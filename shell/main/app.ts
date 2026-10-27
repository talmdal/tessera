// shell/main/app.ts — composition root: wires core to Electron and file-system adapters.
import { app, BrowserWindow, nativeTheme } from 'electron'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { CommandRegistryImpl } from '../../core/commands/CommandRegistry'
import { LayoutService } from '../../core/layout/LayoutService'
import { createPluginContext, createPluginRuntime } from '../../core/plugins/PluginContext'
import { PluginManager } from '../../core/plugins/PluginManager'
import { SHELL_CONTRIBUTOR_ID } from '../../shared/plugins/manifest'
import { forwardEventsToWindows } from './events/forwardEvents'
import { registerShellEvents } from './events/shellEvents'
import { bindRouterToElectron } from './ipc/bindRouter'
import { createLayoutContent } from './layout/layoutContent'
import { LayoutRegistration, registerLayout } from './layout/registerLayout'
import { installQuitHandling } from './lifecycle/quit'
import { osShutdownSources } from './lifecycle/systemShutdown'
import { registerCoreMenus } from './menus/coreMenus'
import { applyApplicationMenu } from './menus/electronMenu'
import { FsPluginSource } from './plugins/FsPluginSource'
import { handlePluginProtocol, pluginUrl, registerPluginSchemePrivileges } from './plugins/pluginProtocol'
import { createAppStatePersistence } from './theme/appStatePersistence'
import { createNativeAppearance } from './theme/nativeAppearance'
import { ThemeRegistration, registerTheme } from './theme/registerTheme'
import { registerViewsIpc } from './views/viewsIpc'

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

/** URL of a file in a plugin's renderer folder (icons and other assets). */
function assetUrlFor(pluginId: string, relativePath: string) {
  if (!pluginManager.get(pluginId)?.manifest.renderer) return undefined
  return pluginUrl(pluginId, relativePath)
}

registerPluginSchemePrivileges()

let layout: LayoutRegistration | undefined
let theme: ThemeRegistration | undefined

async function bootstrap() {
  const shell = createPluginContext(SHELL_CONTRIBUTOR_ID, runtime).context

  const viewResources = {
    remoteEntryFor,
    assetUrlFor,
    isCommandEnabled: (id: string) => runtime.commands.isEnabled(id)
  }

  bindRouterToElectron(runtime.ipc)
  forwardEventsToWindows(runtime.events, () => BrowserWindow.getAllWindows(), log)
  registerShellEvents(shell, runtime)
  handlePluginProtocol(rendererRootFor)
  registerCoreMenus(shell)
  registerViewsIpc(shell, viewResources, log)

  const content = createLayoutContent(runtime.extensions, viewResources, log)
  const layoutService = new LayoutService(content.source, runtime.contextKeys, { log })
  layout = registerLayout(
    shell,
    runtime,
    layoutService,
    content,
    { focusedId: () => BrowserWindow.getFocusedWindow()?.id },
    (runtime.commands as CommandRegistryImpl).onDidChange,
    log
  )
  app.on('browser-window-focus', () => layout?.refreshContextKeys())

  const appearance = createNativeAppearance(nativeTheme)
  theme = registerTheme(shell, runtime, {
    appearance,
    persistence: createAppStatePersistence(runtime.services, log),
    focusedWindowId: () => BrowserWindow.getFocusedWindow()?.id,
    applyNative: state => appearance.apply(state, () => BrowserWindow.getAllWindows()),
    log
  })

  await pluginManager.activateAll()
  // The stored preference needs the app.state service, which a plugin provides;
  // applied now, before the window exists, so the first frame has the right colours.
  const themeState = await theme.service.load()
  appearance.apply(themeState, () => BrowserWindow.getAllWindows())
  applyApplicationMenu(runtime.extensions, runtime.commands)
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    // The theme's background from the first frame, and no frame until the
    // renderer has painted, so there is no flash of the wrong colour.
    backgroundColor: theme?.service.get().colors['shell.background'],
    show: false,
    webPreferences: {
      // Built next to app.js by shell/preload/vite.config.ts
      preload: path.join(__dirname, 'preload.js')
    }
  })
  win.once('ready-to-show', () => win.show())

  // The primary window's layout is persisted under the stable key 'main'.
  // The id is captured now: it is gone from the window object once destroyed.
  const windowId = win.id
  layout?.attachWindow(windowId, 'main')
  win.on('closed', () => layout?.detachWindow(windowId))

  win.loadURL('http://localhost:5173')
  return win
}

app.whenReady().then((async () => {
  await bootstrap()
  const win = createWindow()
  // Quitting runs the ShuttingDown listeners, deactivates every plugin, then quits.
  // Inside ready, because powerMonitor can't be used before it.
  installQuitHandling(app, runtime.lifecycle, pluginManager, log, osShutdownSources(win))
  await runtime.lifecycle.markStarted()
}))

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
