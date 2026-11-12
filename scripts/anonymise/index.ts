// The anonymiser: real statement files with the personal data taken out and their dialect kept, so they can be added
// to the tests. Files given together share one mapping (the same payee gets the same made-up name in each), so
// overlapping statements still overlap. Each output is scanned, and one in which anything still looks personal isn't
// given back to be written. `npm run anonymise` (scripts/anonymise.mts) is the command line.
// OFX, QFX, QBO, CSV and QIF (docs/import-formats-design.md, "Anonymising real statement files").
import path from 'node:path'
import { Amounts, type Factors } from './amounts'
import { checkableCsv, isCsvName, prepareCsv, rewriteCsv, type PreparedCsv } from './csv'
import { checkableQif, isQif, prepareQif, rewriteQif, type PreparedQif } from './qif'
import { decodeFile, sidecarFor, type Sidecar } from './encoding'
import { checkableOfx, isOfx, noCounts, ofxEncoding, prepareOfx, rewriteOfx, type BalanceMapping, type OfxCounts, type PreparedOfx } from './ofx'
import { seeded } from './random'
import { detectDelimiter, parseCsv } from '../../plugins/import-csv/src/shared/csv'
import { scan, type Finding } from './scan'
import { Pseudonyms, emptyWords, type WordMapping } from './words'

export { encodeAs, type Sidecar } from './encoding'
export { likeRule, shapeOf, type Finding } from './scan'

/** Everything a run made up, and from what: keep it only outside the repository (`--map`). */
export interface Mapping {
  version: 1
  words: WordMapping
  factors: Factors
  balances: BalanceMapping
}

export const emptyMapping = (): Mapping => ({ version: 1, words: emptyWords(), factors: {}, balances: {} })

export interface AnonymiseOptions {
  /** Leave amounts as they are. */
  keepAmounts?: boolean
  /** Move every date by this many weeks. */
  shiftWeeks?: number
  /** Replace the bank's name and ids too. */
  hideInstitution?: boolean
  /** Words to leave as they are (well-known merchants, say). */
  keepWords?: readonly string[]
  /** Findings whose text matches are dropped (known false positives). */
  allow?: readonly RegExp[]
  /** A mapping from an earlier run, to anonymise more files the same way. Updated in place. */
  mapping?: Mapping
  /** For tests: the same output every time. */
  seed?: number
  /** For tests: today, which decides how two-digit years are read. */
  today?: Date
}

export interface InputFile {
  name: string
  bytes: Uint8Array
}

export interface Output {
  /** The input's name. */
  name: string
  /** '<name>.anon.<ext>'. */
  outputName: string
  /** The anonymised file, as UTF-8 text. */
  text: string
  /** How the original was encoded, when the UTF-8 text isn't that; written as '<outputName>.meta.json'. */
  sidecar?: Sidecar
  /** What the scan found. When there is anything, the file must not be written. */
  findings: Located[]
  /** What the scan found that the user allowed (`allow`): written as it is. */
  allowed?: Located[]
  counts: OfxCounts
  /** What the user should know about the output (dates moved so their order reads differently). */
  notes?: string[]
  /** Why the file couldn't be anonymised, if it couldn't. */
  error?: string
}

/** A finding, with where it is in its file when that can be said without showing it: 'the N field', 'column 4'. */
export type Located = Finding & { where?: string }

/** QIF's field codes, as the report names them. */
const QIF_FIELDS: Record<string, string> = {
  D: 'date', T: 'amount', U: 'amount', P: 'payee', M: 'memo', N: 'number', L: 'category', C: 'cleared', A: 'address',
  S: 'split category', E: 'split memo', $: 'split amount', K: 'kind', Y: 'security', Q: 'quantity', I: 'price', O: 'commission'
}

/** Where a finding is: a QIF line's field, a CSV line's column, or an OFX value's tag. Only structure is shown. */
function whereOf(kind: 'ofx' | 'csv' | 'qif', text: string, at: number): string | undefined {
  const lineStart = text.lastIndexOf('\n', at - 1) + 1
  const lineEnd = text.indexOf('\n', at)
  const line = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd).replace(/\r$/, '')
  if (kind === 'qif') {
    const code = line[0]
    if (!code || code === '!' || code === '^') return undefined
    return `the ${code} field${QIF_FIELDS[code] ? ` (${QIF_FIELDS[code]})` : ''}`
  }
  if (kind === 'csv') {
    const cells = parseCsv(line, detectDelimiter(text))[0]?.cells ?? []
    const index = cells.findIndex(c => at - lineStart >= c.start && at - lineStart < c.end)
    return index === -1 ? undefined : `column ${index + 1}`
  }
  // The value's tag: the last one before it, with nothing but the value between
  const before = text.slice(0, at)
  const open = /<([A-Za-z][\w.]*)>[^<]*$/.exec(before)
  return open ? `<${open[1]}>` : undefined
}

const locate = (kind: 'ofx' | 'csv' | 'qif', text: string, findings: Finding[]): Located[] =>
  findings.map(f => { const where = whereOf(kind, text, f.at); return where ? { ...f, where } : f })

/** '<name>.anon.<ext>' for a file's name. */
export function outputName(name: string): string {
  const ext = path.extname(name)
  return `${name.slice(0, name.length - ext.length)}.anon${ext}`
}

const kindOf = (name: string, text: string): 'ofx' | 'csv' | 'qif' | undefined =>
  /\.(ofx|qfx|qbo)$/i.test(name) || isOfx(text) ? 'ofx' : isQif(name, text) ? 'qif' : isCsvName(name) ? 'csv' : undefined

const notSupported = (name: string) =>
  `${name} can't be anonymised: only OFX, QFX, QBO, CSV and QIF files can.`

/** How a file is decoded: OFX by the encoding its header declares; anything else by its bytes. */
const decodeAny = (file: InputFile) => decodeFile(file.bytes, /\.(ofx|qfx|qbo)$/i.test(file.name) ? ofxEncoding(file.bytes) : undefined)

/** Anonymises files together, sharing one mapping. */
export function anonymise(files: readonly InputFile[], options: AnonymiseOptions = {}): { outputs: Output[], mapping: Mapping } {
  const mapping = options.mapping ?? emptyMapping()
  const random = seeded(options.seed ?? Math.floor(Math.random() * 2 ** 31))
  const words = new Pseudonyms(random, mapping.words, options.keepWords)
  const amounts = new Amounts(random, mapping.factors, options.keepAmounts)
  const run = {
    words, amounts, balances: mapping.balances,
    options: { shiftDays: Math.round((options.shiftWeeks ?? 0) * 7), hideInstitution: options.hideInstitution ?? false, keepAmounts: options.keepAmounts ?? false }
  }

  const csvRun = { ...run, options: { shiftDays: run.options.shiftDays, keepAmounts: run.options.keepAmounts }, today: options.today ?? new Date() }

  // First every file is read, so nothing made up is any file's original, and balances know every file's lines
  type Prepared = { file: InputFile, decoded: ReturnType<typeof decodeFile>, ofx?: PreparedOfx, csv?: PreparedCsv, qif?: PreparedQif, error?: string }
  const prepared = files.map((file): Prepared => {
    const decoded = decodeAny(file)
    const kind = kindOf(file.name, decoded.text)
    if (!kind) return { file, decoded, error: notSupported(file.name) }
    try {
      if (kind === 'ofx') return { file, decoded, ofx: prepareOfx(decoded.text, run) }
      if (kind === 'qif') return { file, decoded, qif: prepareQif(decoded.text, csvRun) }
      return { file, decoded, csv: prepareCsv(decoded.text, csvRun) }
    } catch (err) {
      return { file, decoded, error: `${file.name} can't be anonymised: ${(err as Error).message}.` }
    }
  })

  const outputs = prepared.map(({ file, decoded, ofx, csv, qif, error }): Output => {
    const counts = noCounts()
    const base = { name: file.name, outputName: outputName(file.name), counts }
    if (error || (!ofx && !csv && !qif)) return { ...base, text: '', findings: [], error }
    let rewritten
    const notes: string[] = []
    try {
      rewritten = ofx ? rewriteOfx(ofx, run, counts) : qif ? rewriteQif(qif, csvRun, counts) : rewriteCsv(csv!, csvRun, counts, notes)
    } catch (err) {
      return { ...base, text: '', findings: [], error: `${file.name} can't be anonymised: ${(err as Error).message}.` }
    }
    const kind = ofx ? 'ofx' as const : qif ? 'qif' as const : 'csv' as const
    const findings = locate(kind, rewritten.text, scan(rewritten, words.replaced, options.allow))
    // What the user allowed: found without the allowances, and not with them
    const everything = options.allow?.length ? scan(rewritten, words.replaced) : []
    const allowed = locate(kind, rewritten.text, everything.filter(f => !findings.some(g => g.at === f.at && g.kind === f.kind)))
    const sidecar = sidecarFor(decoded, rewritten.text)
    return {
      ...base, text: rewritten.text, findings, ...(allowed.length > 0 && { allowed }), ...(sidecar && { sidecar }),
      ...(notes.length > 0 && { notes })
    }
  })
  return { outputs, mapping }
}

/** True for a name the anonymiser gives its output: '<name>.anon.<ext>'. */
export const isAnonymised = (name: string) => /\.anon\.[^.]+$/i.test(name)

/**
 * Scans files without changing them (`--check`): what looks personal in each. A file named as the anonymiser names its
 * output ('*.anon.*') is checked as one: only what the anonymiser keeps as it was is looked at (see `checkableOfx` and
 * `checkableCsv`).
 */
export function check(files: readonly InputFile[], options: { allow?: readonly RegExp[] } = {}): { name: string, findings: Located[], error?: string }[] {
  return files.map(file => {
    const decoded = decodeAny(file)
    const kind = kindOf(file.name, decoded.text)
    if (!kind) return { name: file.name, findings: [], error: notSupported(file.name) }
    const anonymised = isAnonymised(file.name)
    const checkable = kind === 'ofx' ? checkableOfx(decoded.text, { anonymised })
      : kind === 'qif' ? checkableQif(decoded.text, { anonymised }) : checkableCsv(decoded.text, { anonymised })
    return { name: file.name, findings: locate(kind, decoded.text, scan(checkable, [], options.allow)) }
  })
}

/** What a file's anonymising replaced, in words, never the values: '1 account number, 17 payees, …'. */
export function describeCounts(counts: OfxCounts): string {
  const n = (count: number, one: string, many = `${one}s`) => count > 0 ? [`${count} ${count === 1 ? one : many}`] : []
  const parts = [
    ...n(counts.accountNumbers, 'account number'), ...n(counts.ids, 'id'), ...n(counts.payees, 'payee'), ...n(counts.memos, 'memo'),
    ...n(counts.otherText, 'other text value'), ...n(counts.amounts, 'amount'), ...n(counts.dates, 'date moved', 'dates moved')
  ]
  const balances = counts.balances > 0 ? `; ${counts.balances} ${counts.balances === 1 ? 'balance' : 'balances'} worked out again from the changed lines` : ''
  return parts.length > 0 ? `${parts.join(', ')} replaced${balances}` : 'nothing to replace'
}
