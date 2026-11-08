// shared/theme/resolveThemes.ts
import type { ThemeDescriptor, ThemeFonts, ThemeTokens } from '@tessera/types'
import { fontSpecProblems, isFontRoleId } from '../fonts/roles'
import { DEFAULT_THEME, DEFAULT_THEME_ID } from './types'

export interface ContributedTheme {
  contributor: string
  impl: unknown
}

const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i
// Functional notation only; names like "red" are rejected so every colour can be parsed and adjusted by the UI library.
const FUNCTIONAL = /^(?:rgb|rgba|hsl|hsla)\(\s*[-+0-9.%\s,/a-z]+\)$/i

/** True for a CSS colour in hex or `rgb()`/`rgba()`/`hsl()`/`hsla()` notation. */
export function isThemeColor(value: unknown): value is string {
  return typeof value === 'string' && (HEX.test(value) || FUNCTIONAL.test(value))
}

const COLOR_TOKENS = ['primary', 'secondary', 'error', 'warning', 'info', 'success', 'divider'] as const
const GROUP_TOKENS = { background: ['default', 'paper'], text: ['primary', 'secondary'] } as const

/** A problem with a variant's tokens, or undefined when they are fine. */
function tokenProblem(tokens: unknown): string | undefined {
  if (typeof tokens !== 'object' || tokens === null || Array.isArray(tokens)) return 'is not an object'

  for (const [name, value] of Object.entries(tokens)) {
    if ((COLOR_TOKENS as readonly string[]).includes(name)) {
      if (!isThemeColor(value)) return `has an invalid colour for "${name}"`
    } else if (name in GROUP_TOKENS) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return `has an invalid "${name}"`
      for (const [inner, color] of Object.entries(value)) {
        if (!(GROUP_TOKENS[name as keyof typeof GROUP_TOKENS] as readonly string[]).includes(inner)) return `has an unknown token "${name}.${inner}"`
        if (!isThemeColor(color)) return `has an invalid colour for "${name}.${inner}"`
      }
    } else {
      return `has an unknown token "${name}"`
    }
  }
  return undefined
}

/**
 * A problem with a theme's fonts, or undefined when they are fine: by role, each held to what the role allows and to
 * the theme's size range (fontSpecProblems), with the first message.
 */
function fontsProblem(fonts: unknown): string | undefined {
  if (typeof fonts !== 'object' || fonts === null || Array.isArray(fonts)) return 'has fonts that are not an object'
  for (const [role, spec] of Object.entries(fonts)) {
    if (!isFontRoleId(role)) return `has fonts for an unknown role "${role}"`
    const [problem] = fontSpecProblems(role, spec, 'theme')
    if (problem) return `has a font that can't be used (${problem})`
  }
  return undefined
}

function validate(raw: unknown, contributor: string): string | undefined {
  if (typeof raw !== 'object' || raw === null) return 'Theme contribution is not an object'

  const t = raw as Record<string, unknown>
  if (typeof t.id !== 'string' || t.id.length === 0) return 'Theme contribution is missing an id'
  const id = t.id

  if (!id.startsWith(`${contributor}.`) || id.length === contributor.length + 1) return `Theme "${id}" must have an id prefixed by "${contributor}."`
  if (id === DEFAULT_THEME_ID) return `Theme "${id}" is reserved for the shell`
  if (typeof t.label !== 'string' || t.label.length === 0) return `Theme "${id}" is missing a label`
  if (t.description !== undefined && (typeof t.description !== 'string' || t.description.trim() === '')) return `Theme "${id}" has an invalid description`
  if (t.light === undefined && t.dark === undefined) return `Theme "${id}" needs a light or a dark variant`

  for (const variant of ['light', 'dark'] as const) {
    if (t[variant] === undefined) continue
    const problem = tokenProblem(t[variant])
    if (problem) return `Theme "${id}" ${variant} variant ${problem}`
  }

  if (t.fonts !== undefined) {
    const problem = fontsProblem(t.fonts)
    if (problem) return `Theme "${id}" ${problem}`
  }

  for (const key of Object.keys(t)) {
    if (!['id', 'label', 'description', 'light', 'dark', 'fonts'].includes(key)) return `Theme "${id}" has an unknown field "${key}"`
  }
  return undefined
}

/**
 * Validates `shell.themes` contributions, ahead of the shell's own theme.
 * Invalid ones are skipped and described in `diagnostics`; the first of two
 * with the same id wins.
 */
export function resolveThemes(contributions: readonly ContributedTheme[]): { themes: ThemeDescriptor[], diagnostics: string[] } {
  const diagnostics: string[] = []
  const themes: ThemeDescriptor[] = [DEFAULT_THEME]
  const seen = new Set<string>([DEFAULT_THEME_ID])

  for (const { contributor, impl } of contributions) {
    const problem = validate(impl, contributor)
    if (problem) {
      diagnostics.push(problem)
      continue
    }

    const theme = impl as ThemeDescriptor
    if (seen.has(theme.id)) {
      diagnostics.push(`Duplicate theme id "${theme.id}" ignored`)
      continue
    }
    seen.add(theme.id)

    // Copied field by field so the registry never holds a reference into a plugin's object.
    themes.push({
      id: theme.id,
      label: theme.label,
      ...(theme.description !== undefined && { description: theme.description }),
      ...(theme.light && { light: cloneTokens(theme.light) }),
      ...(theme.dark && { dark: cloneTokens(theme.dark) }),
      ...(theme.fonts && { fonts: cloneFonts(theme.fonts) })
    })
  }

  return { themes, diagnostics }
}

const cloneTokens = (tokens: ThemeTokens): ThemeTokens => JSON.parse(JSON.stringify(tokens))
const cloneFonts = (fonts: ThemeFonts): ThemeFonts => JSON.parse(JSON.stringify(fonts))
