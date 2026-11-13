// What the recurring plugin stores in every book: the series, and what has already been done with each occurrence.
// Declared from phase 0 so the collections exist before the service that fills them.
import type { Migrator, SchemaContribution } from '@tessera/book-api'
import {
  RECURRING_COLLECTIONS, RECURRING_MIGRATOR_SERVICE, RECURRING_PLUGIN_ID, RECURRING_SCHEMA_VERSION
} from '@tessera/recurring-api'

export const RECURRING_SCHEMA: SchemaContribution = {
  id: RECURRING_PLUGIN_ID,
  version: RECURRING_SCHEMA_VERSION,
  migrator: RECURRING_MIGRATOR_SERVICE,
  collections: [
    {
      name: RECURRING_COLLECTIONS.series,
      indexes: [
        // The Recurring view's query: everything due, in order
        { name: 'byNextDate', fields: ['nextDate'] },
        // Cleaning up when an account is closed or deleted, and "what is scheduled in this account"
        { name: 'byAccount', fields: ['accountId', 'nextDate'] }
      ]
    },
    {
      name: RECURRING_COLLECTIONS.postings,
      indexes: [
        { name: 'bySeries', fields: ['seriesId', 'dueDate'] },
        // Sparse: only an entered posting has one. Finds the series behind a transaction
        { name: 'uniqueTransaction', fields: ['transactionId'], unique: true }
      ]
    },
    {
      // The book's holidays, which a business-day rule steps over. One per date
      name: RECURRING_COLLECTIONS.holidays,
      indexes: [{ name: 'uniqueDate', fields: ['date'], unique: true }]
    }
  ]
}

/**
 * Version 0 → 1: there is nothing to seed, so declaring the collections is the whole migration. It exists because
 * `SchemaContribution` requires one, and because version 2 will need it. Safe to run again.
 */
export const recurringMigrator: Migrator = {
  async migrate() {
    // Nothing to do: the collections are created from the schema when the book opens.
  }
}
