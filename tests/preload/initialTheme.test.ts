import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  ipcRenderer: { invoke: vi.fn(), on: vi.fn(), sendSync: vi.fn() },
  contextBridge: { exposeInMainWorld: vi.fn((key: string, value: unknown) => { ;(globalThis as any)[key] = value }) }
}))

import * as electron from 'electron'

const snapshot = {
  state: { windowId: 1, global: { theme: 'tessera.default', mode: 'system' }, theme: 'tessera.default', mode: 'dark' },
  themes: [{ id: 'tessera.default', label: 'Tessera' }]
}

/** Loads the preload afresh, as a new page would. */
const loadPreload = async () => {
  vi.resetModules()
  await import('../../shell/preload/preload')
  return (globalThis as any).api
}

describe('preload: the initial theme', () => {
  beforeEach(() => {
    vi.mocked(electron.ipcRenderer.sendSync).mockReset()
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it("asks once, synchronously, and exposes the window's theme so the first render needs no round trip", async () => {
    vi.mocked(electron.ipcRenderer.sendSync).mockReturnValue(snapshot)

    const api = await loadPreload()

    expect(electron.ipcRenderer.sendSync).toHaveBeenCalledTimes(1)
    expect(electron.ipcRenderer.sendSync).toHaveBeenCalledWith('shell:theme.initial')
    expect(api.initialTheme).toEqual(snapshot)
  })

  it('exposes nothing when the main process does not know the window', async () => {
    vi.mocked(electron.ipcRenderer.sendSync).mockReturnValue(null)

    expect((await loadPreload()).initialTheme).toBeUndefined()
  })

  it('still exposes the bridge, and logs, when the request fails', async () => {
    vi.mocked(electron.ipcRenderer.sendSync).mockImplementation(() => { throw new Error('no handler') })

    const api = await loadPreload()

    expect(api.initialTheme).toBeUndefined()
    expect(typeof api.invoke).toBe('function')
    expect(typeof api.on).toBe('function')
    expect(console.error).toHaveBeenCalledWith('[theme] Could not read the initial theme', expect.any(Error))
  })
})
