// Writing CSV: one row per transaction, for spreadsheets. The header uses names this plugin's own reader recognises
// (Date, Cheque number, Payee, Category, Memo, Amount, Status, Balance), so a file Tessera wrote opens in CSV Columns
// with nothing guessed. Uncleared rows are never labelled "Pending", which the reader leaves out. Pure: data in, bytes
// out. See docs/export-design.md, "CSV".
import { CATEGORY_SEPARATOR, STATUS_LETTERS } from '@tessera/accounts-api'
import {
  encodeText, withDecimalComma,
  type ExportCheck, type ExportData, type ExportFormat, type ExportFormatContribution, type ExportOptions, type ExportOutput,
  type ExportTransaction, type TextEncoding
} from '@tessera/export-api'

export const CSV_EXPORT_SERVICE = 'format-csv.export'

export const CSV_EXPORT: ExportFormatContribution = {
  id: 'format-csv.csv',
  label: 'CSV file (spreadsheets)',
  extension: 'csv',
  service: CSV_EXPORT_SERVICE,
  description: 'For Excel, Numbers, Google Sheets and other spreadsheets: one row per transaction, with its balance.',
  order: 10,
  accounts: 'many',
  options: [
    {
      kind: 'choice', key: 'amounts', label: 'Amounts', default: 'signed',
      options: [
        { value: 'signed', label: 'One column, money out negative' },
        { value: 'outIn', label: 'Money out and Money in columns' }
      ]
    },
    {
      kind: 'choice', key: 'dates', label: 'Date format', default: 'iso',
      options: [
        { value: 'iso', label: 'Year-month-day (2026-10-05)', description: 'Read as a date by every spreadsheet, whatever its language.' },
        { value: 'mdy', label: 'Month/day/year (10/05/2026)' },
        { value: 'dmy', label: 'Day/month/year (05/10/2026)' }
      ]
    },
    {
      kind: 'choice', key: 'decimal', label: 'Decimal separator', default: '.',
      options: [
        { value: '.', label: 'Point (1234.56)' },
        {
          value: ',', label: 'Comma (1234,56)',
          description: 'Cells are then separated by semicolons. For spreadsheets set to use a comma for decimals; others may need the separator chosen when opening the file.'
        }
      ]
    },
    {
      kind: 'choice', key: 'encoding', label: 'Characters', default: 'utf-8',
      options: [
        { value: 'utf-8', label: 'UTF-8 (Excel, Numbers, Google Sheets)' },
        {
          value: 'windows-1252', label: 'Windows (older programs)',
          description: 'Other programs may show accented letters wrongly, and characters Windows can’t hold are replaced.'
        }
      ]
    },
    {
      kind: 'boolean', key: 'includeVoided', label: 'Include voided transactions', default: false,
      description: 'Marked V, and not counted in the balance. Tessera would import them back as real transactions.'
    },
    {
      kind: 'boolean', key: 'formulaGuard', label: 'Protect against spreadsheet formulas', default: true,
      description: 'Text that starts with =, +, - or @ is written with a \' in front, so a spreadsheet can’t run it. Some spreadsheets show the \'.'
    }
  ]
}

/** The options, as `resolveOptions` gives them. */
interface CsvExportOptions {
  amounts: 'signed' | 'outIn'
  dates: 'iso' | 'mdy' | 'dmy'
  decimal: '.' | ','
  encoding: TextEncoding
  includeVoided: boolean
  formulaGuard: boolean
}

const optionsOf = (options: ExportOptions): CsvExportOptions => ({
  amounts: options.amounts === 'outIn' ? 'outIn' : 'signed',
  dates: options.dates === 'mdy' || options.dates === 'dmy' ? options.dates : 'iso',
  decimal: options.decimal === ',' ? ',' : '.',
  encoding: options.encoding === 'windows-1252' ? 'windows-1252' : 'utf-8',
  includeVoided: options.includeVoided === true,
  formulaGuard: options.formulaGuard !== false
})

/** Text a spreadsheet would run as a formula: starting with =, +, -, @, a tab or a carriage return. */
const FORMULA = /^[=+\-@\t\r]/

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en')} ${n === 1 ? one : many}`

/** The register's category column: 'Food : Groceries', or 'Transfer to: Savings'. */
function categoryOf(t: ExportTransaction): string {
  if (t.transfer) return `${t.transfer.direction === 'to' ? 'Transfer to' : 'Transfer from'}: ${t.transfer.account}`
  return t.category?.join(CATEGORY_SEPARATOR) ?? ''
}

interface Built {
  text: string
  transactions: number
  /** Accounts with no row in the file, by id. */
  leftOut: string[]
  warnings: string[]
}

/** The file's text, and what was changed or left out on the way. */
function build(data: ExportData, o: CsvExportOptions): Built {
  const delimiter = o.decimal === ',' ? ';' : ','
  // Only the accounts with a row to write are in the file: the columns follow them, so one account's rows make a
  // one-account file, which reads back as its account
  const written = (t: ExportTransaction) => !t.voided || o.includeVoided
  const accounts = data.accounts.filter(a => a.transactions.some(written))
  const several = accounts.length > 1
  const currencies = [...new Set(accounts.map(a => a.currency))]
  let guarded = 0
  let voidedLeftOut = 0
  let transactions = 0

  const date = (d: string) => o.dates === 'iso' ? d
    : o.dates === 'mdy' ? `${d.slice(5, 7)}/${d.slice(8, 10)}/${d.slice(0, 4)}` : `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`
  const amount = (canonical: string) => o.decimal === ',' ? withDecimalComma(canonical) : canonical
  const text = (value: string | undefined) => {
    const v = value ?? ''
    if (o.formulaGuard && FORMULA.test(v)) { guarded++; return `'${v}` }
    return v
  }
  const cell = (value: string) => /["\r\n]/.test(value) || value.includes(delimiter) ? `"${value.replace(/"/g, '""')}"` : value

  const header = [
    ...(several ? ['Account'] : []), 'Date', 'Cheque number', 'Payee', 'Category', 'Memo',
    ...(o.amounts === 'signed' ? ['Amount'] : ['Money out', 'Money in']), ...(currencies.length > 1 ? ['Currency'] : []), 'Status', 'Balance'
  ]
  const lines = [header.map(cell).join(delimiter)]
  for (const account of accounts) {
    for (const t of account.transactions) {
      if (t.voided && !o.includeVoided) { voidedLeftOut++; continue }
      transactions++
      const negative = t.amount.startsWith('-')
      const magnitude = amount(t.amount.replace(/^-/, ''))
      lines.push([
        ...(several ? [text(account.name)] : []), date(t.date), text(t.number), text(t.payee), text(categoryOf(t)), text(t.memo),
        ...(o.amounts === 'signed' ? [amount(t.amount)] : [negative ? magnitude : '', negative || /^0(\.0+)?$/.test(t.amount) ? '' : magnitude]),
        ...(currencies.length > 1 ? [account.currency] : []), t.voided ? STATUS_LETTERS.voided : STATUS_LETTERS[t.status], amount(t.balance)
      ].map(cell).join(delimiter))
    }
  }

  // An account left out because all its lines are voided: those are left out too
  if (!o.includeVoided) for (const a of data.accounts) if (!accounts.includes(a)) voidedLeftOut += a.transactions.filter(t => t.voided).length

  const warnings = [
    ...(several ? ['Several accounts in one CSV file suit a spreadsheet. Tessera would import the file back as a single account.'] : []),
    ...(currencies.length > 1 ? [`The accounts are in more than one currency (${currencies.join(', ')}): a Currency column says which, and Tessera can’t import the file back.`] : []),
    ...(guarded > 0 ? [`${plural(guarded, 'cell')} starting like a spreadsheet formula ${guarded === 1 ? 'is' : 'are'} written with a ' in front.`] : []),
    ...(voidedLeftOut > 0 ? [`${plural(voidedLeftOut, 'voided transaction')} ${voidedLeftOut === 1 ? 'is' : 'are'} left out.`] : [])
  ]
  const leftOut = data.accounts.filter(a => !accounts.includes(a)).map(a => a.id)
  return { text: lines.join('\r\n') + '\r\n', transactions, leftOut, warnings }
}

function encoded(built: Built, o: CsvExportOptions): ExportOutput {
  const { bytes, replaced } = encodeText(built.text, o.encoding, { bom: o.encoding === 'utf-8' })
  const warnings = replaced > 0
    ? [...built.warnings, `${plural(replaced, 'character')} Windows can’t hold ${replaced === 1 ? 'is' : 'are'} written as the nearest letter, or “?”.`]
    : built.warnings
  return { bytes, warnings }
}

export const csvExport: ExportFormat = {
  check(data, options): ExportCheck {
    const o = optionsOf(options)
    const built = build(data, o)
    const { warnings } = encoded(built, o)
    const problems = built.transactions === 0
      ? [`There are no transactions to export${data.accounts.length === 1 ? ` in “${data.accounts[0].name}”` : ''} for these dates.`]
      : []
    return { transactions: built.transactions, ...(built.leftOut.length > 0 && { accountsLeftOut: built.leftOut }), problems, warnings }
  },
  write(data, options): ExportOutput {
    const o = optionsOf(options)
    return encoded(build(data, o), o)
  }
}
