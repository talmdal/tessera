import type { AppState } from '@tessera/types'
import { describe, it, expect, vi } from 'vitest'
import { ServiceRegistryImpl } from '../../core/services/ServiceRegistry'
import { createAppStatePersistence } from '../../shell/main/theme/appStatePersistence'
import { createLogger } from '../helpers/runtime'

function setup(stored?: unknown) {
  const services = new ServiceRegistryImpl()
  const values = new Map<string, unknown>(stored === undefined ? [] : [['theme', stored]])
  const appState = {
    get: vi.fn(async (key: string) => values.get(key)),
    set: vi.fn(async (key: string, value: unknown) => { values.set(key, value) }),
    update: vi.fn(),
    remove: vi.fn()
  } as unknown as AppState & { get: ReturnType<typeof vi.fn> }
  const log = createLogger()
  const persistence = createAppStatePersistence(services, log)
  return { services, appState, values, log, persistence, provide: () => services.provide('app-state', 'app.state', appState) }
}

describe('createAppStatePersistence', () => {
  it('reads the preference from the theme key and writes it back', async () => {
    const preference = { theme: 'shell.dark', light: 'shell.light', dark: 'shell.dark' }
    const { persistence, provide, values } = setup(preference)
    provide()

    expect(await persistence.load()).toEqual(preference)

    await persistence.save({ ...preference, theme: 'system' })
    expect(values.get('theme')).toEqual({ ...preference, theme: 'system' })
  })

  it("reads the old useThemeState string as the shell's theme of that kind", async () => {
    const { persistence, provide } = setup('dark')
    provide()
    expect(await persistence.load()).toEqual({ theme: 'shell.dark' })
  })

  it('returns nothing for an absent or malformed value', async () => {
    for (const stored of [undefined, 42, 'sepia']) {
      const { persistence, provide } = setup(stored)
      provide()
      expect(await persistence.load()).toBeUndefined()
    }
  })

  it('warns once and does nothing while no plugin provides app.state', async () => {
    const { persistence, log } = setup()

    expect(await persistence.load()).toBeUndefined()
    await persistence.save({ theme: 'system', light: 'shell.light', dark: 'shell.dark' })

    expect(log.warn).toHaveBeenCalledTimes(1)
    expect(log.warn.mock.calls[0][0]).toContain('No plugin provides "app.state"')
  })

  it('finds the service when it appears after creation', async () => {
    const { persistence, provide, appState } = setup({ theme: 'shell.dark' })
    expect(await persistence.load()).toBeUndefined()

    provide()
    expect(await persistence.load()).toEqual({ theme: 'shell.dark' })
    expect(appState.get).toHaveBeenCalledWith('theme')
  })
})
