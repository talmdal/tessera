import { describe, it, expect } from 'vitest'
import { PluginManager } from '../../core/plugins/PluginManager'
import { createLogger, createRuntime, manifest, MemoryPluginSource } from '../helpers/runtime'

/** Plugins that provide a service record that they ran. */
function setup(selection: ConstructorParameters<typeof PluginManager>[3]) {
  const activated: string[] = []
  const plugin = (id: string, extra: Record<string, unknown> = {}) => ({
    location: `/${id}`,
    manifest: manifest(id, extra),
    module: { activate: (context: any) => {
      activated.push(id)
      for (const service of (extra.services as any)?.provides ?? []) context.services.provide(id, service, {})
    } }
  })
  const log = createLogger()
  const source = new MemoryPluginSource([
    plugin('loki', { services: { provides: ['storage.engine'] } }),
    plugin('sqlite', { services: { provides: ['storage.engine'] } }),
    plugin('state', { services: { requires: ['storage.engine'] } }),
    plugin('other')
  ])
  return { activated, log, manager: new PluginManager(source, createRuntime(), log, selection) }
}

describe('plugin selection from the bootstrap configuration', () => {
  it('activates in discovery order, the first provider of a contested service winning, by default', async () => {
    const { activated, log, manager } = setup(undefined)
    await manager.activateAll()
    expect(activated).toEqual(['loki', 'state', 'other'])
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('"sqlite"'))
  })

  it('lets a preferred plugin win a contested service', async () => {
    const { activated, log, manager } = setup({ preferred: ['sqlite'] })
    await manager.activateAll()
    expect(activated).toEqual(['sqlite', 'state', 'other'])
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('"loki"'))
  })

  it('orders several preferred plugins as listed, leaving the rest in discovery order', async () => {
    const { activated, manager } = setup({ preferred: ['other', 'sqlite'] })
    await manager.activateAll()
    expect(activated).toEqual(['other', 'sqlite', 'state'])
  })

  it('leaves out disabled plugins, and anything that needed them', async () => {
    const { activated, log, manager } = setup({ disabled: ['loki', 'sqlite'] })
    await manager.activateAll()
    expect(activated).toEqual(['other'])
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('"state"'))
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('"loki" is disabled'))
  })

  it('lets the other provider through when one is disabled', async () => {
    const { activated, manager } = setup({ disabled: ['loki'] })
    await manager.activateAll()
    expect(activated).toEqual(['sqlite', 'state', 'other'])
  })

  it('disabled wins over preferred', async () => {
    const { activated, manager } = setup({ disabled: ['sqlite'], preferred: ['sqlite'] })
    await manager.activateAll()
    expect(activated).toEqual(['loki', 'state', 'other'])
  })

  it('warns about a named plugin that is not installed, and carries on', async () => {
    const { activated, log, manager } = setup({ preferred: ['ghost'], disabled: ['phantom'] })
    await manager.activateAll()
    expect(activated).toEqual(['loki', 'state', 'other'])
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('"ghost"'))
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('"phantom"'))
  })
})
