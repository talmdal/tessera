// The book plugin: the file that holds a user's finances and its sub-books. Domain-free: it never mentions
// accounts; domain plugins declare their collections through `book.schema` and use `book.session`.
// See docs/account-manager-design.md, "The book".
import type { AppState, PluginContext, ShellFiles, ShellPrompts, StorageEngine } from '@tessera/types'
import { SHELL_FILES_SERVICE, SHELL_PROMPTS_SERVICE } from '@tessera/types'
import path from 'node:path'
import {
  BOOK_OPTIONS_DEFAULTS, BOOK_PLUGIN_ID, BOOK_SESSION_SERVICE, BOOK_VIEWS, DEFAULT_ARCHIVE_FOLDER_NAME,
  validateBookOptions, type BookOptions, type BookSession
} from '@tessera/book-api'
import { Archiver } from './archive/Archiver'
import { ArchiveWriter } from './archive/ArchiveWriter'
import { registerArchiveCommands } from './archive/commands'
import { registerArchiveIpc, type ArchiveIpcDeps } from './archive/ipc'
import { nodeBackupDisk, type BackupDisk } from './backups/BackupDisk'
import { BackupLedger } from './backups/BackupLedger'
import { registerBackupCommands } from './backups/commands'
import { registerBackupsIpc } from './backups/ipc'
import { Restorer } from './backups/Restorer'
import { Backups } from './backups/Backups'
import { registerCommands, revealer } from './commands'
import { contributions } from './contributions'
import { nodeDisk, type BookDisk } from './disk'
import { BookPublisher, registerIpc } from './ipc'
import { BookSessionImpl, describeError, bookName } from './BookSessionImpl'
import { RecentBooks } from './RecentBooks'
import { SchemaRegistry } from './SchemaRegistry'

let active: { session: BookSessionImpl, backups: Backups } | undefined

/** Exactly the `BookSession` contract, so other plugins can't reach the implementation's internals. */
export function publicSession(session: BookSessionImpl): BookSession {
  return {
    get current() { return session.current },
    database: contributor => session.database(contributor),
    create: (file, options) => session.create(file, options),
    open: file => session.open(file),
    close: () => session.close(),
    delete: file => session.delete(file),
    tree: () => session.tree(),
    createSubBook: input => session.createSubBook(input),
    renameSubBook: (id, name, options) => session.renameSubBook(id, name, options),
    moveSubBook: (id, to, index) => session.moveSubBook(id, to, index),
    deleteSubBook: id => session.deleteSubBook(id),
    participate: (contributor, participant) => session.participate(contributor, participant),
    participateInArchive: (contributor, participant, options) => session.participateInArchive(contributor, participant, options),
    registerNavigator: contributor => session.registerNavigator(contributor),
    onWillClose: listener => session.onWillClose(listener),
    onDidChange: session.onDidChange,
    onDidChangeTree: session.onDidChangeTree
  }
}

export async function activate(context: PluginContext, options: { disk?: BookDisk, backupDisk?: BackupDisk } = {}) {
  const engine = context.services.get<StorageEngine>('storage.engine')
  const appState = context.services.get<AppState>('app.state')
  const files = context.services.get<ShellFiles>(SHELL_FILES_SERVICE)
  const prompts = context.services.get<ShellPrompts>(SHELL_PROMPTS_SERVICE)
  const disk = options.disk ?? nodeDisk()

  // The user's backup settings, or the defaults where there is no options service (some tests)
  const settings = context.options?.register<BookOptions>({ defaults: BOOK_OPTIONS_DEFAULTS, validate: validateBookOptions })
  const ledger = new BackupLedger(appState)
  const backupDisk = options.backupDisk ?? nodeBackupDisk()
  const backups = new Backups({
    disk: backupDisk, ledger, files, engineId: engine.id, log: context.logger,
    options: () => (settings?.get() ?? BOOK_OPTIONS_DEFAULTS).backups
  })
  const archiveOptions = () => (settings?.get() ?? BOOK_OPTIONS_DEFAULTS).archive
  const defaultArchiveFolder = () => path.join(files.documentsPath(), DEFAULT_ARCHIVE_FOLDER_NAME)
  const archiveFolder = () => archiveOptions().folder ?? defaultArchiveFolder()

  const recent = new RecentBooks(appState)
  const schema = new SchemaRegistry(context.extensions, context.services, context.logger)
  const session = new BookSessionImpl({ engine, files, prompts, recent, schema, disk, log: context.logger })
  // First, before anything can register a close listener: close listeners run last registered first, so the
  // backup's runs after every other plugin's, and sees whatever they write as the book closes
  context.subscriptions.push(...backups.attach(session))
  const restorer = new Restorer({
    session, engine, backupDisk, bookDisk: disk, backups, contributions: () => schema.contributions(), log: context.logger
  })
  const archiveWriter = new ArchiveWriter({
    engine, bookDisk: disk, folders: backupDisk, probe: file => session.probeFile(file), log: context.logger
  })
  const archiver = new Archiver({
    session, participants: session.archiveParticipants, writer: archiveWriter,
    folder: archiveFolder, log: context.logger
  })
  const archiveDeps: ArchiveIpcDeps & { prompts: typeof prompts, backupNow: () => Promise<unknown> } = {
    session, archiver, backups, prompts,
    folder: archiveFolder,
    defaultFolder: defaultArchiveFolder,
    archiveOptions,
    // The stale-backup checkbox: an ordinary manual backup of the open book, before anything is removed
    backupNow: () => {
      const book = session.current
      if (!book) throw new Error('No book is open to back up')
      return backups.backUpNow(session.unscopedDatabase(), book, {})
    }
  }
  const publisher = new BookPublisher(context, session, recent, disk)
  active = { session, backups }

  context.subscriptions.push(
    session.onDidChange(change => {
      if (change.type === 'opened') publisher.setError(undefined)
      else if (change.type === 'pruned') publisher.publishState()    // the book and its tree are still there
      else {
        publisher.publishState()
        publisher.publishTree(null)
      }
      void publisher.publishRecent()
    }),
    session.onDidChangeTree(tree => publisher.publishTree(tree)),
    session.onDidChangeNavigator(() => publisher.publishState()),
    ...contributions().map(([point, id, impl]) => context.extensions.contribute(BOOK_PLUGIN_ID, point, id, impl)),
    ...registerCommands(context, session, prompts),
    ...registerIpc(context, session, publisher, recent),
    ...registerBackupsIpc(context, {
      session, recent, backups, ledger, files, restorer,
      archiveFolder
    }),
    ...registerBackupCommands(context, { session, backups, files, prompts, restorer, archiveFolder }),
    ...registerArchiveCommands(context, archiveDeps),
    ...registerArchiveIpc(context, archiveDeps),
    context.services.provide(BOOK_PLUGIN_ID, BOOK_SESSION_SERVICE, publicSession(session)),
    // On quit the book closes but is remembered, so it reopens at the next start; then the backup that closing
    // queued gets its time to finish, inside the shutdown limit. One listener, so the two can't run out of order
    context.lifecycle.onShuttingDown(async () => {
      await session.shutdown()
      await backups.drain()
    })
  )

  // Reopen the last book once every plugin has activated: the schema contributors and their migrators are there
  context.lifecycle.onStarted(async () => {
    const last = await recent.last().catch(() => undefined)
    if (last !== undefined) {
      try {
        await session.open(last)
      } catch (err) {
        context.logger.warn(`[book] Could not reopen ${last}: ${describeError(err)}`)
        publisher.setError(`“${bookName(last)}” could not be reopened. ${describeError(err)}`)
      }
    }
    if (!session.current) await revealer(context)(BOOK_VIEWS.start)
  })

  publisher.publishState()
}

/** Runs after every plugin that requires `book.session` has deactivated. */
export async function deactivate() {
  const current = active
  active = undefined
  await current?.session.shutdown()
  await current?.backups.drain()
}
