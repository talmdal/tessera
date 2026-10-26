// shared/views/resolveViews.ts
import type { ViewContribution, ViewDescriptor } from '@tessera/types'
import { parseWhen } from '../context/when'
import { isFileIcon, isValidIcon } from '../layout/icons'
import { ALL_SLOTS, isBarSlot } from './types'

export interface ContributedView {
  contributor: string
  impl: unknown
}

/** How plugin-relative resources resolve to URLs. Both return undefined when the plugin has no renderer. */
export interface ViewResources {
  /** URL of a plugin's federation remote entry. */
  remoteEntryFor(pluginId: string): string | undefined
  /** URL of a file in a plugin's renderer folder, from a "./…" path. */
  assetUrlFor(pluginId: string, relativePath: string): string | undefined
}

/**
 * Validates `shell.views` contributions and orders them by slot order.
 * Accepts the legacy `remoteEntryFor` function for convenience in tests.
 */
export function resolveViews(
  contributions: readonly ContributedView[],
  resources: ViewResources | ((pluginId: string) => string | undefined)
): { views: ViewDescriptor[], diagnostics: string[] } {
  const { remoteEntryFor, assetUrlFor }: ViewResources = typeof resources === 'function'
    ? { remoteEntryFor: resources, assetUrlFor: () => undefined }
    : resources

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

    let icon = view.icon
    if (icon && isFileIcon(icon)) {
      const url = assetUrlFor(contributor, icon.slice(2))
      if (!url) {
        diagnostics.push(`View "${view.id}" has icon "${icon}", which cannot be served from "${contributor}"`)
        return
      }
      icon = url
    }

    seen.add(view.id)
    resolved.push({
      view: {
        id: view.id, title: view.title, slot: view.slot, module: view.module,
        pluginId: contributor, remoteEntry,
        ...(icon === undefined ? {} : { icon }),
        ...(view.when === undefined ? {} : { when: view.when })
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
  if (!ALL_SLOTS.includes(v.slot)) return `View "${v.id}" targets unknown slot "${v.slot}"`
  if (!isString(v.module) || !v.module.startsWith('./')) return `View "${v.id}" must name an exposed module like "./MyView"`
  if (v.order !== undefined && (typeof v.order !== 'number' || !Number.isFinite(v.order))) return `View "${v.id}" has an invalid order`
  if (isBarSlot(v.slot) && v.icon === undefined) return `View "${v.id}" needs an icon: bar views are shown on the collapsed rail`
  if (v.icon !== undefined && !isValidIcon(v.icon)) return `View "${v.id}" has an invalid icon "${String(v.icon)}": use "./file.svg" or a shell icon name`
  if (v.when !== undefined) {
    if (!isString(v.when)) return `View "${v.id}" has an invalid when expression`
    try {
      parseWhen(v.when)
    } catch (err) {
      return `View "${v.id}" has an invalid when expression: ${err instanceof Error ? err.message : String(err)}`
    }
  }
}
