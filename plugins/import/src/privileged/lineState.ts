// Where a bank line stands, worked out from its record and the account's transactions. A review change writes its
// intent on the line, then makes its `accounts` write, then records the result; an interruption between them leaves
// the intent, and which transaction now carries the line's import id (the carrier) says whether the write happened.
// `settle` applies that rule; it is pure, so the annotator can use it on a read-only ledger, and the review commands
// save what it gives. See docs/import-manager-design.md, "Applying an import" and "The Change Match dialog".
import type { Transaction } from '@tessera/accounts-api'
import type { MatchState } from '@tessera/import-api'
import type { StoredLine } from './store'

export type Line = StoredLine & { id: string, rev: number }

/** The line with no review fields set: it lost its transaction, and waits for the user. */
function unresolved(line: Line): Line {
  const { transactionId: _t, proposedId: _p, before: _b, intent: _i, duplicateOf: _d, ...rest } = line
  return { ...rest, outcome: 'matched', review: 'pending' }
}

/**
 * The line once any interrupted change is settled, given its carrier (the transaction whose `externalId` is the
 * line's import id, if any):
 * - the write happened (the carrier is as intended): the intended line;
 * - it didn't: the line as it was;
 * - half of it did (the line's transaction lost the id, and the intended one didn't get it: a move interrupted
 *   between its unmatch and its match): unresolved.
 */
export function settle(line: Line, carrier: Pick<Transaction, 'id'> | undefined): Line {
  const { intent, ...rest } = line
  if (!intent) return line
  const { carrier: intended, next } = intent
  const happened = intended.kind === 'none' ? carrier === undefined
    : intended.kind === 'id' ? carrier?.id === intended.id
    : carrier !== undefined && carrier.id !== line.transactionId
  if (happened) {
    // (A line that looked already imported, now added or matched elsewhere, is no longer that)
    const { transactionId: _t, proposedId: _p, before: _b, duplicateOf: _d, ...kept } = rest
    const transactionId = intended.kind === 'new' ? carrier!.id : next.transactionId
    return { ...kept, ...next, ...(transactionId !== undefined && { transactionId }) }
  }
  if (carrier === undefined && line.transactionId !== undefined && line.outcome !== 'skipped') return unresolved(rest as Line)
  return rest as Line
}

/** What the register and the dialogs make of a settled line. */
export type LineView =
  /** The user chose not to import it. */
  | { state: 'skipped' }
  /** Its transaction was deleted: it stays recorded (so it isn't imported again), and shows nowhere. */
  | { state: 'gone' }
  | { state: 'new', transaction: Transaction, pending: boolean }
  | { state: 'proposed', transaction: Transaction }
  | { state: 'accepted', transaction: Transaction }
  | { state: 'unresolved' }
  /**
   * It looks like a line imported before from another file, whose transaction this is: nothing was added for it. The
   * transaction may be reconciled (last month's import was, most likely); if it was deleted or voided, the line is
   * unresolved.
   */
  | { state: 'duplicate', transaction: Transaction }

/** Where a settled line stands, given its transactions (`byId`). */
export function viewOf(line: Line, byId: (id: string) => Transaction | undefined): LineView {
  if (line.outcome === 'skipped') return { state: 'skipped' }
  if (line.outcome === 'added') {
    const transaction = line.transactionId !== undefined ? byId(line.transactionId) : undefined
    return transaction ? { state: 'new', transaction, pending: line.review === 'pending' } : { state: 'gone' }
  }
  if (line.transactionId !== undefined) {
    const transaction = byId(line.transactionId)
    if (!transaction) return { state: 'gone' }
    return transaction.externalId === line.importId ? { state: 'accepted', transaction } : { state: 'unresolved' }
  }
  if (line.duplicateOf !== undefined && line.proposedId !== undefined) {
    const transaction = byId(line.proposedId)
    return transaction && !transaction.voided ? { state: 'duplicate', transaction } : { state: 'unresolved' }
  }
  if (line.proposedId !== undefined) {
    const transaction = byId(line.proposedId)
    // Accepted, though the record didn't say so yet (an older interruption): the transaction carries the line
    if (transaction?.externalId === line.importId) return { state: 'accepted', transaction }
    if (transaction && !transaction.voided && transaction.status !== 'reconciled' && transaction.externalId === undefined) {
      return { state: 'proposed', transaction }
    }
  }
  return { state: 'unresolved' }
}

/** The dialog's name for a view's state. */
export function matchStateOf(view: LineView): MatchState | undefined {
  switch (view.state) {
    case 'new': return 'new'
    case 'proposed': return 'proposed'
    case 'accepted': return 'accepted'
    case 'unresolved': return 'unresolved'
    case 'duplicate': return 'duplicate'
    default: return undefined
  }
}

/** The transaction a view shows the line on, if any. */
export const transactionOf = (view: LineView): Transaction | undefined =>
  view.state === 'new' || view.state === 'proposed' || view.state === 'accepted' || view.state === 'duplicate' ? view.transaction : undefined

/**
 * The date a transaction takes when a bank line is matched to it: the bank's, unless that would move it before the
 * account's last archival date (`start`), which the accounts refuse. Then it keeps its own: the bank posted it a day or
 * two before the cut, and the user entered it after.
 */
export function matchedDate(line: Pick<Line, 'bank'>, t: Pick<Transaction, 'date'>, start: string | undefined): string {
  return start !== undefined && line.bank.date < start && t.date >= start ? t.date : line.bank.date
}
