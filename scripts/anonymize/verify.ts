// The verification pass: what makes the tool trustworthy, and it always runs. The output is re-read and the
// run fails if anything from the input survived, if anything identifying-shaped is present at all, if the
// result does not parse as the format it claims to be, or if its structure differs from the input's.
import { readOfx } from '../../plugins/exchange.ofx/src/privileged/index'
import { csvShape } from './csv'
import { qifShape, sameQifStructure, type QifShape } from './qif'
import { luhnValid } from './derive'

export interface Verification {
  substringMatches: number
  patternMatches: number
  parsed: boolean
  structureMatched: boolean
  /** What went wrong, in words, without values. */
  problems: string[]
}

/** Countries that issue IBANs, so a hex reference starting with two letters is not mistaken for one. */
const IBAN_COUNTRIES = new Set(('AD AE AL AT AZ BA BE BG BH BR BY CH CR CY CZ DE DK DO EE EG ES FI FO FR GB GE GI GL GR GT HR HU IE IL IQ IS ' +
  'IT JO KW KZ LB LC LI LT LU LV MC MD ME MK MR MT MU NL NO PK PL PS PT QA RO RS SA SC SE SI SK SM ST SV TL TN TR UA VA VG XK').split(' '))

/** An IBAN: a registered country, and the mod-97 check the standard defines. */
export function ibanValid(candidate: string): boolean {
  if (!IBAN_COUNTRIES.has(candidate.slice(0, 2)) || candidate.length < 15 || candidate.length > 34) return false
  const rearranged = candidate.slice(4) + candidate.slice(0, 4)
  let remainder = 0
  for (const char of rearranged) {
    const piece = /[A-Z]/.test(char) ? String(char.charCodeAt(0) - 55) : char
    for (const digit of piece) remainder = (remainder * 10 + Number(digit)) % 97
  }
  return remainder === 1
}

/** A 14-digit run that reads as `YYYYMMDDHHMMSS`: an OFX timestamp, which passes Luhn one time in ten by chance. */
export function looksLikeTimestamp(run: string): boolean {
  if (run.length !== 14 || !/^(19|20)\d{2}/.test(run)) return false
  const month = Number(run.slice(4, 6)), day = Number(run.slice(6, 8))
  const hour = Number(run.slice(8, 10)), minute = Number(run.slice(10, 12)), second = Number(run.slice(12, 14))
  return month >= 1 && month <= 12 && day >= 1 && day <= 31 && hour < 24 && minute < 60 && second < 60
}

/** Shapes that identify a person whether or not the input held them. Each is named, never shown. */
export const PATTERNS: { name: string, test: (text: string) => number }[] = [
  {
    name: 'a Luhn-valid 13–19 digit run (a card number)',
    test: text => (text.match(/\d{13,19}/g) ?? []).filter(run => !looksLikeTimestamp(run) && luhnValid(run)).length
  },
  {
    name: 'an email address',
    // Addresses at the domains RFC 2606 reserves for examples identify nobody, and the seeded fixtures use one
    test: text => (text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? [])
      .filter(address => !/@(?:[a-z0-9-]+\.)*(?:example\.(?:com|net|org)|[a-z0-9-]+\.(?:invalid|test|example))$/i.test(address)).length
  },
  { name: 'an international phone number', test: text => (text.match(/\+\d{1,3}[\s.-]?\(?\d{2,4}\)?[\s.-]?\d{3}[\s.-]?\d{3,4}\b/g) ?? []).length },
  { name: 'a Canadian postal code', test: text => (text.match(/\b[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z][ -]?\d[ABCEGHJ-NPRSTV-Z]\d\b/g) ?? []).length },
  { name: 'a US ZIP+4 code', test: text => (text.match(/\b\d{5}-\d{4}\b/g) ?? []).length },
  { name: 'an IBAN', test: text => (text.match(/\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g) ?? []).filter(ibanValid).length },
  { name: 'a SIN or SSN', test: text => (text.match(/\b\d{3}[- ]\d{3}[- ]\d{3}\b|\b\d{3}-\d{2}-\d{4}\b/g) ?? []).length },
  { name: 'a street address', test: text => (text.match(/\b\d{1,6}\s+[A-Z][a-z]+(\s[A-Z][a-z]+)?\s(Street|St|Avenue|Ave|Road|Rd|Drive|Dr|Boulevard|Blvd|Lane|Ln|Crescent|Cres|Court|Ct|Way|Place|Pl)\b\.?/g) ?? []).length },
  { name: 'a URL with a query string', test: text => (text.match(/https?:\/\/\S+\?\S+/g) ?? []).length }
]

/** Patterns over a text, as counts by name — no values. */
export function patternMatches(text: string): { name: string, count: number }[] {
  return PATTERNS.map(p => ({ name: p.name, count: p.test(text) })).filter(p => p.count > 0)
}

export interface StructureInput {
  inputTags: ReadonlyMap<string, number>
  outputTags: ReadonlyMap<string, number>
  /** Tags the policy dropped, which are allowed to be missing. */
  dropped: ReadonlySet<string>
}

/**
 * Checks an anonymised output against its input: nothing sensitive survived, nothing identifying-shaped is
 * present, it parses, and its structure — statements, rows, tags — is the input's.
 */
/** A value's shape with nothing of its content: letters as A, digits as 9, the rest as written. */
export const shapeOf = (value: string) => value.replace(/[A-Za-z]/g, 'A').replace(/\d/g, '9')

/** Survivors, each named by where it came from and what it looked like — never by what it was. */
/**
 * Text with the separators *inside* a token removed — spaces, dashes, dots, slashes between letters or digits —
 * so `0012-3456789`, `0012 3456789` and `00123456789` all read the same. Cell delimiters, quotes and line
 * breaks are left alone, so two neighbouring cells cannot run together into a false match.
 */
const squash = (text: string) => text.toLowerCase().replace(/([a-z0-9])[\s\-./]+(?=[a-z0-9])/g, '$1')

/** Six or more digits: an account, card or reference number, which an exporter may reformat. */
const identifierLike = (value: string) => (value.match(/\d/g)?.length ?? 0) >= 6

function survivors(outputText: string, sensitive: ReadonlySet<string>, tags?: ReadonlyMap<string, string>): string[] {
  const lower = outputText.toLowerCase()
  const squashed = squash(outputText)
  const found: string[] = []
  for (const value of sensitive) {
    // An exact copy, or — for an identifier — the same characters with different separators, which is how an
    // account number reappears in a memo or a reference field that a bank formats its own way.
    const exact = lower.includes(value.toLowerCase())
    const reformatted = !exact && identifierLike(value) && squashed.includes(squash(value))
    if (!exact && !reformatted) continue
    const tag = tags?.get(value)
    found.push(`${tag === undefined ? 'a value' : `a <${tag}> value`} of ${value.length} characters, shaped “${shapeOf(value).slice(0, 40)}”`)
  }
  return found
}

/** For each pattern hit, the tag whose value holds it, so a rule can be aimed at the right field. */
function patternHomes(outputText: string): string[] {
  const homes: string[] = []
  for (const match of outputText.matchAll(/<([A-Za-z.]+)>([^<\r\n]+)/g)) {
    for (const p of patternMatches(match[2])) homes.push(`<${match[1]}> holds ${p.name}`)
  }
  return [...new Set(homes)]
}

export function verifyOutput(args: {
  input: Uint8Array
  output: Uint8Array
  outputText: string
  sensitive: ReadonlySet<string>
  sensitiveTags?: ReadonlyMap<string, string>
  formatId: string
  structure: StructureInput
}): Verification {
  const problems: string[] = []

  const survived = survivors(args.outputText, args.sensitive, args.sensitiveTags)
  const substringMatches = survived.length
  if (substringMatches > 0) {
    problems.push(`${substringMatches} value${substringMatches === 1 ? '' : 's'} from the input survived into the output`)
    for (const line of survived.slice(0, 10)) problems.push(`  ${line}`)
  }

  const patterns = patternMatches(args.outputText)
  const patternCount = patterns.reduce((n, p) => n + p.count, 0)
  for (const p of patterns) problems.push(`the output contains ${p.name} (${p.count})`)
  for (const home of patternHomes(args.outputText).slice(0, 10)) problems.push(`  ${home}`)

  let parsed = false
  let structureMatched = false
  try {
    const before = readOfx(args.input, { formatId: args.formatId })
    const after = readOfx(args.output, { formatId: args.formatId })
    parsed = true
    const rows = (doc: typeof after) => doc.statements.reduce((n, s) => n + s.transactions.length, 0)
    structureMatched = before.statements.length === after.statements.length && rows(before) === rows(after)
    if (!structureMatched) problems.push(`the output has ${after.statements.length} statements and ${rows(after)} rows; the input had ${before.statements.length} and ${rows(before)}`)
    for (const [tag, count] of args.structure.inputTags) {
      const kept = args.structure.outputTags.get(tag) ?? 0
      if (kept !== count && !args.structure.dropped.has(tag)) {
        structureMatched = false
        problems.push(`<${tag}> appears ${count} times in the input and ${kept} in the output`)
      }
    }
  } catch (err) {
    problems.push(`the output does not parse: ${err instanceof Error ? err.message : String(err)}`)
  }

  return { substringMatches, patternMatches: patternCount, parsed, structureMatched, problems }
}

/** The checks that need no input: over a file already committed. */
export function checkFile(data: Uint8Array, formatId: string): { ok: boolean, problems: string[] } {
  const problems: string[] = []
  const text = new TextDecoder('latin1').decode(data)
  for (const p of patternMatches(text)) problems.push(`contains ${p.name} (${p.count})`)
  try {
    const doc = readOfx(data, { formatId })
    if (doc.statements.length === 0) problems.push('holds no statements')
  } catch (err) {
    problems.push(`does not parse: ${err instanceof Error ? err.message : String(err)}`)
  }
  return { ok: problems.length === 0, problems }
}

/** The same checks for a CSV, which has no reader yet: patterns, substrings, and the rows and fields match. */
export function verifyCsvOutput(args: {
  input: Uint8Array
  outputText: string
  output: Uint8Array
  sensitive: ReadonlySet<string>
  sensitiveTags?: ReadonlyMap<string, string>
}): Verification {
  const problems: string[] = []
  const survived = survivors(args.outputText, args.sensitive, args.sensitiveTags)
  const substringMatches = survived.length
  if (substringMatches > 0) {
    problems.push(`${substringMatches} value${substringMatches === 1 ? '' : 's'} from the input survived into the output`)
    for (const line of survived.slice(0, 10)) problems.push(`  ${line}`)
  }
  const patterns = patternMatches(args.outputText)
  for (const p of patterns) problems.push(`the output contains ${p.name} (${p.count})`)
  const before = csvShape(args.input)
  const after = csvShape(args.output)
  const structureMatched = before.rows === after.rows && before.header === after.header &&
    before.fields.every((n, i) => after.fields[i] === n)
  if (!structureMatched) problems.push(`the output has ${after.rows} rows; the input had ${before.rows}, or a row's fields differ`)
  return { substringMatches, patternMatches: patterns.reduce((n, p) => n + p.count, 0), parsed: after.rows > 0, structureMatched, problems }
}

/** `--check` for a CSV: patterns, and that it still reads as rows. */
export function checkCsvFile(data: Uint8Array): { ok: boolean, problems: string[] } {
  const problems: string[] = []
  const text = new TextDecoder('utf-8').decode(data)
  for (const p of patternMatches(text)) problems.push(`contains ${p.name} (${p.count})`)
  const shape = csvShape(data)
  if (shape.rows === 0) problems.push('holds no rows')
  return { ok: problems.length === 0, problems }
}

/** The checks for a QIF, which has no reader yet: patterns, substrings, and the blocks and records match. */
export function verifyQifOutput(args: {
  input: Uint8Array
  outputText: string
  sensitive: ReadonlySet<string>
  sensitiveTags?: ReadonlyMap<string, string>
  /** What the anonymiser could not place, so a record that lost those codes is still the same record. */
  unrecognised: readonly { tag: string, count: number }[]
}): Verification {
  const problems: string[] = []
  const survived = survivors(args.outputText, args.sensitive, args.sensitiveTags)
  const substringMatches = survived.length
  if (substringMatches > 0) {
    problems.push(`${substringMatches} value${substringMatches === 1 ? '' : 's'} from the input survived into the output`)
    for (const line of survived.slice(0, 10)) problems.push(`  ${line}`)
  }
  const patterns = patternMatches(args.outputText)
  for (const p of patterns) problems.push(`the output contains ${p.name} (${p.count})`)
  let inputText: string
  try { inputText = new TextDecoder('utf-8', { fatal: true }).decode(args.input) } catch { inputText = new TextDecoder('windows-1252').decode(args.input) }
  const before: QifShape = qifShape(inputText)
  const after = qifShape(args.outputText)
  const structure = sameQifStructure(before, after, args.unrecognised)
  problems.push(...structure)
  const records = after.blocks.reduce((n, b) => n + b.length, 0)
  return { substringMatches, patternMatches: patterns.reduce((n, p) => n + p.count, 0), parsed: records > 0, structureMatched: structure.length === 0, problems }
}

/** `--check` for a QIF: patterns, and that it still reads as records. */
export function checkQifFile(data: Uint8Array): { ok: boolean, problems: string[] } {
  const problems: string[] = []
  const text = new TextDecoder('windows-1252').decode(data)
  for (const p of patternMatches(text)) problems.push(`contains ${p.name} (${p.count})`)
  if (qifShape(text).blocks.reduce((n, b) => n + b.length, 0) === 0) problems.push('holds no records')
  return { ok: problems.length === 0, problems }
}
