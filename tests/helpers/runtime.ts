// tests/helpers/runtime.ts
import { PluginRuntime, createPluginRuntime } from '../../core/plugins/PluginContext'
import { Logger, PluginDescriptor, PluginSource } from '../../core/ports'

export function createRuntime(): PluginRuntime {
  return createPluginRuntime()
}

export function createLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() } satisfies Logger
}

export function manifest(id: string, extra: Record<string, unknown> = {}) {
  return { id, name: id, version: '1.0.0', privileged: { entry: 'index.js' }, ...extra }
}

/** In-memory PluginSource: maps plugin location to the module its entry exports. */
export class MemoryPluginSource implements PluginSource {
  constructor(private readonly plugins: { location: string, manifest: unknown, module: unknown }[]) {}

  async discover(): Promise<PluginDescriptor[]> {
    return this.plugins.map(({ location, manifest }) => ({ location, manifest }))
  }

  async load(descriptor: PluginDescriptor) {
    return this.plugins.find(p => p.location === descriptor.location)!.module
  }
}
