// The rules of transactions, as functions over the collections of one storage transaction. The service runs each in a
// transaction and announces what it touched; everything here either completes or changes nothing.
//
// A transfer is two transactions sharing a `transferId`, one in each account, with opposite amounts. The amount, date,
// payee, memo and void state are mirrored to the other side; the number and the clearing status are each side's own.
import { randomUUID } from 'node:crypto'
import type { Doc } from '@tessera/types'
import {
  AccountsError, CATEGORY_NAME_MAX_LENGTH, CATEGORY_SEPARATOR, CLEARED_STATUSES, CLEARING_STATUSES, MEMO_MAX_LENGTH,
  PAYEE_NAME_MAX_LENGTH, TRANSACTION_NUMBER_MAX_LENGTH, accountNameKey, categoryLabel, isAmount, isIsoDate,
  transferLabel,
  type Account, type AccountBalances, type Category, type ClearingStatus, type Confirmation, type PayeeSuggestion,
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

interface Sums { current: number, cleared: number, reconciled: number, count: number }

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
  return {
    date: draft.date, amount: draft.amount, status,
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
  const payeeId = fields.payee === undefined ? undefined : await payeeNamed(c, fields.payee)

  const transferId = target ? randomUUID() : undefined
  const doc: StoredTransaction = {
    accountId, date: fields.date, amount: fields.amount, status: fields.status, voided: false, createdAt: now, updatedAt: now,
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
    categoryId: current.categoryId, transferAccountId: current.transferAccountId, status: current.status
  }
  for (const [key, value] of Object.entries(patch)) if (value !== undefined) merged[key] = value === null ? undefined : value
  if (patch.categoryId != null && patch.transferAccountId === undefined) merged.transferAccountId = undefined
  if (patch.transferAccountId != null && patch.categoryId === undefined) merged.categoryId = undefined
  const fields = checkDraft(merged as unknown as TransactionDraft)
  if (fields.categoryId !== undefined && fields.categoryId !== current.categoryId) await checkCategory(c, fields.categoryId)

  const other = await otherSide(c, current)
  const sameTransfer = other !== undefined && fields.transferAccountId === current.transferAccountId
  const amountOrDate = fields.amount !== current.amount || fields.date !== current.date
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
    externalId: keep.externalId, splits: keep.splits
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

export async function nextNumber(c: Collections, accountId: string): Promise<string | undefined> {
  let highest: number | undefined
  for (const { number } of await c.transactions.find({ accountId })) {
    if (number !== undefined && /^\d{1,15}$/.test(number)) highest = Math.max(highest ?? 0, Number(number))
  }
  return highest === undefined ? undefined : String(highest + 1)
}
