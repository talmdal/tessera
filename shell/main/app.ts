// shell/main/app.ts — composition root: wires core to Electron and file-system adapters.
import { app, BrowserWindow, screen } from 'electron'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import type { AppState } from '@tessera/types'
import { createPluginContext, createPluginRuntime } from '../../core/plugins/PluginContext'
import { PluginManager } from '../../core/plugins/PluginManager'
import { LayoutService } from '../../core/layout/LayoutService'
import { PRIMARY_WINDOW_KEY } from '../../shared/layout/types'
import { SHELL_CONTRIBUTOR_ID } from '../../shared/plugins/manifest'
import { registerCommandsIpc } from './commands/commandsIpc'
import { forwardEventsToWindows } from './events/forwardEvents'
import { registerShellEvents } from './events/shellEvents'
import { bindRouterToElectron } from './ipc/bindRouter'
import { createAppStatePersistence } from './layout/appStatePersistence'
import { LayoutHost, registerLayout } from './layout/registerLayout'
import { installQuitHandling } from './lifecycle/quit'
import { osShutdownSources } from './lifecycle/systemShutdown'
import { registerCoreMenus } from './menus/coreMenus'
import { applyApplicationMenu } from './menus/electronMenu'
import { FsPluginSource } from './plugins/FsPluginSource'
import { handlePluginProtocol, pluginUrl, registerPluginSchemePrivileges } from './plugins/pluginProtocol'
import { registerViewsIpc } from './views/viewsIpc'
import { createWindowStateGroup, createWindowStateStore, restoreWindowState } from './window/windowState'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const log = console

const runtime = createPluginRuntime(app.getPath('userData'), log)

// Bundled plugins are built from plugins/ into modules/ (see scripts/build-plugins.ts).
// They are listed first, so a user plugin can't replace a bundled one.
const bundledPluginsDir = app.isPackaged
  ? path.join(process.resourcesPath, 'modules')
  : path.resolve(__dirname, '../modules')

const pluginSource = new FsPluginSource([
  { dir: bundledPluginsDir, origin: 'bundled' },
  { dir: path.join(app.getPath('userData'), 'modules'), origin: 'user' }
], log)
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

/** URL of a file in a plugin's renderer folder, which the plugin protocol serves. */
function iconUrlFor(pluginId: string, relativePath: string) {
  return pluginManager.get(pluginId)?.manifest.renderer ? pluginUrl(pluginId, relativePath) : undefined
}

registerPluginSchemePrivileges()

// Layouts are kept by the app-state plugin. Its service is looked up on each use, since it only exists once
// that plugin has activated; the shell is not a manifest plugin, so it reads the registry directly.
const appState = () => runtime.services.has('app.state') ? runtime.services.get<AppState>('app.state') : undefined

const layout = new LayoutService(runtime.extensions, runtime.contextKeys, { remoteEntryFor, iconUrlFor }, {
  persistence: createAppStatePersistence(appState),
  log
})
let layoutHost: LayoutHost

async function bootstrap() {
  const shell = createPluginContext(SHELL_CONTRIBUTOR_ID, runtime).context

  bindRouterToElectron(runtime.ipc)
  forwardEventsToWindows(runtime.events, () => BrowserWindow.getAllWindows(), log)
  registerShellEvents(shell, runtime)
  handlePluginProtocol(rendererRootFor)
  registerCoreMenus(shell)
  registerViewsIpc(shell, remoteEntryFor, iconUrlFor, log)
  registerCommandsIpc(shell, log)
  layoutHost = registerLayout(shell, runtime, layout, iconUrlFor)
  // Registered before the plugins activate, so it runs before the storage plugin closes the store.
  runtime.lifecycle.onShuttingDown(() => trackedWindows.flush())
  await pluginManager.activateAll()
  layout.refresh()   // a plugin's renderer is only known once it has activated
  applyApplicationMenu(runtime.extensions, runtime.commands)
}

let windowsCreated = 0

const DEFAULT_WINDOW_SIZE = { width: 1200, height: 800 }
const windowStates = createWindowStateStore(appState)
const trackedWindows = createWindowStateGroup()

async function createWindow() {
  // The first window is the primary one; its layout and its position and size are kept under a stable key,
  // not its per-session id.
  const key = windowsCreated++ === 0 ? PRIMARY_WINDOW_KEY : `window-${windowsCreated}`

  const state = restoreWindowState(
    await windowStates.load(key).catch(err => { log.warn(`[window] Could not load the window state: ${err}`); return undefined }),
    DEFAULT_WINDOW_SIZE,
    screen.getAllDisplays().map(display => display.workArea))

  console.log('Window state:', state)
  const win = new BrowserWindow({
    ...DEFAULT_WINDOW_SIZE,
    ...state,
    webPreferences: {
      // Built next to app.js by shell/preload/vite.config.ts
      preload: path.join(__dirname, 'preload.js')
    }
  })

  if (state.maximized) win.maximize()
  trackedWindows.track(win, current => windowStates.save(key, current), { log })

  // Attached, with its saved layout loaded, before the page loads so its first layout request is right.
  const id = win.id
  await layoutHost.attachWindow(id, key)
  win.on('closed', () => { layoutHost.detachWindow(id).catch(err => log.error('[layout] Could not save the layout', err)) })

  win.loadURL('http://localhost:5173')
  return win
}

app.whenReady().then((async () => {
  await bootstrap()
  const win = await createWindow()
  // Quitting runs the ShuttingDown listeners, deactivates every plugin, then quits.
  // Inside ready, because powerMonitor can't be used before it.
  installQuitHandling(app, runtime.lifecycle, pluginManager, log, osShutdownSources(win))
  await runtime.lifecycle.markStarted()
}))

app.on('browser-window-focus', (_event, win) => layoutHost?.focus(win.id))

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
