import { vi, describe, it, expect } from 'vitest'

// HOISTED MOCK
vi.mock('electron', () => {
  return {
    ipcRenderer: {
      invoke: vi.fn(),
      on: vi.fn()
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

/** What the main process pushes: delivers `message` the way Electron would. */
const push = (message: unknown) => {
  const [channel, handler] = vi.mocked(electron.ipcRenderer.on).mock.calls[0]
  expect(channel).toBe('tessera:event')
  handler({} as any, message)
}

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

describe('preload push events', () => {
  it('routes an event to the listeners for its name, passing only the data', () => {
    const mine = vi.fn()
    const other = vi.fn()
    window.api.on('vault:opened', mine)
    window.api.on('vault:closed', other)

    push({ name: 'vault:opened', data: { path: 'a' } })

    expect(mine).toHaveBeenCalledWith({ path: 'a' })
    expect(other).not.toHaveBeenCalled()
  })

  it('stops delivering after the returned function is called', () => {
    const listener = vi.fn()
    const stop = window.api.on('vault:saved', listener)

    push({ name: 'vault:saved' })
    stop()
    push({ name: 'vault:saved' })

    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('ignores malformed messages, and a throwing listener does not stop the others', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const after = vi.fn()
    window.api.on('x:y', () => { throw new Error('boom') })
    window.api.on('x:y', after)

    push('not an event')
    push({ data: 1 })
    push({ name: 'x:y', data: 1 })

    expect(after).toHaveBeenCalledOnce()
    expect(error).toHaveBeenCalled()
    error.mockRestore()
  })
})
