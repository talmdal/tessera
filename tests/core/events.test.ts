import { describe, it, expect, vi } from 'vitest'
import { ContextKeyService } from '../../core/context/ContextKeyService'
import { ExtensionRegistry } from '../../core/extensions/ExtensionRegistry'
import { AppLifecycle } from '../../core/lifecycle/AppLifecycle'
import { EventHub } from '../../core/ipc/EventHub'
import { createPluginContext } from '../../core/plugins/PluginContext'
import { createLogger, createRuntime } from '../helpers/runtime'

describe('EventHub', () => {
  it('delivers published events to every subscriber until they dispose', () => {
    const hub = new EventHub()
    const a = vi.fn()
    const b = vi.fn()
    hub.subscribe(a)
    hub.subscribe(b).dispose()

    hub.publish('x:changed', { n: 1 })

    expect(a).toHaveBeenCalledWith({ name: 'x:changed', data: { n: 1 } })
    expect(b).not.toHaveBeenCalled()
  })

  it('isolates a failing subscriber', () => {
    const log = createLogger()
    const hub = new EventHub(log)
    const after = vi.fn()
    hub.subscribe(() => { throw new Error('boom') })
    hub.subscribe(after)

    hub.publish('x:changed')

    expect(after).toHaveBeenCalled()
    expect(log.error).toHaveBeenCalledOnce()
  })
})

describe('plugin events', () => {
  it('publishes under the plugin\'s own namespace', () => {
    const runtime = createRuntime()
    const seen = vi.fn()
    runtime.events.subscribe(seen)

    createPluginContext('vault', runtime).context.events.emit('opened', { path: 'a.tvault' })

    expect(seen).toHaveBeenCalledWith({ name: 'vault:opened', data: { path: 'a.tvault' } })
  })

  it('rejects names that would escape the namespace', () => {
    const { context } = createPluginContext('vault', createRuntime())

    expect(() => context.events.emit('shell:lifecycle.changed')).toThrow('invalid event name')
    expect(() => context.events.emit('')).toThrow('invalid event name')
  })
})

describe('change notifications', () => {
  it('AppLifecycle reports every phase change, including a vetoed shutdown returning', async () => {
    const lifecycle = new AppLifecycle()
    const phases: string[] = []
    lifecycle.onDidChangePhase(phase => phases.push(phase))
    lifecycle.onShuttingDown(event => event.veto())

    await lifecycle.markStarted()
    await lifecycle.requestShutdown()
    const retry = new AppLifecycle()
    retry.onDidChangePhase(phase => phases.push(`retry:${phase}`))
    await retry.markStarted()
    await retry.requestShutdown()
    await retry.markShutDown()

    expect(phases).toEqual(['started', 'shuttingDown', 'started', 'retry:started', 'retry:shuttingDown', 'retry:shutDown'])
  })

  it('AppLifecycle isolates a failing phase listener and lets one be removed', async () => {
    const log = createLogger()
    const lifecycle = new AppLifecycle({ log })
    const kept = vi.fn()
    const removed = vi.fn()
    lifecycle.onDidChangePhase(() => { throw new Error('boom') })
    lifecycle.onDidChangePhase(kept)
    lifecycle.onDidChangePhase(removed).dispose()

    await lifecycle.markStarted()

    expect(kept).toHaveBeenCalledWith('started')
    expect(removed).not.toHaveBeenCalled()
    expect(log.error).toHaveBeenCalledOnce()
  })

  it('ExtensionRegistry reports contributions being added and removed, once each', () => {
    const registry = new ExtensionRegistry()
    const changes: string[] = []
    registry.onDidChange(({ point }) => changes.push(point))

    const registration = registry.contribute('p', 'shell.views', 'p.view', {})
    registration.dispose()
    registration.dispose()

    expect(changes).toEqual(['shell.views', 'shell.views'])
  })

  it('ContextKeyService.snapshot returns a copy of all keys', () => {
    const keys = new ContextKeyService()
    keys.set('vault.isOpen', true)
    keys.set('vault.name', 'home')

    const snapshot = keys.snapshot()
    keys.set('vault.isOpen', false)

    expect(snapshot).toEqual({ 'vault.isOpen': true, 'vault.name': 'home' })
  })
})
