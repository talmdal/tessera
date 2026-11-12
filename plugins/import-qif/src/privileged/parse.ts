// Reading a QIF file: its sections and records, its accounts, the file's date order and decimal separator (decided
// from every date and amount together, or remembered for its source, or asked in QIF Options when the file can be read
// two ways), then a statement per account. What is decided is remembered per statement key, as `options:<key>`; the
// sign cross-check's reversal lands there too (`correct`). See docs/import-formats-design.md, "QIF", and "Phase F5".
import {
  ImportError, canonicalDecimal, guessDecimal,
  type DateOrder, type DecimalSeparator, type FormatCorrection, type FormatMemory, type ImportFile, type ParseContext,
  type ParsedStatement, type ParseResult, type ParseWarning, type RememberedDescription
} from '@tessera/import-api'
import { OPTIONS_DIALOG, type OptionsDialogInput, type OptionsDialogResult, type QifChoice, type QifOptions } from '../shared/options'
import { likeliestOrder, plainDate, qifDate, qifDateOrders } from './dates'
import { parseQif } from './qif'
import { accountName, collect, identify, readStatement, samplesOf } from './statements'

export const optionsKey = (key: string) => `options:${key}`

export interface QifFormatOptions {
  /** Today, for two-digit years. */
  now?: () => Date
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const inWords = (iso: string) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}, ${iso.slice(0, 4)}`
const ORDER_NAMES: Record<DateOrder, string> = { MDY: 'Month/Day/Year', DMY: 'Day/Month/Year', YMD: 'Year/Month/Day' }

/** The date question: an example that reads differently in each order, and what each makes of it. */
function dateQuestion(dates: readonly string[], orders: DateOrder[], pivot: number, value: DateOrder): OptionsDialogInput['dates'] {
  const example = dates.find(d => new Set(orders.map(o => qifDate(d, o, pivot))).size > 1) ?? dates[0]
  const choices: QifChoice<DateOrder>[] = orders.map(order => ({ value: order, label: `${ORDER_NAMES[order]}: ${example.trim()} is ${inWords(qifDate(example, order, pivot)!)}` }))
  return { example: example.trim(), choices, value }
}

/** The decimal question: an amount that reads both ways. */
function decimalQuestion(amounts: readonly string[], value: DecimalSeparator): OptionsDialogInput['decimal'] {
  const example = (amounts.find(a => /\d[.,]\d{3}(?!\d)/.test(a)) ?? amounts[0]).trim()
  const as = (decimal: DecimalSeparator) => canonicalDecimal(example, { decimal }) ?? example
  return {
    example,
    choices: [
      { value: '.', label: `A point for decimals (1,234.56): “${example}” is ${as('.')}` },
      { value: ',', label: `A comma for decimals (1.234,56): “${example}” is ${as(',')}` }
    ],
    value
  }
}

/** Reads a QIF file, asking in QIF Options only what the file can't decide and its source hasn't answered before. */
export async function parseQifFile(file: ImportFile, context: ParseContext, options: QifFormatOptions = {}): Promise<ParseResult | undefined> {
  const now = options.now ?? (() => new Date())
  const pivot = now().getFullYear() + 10
  const text = file.text('auto')
  const sections = parseQif(text)
  if (!sections.some(s => s.header !== '')) throw new ImportError('UNREADABLE', `${file.name} isn't a QIF file: it has no !Type or !Account line.`)
  const collected = collect(sections)
  const warnings: ParseWarning[] = [...collected.warnings]
  if (collected.statements.length === 0) return { statements: [], warnings }

  const keys = collected.statements.map(raw => identify(raw, file.name).key)
  const remembered = await Promise.all(keys.map(key => context.memory.get<QifOptions>(optionsKey(key))))
  const { dates, amounts } = samplesOf(collected.statements)

  // The date order and decimal separator: decided by the file, or remembered for its source, or asked
  const orders = qifDateOrders(dates, pivot)
  const decimals = guessDecimal(amounts.filter(a => a.trim() !== ''))
  let dateOrder: DateOrder
  let decimal: DecimalSeparator
  const input: OptionsDialogInput = { fileName: file.name }
  if (orders.length === 1) dateOrder = orders[0]
  else if (orders.length === 0) {
    // No order reads every date: the one that reads the most, and the rest are warned about
    const read = (order: DateOrder) => dates.filter(d => qifDate(d, order, pivot) !== undefined).length
    dateOrder = (['MDY', 'DMY', 'YMD'] as DateOrder[]).sort((a, b) => read(b) - read(a))[0]
  } else {
    const known = remembered.find(o => o?.dateOrder && orders.includes(o.dateOrder))?.dateOrder
    dateOrder = known ?? likeliestOrder(dates, orders, pivot)
    if (!known) input.dates = dateQuestion(dates.filter(d => plainDate(d) !== undefined), orders, pivot, dateOrder)
  }
  if (decimals.length === 1) decimal = decimals[0]
  else if (decimals.length === 0) decimal = '.'
  else {
    const known = remembered.find(o => o?.decimal)?.decimal
    decimal = known ?? '.'
    if (!known) input.decimal = decimalQuestion(amounts.filter(a => a.trim() !== ''), decimal)
  }

  if (input.dates || input.decimal) {
    const answer = await context.prompt<OptionsDialogResult, OptionsDialogInput>(OPTIONS_DIALOG, input, { title: `QIF Options: ${file.name}` })
    if (answer?.kind === 'skip') return undefined
    if (answer?.kind !== 'options') throw new ImportError('CANCELLED', 'The import was cancelled in the QIF Options dialog.')
    if (answer.dateOrder && input.dates?.choices.some(c => c.value === answer.dateOrder)) dateOrder = answer.dateOrder
    if (answer.decimal && input.decimal?.choices.some(c => c.value === answer.decimal)) decimal = answer.decimal
  }

  const statements: ParsedStatement[] = []
  for (const [i, raw] of collected.statements.entries()) {
    const read = readStatement(raw, file.name, { dateOrder, decimal, pivot, reversed: remembered[i]?.reversed === true })
    warnings.push(...read.warnings)
    if (read.statement.lines.length === 0) {
      const name = accountName(raw)
      warnings.push({ message: `${name ? `“${name}”` : 'An account'} has no transactions, so nothing of it was imported.`, line: raw.line })
      continue
    }
    statements.push(read.statement)
  }

  // Remembered for each source: how its files are read, and its reversal, kept as it was
  for (const [i, key] of keys.entries()) {
    const account = identify(collected.statements[i], file.name)
    const label = account.name ?? file.name.replace(/\.[^.]*$/, '')
    const kept: QifOptions = { ...remembered[i], dateOrder, decimal, label }
    await context.memory.set(optionsKey(key), kept)
  }
  return { statements, warnings }
}

const ORDER_WORDS: Record<DateOrder, string> = { YMD: 'year first', MDY: 'month first', DMY: 'day first' }

/** What the format remembers, as Saved Import Choices lists it: each source's options. */
export function describeQifMemory(key: string, value: unknown): RememberedDescription | undefined {
  if (!key.startsWith('options:')) return undefined
  const options = value as QifOptions | undefined
  if (typeof options !== 'object' || options === null) return undefined
  const sourceKey = key.slice('options:'.length)
  const source = options.label ?? sourceKey.replace(/^qif:(account|file):/, '')
  const detail = [
    options.dateOrder ? `dates ${ORDER_WORDS[options.dateOrder]}` : undefined,
    options.decimal === ',' ? 'a comma for decimals' : options.decimal === '.' ? 'a point for decimals' : undefined,
    options.reversed ? 'amounts reversed' : undefined
  ].filter(Boolean).join(' · ')
  return { what: 'QIF options', source, ...(detail && { detail: detail[0].toUpperCase() + detail.slice(1) }) }
}

/** The sign cross-check reversed a statement, and the user asked to remember: its source's files are read reversed. */
export async function correctQif(correction: FormatCorrection, memory: FormatMemory): Promise<boolean> {
  if (correction.kind !== 'signsReversed' || !correction.key.startsWith('qif:')) return false
  const options = (await memory.get<QifOptions>(optionsKey(correction.key))) ?? {}
  await memory.set(optionsKey(correction.key), { ...options, reversed: !options.reversed })
  return true
}
