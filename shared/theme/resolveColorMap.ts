// shared/theme/resolveColorMap.ts
//
// The resolution rule of the style manager, as a pure function so that the
// main process (ThemeService) and the renderer's first paint (from the
// shell's own catalogue) agree by construction:
//
//   for each token in the catalogue:
//     value = customizations.byTheme[theme][token]
//           ?? customizations.global[token]
//           ?? first explicit entry walking theme → extends → extends …
//           ?? token.defaults[theme.kind]
//     while value is a token reference: value = resolve(that token)
//
// Tokens a theme names but the catalogue lacks are ignored (a theme may
// colour a plugin that is not installed). A reference to an unknown token,
// or a reference cycle, leaves the token without a value and is reported.
import type { ColorDefinition, ThemeCustomizations, ThemeDefinition } from '@tessera/types'
import { isHexColor, isTokenId } from './types'

export interface ResolvedColors {
  colors: Record<string, string>
  diagnostics: string[]
}

export function resolveColorMap(
  catalogue: readonly ColorDefinition[],
  themes: readonly ThemeDefinition[],
  activeTheme: ThemeDefinition,
  customizations: ThemeCustomizations = {}
): ResolvedColors {
  const tokens = new Map(catalogue.map(token => [token.id, token]))
  const byId = new Map(themes.map(theme => [theme.id, theme]))
  const chain = themeChain(activeTheme, byId)
  const forTheme = customizations.byTheme?.[activeTheme.id] ?? {}
  const global = customizations.global ?? {}

  /** The value a token is given before references are followed. */
  const declared = (id: string): string | undefined => {
    const token = tokens.get(id)
    if (!token) return undefined
    const custom = pick(forTheme[id]) ?? pick(global[id])
    if (custom !== undefined) return custom
    for (const theme of chain) {
      const value = pick(theme.colors[id])
      if (value !== undefined) return value
    }
    return token.defaults[activeTheme.kind]
  }

  const colors: Record<string, string> = {}
  const diagnostics: string[] = []
  const resolved = new Map<string, string | null>()

  const resolve = (id: string, trail: string[]): string | null => {
    const known = resolved.get(id)
    if (known !== undefined) return known
    if (trail.includes(id)) {
      diagnostics.push(`Colour token "${trail[0]}" is part of a reference cycle (${[...trail, id].join(' → ')})`)
      return null
    }
    let value = declared(id)
    if (value === undefined) {
      if (trail.length > 0) diagnostics.push(`Colour token "${trail[trail.length - 1]}" references unknown token "${id}"`)
      return null
    }
    if (isTokenId(value)) {
      const target = resolve(value, [...trail, id])
      value = target ?? undefined
    }
    const result = value === undefined ? null : value
    resolved.set(id, result)
    return result
  }

  for (const token of catalogue) {
    const value = resolve(token.id, [])
    if (value !== null) colors[token.id] = value
  }

  return { colors, diagnostics }
}

/** The theme, then each ancestor through `extends`, stopping at a repeat. */
export function themeChain(theme: ThemeDefinition, byId: ReadonlyMap<string, ThemeDefinition>): ThemeDefinition[] {
  const chain: ThemeDefinition[] = []
  let current: ThemeDefinition | undefined = theme
  while (current && !chain.includes(current)) {
    chain.push(current)
    current = current.extends === undefined ? undefined : byId.get(current.extends)
  }
  return chain
}

/** Accepts only well-formed values, so a malformed customisation is skipped rather than applied. */
function pick(value: unknown): string | undefined {
  return isHexColor(value) || isTokenId(value) ? value : undefined
}
