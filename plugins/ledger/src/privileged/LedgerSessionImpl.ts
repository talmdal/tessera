// The `ledger.session` service: the open ledger file and its sub-ledger tree.
import path from 'node:path'
import type { Database, Disposable, Event, Json, Logger, ShellFiles, ShellPrompts, StorageEngine } from '@tessera/types'
import {
  LEDGER_API_VERSION, LEDGER_BACKUP_META, LEDGER_FILE_EXTENSION, LEDGER_FILE_FILTER, LEDGER_FORMAT_VERSION, LEDGER_META, LedgerError, isLedgerError,
  type LedgerChange, type LedgerInfo, type LedgerSession, type LedgerTree, type SubLedger, type SubLedgerParticipant
} from '@tessera/ledger-api'
import type { FileKind, LedgerDisk } from './disk'
import { planMigrations, runMigrations, schemaVersions } from './migrations'
import type { RecentLedgers } from './RecentLedgers'
import type { SchemaRegistry } from './SchemaRegistry'
import { scopedDatabase } from './scopedDatabase'
import { SubLedgers } from './SubLedgers'

export interface LedgerSessionDeps {
  engine: StorageEngine
  files: ShellFiles
  prompts: ShellPrompts
  recent: RecentLedgers
  schema: SchemaRegistry
  disk: LedgerDisk
  log: Pick<Logger, 'info' | 'warn' | 'error'>
  /** The name of the OS trash in messages. */
  trashName?: string
  now?: () => Date
}

/** The file kind each storage engine writes, for a useful message when a ledger and the engine don't match. */
const ENGINE_FILE_KIND: Record<string, FileKind> = { 'storage-sqlite': 'sqlite', 'storage-loki': 'json' }
const ENGINE_LABEL: Record<string, string> = { 'storage-sqlite': 'SQLite', 'storage-loki': 'LokiJS' }

export const defaultTrashName = () => process.platform === 'win32' ? 'Recycle Bin' : 'Trash'

/** An error's message, for log lines and user-facing details. */
export const describeError = (err: unknown) => err instanceof Error ? err.message : String(err)

/** A listener list, for the session's events. */
class Emitter<T> {
  private readonly listeners = new Set<(value: T) => void>()
  constructor(private readonly log: Pick<Logger, 'error'>, private readonly name: string) {}
  readonly event: Event<T> = listener => {
    this.listeners.add(listener)
    return { dispose: () => { this.listeners.delete(listener) } }
  }
  fire(value: T) {
    for (const listener of [...this.listeners]) {
      try { listener(value) } catch (err) { this.log.error(`[ledger] A ${this.name} listener failed`, err) }
    }
  }
}

/** `/a/b/Home Finances.tessera` → `Home Finances`. */
export const ledgerName = (file: string) => path.basename(file, path.extname(file) === LEDGER_FILE_EXTENSION ? LEDGER_FILE_EXTENSION : undefined)

/** A path with the ledger extension, added when the user typed a name without it. */
export const withLedgerExtension = (file: string) =>
  path.extname(file).toLowerCase() === LEDGER_FILE_EXTENSION ? file : file + LEDGER_FILE_EXTENSION

/** The session's own steps, for a job that holds the ledger's operation (`withFileOperations`). */
/**
 * Why the open ledger is closing, for the close hook (the backup on close): Close Ledger; another ledger opening or
 * being created (a restore as new too); a user quit (pass 2, after pass 1 backed up); an OS shutdown; Delete Ledger…;
 * a restore in place.
 */
export type CloseReason = 'close' | 'switch' | 'quit' | 'system' | 'delete' | 'restore'

/**
 * Runs as the ledger closes, after the `onWillClose` listeners and before the database is flushed and closed, with
 * the database still the session's. The backup on close. A hook that throws is logged; the ledger closes anyway.
 */
export type CloseHook = (db: Database, ledger: LedgerInfo, why: CloseReason) => Promise<void>

export interface FileOperations {
  current(): LedgerInfo | undefined
  /** Closes the open ledger (its close listeners run), remembering it. */
  close(): Promise<void>
  /** Opens a ledger (closing the open one), checking it as Open does; `prepare` changes it before it is shown. */
  open(file: string, prepare?: (db: Database) => Promise<void>): Promise<LedgerInfo>
}

export class LedgerSessionImpl implements LedgerSession {
  private db: Database | undefined
  private info: LedgerInfo | undefined
  private queue: Promise<unknown> = Promise.resolve()
  private readonly participants = new Map<string, SubLedgerParticipant>()
  private readonly navigators = new Map<symbol, string>()
  private readonly willClose = new Set<(ledger: LedgerInfo) => void | Promise<void>>()
  private readonly changes: Emitter<LedgerChange>
  private readonly trees: Emitter<LedgerTree>
  private readonly navigatorChanges: Emitter<boolean>
  private readonly operationChanges: Emitter<string | undefined>
  /** The long operation running on the ledger (`beginOperation`), if any. */
  private running: { label: string, token: symbol } | undefined
  /** Whether the open ledger changed since it opened (an upgrade counts) or since a backup of it began. */
  private changed = false
  private watching: Disposable | undefined
  private closeHook: CloseHook | undefined
  private readonly subLedgers: SubLedgers

  readonly onDidChange: Event<LedgerChange>
  readonly onDidChangeTree: Event<LedgerTree>
  /** Whether any navigator is registered, each time that changes. */
  readonly onDidChangeNavigator: Event<boolean>
  /** The running operation's label each time one begins or ends (undefined: none). */
  readonly onDidChangeOperation: Event<string | undefined>

  constructor(private readonly deps: LedgerSessionDeps) {
    this.changes = new Emitter(deps.log, 'change')
    this.trees = new Emitter(deps.log, 'tree')
    this.onDidChange = this.changes.event
    this.onDidChangeTree = this.trees.event
    this.navigatorChanges = new Emitter(deps.log, 'navigator')
    this.operationChanges = new Emitter(deps.log, 'operation')
    this.onDidChangeOperation = this.operationChanges.event
    this.onDidChangeNavigator = this.navigatorChanges.event
    this.subLedgers = new SubLedgers(() => this.openDatabase(), () => [...this.participants])
  }

  get current(): LedgerInfo | undefined {
    return this.info && { ...this.info }
  }

  private openDatabase(): Database {
    if (!this.db) throw new LedgerError('NO_LEDGER', 'No ledger is open.')
    return this.db
  }

  database(contributor: string): Database {
    if (typeof contributor !== 'string' || contributor === '') throw new LedgerError('INVALID', 'A contributor id is required')
    return scopedDatabase(this.openDatabase(), contributor)
  }

  /** File operations run one at a time: a second Open while the first is prompting waits for it. */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work)
    this.queue = next.catch(() => undefined)
    return next
  }

  private get now() { return this.deps.now ?? (() => new Date()) }

  // ---- One long operation at a time

  get operation(): string | undefined {
    return this.running?.label
  }

  beginOperation(label: string): Disposable {
    if (typeof label !== 'string' || label.trim() === '') throw new LedgerError('INVALID', 'An operation needs a label')
    if (this.running) throw this.busy()
    const token = Symbol(label)
    this.running = { label, token }
    this.operationChanges.fire(label)
    return {
      dispose: () => {
        if (this.running?.token !== token) return
        this.running = undefined
        this.operationChanges.fire(undefined)
      }
    }
  }

  private busy() {
    return new LedgerError('BUSY', `Wait for “${this.running?.label}” to finish.`)
  }

  /** The file operations wait for a running operation to end: the user can't close the ledger under an import. */
  private idle<T>(work: () => Promise<T>): Promise<T> {
    return this.running ? Promise.reject(this.busy()) : work()
  }

  /**
   * Runs `work` with the open ledger's database (not a contributor's scoped one) in the file-operation queue, so the
   * ledger can't close or change meanwhile. For the ledger's own jobs: backups. NO_LEDGER when none is open.
   */
  withOpenLedger<T>(work: (db: Database, ledger: LedgerInfo) => Promise<T>): Promise<T> {
    return this.serial(async () => {
      const db = this.openDatabase()
      return work(db, this.current!)
    })
  }

  // ---- Changes since the last backup

  /** Whether the open ledger changed since it was opened, or since its last backup began. False with none open. */
  get changedSinceBackup(): boolean {
    return this.db !== undefined && this.changed
  }

  /**
   * A backup of the open ledger is starting: what changes from now on counts for the next one. Returns the undo, for
   * a backup that fails (the changes then still need backing up).
   */
  backupStarting(): () => void {
    const was = this.changed
    const db = this.db
    this.changed = false
    return () => { if (was && this.db === db) this.changed = true }
  }

  /** Sets the hook that runs as the ledger closes (one: the backup on close). */
  setCloseHook(hook: CloseHook | undefined) {
    this.closeHook = hook
  }

  /** Where file dialogs start: the open (or most recently opened) ledger's folder, else the documents folder. */
  private async defaultFolder(): Promise<string> {
    const known = this.info?.path ?? (await this.deps.recent.list().catch(() => []))[0]?.path
    return known ? path.dirname(known) : this.deps.files.documentsPath()
  }

  // ---- Files

  create(file?: string, options: { name?: string } = {}): Promise<LedgerInfo | undefined> {
    return this.idle(() => this.serial(async () => {
      const open = this.info
      if (open && !(await this.deps.prompts.confirm({
        message: `Close “${open.name}” and create a new ledger?`,
        detail: `Everything in “${open.name}” is already saved.`,
        confirmLabel: 'Close and Create'
      }))) return undefined

      let target = file
      if (target === undefined) {
        target = await this.deps.files.showSaveDialog({
          title: 'New Ledger',
          defaultPath: path.join(await this.defaultFolder(), `${options.name?.trim() || 'My Finances'}${LEDGER_FILE_EXTENSION}`),
          filters: [LEDGER_FILE_FILTER],
          buttonLabel: 'Create'
        })
        if (target === undefined) return undefined
      }
      target = withLedgerExtension(path.resolve(target))

      await this.closeOpen({ forget: false, why: 'switch' })
      // The save dialog asked before replacing; the old file goes to the trash, where it can be restored
      if (await this.deps.disk.exists(target)) await this.trashWithSideFiles(target)

      const db = await this.deps.engine.open({ path: target }, { schema: this.deps.schema.collections() })
      try {
        await db.meta.set(LEDGER_META.format, LEDGER_FORMAT_VERSION)
        await db.meta.set(LEDGER_META.createdAt, this.now().toISOString())
        await db.meta.set(LEDGER_META.createdWith, `ledger ${LEDGER_API_VERSION}`)
        await db.meta.set(LEDGER_META.id, this.deps.engine.newId())
        const contributions = this.deps.schema.contributions()
        await runMigrations(db, planMigrations(contributions, {}, ledgerName(target)), this.deps.schema)
      } catch (err) {
        await db.close().catch(() => {})
        throw err
      }
      return this.attach(db, target, { created: true })
    }))
  }

  open(file?: string): Promise<LedgerInfo | undefined> {
    return this.idle(() => this.serial(async () => {
      let target = file
      if (target === undefined) {
        target = await this.deps.files.showOpenDialog({
          title: 'Open Ledger',
          defaultPath: await this.defaultFolder(),
          filters: [LEDGER_FILE_FILTER, { name: 'All files', extensions: ['*'] }],
          buttonLabel: 'Open'
        })
        if (target === undefined) return undefined
      }
      target = path.resolve(target)
      if (this.info?.path === target) return this.current
      return this.openFile(target)
    }))
  }

  /**
   * The steps of opening a ledger, in the queue. Everything is checked before the open ledger closes, so a bad pick
   * leaves the user where they were: the meta first, which writes nothing; then the whole file, read by opening it,
   * which a damaged file fails. `prepare` changes the new database before the open ledger closes (a restore's meta);
   * `allowBackup` lets a restored copy, which still has its backup's meta, through to `prepare`.
   */
  private async openFile(target: string, options: { allowBackup?: boolean, prepare?: (db: Database) => Promise<void> } = {}): Promise<LedgerInfo> {
    const { versions } = await this.inspect(target, { allowBackup: options.allowBackup ?? false })
    const contributions = this.deps.schema.contributions()
    const plan = planMigrations(contributions, versions, ledgerName(target))
    let backup: string | undefined
    if (plan.needsBackup) backup = await this.backup(target)

    let db: Database
    try {
      db = await this.deps.engine.open({ path: target }, { schema: this.deps.schema.collections() })
    } catch (err) {
      this.deps.log.warn(`[ledger] Could not open ${target}: ${describeError(err)}`)
      throw new LedgerError('UNSUPPORTED_FILE', `“${path.basename(target)}” is not a Tessera ledger, or it is damaged.`)
    }
    if (options.prepare) {
      try {
        await options.prepare(db)
      } catch (err) {
        await db.close().catch(() => {})
        throw err
      }
    }
    await this.closeOpen({ forget: false, why: 'switch' })
    try {
      await runMigrations(db, plan, this.deps.schema)
    } catch (err) {
      await db.close().catch(() => {})
      if (backup && isLedgerError(err)) throw new LedgerError(err.code, `${err.message} A copy of the ledger from before was saved as “${path.basename(backup)}”.`)
      throw err
    }
    return this.attach(db, target, { created: false, upgraded: plan.steps.length > 0 })
  }

  /**
   * For the ledger's own jobs that close and open ledgers while they hold the operation (a restore): runs `work` in
   * the file-operation queue with the session's own steps, which don't wait for the operation, since the caller holds
   * it. Nothing else opens or closes a ledger meanwhile.
   */
  withFileOperations<T>(work: (ops: FileOperations) => Promise<T>): Promise<T> {
    return this.serial(() => work({
      current: () => this.current,
      close: () => this.closeOpen({ forget: false, why: 'restore' }),
      open: (file, prepare) => this.openFile(path.resolve(file), { allowBackup: true, ...(prepare && { prepare }) })
    }))
  }

  close(): Promise<void> {
    return this.idle(() => this.serial(() => this.closeOpen({ forget: true, why: 'close' })))
  }

  /**
   * On quit: closes without forgetting, so the ledger reopens at the next start. `reason` is the lifecycle's: 'user'
   * for a user quit (pass 1 did the backup), 'system' for an OS shutdown.
   */
  shutdown(reason: 'user' | 'system' = 'user'): Promise<void> {
    return this.serial(() => this.closeOpen({ forget: false, why: reason === 'system' ? 'system' : 'quit' }))
  }

  delete(file?: string): Promise<boolean> {
    return this.idle(() => this.serial(async () => {
      const target = file === undefined ? this.info?.path : path.resolve(file)
      if (target === undefined) return false
      const name = ledgerName(target)
      const trash = this.deps.trashName ?? defaultTrashName()

      if (!(await this.deps.prompts.confirm({
        message: `Move “${name}” to the ${trash}?`,
        detail: `All of its sub-ledgers, accounts and transactions go with it. You can restore the file from the ${trash}.`,
        confirmLabel: 'Delete',
        destructive: true
      }))) return false

      if (this.info?.path === target) await this.closeOpen({ forget: true, why: 'delete' })
      if (await this.deps.disk.exists(target)) await this.trashWithSideFiles(target)
      await this.deps.recent.remove(target)
      this.deps.log.info(`[ledger] Moved ${target} to the ${trash}`)
      return true
    }))
  }

  // ---- Opening and closing

  /**
   * Checks a file is a ledger this app can open, from its meta alone: nothing is written, and the documents aren't
   * loaded (that takes up to a second for a large ledger, with the main process blocked). Resolves its meta and the
   * contributors' versions; throws UNSUPPORTED_FILE or FILE_NOT_FOUND with the reason. A backup is refused unless
   * `allowBackup` (a restore reads backups this way).
   */
  async inspect(file: string, { allowBackup = false }: { allowBackup?: boolean } = {}): Promise<{ meta: Record<string, Json>, versions: Record<string, number> }> {
    const name = path.basename(file)
    if (!(await this.deps.disk.exists(file))) throw new LedgerError('FILE_NOT_FOUND', `“${name}” can’t be found. It may have been moved or deleted.`)

    const engine = this.deps.engine.id
    const expected = ENGINE_FILE_KIND[engine]
    const kind = await this.deps.disk.sniff(file)
    if (expected !== undefined && kind !== expected) {
      throw new LedgerError('UNSUPPORTED_FILE', kind === 'sqlite' || kind === 'json'
        ? `“${name}” can’t be opened with the active storage engine (${ENGINE_LABEL[engine] ?? engine}). It may be a ledger saved with another engine, or not a ledger at all.`
        : `“${name}” is not a Tessera ledger.`)
    }

    let meta: Record<string, Json>
    try {
      meta = await this.deps.engine.readMeta({ path: file })
    } catch (err) {
      this.deps.log.warn(`[ledger] Could not read ${file}: ${describeError(err)}`)
      throw new LedgerError('UNSUPPORTED_FILE', `“${name}” is not a Tessera ledger, or it is damaged.`)
    }
    const format = meta[LEDGER_META.format]
    if (typeof format !== 'number') throw new LedgerError('UNSUPPORTED_FILE', `“${name}” is not a Tessera ledger.`)
    if (format > LEDGER_FORMAT_VERSION) throw new LedgerError('UNSUPPORTED_FILE', `“${name}” was saved by a newer version of Tessera. Update Tessera to open it.`)
    // Opened as a ledger, a backup would be written to (upgraded, then edited) and stop being the copy it was
    if (!allowBackup && meta[LEDGER_BACKUP_META.takenAt] !== undefined) {
      throw new LedgerError('UNSUPPORTED_FILE', `“${name}” is a backup, not a ledger. Use File › Restore Ledger… to restore it.`)
    }
    const versions = schemaVersions(meta, this.deps.schema.contributions())
    // A file newer than a contributor's plugin is refused here too, so a restore can say so before copying anything
    planMigrations(this.deps.schema.contributions(), versions, ledgerName(file))
    return { meta, versions }
  }

  /** Copies the file (and its side files) beside it, before a migration changes it. */
  private async backup(file: string): Promise<string> {
    const stamp = this.now().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)
    const copy = path.join(path.dirname(file), `${ledgerName(file)}.backup-${stamp}${LEDGER_FILE_EXTENSION}`)
    await this.deps.disk.copyWithSideFiles(file, copy)
    this.deps.log.info(`[ledger] Backed up ${file} to ${copy} before upgrading it`)
    return copy
  }

  private async trashWithSideFiles(file: string) {
    for (const side of await this.deps.disk.sideFiles(file)) await this.deps.files.trash(side)
    await this.deps.files.trash(file)
  }

  /**
   * `upgraded`: migrations ran, so the file differs from any backup of it. (A new ledger starts unchanged: it has no
   * backup at all, which is reason enough to back it up.)
   */
  private async attach(db: Database, file: string, { created, upgraded = false }: { created: boolean, upgraded?: boolean }): Promise<LedgerInfo> {
    const id = await this.identify(db, file)
    this.db = db
    this.changed = upgraded
    this.watching = db.onDidChange(() => { if (this.db === db) this.changed = true })
    this.info = { path: file, name: ledgerName(file), readOnly: db.readOnly, ...(id !== undefined && { id }) }
    const ledger = this.current!
    try {
      await this.deps.recent.add(file, ledger.name, id)
    } catch (err) {
      this.deps.log.warn(`[ledger] Could not update the recent ledgers: ${describeError(err)}`)
    }
    this.changes.fire({ type: 'opened', ledger, created })
    await this.publishTree()
    return ledger
  }

  /**
   * The ledger's id: read from its meta, or, for a ledger made before ids existed, given one now (one meta write, not
   * a migration). A read-only ledger gets one the next time it is opened writable.
   */
  private async identify(db: Database, file: string): Promise<string | undefined> {
    const stored = await db.meta.get(LEDGER_META.id)
    if (typeof stored === 'string' && stored !== '') return stored
    if (db.readOnly) return undefined
    const id = this.deps.engine.newId()
    try {
      await db.meta.set(LEDGER_META.id, id)
      return id
    } catch (err) {
      this.deps.log.warn(`[ledger] Could not give ${file} an id: ${describeError(err)}`)
      return undefined
    }
  }

  private async closeOpen({ forget, why }: { forget: boolean, why: CloseReason }) {
    const db = this.db
    const ledger = this.info
    if (!db || !ledger) return

    for (const listener of [...this.willClose]) {
      try { await listener({ ...ledger }) } catch (err) { this.deps.log.error('[ledger] A close listener failed', err) }
    }
    // After the listeners, so what plugins write as the ledger closes is in the backup
    if (this.closeHook) {
      try { await this.closeHook(db, { ...ledger }, why) } catch (err) { this.deps.log.error('[ledger] The close hook failed', err) }
    }
    this.watching?.dispose()
    this.watching = undefined
    this.db = undefined
    this.info = undefined
    try { await db.flush() } catch (err) { this.deps.log.error(`[ledger] Could not flush ${ledger.path}`, err) }
    try { await db.close() } catch (err) { this.deps.log.error(`[ledger] Could not close ${ledger.path}`, err) }
    if (forget) await this.deps.recent.forgetLast().catch(err => this.deps.log.warn(`[ledger] Could not update the recent ledgers: ${describeError(err)}`))
    this.changes.fire({ type: 'closed', ledger })
  }

  // ---- The tree

  async tree(): Promise<LedgerTree> {
    const ledger = this.current
    if (!ledger) throw new LedgerError('NO_LEDGER', 'No ledger is open.')
    return { ledger, subLedgers: await this.subLedgers.list() }
  }

  private async publishTree() {
    if (!this.info) return      // closed meanwhile: the 'closed' change says so
    try {
      this.trees.fire(await this.tree())
    } catch (err) {
      this.deps.log.error('[ledger] Could not read the ledger tree', err)
    }
  }

  private async changingTree<T>(work: () => Promise<T>): Promise<T> {
    const result = await work()
    await this.publishTree()
    return result
  }

  createSubLedger(input: { name: string, parentId: string | null, notes?: string }): Promise<SubLedger> {
    return this.changingTree(() => this.subLedgers.create(input))
  }

  renameSubLedger(id: string, name: string, options?: { expectedRev?: number }): Promise<SubLedger> {
    return this.changingTree(() => this.subLedgers.rename(id, name, options))
  }

  moveSubLedger(id: string, to: string | null, index?: number): Promise<void> {
    return this.changingTree(() => this.subLedgers.move(id, to, index))
  }

  async deleteSubLedger(id: string): Promise<void> {
    await this.changingTree(() => this.subLedgers.delete(id))
  }

  participate(contributor: string, participant: SubLedgerParticipant): Disposable {
    if (typeof participant?.reparent !== 'function' || typeof participant.describe !== 'function') {
      throw new Error(`The sub-ledger participant of "${contributor}" needs describe and reparent`)
    }
    if (this.participants.has(contributor)) throw new Error(`"${contributor}" already takes part in sub-ledgers`)
    this.participants.set(contributor, participant)
    return { dispose: () => { if (this.participants.get(contributor) === participant) this.participants.delete(contributor) } }
  }

  get hasNavigator(): boolean {
    return this.navigators.size > 0
  }

  registerNavigator(contributor: string): Disposable {
    const token = Symbol(contributor)
    const before = this.hasNavigator
    this.navigators.set(token, contributor)
    if (!before) this.navigatorChanges.fire(true)
    return {
      dispose: () => {
        if (!this.navigators.delete(token)) return
        if (!this.hasNavigator) this.navigatorChanges.fire(false)
      }
    }
  }

  /** What each participant keeps directly in a sub-ledger, for the delete confirmation. */
  async describeContents(id: string): Promise<string[]> {
    const found: string[] = []
    for (const [contributor, participant] of this.participants) {
      try {
        const description = await participant.describe(id)
        if (description) found.push(description)
      } catch (err) {
        this.deps.log.warn(`[ledger] "${contributor}" could not describe sub-ledger ${id}: ${describeError(err)}`)
      }
    }
    return found
  }

  onWillClose(listener: (ledger: LedgerInfo) => void | Promise<void>): Disposable {
    this.willClose.add(listener)
    return { dispose: () => { this.willClose.delete(listener) } }
  }
}
