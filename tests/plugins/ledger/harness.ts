// Test doubles for the ledger plugin: a memory storage engine with a fake disk over it, and fake shell services.
import path from 'node:path'
import { vi } from 'vitest'
import type { AppState, FileDialogOptions, ShellFiles, ShellPrompts } from '@tessera/types'
import { KitStorageEngine, memoryDriver } from '@tessera/storage-kit'
import type { Migrator, SchemaContribution } from '@tessera/ledger-api'
import { LEDGER_SCHEMA_POINT } from '@tessera/ledger-api'
import { ExtensionRegistryImpl } from '../../../core/extensions/ExtensionRegistry'
import { ServiceRegistryImpl } from '../../../core/services/ServiceRegistry'
import type { FileKind, LedgerDisk } from '../../../plugins/ledger/src/privileged/disk'
import { LedgerSessionImpl } from '../../../plugins/ledger/src/privileged/LedgerSessionImpl'
import { RecentLedgers } from '../../../plugins/ledger/src/privileged/RecentLedgers'
import { SchemaRegistry } from '../../../plugins/ledger/src/privileged/SchemaRegistry'
import { createPluginState } from '../../../core/state/PluginState'

/** A folder that is absolute on every platform. */
export const DIR = path.resolve('/ledgers')
export const file = (name: string) => path.join(DIR, name)

/** A plugin's `context.state` over a store, as the plugin context gives it: its own keys, `<pluginId>.<key>`. */
export const pluginState = (pluginId: string, store: AppState) => createPluginState(pluginId, () => store)

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

/** An error as Node's file system gives it. */
export const errno = (code: string, message = code) => Object.assign(new Error(`${code}: ${message}`), { code })

/**
 * The memory driver's databases are the "files". `foreign` holds files that exist but aren't databases, with what
 * their first bytes look like; `sides` holds side files (`-wal`…) that exist. `hooks` make an operation fail: throw
 * from one (an `errno(...)`) to act as the file system would.
 */
export function memoryDisk(driver: ReturnType<typeof memoryDriver>) {
  const foreign = new Map<string, FileKind>()
  const sides = new Set<string>()
  /** Files whose header says WAL mode. */
  const wal = new Set<string>()
  const copies: [string, string][] = []
  const folders = new Set<string>()
  const hooks: { rename?(from: string, to: string): void, mkdir?(folder: string): void, remove?(file: string): void, copy?(from: string, to: string): void } = {}
  /** When each file last changed, for `stat`; the epoch when not set. */
  const modified = new Map<string, Date>()
  const all = () => [...driver.databases.keys(), ...foreign.keys(), ...sides]
  const disk: LedgerDisk = {
    exists: async f => driver.databases.has(f) || foreign.has(f) || sides.has(f),
    sniff: async f => foreign.get(f) ?? 'unknown',
    walMode: async f => wal.has(f),
    sideFiles: async f => [...sides].filter(side => side.startsWith(f) && side !== f),
    copyWithSideFiles: async (from, to) => {
      copies.push([from, to])
      const files = driver.databases.get(from)
      if (files) driver.databases.set(to, structuredClone(files))
    },
    list: async folder => all().filter(f => path.dirname(f) === folder).sort(),
    rename: async (from, to) => {
      hooks.rename?.(from, to)
      const files = driver.databases.get(from)
      const kind = foreign.get(from)
      const side = sides.has(from)
      if (!files && kind === undefined && !side) throw errno('ENOENT', `no such file, rename '${from}'`)
      if (files) { driver.databases.delete(from); driver.databases.set(to, files) }
      if (kind !== undefined) { foreign.delete(from); foreign.set(to, kind) }
      if (side) { sides.delete(from); sides.add(to) }
    },
    remove: async f => {
      hooks.remove?.(f)
      driver.databases.delete(f)
      foreign.delete(f)
      sides.delete(f)
    },
    mkdir: async folder => { hooks.mkdir?.(folder); folders.add(folder) },
    realpath: async f => path.resolve(f),
    copy: async (from, to, onProgress) => {
      hooks.copy?.(from, to)
      if (driver.databases.has(to) || foreign.has(to) || sides.has(to)) throw errno('EEXIST', `file already exists, open '${to}'`)
      const files = driver.databases.get(from)
      const kind = foreign.get(from)
      if (!files && kind === undefined) throw errno('ENOENT', `no such file, open '${from}'`)
      onProgress?.(0.5)
      if (files) driver.databases.set(to, structuredClone(files))
      if (kind !== undefined) foreign.set(to, kind)
      onProgress?.(1)
    },
    isFolder: async folder => folders.has(folder) || all().some(f => path.dirname(f) === folder),
    stat: async f => {
      const files = driver.databases.get(f)
      if (!files && !foreign.has(f)) throw errno('ENOENT', `no such file, stat '${f}'`)
      const size = files ? JSON.stringify([...files.collections].map(([n, c]) => [n, [...c.docs.values()]])).length : 10
      return { size, modified: modified.get(f) ?? new Date(0) }
    }
  }
  return { disk, foreign, sides, copies, folders, hooks, modified, wal }
}

export function fakeFiles(driver: ReturnType<typeof memoryDriver>, disk: ReturnType<typeof memoryDisk>) {
  const trashed: string[] = []
  const files = {
    showOpenDialog: vi.fn(async (): Promise<string | undefined> => undefined),
    showOpenFilesDialog: vi.fn(async (): Promise<string[]> => []),
    showOpenFolderDialog: vi.fn(async (_options?: FileDialogOptions): Promise<string | undefined> => undefined),
    showSaveDialog: vi.fn(async (_options?: FileDialogOptions): Promise<string | undefined> => undefined),
    exists: vi.fn(async (f: string) => disk.disk.exists(f)),
    trash: vi.fn(async (f: string) => {
      trashed.push(f)
      driver.databases.delete(f)
      disk.foreign.delete(f)
      disk.sides.delete(f)
    }),
    documentsPath: vi.fn(() => path.join(DIR, 'Documents')),
    downloadsPath: vi.fn(() => path.join(DIR, 'Downloads'))
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

/** A `ledger.schema` contributor with a recording migrator. */
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
  // As context.state gives it: the ledger's own keys in app.state
  const recent = new RecentLedgers(pluginState('ledger', state), options.now)
  const schema = new SchemaRegistry(extensions, services, log)
  const session = new LedgerSessionImpl({ engine, files, prompts, recent, schema, disk: disk.disk, log, trashName: 'Trash', ...(options.now && { now: options.now }) })

  const contribute = ({ contribution, migrator }: ReturnType<typeof contributor>) => {
    extensions.contribute(contribution.id, LEDGER_SCHEMA_POINT, contribution.id, contribution)
    if (!services.has(contribution.migrator)) services.provide(contribution.id, contribution.migrator, migrator)
  }

  /** Creates a ledger at `name` without dialogs. */
  const created = async (name = 'Home.tessera') => {
    const ledger = await session.create(file(name))
    if (!ledger) throw new Error('not created')
    return ledger
  }

  return { driver, engine, disk, files, trashed, prompts, answers, state, extensions, services, log, recent, schema, session, contribute, created }
}
