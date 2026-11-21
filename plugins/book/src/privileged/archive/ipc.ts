// What the Archive dialog asks of the book: what to open with, what a cut-off would do, and the run itself. The
// dialog only chooses; the confirmation, the optional backup and the archive all happen here, in the main process.
// See docs/archive-design.md, "The Archive dialog".
import path from 'node:path'
import type { Database, Disposable, IpcMessage, PluginContext, ShellPrompts } from '@tessera/types'
import {
  BOOK_CHANNELS, BOOK_META, BookError, toResult,
  type ArchiveDialogInput, type ArchiveOptionsStatus, type ArchiveOutcome, type ArchivePlan, type ArchiveRequest,
  type BookArchiveOptions, type BookInfo
} from '@tessera/book-api'
import type { Archiver } from './Archiver'
import { humanDate, isIsoDate, isoDay, suggestedCutoff } from './naming'

export interface ArchiveIpcDeps {
  session: { readonly current: BookInfo | undefined, unscopedDatabase(): Database }
  archiver: Pick<Archiver, 'plan' | 'archive'>
  backups: { stale(book: BookInfo): Promise<boolean> }
  prompts: ShellPrompts
  /** The configured destination, or the default. */
  folder: () => string
  /** The default archive folder regardless of the configured destination. */
  defaultFolder: () => string
  /** The current archive settings, read at each action so changes take effect immediately. */
  archiveOptions: () => BookArchiveOptions
  now?: () => Date
}

const openBook = (deps: Pick<ArchiveIpcDeps, 'session'>): BookInfo => {
  const book = deps.session.current
  if (!book) throw new BookError('NO_BOOK', 'Open a book to archive it.')
  return book
}

/** What the Archive dialog opens with. */
export async function archiveDialogInput(deps: ArchiveIpcDeps): Promise<ArchiveDialogInput> {
  const book = openBook(deps)
  const now = (deps.now ?? (() => new Date()))()
  const last = await deps.session.unscopedDatabase().meta.get(BOOK_META.lastArchivedThrough)
  return {
    book: { name: book.name },
    suggested: suggestedCutoff(deps.archiveOptions().suggest, now),
    ...(typeof last === 'string' && { lastArchivedThrough: last }),
    folder: deps.folder(),
    today: isoDay(now),
    backupStale: await deps.backups.stale(book)
  }
}

/** What the confirmation says under the question: each participant's part, then every warning. */
export function confirmationDetail(plan: ArchivePlan, bookName: string): string {
  const lines = [
    `A complete copy of “${bookName}” is saved first, and opens read-only at any time. The removed records can’t be put back except by restoring that copy as a new book.`,
    '',
    ...plan.parts.filter(part => part.documents > 0).map(part => `Removes ${part.describe}.`),
    ...(plan.warnings.length > 0 ? ['', ...plan.warnings.map(warning => `⚠ ${warning.message}`)] : [])
  ]
  return lines.join('\n')
}

/**
 * The whole run, shared by the headless command and the dialog: plan, refuse a blocker, confirm with the plan,
 * optionally back up first, archive, and report. Resolves undefined when the user cancels or there is nothing
 * to do; nothing has happened then.
 */
export async function runArchive(
  deps: ArchiveIpcDeps & { backupNow?: () => Promise<unknown> },
  request: ArchiveRequest,
  options: { folder?: string, backupFirst?: boolean } = {}
): Promise<ArchiveOutcome | undefined> {
  const book = openBook(deps)
  const plan = await deps.archiver.plan(request)
  if (plan.blocker !== undefined) throw new BookError('ARCHIVE_BLOCKED', plan.blocker)
  if (plan.documents === 0) {
    await deps.prompts.message({ kind: 'info', message: `There is nothing to archive before ${humanDate(request.before)}.` })
    return undefined
  }

  if (!(await deps.prompts.confirm({
    message: `Archive “${book.name}” through ${humanDate(request.before)}?`,
    detail: confirmationDetail(plan, book.name),
    confirmLabel: 'Archive',
    destructive: true
  }))) return undefined

  if (options.backupFirst && deps.backupNow) await deps.backupNow()
  const outcome = await deps.archiver.archive(request, { ...(options.folder !== undefined && { folder: options.folder }) })
  await deps.prompts.message({
    kind: 'info',
    message: `Archived “${book.name}” through ${humanDate(request.before)}.`,
    detail: `${outcome.documents.toLocaleString()} records were removed and kept in “${path.basename(outcome.file)}” in ${path.dirname(outcome.file)}. No account’s balance changed.`
  })
  return outcome
}

export function registerArchiveIpc(
  context: Pick<PluginContext, 'ipc'>,
  deps: ArchiveIpcDeps & { backupNow: () => Promise<unknown> }
): Disposable[] {
  return [
    context.ipc.register(BOOK_CHANNELS.archiveStatus, (): ArchiveOptionsStatus => ({ defaultFolder: deps.defaultFolder() })),

    context.ipc.register(BOOK_CHANNELS.archiveInput, () => toResult(() => archiveDialogInput(deps))),

    context.ipc.register(BOOK_CHANNELS.archivePlan, (msg: IpcMessage<{ before?: unknown }>) => toResult(async () => {
      const before = msg.data?.before
      if (!isIsoDate(before)) throw new BookError('INVALID', 'Enter a date, as YYYY-MM-DD.')
      const { removeReconciled, removeVoided } = deps.archiveOptions()
      return deps.archiver.plan({ before, removeReconciled, removeVoided })
    })),

    context.ipc.register(BOOK_CHANNELS.archiveRun, (msg: IpcMessage<{ before?: unknown, folder?: unknown, backupFirst?: unknown }>) =>
      toResult(async () => {
        const { before, folder, backupFirst } = msg.data ?? {}
        if (!isIsoDate(before)) throw new BookError('INVALID', 'Enter a date, as YYYY-MM-DD.')
        const { removeReconciled, removeVoided } = deps.archiveOptions()
        const outcome = await runArchive(deps, { before, removeReconciled, removeVoided }, {
          ...(typeof folder === 'string' && folder !== '' && { folder }),
          backupFirst: backupFirst === true
        })
        return outcome ?? null       // null: cancelled or nothing to do — the dialog stays open
      }))
  ]
}
