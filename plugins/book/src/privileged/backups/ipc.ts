// What the Backups options page asks of the book: the last backup's status, followed through a push event, and a
// folder picker. The page never reads or writes options here: the options dialog owns the draft.
import type { BookChange, BackupStatus, BookInfo } from '@tessera/book-api'
import { ARCHIVE_FILE_FILTER, BACKUP_FILE_FILTER, BOOK_CHANNELS, BOOK_CONTEXT_KEYS, BOOK_EVENTS, BOOK_PLUGIN_ID } from '@tessera/book-api'
import type { Disposable, Event, IpcMessage, PluginContext, ShellFiles } from '@tessera/types'
import type { RecentBooks } from '../RecentBooks'
import type { BackupLedger, LedgerEntry } from './BackupLedger'
import type { Backups } from './Backups'
import type { Restorer } from './Restorer'

export interface BackupsIpcDeps {
  session: { readonly current: BookInfo | undefined, readonly onDidChange: Event<BookChange>, readonly onDidDelete: Event<string> }
  recent: Pick<RecentBooks, 'list'>
  backups: Pick<Backups, 'defaultFolder' | 'onDidRecord' | 'backupFolder'>
  ledger: Pick<BackupLedger, 'entry' | 'byPath' | 'forget'>
  files: Pick<ShellFiles, 'showFolderDialog' | 'showOpenDialog' | 'documentsPath'>
  restorer: Pick<Restorer, 'list' | 'inspect'>
  /** The configured archive folder, or the default. */
  archiveFolder: () => string
}

/** `events.emit` adds the plugin's prefix itself. */
const local = (event: string) => event.slice(`${BOOK_PLUGIN_ID}:`.length)

/**
 * The status of the open book's backups, or of the most recently opened book's when none is open. That book is
 * found in the ledger by its path, since the recent list doesn't know ids.
 */
export async function backupStatus(deps: BackupsIpcDeps): Promise<BackupStatus> {
  const defaultFolder = deps.backups.defaultFolder()
  let book: BackupStatus['book']
  let entry: LedgerEntry | undefined
  const open = deps.session.current
  if (open) {
    book = { id: open.id, name: open.name }
    entry = await deps.ledger.entry(open.id)
  } else {
    const last = (await deps.recent.list().catch(() => []))[0]
    if (last) {
      const found = await deps.ledger.byPath(last.path)
      book = { ...(found && { id: found.id }), name: last.name }
      entry = found
    }
  }
  return {
    ...(book && { book }),
    ...(entry?.lastBackupAt !== undefined && { lastBackupAt: entry.lastBackupAt }),
    ...(entry?.lastFile !== undefined && { lastFile: entry.lastFile }),
    ...(entry?.lastResult !== undefined && { lastResult: entry.lastResult }),
    ...(entry?.lastError !== undefined && { lastError: entry.lastError }),
    defaultFolder
  }
}

export function registerBackupsIpc(context: Pick<PluginContext, 'ipc' | 'events' | 'logger' | 'contextKeys'>, deps: BackupsIpcDeps): Disposable[] {
  const publish = async () => {
    try {
      const status = await backupStatus(deps)
      // The warnings (status bar, start view) follow the same status the options page shows
      context.contextKeys.set(BOOK_CONTEXT_KEYS.backupFailed, status.lastResult === 'failed' || status.lastResult === 'interrupted')
      context.events.emit(local(BOOK_EVENTS.backups), status)
    } catch (err) {
      context.logger.warn(`[book] Could not read the backup status: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // At start-up: a backup that failed last time is warned about before any book opens
  void publish()

  return [
    context.ipc.register(BOOK_CHANNELS.backupsStatus, () => backupStatus(deps)),

    context.ipc.register(BOOK_CHANNELS.chooseFolder, async (msg: IpcMessage<{ current?: unknown, defaultPath?: unknown, title?: unknown }>) => {
      const current = msg.data?.current
      if (current !== undefined && current !== null && typeof current !== 'string') throw new Error('current must be a folder path or null')
      const defaultPath = msg.data?.defaultPath
      if (defaultPath !== undefined && defaultPath !== null && typeof defaultPath !== 'string') throw new Error('defaultPath must be a folder path or null')
      const title = msg.data?.title
      if (title !== undefined && (typeof title !== 'string' || title.trim() === '')) throw new Error('title must be a non-empty string')
      return deps.files.showFolderDialog({
        title: typeof title === 'string' ? title : 'Choose Folder',
        defaultPath: typeof current === 'string' && current !== ''
          ? current
          : typeof defaultPath === 'string' && defaultPath !== ''
            ? defaultPath
            : deps.files.documentsPath(),
        buttonLabel: 'Choose Folder',
        // Modal to the window the options dialog is in, not whichever happens to be focused
        ...(msg.sender && { windowId: msg.sender.windowId })
      })
    }),

    // The Restore dialog: the backups in a folder, headers only, and a backup picked from anywhere
    context.ipc.register(BOOK_CHANNELS.backupsList, async (msg: IpcMessage<{ folder?: unknown, archiveFolder?: unknown }>) => {
      const folder = msg.data?.folder
      const archiveFolder = msg.data?.archiveFolder
      if (folder !== undefined && (typeof folder !== 'string' || folder === '')) throw new Error('folder must be a folder path')
      if (archiveFolder !== undefined && (typeof archiveFolder !== 'string' || archiveFolder === '')) throw new Error('archiveFolder must be a folder path')
      return deps.restorer.list(folder ?? deps.backups.backupFolder(), typeof archiveFolder === 'string' ? archiveFolder : deps.archiveFolder())
    }),

    context.ipc.register(BOOK_CHANNELS.backupsChoose, async (msg: IpcMessage<unknown>) => {
      const chosen = await deps.files.showOpenDialog({
        title: 'Choose a Backup',
        defaultPath: deps.backups.backupFolder(),
        filters: [BACKUP_FILE_FILTER, ARCHIVE_FILE_FILTER, { name: 'All files', extensions: ['*'] }],
        buttonLabel: 'Choose',
        ...(msg.sender && { windowId: msg.sender.windowId })
      })
      return chosen === undefined ? undefined : deps.restorer.inspect(chosen)
    }),

    // The status changes when a backup is recorded, and when the book it describes changes (one opens or closes)
    deps.backups.onDidRecord(() => { void publish() }),
    deps.session.onDidChange(() => { void publish() }),
    // A deleted book's bookkeeping goes with it. Published again afterwards: the 'closed' of a deleted open book came
    // while it was still the last book, so the status (and any warning) would otherwise still describe it
    deps.session.onDidDelete(path => {
      void deps.ledger.forget(path)
        .catch(err => context.logger.warn(`[book] Could not forget the backups of ${path}: ${err instanceof Error ? err.message : String(err)}`))
        .then(() => publish())
    })
  ]
}
