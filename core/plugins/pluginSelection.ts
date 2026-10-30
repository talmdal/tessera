// core/plugins/pluginSelection.ts
//
// Tier-0 (bootstrap) choices applied to the discovered plugins before
// activation is planned. This is configuration that shapes activation, so
// it cannot live in app.state or settings, which exist only after
// activation; the shell reads it from a plain file (see
// shell/main/bootstrap/bootstrapConfig.ts) and passes it here.
import { PluginManifest } from '../../shared/plugins/manifest'

export interface PluginSelection {
  /** Plugin ids that are not activated at all. */
  readonly disabledPlugins?: readonly string[]
  /**
   * Plugin ids moved to the front of the activation order, in this order.
   * Where two plugins provide the same service the first wins, so this is
   * how a storage backend (or any other contested provider) is chosen.
   */
  readonly preferredPlugins?: readonly string[]
}

export interface SelectionResult<T> {
  candidates: T[]
  skipped: { candidate: T, reason: string }[]
  /** Ids named in the selection that no discovered plugin has. */
  unknown: string[]
}

export function selectPlugins<T extends { manifest: PluginManifest }>(
  candidates: readonly T[],
  selection: PluginSelection = {}
): SelectionResult<T> {
  const disabled = new Set(selection.disabledPlugins ?? [])
  const preferred = selection.preferredPlugins ?? []
  const known = new Set(candidates.map(c => c.manifest.id))

  const skipped = candidates
    .filter(c => disabled.has(c.manifest.id))
    .map(candidate => ({ candidate, reason: 'disabled by the bootstrap configuration' }))
  const enabled = candidates.filter(c => !disabled.has(c.manifest.id))

  // Preferred first, in preference order; everything else keeps discovery order.
  const rank = new Map(preferred.map((id, i) => [id, i]))
  const first = enabled
    .filter(c => rank.has(c.manifest.id))
    .sort((a, b) => rank.get(a.manifest.id)! - rank.get(b.manifest.id)!)
  const rest = enabled.filter(c => !rank.has(c.manifest.id))

  const unknown = [...new Set([...disabled, ...preferred])].filter(id => !known.has(id))
  return { candidates: [...first, ...rest], skipped, unknown }
}
