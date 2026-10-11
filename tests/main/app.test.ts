import { vi, describe, it, expect } from 'vitest'

// HOISTED MOCK — must be first
vi.mock('electron', () => {
  const handlers: Record<string, any> = {}

  return {
    ipcMain: {
      handle: vi.fn((channel, fn) => {
        handlers[channel] = fn
      }),
      __invoke: async (channel: string, ...args: any[]) => {
        return handlers[channel]?.({}, ...args)
      }
    },
    ipcRenderer: {
      invoke: vi.fn((channel, ...args) => {
        return (globalThis as any).__ipcInvoke(channel, ...args)
      })
    },
    contextBridge: {
      exposeInMainWorld: vi.fn()
    },
    BrowserWindow: vi.fn(() => ({
      loadURL: vi.fn(),
      on: vi.fn()
    })),
    app: {
      getVersion: () => '1.2.3',
      whenReady: () => Promise.resolve(),
      on: vi.fn(),
      quit: vi.fn()
    }
  }
})

// Connect ipcRenderer.invoke → ipcMain.__invoke
;(globalThis as any).__ipcInvoke = async (channel: string, ...args: any[]) => {
  const electron = await import('electron')
  return electron.ipcMain.__invoke(channel, ...args)
}

// Import AFTER mock
import '../../shell/main/app'
import * as electron from 'electron'

describe('main process', () => {
  it('registers IPC handlers', () => {
    expect(electron.ipcMain.handle).toHaveBeenCalled()
  })

  it('get-version handler returns app version', async () => {
    const result = await (electron.ipcMain as any).__invoke('get-version')
    expect(result).toBe('1.2.3')
  })
})
