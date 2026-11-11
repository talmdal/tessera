// The import plugin's part in an archive (File › Archive Ledger…): tidying the records of the bank lines it has
// imported, after the accounts plugin has removed the transactions no longer required. It runs in the ledger's archive
// transaction, after `accounts`, and reads what that removed from `earlier`.
//
// A line's record is what keeps it from being imported again once its transaction is gone. So only records the import's
// own rule now covers are removed: those dated before the archive date, in an account whose last archival date is now
// past them, where a statement line is never added again (run.ts). Every record dated on or after the archive date
// stays: the bank posts a day or two after the date the user gave, so a transaction dated 30 December may be a bank
// line dated 2 January. See docs/ledger-compaction-design.md, "Imports after an archive".
import type { ArchiveParticipant } from '@tessera/ledger-api'
import { ACCOUNTS_PLUGIN_ID, type AccountsArchived } from '@tessera/accounts-api'
import { collectionsOf } from './store'

/** The removal lets the event loop turn every so many writes, as the accounts plugin's does. */
export const ARCHIVE_YIELD_EVERY = 2000

export interface ImportArchiverDeps {
  /** Told which accounts' import records changed, once the archive is committed. */
  changed(accounts: string[]): void
  /** Lets the event loop turn during a long removal. Default: `setImmediate`. */
  turn?: () => Promise<void>
}

const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []

/** What the accounts plugin shared, checked: a plugin's data from another plugin's copy of a package is read defensively. */
function accountsArchived(value: unknown): AccountsArchived | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const v = value as Partial<AccountsArchived>
  return {
    transactionIds: strings(v.transactionIds),
    removedAccountIds: strings(v.removedAccountIds),
    accounts: Array.isArray(v.accounts)
      ? v.accounts.filter(a => typeof a?.id === 'string' && typeof a.lastArchiveDate === 'string')
      : []
  }
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`

export function importArchiver(deps: ImportArchiverDeps): ArchiveParticipant {
  const turn = deps.turn ?? (() => new Promise<void>(resolve => setImmediate(resolve)))
  let touched: string[] = []

  return {
    // Which records go depends on which transactions the accounts plugin removes: nothing for the user to decide here
    describe: async () => undefined,

    archive: async (tx, { before, earlier }) => {
      touched = []
      const archived = accountsArchived(earlier.get(ACCOUNTS_PLUGIN_ID))
      if (!archived) return { count: 0, summary: 'No imported bank lines' }
      const removed = new Set(archived.transactionIds)
      const gone = new Set(archived.removedAccountIds)
      // The accounts whose last archival date is now at or after `before`: a line dated before it is never added again
      const covered = new Set(archived.accounts.filter(a => a.lastArchiveDate >= before).map(a => a.id))

      const c = collectionsOf(tx)
      const prunedBatches = new Set<string>()
      const accounts = new Set<string>()
      let lines = 0, writes = 0
      for (const line of await c.lines.find()) {
        const ofRemovedTransaction = (line.transactionId !== undefined && removed.has(line.transactionId))
          || (line.proposedId !== undefined && removed.has(line.proposedId))
        const prune = gone.has(line.accountId)
          || (covered.has(line.accountId) && line.bank.date < before && (ofRemovedTransaction || line.outcome === 'skipped'))
        if (!prune) continue
        await c.lines.deleteOne({ id: line.id })
        prunedBatches.add(line.batchId)
        accounts.add(line.accountId)
        lines++
        if (++writes % ARCHIVE_YIELD_EVERY === 0) await turn()
      }
      await turn()

      // A batch left with no lines goes. One still being applied, which recovery settles, is left alone
      const remaining = new Set((await c.lines.find()).map(line => line.batchId))
      for (const batch of await c.batches.find()) {
        const empty = (prunedBatches.has(batch.id) && !remaining.has(batch.id) && batch.state !== 'applying') || gone.has(batch.accountId)
        if (empty) await c.batches.deleteOne({ id: batch.id })
      }
      for (const link of await c.links.find()) if (gone.has(link.accountId)) await c.links.deleteOne({ id: link.id })

      touched = [...accounts].filter(id => !gone.has(id))
      return { count: lines, summary: plural(lines, 'imported bank line') }
    },

    committed: () => {
      const changed = touched
      touched = []
      if (changed.length > 0) deps.changed(changed)
    }
  }
}

