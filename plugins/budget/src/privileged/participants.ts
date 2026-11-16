// The budget plugin's parts in deleting a sub-ledger and in archiving a ledger, each run inside the ledger's own storage
// transaction, so it happens whole or not at all. See docs/budget-design.md, "Sub-ledgers: when a budget's sub-ledger is
// deleted" and "Archives: past actuals stay true".
import type { Database, Logger } from '@tessera/types'
import type { ArchiveParticipant, SubLedgerParticipant } from '@tessera/ledger-api'
import { ACCOUNTS_PLUGIN_ID, type ArchivedTotal } from '@tessera/accounts-api'
import { isMonth } from '@tessera/budget-api'
import { collectionsOf, type ArchivedMonth, type ArchivedTransferEntry, type Collections } from './store'

/** Writing archived months lets the event loop turn every so many writes, as the accounts plugin's removal does. */
export const ARCHIVE_YIELD_EVERY = 2000

// ---- Sub-ledgers

/**
 * Deleting a sub-ledger moves everything in it to its parent; a budget over it moves too, and covers the parent from
 * then on. So do the archived months kept with it, as their own sub-ledger or as a transfer's other side. `moved`
 * hears which budgets moved out of which sub-ledger, to announce once the delete is known to be committed.
 */
export function budgetSubLedgerParticipant(db: () => Database, now: () => string, moved: (from: string, ids: string[]) => void): SubLedgerParticipant {
  return {
    describe: async subLedgerId => {
      const count = await collectionsOf(db()).budgets.count({ subLedgerId })
      return count === 0 ? undefined : `${count} budget${count === 1 ? '' : 's'}`
    },
    reparent: async (tx, from, to) => {
      const c = collectionsOf(tx)
      const budgets = await c.budgets.find({ subLedgerId: from })
      for (const budget of budgets) await c.budgets.updateOne({ id: budget.id }, { $set: { subLedgerId: to, updatedAt: now() } })
      for (const doc of await c.archivedMonths.find()) {
        const transfers: ArchivedMonth['transfers'] = Object.fromEntries(Object.entries(doc.transfers)
          .map(([id, e]): [string, ArchivedTransferEntry] => [id, e[3] === from ? [e[0], e[1], e[2], to] : e]))
        const changed = doc.subLedgerId === from || Object.values(doc.transfers).some(e => e[3] === from)
        if (changed) await c.archivedMonths.replace({ ...doc, subLedgerId: doc.subLedgerId === from ? to : doc.subLedgerId, transfers })
      }
      moved(from, budgets.map(b => b.id))
    }
  }
}

// ---- Archives

const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
const isOptionalId = (value: unknown): value is string | null => value === null || typeof value === 'string'

/** The accounts plugin's `removedTotals`, checked: another plugin's data, from its own copy of the package, is read defensively. */
export function readRemovedTotals(shared: unknown): { totals: ArchivedTotal[], skipped: number, missing: boolean } {
  const list = (shared as { removedTotals?: unknown } | null | undefined)?.removedTotals
  if (!Array.isArray(list)) return { totals: [], skipped: 0, missing: true }
  const totals = list.filter((t): t is ArchivedTotal => typeof t === 'object' && t !== null
    && typeof t.accountId === 'string' && isMonth(t.month) && isOptionalId(t.categoryId) && isOptionalId(t.transferAccountId)
    && isCount(t.inflow) && isCount(t.outflow) && isCount(t.count) && typeof t.currency === 'string' && isOptionalId(t.subLedgerId)
    && (t.transferSubLedgerId === undefined || isOptionalId(t.transferSubLedgerId)))
  return { totals, skipped: list.length - totals.length, missing: false }
}

/**
 * Adds what an archive removed to the archived months: one document per account and month, its totals by category and
 * by transfer account as entries, added to what an earlier archive kept for the same month. Reads the months already
 * kept once, then writes, letting the event loop turn every `ARCHIVE_YIELD_EVERY` writes.
 */
export async function addArchivedMonths(c: Collections['archivedMonths'], totals: readonly ArchivedTotal[], turn: () => Promise<void>): Promise<number> {
  const groups = new Map<string, ArchivedMonth>()
  for (const t of totals) {
    const key = `${t.accountId}|${t.month}`
    let doc = groups.get(key)
    if (!doc) groups.set(key, doc = { accountId: t.accountId, month: t.month, currency: t.currency, subLedgerId: t.subLedgerId, categories: {}, transfers: {} })
    if (t.transferAccountId !== null) {
      const e = doc.transfers[t.transferAccountId] ?? [0, 0, 0, t.transferSubLedgerId ?? null]
      doc.transfers[t.transferAccountId] = [e[0] + t.inflow, e[1] + t.outflow, e[2] + t.count, e[3]]
    } else {
      const key = t.categoryId ?? ''
      const e = doc.categories[key] ?? [0, 0, 0]
      doc.categories[key] = [e[0] + t.inflow, e[1] + t.outflow, e[2] + t.count]
    }
  }
  if (groups.size === 0) return 0
  const kept = new Map((await c.find()).map(d => [`${d.accountId}|${d.month}`, d]))
  let writes = 0
  for (const [key, doc] of groups) {
    const old = kept.get(key)
    if (old) {
      // A second archive of the same month: add to what the first kept. Where the account is now is the newer news
      const categories = { ...old.categories }
      for (const [k, e] of Object.entries(doc.categories)) { const o = categories[k] ?? [0, 0, 0]; categories[k] = [o[0] + e[0], o[1] + e[1], o[2] + e[2]] }
      const transfers = { ...old.transfers }
      for (const [k, e] of Object.entries(doc.transfers)) { const o = transfers[k]; transfers[k] = o ? [o[0] + e[0], o[1] + e[1], o[2] + e[2], e[3]] : e }
      await c.replace({ ...old, currency: doc.currency, subLedgerId: doc.subLedgerId, categories, transfers })
    } else {
      await c.insert(doc)
    }
    if (++writes % ARCHIVE_YIELD_EVERY === 0) await turn()
  }
  return writes
}

/**
 * File › Archive Ledger…: keeps the totals of what the accounts plugin removed (`AccountsArchived.removedTotals`), so no
 * past month's actual changes. It removes nothing, so it says nothing in the dialog (no description) or in the message
 * after it (a count of 0). `committed` runs once the archive is.
 */
export function budgetArchiver(deps: { turn?: () => Promise<void>, committed(): void, log: Pick<Logger, 'warn'> }): ArchiveParticipant {
  const turn = deps.turn ?? (() => new Promise<void>(resolve => setImmediate(resolve)))
  return {
    describe: async () => undefined,
    archive: async (tx, { earlier }) => {
      const shared = earlier.get(ACCOUNTS_PLUGIN_ID)
      const { totals, skipped, missing } = readRemovedTotals(shared)
      if (missing && shared !== undefined) deps.log.warn('[budget] The accounts plugin shared no removedTotals: the archived months\' actuals are not kept')
      if (skipped > 0) deps.log.warn(`[budget] Left out ${skipped} removed totals that weren't as accounts-api 1.13 describes`)
      await addArchivedMonths(collectionsOf(tx).archivedMonths, totals, turn)
      return { count: 0, summary: 'Nothing removed from budgets' }
    },
    committed: () => deps.committed()
  }
}
