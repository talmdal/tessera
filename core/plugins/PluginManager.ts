// core/plugins/PluginManager.ts
import { PluginManifest, parseManifest, providedServices, requiredServices } from '../../shared/plugins/manifest'
import { PluginDescriptor, PluginOrigin, PluginSource } from '../ports'
import { planActivation } from './activationPlan'
import { createPluginContext } from './PluginContext'
import { Logger, PluginScope, PluginRuntime } from '@tessera/types'
import { PrivilegedPluginModule } from './types'

interface ActivePlugin {
  manifest: PluginManifest
  location: string
  origin?: PluginOrigin
  module: PrivilegedPluginModule
  scope: PluginScope
}

interface Candidate {
  descriptor: PluginDescriptor
  manifest: PluginManifest
}

const describe = (err: unknown) => err instanceof Error ? err.message : String(err)

export class PluginManager {
  private readonly active = new Map<string, ActivePlugin>()

  constructor(
    private readonly source: PluginSource,
    private readonly runtime: PluginRuntime,
    private readonly log: Logger
  ) {}

  get activePlugins(): PluginManifest[] {
    return [...this.active.values()].map(p => p.manifest)
  }

  /** Manifest, source location and origin of an active plugin. */
  get(id: string): { manifest: PluginManifest, location: string, origin?: PluginOrigin } | undefined {
    const plugin = this.active.get(id)
    return plugin && { manifest: plugin.manifest, location: plugin.location, origin: plugin.origin }
  }

  /**
   * Activates every discovered plugin, providers of a service before the
   * plugins that require it. A plugin that fails validation, dependency
   * resolution, loading or activation is logged and skipped; anything it
   * registered is rolled back.
   */
  async activateAll(): Promise<PluginManifest[]> {
    const candidates: PluginDescriptor[] = []

    for (const descriptor of await this.source.discover()) {
      let manifest: PluginManifest
      try {
        manifest = parseManifest(descriptor.manifest)
      } catch (err) {
        this.log.warn(`[plugins] Skipping ${descriptor.location}: ${describe(err)}`)
        continue
      }

      const existing = candidates.find(c => c.manifest.id === manifest.id)?.location
        ?? this.active.get(manifest.id)?.location
      if (existing) {
        this.log.warn(`[plugins] Skipping ${descriptor.location}: plugin "${manifest.id}" is already provided by ${existing}`)
        continue
      }
      candidates.push(descriptor)
    }

    const { order, skipped } = planActivation(candidates, id => this.runtime.services.has(id))
    for (const { candidate, reason } of skipped) {
      this.log.warn(`[plugins] Skipping "${candidate.manifest.id}": ${reason}`)
    }

    for (const descriptor of order) {
      // A provider that failed to activate leaves its dependents without the service.
      const manifest = descriptor.manifest
      const missing = requiredServices(manifest).find(service => !this.runtime.services.has(service))
      if (missing) {
        this.log.warn(`[plugins] Skipping "${manifest.id}": required service "${missing}" is not available`)
        continue
      }

      try {
        await this.activate(descriptor)
        this.log.info(`[plugins] Activated "${manifest.id}" ${manifest.version}`)
      } catch (err) {
        this.log.error(`[plugins] Failed to activate "${manifest.id}"`, err)
        continue
      }

      for (const service of providedServices(manifest)) {
         if (this.runtime.services.providerOf(service) !== manifest.id) {
          this.log.warn(`[plugins] "${manifest.id}" declares service "${service}" but did not provide it`)
        }
      }
    }

    return this.activePlugins
  }

  /** Deactivates a plugin, first deactivating any active plugin that requires a service it provides. */
  async deactivate(id: string) {
    const plugin = this.active.get(id)
    if (!plugin) return

    const provided = new Set(providedServices(plugin.manifest))
    for (const other of [...this.active.values()].reverse()) {
      if (other !== plugin && requiredServices(other.manifest).some(service => provided.has(service))) {
        await this.deactivate(other.manifest.id)
      }
    }

    this.active.delete(id)
    try {
      await plugin.module.deactivate?.()
    } catch (err) {
      this.log.error(`[plugins] Failed to deactivate "${id}"`, err)
    } finally {
      plugin.scope.dispose()
    }
  }

  async deactivateAll() {
    for (const id of [...this.active.keys()].reverse()) await this.deactivate(id)
  }

  private async activate(descriptor: PluginDescriptor) {
    const manifest = descriptor.manifest
    const module = toPrivilegedModule(await this.source.load(descriptor, manifest.privileged.entry))
    const scope = createPluginContext(manifest.id, this.runtime, { provides: providedServices(manifest) })

    try {
      await module.activate(scope.context)
    } catch (err) {
      scope.dispose()
      throw err
    }

    this.active.set(manifest.id, { manifest, location: descriptor.location, origin: descriptor.origin, module, scope })
  }
}

/** Accepts both `export function activate` and a default-exported module object. */
function toPrivilegedModule(loaded: unknown): PrivilegedPluginModule {
  const candidates = [loaded, (loaded as { default?: unknown } | null)?.default]
  const module = candidates.find(c =>
    typeof c === 'object' && c !== null && typeof (c as PrivilegedPluginModule).activate === 'function')

  if (!module) throw new Error('Privileged entry does not export an activate function')
  return module as PrivilegedPluginModule
}
