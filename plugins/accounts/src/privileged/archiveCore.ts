// What archiving removes from the accounts, and what that does to each account's opening balance.
// See docs/archive-design.md, "What is removable" and "Moving the opening balance".
//
// This is worked out once, here, and used twice: by the participant's survey, to tell the user what will happen,
// and (phase 3) by its prune, to do it. The two must never disagree, which is why neither has rules of its own.
import type { Doc } from '@tessera/types'
import type { ArchiveRequest, ArchiveRow, ArchiveWarning } from '@tessera/book-api'
import { formatAmount, type Account } from '@tessera/accounts-api'
import { toAccount, type Collections, type StoredReconciliation, type StoredTransaction } from './store'

/** What happens to one account. Only accounts with something to remove get one. */
export interface AccountRemoval {
  account: Account
  /** The transactions going from this account, in register order. */
  removed: Doc<StoredTransaction>[]
  /** The signed sum of the removed transactions that counted towards a balance (voided ones never did). */
  delta: number
  /** What the account's opening balance becomes: the old one plus `delta`. */
  openingBalance: number
  /** What its opening date becomes. */
  openingDate: string
}

/** Transactions before the cut-off that are kept because the user hasn't reconciled them. */
export interface Unreconciled {
  account: Account
  count: number
  /** The oldest one's date, `YYYY-MM-DD`. */
  oldest: string
}

export interface ArchiveRemovalPlan {
  /** Accounts with something to remove, in the order accounts are listed. */
  accounts: AccountRemoval[]
  /** Every transaction id being removed. */
  transactionIds: string[]
  /** Finished reconciliations being removed: before the cut-off, and not an account's most recent. */
  reconciliationIds: string[]
  unreconciled: Unreconciled[]
  /** Why archiving can't go ahead: a reconciliation is in progress. */
  blocker?: string
}

/** `2026-01-01` → `1 Jan 2026` (locale-dependent), read as a local date so it is never a day out. */
export function humanDate(iso: string): string {
  const [year, month, day] = iso.split('-').map(Number)
  const date = new Date(year, (month ?? 1) - 1, day ?? 1)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString(undefined, { dateStyle: 'medium' })
}

const count = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`

/**
 * Whether a transaction is removable on its own account — before the cut-off, settled, and not held by a
 * reconciliation in progress. Transfers are decided in pairs afterwards, so this is not the last word on one.
 */
function isRemovable(transaction: Doc<StoredTransaction>, request: ArchiveRequest, held: ReadonlySet<string>): boolean {
  if (transaction.date >= request.before) return false
  if (held.has(transaction.id)) return false
  // A voided transaction is kept or removed on that footing alone, whatever status it carries
  if (transaction.voided) return request.removeVoided
  return request.removeReconciled && transaction.status === 'reconciled'
}

/**
 * The transactions a reconciliation in progress is holding: the ones whose status it changed, and the ones it
 * added. They are unfinished work and must survive, whatever their status says.
 */
function heldByReconciling(reconciliations: Doc<StoredReconciliation>[]): Set<string> {
  const held = new Set<string>()
  for (const reconciliation of reconciliations) {
    for (const id of Object.keys(reconciliation.original ?? {})) held.add(id)
    for (const id of reconciliation.addedIds ?? []) held.add(id)
  }
  return held
}

/**
 * Everything archiving would do to the accounts, for a cut-off. Reads the whole of the transactions collection
 * once and works in memory — which is where the database already is, and what a snapshot does anyway.
 */
export async function planAccountsArchive(c: Collections, request: ArchiveRequest): Promise<ArchiveRemovalPlan> {
  const accountDocs = await c.accounts.find({}, { sort: { order: 1 } })
  const accounts = new Map(accountDocs.map(doc => [doc.id, toAccount(doc)]))
  const transactions = await c.transactions.find({})
  const reconciliations = await c.reconciliations.find({})

  const inProgress = reconciliations.filter(r => r.status === 'inProgress')
  const held = heldByReconciling(inProgress)
  const blocker = inProgress.length === 0 ? undefined : blockerFor(inProgress, accounts)

  // 1. Each transaction on its own, then 2. transfers in pairs: both sides go, or neither does
  const removable = new Set(transactions.filter(t => isRemovable(t, request, held)).map(t => t.id))
  const byTransfer = new Map<string, Doc<StoredTransaction>[]>()
  for (const transaction of transactions) {
    if (transaction.transferId === undefined) continue
    const sides = byTransfer.get(transaction.transferId) ?? []
    sides.push(transaction)
    byTransfer.set(transaction.transferId, sides)
  }
  for (const sides of byTransfer.values()) {
    if (sides.every(side => removable.has(side.id))) continue
    for (const side of sides) removable.delete(side.id)
  }

  // 3. Group what is left by account, and work out what each account's opening row becomes
  const removals: AccountRemoval[] = []
  const unreconciled: Unreconciled[] = []
  for (const [id, account] of accounts) {
    const mine = transactions.filter(t => t.accountId === id)
    const removed = mine.filter(t => removable.has(t.id)).sort(byDate)
    const open = mine.filter(t => !removable.has(t.id) && t.date < request.before && !t.voided && t.status !== 'reconciled')
    if (open.length > 0) {
      unreconciled.push({ account, count: open.length, oldest: open.reduce((a, b) => a.date <= b.date ? a : b).date })
    }
    if (removed.length === 0) continue

    // Voided transactions were in no balance, so removing one changes nothing: they are not in the adjustment
    const delta = removed.reduce((sum, t) => sum + (t.voided ? 0 : t.amount), 0)
    const remaining = mine.filter(t => !removable.has(t.id))
    const earliest = remaining.length === 0 ? undefined : remaining.reduce((a, b) => a.date <= b.date ? a : b).date
    removals.push({
      account,
      removed,
      delta,
      openingBalance: account.openingBalance + delta,
      openingDate: newOpeningDate(account.openingDate, request.before, earliest)
    })
  }

  return {
    accounts: removals,
    transactionIds: removals.flatMap(removal => removal.removed.map(t => t.id)),
    reconciliationIds: staleReconciliations(reconciliations, accounts, request.before),
    unreconciled,
    ...(blocker !== undefined && { blocker })
  }
}

const byDate = (a: Doc<StoredTransaction>, b: Doc<StoredTransaction>) =>
  a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : 1

/**
 * The opening date after archiving: the cut-off, except that it never moves backwards (an account opened after
 * the cut-off keeps its own date) and never moves past a transaction that is still in the register (an
 * unreconciled one from before the cut-off keeps the opening row above it, where the register draws it).
 */
export function newOpeningDate(openingDate: string, before: string, earliestRemaining: string | undefined): string {
  const target = earliestRemaining !== undefined && earliestRemaining < before ? earliestRemaining : before
  return target < openingDate ? openingDate : target
}

/**
 * Finished reconciliations dated before the cut-off, except the most recent of each account — the one
 * `lastReconciled` points at, which has to keep resolving. One in progress is never touched.
 */
function staleReconciliations(
  reconciliations: Doc<StoredReconciliation>[],
  accounts: Map<string, Account>,
  before: string
): string[] {
  const keep = new Set<string>()
  for (const account of accounts.values()) {
    if (account.lastReconciled) keep.add(account.lastReconciled.reconciliationId)
  }
  // A book whose account somehow lost its `lastReconciled` still keeps that account's newest reconciliation
  for (const account of accounts.values()) {
    if (account.lastReconciled) continue
    const mine = reconciliations.filter(r => r.accountId === account.id && r.status === 'finished')
    const newest = mine.sort((a, b) => a.statementDate < b.statementDate ? -1 : 1).pop()
    if (newest) keep.add(newest.id)
  }
  return reconciliations
    .filter(r => r.status === 'finished' && r.statementDate < before && !keep.has(r.id))
    .map(r => r.id)
}

function blockerFor(inProgress: Doc<StoredReconciliation>[], accounts: Map<string, Account>): string {
  const names = inProgress.map(r => `“${accounts.get(r.accountId)?.name ?? 'an account'}”`)
  const which = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
  return `A reconciliation of ${which} is in progress. Finish or cancel it before archiving.`
}

// ---- What the user is shown

export function describeRemoval(plan: ArchiveRemovalPlan): string {
  const transactions = plan.transactionIds.length
  const where = `${count(transactions, 'transaction')} in ${count(plan.accounts.length, 'account')}`
  return plan.reconciliationIds.length === 0 ? where : `${where}, and ${count(plan.reconciliationIds.length, 'reconciliation')}`
}

/** One row per account that loses something: how many go, and the opening row it is left with. */
export function removalRows(plan: ArchiveRemovalPlan): ArchiveRow[] {
  return plan.accounts.map(({ account, removed, openingBalance, openingDate }) => ({
    id: account.id,
    label: account.name,
    removed: removed.length,
    detail: `Opening balance ${formatAmount(openingBalance, account.currency)} as of ${humanDate(openingDate)}`
  }))
}

/** One warning per account whose unreconciled transactions before the cut-off are being left behind. */
export function removalWarnings(plan: ArchiveRemovalPlan, before: string): ArchiveWarning[] {
  return plan.unreconciled.map(({ account, count: n, oldest }) => ({
    kind: 'unreconciled' as const,
    message: `${account.name}: ${count(n, 'transaction')} before ${humanDate(before)} ${n === 1 ? 'is' : 'are'} not reconciled (oldest ${humanDate(oldest)}). ${n === 1 ? 'It stays' : 'They stay'} in the book.`
  }))
}

/** The documents the accounts participant would remove: its transactions and its stale reconciliations. */
export const removalCount = (plan: ArchiveRemovalPlan) => plan.transactionIds.length + plan.reconciliationIds.length

// ---- The invariant

/**
 * Why an account's balances after the prune are not what they were before it, or undefined when they are. The
 * whole point of the adjustment is that every balance is identical and only the count falls — anything else is a
 * bug, and the caller rolls the prune back rather than committing it.
 */
export function balanceProblem(
  name: string,
  before: import('@tessera/accounts-api').AccountBalances,
  after: import('@tessera/accounts-api').AccountBalances,
  removed: number
): string | undefined {
  for (const key of ['current', 'available', 'cleared', 'reconciled'] as const) {
    if (before[key] !== after[key]) {
      return `“${name}” would not have balanced: its ${key} balance would have changed by ${(after[key] - before[key]).toLocaleString()} minor units.`
    }
  }
  if (after.transactionCount !== before.transactionCount - removed) {
    return `“${name}” would not have balanced: ${removed.toLocaleString()} transactions were removed but its count fell by ${(before.transactionCount - after.transactionCount).toLocaleString()}.`
  }
  return undefined
}
