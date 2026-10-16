import { describe, it, expect, vi } from 'vitest'
import { PluginContext, createPluginContext } from '../../core/plugins/PluginContext'
import { PluginManager } from '../../core/plugins/PluginManager'
import { ServiceRegistry } from '../../core/services/ServiceRegistry'
import { parseManifest } from '../../shared/plugins/manifest'
import { MemoryPluginSource, createLogger, createRuntime, manifest } from '../helpers/runtime'

describe('ServiceRegistry', () => {
  it('provides, looks up and removes a service', () => {
    const registry = new ServiceRegistry()
    const store = { open: () => 'opened' }

    const registration = registry.provide('vault', 'vault.store', store)
    expect(registry.get<typeof store>('vault.store').open()).toBe('opened')
    expect(registry.providerOf('vault.store')).toBe('vault')

    registration.dispose()
    expect(registry.has('vault.store')).toBe(false)
    expect(() => registry.get('vault.store')).toThrow('Service not available: vault.store')
  })

  it('allows one provider per service and rejects non-objects', () => {
    const registry = new ServiceRegistry()
    registry.provide('sqlite', 'vault.store', {})

    expect(() => registry.provide('files', 'vault.store', {})).toThrow('Service "vault.store" is already provided by "sqlite"')
    expect(() => registry.provide('x', 'x.value', 42)).toThrow('must be an object or function')
    expect(() => registry.provide('x', 'x.null', null)).toThrow('must be an object or function')
  })
})

describe('plugin context services', () => {
  it('only lets a plugin provide services declared in its manifest', () => {
    const runtime = createRuntime()
    const { context } = createPluginContext('sqlite', runtime, { provides: ['vault.store'] })

    expect(() => context.services.provide('vault.store', {})).not.toThrow()
    expect(() => context.services.provide('vault.other', {})).toThrow(`declare it in the manifest's services.provides`)
  })

  it('removes provided services on deactivation', () => {
    const runtime = createRuntime()
    const scope = createPluginContext('sqlite', runtime, { provides: ['vault.store'] })
    scope.context.services.provide('vault.store', {})

    scope.dispose()

    expect(runtime.services.has('vault.store')).toBe(false)
  })
})

describe('PluginManager with services', () => {
  const entry = (id: string, services: object, module: object) =>
    ({ location: `/plugins/${id}`, manifest: manifest(id, { services }), module })

  it('activates providers first so required services are available in activate', async () => {
    const log = createLogger()
    const seen: unknown[] = []
    const source = new MemoryPluginSource([
      entry('reports', { requires: ['vault.store'] }, {
        activate: (context: PluginContext) => {
          seen.push(context.services.get<{ name: string }>('vault.store').name)
        }
      }),
      entry('vault', { provides: ['vault.store'] }, {
        activate: (context: PluginContext) => { context.services.provide('vault.store', { name: 'sqlite store' }) }
      })
    ])

    const active = await new PluginManager(source, createRuntime(), log).activateAll()

    expect(active.map(m => m.id)).toEqual(['vault', 'reports'])
    expect(seen).toEqual(['sqlite store'])
  })

  it('skips dependents when the provider fails to activate', async () => {
    const log = createLogger()
    const dependent = vi.fn()
    const source = new MemoryPluginSource([
      entry('vault', { provides: ['vault.store'] }, { activate: () => { throw new Error('disk on fire') } }),
      entry('reports', { requires: ['vault.store'] }, { activate: dependent })
    ])

    const active = await new PluginManager(source, createRuntime(), log).activateAll()

    expect(active).toEqual([])
    expect(dependent).not.toHaveBeenCalled()
    expect(log.warn).toHaveBeenCalledWith('[plugins] Skipping "reports": required service "vault.store" is not available')
  })

  it('logs dependency problems found before activation', async () => {
    const log = createLogger()
    const source = new MemoryPluginSource([entry('reports', { requires: ['vault.store'] }, { activate: vi.fn() })])

    await new PluginManager(source, createRuntime(), log).activateAll()

    expect(log.warn).toHaveBeenCalledWith('[plugins] Skipping "reports": requires service "vault.store", which no plugin provides')
  })

  it('warns when a plugin declares a service but does not provide it', async () => {
    const log = createLogger()
    const source = new MemoryPluginSource([entry('vault', { provides: ['vault.store'] }, { activate: vi.fn() })])

    await new PluginManager(source, createRuntime(), log).activateAll()

    expect(log.warn).toHaveBeenCalledWith('[plugins] "vault" declares service "vault.store" but did not provide it')
  })

  it('deactivates dependents before the provider of their services', async () => {
    const order: string[] = []
    const source = new MemoryPluginSource([
      entry('vault', { provides: ['vault.store'] }, {
        activate: (context: PluginContext) => { context.services.provide('vault.store', {}) },
        deactivate: () => { order.push('vault') }
      }),
      entry('reports', { requires: ['vault.store'] }, { activate: vi.fn(), deactivate: () => { order.push('reports') } }),
      entry('budget', {}, { activate: vi.fn(), deactivate: () => { order.push('budget') } })
    ])
    const runtime = createRuntime()
    const manager = new PluginManager(source, runtime, createLogger())
    await manager.activateAll()

    await manager.deactivate('vault')

    expect(order).toEqual(['reports', 'vault'])
    expect(manager.activePlugins.map(m => m.id)).toEqual(['budget'])
    expect(runtime.services.has('vault.store')).toBe(false)
  })
})

describe('manifest services section', () => {
  const base = { id: 'vault', name: 'Vault', version: '1', privileged: { entry: 'i.js' } }

  it('accepts provides and requires lists of dotted service ids', () => {
    expect(() => parseManifest({ ...base, services: { provides: ['vault.store'], requires: ['crypto.cipher', 'shell.dialogs'] } })).not.toThrow()
  })

  it('rejects malformed services sections', () => {
    expect(() => parseManifest({ ...base, services: [] })).toThrow('invalid services section')
    expect(() => parseManifest({ ...base, services: { provides: 'vault.store' } })).toThrow('services.provides must be an array')
    expect(() => parseManifest({ ...base, services: { requires: ['store'] } })).toThrow('invalid service id "store"')
    expect(() => parseManifest({ ...base, services: { requires: [''] } })).toThrow('invalid service id ""')
  })
})
