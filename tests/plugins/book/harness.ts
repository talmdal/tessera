// Test doubles for the book plugin: a memory storage engine with a fake disk over it, and fake shell services.
import path from 'node:path'
import { Readable, Writable } from 'node:stream'
import { vi } from 'vitest'
import type { AppState, ShellFiles, ShellPrompts } from '@tessera/types'
import { KitStorageEngine, memoryDriver } from '@tessera/storage-kit'
import type { Migrator, SchemaContribution } from '@tessera/book-api'
import { BOOK_SCHEMA_POINT } from '@tessera/book-api'
import { ExtensionRegistryImpl } from '../../../core/extensions/ExtensionRegistry'
import { ServiceRegistryImpl } from '../../../core/services/ServiceRegistry'
import type { FileKind, BookDisk } from '../../../plugins/book/src/privileged/disk'
import { BookSessionImpl } from '../../../plugins/book/src/privileged/BookSessionImpl'
import { RecentBooks } from '../../../plugins/book/src/privileged/RecentBooks'
import { SchemaRegistry } from '../../../plugins/book/src/privileged/SchemaRegistry'
import type { BackupDisk } from '../../../plugins/book/src/privileged/backups/BackupDisk'
import { isBackupFileName } from '../../../plugins/book/src/privileged/backups/naming'

/** A folder that is absolute on every platform. */
export const DIR = path.resolve('/books')
export const file = (name: string) => path.join(DIR, name)

export function memoryAppState(): AppState & { values: Map<string, unknown> } {
  const values = new Map<string, unknown>()
  return {
    values,
    get: async <T>(key: string, defaultFn?: () => T) => (values.has(key) ? values.get(key) : defaultFn?.()) as T | undefined,
    set: async (key, value) => { values.set(key, structuredClone(value)) },
    update: async (key, patch) => { values.set(key, { ...(values.get(key) as object), ...(patch as object) }) },
    remove: async key => { values.delete(key) }
  }
}

/**
 * The memory driver's databases are the "files". `foreign` holds files that exist but aren't databases, with what
 * their first bytes look like; `sides` holds side files (`-wal`…) that exist.
 */
export function memoryDisk(driver: ReturnType<typeof memoryDriver>) {
  const foreign = new Map<string, FileKind>()
  const sides = new Set<string>()
  const copies: [string, string][] = []
  const disk: BookDisk = {
    exists: async f => driver.databases.has(f) || foreign.has(f) || sides.has(f),
    sniff: async f => foreign.get(f) ?? 'unknown',
    sideFiles: async f => [...sides].filter(side => side.startsWith(f) && side !== f),
    copyWithSideFiles: async (from, to) => {
      copies.push([from, to])
      const files = driver.databases.get(from)
      if (files) driver.databases.set(to, structuredClone(files))
    }
  }
  return { disk, foreign, sides, copies }
}

export function fakeFiles(driver: ReturnType<typeof memoryDriver>, disk: ReturnType<typeof memoryDisk>) {
  const trashed: string[] = []
  const files = {
    showOpenDialog: vi.fn(async (): Promise<string | undefined> => undefined),
    showFolderDialog: vi.fn(async (): Promise<string | undefined> => undefined),
    showSaveDialog: vi.fn(async (): Promise<string | undefined> => undefined),
    exists: vi.fn(async (f: string) => disk.disk.exists(f)),
    trash: vi.fn(async (f: string) => {
      trashed.push(f)
      driver.databases.delete(f)
      disk.foreign.delete(f)
      disk.sides.delete(f)
    }),
    documentsPath: vi.fn(() => path.join(DIR, 'Documents'))
  } satisfies ShellFiles
  return { files, trashed }
}

export function fakePrompts() {
  const answers: boolean[] = []
  const prompts = {
    /** Answers queued with `answers.push`; true when none is queued. */
    confirm: vi.fn(async (_options: Parameters<ShellPrompts['confirm']>[0]) => answers.length > 0 ? answers.shift()! : true),
    message: vi.fn(async (_options: Parameters<ShellPrompts['message']>[0]) => {}),
    prompt: vi.fn(async () => undefined as string | undefined),
    show: vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined)
  }
  return { prompts: prompts as typeof prompts & ShellPrompts, answers }
}

export const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })

/** A `book.schema` contributor with a recording migrator. */
export function contributor(id: string, version: number, migrate: Migrator['migrate'] = async () => {}) {
  const contribution: SchemaContribution = {
    id, version, migrator: `${id}.migrator`,
    collections: [{ name: `${id}.things`, indexes: [{ name: 'byName', fields: ['name'], unique: true }] }]
  }
  return { contribution, migrator: { migrate: vi.fn(migrate) } }
}

/** A session over a memory engine, with every dependency faked and exposed. */
export function setupSession(options: { now?: () => Date } = {}) {
  const driver = memoryDriver()
  const engine = new KitStorageEngine(driver)
  const disk = memoryDisk(driver)
  const { files, trashed } = fakeFiles(driver, disk)
  const { prompts, answers } = fakePrompts()
  const state = memoryAppState()
  const extensions = new ExtensionRegistryImpl()
  const services = new ServiceRegistryImpl()
  const log = logger()
  const recent = new RecentBooks(state, options.now)
  const schema = new SchemaRegistry(extensions, services, log)
  const session = new BookSessionImpl({
    engine, files, prompts, recent, schema, disk: disk.disk, log, trashName: 'Trash',
    ...(options.now && { now: options.now })
  })

  const contribute = ({ contribution, migrator }: ReturnType<typeof contributor>) => {
    extensions.contribute(contribution.id, BOOK_SCHEMA_POINT, contribution.id, contribution)
    if (!services.has(contribution.migrator)) services.provide(contribution.id, contribution.migrator, migrator)
  }

  /** Creates a book at `name` without dialogs. */
  const created = async (name = 'Home.tessera') => {
    const book = await session.create(file(name))
    if (!book) throw new Error('not created')
    return book
  }

  return { driver, engine, disk, files, trashed, prompts, answers, state, extensions, services, log, recent, schema, session, contribute, created }
}

/**
 * A `BackupDisk` in memory: `folders` exist, `files` hold their bytes. `hold()` makes the next writes wait until
 * released, and `failWrites` makes them fail, for testing what closing and quitting do while a backup is written.
 */
export function memoryBackupDisk() {
  const folders = new Set<string>()
  const files = new Map<string, { bytes: Buffer, modifiedAt: Date }>()
  const writes: string[] = []
  let gate: Promise<void> | undefined
  let release: (() => void) | undefined
  const control = {
    folders, files, writes,
    disk: undefined as unknown as BackupDisk,
    /** Set to make every write from now on fail with it. */
    failWrites: undefined as Error | undefined,
    /** Writes started from now on wait (part-way, as a slow drive would) until `release()`. */
    hold() { gate = new Promise<void>(resolve => { release = resolve }) },
    release() { release?.(); gate = undefined }
  }
  const inFolder = (folder: string, wanted: (name: string) => boolean) =>
    [...files].filter(([file]) => path.dirname(file) === folder && wanted(path.basename(file)))
      .map(([file, { bytes, modifiedAt }]) => ({ file, size: bytes.length, modifiedAt }))
      .sort((a, b) => a.file < b.file ? -1 : 1)

  const disk: BackupDisk = {
    folderExists: async folder => folders.has(folder),
    makeFolder: async folder => { for (let f = folder; !folders.has(f) && f !== path.dirname(f); f = path.dirname(f)) folders.add(f) },
    async create(folder, name, write) {
      if (!folders.has(folder)) throw Object.assign(new Error(`ENOENT: no such folder ${folder}`), { code: 'ENOENT' })
      const partial = path.join(folder, `${name(1)}.0123abcd.partial`)
      const chunks: Buffer[] = []
      const waiting = gate
      const out = new Writable({
        write(chunk, _encoding, done) {
          chunks.push(Buffer.from(chunk))
          files.set(partial, { bytes: Buffer.concat(chunks), modifiedAt: new Date() })
          if (waiting) waiting.then(() => done(control.failWrites)); else done(control.failWrites)
        }
      })
      try {
        await write(out)
      } catch (err) {
        files.delete(partial)
        throw err
      }
      files.delete(partial)
      for (let attempt = 1; ; attempt++) {
        const target = path.join(folder, name(attempt))
        if (files.has(target)) continue
        files.set(target, { bytes: Buffer.concat(chunks), modifiedAt: new Date() })
        writes.push(target)
        return target
      }
    },
    open: file => {
      const stored = files.get(file)
      if (!stored) return new Readable({ read() { this.destroy(Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' })) } })
      return Readable.from([stored.bytes])
    },
    list: async folder => inFolder(folder, isBackupFileName),
    partials: async folder => inFolder(folder, n => n.endsWith('.partial')),
    remove: async file => { files.delete(file) }
  }
  control.disk = disk
  return control
}
