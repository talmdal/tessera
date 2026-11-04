// The rules an account's fields follow, shared by the service (which enforces them) and the dialogs (which show
// them as the user types). Pure functions.
import { isCurrencyCode } from './money'
import { MAX_AMOUNT } from './money'
import { ACCOUNT_CLASS, ACCOUNT_TYPES, type AccountType } from './model'

export const ACCOUNT_NAME_MAX_LENGTH = 100
export const ACCOUNT_TEXT_MAX_LENGTH = 100
export const ACCOUNT_NUMBER_MAX_LENGTH = 50
export const ACCOUNT_NOTES_MAX_LENGTH = 2000

/** What a person calls each type. */
export const ACCOUNT_TYPE_LABELS: Readonly<Record<AccountType, string>> = {
  chequing: 'Chequing',
  savings: 'Savings',
  cash: 'Cash',
  creditCard: 'Credit card',
  lineOfCredit: 'Line of credit',
  loan: 'Loan',
  mortgage: 'Mortgage',
  investment: 'Investment',
  retirement: 'Retirement',
  otherAsset: 'Other asset',
  otherLiability: 'Other liability'
}

/** Types that can have a credit limit. */
export const CREDIT_LIMIT_TYPES: readonly AccountType[] = ['creditCard', 'lineOfCredit']

export const isAccountType = (value: unknown): value is AccountType => (ACCOUNT_TYPES as readonly unknown[]).includes(value)

export const isLiability = (type: AccountType) => ACCOUNT_CLASS[type] === 'liability'

const CONTROL = /[\u0000-\u001f\u007f]/

/** Why a name can't be used, or undefined. Names are trimmed first, and unique in a book ignoring case. */
export function validateAccountName(name: unknown): string | undefined {
  if (typeof name !== 'string' || name.trim() === '') return 'Enter a name.'
  if (name.trim().length > ACCOUNT_NAME_MAX_LENGTH) return `Use at most ${ACCOUNT_NAME_MAX_LENGTH} characters.`
  if (CONTROL.test(name)) return 'A name can’t contain control characters.'
  return undefined
}

/** The key account names are compared by. */
export const accountNameKey = (name: string) => name.trim().toLocaleLowerCase()

/** An account number reduced to what identifies it: letters and digits, lower case ("12-34 56" → "123456"). */
export const accountNumberKey = (number: string) => number.replace(/[^0-9A-Za-z]/g, '').toLowerCase()

/** A real calendar date written as YYYY-MM-DD. */
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [y, m, d] = value.split('-').map(Number)
  const date = new Date(Date.UTC(y, m - 1, d))
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d
}

/** Today in the local time zone, as YYYY-MM-DD. */
export function todayIso(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/** A whole number of minor units within the range anything stores. */
export const isAmount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && Math.abs(value) <= MAX_AMOUNT

/** `•••• 1234` for an account number, so the whole number isn't on screen. */
export function maskAccountNumber(number: string | undefined): string {
  if (!number) return ''
  const key = number.replace(/[^0-9A-Za-z]/g, '')
  return key.length <= 4 ? number : `•••• ${key.slice(-4)}`
}

export { isCurrencyCode }

/** Types that can require a minimum balance: asset accounts (a bank's minimum on chequing or savings, say). */
export const MINIMUM_BALANCE_TYPES: readonly AccountType[] = ACCOUNT_TYPES.filter(type => ACCOUNT_CLASS[type] === 'asset')

// ---- Transactions

export const TRANSACTION_NUMBER_MAX_LENGTH = 20
export const PAYEE_NAME_MAX_LENGTH = 100
export const MEMO_MAX_LENGTH = 500
export const CATEGORY_NAME_MAX_LENGTH = 60

/** Separates a parent category from its child in labels and paths: "Food : Groceries". */
export const CATEGORY_SEPARATOR = ' : '

/** "Food : Groceries" for a category, from the list of all of them; undefined for an unknown id. */
export function categoryLabel(categories: readonly { id: string, parentId: string | null, name: string }[], id: string | undefined): string | undefined {
  if (id === undefined) return undefined
  const byId = new Map(categories.map(c => [c.id, c]))
  const names: string[] = []
  for (let at = byId.get(id); at && names.length <= categories.length; at = at.parentId === null ? undefined : byId.get(at.parentId)) {
    names.unshift(at.name)
  }
  return names.length === 0 ? undefined : names.join(CATEGORY_SEPARATOR)
}

/** "Transfer to: Savings" for money leaving this account, "Transfer from: Savings" for money arriving. */
export const transferLabel = (amount: number, otherAccount: string) =>
  `${amount < 0 ? 'Transfer to' : 'Transfer from'}: ${otherAccount}`
