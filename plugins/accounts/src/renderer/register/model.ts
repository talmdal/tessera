// The register's editing model, as pure functions: what an edited row holds, and how it becomes a transaction.
import {
  AMOUNT_COLUMNS, amountToInput, categoryLabel, parseAmount,
  type Account, type Category, type ClearingStatus, type RegisterRow, type TransactionDraft
} from '@tessera/accounts-api'

/** What the category field can hold: a category, or the other account of a transfer. */
export type CategoryChoice =
  | { kind: 'category', id: string, label: string }
  | { kind: 'transfer', accountId: string, label: string }

/** An edited row, as typed: text stays text until it is saved, so nothing is reformatted under the user. */
export interface Draft {
  /** The transaction being edited, or undefined for the new-entry row. */
  id?: string
  rev?: number
  status: ClearingStatus
  number: string
  date: string
  payee: string
  category: CategoryChoice | null
  /** The column that lowers the balance (Payment, Charge…), unsigned. */
  decrease: string
  /** The column that raises it (Deposit, Payment…), unsigned. */
  increase: string
  memo: string
}

export type DraftField = 'number' | 'date' | 'payee' | 'category' | 'amount' | 'memo'

/** The choices for the category field: categories by label, then transfers to every other open account in the currency. */
export function categoryChoices(categories: readonly Category[], accounts: readonly Account[], account: Account): CategoryChoice[] {
  const byLabel = categories
    .map(category => ({ kind: 'category' as const, id: category.id, label: categoryLabel(categories, category.id) ?? category.name }))
    .sort((a, b) => a.label.localeCompare(b.label))
  const transfers = accounts
    .filter(other => other.id !== account.id && !other.closed && other.currency === account.currency)
    .map(other => ({ kind: 'transfer' as const, accountId: other.id, label: `Transfer: ${other.name}` }))
    .sort((a, b) => a.label.localeCompare(b.label))
  return [...byLabel, ...transfers]
}

export const sameChoice = (a: CategoryChoice | null, b: CategoryChoice | null) =>
  a === b || (a !== null && b !== null && (a.kind === 'category' ? b.kind === 'category' && a.id === b.id : b.kind === 'transfer' && a.accountId === b.accountId))

/** A fresh new-entry row. */
export function emptyDraft(defaults: { date: string, number?: string }): Draft {
  return { status: 'uncleared', number: defaults.number ?? '', date: defaults.date, payee: '', category: null, decrease: '', increase: '', memo: '' }
}

/** The draft for editing a row. */
export function draftFrom(row: RegisterRow, account: Account, choices: readonly CategoryChoice[]): Draft {
  const t = row.transaction
  const category = t.transferAccountId !== undefined
    ? choices.find(c => c.kind === 'transfer' && c.accountId === t.transferAccountId) ?? { kind: 'transfer' as const, accountId: t.transferAccountId, label: row.categoryLabel ?? 'Transfer' }
    : t.categoryId !== undefined
      ? choices.find(c => c.kind === 'category' && c.id === t.categoryId) ?? { kind: 'category' as const, id: t.categoryId, label: row.categoryLabel ?? '' }
      : null
  const magnitude = amountToInput(Math.abs(t.amount), account.currency)
  return {
    id: t.id, rev: t.rev, status: t.status, number: t.number ?? '', date: t.date, payee: row.payeeName ?? '', category,
    decrease: t.amount < 0 ? magnitude : '', increase: t.amount > 0 ? magnitude : '', memo: t.memo ?? ''
  }
}

/** The draft as a transaction, or the problems that stop it being one, by field. */
export function toTransactionDraft(draft: Draft, currency: string): { transaction?: TransactionDraft, problems: Partial<Record<DraftField, string>> } {
  const problems: Partial<Record<DraftField, string>> = {}
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.date)) problems.date = 'Enter a date.'

  const decrease = draft.decrease.trim()
  const increase = draft.increase.trim()
  let amount = 0
  if (decrease === '' && increase === '') problems.amount = 'Enter an amount.'
  else if (decrease !== '' && increase !== '') problems.amount = 'Enter the amount in one column only.'
  else {
    const parsed = parseAmount(decrease !== '' ? decrease : increase, currency)
    if (!parsed.ok) problems.amount = parsed.message
    else if (parsed.value < 0) problems.amount = 'Enter the amount without a sign; the column says which way it goes.'
    else amount = decrease !== '' ? -parsed.value : parsed.value
  }
  if (Object.keys(problems).length > 0) return { problems }

  const text = (value: string) => value.trim() === '' ? undefined : value.trim()
  const transaction: TransactionDraft = {
    date: draft.date, amount, status: draft.status,
    ...(text(draft.number) !== undefined && { number: text(draft.number) }),
    ...(text(draft.payee) !== undefined && { payee: text(draft.payee) }),
    ...(text(draft.memo) !== undefined && { memo: text(draft.memo) }),
    ...(draft.category?.kind === 'category' && { categoryId: draft.category.id }),
    ...(draft.category?.kind === 'transfer' && { transferAccountId: draft.category.accountId })
  }
  return { transaction, problems }
}

/** The column headings for an account's type. */
export const columnsFor = (account: Account) => AMOUNT_COLUMNS[account.type]

/** What Space does to a status: clears what isn't cleared, and uncleares what is. */
export function toggledStatus(status: ClearingStatus): ClearingStatus {
  return status === 'cleared' || status === 'reconciled' ? 'uncleared' : 'cleared'
}

/** A date moved by `days`, in YYYY-MM-DD. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number)
  const moved = new Date(Date.UTC(y, m - 1, d + days))
  return moved.toISOString().slice(0, 10)
}

/** A number stepped by `by`, when it is a number; anything else as it was. */
export function stepNumber(number: string, by: number): string {
  return /^\d+$/.test(number.trim()) ? String(Math.max(0, Number(number.trim()) + by)) : number
}

/** The next number after `number`, when it is one. */
export const nextAfter = (number: string) => /^\d+$/.test(number.trim()) ? String(Number(number.trim()) + 1) : ''

export const isDirty = (a: Draft, b: Draft) =>
  a.number !== b.number || a.date !== b.date || a.payee !== b.payee || !sameChoice(a.category, b.category) ||
  a.decrease !== b.decrease || a.increase !== b.increase || a.memo !== b.memo

/**
 * A corrected amount, typed in the column the transaction is in: it keeps its direction (a payment stays a payment),
 * so the user types what the statement shows, unsigned.
 */
export function correctedAmount(original: number, text: string, currency: string): { amount?: number, problem?: string } {
  const parsed = parseAmount(text, currency)
  if (!parsed.ok) return { problem: parsed.message }
  const magnitude = Math.abs(parsed.value)
  return { amount: original < 0 ? -magnitude : magnitude }
}
