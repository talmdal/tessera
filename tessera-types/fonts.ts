// Font roles: the kinds of text Tessera styles separately, and what a theme or the user may set for each. The shell
// owns the roles and their defaults (shared/fonts/roles.ts); themes may set fonts; the user has the last word.
// See docs/font-roles-design.md.

/**
 * The kinds of text Tessera styles separately:
 * - `ui`: Interface text, the base every other size follows;
 * - `heading`: Headings and dialog titles;
 * - `small`: Small text (captions, hints under fields, tooltips);
 * - `table`: Tables and registers;
 * - `numeric`: Amounts and figures, always with digits of equal width;
 * - `monospace`: Fixed-width text (paths, file contents).
 */
export type FontRoleId = 'ui' | 'heading' | 'small' | 'table' | 'numeric' | 'monospace'

/** What a role lets a theme or the user set. Not every role has every facet. */
export type FontFacet = 'family' | 'size' | 'weight'

/** The weights offered: Regular, Medium, Semibold, Bold. */
export type FontWeight = 400 | 500 | 600 | 700

/**
 * One role's font, as a theme sets it. Everything is optional: what is left out comes from the next layer.
 * `family` is family names, most wanted first, never CSS: the shell checks and quotes them, and adds the role's fallbacks.
 */
export interface FontSpec {
  family?: string[]
  /** Whole CSS pixels. Only for roles with a size facet. */
  size?: number
  /** Only for roles with a weight facet. */
  weight?: FontWeight
}

/** The fonts a theme sets, by role. */
export type ThemeFonts = Partial<Record<FontRoleId, FontSpec>>

/**
 * The user's fonts (the `shell.fonts` setting). Each role lists only its own facets, and every `null` is Automatic:
 * the theme's value, else the one inherited from Interface text, else the shell's.
 */
export interface FontSettings {
  /** When false, themes' fonts are ignored and only the user's and the shell's apply. */
  useThemeFonts: boolean
  roles: {
    ui: { family: string[] | null, size: number | null, weight: FontWeight | null }
    heading: { family: string[] | null, weight: FontWeight | null }
    small: { family: string[] | null, size: number | null }
    table: { family: string[] | null, size: number | null }
    numeric: { family: string[] | null }
    monospace: { family: string[] | null, size: number | null }
  }
}

/**
 * Where a resolved value came from: the user's settings, the theme, Interface text (or, for Amounts and figures, the
 * text around it), or the shell's own default.
 */
export type FontSource = 'user' | 'theme' | 'inherited' | 'shell'

/** A role as it is drawn. */
export interface ResolvedFontRole {
  id: FontRoleId
  /**
   * The CSS `font-family` value, with the role's fallbacks. Undefined for Amounts and figures while they take the
   * family of the text around them.
   */
  fontFamily?: string
  /** The family asked for first ("Inter"), for display; undefined while the shell's own stack is used. */
  primary?: string
  /**
   * The size in CSS pixels, for roles with a size facet. An Automatic size is the one the role shows: Small text at
   * MUI's caption ratio of the interface size, for example. Undefined for Headings (each level keeps its own) and for
   * Amounts and figures (the size of the text around them).
   */
  size?: number
  /** Undefined when the role keeps each level's own weight (Headings, while Automatic) or has no weight facet. */
  weight?: FontWeight
  sources: { family: FontSource, size?: FontSource, weight?: FontSource }
}

/** Every role, resolved. */
export type ResolvedFonts = Record<FontRoleId, ResolvedFontRole>
