// What filing a statement needs settled before anything is stored: which account it belongs to, what the
// account dialog would be prefilled with when it belongs to none, and how one incoming transaction becomes the
// draft the register writes. Nothing here writes anything.
import type {
  Account, AccountsService, Category, RegisterRow
} from '@tessera/accounts-api'
import { CATEGORY_SEPARATOR, accountNumberKey, categoryLabel } from '@tessera/accounts-api'
import {
  ExchangeError,
  type AccountCreationInput, type AccountLink, type AccountMatchedBy, type ExchangeStatement,
  type ExchangeTransaction, type ImportDraft, type PayeeRule, type RegisterLine
} from '@tessera/exchange-api'
import type { RuleOutcome } from './rules'
import type { ExistingRow } from './matcher'

// ---- Account resolution -----------------------------------------------------------------------

/** Which account a statement lands in, when something already settles it; else the user is asked. */
export type ResolvedTarget =
  | { kind: 'existing', accountId: string, matchedBy: AccountMatchedBy }
  | { kind: 'unresolved' }

/**
 * Which account a statement lands in. A saved link first — the common case, and why the second import of a
 * source asks nothing — then the account number, then the name, and only then the user.
 */
export async function resolveAccount(
  statement: ExchangeStatement,
  formatId: string,
  deps: { accounts: AccountsService, links: readonly AccountLink[] },
  chosen?: string
): Promise<{ target: ResolvedTarget, link?: AccountLink }> {
  const all = await deps.accounts.list({ includeClosed: true })

  if (chosen !== undefined) {
    const account = all.find(a => a.id === chosen)
    if (!account) throw new ExchangeError('NOT_FOUND', 'That account no longer exists.', 'accountId')
    return { target: { kind: 'existing', accountId: account.id, matchedBy: 'user' } }
  }

  const link = linkForSource(deps.links, formatId, statement.account)
  const numberKey = accountNumberKey(statement.account.number ?? '')
  if (link !== undefined && all.some(a => a.id === link.accountId)) {
    return { target: { kind: 'existing', accountId: link.accountId, matchedBy: 'link' }, link }
  }

  // The account number, ignoring spaces, dashes and case. A statement often shows only the last four digits,
  // which is what `AccountFilter.accountNumber: { endsWith }` exists for.
  if (numberKey.length >= 4) {
    const byNumber = all.filter(a => {
      const theirs = accountNumberKey(a.accountNumber ?? '')
      return theirs !== '' && (theirs === numberKey || theirs.endsWith(numberKey) || numberKey.endsWith(theirs))
    })
    if (byNumber.length === 1) return { target: { kind: 'existing', accountId: byNumber[0].id, matchedBy: 'number' } }
  }

  const name = (statement.account.name ?? '').trim().toLowerCase()
  if (name !== '') {
    const byName = all.filter(a => a.name.trim().toLowerCase() === name)
    if (byName.length === 1) return { target: { kind: 'existing', accountId: byName[0].id, matchedBy: 'name' } }
  }

  return { target: { kind: 'unresolved' } }
}

/**
 * What the account dialog would be prefilled with, for a statement with no home. The opening balance is the
 * statement's ledger balance less the sum of its transactions, so that once the statement is read the account's
 * balance is the bank's — which is what makes a first import reconcile instead of being out by a month.
 */
export function accountFromStatement(
  statement: ExchangeStatement, today: string, institution?: string
): AccountCreationInput | undefined {
  const currency = statement.account.currency
  if (currency === undefined) return undefined

  const sum = statement.transactions.reduce((total, row) => total + row.amount, 0)
  const ledger = statement.balances?.ledger
  const openingDate = statement.period?.from ?? statement.transactions[0]?.date ?? today

  return {
    name: statement.account.name?.trim() || `Imported account ${statement.account.number ?? ''}`.trim(),
    type: statement.account.type ?? 'chequing',
    subBookId: null,
    currency,
    openingDate,
    openingBalance: ledger === undefined ? 0 : ledger.amount - sum,
    ...(statement.account.number !== undefined && { accountNumber: statement.account.number }),
    // The bank's own two identifiers, kept so a statement from this source is recognised next month and an
    // exported OFX can write them back rather than inventing them.
    ...(statement.account.bankId !== undefined && { routingNumber: statement.account.bankId }),
    ...(institution !== undefined && { institution })
  }
}

/** A statement in the user's words, for the account dialog's title: '“Chequing” ····6789'. */
export function describeStatement(statement: ExchangeStatement, institution?: string): string {
  const { name, number } = statement.account
  const masked = number === undefined ? undefined : `····${accountNumberKey(number).slice(-4)}`
  const named = name?.trim()
  if (named) return [`“${named}”`, masked].filter(Boolean).join(' ')
  const bank = institution === undefined ? 'The' : `The ${institution}`
  return `${bank} account${masked === undefined ? '' : ` ${masked}`}`
}

/**
 * A statement in a currency the account does not use is refused rather than converted, in line with how
 * `accounts.service` treats a transfer between currencies. Multi-currency is a later feature.
 */
export function checkCurrency(statement: ExchangeStatement, account: Account) {
  const currency = statement.account.currency
  if (currency !== undefined && currency.toUpperCase() !== account.currency) {
    throw new ExchangeError('CURRENCY_MISMATCH',
      `This statement is in ${currency.toUpperCase()}; “${account.name}” is in ${account.currency}.`, 'currency')
  }
}

// ---- Categories ---------------------------------------------------------------------------------

/** `Parent : Child` → id, matched ignoring case and the spaces around the separator. */
export function categoryIndex(categories: readonly Category[]): Map<string, string> {
  const index = new Map<string, string>()
  for (const category of categories) {
    const label = categoryLabel(categories, category.id)
    if (label !== undefined) index.set(normalisePath(label), category.id)
  }
  return index
}

/**
 * The saved link for a statement source: the same format, the same account number (normalised), the same bank.
 * One predicate for both places that ask — resolving which account a new statement belongs to, and finding the
 * per-source settings of one already filed — so a source cannot be "linked" for one purpose and not the other.
 */
export function linkForSource(
  links: readonly AccountLink[],
  formatId: string,
  source: { number?: string, bankId?: string }
): AccountLink | undefined {
  const numberKey = accountNumberKey(source.number ?? '')
  if (numberKey === '') return undefined
  return links.find(l =>
    l.formatId === formatId &&
    l.numberKey === numberKey &&
    (l.bankId ?? '') === (source.bankId ?? ''))
}

export const normalisePath = (path: string) =>
  path.split(/\s*[:>]\s*/).map(part => part.trim().toLowerCase()).filter(part => part !== '').join(CATEGORY_SEPARATOR.trim())

// ---- Building a draft -----------------------------------------------------------------------------

export interface DraftingDeps {
  /**
   * What the payee resolved to, settled before matching by `resolveRename` and passed in rather than worked
   * out again here. One resolution per row: the name the matcher compared on has to be the name written, or a
   * row could match on one payee and land in the register under another.
   */
  renamed: RuleOutcome
  /** `Parent : Child` (normalised) → category id. */
  categories: Map<string, string>
  /** Account name (lower case) → id, for a transfer the file named. */
  accountsByName: Map<string, string>
}

/** What one incoming row would be written as: the draft, with its rename and category resolved. */
export function buildDraft(incoming: ExchangeTransaction, account: Account, deps: DraftingDeps): ImportDraft {
  const renamed = deps.renamed
  const payee = renamed.payee ?? incoming.payee
  const transferAccountId = incoming.transferAccount === undefined
    ? undefined
    : deps.accountsByName.get(incoming.transferAccount.trim().toLowerCase())
  const categoryId = transferAccountId !== undefined
    ? undefined
    : renamed.categoryId ?? (incoming.category === undefined ? undefined : deps.categories.get(normalisePath(incoming.category)))

  const memo = memoWithOriginal(incoming)
  return {
    date: incoming.date,
    amount: incoming.amount,
    // Accepting a row asserts the source has reported it, which is exactly what `electronic` means
    status: 'electronic',
    ...(payee !== undefined && payee.trim() !== '' && { payee: payee.trim() }),
    ...(memo !== undefined && { memo }),
    ...(incoming.number !== undefined && incoming.number.trim() !== '' && { number: incoming.number.trim() }),
    ...(categoryId !== undefined && { categoryId }),
    ...(transferAccountId !== undefined && transferAccountId !== account.id && { transferAccountId }),
    ...(incoming.externalId !== undefined && { externalId: incoming.externalId })
  }
}

/**
 * The memo, with what the purchase was originally in appended when the bank converted it for us. The figure
 * itself needs no conversion — the bank already did it — but the user deserves to see why it is an odd number.
 */
function memoWithOriginal(incoming: ExchangeTransaction): string | undefined {
  const original = incoming.originalAmount
  if (original === undefined) return incoming.memo
  const note = `${original.currency} ${(original.amount / 100).toFixed(2)}`
  return incoming.memo === undefined || incoming.memo.trim() === '' ? note : `${incoming.memo} (${note})`
}

// ---- Register rows as matching sees them ---------------------------------------------------------

export const toExistingRow = (row: RegisterRow): ExistingRow => ({
  ...row.transaction,
  ...(row.payeeName !== undefined && { payeeName: row.payeeName })
})

/** A transaction as a dialog shows it: the fields a person compares, with the payee by name. */
export const toRegisterLine = (row: ExistingRow): RegisterLine => ({
  id: row.id,
  date: row.date,
  amount: row.amount,
  status: row.status,
  ...(row.number !== undefined && { number: row.number }),
  ...(row.payeeName !== undefined && { payee: row.payeeName }),
  ...(row.memo !== undefined && { memo: row.memo }),
  ...(row.categoryId !== undefined && { categoryId: row.categoryId }),
  ...(row.transferAccountId !== undefined && { transferAccountId: row.transferAccountId }),
  ...(row.externalId !== undefined && { externalId: row.externalId })
})
