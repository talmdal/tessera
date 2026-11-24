// The rules an account's fields follow, shared by the service (which enforces them) and the dialogs (which show
// them as the user types). Pure functions.
import { descendantIds, type TreeNode } from '@tessera/ledger-api'
import { isCurrencyCode } from './money'
import { MAX_AMOUNT } from './money'
import { ACCOUNT_CLASS, ACCOUNT_TYPES, type Account, type AccountType, type TransactionTotal } from './model'

export const ACCOUNT_NAME_MAX_LENGTH = 100
export const ACCOUNT_TEXT_MAX_LENGTH = 100
export const ACCOUNT_NUMBER_MAX_LENGTH = 50
/** OFX's `BANKID` is at most 9 characters. */
export const BANK_ID_MAX_LENGTH = 9
/** `INTU.BID`: a few digits in practice; room to spare. */
export const INTUIT_BANK_ID_MAX_LENGTH = 32
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

/**
 * When the account's current period starts, which the register's first row (the opening balance) is dated: its last
 * archival date once it has been archived (or the opening date, if that is later), else the date it opened.
 */
export const periodStart = (account: Pick<Account, 'openingDate' | 'lastArchiveDate'>): string =>
  account.lastArchiveDate !== undefined && account.lastArchiveDate > account.openingDate ? account.lastArchiveDate : account.openingDate

const CONTROL = /[\u0000-\u001f\u007f]/

/** Why a name can't be used, or undefined. Names are trimmed first, and unique in a ledger ignoring case. */
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

/**
 * The currency most of these accounts use; the alphabetically first of those tied; `fallback` when there are none. What
 * a new account, a statement with no currency, or a new budget starts with.
 */
export function mostUsedCurrency(accounts: readonly { currency: string }[], fallback: string): string {
  const counts = new Map<string, number>()
  for (const { currency } of accounts) counts.set(currency, (counts.get(currency) ?? 0) + 1)
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? fallback
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
/** A bank's id for a line (OFX FITIDs are at most 255 characters), or an importer's fingerprint. */
export const EXTERNAL_ID_MAX_LENGTH = 255
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

// ---- What a budget or a report covers (since 1.15)

/**
 * The accounts a budget or a report covers: the whole ledger; a sub-ledger and everything beneath it; accounts of some
 * types, in the ledger or beneath a sub-ledger (a report's *Everyday accounts*); or accounts chosen by id.
 */
export type AccountScopeInput =
  | { kind: 'ledger' }
  | { kind: 'subLedger', subLedgerId: string }
  | { kind: 'types', types: readonly AccountType[], subLedgerId?: string }
  | { kind: 'accounts', accountIds: readonly string[] }

/** An account as a scope judges it: where it is (or, for one an archive removed, where it was), and its type if known. */
export interface ScopedAccount {
  id: string
  subLedgerId: string | null
  type?: AccountType
}

export interface AccountScope {
  /** Whether an account is in the scope. One whose type isn't known is outside a scope of types. */
  covers(account: ScopedAccount): boolean
  /** The accounts given that are in the scope, in any currency: a transfer with one of these stays inside it. */
  inside: ReadonlySet<string>
  /** Those in the scope and the currency: the ones whose transactions count. */
  counted: ReadonlySet<string>
  /** Those in the scope left out for their currency, by name. */
  notCounted: { accountId: string, name: string, currency: string }[]
}

/**
 * The scope `input` draws over `accounts` (the ledger's, as `accounts.service.list()` gives them), for figures in
 * `currency`. Closed accounts are covered: their history is still history. A sub-ledger covers its descendants, and
 * accounts are judged where they are now, as budgets judge them (docs/budget-design.md, "Budgets").
 */
export function accountScope(
  input: AccountScopeInput,
  subLedgers: readonly TreeNode[],
  accounts: readonly Pick<Account, 'id' | 'name' | 'subLedgerId' | 'currency' | 'type'>[],
  currency: string
): AccountScope {
  const beneath = (subLedgerId: string | undefined) => subLedgerId === undefined
    ? undefined
    : new Set<string>([subLedgerId, ...descendantIds(subLedgers, subLedgerId)])
  let covers: (account: ScopedAccount) => boolean
  switch (input.kind) {
    case 'ledger':
      covers = () => true
      break
    case 'subLedger': {
      const within = beneath(input.subLedgerId)!
      covers = a => a.subLedgerId !== null && within.has(a.subLedgerId)
      break
    }
    case 'types': {
      const types = new Set(input.types)
      const within = beneath(input.subLedgerId)
      covers = a => a.type !== undefined && types.has(a.type) && (within === undefined || (a.subLedgerId !== null && within.has(a.subLedgerId)))
      break
    }
    case 'accounts': {
      const ids = new Set(input.accountIds)
      covers = a => ids.has(a.id)
      break
    }
  }
  const inScope = accounts.filter(a => covers(a))
  return {
    covers,
    inside: new Set(inScope.map(a => a.id)),
    counted: new Set(inScope.filter(a => a.currency === currency).map(a => a.id)),
    notCounted: inScope.filter(a => a.currency !== currency)
      .map(a => ({ accountId: a.id, name: a.name, currency: a.currency }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }
}

/**
 * Whether a total crosses the scope: a transfer whose other account is outside it. The other account is judged where
 * it is, when it still exists (`exists`), else where it was when archived (`transferSubLedgerId`, as archived totals
 * carry it). A total that isn't a transfer never crosses. Budgets count a transfer exactly when it crosses; so do
 * reports' flows.
 */
export function crossesScope(
  total: Pick<TransactionTotal, 'transferAccountId'> & { transferSubLedgerId?: string | null },
  scope: AccountScope,
  exists: (accountId: string) => boolean
): boolean {
  const other = total.transferAccountId
  if (other === null || other === undefined) return false
  if (exists(other)) return !scope.inside.has(other)
  return !scope.covers({ id: other, subLedgerId: total.transferSubLedgerId ?? null })
}
