import { describe, it, expect, vi } from 'vitest'
import { selectPlugins } from '../../core/plugins/pluginSelection'
import { PluginManager } from '../../core/plugins/PluginManager'
import { MemoryPluginSource, createLogger, createRuntime, manifest } from '../helpers/runtime'

const candidate = (id: string, extra: Record<string, unknown> = {}) => ({ manifest: manifest(id, extra) })
const ids = (list: { manifest: { id: string } }[]) => list.map(c => c.manifest.id)

describe('selectPlugins', () => {
  const discovered = [candidate('a'), candidate('b'), candidate('c'), candidate('d')]

  it('keeps discovery order with no selection', () => {
    const result = selectPlugins(discovered)
    expect(ids(result.candidates)).toEqual(['a', 'b', 'c', 'd'])
    expect(result.skipped).toEqual([])
    expect(result.unknown).toEqual([])
  })

  it('leaves disabled plugins out, with a reason', () => {
    const result = selectPlugins(discovered, { disabledPlugins: ['b', 'd'] })
    expect(ids(result.candidates)).toEqual(['a', 'c'])
    expect(result.skipped.map(s => [s.candidate.manifest.id, s.reason])).toEqual([
      ['b', 'disabled by the bootstrap configuration'],
      ['d', 'disabled by the bootstrap configuration']
    ])
  })

  it('moves preferred plugins to the front, in preference order', () => {
    expect(ids(selectPlugins(discovered, { preferredPlugins: ['d', 'b'] }).candidates)).toEqual(['d', 'b', 'a', 'c'])
  })

  it('disabling beats preferring, and reports ids that match nothing', () => {
    const result = selectPlugins(discovered, { disabledPlugins: ['b', 'ghost'], preferredPlugins: ['b', 'phantom', 'c'] })
    expect(ids(result.candidates)).toEqual(['c', 'a', 'd'])
    expect(result.unknown).toEqual(['ghost', 'phantom'])
  })
})

describe('PluginManager with a bootstrap selection', () => {
  const provider = (id: string) => ({
    location: `/plugins/${id}`,
    manifest: manifest(id, { services: { provides: ['storage.engine'] } }),
    module: { activate: vi.fn((context: any) => { context.services.provide(id, 'storage.engine', { id }) }) }
  })

  it('lets a preferred plugin win a contested service', async () => {
    const runtime = createRuntime()
    const log = createLogger()
    const source = new MemoryPluginSource([provider('storage-loki'), provider('storage-sqlite')])

    await new PluginManager(source, runtime, log, { preferredPlugins: ['storage-sqlite'] }).activateAll()

    expect(runtime.services.providerOf('storage.engine')).toBe('storage-sqlite')
    expect(log.warn.mock.calls.map(c => c[0])).toEqual([
      '[plugins] Skipping "storage-loki": service "storage.engine" is also provided by "storage-sqlite"'
    ])
  })

  it('does not activate a disabled plugin, and says why without a warning', async () => {
    const runtime = createRuntime()
    const log = createLogger()
    const source = new MemoryPluginSource([provider('storage-loki'), provider('storage-sqlite')])

    const active = await new PluginManager(source, runtime, log, { disabledPlugins: ['storage-loki'] }).activateAll()

    expect(active.map(m => m.id)).toEqual(['storage-sqlite'])
    expect(runtime.services.providerOf('storage.engine')).toBe('storage-sqlite')
    expect(log.warn).not.toHaveBeenCalled()
    expect(log.info.mock.calls.map(c => c[0])).toContain('[plugins] Skipping "storage-loki": disabled by the bootstrap configuration')
  })

  it('warns about ids in the selection that are not installed', async () => {
    const log = createLogger()
    await new PluginManager(new MemoryPluginSource([provider('storage-loki')]), createRuntime(), log, { disabledPlugins: ['nope'] }).activateAll()
    expect(log.warn.mock.calls[0][0]).toContain('"nope", which is not an installed plugin')
  })
})
