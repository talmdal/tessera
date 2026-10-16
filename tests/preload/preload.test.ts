import { vi, describe, it, expect } from 'vitest'

// HOISTED MOCK
vi.mock('electron', () => {
  return {
    ipcRenderer: {
      invoke: vi.fn()
    },
    contextBridge: {
      exposeInMainWorld: vi.fn((key, value) => {
        ;(globalThis as any)[key] = value
      })
    }
  }
})

import * as electron from 'electron'
import '../../shell/preload/preload'

describe('preload', () => {
  it('exposes API to window', () => {
    expect(electron.contextBridge.exposeInMainWorld).toHaveBeenCalledWith('api', expect.anything())
    expect(window.api).toBeDefined()
  })

  it('sends requests over the single invoke channel and unwraps the result', async () => {
    vi.mocked(electron.ipcRenderer.invoke).mockResolvedValueOnce({ ok: true, data: 'pong' })

    await expect(window.api.invoke('test-plugin:ping', { n: 1 })).resolves.toBe('pong')
    expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith('tessera:invoke', { channel: 'test-plugin:ping', data: { n: 1 } })
  })

  it('rejects with the error code and message on failure', async () => {
    vi.mocked(electron.ipcRenderer.invoke).mockResolvedValueOnce({
      ok: false,
      error: { code: 'NO_HANDLER', message: 'No IPC handler for x:y' }
    })

    await expect(window.api.invoke('x:y')).rejects.toThrow('NO_HANDLER: No IPC handler for x:y')
  })
})
