// shared/themes/resolveThemes.ts
import type { ColorScheme, ThemeContribution, ThemeDescriptor, ThemeOptionsJson } from '@tessera/types'
import { COLOR_SCHEMES, MAX_THEME_BYTES } from './types'

export interface ContributedTheme {
  contributor: string
  impl: unknown
}

/**
 * Validates `shell.themes` contributions and orders them for the chooser.
 * Validation is structural: a theme must be plain, serialisable data of a
 * sane size, so nothing dangerous crosses IPC. Whether its options build a
 * usable MUI theme is decided in the renderer, which falls back if not.
 */
export function resolveThemes(contributions: readonly ContributedTheme[]): { themes: ThemeDescriptor[], diagnostics: string[] } {
  const diagnostics: string[] = []
  const seen = new Set<string>()
  const resolved: { theme: ThemeDescriptor, order: number, seq: number }[] = []

  contributions.forEach(({ contributor, impl }, seq) => {
    const problem = validateTheme(impl)
    if (problem) {
      diagnostics.push(problem)
      return
    }

    const theme = impl as ThemeContribution
    if (seen.has(theme.id)) {
      diagnostics.push(`Duplicate theme id "${theme.id}" ignored`)
      return
    }

    seen.add(theme.id)
    const schemes = COLOR_SCHEMES.filter(scheme => theme[scheme] !== undefined)
    resolved.push({
      theme: { ...theme, pluginId: contributor, schemes },
      order: theme.order ?? 0,
      seq
    })
  })

  const themes = resolved.sort((a, b) => a.order - b.order || a.seq - b.seq).map(r => r.theme)
  return { themes, diagnostics }
}

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const isString = (value: unknown): value is string => typeof value === 'string' && value.length > 0
const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/** The first problem with a contribution, or undefined when it is valid. */
export function validateTheme(raw: unknown): string | undefined {
  if (!isPlainObject(raw)) return 'Theme contribution is not an object'
  const t = raw

  if (!isString(t.id)) return 'Theme contribution is missing an id'
  if (!isString(t.label)) return `Theme "${t.id}" is missing a label`
  if (t.description !== undefined && typeof t.description !== 'string') return `Theme "${t.id}" has an invalid description`
  if (t.order !== undefined && (typeof t.order !== 'number' || !Number.isFinite(t.order))) return `Theme "${t.id}" has an invalid order`

  if (t.light === undefined && t.dark === undefined) return `Theme "${t.id}" defines neither a light nor a dark scheme`
  for (const key of ['common', 'light', 'dark'] as const) {
    if (t[key] === undefined) continue
    if (!isPlainObject(t[key])) return `Theme "${t.id}": ${key} is not an object`
    const bad = findUnsafe(t[key] as ThemeOptionsJson, key)
    if (bad) return `Theme "${t.id}": ${bad}`
  }

  if (t.swatch !== undefined) {
    if (!isPlainObject(t.swatch)) return `Theme "${t.id}" has an invalid swatch`
    for (const scheme of COLOR_SCHEMES) {
      const colours = (t.swatch as Record<ColorScheme, unknown>)[scheme]
      if (colours !== undefined && (!Array.isArray(colours) || !colours.every(isString))) return `Theme "${t.id}" has an invalid ${scheme} swatch`
    }
  }

  let size: number
  try {
    size = JSON.stringify(raw).length
  } catch {
    return `Theme "${t.id}" cannot be serialised`
  }
  if (size > MAX_THEME_BYTES) return `Theme "${t.id}" is too large (${size} bytes; the limit is ${MAX_THEME_BYTES})`

  return undefined
}

/**
 * Theme options must be plain data: no functions (they can't cross IPC and
 * would run in the renderer), no class instances, and no keys that could
 * alter a prototype when the options are deep-merged.
 */
function findUnsafe(value: unknown, path: string): string | undefined {
  if (typeof value === 'function') return `${path} is a function; theme options must be plain data`
  if (Array.isArray(value)) {
    for (const [i, item] of value.entries()) {
      const bad = findUnsafe(item, `${path}[${i}]`)
      if (bad) return bad
    }
    return undefined
  }
  if (typeof value === 'object' && value !== null) {
    if (!isPlainObject(value)) return `${path} is not a plain object`
    for (const key of Object.keys(value)) {
      if (UNSAFE_KEYS.has(key)) return `${path} has a forbidden key "${key}"`
      const bad = findUnsafe(value[key], `${path}.${key}`)
      if (bad) return bad
    }
  }
  return undefined
}
