// shell/main/app.ts — composition root: wires core to Electron and file-system adapters.
import { app, BrowserWindow, dialog, nativeTheme, screen, session, shell as electronShell } from 'electron'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import type { AppState } from '@tessera/types'
import { DialogService } from '../../core/dialogs/DialogService'
import { createPluginContext, createPluginRuntime } from '../../core/plugins/PluginContext'
import { PluginManager } from '../../core/plugins/PluginManager'
import { LayoutService } from '../../core/layout/LayoutService'
import { ThemeService } from '../../core/theme/ThemeService'
import { PRIMARY_WINDOW_KEY } from '../../shared/layout/types'
import { SHELL_CONTRIBUTOR_ID } from '../../shared/plugins/manifest'
import { registerCommandsIpc } from './commands/commandsIpc'
import { forwardEventsToWindows } from './events/forwardEvents'
import { registerShellEvents } from './events/shellEvents'
import { loadBootstrapConfig, toPluginSelection } from './bootstrap/bootstrapConfig'
import { createElectronFiles } from './dialogs/electronFiles'
import { createElectronPrompts } from './dialogs/electronPrompts'
import { registerDialogs } from './dialogs/registerDialogs'
import { bindRouterToElectron } from './ipc/bindRouter'
import { createAppStatePersistence } from './layout/appStatePersistence'
import { LayoutHost, registerLayout } from './layout/registerLayout'
import { installQuitHandling, type QuitHandling } from './lifecycle/quit'
import { askToQuit } from './lifecycle/quitPrompt'
import { osShutdownSources } from './lifecycle/systemShutdown'
import { registerCoreMenus } from './menus/coreMenus'
import { applyApplicationMenu } from './menus/electronMenu'
import { FsPluginSource } from './plugins/FsPluginSource'
import { createElectronFontProbe } from './fonts/electronFontProbe'
import { createFontCatalogue } from './fonts/fontCatalogue'
import { registerFonts } from './fonts/registerFonts'
import { createElectronThemePort } from './theme/electronTheme'
import { createThemePersistence } from './theme/appStatePersistence'
import { registerInitialTheme } from './theme/initialTheme'
import { ThemeHost, registerTheme } from './theme/registerTheme'
import { handlePluginProtocol, pluginUrl, registerPluginSchemePrivileges } from './plugins/pluginProtocol'
import { createJsonSettingsPersistence, SETTINGS_FOLDER } from './settings/jsonSettingsPersistence'
import { registerSettings } from './settings/registerSettings'
import { registerViewsIpc } from './views/viewsIpc'
import { createWindowReveal, registerWindowReady } from './window/windowReveal'
import { createWindowStateGroup, createWindowStateStore, restoreWindowState } from './window/windowState'
import { FONT_SETTINGS } from '../../shared/fonts/settings'
import { THEME_SETTINGS } from '../../shared/theme/settings'
import { windowBackground } from '../../shared/theme/tokens'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const log = console

// Settings are plain JSON files the shell keeps, one per namespace, read before any plugin activates.
const runtime = createPluginRuntime(app.getPath('userData'), log, {
  settingsPersistence: createJsonSettingsPersistence(path.join(app.getPath('userData'), SETTINGS_FOLDER), log)
})

// Bundled plugins are built from plugins/ into modules/ (see scripts/build-plugins.ts).
// They are listed first, so a user plugin can't replace a bundled one.
const bundledPluginsDir = app.isPackaged
  ? path.join(process.resourcesPath, 'modules')
  : path.resolve(__dirname, '../modules')

const pluginSource = new FsPluginSource([
  { dir: bundledPluginsDir, origin: 'bundled' },
  { dir: path.join(app.getPath('userData'), 'modules'), origin: 'user' }
], log)
// Tier-0 configuration, read before anything activates: which plugins are left out, and which are activated
// first (so which of several `storage.engine` providers wins). It can't live in app-state, which needs storage.
const bootstrapConfig = loadBootstrapConfig(app.getPath('userData'), log)
const pluginManager = new PluginManager(pluginSource, runtime, log, toPluginSelection(bootstrapConfig))

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

// The application's theme is a setting (the Options dialog's Appearance page); the theme manager follows it.
const themeSettings = runtime.settings.register(SHELL_CONTRIBUTOR_ID, THEME_SETTINGS)
// So are the user's fonts, which travel to every window with its theme (docs/font-roles-design.md).
const fontSettings = runtime.settings.register(SHELL_CONTRIBUTOR_ID, FONT_SETTINGS)
const theme = new ThemeService(runtime.extensions, createElectronThemePort(nativeTheme), {
  persistence: createThemePersistence(appState, themeSettings, log),
  log
})
let themeHost: ThemeHost
const reveal = createWindowReveal(log)

// Dialogs (and the Options dialog) go to the window the user is working in: the focused one, else the first.
const targetWindow = () => (BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0])?.id
const dialogs = new DialogService(runtime.extensions, runtime.events, { remoteEntryFor, targetWindow, log })

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
  themeHost = registerTheme(shell, runtime, theme, log, themeSettings, fontSettings)
  // The Fonts page, and the installed fonts it offers: listed when it first asks, from a probe page built next to app.js
  registerFonts(shell, createFontCatalogue(createElectronFontProbe({ BrowserWindow, session }, path.join(__dirname, 'font-probe.html')), { log }))
  registerInitialTheme(windowId => themeHost.snapshotFor(windowId), log)
  registerWindowReady(shell, reveal, dialogs)
  // Provided before the plugins activate, so a plugin can require them
  const files = createElectronFiles({ dialog, BrowserWindow, shell: electronShell, app })
  registerDialogs(shell, runtime, dialogs, {
    prompts: createElectronPrompts({ dialog, BrowserWindow }, dialogs),
    files
  })
  registerSettings(shell, runtime, {
    remoteEntryFor, targetWindow, log,
    // A `folder` field's Browse…
    chooseFolder: (windowId, { defaultPath, title }) => files.showOpenFolderDialog({
      title: title ?? 'Choose a Folder', buttonLabel: 'Choose',
      ...(defaultPath !== undefined && { defaultPath }), ...(windowId !== undefined && { windowId })
    })
  })
  // Registered before the plugins activate, so it runs before the storage plugin closes the store.
  runtime.lifecycle.onShuttingDown(() => trackedWindows.flush())
  // What was saved is read before any plugin registers its settings, so `get()` is right from the start.
  await runtime.settings.load()
  await pluginManager.activateAll()
  layout.refresh()   // a plugin's renderer is only known once it has activated
  await themeHost.load()   // the saved theme is in app-state, which has only now activated
  applyApplicationMenu(runtime.extensions, runtime.commands)
}

let windowsCreated = 0

const DEFAULT_WINDOW_SIZE = { width: 1200, height: 800 }
const windowStates = createWindowStateStore(appState)
const trackedWindows = createWindowStateGroup()
/** Two-pass quitting, installed once the first window exists. */
let quitting: QuitHandling | undefined

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
    // Hidden until its theme is applied and its first frame is ready, so there is no flash of an unthemed window.
    show: false,
    webPreferences: {
      // Built next to app.js by shell/preload/vite.config.ts
      preload: path.join(__dirname, 'preload.js')
    }
  })

  trackedWindows.track(win, current => windowStates.save(key, current), { log })

  // Attached, with its saved layout loaded, before the page loads so its first layout request is right.
  const id = win.id
  await layoutHost.attachWindow(id, key)
  win.on('closed', () => { layoutHost.detachWindow(id).catch(err => log.error('[layout] Could not save the layout', err)) })

  const themed = await themeHost.attachWindow(id, key)
  win.setBackgroundColor(windowBackground(themed, theme.list()))
  // Maximizing shows a hidden window, so it waits for the reveal.
  reveal.track(win, { show: () => { if (state.maximized) win.maximize(); win.show() } })
  win.on('closed', () => { themeHost.detachWindow(id).catch(err => log.error('[theme] Could not save the theme', err)) })
  win.on('closed', () => dialogs.windowClosed(id))
  // On Windows and Linux, closing the last window quits: the quit's first pass runs while the window is still there,
  // and the window stays if the user cancels
  win.on('close', event => {
    if (process.platform !== 'darwin' && BrowserWindow.getAllWindows().length === 1) quitting?.closingLastWindow(event)
  })

  win.loadURL('http://localhost:5173')
  return win
}

app.whenReady().then((async () => {
  await bootstrap()
  const win = await createWindow()
  // Quitting runs the ShuttingDown listeners, deactivates every plugin, then quits.
  // Inside ready, because powerMonitor can't be used before it.
  quitting = installQuitHandling(app, runtime.lifecycle, pluginManager, log, osShutdownSources(win), {
    ask: reasons => askToQuit({ dialog, BrowserWindow }, reasons),
    cancelDialogs: () => dialogs.cancelAll()
  })
  await runtime.lifecycle.markStarted()
}))

app.on('browser-window-focus', (_event, win) => {
  layoutHost?.focus(win.id)
  themeHost?.focus(win.id)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
