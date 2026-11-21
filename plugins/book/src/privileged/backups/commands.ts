// File › Back Up Now and Back Up To…, and the command the failed-backup warnings run to show the Backups page.
// See docs/backup-restore-design.md, "Backing up on demand".
import path from 'node:path'
import type { Disposable, PluginContext, ShellFiles, ShellPrompts } from '@tessera/types'
import {
  BACKUP_FILE_EXTENSION, BACKUP_FILE_FILTER, BOOK_ARCHIVE_OPTIONS_PAGE, BOOK_BACKUPS_OPTIONS_PAGE, BOOK_COMMANDS,
  BOOK_CONTEXT_KEYS, BOOK_DIALOGS, BOOK_FILE_EXTENSION, BOOK_FILE_FILTER, DEFAULT_ARCHIVE_FOLDER_NAME, BookError,
  type BookInfo, type RestoreDialogInput, type RestoreDialogResult
} from '@tessera/book-api'
import { defaultTrashName, withBookExtension } from '../BookSessionImpl'
import { reportingFailures } from '../commands'
import type { Restorer } from './Restorer'
import type { Backups, BackupsSession } from './Backups'
import { backupFileName } from './naming'

/** The shell's command that opens the options dialog; it takes `{ page }` to open at one page. */
export const OPTIONS_OPEN_COMMAND = 'shell.options.open'

export interface BackupCommandsDeps {
  session: Pick<BackupsSession, 'unscopedDatabase'> & { readonly current: BookInfo | undefined }
  backups: Pick<Backups, 'backUpNow' | 'backupFolder'>
  files: Pick<ShellFiles, 'showSaveDialog' | 'documentsPath'>
  prompts: ShellPrompts
  restorer: Pick<Restorer, 'inspect' | 'restore'>
  archiveFolder?: () => string
  now?: () => Date
  /** The name of the OS trash in messages. */
  trashName?: string
}

/** When a backup was taken, as a person says it: "19 Nov 2026, 18:42". */
export const takenText = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

/** `2026-11-19`, local: for the suggested name of a restored copy. */
const isoDay = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`

/** A path with the backup extension, added when the user typed a name without it. */
export const withBackupExtension = (file: string) =>
  file.toLowerCase().endsWith(BACKUP_FILE_EXTENSION) ? file : file + BACKUP_FILE_EXTENSION

export function registerBackupCommands(context: Pick<PluginContext, 'commands' | 'logger'>, deps: BackupCommandsDeps): Disposable[] {
  const attempt = reportingFailures(context, deps.prompts)
  const now = deps.now ?? (() => new Date())

  /** Backs the open book up, to `to` or into the backup folder, and says where it went. */
  const backUp = async (book: BookInfo, to?: string) => {
    const file = await deps.backups.backUpNow(deps.session.unscopedDatabase(), book, to === undefined ? {} : { to })
    await deps.prompts.message({
      kind: 'info',
      message: `Backed up “${book.name}”.`,
      detail: `Saved as “${path.basename(file)}” in ${path.dirname(file)}.`
    })
    return file
  }

  /**
   * What the Restore dialog chose, carried out: the header read again here (what the renderer said is never
   * trusted), the destination asked for, a confirmation that names what happens to which file, then the restore.
   */
  const restore = async (choice: RestoreDialogResult) => {
    const info = await deps.restorer.inspect(choice.file)
    if (!info.header || info.problem !== undefined) throw new BookError('UNSUPPORTED_FILE', info.problem ?? 'This is not a Tessera backup.')
    const { bookName: backedUp, bookId, bookPath, takenAt, archiveThrough } = info.header
    const when = takenText(takenAt)
    const current = deps.session.current
    const isArchive = info.header.trigger === 'archive'
    const sourceName = isArchive ? 'archive' : 'backup'

    let outcome
    if (choice.target === 'replace') {
      if (!current) throw new BookError('NO_BOOK', 'No book is open to replace.')
      const other = bookId === current.id ? '' : ` This backup is of “${backedUp}”, not “${current.name}”.`
      const archiveDetail = isArchive
        ? `The archive holds “${backedUp}” as it was before it was archived through ${archiveThrough ?? takenText(takenAt).split(',')[0]}. Restoring it replaces this book’s current data; it does not merge. “${current.name}” as it is now is backed up first, then its file is moved to the ${trash}.${other}`
        : `“${current.name}” as it is now is backed up first, then its file is moved to the ${trash}.${other}`
      const confirmed = await deps.prompts.confirm({
        message: `Replace “${current.name}” with the ${sourceName} from ${when}?`,
        detail: archiveDetail,
        confirmLabel: 'Replace',
        destructive: true
      })
      if (!confirmed) return undefined
      outcome = await deps.restorer.restore(choice.file, { kind: 'replace' })
    } else {
      const folder = bookPath ? path.dirname(bookPath) : deps.files.documentsPath()
      const chosen = await deps.files.showSaveDialog({
        title: 'Restore as a New Book',
        defaultPath: path.join(folder, `${backedUp} (restored ${isoDay(now())})${BOOK_FILE_EXTENSION}`),
        filters: [BOOK_FILE_FILTER],
        buttonLabel: 'Restore'
      })
      if (chosen === undefined) return undefined
      // The save dialog asked about the file; opening the copy also closes the open book, so say that
      if (current && !(await deps.prompts.confirm({
        message: `Close “${current.name}” and open the restored copy?`,
        detail: isArchive
          ? `The ${sourceName} will be a writable copy of “${backedUp}”. It does not merge, and “${current.name}” is not changed.`
          : `“${current.name}” is not changed.`,
        confirmLabel: 'Close and Restore'
      }))) return undefined
      outcome = await deps.restorer.restore(choice.file, { kind: 'new', path: withBookExtension(path.resolve(chosen)) })
    }

    await deps.prompts.message({
      kind: 'info',
      message: `Restored “${outcome.book.name}” from the ${sourceName} of ${when}.`,
      ...(outcome.safetyBackup && { detail: `The book as it was before was saved as “${path.basename(outcome.safetyBackup)}” in ${path.dirname(outcome.safetyBackup)}.` })
    })
    return outcome.book
  }
  const trash = deps.trashName ?? defaultTrashName()

  return [
    context.commands.register(BOOK_COMMANDS.backupNow, async () => {
      const book = deps.session.current
      if (!book) return undefined
      return attempt('back up the book', () => backUp(book))
    }, { enablement: BOOK_CONTEXT_KEYS.isOpen }),

    context.commands.register(BOOK_COMMANDS.backupTo, async () => {
      const book = deps.session.current
      if (!book) return undefined
      const chosen = await deps.files.showSaveDialog({
        title: 'Back Up To',
        defaultPath: path.join(deps.backups.backupFolder(), backupFileName(book.name, now(), 'manual')),
        filters: [BACKUP_FILE_FILTER],
        buttonLabel: 'Back Up'
      })
      if (chosen === undefined) return undefined
      return attempt('back up the book', () => backUp(book, withBackupExtension(path.resolve(chosen))))
    }, { enablement: BOOK_CONTEXT_KEYS.isOpen }),

    context.commands.register(BOOK_COMMANDS.restore, async () => {
      const open = deps.session.current
      const input: RestoreDialogInput = {
        ...(open && { open: { id: open.id, name: open.name, readOnly: open.readOnly } }),
        folder: deps.backups.backupFolder(),
        archiveFolder: deps.archiveFolder?.() ?? path.join(deps.files.documentsPath(), DEFAULT_ARCHIVE_FOLDER_NAME)
      }
      const choice = await deps.prompts.show<RestoreDialogResult>(BOOK_DIALOGS.restore, input)
      if (!choice) return undefined
      return attempt('restore the backup', () => restore(choice))
    }),

    context.commands.register(BOOK_COMMANDS.backupSettings, async () => {
      if (!context.commands.has(OPTIONS_OPEN_COMMAND)) return
      await context.commands.execute(OPTIONS_OPEN_COMMAND, { page: BOOK_BACKUPS_OPTIONS_PAGE })
    }),

    context.commands.register(BOOK_COMMANDS.archiveSettings, async () => {
      if (!context.commands.has(OPTIONS_OPEN_COMMAND)) return
      await context.commands.execute(OPTIONS_OPEN_COMMAND, { page: BOOK_ARCHIVE_OPTIONS_PAGE })
    })
  ]
}
