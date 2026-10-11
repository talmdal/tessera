import { app, BrowserWindow, ipcMain } from 'electron'
import path from 'node:path'
import { IpcRouter } from '../../shared/ipcRouter'
import { ExtensionRegistry } from '../../shared/plugins/context'
import { PluginManager } from '../../shared/plugins/PluginManager'
import { bindRouterToElectron } from './ipc/bindRouter'
import type { Services } from '../../shared/plugins/types'

// TODO: real services later
const services: Services = {
  vault: {
    createVault: async name => `vault-${name}`
  }
}

const ipcRouter = new IpcRouter()
const extensions = new ExtensionRegistry()

const modulesDir = path.join(app.getPath('userData'), 'modules')
const pluginManager = new PluginManager(modulesDir, services, ipcRouter, extensions)

async function bootstrapPlugins() {
  await pluginManager.activateAll()
  bindRouterToElectron(ipcRouter)
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, '../preload/dist-preload/index.js')
    }
  })

  win.loadURL('http://localhost:5173')
}

app.whenReady().then((async () => {
  await bootstrapPlugins()
  createWindow()
}))

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
