// shared/theme/resolveThemes.ts
//
// Validates `shell.themes` contributions and settles their `extends` chains.
// A theme with a bad colour value is skipped whole (a half-applied theme is
// worse than none); an unknown parent is a warning and the theme falls back
// to the shell's theme of its kind; a parent of the other kind, or a cycle,
// skips the theme. Output is ordered by `order`, then registration.
import type { ThemeContribution, ThemeDefinition } from '@tessera/types'
import { defaultThemeFor, isColorValue, isOwnedThemeId, isThemeKind, isTokenId } from './types'

export interface ContributedTheme {
  contributor: string
  impl: unknown
}

export function resolveThemes(
  contributions: readonly ContributedTheme[]
): { themes: ThemeDefinition[], diagnostics: string[] } {
  const diagnostics: string[] = []
  const seen = new Set<string>()
  const candidates: { theme: ThemeDefinition, declaredParent?: string, order: number, seq: number }[] = []

  contributions.forEach(({ contributor, impl }, seq) => {
    const problem = validate(contributor, impl)
    if (problem) {
      diagnostics.push(problem)
      return
    }
    const theme = impl as ThemeContribution
    if (seen.has(theme.id)) {
      diagnostics.push(`Duplicate theme "${theme.id}" ignored`)
      return
    }
    seen.add(theme.id)
    candidates.push({
      theme: { id: theme.id, label: theme.label, kind: theme.kind, colors: { ...(theme.colors ?? {}) }, pluginId: contributor },
      declaredParent: theme.extends,
      order: theme.order ?? 0,
      seq
    })
  })

  // Settle `extends`: the declared parent, or the shell's theme of the same
  // kind. A root theme (the shell's own) has no parent.
  const byId = new Map(candidates.map(c => [c.theme.id, c]))
  for (const candidate of candidates) {
    const { theme, declaredParent } = candidate
    const fallback = defaultThemeFor(theme.kind)
    let parent = declaredParent
    if (parent !== undefined && !byId.has(parent)) {
      diagnostics.push(`Theme "${theme.id}" extends unknown theme "${parent}"; using "${fallback}"`)
      parent = undefined
    }
    if (parent === undefined) parent = theme.id === fallback ? undefined : fallback
    if (parent !== undefined && !byId.has(parent)) parent = undefined   // the shell's own are absent (tests)
    if (parent !== undefined) theme.extends = parent
  }

  const themes: ThemeDefinition[] = []
  for (const candidate of candidates) {
    const { theme } = candidate
    const parent = theme.extends === undefined ? undefined : byId.get(theme.extends)!.theme
    if (parent && parent.kind !== theme.kind) {
      diagnostics.push(`Theme "${theme.id}" (${theme.kind}) cannot extend "${parent.id}" (${parent.kind})`)
      continue
    }
    if (hasCycle(theme, id => byId.get(id)?.theme)) {
      diagnostics.push(`Theme "${theme.id}" is part of an extends cycle`)
      continue
    }
    themes.push(theme)
  }

  const rank = new Map(candidates.map(c => [c.theme.id, c]))
  themes.sort((a, b) => {
    const ra = rank.get(a.id)!, rb = rank.get(b.id)!
    return ra.order - rb.order || ra.seq - rb.seq
  })

  return { themes, diagnostics }
}

function hasCycle(start: ThemeDefinition, lookup: (id: string) => ThemeDefinition | undefined) {
  const visited = new Set<string>()
  let current: ThemeDefinition | undefined = start
  while (current) {
    if (visited.has(current.id)) return true
    visited.add(current.id)
    current = current.extends === undefined ? undefined : lookup(current.extends)
  }
  return false
}

function validate(contributor: string, raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null) return 'Theme contribution is not an object'

  const t = raw as Record<string, unknown>
  if (!isTokenId(t.id)) return `Theme id "${String(t.id)}" is invalid: use "<pluginId>.<name>"`
  if (!isOwnedThemeId(contributor, t.id)) return `Theme "${t.id}" ignored: "${contributor}" may only contribute themes starting with "${contributor}."`
  if (typeof t.label !== 'string' || t.label.length === 0) return `Theme "${t.id}" is missing a label`
  if (!isThemeKind(t.kind)) return `Theme "${t.id}" has an invalid kind "${String(t.kind)}": use "light" or "dark"`
  if (t.extends !== undefined && !isTokenId(t.extends)) return `Theme "${t.id}" has an invalid extends "${String(t.extends)}"`
  if (t.order !== undefined && (typeof t.order !== 'number' || !Number.isFinite(t.order))) return `Theme "${t.id}" has an invalid order`

  if (t.colors !== undefined) {
    if (typeof t.colors !== 'object' || t.colors === null || Array.isArray(t.colors)) return `Theme "${t.id}" has an invalid colors map`
    for (const [key, value] of Object.entries(t.colors as Record<string, unknown>)) {
      if (!isTokenId(key)) return `Theme "${t.id}" colours an invalid token id "${key}"`
      if (!isColorValue(value)) return `Theme "${t.id}" has an invalid colour "${String(value)}" for "${key}": use a hex colour or a token id`
    }
  }
}
