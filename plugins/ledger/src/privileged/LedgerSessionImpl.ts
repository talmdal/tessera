// The `ledger.session` service: the open ledger file and its sub-ledger tree.
import path from 'node:path'
import type { Database, Disposable, Event, Logger, ShellFiles, ShellPrompts, StorageEngine } from '@tessera/types'
import {
  LEDGER_API_VERSION, LEDGER_FILE_EXTENSION, LEDGER_FILE_FILTER, LEDGER_FORMAT_VERSION, LEDGER_META, LedgerError, isLedgerError,
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
  private readonly subLedgers: SubLedgers

  readonly onDidChange: Event<LedgerChange>
  readonly onDidChangeTree: Event<LedgerTree>
  /** Whether any navigator is registered, each time that changes. */
  readonly onDidChangeNavigator: Event<boolean>

  constructor(private readonly deps: LedgerSessionDeps) {
    this.changes = new Emitter(deps.log, 'change')
    this.trees = new Emitter(deps.log, 'tree')
    this.onDidChange = this.changes.event
    this.onDidChangeTree = this.trees.event
    this.navigatorChanges = new Emitter(deps.log, 'navigator')
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

  /** Where file dialogs start: the open (or most recently opened) ledger's folder, else the documents folder. */
  private async defaultFolder(): Promise<string> {
    const known = this.info?.path ?? (await this.deps.recent.list().catch(() => []))[0]?.path
    return known ? path.dirname(known) : this.deps.files.documentsPath()
  }

  // ---- Files

  create(file?: string, options: { name?: string } = {}): Promise<LedgerInfo | undefined> {
    return this.serial(async () => {
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

      await this.closeOpen({ forget: false })
      // The save dialog asked before replacing; the old file goes to the trash, where it can be restored
      if (await this.deps.disk.exists(target)) await this.trashWithSideFiles(target)

      const db = await this.deps.engine.open({ path: target }, { schema: this.deps.schema.collections() })
      try {
        await db.meta.set(LEDGER_META.format, LEDGER_FORMAT_VERSION)
        await db.meta.set(LEDGER_META.createdAt, this.now().toISOString())
        await db.meta.set(LEDGER_META.createdWith, `ledger ${LEDGER_API_VERSION}`)
        const contributions = this.deps.schema.contributions()
        await runMigrations(db, planMigrations(contributions, {}, ledgerName(target)), this.deps.schema)
      } catch (err) {
        await db.close().catch(() => {})
        throw err
      }
      return this.attach(db, target, true)
    })
  }

  open(file?: string): Promise<LedgerInfo | undefined> {
    return this.serial(async () => {
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

      // Everything is checked before the open ledger closes, so a bad pick leaves the user where they were
      const versions = await this.probe(target)
      const contributions = this.deps.schema.contributions()
      const plan = planMigrations(contributions, versions, ledgerName(target))
      let backup: string | undefined
      if (plan.needsBackup) backup = await this.backup(target)

      await this.closeOpen({ forget: false })
      const db = await this.deps.engine.open({ path: target }, { schema: this.deps.schema.collections() })
      try {
        await runMigrations(db, plan, this.deps.schema)
      } catch (err) {
        await db.close().catch(() => {})
        if (backup && isLedgerError(err)) throw new LedgerError(err.code, `${err.message} A copy of the ledger from before was saved as “${path.basename(backup)}”.`)
        throw err
      }
      return this.attach(db, target, false)
    })
  }

  close(): Promise<void> {
    return this.serial(() => this.closeOpen({ forget: true }))
  }

  /** On quit: closes without forgetting, so the ledger reopens at the next start. */
  shutdown(): Promise<void> {
    return this.serial(() => this.closeOpen({ forget: false }))
  }

  delete(file?: string): Promise<boolean> {
    return this.serial(async () => {
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

      if (this.info?.path === target) await this.closeOpen({ forget: true })
      if (await this.deps.disk.exists(target)) await this.trashWithSideFiles(target)
      await this.deps.recent.remove(target)
      this.deps.log.info(`[ledger] Moved ${target} to the ${trash}`)
      return true
    })
  }

  // ---- Opening and closing

  /** Checks a file is a ledger this app can open, without changing it. Resolves the contributors' versions. */
  private async probe(file: string): Promise<Record<string, number>> {
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

    let db: Database
    try {
      // Read-only, so nothing is written to a file that turns out not to be a ledger
      db = await this.deps.engine.open({ path: file }, { readOnly: true })
    } catch (err) {
      this.deps.log.warn(`[ledger] Could not read ${file}: ${describeError(err)}`)
      throw new LedgerError('UNSUPPORTED_FILE', `“${name}” is not a Tessera ledger, or it is damaged.`)
    }
    try {
      const format = await db.meta.get(LEDGER_META.format)
      if (typeof format !== 'number') throw new LedgerError('UNSUPPORTED_FILE', `“${name}” is not a Tessera ledger.`)
      if (format > LEDGER_FORMAT_VERSION) throw new LedgerError('UNSUPPORTED_FILE', `“${name}” was saved by a newer version of Tessera. Update Tessera to open it.`)
      return await schemaVersions(db, this.deps.schema.contributions())
    } finally {
      // Closed before the real open: the engine caches open databases by path, not by options
      await db.close().catch(err => this.deps.log.warn(`[ledger] Could not close ${file} after reading it: ${describeError(err)}`))
    }
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

  private async attach(db: Database, file: string, created: boolean): Promise<LedgerInfo> {
    this.db = db
    this.info = { path: file, name: ledgerName(file), readOnly: db.readOnly }
    const ledger = this.current!
    try {
      await this.deps.recent.add(file, ledger.name)
    } catch (err) {
      this.deps.log.warn(`[ledger] Could not update the recent ledgers: ${describeError(err)}`)
    }
    this.changes.fire({ type: 'opened', ledger, created })
    await this.publishTree()
    return ledger
  }

  private async closeOpen({ forget }: { forget: boolean }) {
    const db = this.db
    const ledger = this.info
    if (!db || !ledger) return

    for (const listener of [...this.willClose]) {
      try { await listener({ ...ledger }) } catch (err) { this.deps.log.error('[ledger] A close listener failed', err) }
    }
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
