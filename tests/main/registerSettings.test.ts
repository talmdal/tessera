import { describe, expect, it } from 'vitest'
import { SETTINGS_OPEN_COMMAND, SETTINGS_PAGES_EXTENSION_POINT } from '@tessera/types'
import { createPluginContext, createPluginRuntime } from '../../core/plugins/PluginContext'
import { resolveMenus } from '../../shared/menus/resolveMenus'
import { MENUS_EXTENSION_POINT, TOOLS_MENU } from '../../shared/menus/types'
import { SHELL_CONTRIBUTOR_ID } from '../../shared/plugins/manifest'
import { SETTINGS_CHANGED, SETTINGS_COMMIT, SETTINGS_GET, SETTINGS_OPEN, SettingsCatalogue } from '../../shared/settings/types'
import { registerSettings } from '../../shell/main/settings/registerSettings'
import { createLogger } from '../helpers/runtime'
import { memorySettingsPersistence } from '../helpers/settings'

const DEFAULTS = { reopenLast: true, recentLimit: 10 }

function setup(options: { window?: number } = { window: 3 }) {
  const log = createLogger()
  const store = memorySettingsPersistence()
  const runtime = createPluginRuntime(undefined, log, { settingsPersistence: store.persistence })
  const shell = createPluginContext(SHELL_CONTRIBUTOR_ID, runtime).context
  registerSettings(shell, runtime, {
    remoteEntryFor: id => id === 'headless' ? undefined : `tessera-plugin://${id}/remoteEntry.js`,
    targetWindow: () => options.window,
    log
  })

  const events: { name: string, data?: any }[] = []
  runtime.events.subscribe(event => events.push(event))
  const ask = async (channel: string, data?: unknown) => {
    const reply = await runtime.ipc.dispatch({ channel, data }, { windowId: 3 })
    if (!reply.ok) throw new Error(reply.error.message)
    return reply.data as any
  }
  const plugin = (id: string) => createPluginContext(id, runtime).context
  return { runtime, shell, log, store, events, ask, plugin }
}

describe('settings in the shell: the Options dialog\'s requests', () => {
  it('lists every page, with the remote entry of those that have a component, and every namespace', async () => {
    const { ask, plugin } = setup()
    const ledger = plugin('ledger')
    ledger.settings.register({ defaults: DEFAULTS })
    ledger.extensions.contribute('ledger', SETTINGS_PAGES_EXTENSION_POINT, 'ledger.settings', {
      id: 'ledger.settings', title: 'Ledger', fields: [{ kind: 'boolean', key: 'reopenLast', label: 'Reopen' }]
    })
    const accounts = plugin('accounts')
    accounts.settings.register({ defaults: { showClosed: false } })
    accounts.extensions.contribute('accounts', SETTINGS_PAGES_EXTENSION_POINT, 'accounts.settings', { id: 'accounts.settings', title: 'Accounts', module: './AccountsSettings' })

    const catalogue: SettingsCatalogue = await ask(SETTINGS_GET)

    expect(catalogue.pages).toEqual([
      { id: 'ledger.settings', title: 'Ledger', pluginId: 'ledger', settings: 'ledger', keywords: [], fields: [{ kind: 'boolean', key: 'reopenLast', label: 'Reopen' }] },
      { id: 'accounts.settings', title: 'Accounts', pluginId: 'accounts', settings: 'accounts', module: './AccountsSettings', keywords: [], remoteEntry: 'tessera-plugin://accounts/remoteEntry.js' }
    ])
    expect(catalogue.namespaces.map(n => n.id)).toEqual(['ledger', 'accounts'])
  })

  it('keeps a component page of a plugin without a renderer, saying so once, so the pages under it keep their place', async () => {
    const { ask, plugin, log } = setup()
    const headless = plugin('headless')
    headless.settings.register({ defaults: {} })
    headless.extensions.contribute('headless', SETTINGS_PAGES_EXTENSION_POINT, 'headless.settings', { id: 'headless.settings', title: 'Headless', module: './Page' })

    expect((await ask(SETTINGS_GET)).pages[0]).not.toHaveProperty('remoteEntry')
    await ask(SETTINGS_GET)
    expect(log.warn.mock.calls.filter((c: unknown[]) => String(c[0]).includes('headless'))).toEqual([
      ['[settings] Settings page "headless.settings" has a module, but "headless" has no renderer entry']
    ])
  })

  it('applies the dialog\'s changes, logging which window made them, and answers with the new values', async () => {
    const { ask, plugin, log, store } = setup()
    const handle = plugin('ledger').settings.register({ defaults: DEFAULTS })

    const result = await ask(SETTINGS_COMMIT, { changes: [{ id: 'ledger', value: { ...DEFAULTS, recentLimit: 3 } }] })

    expect(result).toEqual({ ok: true, namespaces: [{ id: 'ledger', owner: 'ledger', value: { ...DEFAULTS, recentLimit: 3 }, defaults: DEFAULTS }] })
    expect(handle.get().recentLimit).toBe(3)
    expect(store.documents.get('ledger')).toEqual({ version: 1, values: { recentLimit: 3 } })
    expect(log.info).toHaveBeenCalledWith('[settings] Window 3 applied ledger')
  })

  it('answers refused changes with the messages, and refuses a request without changes', async () => {
    const { ask, plugin } = setup()
    plugin('ledger').settings.register({ defaults: DEFAULTS, validate: v => v.recentLimit > 0 ? [] : ['Keep one.'] })

    expect(await ask(SETTINGS_COMMIT, { changes: [{ id: 'ledger', value: { recentLimit: 0 } }] })).toEqual({ ok: false, errors: { ledger: ['Keep one.'] } })
    await expect(ask(SETTINGS_COMMIT, {})).rejects.toThrow('A settings commit needs a list of changes')
  })

  it('tells every window when a namespace changes, wherever the change came from', async () => {
    const { plugin, events } = setup()
    await plugin('ledger').settings.register({ defaults: DEFAULTS }).update({ reopenLast: false })

    expect(events.filter(e => e.name === SETTINGS_CHANGED).map(e => e.data)).toEqual([
      { id: 'ledger', owner: 'ledger', value: { ...DEFAULTS, reopenLast: false }, defaults: DEFAULTS, changed: ['reopenLast'] }
    ])
  })

  it('finishes writing after the last plugin has deactivated', async () => {
    const { runtime, plugin, store } = setup()
    const handle = plugin('ledger').settings.register({ defaults: DEFAULTS })
    store.hold()
    void handle.update({ recentLimit: 2 })

    const done = runtime.lifecycle.markShutDown()
    store.release()
    await done
    expect(store.documents.get('ledger')).toEqual({ version: 1, values: { recentLimit: 2 } })
  })
})

describe('settings in the shell: opening the dialog', () => {
  it('opens the dialog in the focused window, at a page if one is named', async () => {
    const { runtime, events } = setup()
    await runtime.commands.execute(SETTINGS_OPEN_COMMAND)
    await runtime.commands.execute(SETTINGS_OPEN_COMMAND, 'ledger.settings')

    expect(events.filter(e => e.name === SETTINGS_OPEN).map(e => e.data)).toEqual([{ windowId: 3 }, { windowId: 3, page: 'ledger.settings' }])
  })

  it('refuses when there is no window, or the page is not an id', async () => {
    await expect(setup({}).runtime.commands.execute(SETTINGS_OPEN_COMMAND)).rejects.toThrow('There is no window to show the settings in')
    await expect(setup().runtime.commands.execute(SETTINGS_OPEN_COMMAND, 42)).rejects.toThrow('The page to open must be a settings page id')
  })

  it('adds Tools ▸ Options… with Ctrl+, below the plugins\' Tools items', () => {
    const { runtime } = setup()
    const contributions = [
      { kind: 'menu', id: TOOLS_MENU, label: '&Tools' },
      { kind: 'item', id: 'budget.tools.recalc', label: 'Recalculate', parent: TOOLS_MENU, command: 'budget.recalc' },
      ...runtime.extensions.getContributions(MENUS_EXTENSION_POINT).map(c => c.impl)
    ]
    const { menus, diagnostics } = resolveMenus(contributions)
    expect(diagnostics).toEqual([])
    const tools = menus.find(m => m.id === TOOLS_MENU)!
    expect(tools.children.filter(n => n.type === 'item')).toEqual([
      expect.objectContaining({ label: 'Recalculate' }),
      { type: 'item', id: 'shell.tools.options', label: '&Options…', command: SETTINGS_OPEN_COMMAND, accelerator: 'CmdOrCtrl+,' }
    ])
  })
})
