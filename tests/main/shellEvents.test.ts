import { describe, it, expect, vi } from 'vitest'
import { EventHubImpl } from '../../core/ipc/EventHub'
import { createPluginContext } from '../../core/plugins/PluginContext'
import { forwardEventsToWindows } from '../../shell/main/events/forwardEvents'
import { registerShellEvents } from '../../shell/main/events/shellEvents'
import { createLogger, createRuntime } from '../helpers/runtime'

const fakeWindow = (destroyed = false, send: (...args: any[]) => unknown = vi.fn()) => ({ isDestroyed: () => destroyed, webContents: { send } })

describe('forwardEventsToWindows', () => {
  it('sends each event to every live window on the push channel', () => {
    const hub = new EventHubImpl()
    const open = fakeWindow()
    const closed = fakeWindow(true)
    forwardEventsToWindows(hub, () => [open, closed], createLogger())

    hub.publish('vault:opened', { n: 1 })

    expect(open.webContents.send).toHaveBeenCalledWith('tessera:event', { name: 'vault:opened', data: { n: 1 } })
    expect(closed.webContents.send).not.toHaveBeenCalled()
  })

  it('logs a payload Electron cannot send, and still reaches the other windows', () => {
    const hub = new EventHubImpl()
    const log = createLogger()
    const broken = fakeWindow(false, vi.fn(() => { throw new Error('could not be cloned') }))
    const fine = fakeWindow()
    forwardEventsToWindows(hub, () => [broken, fine], log)

    hub.publish('x:y', () => {})

    expect(log.error).toHaveBeenCalledOnce()
    expect(fine.webContents.send).toHaveBeenCalled()
  })

  it('stops forwarding when disposed', () => {
    const hub = new EventHubImpl()
    const win = fakeWindow()
    forwardEventsToWindows(hub, () => [win], createLogger()).dispose()

    hub.publish('x:y')

    expect(win.webContents.send).not.toHaveBeenCalled()
  })
})

describe('registerShellEvents', () => {
  function setup() {
    const runtime = createRuntime()
    const shell = createPluginContext('shell', runtime).context
    registerShellEvents(shell, runtime)
    const events: { name: string, data?: unknown }[] = []
    runtime.events.subscribe(event => events.push(event))
    return { runtime, events, request: (channel: string) => runtime.ipc.dispatch({ channel }) }
  }

  it('answers requests for the current phase and context keys', async () => {
    const { runtime, request } = setup()
    runtime.contextKeys.set('vault.isOpen', true)

    await expect(request('shell:lifecycle.get')).resolves.toMatchObject({ ok: true, data: 'starting' })
    await expect(request('shell:contextKeys.snapshot')).resolves.toMatchObject({ ok: true, data: { 'vault.isOpen': true } })
  })

  it('publishes each lifecycle phase change', async () => {
    const { runtime, events } = setup()

    await runtime.lifecycle.markStarted()
    await runtime.lifecycle.requestShutdown()

    expect(events).toEqual([
      { name: 'shell:lifecycle.changed', data: { phase: 'started' } },
      { name: 'shell:lifecycle.changed', data: { phase: 'shuttingDown' } }
    ])
  })

  it('publishes context key changes with null for removed keys', () => {
    const { runtime, events } = setup()

    runtime.contextKeys.set('vault.isOpen', true)
    runtime.contextKeys.set('vault.isOpen', undefined)
    createPluginContext('vault', runtime).context.contextKeys.set('vault.dirty', true)
    runtime.contextKeys.deleteNamespace('vault')

    expect(events.map(e => e.data)).toEqual([
      { 'vault.isOpen': true },
      { 'vault.isOpen': null },
      { 'vault.dirty': true },
      { 'vault.dirty': null }
    ])
  })

  it('announces view changes, and only for the views extension point', () => {
    const { runtime, events } = setup()

    const registration = runtime.extensions.contribute('p', 'shell.menus', 'p.menu', {})
    expect(events).toEqual([])

    runtime.extensions.contribute('p', 'shell.views', 'p.view', {})
    registration.dispose()

    expect(events).toEqual([{ name: 'shell:views.changed', data: undefined }])
  })
})
