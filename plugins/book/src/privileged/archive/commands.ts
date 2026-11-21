// File › Archive…: with no arguments it opens the Archive dialog; with `{ before }` it runs headless, confirming
// with the plan. The dialog and the headless path share `runArchive`, so they can never disagree.
// See docs/archive-design.md, "The Archive dialog".
import type { Disposable, PluginContext, ShellPrompts } from '@tessera/types'
import {
  BOOK_COMMANDS, BOOK_CONTEXT_KEYS, BOOK_DIALOGS, BookError,
  type ArchiveArgs, type ArchiveOutcome
} from '@tessera/book-api'
import { reportingFailures } from '../commands'
import { archiveDialogInput, runArchive, type ArchiveIpcDeps } from './ipc'
import { isIsoDate } from './naming'

const K = BOOK_CONTEXT_KEYS
const WRITABLE = `${K.isOpen} && !${K.isReadOnly}`

export { confirmationDetail } from './ipc'

export function registerArchiveCommands(
  context: Pick<PluginContext, 'commands' | 'logger'>,
  deps: ArchiveIpcDeps & { prompts: ShellPrompts, backupNow?: () => Promise<unknown> }
): Disposable[] {
  const attempt = reportingFailures(context, deps.prompts)

  return [
    context.commands.register(BOOK_COMMANDS.archive, async (args?: unknown): Promise<ArchiveOutcome | undefined> => {
      if (!deps.session.current) return undefined
      return attempt('archive the book', async () => {
        const before = (args as Partial<ArchiveArgs> | undefined)?.before
        if (before === undefined) {
          // The dialog gathers the date and the rest, and runs the archive through its own IPC
          const outcome = await deps.prompts.show<ArchiveOutcome>(BOOK_DIALOGS.archive, await archiveDialogInput(deps))
          return outcome ?? undefined
        }
        if (!isIsoDate(before)) throw new BookError('INVALID', 'Say what date to archive before, as { before: "YYYY-MM-DD" }.')
        const { removeReconciled, removeVoided } = deps.archiveOptions()
        return runArchive(deps, { before, removeReconciled, removeVoided })
      })
    }, { enablement: WRITABLE })
  ]
}
