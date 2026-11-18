// `npm run anonymize` — a real bank file in, a fixture safe to commit out, and a loud failure in between if
// anything from the input could have survived. See docs/import-export-design.md, "The anonymiser".
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { anonymizeCsv } from './csv'
import { anonymizeOfx, type PolicyCounts } from './ofx'
import { anonymizeQif } from './qif'
import { checkCsvFile, checkFile, checkQifFile, verifyCsvOutput, verifyOutput, verifyQifOutput, type Verification } from './verify'
import { LEAF_POLICIES } from './policy'

export interface Options {
  input?: string
  output?: string
  seedFile?: string
  report?: string
  keepAmounts: boolean
  check?: string
  quiet: boolean
  help: boolean
}

export interface Io {
  log(line: string): void
  error(line: string): void
}

// `.aso` is Microsoft Money's old extension for a plain OFX download
const FORMATS: Record<string, string> = {
  '.ofx': 'exchange-ofx.ofx', '.aso': 'exchange-ofx.ofx', '.qfx': 'exchange-ofx.qfx', '.qbo': 'exchange-ofx.qbo',
  '.csv': 'exchange-csv.csv', '.qif': 'exchange-qif.qif'
}
const isCsv = (formatId: string) => formatId === 'exchange-csv.csv'
const isQif = (formatId: string) => formatId === 'exchange-qif.qif'

export function parseArgs(argv: readonly string[]): Options {
  const options: Options = { keepAmounts: false, quiet: false, help: false }
  const positional: string[] = []
  for (let at = 0; at < argv.length; at += 1) {
    const arg = argv[at]
    const value = () => {
      const next = argv[++at]
      if (next === undefined) throw new Error(`${arg} needs a value`)
      return next
    }
    if (arg === '--seed-file') options.seedFile = value()
    else if (arg === '--report') options.report = value()
    else if (arg === '--check') options.check = value()
    else if (arg === '--keep-amounts') options.keepAmounts = true
    else if (arg === '--quiet') options.quiet = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else if (arg.startsWith('--')) throw new Error(`Unknown option ${arg}`)
    else positional.push(arg)
  }
  if (positional.length > 2) throw new Error('Expected an input file and an output file, nothing more')
  if (positional[0] !== undefined) options.input = positional[0]
  if (positional[1] !== undefined) options.output = positional[1]
  return options
}

export const usage = () => `Usage:
  npm run anonymize -- <statement> <fixture>          anonymise one file (OFX, QFX, QBO, ASO, QIF or CSV)
  npm run anonymize -- --check <file-or-folder>       verify committed fixtures: patterns and parsing
Options:
  --seed-file <path>   the secret seed; created if missing, never written anywhere else (keep it gitignored)
  --report <path>      write a JSON report: counts and tag names, never values
  --keep-amounts       leave amounts as they are (for debugging a parser; refused under tests/)
  --quiet              only problems

Read the output before committing it. The tool is a check, not an authority.`

/** The seed: the file's bytes, created with fresh random bytes when it does not exist; else fresh bytes, discarded. */
function seedFrom(file: string | undefined): Uint8Array {
  if (file === undefined) return randomBytes(32)
  const resolved = path.resolve(file)
  if (fs.existsSync(resolved)) return fs.readFileSync(resolved)
  const seed = randomBytes(32)
  fs.mkdirSync(path.dirname(resolved), { recursive: true })
  fs.writeFileSync(resolved, seed, { mode: 0o600 })
  return seed
}

const formatOf = (file: string): string => {
  const format = FORMATS[path.extname(file).toLowerCase()]
  if (format === undefined) {
    throw new Error(`“${path.basename(file)}”: only OFX, QFX, QBO, ASO, QIF and CSV files can be anonymised.`)
  }
  return format
}

/** `--check`: every statement-shaped file under a path, or the one file, against the checks needing no input. */
export function check(target: string, io: Io): number {
  const resolved = path.resolve(target)
  const files = fs.statSync(resolved).isDirectory()
    ? fs.readdirSync(resolved, { recursive: true, withFileTypes: true })
      .filter(entry => entry.isFile() && FORMATS[path.extname(entry.name).toLowerCase()] !== undefined)
      .map(entry => path.join(entry.parentPath, entry.name))
    : [resolved]
  let failures = 0
  for (const file of files) {
    const format = formatOf(file)
    const result = isCsv(format) ? checkCsvFile(fs.readFileSync(file)) : isQif(format) ? checkQifFile(fs.readFileSync(file)) : checkFile(fs.readFileSync(file), format)
    if (result.ok) { io.log(`ok       ${path.relative(process.cwd(), file)}`); continue }
    failures += 1
    io.error(`FAILED   ${path.relative(process.cwd(), file)}`)
    for (const problem of result.problems) io.error(`         ${problem}`)
  }
  if (files.length === 0) io.log('No statement files found.')
  return failures === 0 ? 0 : 1
}

export async function main(argv: readonly string[], io: Io = { log: console.log, error: console.error }): Promise<number> {
  let options: Options
  try {
    options = parseArgs(argv)
  } catch (err) {
    io.error(err instanceof Error ? err.message : String(err))
    io.error(usage())
    return 2
  }
  if (options.help) { io.log(usage()); return 0 }
  if (options.check !== undefined) return check(options.check, io)
  if (options.input === undefined || options.output === undefined) { io.error(usage()); return 2 }

  const input = path.resolve(options.input)
  const output = path.resolve(options.output)
  const formatId = formatOf(input)
  const insideTests = output.startsWith(path.resolve('tests') + path.sep)

  if (options.keepAmounts) {
    io.error('WARNING: --keep-amounts leaves the real amounts in the output. A recurring figure identifies a salary or a rent.')
    if (insideTests) { io.error('Refusing to write a file with real amounts under tests/.'); return 1 }
  }

  const data = fs.readFileSync(input)
  const seed = seedFrom(options.seedFile)
  let result: { output: Uint8Array, text: string, counts: PolicyCounts, unrecognised: { tag: string, count: number }[], records: number }
  let verification: Verification
  if (isQif(formatId)) {
    const qif = anonymizeQif(data, { seed, keepAmounts: options.keepAmounts })
    result = { ...qif, records: qif.shape.blocks.reduce((n, b) => n + b.length, 0) }
    verification = verifyQifOutput({ input: data, outputText: qif.text, sensitive: qif.sensitive, sensitiveTags: qif.sensitiveTags, unrecognised: qif.unrecognised })
  } else if (isCsv(formatId)) {
    const csv = anonymizeCsv(data, { seed, keepAmounts: options.keepAmounts })
    result = { ...csv, records: csv.shape.rows }
    verification = verifyCsvOutput({ input: data, output: csv.output, outputText: csv.text, sensitive: csv.sensitive, sensitiveTags: csv.sensitiveTags })
    if (!options.quiet) io.log(`Columns: ${csv.columns.map(c => `${c.name}→${c.role}`).join(', ')}`)
  } else {
    const ofx = anonymizeOfx(data, { seed, keepAmounts: options.keepAmounts })
    result = { ...ofx, records: ofx.inputTags.get('STMTTRN') ?? 0 }
    const dropped = new Set([
      ...Object.entries(LEAF_POLICIES).filter(([, p]) => p.kind === 'drop').map(([tag]) => tag),
      ...ofx.unrecognised.map(u => u.tag)
    ])
    verification = verifyOutput({
      input: data, output: ofx.output, outputText: ofx.text, sensitive: ofx.sensitive, sensitiveTags: ofx.sensitiveTags, formatId,
      structure: { inputTags: ofx.inputTags, outputTags: ofx.tags, dropped }
    })
  }

  if (options.report !== undefined) {
    const report = {
      input: { format: formatId, bytes: data.byteLength, records: result.records },
      policies: result.counts,
      unrecognised: result.unrecognised,
      verification: {
        substringMatches: verification.substringMatches, patternMatches: verification.patternMatches,
        parsed: verification.parsed, structureMatched: verification.structureMatched
      },
      dateShiftDays: '(not recorded)',
      seed: '(not recorded)'
    }
    fs.mkdirSync(path.dirname(path.resolve(options.report)), { recursive: true })
    fs.writeFileSync(path.resolve(options.report), JSON.stringify(report, null, 2) + '\n')
  }

  if (verification.problems.length > 0) {
    io.error(`Not written: ${path.relative(process.cwd(), output)}`)
    for (const problem of verification.problems) io.error(`  ${problem}`)
    return 1
  }

  fs.mkdirSync(path.dirname(output), { recursive: true })
  fs.writeFileSync(output, result.output)

  if (!options.quiet) {
    const c = result.counts
    io.log(`Wrote ${path.relative(process.cwd(), output)} (${result.output.byteLength} bytes)`)
    io.log(`  ${c.structural} structural, ${c.enum} enum, ${c.synthetic} synthetic, ${c.shifted} shifted, ${c.drop} dropped`)
    if (result.unrecognised.length > 0) {
      io.log('  Dropped as unrecognised (add a policy if any of these carries meaning):')
      for (const { tag, count } of result.unrecognised) io.log(`    ${tag} × ${count}`)
    }
    io.log('  Read the output before committing it.')
  }
  return 0
}
