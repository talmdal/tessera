import { describe, it, expect, vi } from 'vitest'
import { PluginContext } from '../../core/plugins/PluginContext'
import { PluginManager } from '../../core/plugins/PluginManager'
import { MemoryPluginSource, createLogger, createRuntime, manifest } from '../helpers/runtime'

const plugin = (id: string, module: unknown, extra: Record<string, unknown> = {}) =>
  ({ location: `/plugins/${id}`, manifest: manifest(id, extra), module })

describe('PluginManager', () => {
  it('activates plugins with a scoped context', async () => {
    const runtime = createRuntime()
    const activate = vi.fn((context: PluginContext) => {
      context.commands.register('alpha.go', () => 'went')
    })
    const manager = new PluginManager(new MemoryPluginSource([plugin('alpha', { activate })]), runtime, createLogger())

    const active = await manager.activateAll()

    expect(active.map(m => m.id)).toEqual(['alpha'])
    expect(activate.mock.calls[0][0].pluginId).toBe('alpha')
    expect(runtime.commands.has('alpha.go')).toBe(true)
  })

  it('accepts a default-exported module object', async () => {
    const activate = vi.fn()
    const manager = new PluginManager(
      new MemoryPluginSource([plugin('alpha', { default: { activate } })]), createRuntime(), createLogger())

    await manager.activateAll()

    expect(activate).toHaveBeenCalledOnce()
  })

  it('isolates failures: bad manifests, missing activate and throwing plugins are skipped', async () => {
    const runtime = createRuntime()
    const log = createLogger()
    const source = new MemoryPluginSource([
      { location: '/plugins/bad', manifest: { id: 'Bad Id' }, module: {} },
      { location: '/plugins/shell', manifest: manifest('shell'), module: { activate: vi.fn() } },
      plugin('no-activate', {}),
      plugin('thrower', {
        activate: (context: PluginContext) => {
          context.commands.register('thrower.half', () => 1)
          throw new Error('nope')
        }
      }),
      plugin('good', { activate: vi.fn() })
    ])

    const active = await new PluginManager(source, runtime, log).activateAll()

    expect(active.map(m => m.id)).toEqual(['good'])
    expect(log.warn).toHaveBeenCalledTimes(2)
    expect(log.error).toHaveBeenCalledTimes(2)
    // Registrations from a failed activation are rolled back
    expect(runtime.commands.has('thrower.half')).toBe(false)
  })

  it('skips a second plugin with an id that is already active', async () => {
    const second = vi.fn()
    const source = new MemoryPluginSource([
      plugin('alpha', { activate: vi.fn() }),
      { ...plugin('alpha', { activate: second }), location: '/elsewhere/alpha' }
    ])

    await new PluginManager(source, createRuntime(), createLogger()).activateAll()

    expect(second).not.toHaveBeenCalled()
  })

  it('deactivates in reverse order, calling deactivate and removing registrations', async () => {
    const runtime = createRuntime()
    const order: string[] = []
    const make = (id: string) => ({
      activate: (context: PluginContext) => { context.subscriptions.push(context.ipc.register(`${id}:ping`, () => id)) },
      deactivate: () => { order.push(id) }
    })
    const manager = new PluginManager(
      new MemoryPluginSource([plugin('alpha', make('alpha')), plugin('beta', make('beta'))]), runtime, createLogger())

    await manager.activateAll()
    await manager.deactivateAll()

    expect(order).toEqual(['beta', 'alpha'])
    expect(runtime.ipc.has('alpha:ping')).toBe(false)
    expect(manager.activePlugins).toEqual([])
  })

  it('gives a plugin context.state when its manifest requires app.state, activating the store first', async () => {
    const runtime = createRuntime()
    const values = new Map<string, unknown>()
    const store = {
      get: async (key: string) => values.get(key), set: async (key: string, value: unknown) => { values.set(key, value) },
      update: async () => {}, remove: async () => {}
    }
    const remembered: unknown[] = []
    const source = new MemoryPluginSource([
      // Discovered before the store, but activated after it, because it requires it
      plugin('budget', { activate: async (context: PluginContext) => { await context.state.set('opened', true); remembered.push(await context.state.get('opened')) } },
        { services: { requires: ['app.state'] } }),
      plugin('app-state', { activate: (context: PluginContext) => { context.services.provide('app-state', 'app.state', store) } },
        { services: { provides: ['app.state'] } }),
      // Doesn't declare it: its use of state fails, and so does its activation, however the order falls
      plugin('careless', { activate: async (context: PluginContext) => { await context.state.set('x', 1) } })
    ])
    const log = createLogger()

    const active = await new PluginManager(source, runtime, log).activateAll()

    expect(active.map(m => m.id)).toEqual(['app-state', 'budget'])
    expect(remembered).toEqual([true])
    expect(values.get('budget.opened')).toBe(true)
    expect(log.error).toHaveBeenCalledWith('[plugins] Failed to activate "careless"', expect.objectContaining({
      message: expect.stringContaining('add it to services.requires')
    }))
  })
})

