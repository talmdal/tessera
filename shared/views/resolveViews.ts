// shared/views/resolveViews.ts
import { parseWhen } from '../context/when'
import { resolveIcon } from '../layout/icons'
import { MAIN_SLOT, SLOTS, ViewContribution, ViewDescriptor } from './types'

export interface ContributedView {
  contributor: string
  impl: unknown
}

/**
 * Validates `shell.views` contributions and orders them by slot order.
 * `remoteEntryFor` returns the renderer remote entry URL of a plugin, or
 * undefined when the plugin has no renderer. `iconUrlFor` turns a file in a
 * plugin's renderer folder into a URL; without it, file icons are rejected.
 */
export function resolveViews(
  contributions: readonly ContributedView[],
  remoteEntryFor: (pluginId: string) => string | undefined,
  iconUrlFor?: (pluginId: string, relativePath: string) => string | undefined
): { views: ViewDescriptor[], diagnostics: string[] } {
  const diagnostics: string[] = []
  const seen = new Set<string>()
  const resolved: { view: ViewDescriptor, order: number, seq: number }[] = []

  contributions.forEach(({ contributor, impl }, seq) => {
    const problem = validate(impl)
    if (problem) {
      diagnostics.push(problem)
      return
    }

    const view = impl as ViewContribution
    if (seen.has(view.id)) {
      diagnostics.push(`Duplicate view id "${view.id}" ignored`)
      return
    }

    const remoteEntry = remoteEntryFor(contributor)
    if (!remoteEntry) {
      diagnostics.push(`View "${view.id}" ignored: "${contributor}" has no renderer entry`)
      return
    }

    let icon: string | undefined
    if (view.icon !== undefined) {
      const result = resolveIcon(view.icon, contributor, iconUrlFor)
      if ('problem' in result) {
        diagnostics.push(`View "${view.id}" ignored: ${result.problem}`)
        return
      }
      icon = result.icon
    }

    seen.add(view.id)
    resolved.push({
      view: {
        id: view.id, title: view.title, slot: view.slot, module: view.module, pluginId: contributor, remoteEntry,
        ...(icon !== undefined && { icon }),
        ...(view.when !== undefined && { when: view.when })
      },
      order: view.order ?? 0,
      seq
    })
  })

  const views = resolved
    .sort((a, b) => a.order - b.order || a.seq - b.seq)
    .map(r => r.view)

  return { views, diagnostics }
}

function validate(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null) return 'View contribution is not an object'

  const v = raw as Record<string, unknown>
  const isString = (x: unknown): x is string => typeof x === 'string' && x.length > 0

  if (!isString(v.id)) return 'View contribution is missing an id'
  if (!isString(v.title)) return `View "${v.id}" is missing a title`
  if (!isString(v.slot)) return `View "${v.id}" is missing a slot`
  if (!SLOTS.includes(v.slot)) return `View "${v.id}" targets unknown slot "${v.slot}"`
  if (!isString(v.module) || !v.module.startsWith('./')) return `View "${v.id}" must name an exposed module like "./MyView"`
  if (v.icon !== undefined && !isString(v.icon)) return `View "${v.id}" has an invalid icon`
  if (v.icon === undefined && v.slot !== MAIN_SLOT) return `View "${v.id}" in ${v.slot} needs an icon, for the rail of a collapsed bar`
  if (v.order !== undefined && (typeof v.order !== 'number' || !Number.isFinite(v.order))) return `View "${v.id}" has an invalid order`

  if (v.when !== undefined) {
    if (!isString(v.when)) return `View "${v.id}" has an invalid when expression`
    try {
      parseWhen(v.when)
    } catch (err) {
      return `View "${v.id}" has an invalid when expression: ${err instanceof Error ? err.message : String(err)}`
    }
  }
}
