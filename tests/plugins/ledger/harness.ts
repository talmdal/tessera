// Test doubles for the ledger plugin: a memory storage engine with a fake disk over it, and fake shell services.
import path from 'node:path'
import { vi } from 'vitest'
import type { AppState, ShellFiles, ShellPrompts } from '@tessera/types'
import { KitStorageEngine, memoryDriver } from '@tessera/storage-kit'
import type { Migrator, SchemaContribution } from '@tessera/ledger-api'
import { LEDGER_SCHEMA_POINT } from '@tessera/ledger-api'
import { ExtensionRegistryImpl } from '../../../core/extensions/ExtensionRegistry'
import { ServiceRegistryImpl } from '../../../core/services/ServiceRegistry'
import type { FileKind, LedgerDisk } from '../../../plugins/ledger/src/privileged/disk'
import { LedgerSessionImpl } from '../../../plugins/ledger/src/privileged/LedgerSessionImpl'
import { RecentLedgers } from '../../../plugins/ledger/src/privileged/RecentLedgers'
import { SchemaRegistry } from '../../../plugins/ledger/src/privileged/SchemaRegistry'

/** A folder that is absolute on every platform. */
export const DIR = path.resolve('/ledgers')
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
  const disk: LedgerDisk = {
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
    showOpenFilesDialog: vi.fn(async (): Promise<string[]> => []),
    showSaveDialog: vi.fn(async (): Promise<string | undefined> => undefined),
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
  const recent = new RecentLedgers(state, options.now)
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
