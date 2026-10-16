// shell/main/app.ts — composition root: wires core to Electron and file-system adapters.
import { app, BrowserWindow } from 'electron'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createPluginContext, createPluginRuntime } from '../../core/plugins/PluginContext'
import { PluginManager } from '../../core/plugins/PluginManager'
import { SHELL_CONTRIBUTOR_ID } from '../../shared/plugins/manifest'
import { bindRouterToElectron } from './ipc/bindRouter'
import { registerCoreMenus } from './menus/coreMenus'
import { applyApplicationMenu } from './menus/electronMenu'
import { FsPluginSource } from './plugins/FsPluginSource'
import { handlePluginProtocol, pluginUrl, registerPluginSchemePrivileges } from './plugins/pluginProtocol'
import { registerViewsIpc } from './views/viewsIpc'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const log = console

const runtime = createPluginRuntime(log)

const pluginSource = new FsPluginSource([path.join(app.getPath('userData'), 'modules')], log)
const pluginManager = new PluginManager(pluginSource, runtime, log)

/** Folder holding an active plugin's renderer remote entry, served over PLUGIN_SCHEME. */
function rendererRootFor(pluginId: string) {
  const plugin = pluginManager.get(pluginId)
  if (!plugin?.manifest.renderer) return undefined
  return path.dirname(path.resolve(plugin.location, plugin.manifest.renderer.entry))
}

function remoteEntryFor(pluginId: string) {
  const entry = pluginManager.get(pluginId)?.manifest.renderer?.entry
  return entry && pluginUrl(pluginId, path.basename(entry))
}

registerPluginSchemePrivileges()

async function bootstrap() {
  const shell = createPluginContext(SHELL_CONTRIBUTOR_ID, runtime).context

  bindRouterToElectron(runtime.ipc)
  handlePluginProtocol(rendererRootFor)
  registerCoreMenus(shell)
  registerViewsIpc(shell, remoteEntryFor, log)
  await pluginManager.activateAll()
  applyApplicationMenu(runtime.extensions, runtime.commands)
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      // Built next to app.js by shell/preload/vite.config.ts
      preload: path.join(__dirname, 'preload.js')
    }
  })

  win.loadURL('http://localhost:5173')
}

app.whenReady().then((async () => {
  await bootstrap()
  createWindow()
}))

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
