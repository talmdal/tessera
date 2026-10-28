import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// -----------------------------
// 1. HOISTED MOCK — must be FIRST
// -----------------------------
vi.mock('electron', () => {
  const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-userdata-'))
  const modulesDir = path.join(tmpUserData, 'modules')
  fs.mkdirSync(modulesDir)

  const pluginDir = path.join(modulesDir, 'test-plugin')
  fs.mkdirSync(pluginDir)

  fs.writeFileSync(
    path.join(pluginDir, 'manifest.json'),
    JSON.stringify({
      id: 'test-plugin',
      name: 'Test Plugin',
      version: '0.0.1',
      privileged: { entry: 'privileged/index.js' },
      renderer: { entry: 'renderer/remoteEntry.js' }
    })
  )

  fs.mkdirSync(path.join(pluginDir, 'privileged'))
  fs.writeFileSync(
    path.join(pluginDir, 'privileged/index.js'),
    `
      exports.activate = (context) => {
        context.ipc.register('test-plugin:ping', async () => 'pong')
        context.commands.register('test-plugin.hello', () => 'hello')
        // Negative order must not move it ahead of File
        context.extensions.contribute('test-plugin', 'shell.menus', 'test-plugin.menu', { kind: 'menu', id: 'test-plugin.menu', label: 'Test', order: -100 })
        context.extensions.contribute('test-plugin', 'shell.menus', 'test-plugin.hello', { kind: 'item', id: 'test-plugin.hello', label: 'Hello', parent: 'test-plugin.menu', command: 'test-plugin.hello' })
        context.extensions.contribute('test-plugin', 'shell.views', 'test-plugin.hello', { id: 'test-plugin.hello', title: 'Hello', slot: 'shell.main', module: './HelloView' })
      }
    `
  )

  const handlers: Record<string, any> = {}
  const liveWindow = { isDestroyed: () => false, webContents: { send: vi.fn() } }

  return {
    ipcMain: {
      handle: vi.fn((channel, fn) => {
        handlers[channel] = fn
      }),
      __invoke: async (channel: string, payload: any) => {
        const handler = handlers[channel]
        if (!handler) throw new Error(`No IPC handler for ${channel}`)
        return handler({}, payload)
      }
    },

    ipcRenderer: {
      invoke: vi.fn((channel, payload) => {
        const electron = require('electron')
        return electron.ipcMain.__invoke(channel, payload)
      })
    },

    contextBridge: {
      exposeInMainWorld: vi.fn()
    },

    Menu: {
      buildFromTemplate: vi.fn((template: any[]) => {
        const find = (items: any[] | undefined, id: string): any =>
          items?.reduce((found, item) => found ?? (item.id === id ? item : find(item.submenu, id)), null) ?? null
        return { template, getMenuItemById: (id: string) => find(template, id) }
      }),
      setApplicationMenu: vi.fn()
    },

    dialog: {
      showMessageBox: vi.fn()
    },

    powerMonitor: { on: vi.fn() },

    screen: { getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }] },

    protocol: {
      registerSchemesAsPrivileged: vi.fn(),
      handle: vi.fn()
    },

    BrowserWindow: Object.assign(vi.fn(function () { return {
      id: 7,
      loadURL: vi.fn(),
    getNativeWindowHandle: vi.fn(() => Buffer.alloc(8)),
      on: vi.fn(),
      webContents: { openDevTools: vi.fn() }
    } }), { getAllWindows: () => [liveWindow], fromWebContents: () => ({ id: 7 }) }),

    app: {
      getVersion: () => '1.2.3',
      whenReady: () => Promise.resolve(), // resolves immediately
      on: vi.fn(),
      quit: vi.fn(),
      getPath: vi.fn((key: string) => {
        if (key === 'userData') return tmpUserData
        return ''
      })
    }
  }
})

// -----------------------------
// 2. Import AFTER mock
// -----------------------------
import '../../shell/main/app'
import * as electron from 'electron'

// -----------------------------
// 3. Tests
// -----------------------------
describe('main process (dynamic plugin system)', () => {
  it('binds a single invoke channel', async () => {
    await electron.app.whenReady()
    expect(vi.mocked(electron.ipcMain.handle).mock.calls.map(c => c[0])).toEqual(['tessera:invoke'])
  })

  it('routes requests to the plugin handler on its namespaced channel', async () => {
    await vi.waitFor(() => expect(electron.Menu.setApplicationMenu).toHaveBeenCalled())
    const response = await (electron.ipcMain as any).__invoke('tessera:invoke', { channel: 'test-plugin:ping', data: {} })
    expect(response).toEqual({ ok: true, data: 'pong' })
  })

  it('installs a menu bar with plugin menus between File and Tools/Help', async () => {
    await electron.app.whenReady()
    await vi.waitFor(() => expect(electron.Menu.setApplicationMenu).toHaveBeenCalled())

    const template = vi.mocked(electron.Menu.buildFromTemplate).mock.calls[0][0]
    expect(template.map(m => m.label)).toEqual(['&File', '&View', 'Test', '&Tools', '&Help'])
  })

  it('lists plugin views with the URL of the plugin remote entry', async () => {
    await vi.waitFor(() => expect(electron.Menu.setApplicationMenu).toHaveBeenCalled())

    const response = await (electron.ipcMain as any).__invoke('tessera:invoke', { channel: 'shell:views.list' })
    expect(response).toEqual({
      ok: true,
      data: [{
        id: 'test-plugin.hello',
        title: 'Hello',
        slot: 'shell.main',
        module: './HelloView',
        pluginId: 'test-plugin',
        remoteEntry: 'tessera-plugin://test-plugin/remoteEntry.js'
      }]
    })
  })

  it('answers a window with its layout, listing the plugin view in the main area', async () => {
    await vi.waitFor(() => expect(electron.Menu.setApplicationMenu).toHaveBeenCalled())

    const response = await (electron.ipcMain as any).__invoke('tessera:invoke', { channel: 'shell:layout.get' })

    expect(response).toMatchObject({
      ok: true,
      data: { windowId: 7, main: { views: ['test-plugin.hello'], activeView: 'test-plugin.hello' }, bars: { left: { views: [], collapsed: false } } }
    })
  })

  it('runs a layout command from the renderer and publishes the new layout', async () => {
    await vi.waitFor(() => expect(electron.Menu.setApplicationMenu).toHaveBeenCalled())
    const [window] = electron.BrowserWindow.getAllWindows() as any[]
    const before = window.webContents.send.mock.calls.length

    const reset = await (electron.ipcMain as any).__invoke('tessera:invoke', { channel: 'shell:commands.execute', data: { id: 'shell.layout.reset' } })
    const slot = await (electron.ipcMain as any).__invoke('tessera:invoke', { channel: 'shell:layout.slot.set', data: { slot: 'shell.top', collapsed: true } })

    expect(reset).toMatchObject({ ok: true })
    expect(slot).toMatchObject({ ok: true, data: { bars: { top: { collapsed: true } } } })
    expect(window.webContents.send.mock.calls.slice(before).map((call: any[]) => call[1].name)).toContain('shell:layout.changed')
  })

  it('lists no bar items when no plugin contributes any', async () => {
    await vi.waitFor(() => expect(electron.Menu.setApplicationMenu).toHaveBeenCalled())

    const response = await (electron.ipcMain as any).__invoke('tessera:invoke', { channel: 'shell:bar.items.list' })

    expect(response).toEqual({ ok: true, data: [] })
  })

  it('follows the focused window', async () => {
    await vi.waitFor(() => expect(electron.Menu.setApplicationMenu).toHaveBeenCalled())
    const focus = vi.mocked(electron.app.on).mock.calls.find(([event]) => event === 'browser-window-focus')

    expect(focus).toBeDefined()
    expect(() => (focus![1] as any)({}, { id: 7 })).not.toThrow()
  })

  it('opens the window at the default size, and follows its position and size from then on', async () => {
    await vi.waitFor(() => expect(electron.Menu.setApplicationMenu).toHaveBeenCalled())
    const [options] = vi.mocked(electron.BrowserWindow).mock.calls[0] as any[]
    const window = vi.mocked(electron.BrowserWindow).mock.results[0].value as any

    expect(options).toMatchObject({ width: 1200, height: 800 })
    expect(options).not.toHaveProperty('x')
    expect(vi.mocked(window.on).mock.calls.map((call: any[]) => call[0])).toEqual(expect.arrayContaining(['resize', 'move', 'maximize', 'unmaximize', 'close']))
  })

  it('registers the plugin scheme as privileged and serves it', async () => {
    await vi.waitFor(() => expect(electron.protocol.handle).toHaveBeenCalledWith('tessera-plugin', expect.any(Function)))
    expect(electron.protocol.registerSchemesAsPrivileged).toHaveBeenCalledWith([
      expect.objectContaining({ scheme: 'tessera-plugin' })
    ])
  })

  it('pushes lifecycle changes to the open windows', async () => {
    const [window] = electron.BrowserWindow.getAllWindows() as any[]

    await vi.waitFor(() => expect(window.webContents.send).toHaveBeenCalledWith(
      'tessera:event', { name: 'shell:lifecycle.changed', data: { phase: 'started' } }))
  })
})
