// shared/fonts/roles.ts — the font roles: the kinds of text Tessera styles separately, what each lets a theme or the
// user set, and their defaults and limits. Both processes read it: the main process to check settings and themes, the
// renderer to resolve and draw them. See docs/font-roles-design.md.
import type { FontFacet, FontRoleId, FontWeight, ThemeFonts } from '@tessera/types'
import { familyListProblem } from './families'

/** The operating system's own UI font: the shell's default for everything but fixed-width text. Trusted CSS. */
export const FONT_STACK = 'system-ui, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'

/** The operating system's fixed-width font, with the common ones of each platform after it. Trusted CSS. */
export const MONO_STACK = 'ui-monospace, "Cascadia Mono", Consolas, "SF Mono", Menlo, "DejaVu Sans Mono", "Liberation Mono", monospace'

/** The interface size the shell uses unless a theme or the user sets another: MUI's `typography.fontSize`. */
export const BASE_FONT_SIZE = 13

/** The shell's weight for interface text. */
export const BASE_FONT_WEIGHT: FontWeight = 400

/** The weights offered, lightest first, with their names. */
export const FONT_WEIGHTS: readonly { weight: FontWeight, label: string }[] = [
  { weight: 400, label: 'Regular' },
  { weight: 500, label: 'Medium' },
  { weight: 600, label: 'Semibold' },
  { weight: 700, label: 'Bold' }
]

/** A range of whole CSS pixels, both ends included. */
export interface SizeRange { min: number, max: number }

/** Who is setting a value: the user may choose from a wide range, a theme from a narrow one (so it can't break layout). */
export type FontTier = 'user' | 'theme'

export interface FontRoleDefinition {
  id: FontRoleId
  /** What the user sees. */
  label: string
  /** A line under the label, saying what the role covers. */
  description: string
  /** What a theme or the user may set for the role. */
  facets: readonly FontFacet[]
  /**
   * Where the family comes from when nobody sets it, and what follows a family that is set:
   * - `stack`: the shell's own CSS, which also follows a family that is set (Interface text, Fixed-width text);
   * - `ui`: Interface text's family (Headings, Small text, Tables and registers);
   * - `surrounding`: the text the role sits in (Amounts and figures); a family that is set is followed by Interface text's.
   */
  family: { stack: string } | { inherits: 'ui' } | { inherits: 'surrounding' }
  /**
   * For roles with a size facet: the size when nobody sets it, as a ratio of the interface size (MUI's own ratio, so
   * the shell looks as it did before roles), and the sizes each tier may choose.
   */
  size?: { ratio: number, user: SizeRange, theme: SizeRange }
}

/** The roles, in the order the Fonts page lists them. */
export const FONT_ROLES: readonly FontRoleDefinition[] = [
  {
    id: 'ui',
    label: 'Interface text',
    description: 'Menus, buttons, fields, panels and most text. Other sizes follow this one.',
    facets: ['family', 'size', 'weight'],
    family: { stack: FONT_STACK },
    // 11 at the least: at 10, tooltips would be 7.9 px (docs/font-roles-design.md#phase-0-results)
    size: { ratio: 1, user: { min: 11, max: 24 }, theme: { min: 12, max: 16 } }
  },
  {
    id: 'heading',
    label: 'Headings',
    description: 'Titles of views, pages and dialogs, and the headings within them.',
    facets: ['family', 'weight'],
    family: { inherits: 'ui' }
  },
  {
    id: 'small',
    label: 'Small text',
    description: 'Captions, hints under fields, and tooltips.',
    facets: ['family', 'size'],
    family: { inherits: 'ui' },
    // MUI's caption is 12 where its body text is 14
    size: { ratio: 12 / 14, user: { min: 8, max: 20 }, theme: { min: 10, max: 14 } }
  },
  {
    id: 'table',
    label: 'Tables and registers',
    description: 'The register and other lists of transactions.',
    facets: ['family', 'size'],
    family: { inherits: 'ui' },
    size: { ratio: 1, user: { min: 10, max: 24 }, theme: { min: 12, max: 16 } }
  },
  {
    id: 'numeric',
    label: 'Amounts and figures',
    description: 'Always with digits of equal width, so columns line up. The size follows the text around it.',
    facets: ['family'],
    family: { inherits: 'surrounding' }
  },
  {
    id: 'monospace',
    label: 'Fixed-width text',
    description: 'File paths and file contents.',
    facets: ['family', 'size'],
    family: { stack: MONO_STACK },
    size: { ratio: 1, user: { min: 9, max: 24 }, theme: { min: 11, max: 16 } }
  }
]

/** The role ids, in the order the Fonts page lists them. */
export const FONT_ROLE_IDS: readonly FontRoleId[] = FONT_ROLES.map(role => role.id)

const BY_ID = new Map(FONT_ROLES.map(role => [role.id, role]))

/** True for the id of one of the shell's roles. */
export const isFontRoleId = (id: unknown): id is FontRoleId => typeof id === 'string' && BY_ID.has(id as FontRoleId)

/** A role's definition. Throws for an id that isn't a role. */
export function fontRole(id: FontRoleId): FontRoleDefinition {
  const role = BY_ID.get(id)
  if (!role) throw new Error(`Unknown font role "${id}"`)
  return role
}

export const isFontWeight = (value: unknown): value is FontWeight => FONT_WEIGHTS.some(w => w.weight === value)

/** True for a whole number of pixels within `range`. */
export const isSizeIn = (value: unknown, range: SizeRange): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= range.min && value <= range.max

/**
 * What is wrong with one role's `FontSpec` as a theme (`tier: 'theme'`) or the user sets it, as messages for people:
 * a facet the role doesn't have, a family list that can't be used, a size outside the tier's range, a weight that
 * isn't offered. Empty when it is fine. Values that are absent (or `null`, as the settings store Automatic) are fine.
 */
export function fontSpecProblems(id: FontRoleId, spec: unknown, tier: FontTier): string[] {
  const role = fontRole(id)
  if (typeof spec !== 'object' || spec === null || Array.isArray(spec)) return [`${role.label}: must be an object.`]

  const problems: string[] = []
  for (const [facet, value] of Object.entries(spec as Record<string, unknown>)) {
    if (value === undefined || value === null) continue
    if (!(role.facets as readonly string[]).includes(facet)) {
      problems.push(facet === 'family' || facet === 'size' || facet === 'weight'
        ? `${role.label}: its ${facet} can't be set.`
        : `${role.label}: "${facet}" isn't something a font has.`)
      continue
    }
    if (facet === 'family') {
      const problem = familyListProblem(value)
      if (problem) problems.push(`${role.label}: the font ${problem}.`)
    } else if (facet === 'size') {
      const range = role.size![tier]
      if (!isSizeIn(value, range)) problems.push(`${role.label}: choose a size from ${range.min} to ${range.max} px.`)
    } else if (!isFontWeight(value)) {
      problems.push(`${role.label}: choose Regular, Medium, Semibold or Bold.`)
    }
  }
  return problems
}

/**
 * What a theme's fonts set, for people, role by role in the Fonts page's order: "Headings (Georgia, Semibold)",
 * "Interface text (14 px)". Empty when the theme sets none. Values that wouldn't pass (a theme is checked before it is
 * registered, so only by mistake) are left out.
 */
export function describeThemeFonts(fonts: ThemeFonts | undefined): string[] {
  if (!fonts) return []
  return FONT_ROLES.flatMap(role => {
    const spec = fonts[role.id]
    if (!spec || fontSpecProblems(role.id, spec, 'theme').length > 0) return []
    const parts = [
      spec.family?.[0],
      spec.size !== undefined && spec.size !== null ? `${spec.size} px` : undefined,
      spec.weight !== undefined && spec.weight !== null ? FONT_WEIGHTS.find(w => w.weight === spec.weight)?.label : undefined
    ].filter(Boolean)
    return parts.length > 0 ? [`${role.label} (${parts.join(', ')})`] : []
  })
}
