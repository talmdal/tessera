import { vi } from 'vitest'

// Internal handler registry for ipcMain.handle
const handlers: Record<string, (...args: any[]) => any> = {}

// Electron mock
vi.mock('electron', () => {
  return {
    // -----------------------------
    // ipcMain mock
    // -----------------------------
    ipcMain: {
      handle: vi.fn((channel, fn) => {
        handlers[channel] = fn
      }),

      // Internal helper used by tests
      __invoke: async (channel: string, ...args: any[]) => {
        const handler = handlers[channel]
        if (!handler) {
          throw new Error(`No IPC handler registered for ${channel}`)
        }
        return handler({}, ...args)
      }
    },

    // -----------------------------
    // ipcRenderer mock
    // -----------------------------
    ipcRenderer: {
      invoke: vi.fn((channel, ...args) => {
        return (globalThis as any).__ipcInvoke(channel, ...args)
      })
    },

    // -----------------------------
    // contextBridge mock
    // -----------------------------
    contextBridge: {
      exposeInMainWorld: vi.fn((key, value) => {
        ;(globalThis as any)[key] = value
      })
    },

    // -----------------------------
    // BrowserWindow mock
    // -----------------------------
    BrowserWindow: vi.fn(() => ({
      loadURL: vi.fn(),
      on: vi.fn(),
      webContents: {
        openDevTools: vi.fn()
      }
    })),

    // -----------------------------
    // app mock
    // -----------------------------
    app: {
      getVersion: () => '1.2.3',

      whenReady: () => Promise.resolve(),

      on: vi.fn(),

      quit: vi.fn()
    }
  }
})

// Bridge ipcRenderer.invoke → ipcMain.__invoke
;(globalThis as any).__ipcInvoke = async (channel: string, ...args: any[]) => {
  const electron = await import('electron')
  return electron.ipcMain.__invoke(channel, ...args)
}
