// The rules of transactions, as functions over the collections of one storage transaction. The service runs each in a
// transaction and announces what it touched; everything here either completes or changes nothing.
//
// A transfer is two transactions sharing a `transferId`, one in each account, with opposite amounts. The amount, date,
// payee, memo and void state are mirrored to the other side; the number and the clearing status are each side's own.
import { randomUUID } from 'node:crypto'
import type { Doc } from '@tessera/types'
import { displayDate } from '@tessera/ledger-api'
import {
  AccountsError, isAccountsError, CATEGORY_NAME_MAX_LENGTH, CATEGORY_SEPARATOR, CLEARED_STATUSES, CLEARING_STATUSES, EXTERNAL_ID_MAX_LENGTH, MEMO_MAX_LENGTH,
  PAYEE_NAME_MAX_LENGTH, TRANSACTION_NUMBER_MAX_LENGTH, accountNameKey, categoryLabel, isAmount, isIsoDate,
  transferLabel,
  type Account, type AccountBalances, type BankMatch, type BankUnmatch, type Category, type ClearingStatus, type Confirmation, type PayeeSuggestion,
  type RegisterSnapshot, type Transaction, type TransactionDraft, type TransactionPatch, type WriteOptions
} from '@tessera/accounts-api'
import {
  invalid, optionalText, toAccount, toCategory, toPayee, toTransaction,
  type Collections, type StoredAccount, type StoredCategory, type StoredTransaction
} from './store'

/** The accounts a write touched: their transactions, and so their balances, changed. */
export type Touched = Set<string>

const notFound = () => new AccountsError('NOT_FOUND', 'That transaction no longer exists.')

// ---- Accounts

export async function accountOf(c: Collections, id: string, field?: string): Promise<Doc<StoredAccount>> {
  const account = typeof id === 'string' ? await c.accounts.get(id) : undefined
  if (!account) throw new AccountsError('NOT_FOUND', 'That account no longer exists.', field)
  return account
}

/** An account that may be written to: it exists and isn't closed. */
export async function openAccount(c: Collections, id: string, field?: string): Promise<Doc<StoredAccount>> {
  const account = await accountOf(c, id, field)
  if (account.closed) throw new AccountsError('ACCOUNT_CLOSED', `“${account.name}” is closed. Reopen it to change its transactions.`, field)
  return account
}

// ---- Balances

export interface Sums { current: number, cleared: number, reconciled: number, count: number }

/** Each account's transaction sums, in one pass: non-voided amounts by status, and a count of everything. */
export async function sumsByAccount(c: Collections): Promise<Map<string, Sums>> {
  const rows = await c.transactions.aggregate<{ _id: string } & Sums>([{
    $group: {
      _id: '$accountId',
      current: { $sum: { $cond: [{ voided: false }, '$amount', 0] } },
      cleared: { $sum: { $cond: [{ voided: false, status: { $in: [...CLEARED_STATUSES] } }, '$amount', 0] } },
      reconciled: { $sum: { $cond: [{ voided: false, status: 'reconciled' }, '$amount', 0] } },
      count: { $count: {} }
    }
  }])
  return new Map(rows.map(({ _id, ...sums }) => [_id, sums]))
}

/**
 * The same sums as `sumsByAccount`, in one plain pass over documents already read: 19 ms instead of 0.35 s at
 * 100,000 transactions (docs/ledger-compaction-design.md, Phase 0 results). An archive checks its balances with it.
 */
export function sumTransactions(transactions: Iterable<Pick<StoredTransaction, 'accountId' | 'amount' | 'status' | 'voided'>>): Map<string, Sums> {
  const sums = new Map<string, Sums>()
  for (const t of transactions) {
    let s = sums.get(t.accountId)
    if (!s) sums.set(t.accountId, s = { current: 0, cleared: 0, reconciled: 0, count: 0 })
    s.count++
    if (t.voided) continue
    s.current += t.amount
    if ((CLEARED_STATUSES as readonly string[]).includes(t.status)) s.cleared += t.amount
    if (t.status === 'reconciled') s.reconciled += t.amount
  }
  return sums
}

export function balancesFor(account: Pick<Account, 'openingBalance' | 'minimumBalance'>, sums?: Sums): AccountBalances {
  const current = account.openingBalance + (sums?.current ?? 0)
  return {
    current,
    available: current - (account.minimumBalance ?? 0),
    cleared: account.openingBalance + (sums?.cleared ?? 0),
    reconciled: account.openingBalance + (sums?.reconciled ?? 0),
    transactionCount: sums?.count ?? 0
  }
}

export async function balancesOf(c: Collections, account: Account): Promise<AccountBalances> {
  return balancesFor(account, (await sumsByAccount(c)).get(account.id))
}

// ---- Payees and categories

/** The payee with this name (ignoring case), created if new. */
export async function payeeNamed(c: Collections, name: string): Promise<string> {
  const key = accountNameKey(name)
  const existing = await c.payees.findOne({ nameKey: key })
  return existing ? existing.id : (await c.payees.insert({ name, nameKey: key })).id
}

export async function searchPayees(c: Collections, prefix: string, limit = 20): Promise<PayeeSuggestion[]> {
  const key = accountNameKey(String(prefix ?? ''))
  const payees = (await c.payees.find(undefined, { sort: { nameKey: 1 } })).filter(p => p.nameKey.startsWith(key)).slice(0, Math.max(0, limit))
  const suggestions: PayeeSuggestion[] = []
  for (const payee of payees) {
    const last = await c.transactions.findOne({ payeeId: payee.id }, { sort: { date: -1, createdAt: -1 } })
    suggestions.push({
      ...toPayee(payee),
      ...(last && { lastAmount: last.amount }),
      ...(last?.categoryId !== undefined && { lastCategoryId: last.categoryId }),
      ...(last?.transferAccountId !== undefined && { lastTransferAccountId: last.transferAccountId })
    })
  }
  return suggestions
}

export async function listCategories(c: Collections): Promise<Category[]> {
  return (await c.categories.find()).map(toCategory)
}

/** `Parent : Child`, each created if new (ignoring case); returns the leaf. */
export async function createCategory(c: Collections, path: string, kind: Category['kind']): Promise<{ category: Category, created: boolean }> {
  if (kind !== 'income' && kind !== 'expense') throw invalid('kind', 'Choose income or expense.')
  const names = String(path ?? '').split(CATEGORY_SEPARATOR.trim()).map(name => name.trim())
  if (names.length === 0 || names.some(name => name === '')) throw invalid('category', 'Enter a category, like “Food : Groceries”.')
  for (const name of names) {
    if (name.length > CATEGORY_NAME_MAX_LENGTH) throw invalid('category', `Use at most ${CATEGORY_NAME_MAX_LENGTH} characters for each part.`)
    if (/[\u0000-\u001f\u007f]/.test(name)) throw invalid('category', 'Remove the control characters.')
  }
  let parentId: string | null = null
  let leaf: Doc<StoredCategory> | undefined
  let created = false
  for (const name of names) {
    leaf = await c.categories.findOne({ parentId, nameKey: accountNameKey(name) }) ?? undefined
    if (!leaf) {
      leaf = await c.categories.insert({ parentId, name, nameKey: accountNameKey(name), kind })
      created = true
    }
    parentId = leaf.id
  }
  return { category: toCategory(leaf!), created }
}

// ---- Checking drafts

interface Checked {
  date: string
  number?: string
  amount: number
  payee?: string
  memo?: string
  categoryId?: string
  transferAccountId?: string
  status: ClearingStatus
  externalId?: string
}

/**
 * A bank line's identity, exactly as given: bank ids are compared as they are, so nothing is trimmed. Absent when
 * undefined or null.
 */
function checkExternalId(value: unknown, field = 'externalId'): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || value === '') throw invalid(field, 'A bank line needs an id.')
  if (value.length > EXTERNAL_ID_MAX_LENGTH) throw invalid(field, `A bank line's id has at most ${EXTERNAL_ID_MAX_LENGTH} characters.`)
  if (/[\u0000-\u001f\u007f]/.test(value)) throw invalid(field, "A bank line's id can't contain control characters.")
  return value
}

/** Refuses a bank line already in the account (on a transaction other than `except`): it was imported before. */
async function ensureExternalIdFree(c: Collections, accountId: string, externalId: string, except?: string) {
  const holder = await c.transactions.findOne({ accountId, externalId })
  if (holder && holder.id !== except) {
    throw new AccountsError('DUPLICATE_EXTERNAL_ID', `That bank line is already in this account (the transaction of ${holder.date}).`, 'externalId')
  }
}

export function checkDraft(draft: TransactionDraft): Checked {
  if (typeof draft !== 'object' || draft === null) throw invalid('date', 'Enter the transaction.')
  if (!isIsoDate(draft.date)) throw invalid('date', 'Enter a date.')
  if (!isAmount(draft.amount)) throw invalid('amount', 'Enter an amount.')
  const status = draft.status ?? 'uncleared'
  if (!(CLEARING_STATUSES as readonly string[]).includes(status)) throw invalid('status', 'Choose a status.')
  if (draft.categoryId != null && draft.transferAccountId != null) throw invalid('category', 'Choose a category or a transfer, not both.')
  const number = optionalText(draft.number, 'number', TRANSACTION_NUMBER_MAX_LENGTH)
  const payee = optionalText(draft.payee, 'payee', PAYEE_NAME_MAX_LENGTH)
  const memo = optionalText(draft.memo, 'memo', MEMO_MAX_LENGTH)
  const externalId = checkExternalId(draft.externalId)
  return {
    date: draft.date, amount: draft.amount, status,
    ...(externalId !== undefined && { externalId }),
    ...(number !== undefined && { number }),
    ...(payee !== undefined && { payee }),
    ...(memo !== undefined && { memo }),
    ...(draft.categoryId != null && { categoryId: draft.categoryId }),
    ...(draft.transferAccountId != null && { transferAccountId: draft.transferAccountId })
  }
}

async function checkCategory(c: Collections, id: string) {
  if (!(await c.categories.get(id))) throw new AccountsError('NOT_FOUND', 'That category no longer exists.', 'category')
}

/** The other account of a transfer: open, another account, and in the same currency. */
async function transferTarget(c: Collections, from: Doc<StoredAccount>, id: string): Promise<Doc<StoredAccount>> {
  if (id === from.id) throw invalid('category', 'A transfer needs another account.')
  const to = await openAccount(c, id, 'category')
  if (to.currency !== from.currency) {
    throw new AccountsError('CURRENCY_MISMATCH', `“${to.name}” is in ${to.currency}; “${from.name}” is in ${from.currency}.`, 'category')
  }
  return to
}

/** The other side of a transfer. */
async function otherSide(c: Collections, transaction: Doc<StoredTransaction>): Promise<Doc<StoredTransaction> | undefined> {
  if (transaction.transferId === undefined) return undefined
  return (await c.transactions.find({ transferId: transaction.transferId })).find(t => t.id !== transaction.id)
}

/**
 * Nothing new is dated before an account's last archival date: that period's history is in the archive file, and the
 * opening balance stands for it. `from` is the transaction's date before an edit. A transaction that stayed from
 * before the date (it wasn't reconciled when the ledger was archived) can still be edited, its date included; one
 * dated on or after it can't be moved before it. See docs/ledger-compaction-design.md, "Entering transactions after an
 * archive".
 */
export function checkArchivePeriod(account: Pick<StoredAccount, 'name' | 'lastArchiveDate'>, date: string, from?: string, field = 'date') {
  const start = account.lastArchiveDate
  if (start === undefined || date >= start || (from !== undefined && from < start)) return
  throw invalid(field, `“${account.name}” has been archived before ${displayDate(start)}, so its transactions must be dated ${displayDate(start)} or later.`)
}

/** Refuses, unless confirmed, a change that alters a reconciled balance. */
function guardReconciled(needed: boolean, options: WriteOptions, what: Pick<StoredTransaction, 'date'>) {
  if (needed && !options.confirm?.includes('reconciled')) {
    throw new AccountsError('CONFIRMATION_REQUIRED',
      `The transaction of ${what.date} is reconciled. Changing it changes a reconciled balance, which the next statement starts from.`,
      undefined, ['reconciled'] satisfies Confirmation[])
  }
}

const sides = (mine: Pick<StoredTransaction, 'accountId'>, other?: Pick<StoredTransaction, 'accountId'>): string[] =>
  other ? [mine.accountId, other.accountId] : [mine.accountId]

// ---- Writing

export async function createTransaction(c: Collections, accountId: string, draft: TransactionDraft, now: string): Promise<{ transaction: Transaction, touched: Touched }> {
  const account = await openAccount(c, accountId)
  const fields = checkDraft(draft)
  if (fields.status === 'reconciled') throw invalid('status', 'Transactions become reconciled by reconciling the account.')
  if (fields.categoryId !== undefined) await checkCategory(c, fields.categoryId)
  const target = fields.transferAccountId === undefined ? undefined : await transferTarget(c, account, fields.transferAccountId)
  checkArchivePeriod(account, fields.date)
  if (target) checkArchivePeriod(target, fields.date)
  if (fields.externalId !== undefined) await ensureExternalIdFree(c, accountId, fields.externalId)
  const payeeId = fields.payee === undefined ? undefined : await payeeNamed(c, fields.payee)

  const transferId = target ? randomUUID() : undefined
  // The bank line's id stays on this side: the other side of a transfer is another account's line
  const doc: StoredTransaction = {
    accountId, date: fields.date, amount: fields.amount, status: fields.status, voided: false, createdAt: now, updatedAt: now,
    ...(fields.externalId !== undefined && { externalId: fields.externalId }),
    ...(fields.number !== undefined && { number: fields.number }),
    ...(payeeId !== undefined && { payeeId }),
    ...(fields.memo !== undefined && { memo: fields.memo }),
    ...(fields.categoryId !== undefined && { categoryId: fields.categoryId }),
    ...(target && { transferId, transferAccountId: target.id })
  }
  const created = await c.transactions.insert(doc)
  if (target) {
    await c.transactions.insert({
      accountId: target.id, date: fields.date, amount: -fields.amount, status: 'uncleared', voided: false,
      createdAt: now, updatedAt: now, transferId, transferAccountId: accountId,
      ...(payeeId !== undefined && { payeeId }),
      ...(fields.memo !== undefined && { memo: fields.memo })
    })
  }
  return { transaction: toTransaction(created), touched: new Set([accountId, ...(target ? [target.id] : [])]) }
}

/** A transaction of this account, or NOT_FOUND. */
async function ownTransaction(c: Collections, accountId: string, id: string): Promise<Doc<StoredTransaction>> {
  const found = typeof id === 'string' ? await c.transactions.get(id) : undefined
  if (!found || found.accountId !== accountId) throw notFound()
  return found
}

export async function updateTransaction(
  c: Collections, accountId: string, id: string, patch: TransactionPatch, options: WriteOptions, now: string
): Promise<{ transaction: Transaction, touched: Touched }> {
  const account = await openAccount(c, accountId)
  const current = await ownTransaction(c, accountId, id)
  if (options.expectedRev !== undefined && current.rev !== options.expectedRev) {
    throw new AccountsError('CONFLICT', 'This transaction was changed elsewhere. Try again.')
  }
  if (typeof patch !== 'object' || patch === null) throw invalid('date', 'Nothing to change.')

  // The transaction as a draft, with the patch applied; choosing a category ends a transfer and the other way round
  const payeeName = current.payeeId === undefined ? undefined : (await c.payees.get(current.payeeId))?.name
  const merged: Record<string, unknown> = {
    date: current.date, number: current.number, amount: current.amount, payee: payeeName, memo: current.memo,
    categoryId: current.categoryId, transferAccountId: current.transferAccountId, status: current.status,
    externalId: current.externalId
  }
  for (const [key, value] of Object.entries(patch)) if (value !== undefined) merged[key] = value === null ? undefined : value
  if (patch.categoryId != null && patch.transferAccountId === undefined) merged.transferAccountId = undefined
  if (patch.transferAccountId != null && patch.categoryId === undefined) merged.categoryId = undefined
  const fields = checkDraft(merged as unknown as TransactionDraft)
  if (fields.categoryId !== undefined && fields.categoryId !== current.categoryId) await checkCategory(c, fields.categoryId)
  if (fields.externalId !== undefined && fields.externalId !== current.externalId) await ensureExternalIdFree(c, accountId, fields.externalId, id)

  const other = await otherSide(c, current)
  const sameTransfer = other !== undefined && fields.transferAccountId === current.transferAccountId
  const amountOrDate = fields.amount !== current.amount || fields.date !== current.date
  checkArchivePeriod(account, fields.date, current.date)
  if (sameTransfer && fields.date !== other.date) checkArchivePeriod(await accountOf(c, other.accountId), fields.date, other.date)
  guardReconciled(
    (current.status === 'reconciled' && (amountOrDate || fields.status !== current.status)) ||
    (fields.status === 'reconciled' && current.status !== 'reconciled') ||
    (other?.status === 'reconciled' && (!sameTransfer || amountOrDate)),
    options, current)

  const payeeId = fields.payee === undefined ? undefined : await payeeNamed(c, fields.payee)
  const touched: Touched = new Set([accountId])

  let transferId: string | undefined
  if (sameTransfer) {
    // Mirror what both sides share
    transferId = current.transferId
    const mirrored = { date: fields.date, amount: -fields.amount, payeeId, memo: fields.memo }
    if (other.date !== mirrored.date || other.amount !== mirrored.amount || other.payeeId !== mirrored.payeeId || other.memo !== mirrored.memo) {
      await openAccount(c, other.accountId)
      const { rev: _rev, ...rest } = other
      await c.transactions.replace(strip({ ...rest, ...mirrored, updatedAt: now }))
      touched.add(other.accountId)
    }
  } else {
    if (other) {
      // The transfer ends, or goes to another account: this other side goes
      await openAccount(c, other.accountId)
      await c.transactions.deleteOne({ id: other.id })
      touched.add(other.accountId)
    }
    if (fields.transferAccountId !== undefined) {
      const target = await transferTarget(c, account, fields.transferAccountId)
      checkArchivePeriod(target, fields.date)
      transferId = randomUUID()
      await c.transactions.insert(strip({
        accountId: target.id, date: fields.date, amount: -fields.amount, status: 'uncleared', voided: current.voided,
        createdAt: now, updatedAt: now, transferId, transferAccountId: accountId, payeeId, memo: fields.memo
      }))
      touched.add(target.id)
    }
  }

  const { rev: _rev, ...keep } = current
  const next = strip({
    id, accountId, date: fields.date, amount: fields.amount, status: fields.status, voided: current.voided,
    createdAt: keep.createdAt, updatedAt: now, number: fields.number, payeeId, memo: fields.memo,
    categoryId: fields.categoryId, transferId, transferAccountId: transferId === undefined ? undefined : fields.transferAccountId,
    externalId: fields.externalId, splits: keep.splits
  })
  const saved = await c.transactions.replace(next as StoredTransaction & { id: string })
  return { transaction: toTransaction(saved), touched }
}

/** Drops undefined fields, so a replaced document doesn't keep a key with no value. */
function strip<T extends object>(doc: T): T {
  return Object.fromEntries(Object.entries(doc).filter(([, value]) => value !== undefined)) as T
}

export async function deleteTransactions(c: Collections, accountId: string, ids: string[], options: WriteOptions): Promise<Touched> {
  await openAccount(c, accountId)
  const touched: Touched = new Set([accountId])
  for (const id of new Set(ids)) {
    const transaction = await ownTransaction(c, accountId, id)
    const other = await otherSide(c, transaction)
    guardReconciled(transaction.status === 'reconciled' || other?.status === 'reconciled', options, transaction)
    if (other) {
      await openAccount(c, other.accountId)
      await c.transactions.deleteOne({ id: other.id })
      touched.add(other.accountId)
    }
    await c.transactions.deleteOne({ id })
  }
  return touched
}

export async function setStatus(c: Collections, accountId: string, ids: string[], status: ClearingStatus, options: WriteOptions, now: string): Promise<Touched> {
  await openAccount(c, accountId)
  if (!(CLEARING_STATUSES as readonly string[]).includes(status)) throw invalid('status', 'Choose a status.')
  for (const id of new Set(ids)) {
    const transaction = await ownTransaction(c, accountId, id)
    if (transaction.status === status) continue
    guardReconciled(transaction.status === 'reconciled' || status === 'reconciled', options, transaction)
    // Not mirrored: each side of a transfer is cleared against its own statement
    await c.transactions.updateOne({ id }, { $set: { status, updatedAt: now } })
  }
  return new Set([accountId])
}

export async function setVoided(c: Collections, accountId: string, ids: string[], voided: boolean, options: WriteOptions, now: string): Promise<Touched> {
  await openAccount(c, accountId)
  const touched: Touched = new Set([accountId])
  for (const id of new Set(ids)) {
    const transaction = await ownTransaction(c, accountId, id)
    if (transaction.voided === voided) continue
    const other = await otherSide(c, transaction)
    guardReconciled(transaction.status === 'reconciled' || other?.status === 'reconciled', options, transaction)
    await c.transactions.updateOne({ id }, { $set: { voided, updatedAt: now } })
    if (other) {
      await openAccount(c, other.accountId)
      await c.transactions.updateOne({ id: other.id }, { $set: { voided, updatedAt: now } })
      touched.add(other.accountId)
    }
  }
  return touched
}

// ---- For importers: bank lines in, and matched to what the user entered

/** Runs `work`, naming where its accounts error comes from: field `date` becomes `drafts[3].date`, say. */
async function naming<T>(prefix: string, work: () => Promise<T> | T): Promise<T> {
  try {
    return await work()
  } catch (err) {
    if (!isAccountsError(err)) throw err
    throw new AccountsError(err.code, err.message, err.field === undefined ? prefix : `${prefix}.${err.field}`, err.reasons)
  }
}

const merge = (into: Touched, from: Iterable<string>) => { for (const id of from) into.add(id) }

/**
 * Creates every draft, or none: the caller runs it in one storage transaction. Every draft is checked first, so a
 * problem anywhere is found before anything is written, and names its draft (`drafts[3].date`).
 */
export async function createTransactions(c: Collections, accountId: string, drafts: TransactionDraft[], now: string): Promise<{ transactions: Transaction[], touched: Touched }> {
  if (!Array.isArray(drafts)) throw invalid('drafts', 'Give the transactions as a list.')
  await openAccount(c, accountId)
  const lines = new Map<string, number>()
  for (const [i, draft] of drafts.entries()) {
    const fields = await naming(`drafts[${i}]`, () => checkDraft(draft))
    if (fields.status === 'reconciled') throw invalid(`drafts[${i}].status`, 'Transactions become reconciled by reconciling the account.')
    if (fields.externalId === undefined) continue
    const first = lines.get(fields.externalId)
    if (first !== undefined) {
      throw new AccountsError('DUPLICATE_EXTERNAL_ID', `Transactions ${first + 1} and ${i + 1} are the same bank line.`, `drafts[${i}].externalId`)
    }
    lines.set(fields.externalId, i)
  }

  const touched: Touched = new Set([accountId])
  const transactions: Transaction[] = []
  for (const [i, draft] of drafts.entries()) {
    const result = await naming(`drafts[${i}]`, () => createTransaction(c, accountId, draft, now))
    transactions.push(result.transaction)
    merge(touched, result.touched)
  }
  return { transactions, touched }
}

/** What a bank line changes: checked before anything is written. Fields are named under `prefix`. */
function checkBankFields(values: { date?: unknown, amount?: unknown, status?: unknown }, prefix = '') {
  if (values.date !== undefined && !isIsoDate(values.date)) throw invalid(`${prefix}date`, 'Enter a date.')
  if (values.amount !== undefined && !isAmount(values.amount)) throw invalid(`${prefix}amount`, 'Enter an amount.')
  if (values.status !== undefined && !(CLEARING_STATUSES as readonly unknown[]).includes(values.status)) throw invalid(`${prefix}status`, 'Choose a status.')
}

/**
 * Links a bank line to a transaction already in the account. Deletes `replaces` first (the transaction the same line
 * was added as, so it must carry the line's id), then gives the transaction the line's id, date, amount and status
 * through the same rules as any edit: a transfer's other side follows, and a reconciled one needs confirming.
 */
export async function matchTransaction(
  c: Collections, accountId: string, id: string, match: BankMatch, options: WriteOptions, now: string
): Promise<{ transaction: Transaction, touched: Touched }> {
  await openAccount(c, accountId)
  if (typeof match !== 'object' || match === null) throw invalid('externalId', 'Give the bank line to match.')
  const externalId = checkExternalId(match.externalId)
  if (externalId === undefined) throw invalid('externalId', 'A bank line needs an id.')
  checkBankFields(match)
  if (match.status === 'reconciled') throw invalid('status', 'Transactions become reconciled by reconciling the account.')

  const target = await ownTransaction(c, accountId, id)
  if (options.expectedRev !== undefined && target.rev !== options.expectedRev) {
    throw new AccountsError('CONFLICT', 'This transaction was changed elsewhere. Try again.')
  }
  if (target.voided) throw invalid('id', 'A void transaction can’t be matched to a bank line. Unvoid it first.')
  if (target.externalId !== undefined && target.externalId !== externalId) {
    throw invalid('id', 'That transaction is already matched to another bank line. Unmatch it first.')
  }

  const touched: Touched = new Set([accountId])
  if (match.replaces !== undefined) {
    if (typeof match.replaces !== 'string' || match.replaces === id) throw invalid('replaces', 'Choose the transaction the bank line was added as.')
    const replaced = await naming('replaces', () => ownTransaction(c, accountId, match.replaces!))
    // Only the line's own earlier transaction may go, so a match can never lose another bank line
    if (replaced.externalId !== externalId) throw invalid('replaces', 'That transaction isn’t the one this bank line was added as.')
    merge(touched, await deleteTransactions(c, accountId, [replaced.id], options))
  }

  // A user's cleared mark is stronger than the bank's: it stays
  const status = match.status ?? (target.status === 'cleared' || target.status === 'reconciled' ? target.status : 'electronic')
  const patch: TransactionPatch = {
    externalId, status,
    ...(match.date !== undefined && { date: match.date }),
    ...(match.amount !== undefined && { amount: match.amount })
  }
  const updated = await updateTransaction(c, accountId, id, patch, options, now)
  merge(touched, updated.touched)
  return { transaction: updated.transaction, touched }
}

/**
 * Takes the bank line off a transaction: clears its id and puts back `restore` (through the same rules as any edit),
 * then creates `add`, which takes over the id.
 */
export async function unmatchTransaction(
  c: Collections, accountId: string, id: string, unmatch: BankUnmatch, options: WriteOptions, now: string
): Promise<{ transaction: Transaction, added?: Transaction, touched: Touched }> {
  await openAccount(c, accountId)
  if (typeof unmatch !== 'object' || unmatch === null) throw invalid('restore', 'Say what to put back.')
  const restore = unmatch.restore ?? {}
  if (typeof restore !== 'object' || restore === null) throw invalid('restore', 'Say what to put back.')
  checkBankFields(restore, 'restore.')
  if (unmatch.add !== undefined && (typeof unmatch.add !== 'object' || unmatch.add === null)) throw invalid('add', 'Give the bank line as a transaction.')

  const target = await ownTransaction(c, accountId, id)
  const externalId = target.externalId
  if (externalId === undefined) throw invalid('id', 'That transaction isn’t matched to a bank line.')
  if (unmatch.add?.externalId != null && unmatch.add.externalId !== externalId) {
    throw invalid('add.externalId', 'The bank line keeps its id: leave it out, or give the same one.')
  }

  const patch: TransactionPatch = {
    externalId: null,
    ...(restore.date !== undefined && { date: restore.date }),
    ...(restore.amount !== undefined && { amount: restore.amount }),
    ...(restore.status !== undefined && { status: restore.status })
  }
  const updated = await updateTransaction(c, accountId, id, patch, options, now)
  const touched: Touched = new Set(updated.touched)
  if (unmatch.add === undefined) return { transaction: updated.transaction, touched }

  const created = await naming('add', () => createTransaction(c, accountId, { ...unmatch.add!, externalId }, now))
  merge(touched, created.touched)
  return { transaction: updated.transaction, added: created.transaction, touched }
}

/**
 * Deletes an account's transactions. The other side of each transfer stays, in its own account, as an ordinary
 * uncategorised transaction with a note, so no other account's balance changes. Returns the accounts touched.
 */
export async function deleteTransactionsOfAccount(c: Collections, account: Pick<Account, 'id' | 'name'>, now: string): Promise<Touched> {
  const touched: Touched = new Set([account.id])
  for (const transaction of await c.transactions.find({ accountId: account.id })) {
    const other = await otherSide(c, transaction)
    if (other) {
      const note = `(transfer with deleted account “${account.name}”)`
      await c.transactions.updateOne({ id: other.id }, {
        $unset: { transferId: true, transferAccountId: true },
        $set: { memo: other.memo ? `${other.memo} ${note}` : note, updatedAt: now }
      })
      touched.add(other.accountId)
    }
    await c.transactions.deleteOne({ id: transaction.id })
  }
  return touched
}

// ---- Reading

export async function listTransactions(c: Collections, accountId: string, range: { from?: string, to?: string } = {}): Promise<Transaction[]> {
  const date: Record<string, string> = {}
  if (range.from !== undefined) date.$gte = range.from
  if (range.to !== undefined) date.$lte = range.to
  const filter = Object.keys(date).length > 0 ? { accountId, date } : { accountId }
  // Ties on the date keep entry order: ids are time-ordered, and every sort ends with the id
  return (await c.transactions.find(filter, { sort: { date: 1 } })).map(toTransaction)
}

export async function registerOf(c: Collections, accountId: string): Promise<RegisterSnapshot> {
  const account = toAccount(await accountOf(c, accountId))
  const transactions = await listTransactions(c, accountId)
  const payees = new Map((await c.payees.find()).map(p => [p.id, p.name]))
  const categories = await listCategories(c)
  const accountNames = new Map((await c.accounts.find()).map(a => [a.id, a.name]))

  let running = account.openingBalance
  const rows = transactions.map(transaction => {
    if (!transaction.voided) running += transaction.amount
    const label = transaction.transferAccountId !== undefined
      ? transferLabel(transaction.amount, accountNames.get(transaction.transferAccountId) ?? 'another account')
      : categoryLabel(categories, transaction.categoryId)
    const payeeName = transaction.payeeId === undefined ? undefined : payees.get(transaction.payeeId)
    return {
      transaction, balance: running, available: running - (account.minimumBalance ?? 0),
      ...(payeeName !== undefined && { payeeName }),
      ...(label !== undefined && { categoryLabel: label })
    }
  })
  const sums = (await sumsByAccount(c)).get(accountId)
  return { account, rows, balances: balancesFor(account, sums) }
}

/** The account's transactions carrying one of these bank line ids, in register order. */
export async function findByExternalIds(c: Collections, accountId: string, ids: string[]): Promise<Transaction[]> {
  await accountOf(c, accountId)
  if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) throw invalid('ids', 'Give the bank line ids as a list of text.')
  const wanted = [...new Set(ids.filter(id => id !== ''))]
  if (wanted.length === 0) return []
  return (await c.transactions.find({ accountId, externalId: { $in: wanted } }, { sort: { date: 1 } })).map(toTransaction)
}

/** One more than the highest numeric transaction number, archived ones included. */
export async function nextNumber(c: Collections, accountId: string): Promise<string | undefined> {
  let highest = (await c.accounts.get(accountId))?.archived?.highestNumber
  for (const { number } of await c.transactions.find({ accountId })) {
    if (number !== undefined && /^\d{1,15}$/.test(number)) highest = Math.max(highest ?? 0, Number(number))
  }
  return highest === undefined ? undefined : String(highest + 1)
}
