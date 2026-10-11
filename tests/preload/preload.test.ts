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
    expect(electron.contextBridge.exposeInMainWorld).toHaveBeenCalled()
    expect(window.api).toBeDefined()
  })

  it('calls ipcRenderer.invoke', async () => {
    await window.api.invoke('get-version')
    expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith('get-version', undefined)
  })
})
