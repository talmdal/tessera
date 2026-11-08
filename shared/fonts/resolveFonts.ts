// shared/fonts/resolveFonts.ts — what each font role shows: the user's choice, else the theme's, else the value
// inherited from Interface text, else the shell's. Pure, so both processes and the tests agree.
import type { FontRoleId, FontSettings, FontSource, FontWeight, ResolvedFontRole, ResolvedFonts, ThemeFonts } from '@tessera/types'
import { cssFontFamily, familyListProblem } from './families'
import { BASE_FONT_SIZE, BASE_FONT_WEIGHT, FONT_STACK, type FontTier, MONO_STACK, fontRole, isFontWeight, isSizeIn } from './roles'

/** The user's fonts when they have changed nothing: theme fonts on, every role Automatic. */
export const DEFAULT_FONT_SETTINGS: FontSettings = Object.freeze({
  useThemeFonts: true,
  roles: Object.freeze({
    ui: Object.freeze({ family: null, size: null, weight: null }),
    heading: Object.freeze({ family: null, weight: null }),
    small: Object.freeze({ family: null, size: null }),
    table: Object.freeze({ family: null, size: null }),
    numeric: Object.freeze({ family: null }),
    monospace: Object.freeze({ family: null, size: null })
  })
}) as FontSettings

interface Picked<T> { value: T, source: FontSource }

/** Sizes in resolved roles keep two decimals: MUI's ratios give 11.142857… for a caption at 13. */
const round2 = (n: number) => Math.round(n * 100) / 100

/**
 * The fonts every role shows, for the user's `settings` and the fonts of the theme the window shows (`themeFonts`,
 * ignored when the user turned theme fonts off).
 *
 * For each role and each of its facets, the first of these wins: the user's value, the theme's, the value inherited
 * from Interface text (for Amounts and figures, the text around them), the shell's default. Every value is checked
 * again here, as the settings and themes were when they were saved or contributed, and one that doesn't pass is
 * ignored: whatever a settings file or a theme holds, only a valid family name reaches a stylesheet.
 */
export function resolveFonts(settings: FontSettings = DEFAULT_FONT_SETTINGS, themeFonts?: ThemeFonts): ResolvedFonts {
  const theme = settings?.useThemeFonts === false ? undefined : themeFonts
  const userRoles = (settings?.roles ?? {}) as Record<string, Record<string, unknown> | undefined>

  /** The user's value for a facet, else the theme's; each only if it is valid for the role and the tier. */
  function pick(id: FontRoleId, facet: 'family'): Picked<string[]> | undefined
  function pick(id: FontRoleId, facet: 'size'): Picked<number> | undefined
  function pick(id: FontRoleId, facet: 'weight'): Picked<FontWeight> | undefined
  function pick(id: FontRoleId, facet: 'family' | 'size' | 'weight'): Picked<unknown> | undefined {
    const role = fontRole(id)
    if (!role.facets.includes(facet)) return undefined
    const valid = (value: unknown, tier: FontTier) =>
      facet === 'family' ? familyListProblem(value) === undefined
        : facet === 'size' ? isSizeIn(value, role.size![tier])
          : isFontWeight(value)
    const layers: [unknown, FontSource, FontTier][] = [
      [userRoles[id]?.[facet], 'user', 'user'],
      [theme?.[id]?.[facet], 'theme', 'theme']
    ]
    for (const [value, source, tier] of layers) {
      if (value !== undefined && value !== null && valid(value, tier)) return { value, source }
    }
    return undefined
  }

  // Interface text: everything else follows it
  const uiFamily = pick('ui', 'family')
  const uiSize = pick('ui', 'size')
  const uiWeight = pick('ui', 'weight')
  const ui: ResolvedFontRole = {
    id: 'ui',
    fontFamily: uiFamily ? cssFontFamily(uiFamily.value, FONT_STACK) : FONT_STACK,
    primary: uiFamily?.value[0],
    size: uiSize?.value ?? BASE_FONT_SIZE,
    weight: uiWeight?.value ?? BASE_FONT_WEIGHT,
    sources: { family: uiFamily?.source ?? 'shell', size: uiSize?.source ?? 'shell', weight: uiWeight?.source ?? 'shell' }
  }
  const uiSizePx = ui.size!

  /** A family that follows Interface text when nobody sets it, and falls back to it when the one set is missing. */
  const familyOverUi = (id: FontRoleId) => {
    const own = pick(id, 'family')
    return own
      ? { fontFamily: cssFontFamily(own.value, ui.fontFamily!), primary: own.value[0], source: own.source }
      : { fontFamily: ui.fontFamily, primary: ui.primary, source: 'inherited' as const }
  }

  /** A size set for the role, else the interface size at the role's ratio. */
  const sizeOverUi = (id: FontRoleId) => {
    const own = pick(id, 'size')
    return own ? { size: own.value, source: own.source } : { size: round2(uiSizePx * fontRole(id).size!.ratio), source: 'inherited' as const }
  }

  const headingFamily = familyOverUi('heading')
  const headingWeight = pick('heading', 'weight')
  const heading: ResolvedFontRole = {
    id: 'heading',
    fontFamily: headingFamily.fontFamily,
    primary: headingFamily.primary,
    // Automatic: each level keeps its own weight (h6 is medium, h4 regular)
    weight: headingWeight?.value,
    sources: { family: headingFamily.source, weight: headingWeight?.source ?? 'shell' }
  }

  const sized = (id: 'small' | 'table'): ResolvedFontRole => {
    const family = familyOverUi(id)
    const size = sizeOverUi(id)
    return { id, fontFamily: family.fontFamily, primary: family.primary, size: size.size, sources: { family: family.source, size: size.source } }
  }

  // Amounts and figures: the family of the text around them unless one is set, which then falls back to Interface text
  const numericFamily = pick('numeric', 'family')
  const numeric: ResolvedFontRole = {
    id: 'numeric',
    fontFamily: numericFamily ? cssFontFamily(numericFamily.value, ui.fontFamily!) : undefined,
    primary: numericFamily?.value[0],
    sources: { family: numericFamily?.source ?? 'inherited' }
  }

  // Fixed-width text: its own stack (a proportional font is never right for it), the interface size
  const monoFamily = pick('monospace', 'family')
  const monoSize = sizeOverUi('monospace')
  const monospace: ResolvedFontRole = {
    id: 'monospace',
    fontFamily: monoFamily ? cssFontFamily(monoFamily.value, MONO_STACK) : MONO_STACK,
    primary: monoFamily?.value[0],
    size: monoSize.size,
    sources: { family: monoFamily?.source ?? 'shell', size: monoSize.source }
  }

  return { ui, heading, small: sized('small'), table: sized('table'), numeric, monospace }
}

/** True when a value was set by the user or a theme, rather than following a default: only those are drawn as overrides. */
export const isChosen = (source: FontSource | undefined) => source === 'user' || source === 'theme'
