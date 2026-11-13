// Pure helpers for the export manager and file-type plugins' writers: amounts as exact text (never floating point),
// text in the encodings files need, file names every system accepts, and format options made whole and checked.
// See docs/export-design.md, "The contract".
import type { ExportOptionField, ExportOptions } from './contract'

/**
 * Minor units as a canonical decimal, exactly: (-8412, 2) → '-84.12', (1200, 0) → '1200', (5, 3) → '0.005'. Integers
 * only: `formatAmount` divides in floating point, which is fine on screen and wrong in a file.
 */
export function minorToDecimal(minor: number, digits: number): string {
  if (!Number.isSafeInteger(minor)) throw new RangeError(`${minor} isn't a whole number of minor units`)
  const sign = minor < 0 ? '-' : ''
  const text = String(Math.abs(minor)).padStart(digits + 1, '0')
  return digits === 0 ? sign + text : `${sign}${text.slice(0, -digits)}.${text.slice(-digits)}`
}

/** A canonical decimal with a comma for its separator, for files that want one: '-84.12' → '-84,12'. */
export const withDecimalComma = (canonical: string): string => canonical.replace('.', ',')

/** windows-1252's 0x80–0x9F, by code point (-1 where it has none). The rest of 0x00–0xFF is the code point itself. */
const HIGH_1252 = [
  0x20ac, -1, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, -1, 0x017d, -1,
  -1, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, -1, 0x017e, 0x0178
]
const TO_1252 = new Map<number, number>(HIGH_1252.flatMap((cp, i) => cp === -1 ? [] : [[cp, 0x80 + i] as [number, number]]))
const byte1252 = (cp: number): number | undefined => cp < 0x80 || (cp >= 0xa0 && cp <= 0xff) ? cp : TO_1252.get(cp)

/**
 * Letters Unicode gives no decomposition, but an obvious base letter. Reducing to a base letter by decomposition alone
 * turns 'Łódź' into '?ódz' (found in phase X0); with these it is 'Lódz'.
 */
const BASE_LETTERS: Readonly<Record<string, string>> = {
  Ł: 'L', ł: 'l', Đ: 'D', đ: 'd', Ħ: 'H', ħ: 'h', ı: 'i', Ŀ: 'L', ŀ: 'l', Ŧ: 'T', ŧ: 't', ĸ: 'k'
}

export type TextEncoding = 'utf-8' | 'windows-1252'

/**
 * Text as a file's bytes. UTF-8, with a byte-order mark when `bom` is set (how Excel knows a CSV is UTF-8). Or
 * windows-1252, as Money and Quicken expect: a character it can't hold becomes its base letter where there is one
 * ('ő' → 'o', 'Ł' → 'L'), else '?'. `replaced` counts those characters, for a warning.
 */
export function encodeText(text: string, encoding: TextEncoding, options: { bom?: boolean } = {}): { bytes: Uint8Array, replaced: number } {
  if (encoding === 'utf-8') {
    const body = new TextEncoder().encode(text)
    if (!options.bom) return { bytes: body, replaced: 0 }
    const bytes = new Uint8Array(body.length + 3)
    bytes.set([0xef, 0xbb, 0xbf])
    bytes.set(body, 3)
    return { bytes, replaced: 0 }
  }
  // One byte per character, written straight into a buffer (grown when a replacement is longer than what it
  // replaces): a 100,000-row file takes a quarter of the time an array of numbers did
  let out = new Uint8Array(text.length + 16)
  let n = 0
  const push = (byte: number) => {
    if (n === out.length) { const bigger = new Uint8Array(out.length * 2); bigger.set(out); out = bigger }
    out[n++] = byte
  }
  let replaced = 0
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i)
    if (unit < 0x80 || (unit >= 0xa0 && unit <= 0xff)) { push(unit); continue }
    const cp = text.codePointAt(i)!
    if (cp > 0xffff) i++                                   // the second half of a surrogate pair
    const mapped = TO_1252.get(cp)
    if (mapped !== undefined) { push(mapped); continue }
    replaced++
    const ch = String.fromCodePoint(cp)
    const base = BASE_LETTERS[ch] ?? ch.normalize('NFKD').replace(/\p{M}/gu, '')
    const bytes = [...base].map(c => byte1252(c.codePointAt(0)!))
    if (base !== '' && bytes.every(b => b !== undefined)) for (const b of bytes as number[]) push(b)
    else push(0x3f)
  }
  return { bytes: out.slice(0, n), replaced }
}

/** Names Windows keeps for devices, which no file may have, whatever its extension. */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/**
 * A file name (without its folder) every system accepts: no '<>:"/\|?*' or control characters, no spaces or dots at
 * the end, not a name Windows keeps for a device, at most 150 characters. 'Export' when nothing is left.
 */
export function safeFileName(name: string): string {
  let safe = name.replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '-').replace(/\s+/g, ' ').trim()
  safe = safe.slice(0, 150).replace(/[ .]+$/, '')
  if (safe === '') return 'Export'
  return RESERVED.test(safe.split('.')[0]) ? `_${safe}` : safe
}

/** True when `value` is a valid value of `field`. */
export function isValidOption(field: ExportOptionField, value: unknown): boolean {
  switch (field.kind) {
    case 'choice': return typeof value === 'string' && field.options.some(o => o.value === value)
    case 'boolean': return typeof value === 'boolean'
    case 'text': return typeof value === 'string' && (field.maxLength === undefined || value.length <= field.maxLength)
  }
}

/**
 * A format's options made whole: every field it declares, with the value given when it is valid, else the field's
 * default. Keys it doesn't declare are dropped. What a format is given is always this.
 */
export function resolveOptions(fields: readonly ExportOptionField[] | undefined, given: Readonly<Record<string, unknown>> | undefined): ExportOptions {
  const options: ExportOptions = {}
  for (const field of fields ?? []) {
    const value = given?.[field.key]
    options[field.key] = isValidOption(field, value) ? value as string | boolean : field.default
  }
  return options
}

/** What stops `options` being used, in words: a required text left empty. */
export function optionProblems(fields: readonly ExportOptionField[] | undefined, options: ExportOptions): string[] {
  return (fields ?? []).flatMap(field =>
    field.kind === 'text' && field.required && String(options[field.key] ?? '').trim() === '' ? [`Enter the ${field.label.toLowerCase()}.`] : [])
}
