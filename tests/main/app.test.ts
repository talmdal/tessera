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
      privileged: { entry: 'privileged/index.js' }
    })
  )

  fs.mkdirSync(path.join(pluginDir, 'privileged'))
  fs.writeFileSync(
    path.join(pluginDir, 'privileged/index.js'),
    `
      exports.activate = (context) => {
        context.ipc.register('test', 'ping', async () => 'pong')
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
  it('registers IPC handlers from plugins', async () => {
    await electron.app.whenReady() // ⭐ wait for plugin activation
    expect(electron.ipcMain.handle).toHaveBeenCalled()
  })

  it('plugin IPC handler responds correctly', async () => {
    await electron.app.whenReady() // ⭐ wait for plugin activation
    const result = await (electron.ipcMain as any).__invoke('test:ping', { data: {} })
    expect(result).toBe('pong')
  })
})
