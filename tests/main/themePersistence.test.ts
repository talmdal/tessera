import { describe, expect, it, vi } from 'vitest'
import type { AppState } from '@tessera/types'
import { createThemePersistence } from '../../shell/main/theme/appStatePersistence'

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

describe('createThemePersistence', () => {
  it("keeps the application-wide choice under the key the old theme hook used", async () => {
    const { data, state } = fakeAppState({ theme: 'dark' })
    const persistence = createThemePersistence(() => state)

    expect(await persistence.loadGlobal()).toBe('dark')
    await persistence.saveGlobal({ theme: 'tessera.default', mode: 'light' })

    expect(data.get('theme')).toEqual({ theme: 'tessera.default', mode: 'light' })
  })

  it("keeps a window's override under its window key, and removes it when cleared", async () => {
    const { data, state } = fakeAppState()
    const persistence = createThemePersistence(() => state)

    await persistence.saveOverride('main', { theme: 'p.midnight', mode: 'dark' })
    expect(data.get('shell.theme.main')).toEqual({ theme: 'p.midnight', mode: 'dark' })
    expect(await persistence.loadOverride('main')).toEqual({ theme: 'p.midnight', mode: 'dark' })

    await persistence.saveOverride('main', undefined)
    expect(data.has('shell.theme.main')).toBe(false)
  })

  it('remembers nothing, and fails nothing, while app-state is not available', async () => {
    const persistence = createThemePersistence(() => undefined)

    expect(await persistence.loadGlobal()).toBeUndefined()
    expect(await persistence.loadOverride('main')).toBeUndefined()
    await expect(persistence.saveGlobal({ theme: 'x', mode: 'dark' })).resolves.toBeUndefined()
    await expect(persistence.saveOverride('main', undefined)).resolves.toBeUndefined()
  })

  it('looks the service up on every use, since it appears after startup', async () => {
    let current: AppState | undefined
    const persistence = createThemePersistence(() => current)
    expect(await persistence.loadGlobal()).toBeUndefined()

    current = fakeAppState({ theme: 'light' }).state

    expect(await persistence.loadGlobal()).toBe('light')
  })
})
