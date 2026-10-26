// shared/layout/resolveBarItems.ts
import type { BarItemContribution, BarItemDescriptor } from '@tessera/types'
import { parseWhen } from '../context/when'
import { isBarSlot } from '../views/types'
import { isFileIcon, isValidIcon } from './icons'

export interface ContributedBarItem {
  contributor: string
  impl: unknown
}

export interface BarItemResources {
  /** URL of a file in a plugin's renderer folder, from a "./…" path; undefined when the plugin has no renderer. */
  assetUrlFor(pluginId: string, relativePath: string): string | undefined
  /** Whether a command is registered and currently enabled (CommandRegistry.isEnabled). */
  isCommandEnabled(commandId: string): boolean
}

/**
 * Validates `shell.bar.items` contributions and orders them by slot, then
 * alignment ('start' before 'end'), then order, then registration.
 */
export function resolveBarItems(
  contributions: readonly ContributedBarItem[],
  resources: BarItemResources
): { items: BarItemDescriptor[], diagnostics: string[] } {
  const diagnostics: string[] = []
  const seen = new Set<string>()
  const resolved: { item: BarItemDescriptor, order: number, seq: number }[] = []

  contributions.forEach(({ contributor, impl }, seq) => {
    const problem = validate(impl)
    if (problem) {
      diagnostics.push(problem)
      return
    }

    const item = impl as BarItemContribution
    if (seen.has(item.id)) {
      diagnostics.push(`Duplicate bar item id "${item.id}" ignored`)
      return
    }

    let icon = item.icon
    if (icon && isFileIcon(icon)) {
      const url = resources.assetUrlFor(contributor, icon.slice(2))
      if (!url) {
        diagnostics.push(`Bar item "${item.id}" has icon "${icon}", which cannot be served from "${contributor}"`)
        return
      }
      icon = url
    }

    seen.add(item.id)
    resolved.push({
      item: {
        ...item,
        ...(icon === undefined ? {} : { icon }),
        pluginId: contributor,
        enabled: item.command === undefined ? true : resources.isCommandEnabled(item.command)
      },
      order: item.order ?? 0,
      seq
    })
  })

  const alignRank = (item: BarItemDescriptor) => (item.align ?? 'start') === 'start' ? 0 : 1
  const items = resolved
    .sort((a, b) =>
      a.item.slot.localeCompare(b.item.slot) ||
      alignRank(a.item) - alignRank(b.item) ||
      a.order - b.order ||
      a.seq - b.seq)
    .map(r => r.item)

  return { items, diagnostics }
}

function validate(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null) return 'Bar item contribution is not an object'

  const c = raw as Record<string, unknown>
  const isString = (x: unknown): x is string => typeof x === 'string' && x.length > 0
  const optional = (x: unknown, check: (x: unknown) => boolean) => x === undefined || check(x)

  if (!isString(c.id)) return 'Bar item contribution is missing an id'
  const id = c.id as string
  if (!isString(c.slot)) return `Bar item "${id}" is missing a slot`
  if (!isBarSlot(c.slot)) return `Bar item "${id}" targets "${c.slot}"; items go in bar slots only`
  if (!optional(c.align, v => v === 'start' || v === 'end')) return `Bar item "${id}" has an invalid align`
  if (!optional(c.order, v => typeof v === 'number' && Number.isFinite(v))) return `Bar item "${id}" has an invalid order`
  if (!optional(c.icon, isValidIcon)) return `Bar item "${id}" has an invalid icon "${String(c.icon)}": use "./file.svg" or a shell icon name`
  if (!optional(c.tooltip, isString)) return `Bar item "${id}" has an invalid tooltip`

  switch (c.kind) {
    case 'button':
      if (!isString(c.label)) return `Bar item "${id}" is missing a label`
      if (!isString(c.command)) return `Bar item "${id}" is missing a command`
      break
    case 'text':
      if (!isString(c.text)) return `Bar item "${id}" is missing its text`
      if (!optional(c.command, isString)) return `Bar item "${id}" has an invalid command`
      break
    default:
      return `Bar item "${id}" has unknown kind "${String(c.kind)}"`
  }

  if (c.when !== undefined) {
    if (!isString(c.when)) return `Bar item "${id}" has an invalid when expression`
    try {
      parseWhen(c.when as string)
    } catch (err) {
      return `Bar item "${id}" has an invalid when expression: ${err instanceof Error ? err.message : String(err)}`
    }
  }
}
