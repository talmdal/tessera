// What the accounts plugin stores in every book, and how its data is brought up to date.
import type { Migrator, SchemaContribution } from '@tessera/book-api'
import {
  ACCOUNTS_COLLECTIONS, ACCOUNTS_MIGRATOR_SERVICE, ACCOUNTS_PLUGIN_ID, ACCOUNTS_SCHEMA_VERSION, accountNameKey
} from '@tessera/accounts-api'

export const ACCOUNTS_SCHEMA: SchemaContribution = {
  id: ACCOUNTS_PLUGIN_ID,
  version: ACCOUNTS_SCHEMA_VERSION,
  migrator: ACCOUNTS_MIGRATOR_SERVICE,
  collections: [
    {
      name: ACCOUNTS_COLLECTIONS.accounts,
      indexes: [
        { name: 'bySubBook', fields: ['subBookId', 'order'] },
        // Names are unique in the whole book, ignoring case: transfers are shown as "Transfer to: Savings"
        { name: 'uniqueName', fields: ['nameKey'], unique: true }
      ]
    },
    {
      name: ACCOUNTS_COLLECTIONS.transactions,
      indexes: [
        { name: 'byAccountDate', fields: ['accountId', 'date'] },
        { name: 'byTransfer', fields: ['transferId'] },
        { name: 'byPayee', fields: ['payeeId', 'date'] },
        { name: 'byCategory', fields: ['categoryId', 'date'] },
        // Sparse: only imported transactions have one; a re-import of the same statement line is refused
        { name: 'uniqueExternalId', fields: ['accountId', 'externalId'], unique: true }
      ]
    },
    { name: ACCOUNTS_COLLECTIONS.payees, indexes: [{ name: 'uniqueName', fields: ['nameKey'], unique: true }] },
    { name: ACCOUNTS_COLLECTIONS.categories, indexes: [{ name: 'uniqueName', fields: ['parentId', 'nameKey'], unique: true }] },
    {
      name: ACCOUNTS_COLLECTIONS.reconciliations,
      indexes: [
        { name: 'byAccount', fields: ['accountId', 'startedAt'] },
        // Sparse: set only while in progress, so an account has at most one reconciliation under way
        { name: 'oneActive', fields: ['activeFor'], unique: true }
      ]
    }
  ]
}

/** The categories a new book starts with: income, then expenses, each a parent with its children. */
export const STARTER_CATEGORIES: { kind: 'income' | 'expense', name: string, children?: string[] }[] = [
  { kind: 'income', name: 'Salary' },
  { kind: 'income', name: 'Interest' },
  { kind: 'income', name: 'Dividends' },
  { kind: 'income', name: 'Gifts received' },
  { kind: 'income', name: 'Other income' },
  { kind: 'expense', name: 'Housing', children: ['Rent', 'Mortgage interest', 'Property tax', 'Home insurance', 'Maintenance'] },
  { kind: 'expense', name: 'Utilities', children: ['Electricity', 'Heating', 'Water', 'Internet', 'Phone'] },
  { kind: 'expense', name: 'Food', children: ['Groceries', 'Dining out'] },
  { kind: 'expense', name: 'Transportation', children: ['Fuel', 'Public transit', 'Car insurance', 'Car maintenance', 'Parking'] },
  { kind: 'expense', name: 'Health', children: ['Medical', 'Dental', 'Pharmacy'] },
  { kind: 'expense', name: 'Personal', children: ['Clothing', 'Personal care'] },
  { kind: 'expense', name: 'Entertainment' },
  { kind: 'expense', name: 'Gifts and donations' },
  { kind: 'expense', name: 'Education' },
  { kind: 'expense', name: 'Childcare' },
  { kind: 'expense', name: 'Travel' },
  { kind: 'expense', name: 'Bank fees' },
  { kind: 'expense', name: 'Interest paid' },
  { kind: 'expense', name: 'Taxes' },
  { kind: 'expense', name: 'Miscellaneous' }
]

/**
 * Version 0 → 1: seeds the starter categories. Safe to run again: a category that is already there is left alone.
 * (Books are expected to start fresh with this version, so there is no earlier accounts data to convert.)
 */
export const accountsMigrator: Migrator = {
  async migrate(db, from) {
    if (from !== 0) return
    await db.transaction(async tx => {
      const categories = tx.collection<{ parentId: string | null, name: string, nameKey: string, kind: string }>(ACCOUNTS_COLLECTIONS.categories)
      const ensure = async (parentId: string | null, name: string, kind: string) => {
        const existing = await categories.findOne({ parentId, nameKey: accountNameKey(name) })
        return existing ?? categories.insert({ parentId, name, nameKey: accountNameKey(name), kind })
      }
      for (const { kind, name, children = [] } of STARTER_CATEGORIES) {
        const parent = await ensure(null, name, kind)
        for (const child of children) await ensure(parent.id, child, kind)
      }
    })
  }
}
