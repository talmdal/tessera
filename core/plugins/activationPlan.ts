// core/plugins/activationPlan.ts
import { PluginManifest, providedServices, requiredServices } from '../../shared/plugins/manifest'

export interface ActivationPlan<T> {
  /** Plugins to activate, providers before the plugins that require them. */
  order: T[]
  skipped: { candidate: T, reason: string }[]
}

/**
 * Orders plugins by their declared service dependencies. Discovery order is
 * kept wherever dependencies allow. A plugin is skipped when:
 * - a service it provides is already provided (by the shell or an earlier plugin)
 * - a service it requires has no provider, or its provider was skipped
 * - it is part of, or depends on, a dependency cycle
 *
 * `isAvailable` reports services that are already registered, e.g. by the shell.
 */
export function planActivation<T extends { manifest: PluginManifest }>(
  candidates: readonly T[],
  isAvailable: (serviceId: string) => boolean
): ActivationPlan<T> {
  const skipped = new Map<T, string>()
  const providerOf = new Map<string, T>()

  for (const candidate of candidates) {
    const provides = providedServices(candidate.manifest)
    const conflict = provides
      .map(service => {
        if (isAvailable(service)) return `service "${service}" is already provided by the shell`
        const other = providerOf.get(service)
        if (other) return `service "${service}" is also provided by "${other.manifest.id}"`
      })
      .find(Boolean)

    if (conflict) skipped.set(candidate, conflict)
    else for (const service of provides) providerOf.set(service, candidate)
  }

  // Skipping a provider can strand its dependents, so repeat until nothing changes.
  for (let changed = true; changed;) {
    changed = false
    for (const candidate of candidates) {
      if (skipped.has(candidate)) continue
      for (const service of requiredServices(candidate.manifest)) {
        if (isAvailable(service)) continue
        const provider = providerOf.get(service)
        if (provider === candidate) continue
        const reason = !provider
          ? `requires service "${service}", which no plugin provides`
          : skipped.has(provider) ? `requires service "${service}", but its provider "${provider.manifest.id}" was skipped` : undefined
        if (reason) {
          skipped.set(candidate, reason)
          changed = true
          break
        }
      }
    }
  }

  const dependencies = (candidate: T) => requiredServices(candidate.manifest)
    .map(service => isAvailable(service) ? undefined : providerOf.get(service))
    .filter((provider): provider is T => provider !== undefined && provider !== candidate)

  const remaining = candidates.filter(c => !skipped.has(c))
  const placed = new Set<T>()
  const order: T[] = []

  while (remaining.length > 0) {
    const index = remaining.findIndex(c => dependencies(c).every(d => placed.has(d)))
    if (index === -1) {
      const ids = remaining.map(c => c.manifest.id).join(', ')
      for (const candidate of remaining) skipped.set(candidate, `has a circular service dependency (among: ${ids})`)
      break
    }
    const [next] = remaining.splice(index, 1)
    placed.add(next)
    order.push(next)
  }

  return {
    order,
    skipped: candidates.filter(c => skipped.has(c)).map(candidate => ({ candidate, reason: skipped.get(candidate)! }))
  }
}
