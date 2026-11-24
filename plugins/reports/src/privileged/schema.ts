// What the reports plugin stores in every ledger (ledger.schema): the user's saved reports. Figures are never stored:
// reports are worked out when shown. See docs/reporting-design.md, "Storage schema (`reports`)".
import type { Migrator, SchemaContribution } from '@tessera/ledger-api'
import { REPORTS_COLLECTIONS, REPORTS_MIGRATOR_SERVICE, REPORTS_PLUGIN_ID, REPORTS_SCHEMA_VERSION } from '@tessera/reports-api'

/** The unique index, named so a clash can be told apart (store.ts, `translate`). */
export const INDEXES = {
  savedName: 'uniqueName'
} as const

export const REPORTS_SCHEMA: SchemaContribution = {
  id: REPORTS_PLUGIN_ID,
  version: REPORTS_SCHEMA_VERSION,
  migrator: REPORTS_MIGRATOR_SERVICE,
  collections: [
    {
      name: REPORTS_COLLECTIONS.saved,
      indexes: [
        // Names are unique in the ledger, ignoring case
        { name: INDEXES.savedName, fields: ['nameKey'], unique: true },
        // Deleting a sub-ledger finds the saved reports over it
        { name: 'bySubLedger', fields: ['parameters.scope.subLedgerId'] }
      ]
    }
  ]
}

/** Version 0 → 1: nothing to seed. A ledger has no saved report until the user saves one. */
export const reportsMigrator: Migrator = {
  async migrate() {}
}
