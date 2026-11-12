// The anonymiser's last step, and a check on any file: is anything personal left? It looks for every original value
// the run replaced, and for the usual shapes of personal numbers and addresses. A file with a finding isn't written.
//
// What it looks at: the text with the file's structure (tags, a header) and its known-harmless values (dates, amounts
// kept, codes) blanked out. A shape is reported only if it contains a letter or digit copied from the original that
// wasn't vetted, so the tool's own made-up account numbers don't stop it, while one it failed to replace does.
// See docs/import-formats-design.md, "The scan: refusing to write".
import { fold } from './words'

/** An output and what the scan needs to know about each of its characters. */
export interface Scannable {
  text: string
  /** 1 where the character was copied from the original and not vetted as harmless. */
  original: Uint8Array
  /** 1 where the character is structure or a known-harmless value: not looked at. */
  hidden: Uint8Array
}

/** A file as the scan sees it when nothing is known about it: every character the original's, none hidden. */
export const plain = (text: string): Scannable => ({ text, original: new Uint8Array(text.length).fill(1), hidden: new Uint8Array(text.length) })

export type FindingKind =
  | 'replaced value' | 'card number' | 'long number' | 'email address' | 'phone number' | 'postal code'
  | 'social insurance or security number' | 'IBAN'

export interface Finding {
  kind: FindingKind
  /** From 1. */
  line: number
  /** What was found, masked except for its last two characters. */
  masked: string
  /** The text found, unmasked, for `--allow`. Never printed. */
  text: string
  /** The whole value around it (the run of non-space characters: 'CA12345678' around '12345678'), unmasked. Never printed. */
  token: string
  /** The token's shape, letters as 'A' and digits as '9' ('AA99999999'): safe to print, and what `--allow-like` takes. */
  shape: string
  /** Where it starts in the output's text. */
  at: number
}

/** A value's shape: every letter an 'A', every digit a '9', everything else as it is. */
export const shapeOf = (text: string) => text.replace(/\p{L}/gu, 'A').replace(/\p{N}/gu, '9')

/**
 * An `--allow-like` example as a rule: a value of the same shape, letter for letter and digit for digit, whatever they
 * are ('AB12345678' allows 'CA98765432'). No regular expression to write or quote.
 */
export function likeRule(example: string): RegExp {
  const pattern = [...example.trim()].map(ch => /\p{L}/u.test(ch) ? '\\p{L}' : /\p{N}/u.test(ch) ? '\\p{N}' : /\s/.test(ch) ? '\\s' : ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('')
  return new RegExp(`^${pattern}$`, 'iu')
}

/** What was found, hiding all but its last two characters. */
export const mask = (text: string) => text.replace(/[\p{L}\p{N}](?=(?:[^\p{L}\p{N}]*[\p{L}\p{N}]){2})/gu, '•')

function luhn(digits: string): boolean {
  let sum = 0
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i])
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9 }
    sum += d
  }
  return sum % 10 === 0
}

const PATTERNS: { kind: FindingKind, pattern: RegExp, accept?: (match: string) => boolean }[] = [
  { kind: 'card number', pattern: /(?<![\d])\d(?:[ -]?\d){12,18}(?![\d])/g, accept: m => luhn(m.replace(/\D/g, '')) },
  { kind: 'long number', pattern: /(?<![\d])\d{7,}(?![\d])/g },
  { kind: 'email address', pattern: /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu },
  { kind: 'phone number', pattern: /(?<![\d])(?:\+?1[ .-]?)?(?:\(\d{3}\)\s?|\d{3}[ .-])\d{3}[ .-]\d{4}(?![\d])/g },
  { kind: 'phone number', pattern: /\+\d{1,3}[ .-]?\d{2,4}[ .-]\d{3,4}[ .-]?\d{3,4}(?![\d])/g },
  { kind: 'postal code', pattern: /\b[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z][ -]?\d[ABCEGHJ-NPRSTV-Z]\d\b/gi },
  { kind: 'postal code', pattern: /\b[A-Z]{2}\s+\d{5}(?:-\d{4})?\b|\b\d{5}-\d{4}\b/g },
  { kind: 'postal code', pattern: /\b[A-Z]{1,2}\d[A-Z\d]?\s+\d[A-Z]{2}\b/g },
  { kind: 'social insurance or security number', pattern: /(?<![\d-])(?:\d{3}[- ]\d{3}[- ]\d{3}|\d{3}-\d{2}-\d{4})(?![\d-])/g },
  { kind: 'IBAN', pattern: /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g }
]

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * What the scan finds in an output. `replaced` holds the originals the run replaced (folded: lower case, no accents);
 * `allow` drops findings whose text, or the whole value around it, matches: for known false positives.
 */
export function scan(output: Scannable, replaced: Iterable<string> = [], allow: readonly RegExp[] = []): Finding[] {
  const { text, original, hidden } = output
  // The view: hidden characters blanked (line ends kept, for line numbers). Indexed as the text is, by UTF-16 unit
  const view = text.split('').map((ch, i) => hidden[i] && ch !== '\n' ? ' ' : ch).join('')
  const lineOf = (at: number) => text.slice(0, at).split('\n').length
  const found: (Finding & { end: number })[] = []
  /** The run of characters around [at, end) that the scan looks at and aren't spaces: structure (a QIF code, a CSV delimiter, a tag) ends it. */
  const tokenAround = (at: number, end: number) => {
    let from = at
    let to = end
    while (from > 0 && !/\s/.test(view[from - 1])) from--
    while (to < text.length && !/\s/.test(view[to])) to++
    return text.slice(from, to)
  }
  const add = (kind: FindingKind, at: number, found_: string) => {
    const token = tokenAround(at, at + found_.length)
    const allowed = (rule: RegExp) => { const r = new RegExp(rule.source, rule.flags.replace('g', '')); return r.test(found_) || r.test(token) }
    if (allow.some(allowed)) return
    if (found.some(f => f.kind === kind && f.at === at)) return
    found.push({ kind, line: lineOf(at), masked: mask(found_), text: found_, token, shape: shapeOf(token), at, end: at + found_.length })
  }

  // Every original the run replaced, as a whole word or number, anywhere it is looked at. Folded character by
  // character, so positions stay those of the text
  const folded = view.split('').map(ch => { const f = fold(ch); return f.length === 1 ? f : ch.toLowerCase() }).join('')
  for (const value of new Set(replaced)) {
    if (value.length < 4) continue
    const edge = /^[\p{L}\p{N}]/u.test(value) ? '(?<![\\p{L}\\p{N}])' : ''
    const end = /[\p{L}\p{N}]$/u.test(value) ? '(?![\\p{L}\\p{N}])' : ''
    for (const match of folded.matchAll(new RegExp(`${edge}${escape(value)}${end}`, 'gu'))) {
      add('replaced value', match.index!, text.slice(match.index!, match.index! + match[0].length))
    }
  }

  // The shapes of personal numbers, where a letter or digit of the match came from the original
  for (const { kind, pattern, accept } of PATTERNS) {
    for (const match of view.matchAll(pattern)) {
      const at = match.index!
      const fromOriginal = match[0].split('').some((ch, i) => /[\p{L}\p{N}]/u.test(ch) && original[at + i] === 1)
      if (fromOriginal && (!accept || accept(match[0]))) add(kind, at, match[0])
    }
  }
  // A long number inside something already found (a card number, an IBAN) says nothing more
  return found
    .filter(f => f.kind !== 'long number' || !found.some(o => o !== f && o.kind !== 'long number' && o.at <= f.at && o.end >= f.end))
    .sort((a, b) => a.at - b.at)
    .map(({ end: _, ...finding }) => finding)
}
