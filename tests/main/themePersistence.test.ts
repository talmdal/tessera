import { describe, expect, it, vi } from 'vitest'
import type { AppState } from '@tessera/types'
import { SettingsService } from '../../core/settings/SettingsService'
import { THEME_SETTINGS } from '../../shared/theme/settings'
import { createThemePersistence } from '../../shell/main/theme/appStatePersistence'
import { createLogger } from '../helpers/runtime'

function fakeAppState(initial: Record<string, unknown> = {}) {
  const data = new Map(Object.entries(initial))
  const state = {
    get: vi.fn(async (key: string) => data.get(key)),
    set: vi.fn(async (key: string, value: unknown) => { data.set(key, value) }),
    update: vi.fn(),
    remove: vi.fn(async (key: string) => { data.delete(key) })
  } as unknown as AppState
  return { data, state }
}

function themeSettings() {
  const service = new SettingsService()
  return service.register('shell', THEME_SETTINGS)
}

describe('createThemePersistence', () => {
  it('reads the application-wide choice from the shell.theme setting, and leaves writing it to whoever changes it', async () => {
    const settings = themeSettings()
    await settings.update({ mode: 'light' })
    const update = vi.spyOn(settings, 'update')
    const persistence = createThemePersistence(() => fakeAppState().state, settings)

    expect(await persistence.loadGlobal()).toEqual({ theme: 'tessera.default', mode: 'light' })
    await persistence.saveGlobal({ theme: 'tessera.default', mode: 'dark' })

    expect(update).not.toHaveBeenCalled()
    expect(settings.get()).toEqual({ theme: 'tessera.default', mode: 'light' })
  })

  it('moves a choice saved in app-state by an earlier version into the setting, once', async () => {
    const log = createLogger()
    const settings = themeSettings()
    const { data, state } = fakeAppState({ theme: 'dark' })
    const persistence = createThemePersistence(() => state, settings, log)

    expect(await persistence.loadGlobal()).toEqual({ theme: 'tessera.default', mode: 'dark' })
    expect(settings.get()).toEqual({ theme: 'tessera.default', mode: 'dark' })
    expect(data.has('theme')).toBe(false)
    expect(log.info).toHaveBeenCalledWith('[theme] Moved the saved theme (tessera.default, dark) into the settings')
  })

  it('keeps what the setting already holds over an old app-state choice, and drops the old one', async () => {
    const settings = themeSettings()
    await settings.update({ mode: 'light' })
    const { data, state } = fakeAppState({ theme: { theme: 'p.midnight', mode: 'dark' } })

    expect(await createThemePersistence(() => state, settings).loadGlobal()).toEqual({ theme: 'tessera.default', mode: 'light' })
    expect(data.has('theme')).toBe(false)
  })

  it('drops an unreadable old choice without moving it', async () => {
    const settings = themeSettings()
    const { data, state } = fakeAppState({ theme: 42 })

    expect(await createThemePersistence(() => state, settings).loadGlobal()).toEqual({ theme: 'tessera.default', mode: 'system' })
    expect(data.has('theme')).toBe(false)
  })

  it("keeps a window's override under its window key in app-state, and removes it when cleared", async () => {
    const { data, state } = fakeAppState()
    const persistence = createThemePersistence(() => state, themeSettings())

    await persistence.saveOverride('main', { theme: 'p.midnight', mode: 'dark' })
    expect(data.get('shell.theme.main')).toEqual({ theme: 'p.midnight', mode: 'dark' })
    expect(await persistence.loadOverride('main')).toEqual({ theme: 'p.midnight', mode: 'dark' })

    await persistence.saveOverride('main', undefined)
    expect(data.has('shell.theme.main')).toBe(false)
  })

  it('still reads the application-wide choice, and fails nothing, while app-state is not available', async () => {
    const persistence = createThemePersistence(() => undefined, themeSettings())

    expect(await persistence.loadGlobal()).toEqual({ theme: 'tessera.default', mode: 'system' })
    expect(await persistence.loadOverride('main')).toBeUndefined()
    await expect(persistence.saveOverride('main', undefined)).resolves.toBeUndefined()
  })

  it('looks app-state up on every use, since it appears after startup', async () => {
    let current: AppState | undefined
    const persistence = createThemePersistence(() => current, themeSettings())
    expect(await persistence.loadOverride('main')).toBeUndefined()

    current = fakeAppState({ 'shell.theme.main': { theme: 'x', mode: 'dark' } }).state

    expect(await persistence.loadOverride('main')).toEqual({ theme: 'x', mode: 'dark' })
  })
})
