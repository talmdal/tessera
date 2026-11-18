// What the book already holds, against what a file brings: the four tiers of matching, and the transfer pairing
// that runs after them. Pure functions over plain data — no storage, no clock, no service — because this is the
// piece most worth testing and most likely to be tuned.
//
// The tiers, in the order they win:
//   1. the source's own id (`externalId`): decisive, and backed by a unique index in the accounts schema;
//   2. a near match on date and amount, for the formats that carry no id;
//   3. the merge: that near match, when it lands on a transaction the user typed by hand, updates it instead of
//      entering a second copy;
//   4. the user, through the review's Change… button — applied by the planner, not here, but this module knows
//      not to recompute a row the user has settled.
import { MIN_PAYEE_PREFIX, type Disposition, type ExchangeTransaction, type MatchCandidate, type MatchedBy } from '@tessera/exchange-api'
import type { Transaction } from '@tessera/accounts-api'

export interface MatchOptions {
  /** Days either side for a near match. 0 means same-day only. */
  dateWindow: number
  /** Merge a near match into a transaction the user typed; otherwise such a row is entered as new. */
  mergeManualEntries: boolean
  /**
   * The source supplies a stable id for every row. Its rows are still offered to the heuristic when their id is
   * unknown to the book, because that is how a cheque typed by hand and reported later is found.
   */
  transactionIds: boolean
  /**
   * Payees this long may have been truncated by the source, so they match a longer name by prefix. Standard QIF
   * truncates to 15; a format that does not truncate leaves this undefined.
   */
  truncatedAt?: number
}

/** What the matcher concluded about one row, before the user has touched it. */
export interface Proposal {
  disposition: Disposition
  existingId?: string
  matchedBy: MatchedBy
  reason: string
}

/** A row paired with its proposal, plus anything worth telling the user about the file itself. */
export interface MatchOutcome {
  proposals: Proposal[]
  /** Rows of the file that repeat a reference already used earlier in the same file. */
  duplicateIdWarnings: { index: number, externalId: string }[]
}

// ---- Dates ------------------------------------------------------------------------------------

const DAY_MS = 86_400_000

/** Whole days between two YYYY-MM-DD dates, ignoring time zones entirely: both are calendar dates. */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY_MS)
}

/** `date` shifted by `days`, as YYYY-MM-DD. */
export function shiftDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10)
}

// ---- Payees -----------------------------------------------------------------------------------

/** A payee reduced to what identifies it: letters, digits and single spaces, lower case. */
export function payeeKey(name: string | undefined): string {
  return (name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

/**
 * Whether two payees could be the same. Equal after normalising, or one a prefix of the other — which is the
 * truncated-QIF case, and the reason `truncatedAt` exists: without it, `Canadian Tire S` from the file would
 * create a second payee beside `Canadian Tire Store` in the book.
 *
 * An empty payee on either side is compatible with anything: plenty of rows have none, and refusing to match
 * them would duplicate every bank fee in the register.
 */
export function payeesCompatible(a: string | undefined, b: string | undefined, truncatedAt?: number): 'exact' | 'prefix' | 'empty' | false {
  const left = payeeKey(a)
  const right = payeeKey(b)
  if (left === '' || right === '') return 'empty'
  if (left === right) return 'exact'

  const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left]
  if (shorter.length < MIN_PAYEE_PREFIX || !longer.startsWith(shorter)) return false
  // Only a source that truncates may match short-to-long; otherwise "Hydro" would absorb "Hydro Ottawa"
  const sourceLength = (a ?? '').trim().length
  if (truncatedAt !== undefined && sourceLength >= truncatedAt) return 'prefix'
  return false
}

// ---- Scoring ----------------------------------------------------------------------------------

/**
 * How well an existing transaction matches an incoming row, and why, or undefined when it cannot be the same
 * transaction at all.
 *
 * Amounts must be **exactly** equal. Never approximate: two coffees at $4.50 on the same day are two
 * transactions, and “nearly equal amounts” merges them into one the user cannot easily find again.
 */
export function scoreCandidate(
  incoming: Pick<ExchangeTransaction, 'date' | 'amount' | 'payee' | 'number'>,
  existing: Pick<Transaction, 'date' | 'amount' | 'number'> & { payeeName?: string, transferAccountId?: string },
  options: Pick<MatchOptions, 'dateWindow' | 'truncatedAt'>
): { score: number, reason: string } | undefined {
  if (existing.amount !== incoming.amount) return undefined

  const drift = Math.abs(daysBetween(incoming.date, existing.date))
  if (drift > Math.max(0, options.dateWindow)) return undefined

  // One side of a transfer carries whatever payee the other side was given — "To savings" against the bank's
  // "From chequing" — so a transfer's payee says nothing about whether this is the same money
  const payees = existing.transferAccountId !== undefined
    ? 'empty' as const
    : payeesCompatible(incoming.payee, existing.payeeName, options.truncatedAt)
  if (payees === false) return undefined

  const sameNumber = incoming.number !== undefined && incoming.number !== '' && incoming.number === existing.number
  // Date agreement dominates, then the payee, then the cheque number: an exact date and payee is as good as it gets
  const dateScore = drift === 0 ? 0.5 : 0.5 * (1 - drift / (Math.max(1, options.dateWindow) + 1))
  const payeeScore = payees === 'exact' ? 0.35 : payees === 'prefix' ? 0.25 : 0.1
  const numberScore = sameNumber ? 0.15 : 0

  return { score: dateScore + payeeScore + numberScore, reason: describe(drift, payees, sameNumber) }
}

function describe(drift: number, payees: 'exact' | 'prefix' | 'empty', sameNumber: boolean): string {
  const when = drift === 0 ? 'the same day' : `${drift} day${drift === 1 ? '' : 's'} apart`
  if (sameNumber) return `Same amount and number, ${when}`
  if (payees === 'exact') return `Same amount and payee, ${when}`
  if (payees === 'prefix') return `Same amount, and the payee matches as far as the file records it, ${when}`
  return `Same amount, ${when}`
}

// ---- The matcher ------------------------------------------------------------------------------

/** An existing transaction with its payee's name resolved, which is what matching compares against. */
export interface ExistingRow extends Transaction {
  payeeName?: string
}

/**
 * Matches a statement's rows against one account's transactions. Rows are taken in date order, each claiming the
 * best candidate no earlier row has taken, so the result never depends on hash order.
 */
export function matchStatement(incoming: ExchangeTransaction[], existing: ExistingRow[], options: MatchOptions): MatchOutcome {
  const proposals: Proposal[] = new Array(incoming.length)
  const duplicateIdWarnings: { index: number, externalId: string }[] = []

  const byExternalId = new Map<string, ExistingRow>()
  for (const row of existing) if (row.externalId !== undefined) byExternalId.set(row.externalId, row)

  // Tier 1, and the corrections that come with it. Decisive, so these rows never reach the heuristic.
  const undecided: number[] = []
  const seenInFile = new Set<string>()
  for (const [index, row] of incoming.entries()) {
    const corrected = row.corrects === undefined ? undefined : byExternalId.get(row.corrects.externalId)
    if (row.corrects !== undefined && corrected !== undefined) {
      proposals[index] = {
        disposition: 'conflict',
        existingId: corrected.id,
        matchedBy: 'externalId',
        reason: row.corrects.action === 'delete'
          ? 'The source says this transaction was withdrawn; accepting voids it'
          : 'The source has restated this transaction'
      }
      continue
    }

    if (options.transactionIds && row.externalId !== undefined) {
      if (seenInFile.has(row.externalId)) {
        // The file's fault, not the user's. Kept out of the import rather than letting the index refuse it later
        duplicateIdWarnings.push({ index, externalId: row.externalId })
        proposals[index] = {
          disposition: 'duplicate',
          matchedBy: 'externalId',
          reason: 'This line repeats a reference used earlier in the same file'
        }
        continue
      }
      seenInFile.add(row.externalId)

      const match = byExternalId.get(row.externalId)
      if (match !== undefined) {
        const same = match.amount === row.amount && match.date === row.date
        proposals[index] = {
          disposition: same ? 'duplicate' : 'conflict',
          existingId: match.id,
          matchedBy: 'externalId',
          reason: same ? 'Same reference: already imported' : 'Same reference, but the amount or date has changed'
        }
        continue
      }
    }
    undecided.push(index)
  }

  // Tiers 2 and 3. Only transactions no bank has reported yet are offered. One carrying an `externalId` belongs
  // to tier 1, and merging a second reference onto it would lose the first. One that is `electronic` has
  // already been reported — it is a row an earlier import wrote or merged into, which for a file with no row
  // ids (CSV, QIF) carries no `externalId` — so a second identical bank row is a second purchase, not this one.
  // Offering it merged the two and lost a transaction.
  const available = existing.filter(row => row.externalId === undefined && row.status !== 'electronic')
  const claimed = new Set<string>()
  const inDateOrder = [...undecided].sort((a, b) =>
    incoming[a].date.localeCompare(incoming[b].date) || a - b)

  for (const index of inDateOrder) {
    const row = incoming[index]
    const best = bestCandidate(row, available, claimed, options)

    if (best === undefined) {
      proposals[index] = { disposition: 'new', matchedBy: 'none', reason: 'Not in this account yet' }
      continue
    }
    if (best.ambiguous) {
      // Guessing between two identical rows is worse than entering one the user can see and remove
      proposals[index] = {
        disposition: 'new',
        matchedBy: 'none',
        reason: 'Two transactions here look equally like this one, so it is offered as new'
      }
      continue
    }
    if (best.row.status === 'reconciled') {
      claimed.add(best.row.id)
      proposals[index] = {
        disposition: 'conflict',
        existingId: best.row.id,
        matchedBy: 'heuristic',
        reason: `${best.reason}, but that transaction is reconciled`
      }
      continue
    }
    if (!options.mergeManualEntries) {
      proposals[index] = { disposition: 'new', matchedBy: 'none', reason: 'Not in this account yet' }
      continue
    }
    claimed.add(best.row.id)
    proposals[index] = {
      disposition: 'merge',
      existingId: best.row.id,
      matchedBy: 'heuristic',
      reason: best.reason
    }
  }

  return { proposals, duplicateIdWarnings }
}

interface Best {
  row: ExistingRow
  reason: string
  /** Two candidates scored the same: the matcher declines to choose. */
  ambiguous: boolean
}

function bestCandidate(row: ExchangeTransaction, available: ExistingRow[], claimed: Set<string>, options: MatchOptions): Best | undefined {
  let best: { row: ExistingRow, score: number, reason: string } | undefined
  let tied = false

  for (const candidate of available) {
    if (claimed.has(candidate.id) || candidate.voided) continue
    const scored = scoreCandidate(row, candidate, options)
    if (scored === undefined) continue
    if (best === undefined || scored.score > best.score) {
      best = { row: candidate, ...scored }
      tied = false
    } else if (scored.score === best.score) {
      tied = true
    }
  }
  return best === undefined ? undefined : { row: best.row, reason: best.reason, ambiguous: tied }
}

// ---- Candidates for the Change… dialog --------------------------------------------------------

/**
 * The transactions the user may match a row to by hand, best first. Unlike the matcher, this does not insist on
 * an equal amount or a compatible payee: someone reaching for this dialog is looking for something the matcher
 * already failed to find, and a transposed figure is exactly the case it exists for.
 */
export function rankCandidates(
  row: ExchangeTransaction,
  existing: ExistingRow[],
  options: { dateWindow: number, truncatedAt?: number, currentId?: string }
): MatchCandidate[] {
  const ranked = existing.map(candidate => {
    const exact = scoreCandidate(row, candidate, { dateWindow: options.dateWindow, truncatedAt: options.truncatedAt })
    const drift = Math.abs(daysBetween(row.date, candidate.date))
    const sameAmount = candidate.amount === row.amount
    const sameNumber = row.number !== undefined && row.number !== '' && row.number === candidate.number

    // Outside the matcher's reach, so scored loosely: something is better than an unordered list
    const score = exact?.score ?? (
      (sameAmount ? 0.4 : 0) +
      (sameNumber ? 0.3 : 0) +
      Math.max(0, 0.25 - drift * 0.01) +
      (payeesCompatible(row.payee, candidate.payeeName, options.truncatedAt) ? 0.05 : 0)
    )
    const reason = exact?.reason ?? looseReason(sameAmount, sameNumber, drift)
    const caution = candidate.status === 'reconciled'
      ? 'reconciled' as const
      : sameAmount ? undefined : 'amountDiffers' as const

    const { payeeName, ...transaction } = candidate
    return {
      transaction: transaction as Transaction,
      ...(payeeName !== undefined && { payee: payeeName }),
      score,
      reason,
      ...(candidate.id === options.currentId && { current: true }),
      ...(caution !== undefined && { caution })
    }
  })

  return ranked.sort((a, b) =>
    (a.current === true ? -1 : 0) - (b.current === true ? -1 : 0) ||
    b.score - a.score ||
    a.transaction.date.localeCompare(b.transaction.date) ||
    a.transaction.id.localeCompare(b.transaction.id))
}

function looseReason(sameAmount: boolean, sameNumber: boolean, drift: number): string {
  const when = drift === 0 ? 'the same day' : `${drift} day${drift === 1 ? '' : 's'} apart`
  if (sameNumber) return `Same number, ${when}`
  if (sameAmount) return `Same amount, ${when}`
  return `${when[0].toUpperCase()}${when.slice(1)}`
}

// ---- Transfers --------------------------------------------------------------------------------

/** One row of the whole import, as transfer pairing sees it: which account it will land in, and its figures. */
export interface PairableRow {
  key: string
  accountId: string
  date: string
  amount: number
  /** The account the file named for this row's other side, already resolved to an id. */
  transferAccountId?: string
  payeeAccountId?: string
}

/**
 * Pairs the two sides of a transfer across the whole import, so that a statement from each account does not
 * produce two one-sided transactions where the user wants one pair.
 *
 * Only confident pairs are made. Anything ambiguous is left as two ordinary transactions, because a wrong
 * transfer is much harder for a user to unpick than a missing one.
 */
export function pairTransfers(rows: PairableRow[], dateWindow: number): Map<string, string> {
  const pairs = new Map<string, string>()
  const taken = new Set<string>()

  // Rows naming their other account go first: the file told us, so those pairs are certain
  const ordered = [...rows].sort((a, b) =>
    (a.transferAccountId === undefined ? 1 : 0) - (b.transferAccountId === undefined ? 1 : 0) ||
    a.date.localeCompare(b.date) || a.key.localeCompare(b.key))

  for (const row of ordered) {
    if (taken.has(row.key)) continue
    const wanted = row.transferAccountId ?? row.payeeAccountId
    if (wanted === undefined || wanted === row.accountId) continue

    const matches = rows.filter(other =>
      !taken.has(other.key) &&
      other.key !== row.key &&
      other.accountId === wanted &&
      other.amount === -row.amount &&
      Math.abs(daysBetween(other.date, row.date)) <= dateWindow &&
      (other.transferAccountId ?? other.payeeAccountId ?? row.accountId) === row.accountId)

    if (matches.length !== 1) continue
    taken.add(row.key)
    taken.add(matches[0].key)
    pairs.set(row.key, matches[0].key)
    pairs.set(matches[0].key, row.key)
  }
  return pairs
}

/** Of a paired row, the one that is written (the other is skipped: `accounts.service` writes both sides). */
export function writesTheTransfer(row: { key: string }, otherKey: string): boolean {
  return row.key < otherKey
}
