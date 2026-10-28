// shared/layout/resolveBarItems.ts
import type { BorderItemContribution, BorderItemInfo } from '@tessera/types'
import { parseWhen } from '../context/when'
import { BOTTOM_SLOT, LEFT_SLOT, RIGHT_SLOT, TOP_SLOT } from '../views/types'
import { resolveIcon } from './icons'

export interface ContributedBarItem {
  contributor: string
  impl: unknown
}

const BAR_ITEM_SLOTS: readonly string[] = [TOP_SLOT, BOTTOM_SLOT, LEFT_SLOT, RIGHT_SLOT]

/**
 * Validates `shell.bar.items` contributions and orders them by `order`, then
 * registration. Invalid ones are skipped and described in `diagnostics`.
 * `iconUrlFor` turns a file in a plugin's renderer folder into a URL; without
 * it, file icons are rejected.
 */
export function resolveBarItems(
  contributions: readonly ContributedBarItem[],
  iconUrlFor?: (pluginId: string, relativePath: string) => string | undefined
): { items: BorderItemInfo[], diagnostics: string[] } {
  const diagnostics: string[] = []
  const seen = new Set<string>()
  const resolved: { item: BorderItemInfo, order: number, seq: number }[] = []

  contributions.forEach(({ contributor, impl }, seq) => {
    const problem = validate(impl)
    if (problem) {
      diagnostics.push(problem)
      return
    }

    const item = impl as BorderItemContribution
    if (seen.has(item.id)) {
      diagnostics.push(`Duplicate bar item id "${item.id}" ignored`)
      return
    }

    let icon: string | undefined
    if (item.icon !== undefined) {
      const result = resolveIcon(item.icon, contributor, iconUrlFor)
      if ('problem' in result) {
        diagnostics.push(`Bar item "${item.id}" ignored: ${result.problem}`)
        return
      }
      icon = result.icon
    }

    seen.add(item.id)
    resolved.push({
      item: { ...item, ...(icon !== undefined && { icon }), pluginId: contributor },
      order: item.order ?? 0,
      seq
    })
  })

  const items = resolved.sort((a, b) => a.order - b.order || a.seq - b.seq).map(r => r.item)
  return { items, diagnostics }
}

function validate(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null) return 'Bar item contribution is not an object'

  const i = raw as Record<string, unknown>
  const isString = (x: unknown): x is string => typeof x === 'string' && x.length > 0

  if (!isString(i.id)) return 'Bar item contribution is missing an id'
  const id = i.id
  if (!isString(i.slot) || !BAR_ITEM_SLOTS.includes(i.slot)) return `Bar item "${id}" must target a bar slot, not "${String(i.slot)}"`

  if (i.kind === 'button') {
    if (!isString(i.label)) return `Bar item "${id}" is missing a label`
    if (!isString(i.command)) return `Bar item "${id}" is missing a command`
  } else if (i.kind === 'text') {
    if (!isString(i.text)) return `Bar item "${id}" is missing its text`
    if (i.command !== undefined && !isString(i.command)) return `Bar item "${id}" has an invalid command`
  } else {
    return `Bar item "${id}" has unknown kind "${String(i.kind)}"`
  }

  if (i.icon !== undefined && !isString(i.icon)) return `Bar item "${id}" has an invalid icon`
  if (i.tooltip !== undefined && !isString(i.tooltip)) return `Bar item "${id}" has an invalid tooltip`
  if (i.align !== undefined && i.align !== 'start' && i.align !== 'end') return `Bar item "${id}" has an invalid align`
  if (i.order !== undefined && (typeof i.order !== 'number' || !Number.isFinite(i.order))) return `Bar item "${id}" has an invalid order`

  if (i.when !== undefined) {
    if (!isString(i.when)) return `Bar item "${id}" has an invalid when expression`
    try {
      parseWhen(i.when)
    } catch (err) {
      return `Bar item "${id}" has an invalid when expression: ${err instanceof Error ? err.message : String(err)}`
    }
  }
}
