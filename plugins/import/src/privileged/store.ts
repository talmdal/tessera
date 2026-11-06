// What the import plugin keeps in the ledger, in its own collections: each import (a batch), each bank line that
// wasn't a duplicate, saved account matches, payee aliases and formats' memory. See docs/import-manager-design.md,
// "Storage schema (import)".
import type { Collection, Database, Transaction } from '@tessera/types'
import type { ClearingStatus } from '@tessera/accounts-api'
import { IMPORT_COLLECTIONS, type AccountLink, type BankLine, type ImportCounts } from '@tessera/import-api'

/** One statement imported into one account. */
export interface StoredBatch {
  accountId: string
  fileName: string
  filePath?: string
  formatId?: string
  statementIndex: number
  importedAt: string
  /** 'applying' until the transactions are in the account and the lines point at them (see apply.ts). */
  state: 'applying' | 'applied' | 'undone'
  period?: { from?: string, to?: string }
  /** The bank's balance, in minor units, and its date. */
  bankBalance?: { amount: number, asOf: string }
  counts: ImportCounts
}

/** What a transaction was before a match was accepted, so Unmatch can put it back. */
export interface Before {
  date: string
  amount: number
  status: ClearingStatus
}

/**
 * A review change in progress, written before its `accounts` write and cleared after: if the write is interrupted,
 * which transaction carries the line's import id says whether it happened (see lineState.ts).
 */
export interface LineIntent {
  /** Who carries the import id once the write is done: nobody, this transaction, or a transaction the write creates. */
  carrier: { kind: 'none' } | { kind: 'id', id: string } | { kind: 'new' }
  /** The line once it is done. `transactionId` is filled in from the carrier for a transaction the write creates. */
  next: LineFields
}

/** The parts of a line a review changes. */
export interface LineFields {
  outcome: 'added' | 'matched' | 'skipped'
  review: 'pending' | 'done'
  transactionId?: string
  before?: Before
}

/**
 * A bank line that was imported (not a duplicate): recorded so it is never imported again, even once deleted.
 * - added: `transactionId` is the new transaction; `review` is 'pending' until the user accepts it.
 * - matched, proposed: `proposedId` is the transaction it may be, unchanged; `review` 'pending'.
 * - matched, accepted: `transactionId` carries the line; `before` is what Accept changed; `review` 'done'.
 * - matched with neither: unresolved, it lost its transaction; the user says where it goes.
 * - skipped: the user chose not to import it.
 */
export interface StoredLine extends LineFields {
  batchId: string
  accountId: string
  /** The bank's id for the line, or a fingerprint ('fp:…'): the transaction's externalId. Unique per account. */
  importId: string
  bank: BankLine
  /** A proposed match: the transaction the line may be. */
  proposedId?: string
  /** The proposal's score when it was made, 0 to 1. The register scores it again as the transaction is edited. */
  score?: number
  intent?: LineIntent
}

export type StoredLink = Omit<AccountLink, 'id' | 'rev'>

export interface StoredAlias {
  /** The bank's payee text, normalised. */
  pattern: string
  payeeName: string
  createdAt: string
  uses: number
}

export interface StoredMemory {
  formatId: string
  key: string
  value: unknown
}

export interface Collections {
  batches: Collection<StoredBatch>
  lines: Collection<StoredLine>
  links: Collection<StoredLink>
  aliases: Collection<StoredAlias>
  memory: Collection<StoredMemory>
}

/** The collections, read through the database or written through a transaction. */
export function collectionsOf(source: Database | Transaction): Collections {
  return {
    batches: source.collection<StoredBatch>(IMPORT_COLLECTIONS.batches),
    lines: source.collection<StoredLine>(IMPORT_COLLECTIONS.lines),
    links: source.collection<StoredLink>(IMPORT_COLLECTIONS.accountLinks),
    aliases: source.collection<StoredAlias>(IMPORT_COLLECTIONS.payeeAliases),
    memory: source.collection<StoredMemory>(IMPORT_COLLECTIONS.memory)
  }
}
