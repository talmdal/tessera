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
      getNativeWindowHandle: vi.fn(() => Buffer.alloc(8)),
      on: vi.fn(),
      webContents: {
        openDevTools: vi.fn()
      }
    })),

    // -----------------------------
    // Menu / dialog mocks
    // -----------------------------
    Menu: {
      // The fake menu's items are the template objects, so tests can observe enabled changes
      buildFromTemplate: vi.fn((template: any[]) => {
        const find = (items: any[] | undefined, id: string): any =>
          items?.reduce((found, item) => found ?? (item.id === id ? item : find(item.submenu, id)), null) ?? null
        return { template, getMenuItemById: (id: string) => find(template, id) }
      }),
      setApplicationMenu: vi.fn()
    },

    dialog: {
      showMessageBox: vi.fn(async () => ({ response: 0 }))
    },

    powerMonitor: { on: vi.fn() },

    protocol: {
      registerSchemesAsPrivileged: vi.fn(),
      handle: vi.fn()
    },

    // -----------------------------
    // app mock
    // -----------------------------
    app: {
      getVersion: () => '1.2.3',
      whenReady: () => Promise.resolve(),
      on: vi.fn(),
      quit: vi.fn(),
      getPath: vi.fn((key: string) => 'C:/fake/userData')
    }
  }
})

// Bridge ipcRenderer.invoke → ipcMain.__invoke
// The Windows shutdown handler is a native addon that needs a real window handle.
vi.mock('@paymoapp/electron-shutdown-handler', () => ({
  default: {
    setWindowHandle: vi.fn(),
    blockShutdown: vi.fn(() => true),
    releaseShutdown: vi.fn(() => true),
    on: vi.fn()
  }
}))

;(globalThis as any).__ipcInvoke = async (channel: string, ...args: any[]) => {
  const electron = await import('electron')
  return (electron.ipcMain as any).__invoke(channel, ...args)
}
