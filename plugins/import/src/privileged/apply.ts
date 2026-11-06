// Applying an import, and putting right one that was interrupted. The import plugin's records and the accounts'
// transactions live in different plugins' collections, and a storage transaction can't span both, so an import is
// applied in three steps, each atomic:
//   1. import: the batch ('applying') and its lines, new ones and proposed matches;
//   2. accounts: createMany, every new transaction or none (a proposed match writes nothing there);
//   3. import: the lines point at their transactions; the batch is 'applied'.
// A batch still 'applying' later is settled by what step 2 left: since it is all or none, any of its lines' ids in the
// account means it happened (step 3 is finished); none means it didn't (step 1 is undone, and the user told).
// See docs/import-manager-design.md, "Applying an import".
import type { Database } from '@tessera/types'
import { isAccountsError, type AccountsService, type Transaction, type TransactionDraft } from '@tessera/accounts-api'
import type { ImportCounts } from '@tessera/import-api'
import type { ConvertedLine } from './convert'
import { collectionsOf, type StoredBatch } from './store'

export interface ApplyRequest {
  accountId: string
  fileName: string
  filePath?: string
  formatId?: string
  statementIndex: number
  period?: StoredBatch['period']
  bankBalance?: StoredBatch['bankBalance']
  counts: ImportCounts
  /** The lines to add, and their drafts, in the same order. */
  lines: ConvertedLine[]
  drafts: TransactionDraft[]
  /** The lines proposed as matches for transactions already in the account: recorded, nothing added. */
  matched?: { line: ConvertedLine, proposedId: string, score: number }[]
}

/** Step 3: each line points at the transaction it became; the batch is done. */
async function complete(db: Database, batchId: string, transactions: Transaction[]): Promise<void> {
  const byImportId = new Map(transactions.map(t => [t.externalId, t.id]))
  await db.transaction(async tx => {
    const c = collectionsOf(tx)
    for (const line of await c.lines.find({ batchId })) {
      const id = byImportId.get(line.importId)
      if (id !== undefined && line.transactionId !== id) await c.lines.updateOne({ id: line.id }, { $set: { transactionId: id } })
    }
    await c.batches.updateOne({ id: batchId }, { $set: { state: 'applied' } })
  })
}

async function undo(db: Database, batchId: string): Promise<void> {
  await db.transaction(async tx => {
    const c = collectionsOf(tx)
    await c.lines.deleteMany({ batchId })
    await c.batches.deleteOne({ id: batchId })
  })
}

/** Applies an import in its three steps. Returns the batch and the transactions added. */
export async function applyImport(db: () => Database, accounts: AccountsService, request: ApplyRequest, now: string): Promise<{ batchId: string, transactions: Transaction[] }> {
  // 1. The batch and its lines
  const batchId = await db().transaction(async tx => {
    const c = collectionsOf(tx)
    const batch = await c.batches.insert({
      accountId: request.accountId, fileName: request.fileName, statementIndex: request.statementIndex, importedAt: now,
      state: 'applying', counts: request.counts,
      ...(request.filePath !== undefined && { filePath: request.filePath }),
      ...(request.formatId !== undefined && { formatId: request.formatId }),
      ...(request.period !== undefined && { period: request.period }),
      ...(request.bankBalance !== undefined && { bankBalance: request.bankBalance })
    })
    const records = [
      ...request.lines.map(line => ({
        batchId: batch.id, accountId: request.accountId, importId: line.importId, bank: line.bank,
        outcome: 'added' as const, review: 'pending' as const
      })),
      // A proposal changes nothing in the account until the user accepts it
      ...(request.matched ?? []).map(({ line, proposedId, score }) => ({
        batchId: batch.id, accountId: request.accountId, importId: line.importId, bank: line.bank,
        outcome: 'matched' as const, review: 'pending' as const, proposedId, score
      }))
    ]
    if (records.length > 0) await c.lines.insertMany(records)
    return batch.id
  })

  // 2. The transactions, all or none; if none, nothing of the import is kept
  let transactions: Transaction[]
  try {
    transactions = request.drafts.length > 0 ? await accounts.transactions(request.accountId).createMany(request.drafts) : []
  } catch (err) {
    await undo(db(), batchId)
    throw err
  }

  // 3. Done. If this step is interrupted, recovery finishes it
  await complete(db(), batchId, transactions)
  return { batchId, transactions }
}

/**
 * Settles every batch an interruption left 'applying'. Returns notices for the user about imports that had to be
 * undone; those that had been applied are simply finished.
 */
export async function recoverImports(db: () => Database, accounts: AccountsService): Promise<string[]> {
  const notices: string[] = []
  const c = collectionsOf(db())
  for (const batch of await c.batches.find({ state: 'applying' })) {
    const waiting = (await c.lines.find({ batchId: batch.id })).filter(line => line.outcome === 'added' && line.transactionId === undefined)
    let found: Transaction[] = []
    if (waiting.length > 0) {
      try {
        found = await accounts.transactions(batch.accountId).findByExternalIds(waiting.map(line => line.importId))
      } catch (err) {
        if (!isAccountsError(err) || err.code !== 'NOT_FOUND') throw err   // the account is gone: nothing was kept
      }
    }
    if (waiting.length === 0 || found.length > 0) await complete(db(), batch.id, found)
    else {
      await undo(db(), batch.id)
      notices.push(`The import of ${batch.fileName} was interrupted, so nothing from it was added. Import the file again.`)
    }
  }
  return notices
}
