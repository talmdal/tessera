// shared/theme/resolveColors.ts
//
// Validates `shell.colors` contributions into the token catalogue, like
// resolveViews does for views. Ownership is enforced: a token's id must start
// with the contributor's plugin id. Offending contributions are skipped and
// described in the diagnostics.
import type { ColorContribution, ColorDefinition } from '@tessera/types'
import { cssVariableFor, isColorValue, isOwnedThemeId, isTokenId } from './types'

export interface ContributedColor {
  contributor: string
  impl: unknown
}

export function resolveColors(
  contributions: readonly ContributedColor[]
): { colors: ColorDefinition[], diagnostics: string[] } {
  const diagnostics: string[] = []
  const seenIds = new Set<string>()
  const seenVariables = new Map<string, string>()
  const colors: ColorDefinition[] = []

  for (const { contributor, impl } of contributions) {
    const problem = validate(contributor, impl)
    if (problem) {
      diagnostics.push(problem)
      continue
    }

    const color = impl as ColorContribution
    if (seenIds.has(color.id)) {
      diagnostics.push(`Duplicate colour token "${color.id}" ignored`)
      continue
    }
    const variable = cssVariableFor(color.id)
    const clash = seenVariables.get(variable)
    if (clash !== undefined) {
      diagnostics.push(`Colour token "${color.id}" ignored: it maps to the same CSS variable as "${clash}"`)
      continue
    }

    seenIds.add(color.id)
    seenVariables.set(variable, color.id)
    colors.push({
      id: color.id,
      description: color.description,
      defaults: typeof color.defaults === 'string'
        ? { light: color.defaults, dark: color.defaults }
        : { light: color.defaults.light, dark: color.defaults.dark },
      pluginId: contributor
    })
  }

  return { colors, diagnostics }
}

function validate(contributor: string, raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null) return 'Colour token contribution is not an object'

  const c = raw as Record<string, unknown>
  if (!isTokenId(c.id)) return `Colour token id "${String(c.id)}" is invalid: use "<pluginId>.<name>"`
  if (!isOwnedThemeId(contributor, c.id)) return `Colour token "${c.id}" ignored: "${contributor}" may only contribute tokens starting with "${contributor}."`
  if (typeof c.description !== 'string' || c.description.length === 0) return `Colour token "${c.id}" is missing a description`

  const defaults = c.defaults
  const values: unknown[] = typeof defaults === 'object' && defaults !== null
    ? [(defaults as Record<string, unknown>).light, (defaults as Record<string, unknown>).dark]
    : [defaults]
  for (const value of values) {
    if (!isColorValue(value)) return `Colour token "${c.id}" has an invalid default "${String(value)}": use a hex colour or a token id`
    if (value === c.id) return `Colour token "${c.id}" cannot default to itself`
  }
}
