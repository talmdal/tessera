// Shared plumbing for the extension points `accounts` owns. Each point validates its own contributions (the
// framework has no declared points yet, see docs/todo.md), skips the invalid ones, and warns once about each
// problem rather than on every read — a view asks for these every time a menu opens.
import type { ExtensionRegistry, Logger } from '@tessera/types'
import { ACCOUNT_TYPES } from '@tessera/accounts-api'

/** Why a contribution can't be used, or undefined. */
export type Validator = (raw: unknown, contributor: string) => string | undefined

export const isText = (value: unknown): value is string => typeof value === 'string' && value.trim() !== ''

/**
 * The shared field rules: an id namespaced to the contributor, a label, a command, and optional `accountTypes`,
 * `icon` and `order`. `kind` names the point in the warning ("reconcile action", "row action").
 */
export function checkCommonFields(raw: unknown, contributor: string, kind: string): string | undefined {
  if (typeof raw !== 'object' || raw === null) return `A ${kind} from "${contributor}" is not an object`
  const a = raw as Record<string, unknown>
  const Kind = `${kind[0].toUpperCase()}${kind.slice(1)}`
  if (!isText(a.id) || !(a.id as string).startsWith(`${contributor}.`)) {
    return `A ${kind} from "${contributor}" needs an id starting with "${contributor}."`
  }
  if (!isText(a.label)) return `${Kind} "${a.id}" needs a label`
  if (!isText(a.command)) return `${Kind} "${a.id}" needs a command`
  if (a.accountTypes !== undefined && (!Array.isArray(a.accountTypes) || a.accountTypes.some(t => !(ACCOUNT_TYPES as readonly unknown[]).includes(t)))) {
    return `${Kind} "${a.id}" names an unknown account type`
  }
  if (a.order !== undefined && (typeof a.order !== 'number' || !Number.isFinite(a.order))) return `${Kind} "${a.id}" has an invalid order`
  if (a.icon !== undefined && !isText(a.icon)) return `${Kind} "${a.id}" has an invalid icon`
  return undefined
}

/**
 * Valid contributions to `point`, by `order` then as contributed, duplicate ids dropped. Each distinct problem is
 * logged once, with the `[accounts]` prefix the shell's own diagnostics use.
 */
export function collect<T extends { id: string, order?: number }>(
  extensions: Pick<ExtensionRegistry, 'getContributions'>,
  point: string,
  validate: Validator,
  log: Pick<Logger, 'warn'>,
  warned: Set<string>,
  describe: string
): T[] {
  const valid: { item: T, seq: number }[] = []
  const seen = new Set<string>()
  extensions.getContributions(point).forEach(({ contributor, impl }, seq) => {
    const id = (impl as { id?: unknown })?.id
    const problem = validate(impl, contributor)
      ?? (typeof id === 'string' && seen.has(id) ? `Duplicate ${describe} "${id}" ignored` : undefined)
    if (problem) {
      if (!warned.has(problem)) { warned.add(problem); log.warn(`[accounts] ${problem}`) }
      return
    }
    const item = impl as T
    seen.add(item.id)
    valid.push({ item, seq })
  })
  return valid.sort((a, b) => (a.item.order ?? 0) - (b.item.order ?? 0) || a.seq - b.seq).map(v => v.item)
}
