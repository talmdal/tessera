import { describe, it, expect, vi } from 'vitest'
import * as electron from 'electron'
import { PluginContext, createPluginContext } from '../../core/plugins/PluginContext'
import { MENUS_EXTENSION_POINT, MenuContribution } from '../../shared/menus/types'
import { registerCoreMenus } from '../../shell/main/menus/coreMenus'
import { applyApplicationMenu } from '../../shell/main/menus/electronMenu'
import { createRuntime } from '../helpers/runtime'

type Item = electron.MenuItemConstructorOptions

function setup(extra: MenuContribution[] = [], registerCommands?: (context: PluginContext) => void) {
  const runtime = createRuntime()
  registerCoreMenus(createPluginContext('shell', runtime).context)

  const plugin = createPluginContext('p', runtime)
  registerCommands?.(plugin.context)
  for (const c of extra) plugin.context.extensions.contribute(MENUS_EXTENSION_POINT, c)

  vi.mocked(electron.Menu.buildFromTemplate).mockClear()
  const tracking = applyApplicationMenu(runtime.extensions, runtime.commands)
  const template = vi.mocked(electron.Menu.buildFromTemplate).mock.calls[0][0]
  const find = (id: string): Item => template.flatMap(m => m.submenu as Item[]).find(i => i.id === id)!

  return { template, find, plugin, tracking }
}

describe('electron menu renderer', () => {
  it('renders the core File, Tools and Help menus', () => {
    const { template } = setup()

    expect(template.map(m => m.label)).toEqual(['&File', '&Tools', '&Help'])
    expect(electron.Menu.setApplicationMenu).toHaveBeenCalled()
  })

  it('consolidates separators between plugin groups and shell groups', () => {
    const { template } = setup([
      { kind: 'group', id: 'p.empty', parent: 'shell.file', order: 1 },
      { kind: 'item', id: 'p.open', label: 'Open', parent: 'shell.file', command: 'p.open' }
    ])

    const file = template[0].submenu as Item[]
    expect(file.map(i => i.type === 'separator' ? '-' : i.id)).toEqual(['p.open', '-', 'shell.file.exit'])
  })

  it('drops contributed menus that have no items', () => {
    const { template } = setup([{ kind: 'menu', id: 'p.empty', label: 'Empty' }])

    expect(template.map(m => m.id)).toEqual(['shell.file', 'shell.tools', 'shell.help'])
  })

  it('disables items whose command is not registered and runs registered commands on click', async () => {
    const run = vi.fn()
    const { find } = setup([
      { kind: 'item', id: 'p.missing', label: 'Missing', parent: 'shell.tools', command: 'p.missing' },
      { kind: 'item', id: 'p.run', label: 'Run', parent: 'shell.tools', command: 'p.run' }
    ], context => context.commands.register('p.run', run))

    expect(find('p.missing').enabled).toBe(false)
    expect(find('p.run').enabled).toBe(true)
    ;(find('p.run').click as () => void)()
    await vi.waitFor(() => expect(run).toHaveBeenCalled())
  })

  it('updates items in place as context keys change their command enablement', () => {
    const { find, plugin } = setup([
      { kind: 'item', id: 'p.save', label: 'Save', parent: 'shell.file', command: 'p.save' },
      { kind: 'item', id: 'p.close', label: 'Close', parent: 'shell.file', command: 'p.close' }
    ], context => {
      context.commands.register('p.save', () => {}, { enablement: 'p.isOpen && p.isDirty' })
      context.commands.register('p.close', () => {}, { enablement: 'p.isOpen' })
    })
    const keys = plugin.context.contextKeys
    const state = () => [find('p.close').enabled, find('p.save').enabled]

    expect(state()).toEqual([false, false])
    keys.set('p.isOpen', true)
    expect(state()).toEqual([true, false])
    keys.set('p.isDirty', true)
    expect(state()).toEqual([true, true])
    keys.set('p.isOpen', false)
    expect(state()).toEqual([false, false])
  })

  it('follows commands registered or removed after the menu was built', () => {
    const { find, plugin } = setup([
      { kind: 'item', id: 'p.late', label: 'Late', parent: 'shell.tools', command: 'p.late' }
    ])

    expect(find('p.late').enabled).toBe(false)
    const registration = plugin.context.commands.register('p.late', () => {})
    expect(find('p.late').enabled).toBe(true)
    registration.dispose()
    expect(find('p.late').enabled).toBe(false)
  })

  it('disables a plugin\'s items when the plugin is deactivated, and stops tracking on dispose', () => {
    const { find, plugin, tracking } = setup([
      { kind: 'item', id: 'p.close', label: 'Close', parent: 'shell.file', command: 'p.close' }
    ], context => {
      context.commands.register('p.close', () => {}, { enablement: 'p.isOpen' })
      context.contextKeys.set('p.isOpen', true)
    })

    expect(find('p.close').enabled).toBe(true)
    plugin.dispose()
    expect(find('p.close').enabled).toBe(false)

    tracking.dispose()
    plugin.context.commands.register('p.close', () => {})
    expect(find('p.close').enabled).toBe(false)
  })
})
