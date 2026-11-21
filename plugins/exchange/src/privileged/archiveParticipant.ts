// The exchange plugin's part in archiving. See docs/archive-design.md, "Participants".
//
// An import batch exists so an import can be undone. Once every transaction it created or merged into is being
// archived away, there is nothing left to undo into: the batch goes with them. Everything else — account links,
// payee rules, profiles, pending statements — is about future imports, and stays. Whether a batch's rows are all
// going is answered by the surveys' published ids, which is why surveys run in two passes.
import type { Doc, Transaction as StorageTransaction } from '@tessera/types'
import type {
  ArchiveContext, ArchiveParticipant, ArchiveRequest, ArchiveResult, ArchiveSurvey, ArchiveWarning
} from '@tessera/book-api'
import { collectionsOf, type Collections, type StoredBatch } from './store'

const count = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`

/** `2026-01-01` → `1 Jan 2026` (locale-dependent), read as a local date so it is never a day out. */
const humanDate = (iso: string): string => {
  const [year, month, day] = iso.split('-').map(Number)
  const date = new Date(year, (month ?? 1) - 1, day ?? 1)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString(undefined, { dateStyle: 'medium' })
}

/** Every transaction a batch created or merged into: what undoing it would touch. */
export const batchTransactionIds = (batch: Pick<StoredBatch, 'created' | 'merged'>): string[] => [
  ...batch.created.flatMap(group => group.rows.map(row => row.id)),
  ...batch.merged.map(record => record.id)
]

/** Removable: closed, it touched something, and every transaction it touched is being archived. */
const isSpent = (batch: Doc<StoredBatch>, removed: ReadonlySet<string>): boolean => {
  if (batch.closedAt === undefined) return false
  const ids = batchTransactionIds(batch)
  return ids.length > 0 && ids.every(id => removed.has(id))
}

async function spentBatches(c: Collections, removed: ReadonlySet<string>): Promise<Doc<StoredBatch>[]> {
  return (await c.batches.find({})).filter(batch => isSpent(batch, removed))
}

export function exchangeArchiveParticipant(deps: { collections: () => Collections }): ArchiveParticipant {
  return {
    async survey(request: ArchiveRequest, published: ReadonlySet<string>): Promise<ArchiveSurvey> {
      const c = deps.collections()
      const batches = await c.batches.find({})
      const spent = batches.filter(batch => isSpent(batch, published))

      const warnings: ArchiveWarning[] = []
      // An open import touching the archived period: its statement still has rows, so the batch stays
      for (const batch of batches) {
        if (batch.closedAt !== undefined) continue
        if (!batchTransactionIds(batch).some(id => published.has(id))) continue
        warnings.push({ kind: 'openImport', message: `One import of “${batch.fileName}” is still open. Its batch is kept.` })
      }
      // A statement read but not yet reviewed, reaching into the archived period
      for (const pending of await c.pending.find({})) {
        if (pending.period?.from !== undefined && pending.period.from < request.before) {
          warnings.push({
            kind: 'openImport',
            message: `A statement of “${pending.fileName}” from before ${humanDate(request.before)} hasn’t been reviewed. It is kept.`
          })
        }
      }

      return {
        describe: count(spent.length, 'import batch', 'import batches'),
        documents: spent.length,
        warnings
      }
    },

    async prune(tx: StorageTransaction, context: ArchiveContext): Promise<ArchiveResult> {
      const c = collectionsOf(tx)
      const spent = await spentBatches(c, context.removedIds)
      if (spent.length > 0) await c.batches.deleteMany({ id: { $in: spent.map(batch => batch.id) } })
      return { documents: spent.length }
    }
  }
}
