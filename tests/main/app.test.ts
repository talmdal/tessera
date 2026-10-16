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
        context.ipc.handle('ping', async () => 'pong')
        context.commands.register('test-plugin.hello', () => 'hello')
        // Negative order must not move it ahead of File
        context.extensions.contribute('shell.menus', { kind: 'menu', id: 'test-plugin.menu', label: 'Test', order: -100 })
        context.extensions.contribute('shell.menus', { kind: 'item', id: 'test-plugin.hello', label: 'Hello', parent: 'test-plugin.menu', command: 'test-plugin.hello' })
        context.extensions.contribute('shell.views', { id: 'test-plugin.hello', title: 'Hello', slot: 'shell.main', module: './HelloView' })
      }
    `
  )

  const handlers: Record<string, any> = {}

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

    protocol: {
      registerSchemesAsPrivileged: vi.fn(),
      handle: vi.fn()
    },

    BrowserWindow: vi.fn(() => ({
      loadURL: vi.fn(),
      on: vi.fn(),
      webContents: { openDevTools: vi.fn() }
    })),

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
    expect(template.map(m => m.label)).toEqual(['&File', 'Test', '&Tools', '&Help'])
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

  it('registers the plugin scheme as privileged and serves it', async () => {
    await vi.waitFor(() => expect(electron.protocol.handle).toHaveBeenCalledWith('tessera-plugin', expect.any(Function)))
    expect(electron.protocol.registerSchemesAsPrivileged).toHaveBeenCalledWith([
      expect.objectContaining({ scheme: 'tessera-plugin' })
    ])
  })
})
