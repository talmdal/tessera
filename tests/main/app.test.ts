import { describe, it, expect, vi, onTestFinished } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { DEFAULT_FONT_SETTINGS } from '../../shared/fonts/resolveFonts'

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
      renderer: { entry: 'renderer/remoteEntry.js' },
      // Provided by the shell before plugins activate; a missing one would skip this plugin
      services: { requires: ['shell.prompts', 'shell.files'] }
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
        context.extensions.contribute('test-plugin', 'shell.dialogs', 'test-plugin.name', { id: 'test-plugin.name', title: 'Name', module: './NameDialog' })
        const prompts = context.services.get('shell.prompts')
        context.commands.register('test-plugin.ask', () => prompts.show('test-plugin.name', { name: 'Home' }))
        context.settings.register({ defaults: { greeting: 'Hello' } })
        context.extensions.contribute('test-plugin', 'shell.settings.pages', 'test-plugin.settings', {
          id: 'test-plugin.settings', title: 'Test', fields: [{ kind: 'text', key: 'greeting', label: 'Greeting', required: true }]
        })
      }
    `
  )

  const handlers: Record<string, any> = {}
  const syncHandlers: Record<string, any> = {}
  const liveWindow = { id: 7, isDestroyed: () => false, webContents: { send: vi.fn() } }

  return {
    ipcMain: {
      handle: vi.fn((channel, fn) => {
        handlers[channel] = fn
      }),
      on: vi.fn((channel, fn) => {
        syncHandlers[channel] = fn
      }),
      __invoke: async (channel: string, payload: any) => {
        const handler = handlers[channel]
        if (!handler) throw new Error(`No IPC handler for ${channel}`)
        return handler({}, payload)
      },
      // A synchronous request, as the preload sends: the handler answers by setting returnValue
      __sendSync: (channel: string) => {
        const event: any = { sender: {} }
        syncHandlers[channel](event)
        return event.returnValue
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

    nativeTheme: { themeSource: 'system', shouldUseDarkColors: false, on: vi.fn(), removeListener: vi.fn() },

    dialog: {
      showMessageBox: vi.fn(),
      showOpenDialog: vi.fn(),
      showSaveDialog: vi.fn()
    },

    shell: { trashItem: vi.fn() },

    powerMonitor: { on: vi.fn() },

    screen: { getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }] },

    protocol: {
      registerSchemesAsPrivileged: vi.fn(),
      handle: vi.fn()
    },

    // The font probe's session (shell/main/fonts/electronFontProbe.ts); the probe itself can't run under this mock
    session: { fromPartition: vi.fn(() => ({ setPermissionCheckHandler: vi.fn(), setPermissionRequestHandler: vi.fn() })) },

    BrowserWindow: Object.assign(vi.fn(function () { return {
      id: 7,
      loadURL: vi.fn(),
      setBackgroundColor: vi.fn(),
      show: vi.fn(),
      maximize: vi.fn(),
      once: vi.fn(),
      isDestroyed: () => false,
    getNativeWindowHandle: vi.fn(() => Buffer.alloc(8)),
      on: vi.fn(),
      webContents: { openDevTools: vi.fn() }
    } }), { getAllWindows: () => [liveWindow], fromWebContents: () => ({ id: 7 }), getFocusedWindow: () => null }),

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
// These tests share one app, started once for the file, so they run in the order written even when tests are shuffled:
// the window's start-up sequence (hidden until page and renderer are ready) can only be seen before another test has
// signalled that the renderer is ready. Tests that change the app's settings put them back (see the theme command test).
describe('main process (dynamic plugin system)', { shuffle: false }, () => {
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

  it('answers a window with its theme, following the system by default', async () => {
    await vi.waitFor(() => expect(electron.Menu.setApplicationMenu).toHaveBeenCalled())

    const response = await (electron.ipcMain as any).__invoke('tessera:invoke', { channel: 'shell:theme.get' })

    expect(response).toMatchObject({
      ok: true,
      data: { state: { windowId: 7, theme: 'tessera.default', mode: 'light', global: { mode: 'system' } }, themes: [{ id: 'tessera.default' }] }
    })
    // With the user's fonts, at their defaults: every role Automatic, so the window looks as it always has
    expect(response.data.fonts).toEqual(DEFAULT_FONT_SETTINGS)
  })

  it('runs a theme command from the renderer, switches the native theme and publishes the new theme', async () => {
    // Every test in this file shares one app: put the theme back afterwards, even if this test fails, so no other test
    // depends on running before this one
    onTestFinished(() => (electron.ipcMain as any).__invoke('tessera:invoke', { channel: 'shell:commands.execute', data: { id: 'shell.theme.useSystem' } }))
    await vi.waitFor(() => expect(electron.Menu.setApplicationMenu).toHaveBeenCalled())
    const [window] = electron.BrowserWindow.getAllWindows() as any[]
    const before = window.webContents.send.mock.calls.length

    const dark = await (electron.ipcMain as any).__invoke('tessera:invoke', { channel: 'shell:commands.execute', data: { id: 'shell.theme.useDark' } })

    expect(dark).toMatchObject({ ok: true })
    expect(electron.nativeTheme.themeSource).toBe('dark')
    expect(window.webContents.send.mock.calls.slice(before).map((call: any[]) => call[1].name)).toContain('shell:theme.changed')
    await expect((electron.ipcMain as any).__invoke('tessera:invoke', { channel: 'shell:theme.get' }))
      .resolves.toMatchObject({ data: { state: { mode: 'dark' } } })
  })

  it('re-themes the window when a theme is applied in the Options dialog, keeping the choice as a setting', async () => {
    await vi.waitFor(() => expect(electron.Menu.setApplicationMenu).toHaveBeenCalled())
    const invoke = (channel: string, data?: unknown) => (electron.ipcMain as any).__invoke('tessera:invoke', { channel, data })
    const applyTheme = (mode: string) => invoke('shell:settings.commit', { changes: [{ id: 'shell.theme', value: { theme: 'tessera.default', mode } }] })
    onTestFinished(() => applyTheme('system'))
    const [window] = electron.BrowserWindow.getAllWindows() as any[]
    const before = window.webContents.send.mock.calls.length

    expect(await applyTheme('dark')).toMatchObject({ ok: true, data: { ok: true } })

    const published = window.webContents.send.mock.calls.slice(before).map((call: any[]) => call[1])
    expect(published).toContainEqual(expect.objectContaining({ name: 'shell:theme.changed', data: expect.objectContaining({ state: expect.objectContaining({ mode: 'dark' }) }) }))
    expect(electron.nativeTheme.themeSource).toBe('dark')
    const file = path.join(electron.app.getPath('userData'), 'settings', 'shell.theme.json')
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ version: 1, values: { mode: 'dark' } })

    // Chosen in Options now: the View menu has no Theme submenu
    const template = vi.mocked(electron.Menu.buildFromTemplate).mock.calls[0][0] as any[]
    expect(template.find(m => m.label === '&View').submenu.map((i: any) => i.label)).not.toContain('&Theme')
  })

  it('answers the preload synchronously with the window theme, so the first render is themed', async () => {
    await vi.waitFor(() => expect(electron.Menu.setApplicationMenu).toHaveBeenCalled())

    const snapshot = (electron.ipcMain as any).__sendSync('shell:theme.initial')

    expect(snapshot).toMatchObject({ state: { windowId: 7, theme: 'tessera.default', mode: expect.stringMatching(/^(light|dark)$/) }, themes: [{ id: 'tessera.default' }] })
    // The user's fonts too, so the first frame is drawn in them
    expect(snapshot.fonts).toEqual(DEFAULT_FONT_SETTINGS)
  })

  it("re-fonts the window when fonts are applied in the Options dialog, keeping only what differs as a setting", async () => {
    await vi.waitFor(() => expect(electron.Menu.setApplicationMenu).toHaveBeenCalled())
    const invoke = (channel: string, data?: unknown) => (electron.ipcMain as any).__invoke('tessera:invoke', { channel, data })
    const applyFonts = (value: unknown) => invoke('shell:settings.commit', { changes: [{ id: 'shell.fonts', value }] })
    onTestFinished(() => applyFonts(DEFAULT_FONT_SETTINGS))
    const [window] = electron.BrowserWindow.getAllWindows() as any[]
    const before = window.webContents.send.mock.calls.length
    const file = path.join(electron.app.getPath('userData'), 'settings', 'shell.fonts.json')

    // The Options dialog knows the namespace, at its defaults, with no file
    const catalogue = await invoke('shell:settings.get')
    expect(catalogue.data.namespaces).toContainEqual(expect.objectContaining({ id: 'shell.fonts', owner: 'shell', value: DEFAULT_FONT_SETTINGS }))
    expect(fs.existsSync(file)).toBe(false)

    const larger = { ...DEFAULT_FONT_SETTINGS, roles: { ...DEFAULT_FONT_SETTINGS.roles, ui: { family: ['Inter'], size: 16, weight: null } } }
    expect(await applyFonts(larger)).toMatchObject({ ok: true, data: { ok: true } })

    const published = window.webContents.send.mock.calls.slice(before).map((call: any[]) => call[1])
    expect(published).toContainEqual(expect.objectContaining({ name: 'shell:theme.changed', data: expect.objectContaining({ fonts: larger }) }))
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ version: 1, values: { roles: { ui: { family: ['Inter'], size: 16 } } } })
    await expect(invoke('shell:theme.get')).resolves.toMatchObject({ data: { fonts: larger } })

    // Something the user couldn't have chosen is refused, with the reason, and nothing changes
    const refused = await applyFonts({ ...larger, roles: { ...larger.roles, ui: { family: null, size: 99, weight: null } } })
    expect(refused).toMatchObject({ ok: true, data: { ok: false, errors: { 'shell.fonts': ['Interface text: choose a size from 11 to 24 px.'] } } })
    await expect(invoke('shell:theme.get')).resolves.toMatchObject({ data: { fonts: larger } })

    // Back to the defaults: the file goes
    await applyFonts(DEFAULT_FONT_SETTINGS)
    await vi.waitFor(() => expect(fs.existsSync(file)).toBe(false))
  })

  it('has a Fonts page under Appearance, which its command opens, and answers with the installed fonts', async () => {
    await vi.waitFor(() => expect(electron.Menu.setApplicationMenu).toHaveBeenCalled())
    const invoke = (channel: string, data?: unknown) => (electron.ipcMain as any).__invoke('tessera:invoke', { channel, data })
    const [window] = electron.BrowserWindow.getAllWindows() as any[]

    const catalogue = await invoke('shell:settings.get')
    expect(catalogue.data.pages).toContainEqual(expect.objectContaining({ id: 'shell.appearance.fonts', title: 'Fonts', parent: 'shell.appearance', settings: 'shell.fonts', module: './Fonts' }))

    const before = window.webContents.send.mock.calls.length
    await invoke('shell:commands.execute', { id: 'shell.fonts.choose' })
    expect(window.webContents.send.mock.calls.slice(before).map((call: any[]) => call[1]))
      .toContainEqual({ name: 'shell:settings.open', data: { windowId: 7, page: 'shell.appearance.fonts' } })

    // The probe can't list fonts under this mock, so the answer is "not available": the page then offers typing a name
    await expect(invoke('shell:fonts.families')).resolves.toEqual({ ok: true, data: { families: [], complete: false } })
    expect(electron.session.fromPartition).toHaveBeenCalledWith('tessera-font-probe')
  })

  it('creates the window hidden, painted in its theme colour, and shows it once page and renderer are ready', async () => {
    await vi.waitFor(() => expect(electron.Menu.setApplicationMenu).toHaveBeenCalled())
    const options = vi.mocked(electron.BrowserWindow).mock.calls[0][0] as any
    const win = vi.mocked(electron.BrowserWindow).mock.results[0].value as any

    expect(options.show).toBe(false)
    expect(win.setBackgroundColor).toHaveBeenCalledWith(expect.stringMatching(/^#[0-9a-f]{6}$/i))
    expect(win.show).not.toHaveBeenCalled()

    // The page is ready to show, but its renderer has not said its first frame is ready
    const pageReady = win.once.mock.calls.find((call: any[]) => call[0] === 'ready-to-show')![1]
    pageReady()
    expect(win.show).not.toHaveBeenCalled()

    await (electron.ipcMain as any).__invoke('tessera:invoke', { channel: 'shell:window.ready' })

    expect(win.show).toHaveBeenCalledTimes(1)
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
  it('keeps plugin settings in the user data folder, edited through the Options dialog opened from Tools', async () => {
    await vi.waitFor(() => expect(electron.Menu.setApplicationMenu).toHaveBeenCalled())
    const invoke = (channel: string, data?: unknown) => (electron.ipcMain as any).__invoke('tessera:invoke', { channel, data })
    const file = path.join(electron.app.getPath('userData'), 'settings', 'test-plugin.json')
    onTestFinished(() => invoke('shell:settings.commit', { changes: [{ id: 'test-plugin', value: { greeting: 'Hello' } }] }))

    const template = vi.mocked(electron.Menu.buildFromTemplate).mock.calls[0][0] as any[]
    expect(template.find(m => m.label === '&Tools').submenu).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: '&Options…', accelerator: 'CmdOrCtrl+,', enabled: true })
    ]))

    const catalogue = await invoke('shell:settings.get')
    expect(catalogue.ok).toBe(true)
    // The shell's own Appearance page comes first; the plugin's follows
    expect(catalogue.data.pages.map((p: any) => [p.id, p.settings])).toEqual([
      ['shell.appearance', 'shell.theme'], ['shell.appearance.fonts', 'shell.fonts'], ['test-plugin.settings', 'test-plugin']
    ])
    expect(catalogue.data.namespaces).toContainEqual(expect.objectContaining({ id: 'test-plugin', value: { greeting: 'Hello' } }))

    expect(await invoke('shell:settings.commit', { changes: [{ id: 'test-plugin', value: { greeting: ' ' } }] }))
      .toEqual({ ok: true, data: { ok: false, errors: { 'test-plugin': ["Greeting: this can't be empty."] } } })
    expect(await invoke('shell:settings.commit', { changes: [{ id: 'test-plugin', value: { greeting: 'Bonjour' } }] }))
      .toMatchObject({ ok: true, data: { ok: true } })
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ version: 1, values: { greeting: 'Bonjour' } })

    const [window] = electron.BrowserWindow.getAllWindows() as any[]
    const before = window.webContents.send.mock.calls.length
    await invoke('shell:commands.execute', { id: 'shell.settings.open', args: ['test-plugin.settings'] })
    expect(window.webContents.send.mock.calls.slice(before).map((call: any[]) => call[1]))
      .toContainEqual({ name: 'shell:settings.open', data: { windowId: 7, page: 'test-plugin.settings' } })
  })

  // Last: it reports the window ready, which the window-reveal test needs not to have happened yet
  it('shows a dialog a plugin asks for in the window, and hands the window\'s answer back to the plugin', async () => {
    await vi.waitFor(() => expect(electron.Menu.setApplicationMenu).toHaveBeenCalled())
    const invoke = (channel: string, data?: unknown) => (electron.ipcMain as any).__invoke('tessera:invoke', { channel, data })
    const [window] = electron.BrowserWindow.getAllWindows() as any[]
    const before = window.webContents.send.mock.calls.length

    await invoke('shell:window.ready')
    const asked = invoke('shell:commands.execute', { id: 'test-plugin.ask' })

    let open: any
    await vi.waitFor(() => {
      open = window.webContents.send.mock.calls.slice(before).map((call: any[]) => call[1]).find((e: any) => e.name === 'shell:dialog.open')?.data
      expect(open).toBeDefined()
    })
    expect(open).toMatchObject({
      windowId: 7, title: 'Name', input: { name: 'Home' },
      dialog: { id: 'test-plugin.name', module: './NameDialog', pluginId: 'test-plugin', remoteEntry: 'tessera-plugin://test-plugin/remoteEntry.js' }
    })

    await expect(invoke('shell:dialog.close', { requestId: open.requestId, result: { name: 'Cottage' } })).resolves.toMatchObject({ ok: true })
    await expect(asked).resolves.toEqual({ ok: true, data: { name: 'Cottage' } })
  })
})
