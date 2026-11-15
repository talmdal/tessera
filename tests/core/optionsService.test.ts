import { describe, it, expect, vi } from 'vitest'
import type { Json, OptionsDocument } from '@tessera/types'
import { OptionsService } from '../../core/options/OptionsService'
import type { OptionsStore } from '../../core/ports'
import { createLogger } from '../helpers/runtime'

/** An in-memory store, standing in for the JSON file. */
function memoryStore(initial: OptionsDocument = {}) {
  const store = {
    document: initial,
    writes: 0,
    flushes: 0,
    read: () => store.document,
    write: (document: OptionsDocument) => { store.document = document; store.writes++ },
    flush: async () => { store.flushes++ }
  }
  return store satisfies OptionsStore & { document: OptionsDocument, writes: number, flushes: number }
}

const entry = (version: number, values: Json) => ({ version, values })

const BACKUP_DEFAULTS = { autoBackup: true, backup: { count: 5, folder: null as string | null } }

describe('OptionsService: registering', () => {
  it('gives the defaults when nothing is stored, and writes nothing', () => {
    const store = memoryStore()
    const options = new OptionsService(store)

    expect(options.register('book', { defaults: BACKUP_DEFAULTS }).get()).toEqual(BACKUP_DEFAULTS)
    expect(store.writes).toBe(0)
    expect(store.document).toEqual({})
  })

  it('lays the stored overrides over the defaults, so a value is never partial', () => {
    const store = memoryStore({ book: entry(1, { backup: { count: 9 } }) })
    const options = new OptionsService(store)

    expect(options.register('book', { defaults: BACKUP_DEFAULTS }).get())
      .toEqual({ autoBackup: true, backup: { count: 9, folder: null } })
  })

  it('reads a key added in a newer version of the plugin from the defaults, without a migration', () => {
    const store = memoryStore({ book: entry(1, { autoBackup: false }) })
    const options = new OptionsService(store)
    const handle = options.register('book', { defaults: { ...BACKUP_DEFAULTS, addedLater: 'new' } })

    expect(handle.get()).toEqual({ autoBackup: false, backup: { count: 5, folder: null }, addedLater: 'new' })
  })

  it('is synchronous, so a plugin can read its options the moment it activates', () => {
    const options = new OptionsService(memoryStore({ book: entry(1, { autoBackup: false }) }))
    const value = options.register('book', { defaults: BACKUP_DEFAULTS }).get()
    expect(value.autoBackup).toBe(false)      // no await anywhere
  })

  it('refuses a second registration of the same namespace', () => {
    const options = new OptionsService(memoryStore())
    options.register('book', { defaults: BACKUP_DEFAULTS })
    expect(() => options.register('book', { defaults: BACKUP_DEFAULTS })).toThrow(/already registered/)
  })

  it('hands out copies, so a caller cannot mutate what the service holds', () => {
    const options = new OptionsService(memoryStore())
    const handle = options.register('book', { defaults: BACKUP_DEFAULTS })
    handle.get().backup.count = 99
    expect(handle.get().backup.count).toBe(5)
  })

  it('does not share the defaults it was given', () => {
    const defaults = { ...BACKUP_DEFAULTS }
    const options = new OptionsService(memoryStore())
    const handle = options.register('book', { defaults })
    defaults.autoBackup = false
    expect(handle.get().autoBackup).toBe(true)
  })
})

describe('OptionsService: versions and migration', () => {
  it('migrates values written by an older version, and writes the result back once', () => {
    const store = memoryStore({ book: entry(1, { keepBackups: 9 }) })
    const options = new OptionsService(store)

    const handle = options.register('book', {
      version: 2,
      defaults: BACKUP_DEFAULTS,
      migrate: (old, from) => from < 2 ? { backup: { count: (old as { keepBackups: number }).keepBackups } } : old
    })

    expect(handle.get()).toEqual({ autoBackup: true, backup: { count: 9, folder: null } })
    expect(store.document.book).toEqual(entry(2, { backup: { count: 9 } }))
    expect(store.writes).toBe(1)
  })

  it('does not call migrate when the stored version matches, and writes nothing', () => {
    const store = memoryStore({ book: entry(2, { autoBackup: false }) })
    const migrate = vi.fn()
    new OptionsService(store).register('book', { version: 2, defaults: BACKUP_DEFAULTS, migrate })

    expect(migrate).not.toHaveBeenCalled()
    expect(store.writes).toBe(0)
  })

  it('carries older values over unchanged when the plugin has no migrate function', () => {
    const store = memoryStore({ book: entry(1, { autoBackup: false }) })
    const handle = new OptionsService(store).register('book', { version: 3, defaults: BACKUP_DEFAULTS })

    expect(handle.get().autoBackup).toBe(false)
    expect(store.document.book).toEqual(entry(3, { autoBackup: false }))
  })

  it('falls back to the defaults when migrate throws, and leaves the file alone', () => {
    const store = memoryStore({ book: entry(1, { autoBackup: false }) })
    const log = createLogger()
    const handle = new OptionsService(store, { log }).register('book', {
      version: 2, defaults: BACKUP_DEFAULTS, migrate: () => { throw new Error('bad migration') }
    })

    expect(handle.get()).toEqual(BACKUP_DEFAULTS)
    expect(store.document.book).toEqual(entry(1, { autoBackup: false }))
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('bad migration'))
  })

  it('uses values from a newer version read-only, and never rewrites them', () => {
    const store = memoryStore({ book: entry(7, { autoBackup: false, future: 'keep me' }) })
    const log = createLogger()
    const handle = new OptionsService(store, { log }).register('book', { version: 2, defaults: BACKUP_DEFAULTS })

    expect(handle.get()).toMatchObject({ autoBackup: false, future: 'keep me' })
    expect(store.writes).toBe(0)
    expect(store.document.book).toEqual(entry(7, { autoBackup: false, future: 'keep me' }))
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('newer'))
  })
})

describe('OptionsService: damaged and foreign entries', () => {
  it.each([
    ['not an object', 'nonsense'],
    ['an array', []],
    ['missing a version', { values: { autoBackup: false } }],
    ['missing its values', { version: 1 }],
    ['versioned with a string', { version: 'two', values: {} }],
    ['versioned with zero', { version: 0, values: {} }]
  ])('falls back to the defaults when the entry is %s, with a warning', (_label, stored) => {
    const log = createLogger()
    const store = memoryStore({ book: stored as Json })
    const handle = new OptionsService(store, { log }).register('book', { defaults: BACKUP_DEFAULTS })

    expect(handle.get()).toEqual(BACKUP_DEFAULTS)
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('malformed'))
    expect(store.writes).toBe(0)                              // left untouched until the user commits
  })

  it('leaves one damaged entry from spoiling its neighbours', () => {
    const store = memoryStore({ book: 'nonsense' as Json, ledger: entry(1, { tidy: true }) })
    const options = new OptionsService(store, { log: createLogger() })

    expect(options.register('book', { defaults: BACKUP_DEFAULTS }).get()).toEqual(BACKUP_DEFAULTS)
    expect(options.register('ledger', { defaults: { tidy: false } }).get()).toEqual({ tidy: true })
  })

  it('keeps the entries of plugins that have not registered, so a disabled plugin loses nothing', () => {
    const store = memoryStore({ book: entry(1, { autoBackup: false }), absent: entry(4, { kept: true }) })
    const options = new OptionsService(store)

    options.register('book', { defaults: BACKUP_DEFAULTS })
    options.commit('book', { autoBackup: true, backup: { count: 1, folder: null } })

    expect(store.document.absent).toEqual(entry(4, { kept: true }))
  })
})

describe('OptionsService: validation', () => {
  const validate = (value: typeof BACKUP_DEFAULTS) => value.backup.count >= 1 ? [] : ['Keep at least one backup']

  it('uses the defaults for the session when the stored value is invalid, leaving the file untouched', () => {
    const store = memoryStore({ book: entry(1, { backup: { count: 0 } }) })
    const log = createLogger()
    const handle = new OptionsService(store, { log }).register('book', { defaults: BACKUP_DEFAULTS, validate })

    expect(handle.get()).toEqual(BACKUP_DEFAULTS)
    expect(store.writes).toBe(0)
    expect(store.document.book).toEqual(entry(1, { backup: { count: 0 } }))
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('Keep at least one backup'))
  })

  it('refuses an invalid commit, saving nothing and keeping the previous value', () => {
    const store = memoryStore()
    const options = new OptionsService(store)
    const handle = options.register('book', { defaults: BACKUP_DEFAULTS, validate })

    expect(options.commit('book', { autoBackup: true, backup: { count: 0, folder: null } }))
      .toEqual(['Keep at least one backup'])
    expect(handle.get()).toEqual(BACKUP_DEFAULTS)
    expect(store.writes).toBe(0)
  })

  it('treats a validate that throws as a failure, not a crash', () => {
    const log = createLogger()
    const options = new OptionsService(memoryStore(), { log })
    options.register('book', { defaults: BACKUP_DEFAULTS, validate: () => { throw new Error('boom') } })

    expect(options.commit('book', BACKUP_DEFAULTS)).toEqual([expect.stringContaining('boom')])
  })

  it('does not migrate a value that fails validation', () => {
    const store = memoryStore({ book: entry(1, { backup: { count: 0 } }) })
    new OptionsService(store, { log: createLogger() })
      .register('book', { version: 2, defaults: BACKUP_DEFAULTS, validate, migrate: old => old })

    expect(store.writes).toBe(0)
  })
})

describe('OptionsService: committing and resetting', () => {
  it('stores only what differs from the defaults', () => {
    const store = memoryStore()
    const options = new OptionsService(store)
    options.register('book', { version: 2, defaults: BACKUP_DEFAULTS })

    expect(options.commit('book', { autoBackup: true, backup: { count: 9, folder: null } })).toEqual([])
    expect(store.document).toEqual({ book: entry(2, { backup: { count: 9 } }) })
  })

  it('removes the entry when the value matches the defaults again', () => {
    const store = memoryStore({ book: entry(1, { autoBackup: false }) })
    const options = new OptionsService(store)
    options.register('book', { defaults: BACKUP_DEFAULTS })

    options.commit('book', BACKUP_DEFAULTS)
    expect(store.document.book).toBeUndefined()
  })

  it('reports the new value through get and onDidChange', () => {
    const options = new OptionsService(memoryStore())
    const handle = options.register('book', { defaults: BACKUP_DEFAULTS })
    const changes: unknown[] = []
    handle.onDidChange((value, previous) => changes.push({ value, previous }))

    options.commit('book', { autoBackup: false, backup: { count: 5, folder: null } })

    expect(handle.get().autoBackup).toBe(false)
    expect(changes).toEqual([{
      value: { autoBackup: false, backup: { count: 5, folder: null } },
      previous: BACKUP_DEFAULTS
    }])
  })

  it('stays quiet when a commit changes nothing', () => {
    const options = new OptionsService(memoryStore())
    const handle = options.register('book', { defaults: BACKUP_DEFAULTS })
    const listener = vi.fn()
    handle.onDidChange(listener)

    options.commit('book', { ...BACKUP_DEFAULTS })
    expect(listener).not.toHaveBeenCalled()
  })

  it('stops telling a listener that has been disposed', () => {
    const options = new OptionsService(memoryStore())
    const handle = options.register('book', { defaults: BACKUP_DEFAULTS })
    const listener = vi.fn()
    handle.onDidChange(listener).dispose()

    options.commit('book', { autoBackup: false, backup: { count: 5, folder: null } })
    expect(listener).not.toHaveBeenCalled()
  })

  it('keeps telling the other listeners when one throws', () => {
    const log = createLogger()
    const options = new OptionsService(memoryStore(), { log })
    const handle = options.register('book', { defaults: BACKUP_DEFAULTS })
    const second = vi.fn()
    handle.onDidChange(() => { throw new Error('listener boom') })
    handle.onDidChange(second)

    options.commit('book', { autoBackup: false, backup: { count: 5, folder: null } })

    expect(second).toHaveBeenCalledOnce()
    expect(log.error).toHaveBeenCalled()
  })

  it('puts a namespace back to its defaults and removes its entry', () => {
    const store = memoryStore({ book: entry(1, { autoBackup: false }) })
    const options = new OptionsService(store)
    const handle = options.register('book', { defaults: BACKUP_DEFAULTS })
    const listener = vi.fn()
    handle.onDidChange(listener)

    options.reset('book')

    expect(handle.get()).toEqual(BACKUP_DEFAULTS)
    expect(store.document.book).toBeUndefined()
    expect(listener).toHaveBeenCalledOnce()
  })

  it('lets the user replace values a newer version of the plugin wrote, since they asked for it', () => {
    const store = memoryStore({ book: entry(7, { autoBackup: false }) })
    const log = createLogger()
    const options = new OptionsService(store, { log })
    options.register('book', { version: 2, defaults: BACKUP_DEFAULTS })

    options.commit('book', { autoBackup: true, backup: { count: 3, folder: null } })

    expect(store.document.book).toEqual(entry(2, { backup: { count: 3 } }))
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('newer version'))
  })

  it('refuses to commit or reset a namespace nobody registered', () => {
    const options = new OptionsService(memoryStore())
    expect(() => options.commit('nobody', {})).toThrow(/No options are registered/)
    expect(() => options.reset('nobody')).toThrow(/No options are registered/)
  })

  it('survives a store that cannot write, without losing the value in memory', () => {
    const log = createLogger()
    const store = { ...memoryStore(), write: () => { throw new Error('disk full') } }
    const options = new OptionsService(store, { log })
    const handle = options.register('book', { defaults: BACKUP_DEFAULTS })

    expect(options.commit('book', { autoBackup: false, backup: { count: 5, folder: null } })).toEqual([])
    expect(handle.get().autoBackup).toBe(false)
    expect(log.error).toHaveBeenCalled()
  })
})

describe('OptionsService: reading other namespaces', () => {
  it('answers what is registered, what it holds and what its defaults are', async () => {
    const store = memoryStore({ book: entry(1, { autoBackup: false }) })
    const options = new OptionsService(store)
    options.register('book', { defaults: BACKUP_DEFAULTS })

    expect(options.has('book')).toBe(true)
    expect(options.has('ledger')).toBe(false)
    expect(options.namespaces()).toEqual(['book'])
    expect(options.get('book')).toMatchObject({ autoBackup: false })
    expect(options.defaults('book')).toEqual(BACKUP_DEFAULTS)
    expect(options.get('ledger')).toBeUndefined()
    expect(options.defaults('ledger')).toBeUndefined()

    await options.flush()
    expect(store.flushes).toBe(1)
  })
})
