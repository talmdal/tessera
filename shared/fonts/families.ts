// shared/fonts/families.ts — font family names as data: which names are acceptable, and the one place a CSS
// `font-family` value is built from them. Names come from themes and the user's settings, which are untrusted, so they
// are checked against a strict rule and always quoted; nothing they hold is pasted into a stylesheet as it is.

/** At most this many names in one family list: a preference and a few alternatives. */
export const MAX_FAMILY_NAMES = 8

/** The longest family name accepted. */
export const MAX_FAMILY_NAME_LENGTH = 100

/**
 * CSS generic families. They are written unquoted (quoted, "serif" would name a font called serif), and matched
 * case-insensitively.
 */
export const GENERIC_FAMILIES: readonly string[] = [
  'system-ui', 'ui-sans-serif', 'ui-serif', 'ui-monospace', 'ui-rounded',
  'sans-serif', 'serif', 'monospace', 'cursive', 'fantasy', 'math', 'emoji'
]

/**
 * Letters of any script, combining marks, digits, spaces and `_ . + & ' -`. Refused, among others: quotes and
 * backslashes (which would end the quoted name), `; { } ( ) , : / < > @ *` (which would end the declaration, open a block,
 * start another name or reach `url(…)`), and control characters.
 */
const NAME = /^[\p{L}\p{M}\p{N} _.+&'-]+$/u

/** True for a name the shell will use as a font family: see `NAME`, not blank, no spaces around it, not too long. */
export function isFontFamilyName(name: unknown): name is string {
  return typeof name === 'string'
    && name.length > 0 && name.length <= MAX_FAMILY_NAME_LENGTH
    && name.trim() === name
    && NAME.test(name)
}

/** What is wrong with a list of family names, for a message, or undefined when it can be used. */
export function familyListProblem(value: unknown): string | undefined {
  if (!Array.isArray(value)) return 'must be a list of font names'
  if (value.length === 0) return 'must name at least one font'
  if (value.length > MAX_FAMILY_NAMES) return `names more than ${MAX_FAMILY_NAMES} fonts`
  const bad = value.find(name => !isFontFamilyName(name))
  if (bad !== undefined) return typeof bad === 'string' ? `has "${bad}", which isn't a font name` : 'has something that isn\'t a font name'
  return undefined
}

const isGeneric = (name: string) => GENERIC_FAMILIES.includes(name.toLowerCase())

/**
 * The CSS `font-family` value for `names` (most wanted first), followed by `fallback`: a generic family unquoted and in
 * lower case, every other name in double quotes. The names must be valid (`familyListProblem`); an invalid one throws,
 * so a caller that forgot to check fails loudly rather than writing it into a stylesheet. `fallback` is the shell's own
 * CSS (a role's stack), which is trusted and used as it is.
 */
export function cssFontFamily(names: readonly string[], fallback: string): string {
  for (const name of names) {
    if (!isFontFamilyName(name)) throw new Error(`Not a font family name: ${JSON.stringify(name)}`)
  }
  return [...names.map(name => isGeneric(name) ? name.toLowerCase() : `"${name}"`), fallback].join(', ')
}
