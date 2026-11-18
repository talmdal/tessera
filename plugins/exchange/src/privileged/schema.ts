// What the exchange plugin stores in every book: the import history, the source-to-account links, the payee
// renaming rules, the saved format profiles, and the statements read but not yet gone through in a register.
// All of it belongs to the book rather than the application, because a business book renames different payees
// and draws on different accounts from a personal one.
import type { Database } from '@tessera/types'
import type { Migrator, SchemaContribution } from '@tessera/book-api'
import {
  EXCHANGE_COLLECTIONS, EXCHANGE_MIGRATOR_SERVICE, EXCHANGE_PLUGIN_ID, EXCHANGE_SCHEMA_VERSION,
  type ExchangeTransaction, type PendingRow, type PendingStatement
} from '@tessera/exchange-api'

export const EXCHANGE_SCHEMA: SchemaContribution = {
  id: EXCHANGE_PLUGIN_ID,
  version: EXCHANGE_SCHEMA_VERSION,
  migrator: EXCHANGE_MIGRATOR_SERVICE,
  collections: [
    {
      name: EXCHANGE_COLLECTIONS.batches,
      indexes: [
        { name: 'byDate', fields: ['importedAt'] },
        // Re-importing the identical file is noticed before it is read
        { name: 'byFile', fields: ['fileHash'] }
      ]
    },
    {
      name: EXCHANGE_COLLECTIONS.links,
      // One link per (format, bank, account number): answering again replaces it rather than adding a second
      indexes: [{ name: 'uniqueSource', fields: ['formatId', 'bankId', 'numberKey'], unique: true }]
    },
    {
      name: EXCHANGE_COLLECTIONS.rules,
      indexes: [{ name: 'byOrder', fields: ['order'] }]
    },
    {
      name: EXCHANGE_COLLECTIONS.profiles,
      indexes: [{ name: 'byFingerprint', fields: ['formatId', 'fingerprint'], unique: true }]
    },
    {
      // Statements read but not yet gone through in the register (version 2; one document per statement since 3)
      name: EXCHANGE_COLLECTIONS.pending,
      indexes: [{ name: 'byAccount', fields: ['accountId'] }]
    },
    {
      // An earlier build's layout, converted and emptied by the 2 → 3 migration; declared so it can be read at all
      name: EXCHANGE_COLLECTIONS.legacyStatements
    }
  ]
}

/**
 * Version 0 → 1 seeds nothing: a book with no imports has no rules, no links and no history, and an empty list
 * is the correct starting state. 1 → 2 only declares `exchange.pending`, which the engine creates from the
 * schema. 2 → 3 converts the shape an earlier build of this feature gave that collection — one document per
 * statement *row*, with the statement itself in `exchange.statements` — into one document per statement.
 * 3 → 4 stamps each written row in the history with its own acceptance time; see `stampAcceptedRows`.
 */
export const exchangeMigrator: Migrator = {
  async migrate(db, from) {
    if (from === 2) await convertPerRowPending(db)
    if (from <= 3) await stampAcceptedRows(db)
  }
}

/**
 * 3 → 4: gives every written row its own acceptance time.
 *
 * Before this, `created` held bare ids and the batch's single `importedAt` was rewritten on every acceptance,
 * which meant undo compared a row against a timestamp later than any edit the user had made to it — so an edit
 * made between two acceptances was silently discarded instead of being asked about.
 *
 * The old data cannot say when each row was actually accepted; the batch's `importedAt` is the best available
 * answer and is the *latest* acceptance, so an edit genuinely made before it still cannot be distinguished.
 * That is a limit of what was recorded, not of the new shape: rows written from here on carry a true time.
 * Safe to run again — a batch already converted is left alone.
 */
export async function stampAcceptedRows(db: Database): Promise<void> {
  const names = await db.listCollections()
  if (!names.includes(EXCHANGE_COLLECTIONS.batches)) return

  await db.transaction(async tx => {
    const batches = tx.collection<Record<string, unknown>>(EXCHANGE_COLLECTIONS.batches)
    for (const doc of await batches.find()) {
      const at = isText(doc.importedAt) ? doc.importedAt : new Date().toISOString()
      const created = Array.isArray(doc.created) ? doc.created : []
      const merged = Array.isArray(doc.merged) ? doc.merged : []

      // Already converted: every group has `rows` rather than `ids`.
      const converted = created.every(group => Array.isArray((group as { rows?: unknown }).rows))
      if (converted && doc.lastAcceptedAt !== undefined) continue

      await batches.replace({
        ...doc,
        lastAcceptedAt: isText(doc.lastAcceptedAt) ? doc.lastAcceptedAt : at,
        created: created.map(raw => {
          const group = raw as { accountId?: unknown, ids?: unknown, rows?: unknown }
          if (Array.isArray(group.rows)) return group
          const ids = Array.isArray(group.ids) ? group.ids : []
          return {
            accountId: group.accountId,
            rows: ids.filter(isText).map(id => ({ id, at }))
          }
        }),
        merged: merged.map(raw => {
          const record = raw as { at?: unknown }
          return isText(record.at) ? record : { ...record, at }
        })
      } as Record<string, unknown> & { id: string, rev: number })
    }
  })
}

/** A statement as the earlier build stored it. Read defensively: it is another build's data. */
interface LegacyStatement {
  accountId: string
  batchId?: string
  formatId: string
  dialect?: string
  fileName: string
  fileHash: string
  importedAt: string
  period?: { from?: string, to?: string }
  balance?: { amount: number, asOf: string }
}

/** One row as the earlier build stored it. */
interface LegacyRow {
  id: string
  statementId: string
  accountId: string
  index: number
  incoming: ExchangeTransaction
  matchedBy?: string
  existingId?: string
}

const isText = (value: unknown): value is string => typeof value === 'string' && value !== ''

/**
 * Groups the per-row documents by statement, joins each group with its statement document, and writes one
 * `PendingStatement` in their place. A row the user matched by hand keeps that as `userMatch`; the matcher's
 * own proposals are not carried over, since they are recomputed against the live register anyway. Rows whose
 * statement is missing are dropped: nothing can be read without knowing which file and account they belong to.
 * Safe to run again — a document already in the new shape is left alone.
 */
export async function convertPerRowPending(db: Database): Promise<void> {
  const names = await db.listCollections()
  if (!names.includes(EXCHANGE_COLLECTIONS.pending)) return

  await db.transaction(async tx => {
    const pending = tx.collection<Record<string, unknown>>(EXCHANGE_COLLECTIONS.pending)
    const converted = tx.collection<Omit<PendingStatement, 'id' | 'rev'>>(EXCHANGE_COLLECTIONS.pending)
    const legacy = names.includes(EXCHANGE_COLLECTIONS.legacyStatements)
      ? tx.collection<LegacyStatement>(EXCHANGE_COLLECTIONS.legacyStatements)
      : undefined

    const rows: LegacyRow[] = []
    for (const doc of await pending.find()) {
      if (Array.isArray(doc.rows)) continue   // already in this build's shape
      if (!isText(doc.statementId) || typeof doc.incoming !== 'object' || doc.incoming === null) continue
      rows.push(doc as unknown as LegacyRow)
    }
    if (rows.length === 0 && legacy === undefined) return

    const byStatement = new Map<string, LegacyRow[]>()
    for (const row of rows) {
      const group = byStatement.get(row.statementId) ?? []
      group.push(row)
      byStatement.set(row.statementId, group)
    }

    for (const [statementId, group] of byStatement) {
      const statement = legacy === undefined ? undefined : await legacy.get(statementId)
      if (statement !== undefined && isText(statement.accountId) && isText(statement.fileName)) {
        const statementDoc: Omit<PendingStatement, 'id' | 'rev'> = {
          accountId: statement.accountId,
          readAt: isText(statement.importedAt) ? statement.importedAt : new Date().toISOString(),
          formatId: isText(statement.formatId) ? statement.formatId : 'unknown',
          ...(isText(statement.dialect) && { dialect: statement.dialect }),
          fileName: statement.fileName,
          fileHash: isText(statement.fileHash) ? statement.fileHash : '',
          source: {},
          ...(statement.period !== undefined && { period: statement.period }),
          ...(statement.balance !== undefined && { ledger: statement.balance }),
          ...(isText(statement.batchId) && { batchId: statement.batchId }),
          rows: [...group]
            .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
            .map((row, at): PendingRow => ({
              key: `r${Number.isInteger(row.index) ? row.index : at}`,
              transaction: row.incoming,
              ...(row.matchedBy === 'user' && { userMatch: isText(row.existingId) ? row.existingId : null })
            }))
        }
        await converted.insert(statementDoc)
      }
      for (const row of group) await pending.deleteOne({ id: row.id })
    }

    if (legacy !== undefined) {
      for (const statement of await legacy.find()) await legacy.deleteOne({ id: statement.id })
    }
  })
}
