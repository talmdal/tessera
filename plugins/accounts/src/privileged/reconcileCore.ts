// Reconciling an account against a statement, as functions over one storage transaction's collections.
//
// Marking a transaction sets its status (cleared, or uncleared) at once, so a paused reconciliation survives a
// restart, and records the status it had before, so Cancel can put it back. Finishing makes every marked transaction
// reconciled and records the statement on the account.
import type { Doc } from '@tessera/types'
import {
  AccountsError, categoryLabel, chargeAmount, formatAmount, isAmount, isIsoDate, transferLabel,
  type ChargeKind, type ClearingStatus, type Confirmation, type ReconcileCandidate, type ReconcileResult,
  type ReconcileState, type Reconciliation, type StatementCharge, type StatementFigures, type StatementInput
} from '@tessera/accounts-api'
import { invalid, toAccount, toTransaction, type Collections, type StoredReconciliation, type StoredTransaction } from './store'
import {
  accountOf, balancesFor, createTransaction, deleteTransactions, listCategories, openAccount, payeeNamed, sumsByAccount,
  type Touched
} from './transactionsCore'

const MARKED: readonly ClearingStatus[] = ['cleared', 'electronic']

const toReconciliation = (doc: Doc<StoredReconciliation>): Reconciliation => ({
  id: doc.id, rev: doc.rev, accountId: doc.accountId, reconcilerId: doc.reconcilerId, paused: doc.paused, addedIds: doc.addedIds ?? [],
  startedAt: doc.startedAt, statementDate: doc.statementDate, startingBalance: doc.startingBalance, statementBalance: doc.statementBalance
})

export async function inProgress(c: Collections, accountId: string): Promise<Doc<StoredReconciliation> | undefined> {
  return (await c.reconciliations.findOne({ activeFor: accountId })) ?? undefined
}

async function required(c: Collections, accountId: string): Promise<Doc<StoredReconciliation>> {
  const found = await inProgress(c, accountId)
  if (!found) throw new AccountsError('NOT_FOUND', 'This account has no reconciliation in progress.')
  return found
}

export function checkFigures(figures: StatementFigures): StatementFigures {
  if (typeof figures !== 'object' || figures === null) throw invalid('statementDate', 'Enter the statement’s figures.')
  if (!isIsoDate(figures.statementDate)) throw invalid('statementDate', 'Enter the statement date.')
  if (!isAmount(figures.startingBalance)) throw invalid('startingBalance', 'Enter the starting balance.')
  if (!isAmount(figures.statementBalance)) throw invalid('statementBalance', 'Enter the ending balance.')
  return { statementDate: figures.statementDate, startingBalance: figures.startingBalance, statementBalance: figures.statementBalance }
}

/** The account's unreconciled, non-voided transactions, and the running figures. */
export async function stateOf(c: Collections, accountId: string, session: Doc<StoredReconciliation>): Promise<ReconcileState> {
  const account = toAccount(await accountOf(c, accountId))
  const payees = new Map((await c.payees.find()).map(p => [p.id, p.name]))
  const categories = await listCategories(c)
  const names = new Map((await c.accounts.find()).map(a => [a.id, a.name]))
  const transactions = (await c.transactions.find({ accountId }, { sort: { date: 1 } }))
    .filter(t => !t.voided && t.status !== 'reconciled')

  const candidates: ReconcileCandidate[] = transactions.map(doc => {
    const transaction = toTransaction(doc)
    const label = doc.transferAccountId !== undefined
      ? transferLabel(doc.amount, names.get(doc.transferAccountId) ?? 'another account')
      : categoryLabel(categories, doc.categoryId)
    const payeeName = doc.payeeId === undefined ? undefined : payees.get(doc.payeeId)
    return {
      transaction, marked: MARKED.includes(doc.status), afterStatement: doc.date > session.statementDate,
      ...(payeeName !== undefined && { payeeName }),
      ...(label !== undefined && { categoryLabel: label })
    }
  })

  const marked = candidates.filter(c => c.marked).reduce((sum, c) => sum + c.transaction.amount, 0)
  const lastReconciledBalance = balancesFor(account, (await sumsByAccount(c)).get(accountId)).reconciled
  return {
    account,
    reconciliation: toReconciliation(session),
    candidates,
    summary: {
      starting: session.startingBalance,
      marked,
      markedCount: candidates.filter(c => c.marked).length,
      difference: session.statementBalance - (session.startingBalance + marked),
      lastReconciledBalance,
      adjustment: session.statementBalance - (lastReconciledBalance + marked)
    }
  }
}

const CHARGE_PAYEES: Readonly<Record<ChargeKind, string>> = { serviceCharge: 'Service charge', interest: 'Interest' }

/** A charge to add, or undefined when none was given (absent, or zero). */
function checkCharge(kind: ChargeKind, charge: StatementCharge | undefined): StatementCharge | undefined {
  if (charge === undefined || charge === null) return undefined
  if (typeof charge !== 'object') throw invalid(kind, 'Enter the amount.')
  if (!isAmount(charge.amount) || charge.amount < 0) throw invalid(kind, 'Enter the amount as the statement shows it, without a sign.')
  if (charge.amount === 0) return undefined
  if (!isIsoDate(charge.date)) throw invalid(kind, 'Enter the date.')
  if (charge.categoryId !== undefined && typeof charge.categoryId !== 'string') throw invalid(kind, 'Choose a category.')
  return { amount: charge.amount, date: charge.date, ...(charge.categoryId !== undefined && { categoryId: charge.categoryId }) }
}

/**
 * Starts a reconciliation, or updates and resumes the one in progress. The statement's service charge and interest
 * become transactions, marked as on the statement, which the reconciliation remembers so Cancel can delete them.
 */
export async function begin(c: Collections, accountId: string, input: StatementInput & { reconcilerId: string }, now: string): Promise<ReconcileState> {
  const account = await openAccount(c, accountId)
  const checked = checkFigures(input)
  const charges = ([['serviceCharge', input?.serviceCharge], ['interest', input?.interest]] as const)
    .map(([kind, charge]) => [kind, checkCharge(kind, charge)] as const)
  const reconcilerId = typeof input.reconcilerId === 'string' && input.reconcilerId !== '' ? input.reconcilerId : 'unknown'

  const added: string[] = []
  for (const [kind, charge] of charges) {
    if (!charge) continue
    try {
      const { transaction } = await createTransaction(c, accountId, {
        date: charge.date, amount: chargeAmount(kind, account.type, charge.amount), payee: CHARGE_PAYEES[kind], status: 'cleared',
        ...(charge.categoryId !== undefined && { categoryId: charge.categoryId })
      }, now)
      added.push(transaction.id)
    } catch (err) {
      // Named after the dialog's field, not the register's
      if (err instanceof AccountsError && err.field === 'category') throw new AccountsError(err.code, err.message, kind)
      throw err
    }
  }

  const existing = await inProgress(c, accountId)
  if (existing) {
    await c.reconciliations.updateOne({ id: existing.id }, {
      $set: { ...checked, reconcilerId, paused: false, addedIds: [...(existing.addedIds ?? []), ...added] }
    })
    return stateOf(c, accountId, (await inProgress(c, accountId))!)
  }
  const created = await c.reconciliations.insert({
    accountId, activeFor: accountId, reconcilerId, status: 'inProgress', paused: false, startedAt: now, original: {},
    addedIds: added, ...checked
  })
  return stateOf(c, accountId, created)
}

export async function mark(c: Collections, accountId: string, ids: string[], marked: boolean, now: string): Promise<ReconcileState> {
  await openAccount(c, accountId)
  const session = await required(c, accountId)
  const original = { ...session.original }
  for (const id of new Set(ids)) {
    const transaction = await c.transactions.get(id)
    if (!transaction || transaction.accountId !== accountId) throw new AccountsError('NOT_FOUND', 'That transaction no longer exists.')
    if (transaction.voided || transaction.status === 'reconciled') throw invalid('ids', 'Only transactions not yet reconciled, and not voided, can be marked.')
    if (MARKED.includes(transaction.status) === marked) continue
    if (!(id in original)) original[id] = transaction.status
    await c.transactions.updateOne({ id }, { $set: { status: marked ? 'cleared' : 'uncleared', updatedAt: now } })
  }
  await c.reconciliations.updateOne({ id: session.id }, { $set: { original } })
  return stateOf(c, accountId, (await inProgress(c, accountId))!)
}

export async function pause(c: Collections, accountId: string): Promise<void> {
  const session = await required(c, accountId)
  await c.reconciliations.updateOne({ id: session.id }, { $set: { paused: true } })
}

/** Puts back what the reconciliation changed, deletes what it added, and ends it. Returns the accounts it touched. */
export async function cancel(c: Collections, accountId: string, now: string): Promise<Touched> {
  const session = await required(c, accountId)
  const touched: Touched = new Set([accountId])
  const added = new Set(session.addedIds ?? [])
  for (const [id, status] of Object.entries(session.original)) {
    if (added.has(id)) continue
    const transaction = await c.transactions.get(id)
    // Left alone if it has since been reconciled, or deleted
    if (transaction && transaction.status !== 'reconciled') await c.transactions.updateOne({ id }, { $set: { status, updatedAt: now } })
  }
  for (const id of added) {
    const transaction = await c.transactions.get(id)
    // Left alone if it has since been deleted, reconciled, or moved to another account
    if (!transaction || transaction.status === 'reconciled' || transaction.accountId !== accountId) continue
    for (const other of await deleteTransactions(c, accountId, [id], { confirm: ['reconciled'] })) touched.add(other)
  }
  await c.reconciliations.deleteOne({ id: session.id })
  return touched
}

export async function finish(c: Collections, accountId: string, confirm: Confirmation[], now: string): Promise<ReconcileResult> {
  const account = await openAccount(c, accountId)
  const session = await required(c, accountId)
  const state = await stateOf(c, accountId, session)
  const { adjustment } = state.summary

  if (adjustment !== 0 && !confirm.includes('adjustBalance')) {
    throw new AccountsError('CONFIRMATION_REQUIRED',
      `Your records and the statement differ by ${formatAmount(adjustment, account.currency)}. ` +
      'You can go back and look for the difference, or add a balance adjustment for it and complete the reconciliation.',
      undefined, ['adjustBalance'])
  }

  const reconciledIds: string[] = []
  for (const candidate of state.candidates.filter(c => c.marked)) {
    await c.transactions.updateOne({ id: candidate.transaction.id }, { $set: { status: 'reconciled', updatedAt: now } })
    reconciledIds.push(candidate.transaction.id)
  }

  let adjustmentDoc: Doc<StoredTransaction> | undefined
  if (adjustment !== 0) {
    // As Money does: a reconciled transaction for the difference, on the statement date
    adjustmentDoc = await c.transactions.insert({
      accountId, date: session.statementDate, amount: adjustment, status: 'reconciled', voided: false,
      memo: 'Reconciliation adjustment', createdAt: now, updatedAt: now,
      payeeId: await payeeNamed(c, 'Balance adjustment')
    })
  }

  await c.accounts.updateOne({ id: accountId }, {
    $set: { lastReconciled: { date: session.statementDate, balance: session.statementBalance, reconciliationId: session.id } }
  })
  await c.reconciliations.updateOne({ id: session.id }, {
    $set: { status: 'finished', finishedAt: now, reconciledIds, ...(adjustmentDoc && { adjustmentId: adjustmentDoc.id }) },
    $unset: { activeFor: true }
  })
  return { reconciledCount: reconciledIds.length, ...(adjustmentDoc && { adjustment: toTransaction(adjustmentDoc) }) }
}
