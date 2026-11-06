// What the import plugin stores in every ledger (ledger.schema), and how its data is brought up to date.
import type { Migrator, SchemaContribution } from '@tessera/ledger-api'
import { IMPORT_COLLECTIONS, IMPORT_MIGRATOR_SERVICE, IMPORT_PLUGIN_ID, IMPORT_SCHEMA_VERSION } from '@tessera/import-api'

export const IMPORT_SCHEMA: SchemaContribution = {
  id: IMPORT_PLUGIN_ID,
  version: IMPORT_SCHEMA_VERSION,
  migrator: IMPORT_MIGRATOR_SERVICE,
  collections: [
    {
      name: IMPORT_COLLECTIONS.batches,
      indexes: [{ name: 'byAccount', fields: ['accountId', 'importedAt'] }, { name: 'byState', fields: ['state'] }]
    },
    {
      name: IMPORT_COLLECTIONS.lines,
      indexes: [
        // A bank line is recorded once per account, so it is never imported twice, even after its transaction is deleted
        { name: 'uniqueLine', fields: ['accountId', 'importId'], unique: true },
        { name: 'byReview', fields: ['accountId', 'review'] },
        { name: 'byTransaction', fields: ['transactionId'] },
        { name: 'byBatch', fields: ['batchId'] }
      ]
    },
    { name: IMPORT_COLLECTIONS.accountLinks, indexes: [{ name: 'uniqueKey', fields: ['key'], unique: true }, { name: 'byAccount', fields: ['accountId'] }] },
    { name: IMPORT_COLLECTIONS.payeeAliases, indexes: [{ name: 'uniquePattern', fields: ['pattern'], unique: true }] },
    { name: IMPORT_COLLECTIONS.memory, indexes: [{ name: 'uniqueKey', fields: ['formatId', 'key'], unique: true }] }
  ]
}

/** Version 0 → 1: nothing to seed; the collections are created when the ledger opens. */
export const importMigrator: Migrator = {
  async migrate() {}
}
