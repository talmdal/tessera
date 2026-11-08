import { describe, expect, it, vi } from 'vitest'
import { SETTINGS_PAGES_EXTENSION_POINT } from '@tessera/types'
import type { SettingsChangeEvent } from '@tessera/types'
import { SettingsService } from '../../core/settings/SettingsService'
import { createLogger } from '../helpers/runtime'
import { memorySettingsPersistence, setupSettings } from '../helpers/settings'

const DEFAULTS = { reopenLast: true, recentLimit: 10, matching: { before: 14, after: 3 } }
type LedgerSettings = typeof DEFAULTS

const stored = (values: object, version = 1) => ({ version, values })

describe('SettingsService: registering', () => {
  it('starts at the defaults when nothing is saved, and reads them back frozen', async () => {
    const { settings } = await setupSettings()
    const handle = settings.register('ledger', { defaults: DEFAULTS })

    expect(handle.id).toBe('ledger')
    expect(handle.get()).toEqual(DEFAULTS)
    expect(handle.defaults).toEqual(DEFAULTS)
    expect(Object.isFrozen(handle.get().matching)).toBe(true)
    expect(() => { (handle.get() as LedgerSettings).recentLimit = 3 }).toThrow(TypeError)
  })

  it('does not hold on to the object it was given', async () => {
    const { settings } = await setupSettings()
    const defaults = { a: { b: 1 } }
    const handle = settings.register('p', { defaults })
    defaults.a.b = 2

    expect(handle.get()).toEqual({ a: { b: 1 } })
    expect(Object.isFrozen(defaults)).toBe(false)
  })

  it('lets a plugin register several namespaces of its own, and nobody else\'s', async () => {
    const { settings } = await setupSettings()
    settings.register('ledger', { defaults: {} })
    settings.register('ledger', { id: 'ledger.display', defaults: {} })

    expect(settings.has('ledger.display')).toBe(true)
    expect(() => settings.register('evil', { id: 'ledger.stolen', defaults: {} }))
      .toThrow('"evil" cannot register settings "ledger.stolen": ids must be "evil" or start with "evil."')
    expect(() => settings.register('ledger', { defaults: {} })).toThrow('Settings "ledger" are already registered by "ledger"')
  })

  it('refuses ids that could not be file names', async () => {
    const { settings } = await setupSettings()
    for (const id of ['ledger/../x', 'ledger.', 'ledger..x', 'ledger.Display', 'ledger.a b', '']) {
      expect(() => settings.register('ledger', { id, defaults: {} }), id).toThrow('an id is lower-case words separated by dots')
    }
  })

  it('refuses definitions that are not JSON objects, or whose defaults fail their own validation', async () => {
    const { settings } = await setupSettings()
    expect(() => settings.register('p', { defaults: [] as never })).toThrow('Settings "p": the defaults must be an object')
    expect(() => settings.register('p', { defaults: { when: new Date() } as never })).toThrow('Settings "p": defaults.when is not a plain object')
    expect(() => settings.register('p', { defaults: {}, version: 1.5 })).toThrow('the version must be a whole number from 1')
    expect(() => settings.register('p', { defaults: {}, validate: 'no' as never })).toThrow('validate must be a function')
    expect(() => settings.register('p', { defaults: { n: 0 }, validate: v => v.n > 0 ? [] : ['n must be positive'] }))
      .toThrow('the defaults fail their own validation: n must be positive')
    expect(settings.has('p')).toBe(false)
  })

  it('forgets a namespace when its registration is disposed, and can register it again with what was saved', async () => {
    const { settings } = await setupSettings()
    const handle = settings.register('ledger', { defaults: DEFAULTS })
    await handle.update({ recentLimit: 4 })
    handle.dispose()

    expect(settings.has('ledger')).toBe(false)
    await expect(handle.update({ recentLimit: 5 })).rejects.toThrow('Settings "ledger" are no longer registered')
    expect(settings.register('ledger', { defaults: DEFAULTS }).get().recentLimit).toBe(4)
  })
})

describe('SettingsService: reading what was saved', () => {
  it('merges the saved overrides over the defaults, so keys added since keep their defaults', async () => {
    const { settings } = await setupSettings({ ledger: stored({ recentLimit: 5, matching: { after: 7 } }) })
    expect(settings.register('ledger', { defaults: DEFAULTS }).get())
      .toEqual({ reopenLast: true, recentLimit: 5, matching: { before: 14, after: 7 } })
  })

  it('uses the defaults, and says so, when the file is not in the expected form, leaving it alone', async () => {
    for (const document of [[], { values: {} }, { version: 0, values: {} }, { version: 1, values: 'x' }]) {
      const { settings, log, persistence } = await setupSettings({ ledger: document })
      expect(settings.register('ledger', { defaults: DEFAULTS }).get()).toEqual(DEFAULTS)
      expect(log.warn).toHaveBeenCalledWith('[settings] Settings "ledger": the saved file is not in the expected form; the defaults are used until the settings are changed')
      expect(persistence.save).not.toHaveBeenCalled()
    }
  })

  it('falls back to the default for a key of the wrong type alone', async () => {
    const { settings, log } = await setupSettings({ ledger: stored({ reopenLast: false, recentLimit: 'ten' }) })
    expect(settings.register('ledger', { defaults: DEFAULTS }).get()).toEqual({ ...DEFAULTS, reopenLast: false })
    expect(log.warn).toHaveBeenCalledWith('[settings] Settings "ledger": "recentLimit" must be a number, not a string; its default is used')
  })

  it('uses the defaults for the session when what was saved fails validation, and keeps the file until the user saves', async () => {
    const { settings, log, documents } = await setupSettings({ ledger: stored({ recentLimit: 0 }) })
    const handle = settings.register('ledger', { defaults: DEFAULTS, validate: v => v.recentLimit >= 1 ? [] : ['Keep at least one.'] })

    expect(handle.get()).toEqual(DEFAULTS)
    expect(log.warn).toHaveBeenCalledWith('[settings] Settings "ledger" fail their validation (Keep at least one.); the defaults are used until the settings are changed')
    expect(documents.get('ledger')).toEqual(stored({ recentLimit: 0 }))

    await handle.update({ recentLimit: 3 })
    expect(documents.get('ledger')).toEqual(stored({ recentLimit: 3 }))
  })

  it('runs migrate on values saved by an older version, and writes the new version only when something changes', async () => {
    const migrate = vi.fn((old: Record<string, unknown>, from: number) => from < 2 ? { recentLimit: old.keep } : old)
    const { settings, documents } = await setupSettings({ ledger: stored({ keep: 3 }) })
    const handle = settings.register('ledger', { defaults: DEFAULTS, version: 2, migrate })

    expect(migrate).toHaveBeenCalledWith({ keep: 3 }, 1)
    expect(handle.get()).toEqual({ ...DEFAULTS, recentLimit: 3 })
    expect(documents.get('ledger')).toEqual(stored({ keep: 3 }))

    await handle.update({ reopenLast: false })
    expect(documents.get('ledger')).toEqual(stored({ recentLimit: 3, reopenLast: false }, 2))
  })

  it('keeps values of an older version without migrate, as far as they still fit', async () => {
    const { settings } = await setupSettings({ ledger: stored({ recentLimit: 3 }) })
    expect(settings.register('ledger', { defaults: DEFAULTS, version: 3 }).get().recentLimit).toBe(3)
  })

  it('uses the defaults when migrate throws or returns something unusable', async () => {
    for (const migrate of [() => { throw new Error('boom') }, () => 'x' as never, () => ({ f: () => 1 }) as never]) {
      const { settings, log } = await setupSettings({ ledger: stored({ recentLimit: 3 }) })
      expect(settings.register('ledger', { defaults: DEFAULTS, version: 2, migrate }).get()).toEqual(DEFAULTS)
      expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/^\[settings\] Settings "ledger" could not be upgraded from version 1: .*; the defaults are used until the settings are changed$/))
    }
  })

  it('uses, but will not change, values saved by a newer version of the plugin', async () => {
    const { settings, log, persistence } = await setupSettings({ ledger: stored({ recentLimit: 3, added: 'later' }, 5) })
    const handle = settings.register('ledger', { defaults: DEFAULTS, version: 2 })

    expect(handle.get()).toEqual({ ...DEFAULTS, recentLimit: 3, added: 'later' })
    expect(settings.snapshot('ledger')?.readOnly).toBe('These settings were saved by a newer version of "ledger", so they can\'t be changed here.')
    expect(log.warn).toHaveBeenCalledWith('[settings] Settings "ledger" were saved by version 5 of their shape, and "ledger" knows version 2; they are read-only')
    await expect(handle.update({ recentLimit: 4 })).rejects.toThrow('can\'t be changed here')
    expect(persistence.save).not.toHaveBeenCalled()
  })

  it('applies what was saved to namespaces registered before the load, telling their listeners', async () => {
    const store = memorySettingsPersistence({ ledger: stored({ recentLimit: 2 }) })
    const settings = new SettingsService({ persistence: store.persistence })
    const handle = settings.register('ledger', { defaults: DEFAULTS })
    const heard: number[] = []
    handle.onDidChange(event => heard.push(event.value.recentLimit))

    await settings.load()

    expect(handle.get().recentLimit).toBe(2)
    expect(heard).toEqual([2])
  })

  it('starts at the defaults when the saved settings cannot be read at all', async () => {
    const log = createLogger()
    const settings = new SettingsService({ persistence: { loadAll: async () => { throw new Error('disk gone') }, save: async () => {} }, log })
    await settings.load()
    expect(settings.register('ledger', { defaults: DEFAULTS }).get()).toEqual(DEFAULTS)
    expect(log.warn).toHaveBeenCalledWith('[settings] Could not read the saved settings; the defaults are used: disk gone')
  })

  it('keeps what was saved for a namespace nobody registers', async () => {
    const { settings, persistence } = await setupSettings({ gone: stored({ x: 1 }) })
    settings.register('ledger', { defaults: DEFAULTS })
    await settings.commit([{ id: 'ledger', value: { ...DEFAULTS, recentLimit: 1 } }])
    expect(persistence.save.mock.calls.map(c => c[0])).toEqual(['ledger'])
  })
})

describe('SettingsService: changing', () => {
  it('saves only what differs from the defaults, and deletes the file when nothing does', async () => {
    const { settings, documents } = await setupSettings()
    const handle = settings.register('ledger', { defaults: DEFAULTS })

    await handle.update({ recentLimit: 4, matching: { before: 14, after: 5 } })
    expect(documents.get('ledger')).toEqual(stored({ recentLimit: 4, matching: { after: 5 } }))

    await handle.reset()
    expect(documents.has('ledger')).toBe(false)
    expect(handle.get()).toEqual(DEFAULTS)
  })

  it('tells the owner and the shell what changed, and stays quiet when nothing did', async () => {
    const { settings } = await setupSettings()
    const handle = settings.register('ledger', { defaults: DEFAULTS })
    const own: SettingsChangeEvent<LedgerSettings>[] = []
    const all: string[] = []
    handle.onDidChange(event => own.push(event))
    settings.onDidChange(event => all.push(event.id))

    await handle.update({ recentLimit: 4 })
    await handle.update({ recentLimit: 4 })

    expect(own).toEqual([{ id: 'ledger', value: { ...DEFAULTS, recentLimit: 4 }, previous: DEFAULTS, changed: ['recentLimit'] }])
    expect(all).toEqual(['ledger'])
  })

  it('keeps telling other listeners when one throws', async () => {
    const { settings, log } = await setupSettings()
    const handle = settings.register('ledger', { defaults: DEFAULTS })
    const heard = vi.fn()
    handle.onDidChange(() => { throw new Error('listener broke') })
    settings.onDidChange(heard)

    await handle.update({ recentLimit: 4 })

    expect(heard).toHaveBeenCalled()
    expect(log.error).toHaveBeenCalledWith('[settings] A listener for settings "ledger" failed', expect.any(Error))
  })

  it('refuses a change that fails validation, with the messages, changing nothing', async () => {
    const { settings, persistence } = await setupSettings()
    const handle = settings.register('ledger', { defaults: DEFAULTS, validate: v => v.recentLimit > 30 ? ['Show at most 30.'] : [] })

    const error = await handle.update({ recentLimit: 31 }).catch(err => err)
    expect(error.message).toBe('Settings "ledger" were not changed: Show at most 30.')
    expect(error.problems).toEqual(['Show at most 30.'])
    expect(handle.get()).toEqual(DEFAULTS)
    expect(persistence.save).not.toHaveBeenCalled()
  })

  it('refuses values whose keys change type, or that are not JSON objects', async () => {
    const { settings } = await setupSettings()
    settings.register('ledger', { defaults: DEFAULTS })

    expect(await settings.commit([{ id: 'ledger', value: { recentLimit: '4' } }]))
      .toEqual({ ok: false, errors: { ledger: ['"recentLimit" must be a number, not a string.'] } })
    expect(await settings.commit([{ id: 'ledger', value: [] }])).toEqual({ ok: false, errors: { ledger: ['Settings "ledger" must be an object.'] } })
    expect(await settings.commit([{ id: 'ledger', value: { recentLimit: Infinity } }]))
      .toEqual({ ok: false, errors: { ledger: ['Settings "ledger": the value.recentLimit is not a finite number.'] } })
  })

  it('reports a validate that throws as a problem rather than failing', async () => {
    const { settings } = await setupSettings()
    let broken = false
    settings.register('ledger', { defaults: DEFAULTS, validate: () => { if (broken) throw new Error('bug'); return [] } })
    broken = true
    expect(await settings.commit([{ id: 'ledger', value: DEFAULTS }])).toEqual({ ok: false, errors: { ledger: ['Settings "ledger" could not be checked: bug'] } })
  })

  it('fills keys a change leaves out with their defaults', async () => {
    const { settings } = await setupSettings()
    const handle = settings.register('ledger', { defaults: DEFAULTS })
    await settings.commit([{ id: 'ledger', value: { recentLimit: 2 } }])
    expect(handle.get()).toEqual({ ...DEFAULTS, recentLimit: 2 })
  })

  it('applies the changes of several namespaces together, or none of them', async () => {
    const { settings } = await setupSettings()
    const ledger = settings.register('ledger', { defaults: DEFAULTS })
    const accounts = settings.register('accounts', { defaults: { showClosed: false }, validate: v => v.showClosed ? ['Not yet.'] : [] })

    const refused = await settings.commit([{ id: 'ledger', value: { recentLimit: 2 } }, { id: 'accounts', value: { showClosed: true } }, { id: 'nobody', value: {} }])
    expect(refused).toEqual({ ok: false, errors: { accounts: ['Not yet.'], nobody: ['There are no settings "nobody".'] } })
    expect(ledger.get().recentLimit).toBe(10)

    const applied = await settings.commit([{ id: 'ledger', value: { recentLimit: 2 } }, { id: 'accounts', value: { showClosed: false } }])
    expect(applied).toEqual({
      ok: true,
      namespaces: [
        { id: 'ledger', owner: 'ledger', value: { ...DEFAULTS, recentLimit: 2 }, defaults: DEFAULTS },
        { id: 'accounts', owner: 'accounts', value: { showClosed: false }, defaults: { showClosed: false } }
      ]
    })
    expect(accounts.get()).toEqual({ showClosed: false })
  })

  it('refuses one namespace changed twice in one commit', async () => {
    const { settings } = await setupSettings()
    settings.register('ledger', { defaults: DEFAULTS })
    expect(await settings.commit([{ id: 'ledger', value: {} }, { id: 'ledger', value: {} }]))
      .toEqual({ ok: false, errors: { ledger: ['Settings "ledger" were changed twice at once.'] } })
  })

  it('checks the fields of the namespace\'s pages when saving', async () => {
    const { settings, extensions } = await setupSettings()
    settings.register('ledger', { defaults: DEFAULTS })
    extensions.contribute('ledger', SETTINGS_PAGES_EXTENSION_POINT, 'ledger.settings', {
      id: 'ledger.settings', title: 'Ledger', fields: [{ kind: 'number', key: 'recentLimit', label: 'Recent ledgers', min: 1, max: 30, integer: true }]
    })

    expect(await settings.commit([{ id: 'ledger', value: { recentLimit: 31 } }]))
      .toEqual({ ok: false, errors: { ledger: ['Recent ledgers: enter a number from 1 to 30.'] } })
  })

  it('keeps the value in effect, and says so, when it could not be written', async () => {
    const { settings, state, log } = await setupSettings()
    const handle = settings.register('ledger', { defaults: DEFAULTS })
    state.failWith = new Error('disk full')

    const result = await settings.commit([{ id: 'ledger', value: { recentLimit: 2 } }])

    expect(result).toMatchObject({ ok: true, saveError: 'disk full' })
    expect(handle.get().recentLimit).toBe(2)
    expect(log.error).toHaveBeenCalledWith('[settings] Could not save settings "ledger": disk full')

    state.failWith = undefined
    expect(await settings.commit([{ id: 'ledger', value: { recentLimit: 3 } }])).not.toHaveProperty('saveError')
  })

  it('writes one namespace at a time, and only the latest of changes made while a write is under way', async () => {
    const store = await setupSettings()
    const handle = store.settings.register('ledger', { defaults: DEFAULTS })
    store.hold()

    const first = handle.update({ recentLimit: 1 })
    const second = handle.update({ recentLimit: 2 })
    const third = handle.update({ recentLimit: 3 })
    store.release()
    await Promise.all([first, second, third])

    expect(store.persistence.save.mock.calls.map(c => c[1]?.values.recentLimit)).toEqual([1, 3])
    expect(store.documents.get('ledger')).toEqual(stored({ recentLimit: 3 }))
  })

  it('flushes pending writes', async () => {
    const store = await setupSettings()
    const handle = store.settings.register('ledger', { defaults: DEFAULTS })
    store.hold()
    void handle.update({ recentLimit: 7 })
    let flushed = false
    const flushing = store.settings.flush().then(() => { flushed = true })
    await Promise.resolve()
    expect(flushed).toBe(false)

    store.release()
    await flushing
    expect(store.documents.get('ledger')).toEqual(stored({ recentLimit: 7 }))
  })

  it('works without persistence, for the session', async () => {
    const settings = new SettingsService()
    await settings.load()
    const handle = settings.register('ledger', { defaults: DEFAULTS })
    await handle.update({ recentLimit: 2 })
    await settings.flush()
    expect(handle.get().recentLimit).toBe(2)
  })
})

describe('SettingsService: pages and snapshots', () => {
  it('resolves pages against the registered namespaces, logging each problem once', async () => {
    const { settings, extensions, log } = await setupSettings()
    settings.register('ledger', { defaults: DEFAULTS })
    extensions.contribute('ledger', SETTINGS_PAGES_EXTENSION_POINT, 'ledger.settings', { id: 'ledger.settings', title: 'Ledger', fields: [{ kind: 'boolean', key: 'reopenLast', label: 'Reopen' }] })
    extensions.contribute('budget', SETTINGS_PAGES_EXTENSION_POINT, 'budget.settings', { id: 'budget.settings', title: 'Budget', module: './Page' })

    expect(settings.pages().map(p => p.id)).toEqual(['ledger.settings'])
    settings.pages()
    expect(log.warn.mock.calls.filter((c: unknown[]) => String(c[0]).includes('budget'))).toEqual([['[settings] Settings page "budget.settings" ignored: settings "budget" are not registered']])
  })

  it('gives the shell copies it can send anywhere', async () => {
    const { settings } = await setupSettings()
    settings.register('ledger', { defaults: DEFAULTS })
    const [snapshot] = settings.snapshots()

    expect(snapshot).toEqual({ id: 'ledger', owner: 'ledger', value: DEFAULTS, defaults: DEFAULTS })
    expect(Object.isFrozen(snapshot.value)).toBe(false)
    expect(settings.snapshot('nobody')).toBeUndefined()
  })
})

describe('SettingsService: what a change says', () => {
  it('tells the owner which settings changed, including those in nested objects', async () => {
    const { settings } = await setupSettings()
    const handle = settings.register('ledger', { defaults: DEFAULTS })
    const changed: string[][] = []
    handle.onDidChange(event => changed.push(event.changed))

    await settings.commit([{ id: 'ledger', value: { ...DEFAULTS, reopenLast: false, matching: { before: 14, after: 9 } } }])
    await handle.reset()

    expect(changed).toEqual([['reopenLast', 'matching.after'], ['reopenLast', 'matching.after']])
  })

  it('tells each namespace of a commit only about its own changes', async () => {
    const { settings } = await setupSettings()
    const ledger = settings.register('ledger', { defaults: DEFAULTS })
    const accounts = settings.register('accounts', { defaults: { compact: false, currency: 'CAD' } })
    const heard: string[] = []
    ledger.onDidChange(e => heard.push(`${e.id}: ${e.changed.join(', ')}`))
    accounts.onDidChange(e => heard.push(`${e.id}: ${e.changed.join(', ')}`))

    await settings.commit([{ id: 'ledger', value: { recentLimit: 3 } }, { id: 'accounts', value: { compact: true, currency: 'CAD' } }])

    expect(heard).toEqual(['ledger: recentLimit', 'accounts: compact'])
  })
})

describe('SettingsService: reading without changing', () => {
  it('reads any namespace, frozen, and has no way to change it', async () => {
    const { settings } = await setupSettings({ ledger: stored({ recentLimit: 4 }) })
    settings.register('ledger', { defaults: DEFAULTS })
    const reader = settings.reader<LedgerSettings>('ledger')

    expect(reader.get()).toEqual({ ...DEFAULTS, recentLimit: 4 })
    expect(Object.keys(reader).sort()).toEqual(['get', 'id', 'onDidChange'])
    expect(() => { (reader.get() as LedgerSettings).recentLimit = 30 }).toThrow(TypeError)
    expect(settings.snapshot('ledger')?.value.recentLimit).toBe(4)
  })

  it('reads nothing until the owner registers, and follows it from then on', async () => {
    const { settings } = await setupSettings({ ledger: stored({ recentLimit: 4 }) })
    const reader = settings.reader<LedgerSettings>('ledger')
    const heard: string[][] = []
    reader.onDidChange(event => heard.push(event.changed))
    expect(reader.get()).toBeUndefined()

    const handle = settings.register('ledger', { defaults: DEFAULTS })
    expect(reader.get()?.recentLimit).toBe(4)

    await handle.update({ reopenLast: false })
    await settings.commit([{ id: 'ledger', value: { reopenLast: false, recentLimit: 2 } }])
    expect(heard).toEqual([['reopenLast'], ['recentLimit']])

    handle.dispose()
    expect(reader.get()).toBeUndefined()
  })

  it('hears only its own namespace', async () => {
    const { settings } = await setupSettings()
    settings.register('ledger', { defaults: DEFAULTS })
    const accounts = settings.register('accounts', { defaults: { compact: false } })
    const heard = vi.fn()
    settings.reader('ledger').onDidChange(heard)

    await accounts.update({ compact: true })

    expect(heard).not.toHaveBeenCalled()
  })

  it('refuses an id that is not a settings id', async () => {
    const { settings } = await setupSettings()
    expect(() => settings.reader('../ledger')).toThrow('"../ledger" is not a settings id')
  })
})
