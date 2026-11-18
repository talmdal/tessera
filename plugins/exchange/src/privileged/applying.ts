// Writing one accepted statement row into the book, and taking a whole batch back out again.
//
// Everything is written through `accounts.service`, never against its collections, so every rule the account
// manager enforces — closed accounts, transfers, currencies, reconciled balances — applies to an import exactly
// as it does to a user typing. Accepting happens row by row in the register, and each acceptance is recorded on
// the statement's batch, so Undo Import can still take the whole statement back out.
import type { AccountsService, Transaction, TransactionPatch } from '@tessera/accounts-api'
import {
  ExchangeError,
  type ExchangeTransaction, type ImportBatch, type ImportDraft, type MergedBefore, type MergedRecord,
  type RemovedTransaction, type UndoJournal, type UndoResult
} from '@tessera/exchange-api'

export interface AcceptDeps {
  accounts: AccountsService
  /** Take the source's memo and number when merging. */
  adoptBankDetail: boolean
  /** A transaction's payee by name, so undo can put it back when a merge renames it. */
  payeeOf?: (transactionId: string) => string | undefined
}

/** Writes one unmatched row as a new transaction, marked `electronic`. Resolves its id. */
export async function acceptNew(draft: ImportDraft, accountId: string, accounts: AccountsService): Promise<string> {
  const written = await accounts.transactions(accountId).create(draft)
  return written.id
}

/**
 * Merges one accepted row into its register transaction. The statement is the source of truth for what happened
 * at the bank, so the transaction takes the statement's date, amount and payee (after the payee rules), adopts
 * its reference, and becomes `electronic`. Its category and splits stay the user's. Every field changed is
 * recorded, so Undo puts the transaction back exactly as it was.
 *
 * The record comes back without its `at`: the time a row was accepted belongs to the batch's clock, which the
 * caller owns, and a second clock here would drift from it.
 */
export async function mergeInto(
  existingId: string,
  incoming: ExchangeTransaction,
  draft: ImportDraft,
  accountId: string,
  deps: AcceptDeps
): Promise<Omit<MergedRecord, 'at'>> {
  const manager = deps.accounts.transactions(accountId)
  const current = await manager.get(existingId)
  if (current === undefined) throw new ExchangeError('NOT_FOUND', 'The transaction this row matched is no longer there.')

  // The source withdrew the transaction: void it, never delete it, so a reconciled row cannot vanish
  if (incoming.corrects?.action === 'delete') {
    const before: MergedBefore = { status: current.status, voided: current.voided }
    await manager.setVoided([existingId], true, { confirm: ['reconciled'] })
    return { accountId, id: existingId, before }
  }

  const patch: TransactionPatch = { status: 'electronic' }
  const before: MergedBefore = { status: current.status }

  const externalId = draft.externalId
  if (externalId !== undefined && current.externalId !== externalId) {
    patch.externalId = externalId
    before.externalId = current.externalId ?? null
  }
  if (deps.adoptBankDetail) {
    if (draft.memo !== undefined && draft.memo !== current.memo) {
      patch.memo = draft.memo
      before.memo = current.memo ?? null
    }
    if (draft.number !== undefined && draft.number !== current.number) {
      patch.number = draft.number
      before.number = current.number ?? null
    }
  }
  if (draft.amount !== current.amount) {
    patch.amount = draft.amount
    before.amount = current.amount
  }
  if (draft.date !== current.date) {
    patch.date = draft.date
    before.date = current.date
  }
  // The payee too: the statement's, after the payee rules
  const was = deps.payeeOf?.(existingId)
  if (draft.payee !== undefined && draft.payee !== was) {
    patch.payee = draft.payee
    before.payee = was ?? null
  }

  // A reconciled row is never merged into silently; the user accepted the row knowing what it matched
  await manager.update(existingId, patch, { confirm: ['reconciled'] })
  return { accountId, id: existingId, before }
}

// ---- Undo ---------------------------------------------------------------------------------------

export interface UndoDeps {
  accounts: AccountsService
}

/**
 * What stands between a batch and a clean reversal: rows reconciled since the import, and rows edited since.
 * Gathered before anything is written, so `undo` either does the whole batch or writes nothing.
 */
export async function undoObstacles(batch: ImportBatch, accounts: AccountsService): Promise<{ reconciled: string[], edited: string[] }> {
  const reconciled: string[] = []
  const edited: string[] = []

  // Each row is compared against the moment *it* was accepted, not against the batch's. A batch is accreted
  // over however long the user takes to read the statement, so a single timestamp cannot answer this: bumped
  // to the latest acceptance it hides an edit made before the last row went in, and left at the first it
  // reports every later row as edited. Only the row knows.
  for (const group of batch.created) {
    const manager = accounts.transactions(group.accountId)
    for (const row of group.rows) {
      const current = await manager.get(row.id)
      if (current === undefined) continue
      if (current.status === 'reconciled') reconciled.push(row.id)
      else if (current.updatedAt > row.at) edited.push(row.id)
    }
  }
  for (const record of batch.merged) {
    const current = await accounts.transactions(record.accountId).get(record.id)
    if (current === undefined) continue
    if (current.status === 'reconciled') reconciled.push(record.id)
    else if (current.updatedAt > record.at) edited.push(record.id)
  }
  return { reconciled, edited }
}

export function describeObstacles(obstacles: { reconciled: string[], edited: string[] }): ExchangeError | undefined {
  const reasons: ('reconciled' | 'editedSince')[] = []
  const parts: string[] = []
  if (obstacles.reconciled.length > 0) {
    reasons.push('reconciled')
    parts.push(`${obstacles.reconciled.length} ${plural(obstacles.reconciled.length, 'transaction')} reconciled since`)
  }
  if (obstacles.edited.length > 0) {
    reasons.push('editedSince')
    parts.push(`${obstacles.edited.length} ${plural(obstacles.edited.length, 'transaction')} changed since`)
  }
  if (reasons.length === 0) return undefined
  return new ExchangeError('CONFIRMATION_REQUIRED',
    `This import has ${parts.join(' and ')}. Undoing it takes those back out too.`, undefined, reasons)
}

const plural = (n: number, word: string) => n === 1 ? word : `${word}s`

/** Reverses a whole batch: every created transaction deleted, every merged one put back as it was. */
/**
 * Takes a batch's writes back out — or any set of writes shaped like one: `accept` uses this to undo a single
 * row's write when it could not be recorded, so a transaction never exists that no batch knows about.
 *
 * Each step goes through `accounts.service`, which this plugin cannot hold in one storage transaction, so an
 * undo can fail part-way. It is therefore journalled: after every step `record` is given the journal so far,
 * which says what the step did and what puts it back. On a failure the steps already taken are backed out by
 * `backOut`, in reverse, and the error is rethrown — the book ends as it was before the undo, not half-reversed.
 *
 * The order matters. Merged transactions are restored first: putting those back is always possible, since the
 * import's own version of each is in the journal. Created transactions are deleted last, because writing a
 * deleted one back gives it a new id — so the fewer of those there are when something fails, the better.
 */
export async function reverse(
  batch: Pick<ImportBatch, 'id' | 'created' | 'merged'>,
  deps: UndoDeps & {
    /** Called with the journal after every step, to keep it where a later undo can find it. */
    record?: (journal: UndoJournal) => Promise<void>
    /** Called once a failed undo has been backed out, with where the re-created transactions now are. */
    backedOut?: (recreated: Recreated) => Promise<void>
    now?: () => string
  }
): Promise<Omit<UndoResult, 'kept'>> {
  const confirm = ['reconciled' as const]
  const journal: UndoJournal = { startedAt: deps.now?.() ?? new Date().toISOString(), restored: [], removed: [] }
  const record = async () => { await deps.record?.(journal) }

  try {
    for (const merged of batch.merged) {
      const manager = deps.accounts.transactions(merged.accountId)
      const current = await manager.get(merged.id)
      // Gone already — the user deleted it — which is a state undo has nothing to say about
      if (current === undefined) continue
      // How the import left it, in exactly the fields the restore is about to change. Journalled *before* the
      // restore, so a restore that takes effect and then reports failure is still put back: re-applying the
      // import's version is safe whether or not the restore happened.
      const imported = importedState(current, merged.before, await payeeName(deps.accounts, current))
      journal.restored.push({ accountId: merged.accountId, id: merged.id, imported })
      await record()
      await manager.update(merged.id, patchFrom(merged.before), { confirm })
      if (merged.before.voided !== undefined && merged.before.voided !== current.voided) {
        await manager.setVoided([merged.id], merged.before.voided, { confirm })
      }
    }

    for (const group of batch.created) {
      const manager = deps.accounts.transactions(group.accountId)
      const register = await manager.register()
      const byId = new Map(register.rows.map(row => [row.transaction.id, row]))
      // Only what is still there: a row the user deleted by hand is already gone, which is the outcome wanted
      const rows = group.rows.filter(row => byId.has(row.id))
      if (rows.length === 0) continue
      // Journalled before the delete, for the same reason: a delete can take effect and still report failure.
      // Backing out writes back only the rows that are actually gone.
      const snapshots = rows.map(row => snapshot(byId.get(row.id)!.transaction, byId.get(row.id)!.payeeName, row.at))
      journal.removed.push({ accountId: group.accountId, rows: snapshots })
      await record()
      await manager.delete(rows.map(row => row.id), { confirm })
    }
  } catch (err) {
    // Whatever was undone is put back, so the batch is still the import it was and can be undone again. If that
    // fails too, the journal `record` last saved is left in place, and the next undo backs it out first.
    const recreated = await backOut(journal, deps)
    await deps.backedOut?.(recreated)
    throw err
  }

  return {
    batchId: batch.id,
    removed: journal.removed.reduce((n, group) => n + group.rows.length, 0),
    restored: journal.restored.length
  }
}

/** Where a backed-out undo's re-created transactions now are: old id → new id, by account. */
export type Recreated = Map<string, string>

/**
 * Puts an undo's journalled steps back, newest first: deleted transactions written back from their snapshots,
 * restored ones returned to how the import had left them. Resolves the new ids of the rows written back, so the
 * batch can be pointed at them. Used both when an undo fails and when a journal is found left behind by an undo
 * that never finished.
 */
export async function backOut(journal: UndoJournal, deps: UndoDeps): Promise<Recreated> {
  const confirm = ['reconciled' as const]
  const recreated: Recreated = new Map()

  for (const group of [...journal.removed].reverse()) {
    const manager = deps.accounts.transactions(group.accountId)
    // The journal records a delete before it is made, so some of these may never have gone
    const gone: RemovedTransaction[] = []
    for (const row of group.rows) if (await manager.get(row.id) === undefined) gone.push(row)
    if (gone.length === 0) continue
    const written = await manager.createMany(gone.map(row => row.draft), { confirm })
    for (const [at, row] of gone.entries()) {
      recreated.set(row.id, written[at].id)
      if (row.voided) await manager.setVoided([written[at].id], true, { confirm })
    }
  }

  for (const restored of [...journal.restored].reverse()) {
    const manager = deps.accounts.transactions(restored.accountId)
    const current = await manager.get(restored.id)
    if (current === undefined) continue
    await manager.update(restored.id, patchFrom(restored.imported), { confirm })
    if (restored.imported.voided !== undefined && restored.imported.voided !== current.voided) {
      await manager.setVoided([restored.id], restored.imported.voided, { confirm })
    }
  }
  return recreated
}

/** A created transaction as a draft that writes it back, with the import's time and whether it was voided. */
function snapshot(transaction: Transaction, payee: string | undefined, at: string): RemovedTransaction {
  return {
    id: transaction.id,
    at,
    voided: transaction.voided,
    draft: {
      date: transaction.date,
      amount: transaction.amount,
      status: transaction.status,
      ...(transaction.number !== undefined && { number: transaction.number }),
      ...(payee !== undefined && { payee }),
      ...(transaction.memo !== undefined && { memo: transaction.memo }),
      ...(transaction.categoryId !== undefined && { categoryId: transaction.categoryId }),
      ...(transaction.transferAccountId !== undefined && { transferAccountId: transaction.transferAccountId }),
      ...(transaction.externalId !== undefined && { externalId: transaction.externalId })
    }
  }
}

/** A merged transaction as the import left it, in the fields `before` says the restore will change. */
function importedState(current: Transaction, before: MergedBefore, payee: string | undefined): MergedBefore {
  return {
    status: current.status,
    ...(before.externalId !== undefined && { externalId: current.externalId ?? null }),
    ...(before.memo !== undefined && { memo: current.memo ?? null }),
    ...(before.number !== undefined && { number: current.number ?? null }),
    ...(before.amount !== undefined && { amount: current.amount }),
    ...(before.date !== undefined && { date: current.date }),
    ...(before.payee !== undefined && { payee: payee ?? null }),
    ...(before.voided !== undefined && { voided: current.voided })
  }
}

/** A transaction's payee, by name, as a patch or a draft takes it. */
async function payeeName(accounts: AccountsService, transaction: Transaction): Promise<string | undefined> {
  if (transaction.payeeId === undefined) return undefined
  const register = await accounts.transactions(transaction.accountId).register()
  return register.rows.find(row => row.transaction.id === transaction.id)?.payeeName
}

/** The patch that puts a merged transaction back: `null` clears what the import added. */
function patchFrom(before: MergedBefore): TransactionPatch {
  const patch: TransactionPatch = { status: before.status }
  if (before.externalId !== undefined) patch.externalId = before.externalId
  if (before.memo !== undefined) patch.memo = before.memo
  if (before.number !== undefined) patch.number = before.number
  if (before.amount !== undefined) patch.amount = before.amount
  if (before.date !== undefined) patch.date = before.date
  if (before.payee !== undefined) patch.payee = before.payee
  return patch
}

/** A transaction as the history dialog and the undo message describe it. */
export type { Transaction }
