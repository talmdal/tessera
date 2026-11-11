// Archiving, for the accounts plugin: which transactions are no longer required, carrying their total into each
// account's opening balance, removing closed accounts left with nothing, and checking that no balance changed.
// The ledger runs `applyArchive` inside its archive transaction (see ArchiveParticipant in @tessera/ledger-api).
// See docs/ledger-compaction-design.md, "Which transactions are no longer required" and "Carrying the balance forward".
import type { Doc } from '@tessera/types'
import { displayDate, type ArchiveDescription, type ArchiveResult } from '@tessera/ledger-api'
import { ACCOUNTS_ARCHIVE_OPTIONS, type AccountArchived, type AccountsArchived, type AccountsChange } from '@tessera/accounts-api'
import type { Collections, StoredAccount, StoredReconciliation, StoredTransaction } from './store'
import { balancesFor, sumTransactions } from './transactionsCore'

/** The removal lets the event loop turn every so many writes, so the window stays responsive (Phase 0 results). */
export const ARCHIVE_YIELD_EVERY = 2000

type Account = Doc<StoredAccount>
type Txn = Doc<StoredTransaction>
type Reconciliation = Doc<StoredReconciliation>

export interface LedgerData {
  accounts: readonly Account[]
  transactions: readonly Txn[]
  reconciliations: readonly Reconciliation[]
}

export interface AccountArchivePlan {
  /** Transactions removed from the account. */
  removed: number
  /** Their amounts, voids excluded: what the opening balance takes on. */
  carried: number
  /** The highest numeric transaction number among them. */
  highestNumber?: number
}

/** Why a closed account that the archive would leave empty stays. */
export type ClosedKeptReason = 'balance' | 'reconciling'

export interface ArchivePlan {
  before: string
  /** The transactions to remove. */
  remove: string[]
  /** Each account with transactions to remove. */
  accounts: Map<string, AccountArchivePlan>
  /** Each account's transactions before the date that stay because they aren't reconciled (voids aren't counted). */
  unreconciled: Map<string, number>
  /** Reconciled or void transactions before the date that stay because the other side of their transfer doesn't qualify. */
  keptTransfers: number
  /** Closed accounts the archive leaves empty, with a zero balance and no reconciliation under way. */
  closedEmpty: string[]
  /** Those removed: all of `closedEmpty` when the option is on, else none. */
  removeAccounts: string[]
  /** Closed accounts the archive would leave empty but that stay, and why. */
  closedKept: { id: string, reason: ClosedKeptReason }[]
  /** Finished reconciliations before the date (except each account's last), and every one of a removed account. */
  removeReconciliations: string[]
}

const NUMBER = /^\d{1,15}$/

/**
 * What an archive before `before` removes. Pure. A transaction goes when it is dated before `before`, is reconciled
 * or void, and, for one side of a transfer, the other side does too. A closed account goes (with the option on) when
 * the archive removes every transaction it has, its balance is zero, and no reconciliation of it is under way.
 */
export function planArchive(data: LedgerData, before: string, options: { removeClosedAccounts: boolean }): ArchivePlan {
  const known = new Set(data.accounts.map(a => a.id))
  const qualifies = (t: Txn) => t.date < before && (t.voided || t.status === 'reconciled')
  const sides = new Map<string, Txn[]>()
  for (const t of data.transactions) if (t.transferId !== undefined) (sides.get(t.transferId) ?? sides.set(t.transferId, []).get(t.transferId)!).push(t)

  const plan: ArchivePlan = {
    before, remove: [], accounts: new Map(), unreconciled: new Map(), keptTransfers: 0,
    closedEmpty: [], removeAccounts: [], closedKept: [], removeReconciliations: []
  }
  const total = new Map<string, number>()
  for (const t of data.transactions) {
    // A transaction of an account that no longer exists is never shown, and has no balance to carry into
    if (!known.has(t.accountId)) continue
    total.set(t.accountId, (total.get(t.accountId) ?? 0) + 1)
    if (!qualifies(t)) {
      if (t.date < before && !t.voided) plan.unreconciled.set(t.accountId, (plan.unreconciled.get(t.accountId) ?? 0) + 1)
      continue
    }
    if (t.transferId !== undefined) {
      const other = sides.get(t.transferId)!.find(o => o.id !== t.id)
      if (other && !qualifies(other)) { plan.keptTransfers++; continue }
    }
    plan.remove.push(t.id)
    const account = plan.accounts.get(t.accountId) ?? { removed: 0, carried: 0 }
    account.removed++
    if (!t.voided) account.carried += t.amount
    if (t.number !== undefined && NUMBER.test(t.number)) account.highestNumber = Math.max(account.highestNumber ?? 0, Number(t.number))
    plan.accounts.set(t.accountId, account)
  }

  const reconciling = new Set(data.reconciliations.filter(r => r.activeFor !== undefined).map(r => r.accountId))
  for (const a of data.accounts) {
    if (!a.closed) continue
    const removed = plan.accounts.get(a.id)
    if ((removed?.removed ?? 0) < (total.get(a.id) ?? 0)) continue     // something stays in it
    if (a.openingBalance + (removed?.carried ?? 0) !== 0) plan.closedKept.push({ id: a.id, reason: 'balance' })
    else if (reconciling.has(a.id)) plan.closedKept.push({ id: a.id, reason: 'reconciling' })
    else plan.closedEmpty.push(a.id)
  }
  if (options.removeClosedAccounts) plan.removeAccounts = [...plan.closedEmpty]

  const gone = new Set(plan.removeAccounts)
  const last = new Set(data.accounts.map(a => a.lastReconciled?.reconciliationId).filter((id): id is string => id !== undefined))
  for (const r of data.reconciliations) {
    const finishedBefore = r.status === 'finished' && r.statementDate < before && !last.has(r.id)
    if (gone.has(r.accountId) || finishedBefore) plan.removeReconciliations.push(r.id)
  }
  return plan
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`
const quoted = (name: string) => `“${name}”`

/** What the plan removes and keeps, for the Archive dialog and the ledger's record. */
export function describePlan(plan: ArchivePlan, accounts: readonly Pick<Account, 'id' | 'name' | 'order'>[]): ArchiveDescription {
  const name = (id: string) => accounts.find(a => a.id === id)?.name ?? 'an account'
  const transactions = plan.remove.length
  const closed = plan.removeAccounts.length
  const parts = [
    ...(transactions > 0 ? [`${plural(transactions, 'transaction')} from ${plural(plan.accounts.size, 'account')}`] : []),
    ...(closed > 0 ? [`${plural(closed, 'closed account')} with nothing left`] : [])
  ]
  const description: ArchiveDescription = {
    count: transactions + closed,
    summary: parts.length === 0 ? `Nothing to archive before ${displayDate(plan.before)}` : parts.join(', and ')
  }

  const notes = plan.closedKept.map(({ id, reason }) => reason === 'balance'
    ? `${quoted(name(id))} is closed, but stays: its balance isn’t zero.`
    : `${quoted(name(id))} is closed, but stays: a reconciliation of it is under way.`)
  if (notes.length > 0) description.notes = notes

  const unreconciled = [...plan.unreconciled.values()].reduce((sum, n) => sum + n, 0)
  if (unreconciled > 0 || plan.keptTransfers > 0) {
    const byAccount = [...plan.unreconciled]
      .sort(([a, x], [b, y]) => y - x || name(a).localeCompare(name(b)))
      .map(([id, n]) => `${name(id)} ${n.toLocaleString('en-US')}`)
    const details = byAccount.length > 0 ? [byAccount.join(' · ')] : []
    if (plan.keptTransfers > 0) {
      details.push(`${plural(plan.keptTransfers, 'reconciled transfer')} ${plan.keptTransfers === 1 ? 'stays' : 'stay'} with them, until the other side is reconciled.`)
    }
    details.push('To archive them too, cancel, reconcile those accounts, and archive again.')
    description.warnings = [{
      message: `${plural(unreconciled, 'transaction')} before ${displayDate(plan.before)} ${unreconciled === 1 ? 'isn’t reconciled, so it stays' : 'aren’t reconciled, so they stay'} in the ledger.`,
      details
    }]
  }

  if (plan.closedEmpty.length > 0) {
    description.options = [{
      id: ACCOUNTS_ARCHIVE_OPTIONS.removeClosedAccounts,
      label: `Remove closed accounts with nothing left: ${plan.closedEmpty.map(id => quoted(name(id))).join(', ')}`,
      default: true
    }]
  }
  return description
}

/** Whether closed accounts with nothing left are removed: the option, on unless the user turned it off. */
export const removesClosedAccounts = (options: Readonly<Record<string, boolean>>) =>
  options[ACCOUNTS_ARCHIVE_OPTIONS.removeClosedAccounts] ?? true

export async function readLedger(c: Collections): Promise<LedgerData> {
  const [accounts, transactions, reconciliations] = await Promise.all([c.accounts.find(), c.transactions.find(), c.reconciliations.find()])
  return { accounts, transactions, reconciliations }
}

/** Why a check failed: a bug, never something the user did. The ledger reports it and rolls everything back. */
export class ArchiveCheckError extends Error {
  override readonly name = 'ArchiveCheckError'
}

/**
 * Checks an archive before it is committed, from the documents before and after, independently of how the removal
 * was done: every account that stays has the same four balances and opening date; every account that went was
 * planned to go and had a zero balance; every currency's total is the same; a transfer lost both sides or neither;
 * and nothing removed was unreconciled, or dated on or after the archive date. Throws `ArchiveCheckError`.
 */
export function verifyArchive(before: Pick<LedgerData, 'accounts' | 'transactions'>, after: Pick<LedgerData, 'accounts' | 'transactions'>, plan: ArchivePlan) {
  const fail = (message: string) => { throw new ArchiveCheckError(`The archive was stopped: ${message}`) }
  const sums0 = sumTransactions(before.transactions), sums1 = sumTransactions(after.transactions)
  const accounts0 = new Map(before.accounts.map(a => [a.id, a]))
  const accounts1 = new Map(after.accounts.map(a => [a.id, a]))
  const totals = new Map<string, number>()
  const add = (currency: string, amount: number) => totals.set(currency, (totals.get(currency) ?? 0) + amount)

  for (const a0 of before.accounts) {
    const b0 = balancesFor(a0, sums0.get(a0.id))
    add(a0.currency, b0.current)
    const a1 = accounts1.get(a0.id)
    if (!a1) {
      if (!plan.removeAccounts.includes(a0.id)) fail(`“${a0.name}” would have gone.`)
      if (b0.current !== 0 || b0.cleared !== 0 || b0.reconciled !== 0) fail(`“${a0.name}” would have gone with a balance.`)
      continue
    }
    const b1 = balancesFor(a1, sums1.get(a1.id))
    if (b0.current !== b1.current || b0.cleared !== b1.cleared || b0.reconciled !== b1.reconciled || b0.available !== b1.available) {
      fail(`the balances of “${a0.name}” would have changed.`)
    }
    if (a1.openingDate !== a0.openingDate) fail(`the opening date of “${a0.name}” would have changed.`)
  }
  for (const a1 of after.accounts) {
    if (!accounts0.has(a1.id)) fail(`“${a1.name}” would have appeared.`)
    add(a1.currency, -balancesFor(a1, sums1.get(a1.id)).current)
  }
  for (const [currency, difference] of totals) if (difference !== 0) fail(`the total in ${currency} would have changed.`)

  const stays = new Set(after.transactions.map(t => t.id))
  const sides = new Map<string, boolean[]>()
  for (const t of before.transactions) {
    const kept = stays.has(t.id)
    if (!kept && t.date >= plan.before) fail(`a transaction of ${displayDate(t.date)}, on or after the archive date, would have gone.`)
    if (!kept && !(t.voided || t.status === 'reconciled')) fail(`a transaction of ${displayDate(t.date)} that isn’t reconciled would have gone.`)
    if (t.transferId !== undefined) sides.set(t.transferId, [...(sides.get(t.transferId) ?? []), kept])
  }
  for (const kept of sides.values()) if (kept.some(k => k) && kept.some(k => !k)) fail('a transfer would have lost one of its sides.')
}

export interface ArchiveApplied {
  result: ArchiveResult
  change: Partial<AccountsChange>
}

/**
 * Archives the accounts' data before `before`, through a transaction's collections: removes the planned transactions
 * and reconciliations by id (never with `$in`, which the storage kit runs in quadratic time), carries each account's
 * removed total into its opening balance with its last archival date, removes closed accounts left empty, then
 * checks the result (`verifyArchive`). Lets the event loop turn every `ARCHIVE_YIELD_EVERY` writes and between steps.
 */
export async function applyArchive(
  c: Collections, before: string, options: Readonly<Record<string, boolean>>, turn: () => Promise<void>
): Promise<ArchiveApplied> {
  const data = await readLedger(c)
  await turn()
  const plan = planArchive(data, before, { removeClosedAccounts: removesClosedAccounts(options) })
  await turn()

  let writes = 0
  const wrote = async () => { if (++writes % ARCHIVE_YIELD_EVERY === 0) await turn() }
  for (const id of plan.remove) { await c.transactions.deleteOne({ id }); await wrote() }
  for (const id of plan.removeReconciliations) { await c.reconciliations.deleteOne({ id }); await wrote() }

  const gone = new Set(plan.removeAccounts)
  const byId = new Map(data.accounts.map(a => [a.id, a]))
  const kept: AccountsArchived['accounts'] = []
  for (const [id, removed] of plan.accounts) {
    if (gone.has(id)) continue
    const account = byId.get(id)!
    const previous = account.archived
    const highestNumber = Math.max(previous?.highestNumber ?? -1, removed.highestNumber ?? -1)
    const archived = {
      count: (previous?.count ?? 0) + removed.removed,
      originalOpeningBalance: previous?.originalOpeningBalance ?? account.openingBalance,
      ...(highestNumber >= 0 && { highestNumber })
    } satisfies AccountArchived
    const lastArchiveDate = account.lastArchiveDate !== undefined && account.lastArchiveDate > before ? account.lastArchiveDate : before
    await c.accounts.updateOne({ id }, { $set: { openingBalance: account.openingBalance + removed.carried, lastArchiveDate, archived } })
    kept.push({ id, lastArchiveDate })
    await wrote()
  }
  for (const id of plan.removeAccounts) await c.accounts.deleteOne({ id })
  await turn()

  verifyArchive(data, { accounts: await c.accounts.find(), transactions: await c.transactions.find() }, plan)

  const touched = kept.map(k => k.id)
  const removedReconciliations = new Set(plan.removeReconciliations)
  const reconciled = new Set(data.reconciliations.filter(r => removedReconciliations.has(r.id)).map(r => r.accountId))
  const shared: AccountsArchived = { transactionIds: plan.remove, accounts: kept, removedAccountIds: plan.removeAccounts }
  const { count, summary } = describePlan(plan, data.accounts)
  return {
    result: { count, summary, shared },
    change: {
      updated: touched, transactions: [...touched, ...plan.removeAccounts], balances: touched,
      deleted: plan.removeAccounts, reconciliations: [...reconciled], chart: true
    }
  }
}
