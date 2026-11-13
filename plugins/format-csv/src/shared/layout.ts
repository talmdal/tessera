// A CSV file's layout: which column holds what, and how its dates, decimals and signs are written. The guess makes
// one, the CSV Columns dialog shows and edits it, the format remembers the confirmed one per signature, and lines.ts
// reads rows with it. Pure, and shared by both halves.
// See docs/import-formats-design.md, "The layout".
import type { DateOrder, DecimalSeparator } from '@tessera/import-api'
import type { Delimiter } from './csv'

export interface CsvLayout {
  version: 1
  delimiter: Delimiter
  /** Rows before the header (or before the first data row when there is no header). */
  skip: number
  header: boolean
  columns: CsvColumns
  dateOrder: DateOrder
  decimal: DecimalSeparator
  /** Money out is shown as positive: every amount is negated. */
  reversed: boolean
}

export interface CsvColumns {
  /** The posting date. */
  date?: number
  /** The transaction date, when the file has both. */
  userDate?: number
  /** One signed column … */
  amount?: number
  /** … or money out … */
  debit?: number
  /** … and money in. */
  credit?: number
  /** 'DR'/'CR', 'Debit'/'Credit': the sign of an unsigned amount column. */
  direction?: { column: number, debit: string[], credit: string[] }
  payee?: number
  /** Several are joined with ' · '. */
  memo?: number[]
  /** A cheque number. */
  number?: number
  /** The bank's transaction id; never guessed from 'Reference'. */
  id?: number
  balance?: number
  status?: { column: number, pending: string[] }
  currency?: number
  account?: number
  category?: number
}

/** What a column can be, as the dialog lists them. */
export type Role =
  | 'date' | 'userDate' | 'amount' | 'debit' | 'credit' | 'direction' | 'payee' | 'memo' | 'number' | 'id' | 'balance'
  | 'status' | 'currency' | 'account' | 'category'

export const ROLES: readonly Role[] = [
  'date', 'userDate', 'payee', 'memo', 'amount', 'debit', 'credit', 'direction', 'balance', 'number', 'id', 'status',
  'currency', 'account', 'category'
]

/** Each role's name in the dialog. */
export const ROLE_NAMES: Record<Role, string> = {
  date: 'Date', userDate: 'Transaction date', payee: 'Payee', memo: 'Memo', amount: 'Amount', debit: 'Money out',
  credit: 'Money in', direction: 'Debit or credit', balance: 'Balance', number: 'Cheque number', id: 'Bank id',
  status: 'Status', currency: 'Currency', account: 'Account number', category: 'Category'
}

/** Each column's role, for `width` columns; undefined for a column the layout doesn't use. */
export function rolesOf(layout: CsvLayout, width: number): (Role | undefined)[] {
  const roles: (Role | undefined)[] = Array.from({ length: width }, () => undefined)
  const set = (column: number | undefined, role: Role) => { if (column !== undefined && column >= 0 && column < width && roles[column] === undefined) roles[column] = role }
  const c = layout.columns
  set(c.date, 'date'); set(c.userDate, 'userDate'); set(c.amount, 'amount'); set(c.debit, 'debit'); set(c.credit, 'credit')
  set(c.direction?.column, 'direction'); set(c.payee, 'payee'); for (const m of c.memo ?? []) set(m, 'memo')
  set(c.number, 'number'); set(c.id, 'id'); set(c.balance, 'balance'); set(c.status?.column, 'status')
  set(c.currency, 'currency'); set(c.account, 'account'); set(c.category, 'category')
  return roles
}

/** Every column index the layout uses, with repeats if a column has two roles. */
function usedColumns(c: CsvColumns): number[] {
  return [
    c.date, c.userDate, c.amount, c.debit, c.credit, c.direction?.column, c.payee, ...(c.memo ?? []), c.number, c.id,
    c.balance, c.status?.column, c.currency, c.account, c.category
  ].filter((i): i is number => i !== undefined)
}

/** Takes `column` off whatever role it has. */
function without(c: CsvColumns, column: number): CsvColumns {
  const next: CsvColumns = { ...c }
  for (const key of ['date', 'userDate', 'amount', 'debit', 'credit', 'payee', 'number', 'id', 'balance', 'currency', 'account', 'category'] as const) {
    if (next[key] === column) delete next[key]
  }
  if (next.direction?.column === column) delete next.direction
  if (next.status?.column === column) delete next.status
  if (next.memo?.includes(column)) {
    const memo = next.memo.filter(m => m !== column)
    if (memo.length > 0) next.memo = memo
    else delete next.memo
  }
  return next
}

/**
 * The layout with `column` given `role` (or no role), as the dialog's pickers do it: a role another column held moves
 * here (memo is the only one several columns share). An amount column and a Money out / Money in pair exclude each
 * other, and so do an amount's direction column and the pair. `values` are the column's cells, to fill in what a
 * direction or status column's words mean.
 */
export function withRole(layout: CsvLayout, column: number, role: Role | undefined, values: readonly string[] = [], words?: {
  direction: (values: readonly string[]) => { debit: string[], credit: string[] }
  pending: (values: readonly string[]) => string[]
}): CsvLayout {
  // Every role but memo is one field of the layout, so setting it below takes it from the column that had it
  const c = without(layout.columns, column)
  if (role === undefined) return { ...layout, columns: c }
  if (role === 'amount') { delete c.debit; delete c.credit }
  if (role === 'debit' || role === 'credit') { delete c.amount; delete c.direction }
  if (role === 'direction' && (c.debit !== undefined || c.credit !== undefined)) { delete c.debit; delete c.credit }
  switch (role) {
    case 'memo': c.memo = [...(c.memo ?? []), column].sort((a, b) => a - b); break
    case 'direction': c.direction = { column, ...(words?.direction(values) ?? { debit: ['DR', 'D', 'DEBIT'], credit: ['CR', 'C', 'CREDIT'] }) }; break
    case 'status': c.status = { column, pending: words?.pending(values) ?? ['pending'] }; break
    default: c[role] = column
  }
  // Signs: with Money out and Money in, or a direction column, the columns say them
  const reversed = c.amount !== undefined && c.direction === undefined ? layout.reversed : false
  return { ...layout, columns: c, reversed }
}

/**
 * Why a layout can't be used for rows `width` cells wide, in words; empty when it can. It needs a date column and
 * either an amount column or Money out and Money in, every column inside the rows, and no column with two roles.
 */
export function problemsOf(layout: CsvLayout, width: number): string[] {
  const c = layout.columns
  const problems: string[] = []
  if (c.date === undefined) problems.push('Choose the column that holds the date.')
  const pair = c.debit !== undefined || c.credit !== undefined
  if (c.amount === undefined && !pair) problems.push('Choose the column that holds the amount, or the Money out and Money in columns.')
  if (c.amount === undefined && pair && (c.debit === undefined || c.credit === undefined)) {
    problems.push(c.debit === undefined ? 'Choose the Money out column too.' : 'Choose the Money in column too.')
  }
  if (c.direction !== undefined && c.amount === undefined) problems.push('A debit or credit column needs an amount column beside it.')
  const used = usedColumns(c)
  const outside = used.filter(i => i < 0 || i >= width)
  if (outside.length > 0) problems.push(`This file has no column ${outside[0] + 1}: it has ${width}.`)
  const twice = used.find((i, k) => used.indexOf(i) !== k)
  if (twice !== undefined) problems.push(`Column ${twice + 1} has two roles.`)
  if (layout.skip < 0) problems.push('The first row must be in the file.')
  return problems
}

/**
 * What a layout's signature is made from, before it is hashed (privileged/signature.ts):
 * - with a header, the delimiter and the header's cells, each trimmed, lower-cased and without accents;
 * - without one, the number of columns and each column's shape in the first rows (date, number, text or empty).
 */
export function signatureBasis(layout: CsvLayout, header: readonly string[] | undefined, shapes: readonly string[]): string {
  const fold = (text: string) => text.normalize('NFKD').replace(/\p{M}/gu, '').trim().toLowerCase()
  if (layout.header && header) return `header|${layout.delimiter}|${header.map(fold).join('\u001f')}`
  return `shape|${layout.delimiter}|${shapes.length}|${shapes.join(',')}`
}
