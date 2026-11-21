// A filed statement against a live register: which rows are already there, what each remaining row is matched
// to, and how they appear as the register's provisional rows. Pure functions over plain data — the matcher runs
// fresh against the register every time it is asked, because the register moves between imports; only the
// user's own decisions (`PendingRow.userMatch`, `PendingRow.userPayee`) persist.
import type { OverlayRow } from '@tessera/accounts-api'
import {
  DISPOSITION_LABELS, EXCHANGE_COMMANDS,
  type Disposition, type ExchangeTransaction, type MatchedBy, type PendingRow, type PendingStatement
} from '@tessera/exchange-api'
import { matchStatement, type ExistingRow, type MatchOptions } from './matcher'
import { payeeOf, type RuleOutcome } from './rules'

/** An overlay row's key: which statement, and which row of it. `:` cannot appear in either id. */
export const overlayKey = (statementId: string, rowKey: string) => `${statementId}:${rowKey}`

export function parseOverlayKey(key: unknown): { statementId: string, rowKey: string } | undefined {
  if (typeof key !== 'string') return undefined
  const at = key.indexOf(':')
  if (at <= 0 || at === key.length - 1) return undefined
  return { statementId: key.slice(0, at), rowKey: key.slice(at + 1) }
}

/**
 * Splits a statement's transactions into the rows worth filing and the ones already in the book: a row whose
 * bank reference the account already holds, or that an earlier statement already filed, is a duplicate and is
 * dropped at the door, exactly as Money did. Rows with no reference are always filed; the matcher sorts them
 * out against the register when they are read.
 */
export function dedupeRows(
  transactions: readonly ExchangeTransaction[],
  knownExternalIds: ReadonlySet<string>
): { kept: ExchangeTransaction[], duplicates: number } {
  const kept: ExchangeTransaction[] = []
  let duplicates = 0
  const seen = new Set<string>()
  for (const row of transactions) {
    const id = row.externalId
    if (id !== undefined && (knownExternalIds.has(id) || seen.has(id))) { duplicates++; continue }
    if (id !== undefined) seen.add(id)
    kept.push(row)
  }
  return { kept, duplicates }
}

/** One pending row with its match settled: the user's choice where there is one, else the matcher's proposal. */
export interface EffectiveRow {
  statementId: string
  row: PendingRow
  /**
   * What the payee resolved to — the user's rename, else the book's rules, else the file's own text — and the
   * category a rule picked. Settled before matching and carried, so the name the matcher compared on is the
   * same one the register draws and the same one the draft is written with.
   */
  rename: RuleOutcome
  disposition: Disposition
  /** The register transaction this row merges into, when matched. */
  matchedId?: string
  matchedBy: MatchedBy
  reason: string
}

/**
 * Every pending row of an account against its register, in one pass. The matcher proposes per statement; the
 * user's `userMatch` then wins, and a transaction the user claimed is taken away from any proposal that wanted
 * the same one — two statement rows cannot be one transaction.
 */
export function effectiveRows(
  statements: readonly PendingStatement[],
  existing: ExistingRow[],
  options: MatchOptions | ((statement: PendingStatement) => MatchOptions),
  /**
   * What each row's payee becomes, applied **before** the matcher sees it. Without this the matcher compares
   * the bank's raw text against the register's tidy names and calls a row new that the user already typed.
   * Absent in tests that are only about matching; then the file's own text stands.
   */
  renameOf: (row: PendingRow, statement: PendingStatement) => RuleOutcome = () => ({})
): EffectiveRow[] {
  const result: EffectiveRow[] = []
  for (const statement of statements) {
    const forStatement = typeof options === 'function' ? options(statement) : options
    const renames = statement.rows.map(row => renameOf(row, statement))
    // The matcher is given the renamed payee, which is the whole point of rules applying before matching.
    const incoming = statement.rows.map((row, at) => {
      const payee = payeeOf(renames[at], row.transaction)
      return payee === undefined ? row.transaction : { ...row.transaction, payee }
    })
    const { proposals } = matchStatement(incoming, existing, forStatement)
    for (const [at, row] of statement.rows.entries()) {
      const proposal = proposals[at]
      result.push({
        statementId: statement.id,
        row,
        rename: renames[at],
        disposition: proposal.disposition,
        ...(proposal.existingId !== undefined && { matchedId: proposal.existingId }),
        matchedBy: proposal.matchedBy,
        reason: proposal.reason
      })
    }
  }

  // The user's decisions win, and free or claim transactions for everyone else
  const claimedByUser = new Set<string>()
  for (const entry of result) {
    const match = entry.row.userMatch
    if (match === undefined) continue
    if (match === null) {
      entry.disposition = 'new'
      delete entry.matchedId
      entry.matchedBy = 'user'
      entry.reason = 'You chose to keep this unmatched'
    } else {
      entry.disposition = 'merge'
      entry.matchedId = match
      entry.matchedBy = 'user'
      entry.reason = 'Matched by you'
      claimedByUser.add(match)
    }
  }
  // The matcher runs per statement, each with its own claims, so two statements waiting in one account — an
  // October export and an overlapping "last 30 days" — can each propose the same transaction. Only the first
  // keeps it; the rest are new until it is accepted. (A reference match is left alone: two lines carrying the
  // same bank reference really are both the transaction that holds it.)
  const claimedByMatcher = new Set<string>()
  for (const entry of result) {
    if (entry.matchedBy === 'user' || entry.matchedId === undefined) continue
    if (claimedByUser.has(entry.matchedId)) {
      entry.disposition = 'new'
      delete entry.matchedId
      entry.matchedBy = 'none'
      entry.reason = 'Its match was matched to another statement line by you'
      continue
    }
    if (entry.matchedBy !== 'heuristic') continue
    if (claimedByMatcher.has(entry.matchedId)) {
      entry.disposition = 'new'
      delete entry.matchedId
      entry.matchedBy = 'none'
      entry.reason = 'Its match is claimed by a line of another statement waiting here'
      continue
    }
    claimedByMatcher.add(entry.matchedId)
  }
  return result
}

/** What a row's note in the register says: 'Matches 5 Oct', 'New', 'Already here'. */
export function noteFor(entry: EffectiveRow, existingById: ReadonlyMap<string, ExistingRow>): string {
  if (entry.matchedId === undefined) return DISPOSITION_LABELS[entry.disposition]
  const matched = existingById.get(entry.matchedId)
  if (matched === undefined) return DISPOSITION_LABELS[entry.disposition]
  const date = new Date(`${matched.date}T00:00:00`)
  const shown = isNaN(date.getTime()) ? matched.date : date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
  return `${DISPOSITION_LABELS[entry.disposition]} ${shown}`
}

/** A pending row as the register draws it, with Accept and Change on the selected row. */
export function toOverlayRow(
  entry: EffectiveRow,
  payee: string | undefined,
  categoryLabel: string | undefined,
  existingById: ReadonlyMap<string, ExistingRow>
): OverlayRow {
  const t = entry.row.transaction
  return {
    key: overlayKey(entry.statementId, entry.row.key),
    date: t.date,
    amount: t.amount,
    ...(t.number !== undefined && t.number.trim() !== '' && { number: t.number.trim() }),
    ...(payee !== undefined && { payee }),
    ...(t.memo !== undefined && { memo: t.memo }),
    ...(categoryLabel !== undefined && { categoryLabel }),
    ...(entry.matchedId !== undefined && { matchedId: entry.matchedId }),
    note: [
      ...(entry.row.archivedPeriod ? ['Before opening date (already archived)'] : []),
      noteFor(entry, existingById)
    ].join(' · '),
    actions: [
      { id: 'exchange.accept', label: 'Accept', command: EXCHANGE_COMMANDS.accept, primary: true },
      { id: 'exchange.change', label: 'Change…', command: EXCHANGE_COMMANDS.change },
      { id: 'exchange.rename', label: 'Edit…', command: EXCHANGE_COMMANDS.rename },
      { id: 'exchange.skip', label: 'Skip', command: EXCHANGE_COMMANDS.skip }
    ]
  }
}
