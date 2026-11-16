// What the budget plugin stores in every ledger (ledger.schema), and how its data is brought up to date.
import type { Migrator, SchemaContribution } from '@tessera/ledger-api'
import { BUDGET_COLLECTIONS, BUDGET_MIGRATOR_SERVICE, BUDGET_PLUGIN_ID, BUDGET_SCHEMA_VERSION } from '@tessera/budget-api'

/** The unique indexes, named so a clash can be told apart (store.ts, `translate`). */
export const INDEXES = {
  budgetName: 'uniqueName',
  lineCategory: 'uniqueCategory',
  lineAccount: 'uniqueAccount',
  archivedMonth: 'uniqueAccountMonth'
} as const

export const BUDGET_SCHEMA: SchemaContribution = {
  id: BUDGET_PLUGIN_ID,
  version: BUDGET_SCHEMA_VERSION,
  migrator: BUDGET_MIGRATOR_SERVICE,
  collections: [
    {
      name: BUDGET_COLLECTIONS.budgets,
      indexes: [
        // Names are unique in the ledger, ignoring case
        { name: INDEXES.budgetName, fields: ['nameKey'], unique: true },
        { name: 'bySubLedger', fields: ['subLedgerId'] }
      ]
    },
    {
      name: BUDGET_COLLECTIONS.lines,
      indexes: [
        // Sparse: a category line has no target.accountId and a transfer line no target.categoryId, so each index
        // holds one kind of line, and a budget has at most one line per category and one per other account
        { name: INDEXES.lineCategory, fields: ['budgetId', 'target.categoryId'], unique: true },
        { name: INDEXES.lineAccount, fields: ['budgetId', 'target.accountId'], unique: true }
      ]
    },
    // One document per account and month: what archives removed, totalled (docs/budget-design.md, Phase B0 results)
    { name: BUDGET_COLLECTIONS.archivedMonths, indexes: [{ name: INDEXES.archivedMonth, fields: ['accountId', 'month'], unique: true }] }
  ]
}

/** Version 0 → 1: nothing to seed. A ledger has no budget until the user makes one. */
export const budgetMigrator: Migrator = {
  async migrate() {}
}
