import { describe, it, expect, vi, afterEach } from 'vitest'
import { AppLifecycleImpl } from '../../core/lifecycle/AppLifecycle'
import { shutdownApp } from '../../core/lifecycle/shutdown'
import { PluginContext, createPluginContext } from '../../core/plugins/PluginContext'
import { PluginManager } from '../../core/plugins/PluginManager'
import { MemoryPluginSource, createLogger, createRuntime, manifest } from '../helpers/runtime'

afterEach(() => { vi.useRealTimers() })

describe('AppLifecycle', () => {
  it('moves through the phases', async () => {
    const lifecycle = new AppLifecycleImpl()
    const phases = [lifecycle.phase]

    await lifecycle.markStarted(); phases.push(lifecycle.phase)
    await lifecycle.requestShutdown(); phases.push(lifecycle.phase)
    await lifecycle.markShutDown(); phases.push(lifecycle.phase)

    expect(phases).toEqual(['starting', 'started', 'shuttingDown', 'shutDown'])
  })

  it('runs onStarted listeners once started, and immediately for late subscribers', async () => {
    const lifecycle = new AppLifecycleImpl()
    const early = vi.fn()
    lifecycle.onStarted(early)
    expect(early).not.toHaveBeenCalled()

    await lifecycle.markStarted()
    await lifecycle.markStarted()
    const late = vi.fn()
    lifecycle.onStarted(late)

    expect(early).toHaveBeenCalledTimes(1)
    expect(late).toHaveBeenCalledTimes(1)
  })

  it('isolates failing listeners and lets a disposed listener go', async () => {
    const log = createLogger()
    const lifecycle = new AppLifecycleImpl({ log })
    const after = vi.fn()
    const removed = vi.fn()
    lifecycle.onStarted(() => { throw new Error('boom') })
    lifecycle.onStarted(async () => { throw new Error('async boom') })
    lifecycle.onStarted(after)
    lifecycle.onStarted(removed).dispose()

    await lifecycle.markStarted()

    expect(after).toHaveBeenCalled()
    expect(removed).not.toHaveBeenCalled()
    expect(log.error).toHaveBeenCalledTimes(2)
  })

  it('runs ShuttingDown listeners one at a time, in registration order, then allows shutdown', async () => {
    const lifecycle = new AppLifecycleImpl()
    const order: string[] = []
    lifecycle.onShuttingDown(async () => { order.push('a:start'); await Promise.resolve(); order.push('a:end') })
    lifecycle.onShuttingDown(() => { order.push('b') })

    expect(await lifecycle.requestShutdown()).toBe(true)
    expect(order).toEqual(['a:start', 'a:end', 'b'])
  })

  it('lets a listener veto a user shutdown, skips later listeners, and returns to the previous phase', async () => {
    const lifecycle = new AppLifecycleImpl({ log: createLogger() })
    const later = vi.fn()
    await lifecycle.markStarted()
    lifecycle.onShuttingDown(event => event.veto('unsaved changes'))
    lifecycle.onShuttingDown(later)

    expect(await lifecycle.requestShutdown('user')).toBe(false)
    expect(later).not.toHaveBeenCalled()
    expect(lifecycle.phase).toBe('started')
  })

  it('ignores a veto of a system shutdown', async () => {
    const log = createLogger()
    const lifecycle = new AppLifecycleImpl({ log })
    lifecycle.onShuttingDown(event => event.veto())

    expect(await lifecycle.requestShutdown('system')).toBe(true)
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('cannot be refused'))
  })

  it('carries on after the time limit, and ignores a veto that arrives late', async () => {
    vi.useFakeTimers()
    const log = createLogger()
    const lifecycle = new AppLifecycleImpl({ log, shutdownTimeoutMs: 1000 })
    lifecycle.onShuttingDown(event => new Promise<void>(resolve => setTimeout(() => { event.veto(); resolve() }, 5000)))

    const result = lifecycle.requestShutdown()
    await vi.advanceTimersByTimeAsync(1000)

    await expect(result).resolves.toBe(true)
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('exceeded 1000 ms'))
    await vi.advanceTimersByTimeAsync(5000)
    expect(lifecycle.phase).toBe('shuttingDown')
  })

  it('shares one run between concurrent requests, and a vetoed request can be retried', async () => {
    const lifecycle = new AppLifecycleImpl()
    let calls = 0
    lifecycle.onShuttingDown(event => { if (++calls === 1) event.veto() })

    const [first, second] = await Promise.all([lifecycle.requestShutdown(), lifecycle.requestShutdown()])
    expect([first, second, calls]).toEqual([false, false, 1])

    expect(await lifecycle.requestShutdown()).toBe(true)
    expect(calls).toBe(2)
  })

  it('runs onShutDown listeners last, once, and survives their errors', async () => {
    const log = createLogger()
    const lifecycle = new AppLifecycleImpl({ log })
    const flush = vi.fn()
    lifecycle.onShutDown(() => { throw new Error('flush failed') })
    lifecycle.onShutDown(flush)

    await lifecycle.requestShutdown()
    await lifecycle.markShutDown()
    await lifecycle.markShutDown()

    expect(flush).toHaveBeenCalledTimes(1)
    expect(log.error).toHaveBeenCalledTimes(1)
    expect(await lifecycle.requestShutdown()).toBe(true)
  })
})

describe('plugins and the application lifecycle', () => {
  const entry = (id: string, module: object, services: object = {}) =>
    ({ location: `/plugins/${id}`, manifest: manifest(id, { services }), module })

  it('runs plugin onStarted after every plugin has activated', async () => {
    const events: string[] = []
    const runtime = createRuntime()
    const source = new MemoryPluginSource([
      entry('alpha', { activate: (c: PluginContext) => { c.lifecycle.onStarted(() => { events.push('alpha started') }); events.push('alpha activated') } }),
      entry('beta', { activate: () => { events.push('beta activated') } })
    ])

    await new PluginManager(source, runtime, createLogger()).activateAll()
    expect(events).toEqual(['alpha activated', 'beta activated'])

    await runtime.lifecycle.markStarted()
    expect(events).toEqual(['alpha activated', 'beta activated', 'alpha started'])
  })

  it('shuts down in order: ShuttingDown listeners, deactivation (dependents first), ShutDown', async () => {
    const events: string[] = []
    const runtime = createRuntime()
    const source = new MemoryPluginSource([
      entry('vault', {
        activate: (c: PluginContext) => {
          c.subscriptions.push(c.services.provide('vault', 'vault.store', {}))
          c.lifecycle.onShuttingDown(() => { events.push('vault: shutting down') })
        },
        deactivate: () => { events.push('vault: deactivate') }
      }, { provides: ['vault.store'] }),
      entry('reports', { activate: () => {}, deactivate: () => { events.push('reports: deactivate') } }, { requires: ['vault.store'] })
    ])
    const manager = new PluginManager(source, runtime, createLogger())
    await manager.activateAll()
    runtime.lifecycle.onShutDown(() => { events.push('shut down') })

    expect(await shutdownApp(runtime.lifecycle, manager)).toBe(true)

    expect(events).toEqual(['vault: shutting down', 'reports: deactivate', 'vault: deactivate', 'shut down'])
    expect(manager.activePlugins).toEqual([])
  })

  it('leaves every plugin running when a plugin vetoes the quit', async () => {
    const runtime = createRuntime()
    const deactivate = vi.fn()
    const source = new MemoryPluginSource([
      entry('vault', {
        activate: (c: PluginContext) => { c.lifecycle.onShuttingDown(event => event.veto('unsaved vault')) },
        deactivate
      })
    ])
    const manager = new PluginManager(source, runtime, createLogger())
    await manager.activateAll()

    expect(await shutdownApp(runtime.lifecycle, manager)).toBe(false)

    expect(deactivate).not.toHaveBeenCalled()
    expect(manager.activePlugins.map(m => m.id)).toEqual(['vault'])
    expect(runtime.lifecycle.phase).toBe('starting')   // never marked started in this test, so it returns to where it was
  })

  it('removes a plugin\'s listeners when it deactivates, and exposes the phase', async () => {
    const runtime = createRuntime()
    const scope = createPluginContext('alpha', runtime)
    const listener = vi.fn()
    scope.context.subscriptions.push(scope.context.lifecycle.onShuttingDown(listener))
    expect(scope.context.lifecycle.phase).toBe('starting')

    scope.dispose()
    await runtime.lifecycle.requestShutdown()

    expect(listener).not.toHaveBeenCalled()
  })
})
