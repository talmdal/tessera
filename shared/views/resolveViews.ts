// shared/views/resolveViews.ts
import { ViewContribution, ViewDescriptor } from './types'

export interface ContributedView {
  contributor: string
  impl: unknown
}

/**
 * Validates `shell.views` contributions and orders them by slot order.
 * `remoteEntryFor` returns the renderer remote entry URL of a plugin, or
 * undefined when the plugin has no renderer.
 */
export function resolveViews(
  contributions: readonly ContributedView[],
  remoteEntryFor: (pluginId: string) => string | undefined
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

    seen.add(view.id)
    resolved.push({
      view: { id: view.id, title: view.title, slot: view.slot, module: view.module, pluginId: contributor, remoteEntry },
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
  if (!isString(v.module) || !v.module.startsWith('./')) return `View "${v.id}" must name an exposed module like "./MyView"`
  if (v.order !== undefined && (typeof v.order !== 'number' || !Number.isFinite(v.order))) return `View "${v.id}" has an invalid order`
}
