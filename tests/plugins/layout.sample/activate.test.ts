import { describe, it, expect, vi } from 'vitest'
import type { IpcEvent } from '@tessera/types'
import { createPluginContext } from '../../../core/plugins/PluginContext'
import { activate } from '../../../plugins/layout.sample/src/privileged/index'
import { SampleModel } from '../../../plugins/layout.sample/src/privileged/SampleModel'
import { CHANNELS, COMMANDS, EVENTS, VIEWS } from '../../../plugins/layout.sample/src/shared'
import { createRuntime } from '../../helpers/runtime'

function setup({ withWindowManager = true } = {}) {
  const runtime = createRuntime()
  // Stand-in for the shell's reveal command: records which view was asked for.
  const reveal = vi.fn()
  if (withWindowManager) runtime.commands.register('shell.layout.reveal', reveal)

  const events: IpcEvent[] = []
  runtime.events.subscribe(event => events.push(event))

  const scope = createPluginContext('layout-sample', runtime)
  activate(scope.context)

  const invoke = (channel: string, data?: unknown) => runtime.ipc.dispatch({ channel, data })
  return { runtime, reveal, events, invoke, scope }
}

describe('layout-sample: SampleModel', () => {
  it('counts pings per side and snapshots cloneable state', () => {
    const model = new SampleModel(() => 1234)
    expect(model.snapshot()).toEqual({ counts: { top: 0, bottom: 0, left: 0, right: 0 }, total: 0 })

    model.ping('left')
    const state = model.ping('left')
    expect(state).toEqual({ counts: { top: 0, bottom: 0, left: 2, right: 0 }, total: 2, last: { side: 'left', at: 1234 } })

    // A snapshot is a copy: mutating it does not touch the model.
    state.counts.left = 99
    expect(model.snapshot().counts.left).toBe(2)

    expect(model.reset().total).toBe(0)
  })
})

describe('layout-sample: privileged half', () => {
  it('contributes a view to every slot, two bar items and a View-menu entry', () => {
    const { runtime } = setup()

    const views = runtime.extensions.getContributions('shell.views').map(c => c.impl as any)
    expect(views.map(v => v.slot).sort()).toEqual(['shell.bottom', 'shell.left', 'shell.main', 'shell.main', 'shell.right', 'shell.top'])
    expect(views.filter(v => v.slot !== 'shell.main').every(v => typeof v.icon === 'string')).toBe(true)
    expect(views.map(v => v.module)).toEqual(['./Dashboard', './Detail', './TopPanel', './BottomPanel', './LeftPanel', './RightPanel'])

    expect(runtime.extensions.getContributions('shell.bar.items').map(c => (c.impl as any).kind)).toEqual(['button', 'text'])
    expect(runtime.extensions.getContributions('shell.menus').map(c => (c.impl as any).command)).toEqual([COMMANDS.showDashboard])
  })

  it('answers a ping: updates state, pushes it to the views, sets keys and reveals the detail page', async () => {
    const { reveal, events, invoke, runtime } = setup()
    events.length = 0

    const response = await invoke(CHANNELS.ping, { side: 'left' })

    expect(response).toMatchObject({ ok: true, data: { counts: { left: 1 }, total: 1, last: { side: 'left' } } })
    expect(events.map(e => e.name)).toEqual([EVENTS.changed])
    expect(events[0].data).toMatchObject({ counts: { left: 1 }, total: 1 })
    expect(runtime.contextKeys.get('layout-sample.pings')).toBe(1)
    expect(runtime.contextKeys.get('layout-sample.lastSide')).toBe('left')
    expect(reveal).toHaveBeenCalledWith(VIEWS.detail)
  })

  it('rejects a ping without a valid side', async () => {
    const { invoke } = setup()

    expect(await invoke(CHANNELS.ping, { side: 'middle' })).toMatchObject({ ok: false, error: { code: 'HANDLER_ERROR' } })
    expect(await invoke(CHANNELS.ping)).toMatchObject({ ok: false })
  })

  it('serves the current state on request, so a late view can catch up', async () => {
    const { invoke } = setup()
    await invoke(CHANNELS.ping, { side: 'top' })
    await invoke(CHANNELS.ping, { side: 'right' })

    expect(await invoke(CHANNELS.state)).toMatchObject({ ok: true, data: { total: 2, last: { side: 'right' } } })
  })

  it('resets through IPC or the command, revealing the dashboard; the command follows the pings key', async () => {
    const { runtime, reveal, invoke } = setup()

    expect(runtime.commands.isEnabled(COMMANDS.reset)).toBe(false)       // nothing to reset yet
    await invoke(CHANNELS.ping, { side: 'bottom' })
    expect(runtime.commands.isEnabled(COMMANDS.reset)).toBe(true)

    await runtime.commands.execute(COMMANDS.reset)
    expect(reveal).toHaveBeenLastCalledWith(VIEWS.dashboard)
    expect(runtime.contextKeys.get('layout-sample.pings')).toBe(0)
    expect(runtime.commands.isEnabled(COMMANDS.reset)).toBe(false)

    await invoke(CHANNELS.ping, { side: 'bottom' })
    expect(await invoke(CHANNELS.reset)).toMatchObject({ ok: true, data: { total: 0 } })
  })

  it('works without the window manager (no reveal command registered)', async () => {
    const { invoke } = setup({ withWindowManager: false })

    expect(await invoke(CHANNELS.ping, { side: 'left' })).toMatchObject({ ok: true, data: { total: 1 } })
  })

  it('cleans up everything it registered on deactivation', async () => {
    const { runtime, scope, invoke } = setup()

    scope.dispose()

    expect(runtime.extensions.getContributions('shell.views')).toEqual([])
    expect(runtime.extensions.getContributions('shell.bar.items')).toEqual([])
    expect(runtime.commands.has(COMMANDS.reset)).toBe(false)
    expect(runtime.contextKeys.get('layout-sample.pings')).toBeUndefined()
    expect(await invoke(CHANNELS.state)).toMatchObject({ ok: false, error: { code: 'NO_HANDLER' } })
  })
})
