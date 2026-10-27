import { describe, it, expect, vi } from 'vitest'
import type { IpcEvent } from '@tessera/types'
import { CommandRegistryImpl } from '../../core/commands/CommandRegistry'
import { LayoutService } from '../../core/layout/LayoutService'
import { createPluginContext } from '../../core/plugins/PluginContext'
import {
  BAR_ITEMS_CHANGED,
  BAR_ITEMS_LIST,
  COMMANDS_EXECUTE,
  LAYOUT_CHANGED,
  LAYOUT_GET,
  LAYOUT_REVEAL,
  LAYOUT_REVEALED,
  LAYOUT_SLOT_SET
} from '../../shared/layout/types'
import { MENUS_EXTENSION_POINT, VIEW_MENU } from '../../shared/menus/types'
import { VIEWS_EXTENSION_POINT } from '../../shared/views/types'
import { createLayoutContent } from '../../shell/main/layout/layoutContent'
import { LAYOUT_COMMANDS, registerLayout } from '../../shell/main/layout/registerLayout'
import { createLogger, createRuntime } from '../helpers/runtime'

function setup({ focusedId = () => 1 as number | undefined } = {}) {
  const runtime = createRuntime()
  const shell = createPluginContext('shell', runtime).context
  const log = createLogger()

  const content = createLayoutContent(runtime.extensions, {
    remoteEntryFor: () => 'tessera-plugin://p/remoteEntry.js',
    assetUrlFor: (id, rel) => `tessera-plugin://${id}/${rel}`,
    isCommandEnabled: id => runtime.commands.isEnabled(id)
  }, log)

  const service = new LayoutService(content.source, runtime.contextKeys, { log })
  const registration = registerLayout(
    shell, runtime, service, content, { focusedId },
    (runtime.commands as CommandRegistryImpl).onDidChange, log
  )

  const events: IpcEvent[] = []
  runtime.events.subscribe(event => events.push(event))

  const contributeView = (id: string, slot: string, extra: Record<string, unknown> = {}) =>
    runtime.extensions.contribute('p', VIEWS_EXTENSION_POINT, id,
      { id, title: id, slot, module: './V', icon: 'save', ...extra })

  const invoke = (channel: string, data?: unknown, windowId?: number) =>
    runtime.ipc.dispatch({ channel, data }, windowId === undefined ? undefined : { windowId })

  return { runtime, shell, log, service, registration, events, contributeView, invoke }
}

describe('registerLayout', () => {
  it('contributes the View menu with the toggle and layout commands', () => {
    const { runtime } = setup()

    const menus = runtime.extensions.getContributions(MENUS_EXTENSION_POINT).map(c => c.impl as any)
    expect(menus.find(m => m.id === VIEW_MENU)).toMatchObject({ kind: 'menu', label: '&View' })
    expect(menus.find(m => m.id === 'shell.view.toggle.left'))
      .toMatchObject({ command: 'shell.layout.toggle.left', accelerator: 'CmdOrCtrl+B' })
    for (const command of ['shell.layout.toggle.bottom', LAYOUT_COMMANDS.collapseAll, LAYOUT_COMMANDS.expandAll, LAYOUT_COMMANDS.reset, LAYOUT_COMMANDS.reveal]) {
      expect(runtime.commands.has(command), command).toBe(true)
    }
  })

  describe('IPC', () => {
    it('answers layout requests for the sending window', async () => {
      const { registration, contributeView, invoke } = setup()
      registration.attachWindow(1, 'main')
      contributeView('p.a', 'shell.left')

      const got = await invoke(LAYOUT_GET, undefined, 1)
      expect(got).toMatchObject({ ok: true, data: expect.objectContaining({ windowId: 1 }) })

      const set = await invoke(LAYOUT_SLOT_SET, { slot: 'shell.left', collapsed: true }, 1)
      expect(set).toMatchObject({ ok: true, data: expect.objectContaining({ bars: expect.anything() }) })
      expect((set as any).data.bars.left.collapsed).toBe(true)
    })

    it('rejects layout requests without a managed sender window', async () => {
      const { registration, invoke } = setup()
      registration.attachWindow(1, 'main')

      expect(await invoke(LAYOUT_GET)).toMatchObject({ ok: false, error: { code: 'HANDLER_ERROR' } })
      expect(await invoke(LAYOUT_GET, undefined, 99)).toMatchObject({ ok: false, error: { code: 'HANDLER_ERROR' } })
      expect(await invoke(LAYOUT_SLOT_SET, { slot: 42 }, 1)).toMatchObject({ ok: false, error: { message: 'slot is required' } })
    })

    it('reveals a view and pushes layout.changed then layout.revealed', async () => {
      const { registration, contributeView, invoke, events } = setup()
      registration.attachWindow(1, 'main')
      contributeView('p.a', 'shell.right')
      events.length = 0

      const response = await invoke(LAYOUT_REVEAL, { viewId: 'p.a' }, 1)

      expect(response).toMatchObject({ ok: true })
      const names = events.map(e => e.name)
      expect(names.indexOf(LAYOUT_REVEALED)).toBeGreaterThan(-1)
      expect(events.find(e => e.name === LAYOUT_REVEALED)?.data).toEqual({ windowId: 1, viewId: 'p.a', slot: 'shell.right' })
      expect(await invoke(LAYOUT_REVEAL, { viewId: 'ghost' }, 1)).toMatchObject({ ok: false })
    })

    it('lists bar items with enabled flags and republishes when one flips', async () => {
      const { runtime, registration, invoke, events } = setup()
      registration.attachWindow(1, 'main')
      runtime.extensions.contribute('p', 'shell.bar.items', 'p.save',
        { kind: 'button', id: 'p.save', slot: 'shell.top', label: 'Save', command: 'p.save' })

      const before = await invoke(BAR_ITEMS_LIST, undefined, 1)
      expect((before as any).data).toEqual([expect.objectContaining({ id: 'p.save', enabled: false, pluginId: 'p' })])

      events.length = 0
      runtime.commands.register('p.save', () => {})
      expect(events.map(e => e.name)).toContain(BAR_ITEMS_CHANGED)

      // A command change that flips nothing stays silent
      events.length = 0
      runtime.commands.register('p.other', () => {})
      expect(events.map(e => e.name)).not.toContain(BAR_ITEMS_CHANGED)
    })

    it('executes commands for the renderer, refusing disabled ones', async () => {
      const { runtime, invoke, log } = setup()
      const handler = vi.fn(() => 'done')
      runtime.commands.register('p.go', handler)
      runtime.commands.register('p.locked', vi.fn(), { enablement: 'never.set' })

      expect(await invoke(COMMANDS_EXECUTE, { id: 'p.go', args: [1, 'two'] }, 1)).toMatchObject({ ok: true, data: 'done' })
      expect(handler).toHaveBeenCalledWith(1, 'two')
      expect(log.info).toHaveBeenCalledWith(expect.stringContaining('"p.go"'))

      expect(await invoke(COMMANDS_EXECUTE, { id: 'p.locked' }, 1)).toMatchObject({
        ok: false, error: { message: 'Command is disabled: p.locked' }
      })
      expect(await invoke(COMMANDS_EXECUTE, { id: 42 }, 1)).toMatchObject({ ok: false })
    })
  })

  describe('commands and context keys', () => {
    it('toggle commands act on the focused window and follow hasContent', async () => {
      const { runtime, registration, service, contributeView } = setup({ focusedId: () => 2 })
      registration.attachWindow(1, 'main')
      registration.attachWindow(2, 'second')

      expect(runtime.commands.isEnabled('shell.layout.toggle.left')).toBe(false)
      contributeView('p.a', 'shell.left')
      expect(runtime.commands.isEnabled('shell.layout.toggle.left')).toBe(true)

      await runtime.commands.execute('shell.layout.toggle.left')
      expect(service.get(2).bars.left.collapsed).toBe(true)
      expect(service.get(1).bars.left.collapsed).toBe(false)

      await runtime.commands.execute(LAYOUT_COMMANDS.expandAll)
      expect(service.get(2).bars.left.collapsed).toBe(false)
    })

    it('publishes the per-window keys for the focused window', () => {
      const { runtime, registration, service, contributeView } = setup({ focusedId: () => 1 })
      registration.attachWindow(1, 'main')
      contributeView('p.a', 'shell.left')
      contributeView('p.m', 'shell.main', { icon: undefined })

      const keys = runtime.contextKeys
      expect(keys.get('shell.layout.left.hasContent')).toBe(true)
      expect(keys.get('shell.layout.left.visible')).toBe(true)
      expect(keys.get('shell.layout.left.activeView')).toBe('p.a')
      expect(keys.get('shell.layout.main.activeView')).toBe('p.m')
      expect(keys.get('shell.layout.right.hasContent')).toBeUndefined()

      service.setSlot(1, { slot: 'shell.left', collapsed: true })
      expect(keys.get('shell.layout.left.collapsed')).toBe(true)
      expect(keys.get('shell.layout.left.visible')).toBeUndefined()
    })

    it('reveal warns instead of throwing for an unknown view', async () => {
      const { runtime, registration, log } = setup()
      registration.attachWindow(1, 'main')

      await runtime.commands.execute(LAYOUT_COMMANDS.reveal, 'ghost')
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('ghost'), expect.any(Error))
    })
  })

  it('publishes layout.changed with the window id', () => {
    const { registration, events, contributeView } = setup()
    registration.attachWindow(1, 'main')
    events.length = 0

    contributeView('p.a', 'shell.bottom')

    const changed = events.find(e => e.name === LAYOUT_CHANGED)
    expect(changed?.data).toMatchObject({ windowId: 1, bars: expect.anything() })
  })
})
