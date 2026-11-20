// The `book.session` service: the open book file and its sub-book tree.
import { createHash } from 'node:crypto'
import path from 'node:path'
import type { Database, Disposable, Event, Logger, ShellFiles, ShellPrompts, StorageEngine } from '@tessera/types'
import {
  BOOK_API_VERSION, BOOK_FILE_EXTENSION, BOOK_FILE_FILTER, BOOK_FORMAT_VERSION, BOOK_META, BookError, isBookError,
  type BookChange, type BookInfo, type BookSession, type BookTree, type SubBook, type SubBookParticipant
} from '@tessera/book-api'
import type { FileKind, BookDisk } from './disk'
import { planMigrations, runMigrations, schemaVersions } from './migrations'
import type { RecentBooks } from './RecentBooks'
import type { SchemaRegistry } from './SchemaRegistry'
import { scopedDatabase } from './scopedDatabase'
import { SubBooks } from './SubBooks'

/** What `exclusive` hands its work: the session's file operations, run inside its queue rather than queued again. */
export interface SessionInside {
  /** Closes the open book (flushing, running close listeners), remembered for the next start. */
  close(): Promise<void>
  /** Opens a book file exactly as File › Open does: probe, migrate, attach, the 'opened' event. */
  open(file: string): Promise<BookInfo | undefined>
  /** Checks a file is a book this app can open, without changing it. */
  probe(file: string): Promise<void>
  /** Moves a file and its side files to the OS trash. */
  trash(file: string): Promise<void>
}

export interface BookSessionDeps {
  engine: StorageEngine
  files: ShellFiles
  prompts: ShellPrompts
  recent: RecentBooks
  schema: SchemaRegistry
  disk: BookDisk
  log: Pick<Logger, 'info' | 'warn' | 'error'>
  /** The name of the OS trash in messages. */
  trashName?: string
  now?: () => Date
}

/** The file kind each storage engine writes, for a useful message when a book and the engine don't match. */
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
      try { listener(value) } catch (err) { this.log.error(`[book] A ${this.name} listener failed`, err) }
    }
  }
}

/** `/a/b/Home Finances.tessera` → `Home Finances`. */
export const bookName = (file: string) => path.basename(file, path.extname(file) === BOOK_FILE_EXTENSION ? BOOK_FILE_EXTENSION : undefined)

/** A path with the book extension, added when the user typed a name without it. */
export const withBookExtension = (file: string) =>
  path.extname(file).toLowerCase() === BOOK_FILE_EXTENSION ? file : file + BOOK_FILE_EXTENSION

/** Whether a stored `BOOK_META.id` is usable: any non-empty string, so ids from a restored backup are kept as they are. */
const isBookId = (value: unknown): value is string => typeof value === 'string' && value.trim() !== ''

/**
 * The id a read-only book without one is known by: derived from its path, the same each time it is opened. Case is
 * folded where the file system usually ignores it (Windows, macOS), as the recent-books list compares paths.
 */
export function pathBookId(file: string): string {
  const key = process.platform === 'win32' || process.platform === 'darwin' ? file.toLowerCase() : file
  return `path-${createHash('sha256').update(key).digest('hex').slice(0, 32)}`
}

export class BookSessionImpl implements BookSession {
  private db: Database | undefined
  private info: BookInfo | undefined
  private queue: Promise<unknown> = Promise.resolve()
  private readonly participants = new Map<string, SubBookParticipant>()
  private readonly navigators = new Map<symbol, string>()
  private readonly willClose = new Set<(book: BookInfo) => void | Promise<void>>()
  private readonly changes: Emitter<BookChange>
  private readonly trees: Emitter<BookTree>
  private readonly navigatorChanges: Emitter<boolean>
  private readonly deletions: Emitter<string>
  private readonly subBooks: SubBooks

  readonly onDidChange: Event<BookChange>
  readonly onDidChangeTree: Event<BookTree>
  /** Whether any navigator is registered, each time that changes. */
  readonly onDidChangeNavigator: Event<boolean>
  /**
   * The path of a book file each time one is deleted, once it is in the trash and off the recent list. For the book
   * plugin's own bookkeeping (its backups), never published: other plugins see a deleted open book close.
   */
  readonly onDidDelete: Event<string>

  constructor(private readonly deps: BookSessionDeps) {
    this.changes = new Emitter(deps.log, 'change')
    this.trees = new Emitter(deps.log, 'tree')
    this.onDidChange = this.changes.event
    this.onDidChangeTree = this.trees.event
    this.navigatorChanges = new Emitter(deps.log, 'navigator')
    this.deletions = new Emitter(deps.log, 'delete')
    this.onDidDelete = this.deletions.event
    this.onDidChangeNavigator = this.navigatorChanges.event
    this.subBooks = new SubBooks(() => this.openDatabase(), () => [...this.participants])
  }

  get current(): BookInfo | undefined {
    return this.info && { ...this.info }
  }

  private openDatabase(): Database {
    if (!this.db) throw new BookError('NO_BOOK', 'No book is open.')
    return this.db
  }

  /**
   * The open book's whole database, unscoped. For the book plugin's own use (its backups) and never published:
   * `publicSession` leaves it out, so a contributor only ever sees its own collections.
   */
  unscopedDatabase(): Database {
    return this.openDatabase()
  }

  database(contributor: string): Database {
    if (typeof contributor !== 'string' || contributor === '') throw new BookError('INVALID', 'A contributor id is required')
    return scopedDatabase(this.openDatabase(), contributor)
  }

  /** File operations run one at a time: a second Open while the first is prompting waits for it. */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work)
    this.queue = next.catch(() => undefined)
    return next
  }

  private get now() { return this.deps.now ?? (() => new Date()) }

  /** Where file dialogs start: the open (or most recently opened) book's folder, else the documents folder. */
  private async defaultFolder(): Promise<string> {
    const known = this.info?.path ?? (await this.deps.recent.list().catch(() => []))[0]?.path
    return known ? path.dirname(known) : this.deps.files.documentsPath()
  }

  // ---- Files

  create(file?: string, options: { name?: string } = {}): Promise<BookInfo | undefined> {
    return this.serial(async () => {
      const open = this.info
      if (open && !(await this.deps.prompts.confirm({
        message: `Close “${open.name}” and create a new book?`,
        detail: `Everything in “${open.name}” is already saved.`,
        confirmLabel: 'Close and Create'
      }))) return undefined

      let target = file
      if (target === undefined) {
        target = await this.deps.files.showSaveDialog({
          title: 'New Book',
          defaultPath: path.join(await this.defaultFolder(), `${options.name?.trim() || 'My Finances'}${BOOK_FILE_EXTENSION}`),
          filters: [BOOK_FILE_FILTER],
          buttonLabel: 'Create'
        })
        if (target === undefined) return undefined
      }
      target = withBookExtension(path.resolve(target))

      await this.closeOpen({ forget: false })
      // The save dialog asked before replacing; the old file goes to the trash, where it can be restored
      if (await this.deps.disk.exists(target)) await this.trashWithSideFiles(target)

      const db = await this.deps.engine.open({ path: target }, { schema: this.deps.schema.collections() })
      const id = this.deps.engine.newId()
      try {
        await db.meta.set(BOOK_META.format, BOOK_FORMAT_VERSION)
        await db.meta.set(BOOK_META.id, id)
        await db.meta.set(BOOK_META.createdAt, this.now().toISOString())
        await db.meta.set(BOOK_META.createdWith, `book ${BOOK_API_VERSION}`)
        const contributions = this.deps.schema.contributions()
        await runMigrations(db, planMigrations(contributions, {}, bookName(target)), this.deps.schema)
      } catch (err) {
        await db.close().catch(() => {})
        throw err
      }
      return this.attach(db, target, id, true, false)
    })
  }

  open(file?: string): Promise<BookInfo | undefined> {
    return this.serial(() => this.openNow(file))
  }

  /**
   * For the book plugin's own restore, never published: runs `work` inside the file-operation queue, so no Open,
   * Close or Delete can run between its steps, and hands it the session's file operations to use from there.
   */
  exclusive<T>(work: (inside: SessionInside) => Promise<T>): Promise<T> {
    return this.serial(() => work({
      close: () => this.closeOpen({ forget: false }),
      open: file => this.openNow(file),
      probe: async file => { await this.probe(file) },
      trash: file => this.trashWithSideFiles(file)
    }))
  }

  private async openNow(file?: string): Promise<BookInfo | undefined> {
    let target = file
    if (target === undefined) {
      target = await this.deps.files.showOpenDialog({
        title: 'Open Book',
        defaultPath: await this.defaultFolder(),
        filters: [BOOK_FILE_FILTER, { name: 'All files', extensions: ['*'] }],
        buttonLabel: 'Open'
      })
      if (target === undefined) return undefined
    }
    target = path.resolve(target)
    if (this.info?.path === target) return this.current

    // Everything is checked before the open book closes, so a bad pick leaves the user where they were
    const versions = await this.probe(target)
    const contributions = this.deps.schema.contributions()
    const plan = planMigrations(contributions, versions, bookName(target))
    let backup: string | undefined
    if (plan.needsBackup) backup = await this.backup(target)

    await this.closeOpen({ forget: false })
    const db = await this.deps.engine.open({ path: target }, { schema: this.deps.schema.collections() })
    let id: string
    try {
      await runMigrations(db, plan, this.deps.schema)
      id = await this.identify(db, target)
    } catch (err) {
      await db.close().catch(() => {})
      if (backup && isBookError(err)) throw new BookError(err.code, `${err.message} A copy of the book from before was saved as “${path.basename(backup)}”.`)
      throw err
    }
    return this.attach(db, target, id, false, plan.steps.length > 0)
  }

  close(): Promise<void> {
    return this.serial(() => this.closeOpen({ forget: true }))
  }

  /** On quit: closes without forgetting, so the book reopens at the next start. */
  shutdown(): Promise<void> {
    return this.serial(() => this.closeOpen({ forget: false }))
  }

  delete(file?: string): Promise<boolean> {
    return this.serial(async () => {
      const target = file === undefined ? this.info?.path : path.resolve(file)
      if (target === undefined) return false
      const name = bookName(target)
      const trash = this.deps.trashName ?? defaultTrashName()

      if (!(await this.deps.prompts.confirm({
        message: `Move “${name}” to the ${trash}?`,
        detail: `All of its sub-books, accounts and transactions go with it. You can restore the file from the ${trash}.`,
        confirmLabel: 'Delete',
        destructive: true
      }))) return false

      if (this.info?.path === target) await this.closeOpen({ forget: true })
      if (await this.deps.disk.exists(target)) await this.trashWithSideFiles(target)
      await this.deps.recent.remove(target)
      this.deps.log.info(`[book] Moved ${target} to the ${trash}`)
      this.deletions.fire(target)
      return true
    })
  }

  // ---- Opening and closing

  /** Checks a file is a book this app can open, without changing it. Resolves the contributors' versions. */
  private async probe(file: string): Promise<Record<string, number>> {
    const name = path.basename(file)
    if (!(await this.deps.disk.exists(file))) throw new BookError('FILE_NOT_FOUND', `“${name}” can’t be found. It may have been moved or deleted.`)

    const engine = this.deps.engine.id
    const expected = ENGINE_FILE_KIND[engine]
    const kind = await this.deps.disk.sniff(file)
    if (expected !== undefined && kind !== expected) {
      throw new BookError('UNSUPPORTED_FILE', kind === 'sqlite' || kind === 'json'
        ? `“${name}” can’t be opened with the active storage engine (${ENGINE_LABEL[engine] ?? engine}). It may be a book saved with another engine, or not a book at all.`
        : `“${name}” is not a Tessera book.`)
    }

    let db: Database
    try {
      // Read-only, so nothing is written to a file that turns out not to be a book
      db = await this.deps.engine.open({ path: file }, { readOnly: true })
    } catch (err) {
      this.deps.log.warn(`[book] Could not read ${file}: ${describeError(err)}`)
      throw new BookError('UNSUPPORTED_FILE', `“${name}” is not a Tessera book, or it is damaged.`)
    }
    try {
      const format = await db.meta.get(BOOK_META.format)
      if (typeof format !== 'number') throw new BookError('UNSUPPORTED_FILE', `“${name}” is not a Tessera book.`)
      if (format > BOOK_FORMAT_VERSION) throw new BookError('UNSUPPORTED_FILE', `“${name}” was saved by a newer version of Tessera. Update Tessera to open it.`)
      return await schemaVersions(db, this.deps.schema.contributions())
    } finally {
      // Closed before the real open: the engine caches open databases by path, not by options
      await db.close().catch(err => this.deps.log.warn(`[book] Could not close ${file} after reading it: ${describeError(err)}`))
    }
  }

  /** Copies the file (and its side files) beside it, before a migration changes it. */
  private async backup(file: string): Promise<string> {
    const stamp = this.now().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)
    const copy = path.join(path.dirname(file), `${bookName(file)}.backup-${stamp}${BOOK_FILE_EXTENSION}`)
    await this.deps.disk.copyWithSideFiles(file, copy)
    this.deps.log.info(`[book] Backed up ${file} to ${copy} before upgrading it`)
    return copy
  }

  /**
   * The book's stable id. A book from before ids existed is given one here: a single meta write, not a migration —
   * no data changes, so nothing needs backing up first. A read-only book can't be written, so it is known by an id
   * derived from its path until it is opened writable.
   */
  private async identify(db: Database, file: string): Promise<string> {
    const stored = await db.meta.get(BOOK_META.id)
    if (isBookId(stored)) return stored
    if (db.readOnly) return pathBookId(file)
    const id = this.deps.engine.newId()
    await db.meta.set(BOOK_META.id, id)
    if (stored === undefined) this.deps.log.info(`[book] Gave ${file} a book id, ${id}`)
    else this.deps.log.warn(`[book] ${file} had an unusable book id (${JSON.stringify(stored)}); gave it a new one, ${id}`)
    return id
  }

  private async trashWithSideFiles(file: string) {
    for (const side of await this.deps.disk.sideFiles(file)) await this.deps.files.trash(side)
    await this.deps.files.trash(file)
  }

  private async attach(db: Database, file: string, id: string, created: boolean, migrated: boolean): Promise<BookInfo> {
    this.db = db
    this.info = { id, path: file, name: bookName(file), readOnly: db.readOnly }
    const book = this.current!
    try {
      await this.deps.recent.add(file, book.name)
    } catch (err) {
      this.deps.log.warn(`[book] Could not update the recent books: ${describeError(err)}`)
    }
    this.changes.fire({ type: 'opened', book, created, migrated })
    await this.publishTree()
    return book
  }

  private async closeOpen({ forget }: { forget: boolean }) {
    const db = this.db
    const book = this.info
    if (!db || !book) return

    // Last registered first, as plugins shut down: a plugin's listener runs before those of the plugins it depends
    // on, and the book's own (its backups, registered as it activates) runs last, seeing whatever the others wrote
    for (const listener of [...this.willClose].reverse()) {
      try { await listener({ ...book }) } catch (err) { this.deps.log.error('[book] A close listener failed', err) }
    }
    this.db = undefined
    this.info = undefined
    try { await db.flush() } catch (err) { this.deps.log.error(`[book] Could not flush ${book.path}`, err) }
    try { await db.close() } catch (err) { this.deps.log.error(`[book] Could not close ${book.path}`, err) }
    if (forget) await this.deps.recent.forgetLast().catch(err => this.deps.log.warn(`[book] Could not update the recent books: ${describeError(err)}`))
    this.changes.fire({ type: 'closed', book })
  }

  // ---- The tree

  async tree(): Promise<BookTree> {
    const book = this.current
    if (!book) throw new BookError('NO_BOOK', 'No book is open.')
    return { book, subBooks: await this.subBooks.list() }
  }

  private async publishTree() {
    if (!this.info) return      // closed meanwhile: the 'closed' change says so
    try {
      this.trees.fire(await this.tree())
    } catch (err) {
      this.deps.log.error('[book] Could not read the book tree', err)
    }
  }

  private async changingTree<T>(work: () => Promise<T>): Promise<T> {
    const result = await work()
    await this.publishTree()
    return result
  }

  createSubBook(input: { name: string, parentId: string | null, notes?: string }): Promise<SubBook> {
    return this.changingTree(() => this.subBooks.create(input))
  }

  renameSubBook(id: string, name: string, options?: { expectedRev?: number }): Promise<SubBook> {
    return this.changingTree(() => this.subBooks.rename(id, name, options))
  }

  moveSubBook(id: string, to: string | null, index?: number): Promise<void> {
    return this.changingTree(() => this.subBooks.move(id, to, index))
  }

  async deleteSubBook(id: string): Promise<void> {
    await this.changingTree(() => this.subBooks.delete(id))
  }

  participate(contributor: string, participant: SubBookParticipant): Disposable {
    if (typeof participant?.reparent !== 'function' || typeof participant.describe !== 'function') {
      throw new Error(`The sub-book participant of "${contributor}" needs describe and reparent`)
    }
    if (this.participants.has(contributor)) throw new Error(`"${contributor}" already takes part in sub-books`)
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

  /** What each participant keeps directly in a sub-book, for the delete confirmation. */
  async describeContents(id: string): Promise<string[]> {
    const found: string[] = []
    for (const [contributor, participant] of this.participants) {
      try {
        const description = await participant.describe(id)
        if (description) found.push(description)
      } catch (err) {
        this.deps.log.warn(`[book] "${contributor}" could not describe sub-book ${id}: ${describeError(err)}`)
      }
    }
    return found
  }

  onWillClose(listener: (book: BookInfo) => void | Promise<void>): Disposable {
    this.willClose.add(listener)
    return { dispose: () => { this.willClose.delete(listener) } }
  }
}
