# Design note: the storage API (`Store`)

| | |
|---|---|
| **Status** | Proposed, not implemented |
| **Date** | 2026-10-16 |
| **Settles** | Open question 1 of [vault-design.md](vault-design.md): what `Store` looks like |
| **Audience** | Authors of storage backends (SQLite, encrypted file…) and of domain plugins (accounts, budgets…) |

## Summary

`Store` is a **collection/document API with declared indexes, atomic
transactions and change events**.

- Domain plugins store JSON documents in named collections and query them
  only through indexes they declare in their schema.
- Backends implement one small interface and prove it by passing a shared
  **conformance suite**, so a new backend needs no changes elsewhere.
- Nothing about the API is finance-specific. It sits below the domain, in
  line with the vault design's rule that the vault knows nothing about
  accounts.

## Goals and non-goals

**Goals**

- Work identically over a database backend (SQLite) and a load-everything
  file backend (encrypted JSON).
- Be small enough that a backend takes days, not weeks, to write.
- Give domain plugins atomic multi-write operations (imports, transfers).
- Let the UI react to data changes without polling.
- Make backend differences (write-through versus buffered) invisible to
  domain code, apart from the vault's dirty/save flow.

**Non-goals**

- Not a general query language or SQL. Reports that need joins and
  aggregates are a later, separate concern (see open question 1).
- Not a sync protocol. Records carry a revision so sync is possible later.
- Not for very large data. The working assumption is a personal ledger:
  tens of thousands of transactions, rarely above one million records in
  total.

## Why a document API

| Option | Verdict |
|---|---|
| **Collections of documents + declared indexes** | **Chosen.** Maps cheaply onto SQLite (a table per collection with a JSON column plus index columns) and onto an in-memory map for file backends. Plugins evolve their record shapes through migrations they own. |
| Relational API (tables, SQL) | Natural for reports, but every backend must then speak SQL or emulate it, and plugins can see each other's tables. Too heavy a contract for the file backend. |
| Plain key/value | Trivial to implement, but every plugin would re-implement indexing and querying. |
| Event sourcing | Good for audit and sync, but a large conceptual cost and slow reads without projections. Better layered on top by a plugin if wanted. |

## Concepts

- **Collection:** a named set of documents. Names are namespaced by the
  owning plugin id (`accounts.transactions`), so two domains can't collide.
  The schema contribution says who owns what.
- **Document:** a JSON-serialisable object with a string `id`. The store
  adds a numeric `rev`, incremented on every write.
- **Index:** a declared, named set of fields, optionally unique. Queries and
  ordering work only through indexes. This is what lets every backend
  answer them efficiently.
- **Transaction:** a group of reads and writes that commit together or not
  at all.

## Contract (sketch)

TypeScript sketches, refined when implemented. JavaScript plugins follow the
same shapes.

```ts
type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
type Doc = { id: string, [field: string]: Json }
type Stored<T extends Doc> = T & { rev: number }

interface Store {
  collection<T extends Doc = Doc>(name: string): Collection<T>
  /** Runs `work` atomically. Rolls back if it throws. Writers are serialised. */
  transaction<R>(work: (tx: Transaction) => Promise<R>): Promise<R>
  /** A new sortable unique id (ULID). */
  newId(): string
  readonly onDidChange: Event<ChangeEvent>
}

interface Transaction {
  collection<T extends Doc = Doc>(name: string): Collection<T>
}

interface Collection<T extends Doc> {
  get(id: string): Promise<Stored<T> | undefined>
  getMany(ids: string[]): Promise<(Stored<T> | undefined)[]>
  /** Insert or replace. With `expectedRev`, fails with CONFLICT if the stored rev differs. */
  put(doc: T, options?: { expectedRev?: number }): Promise<Stored<T>>
  delete(id: string, options?: { expectedRev?: number }): Promise<boolean>
  query(query: Query): Promise<Page<Stored<T>>>
  count(filter?: Filter): Promise<number>
  /** Full scan, for rare whole-collection work (migrations, exports). Streams, never loads all at once. */
  scan(): AsyncIterable<Stored<T>>
}

interface ChangeEvent {
  collection: string
  kind: 'put' | 'delete'
  ids: string[]
}
```

Change events fire **after commit**, once per committed transaction per
collection, never for rolled-back work.

### Queries

Queries are plain data, so they are testable, loggable and
backend-independent.

```ts
interface Query {
  /** Index to use. Omit to order by id. */
  index?: string
  /** Conditions on the indexed fields, in index order. */
  where?: Filter
  direction?: 'asc' | 'desc'
  limit?: number
  /** Opaque cursor from a previous page. */
  after?: string
}

/** Equality on leading index fields, then an optional range on the next one. */
type Filter = { [field: string]: Json | { gte?: Json, lte?: Json, gt?: Json, lt?: Json, in?: Json[] } }

interface Page<T> { items: T[], next?: string }
```

For an index on `[accountId, date]`, `{ accountId: 'a1', date: { gte: '2026-01-01' } }`
is valid, because equality constrains the leading field and the range
applies to the next one. A query that isn't satisfiable by the named index
is rejected with `UNSUPPORTED_QUERY`, rather than silently scanning.

Pagination is by cursor, not offset, so it stays correct while data changes.

For one-off needs the index can't express (say, text search in memos), a
plugin runs `scan()` and filters in code. That is deliberate: services are
in-process, so a predicate in plugin code is fine, and it keeps the
**contract** free of function-valued queries.

### Errors

A `StoreError` with a stable `code`:

| Code | Meaning |
|---|---|
| `NOT_OPEN` | No vault is open |
| `CONFLICT` | `expectedRev` didn't match |
| `UNIQUE_VIOLATION` | A write would duplicate a unique index key |
| `UNSUPPORTED_QUERY` | The query isn't answerable from the named index |
| `UNKNOWN_COLLECTION` | The collection isn't declared in any schema |
| `READ_ONLY` | The vault was opened read-only |
| `INVALID_DOCUMENT` | Missing or non-string `id`, or not JSON-serialisable |

## Schema declaration

This refines the `SchemaDescriptor` sketched in
[vault-design.md](vault-design.md), replacing its `collections: string[]`:

```ts
interface SchemaDescriptor {
  id: string                          // 'accounts.schema'
  version: number                     // current schema version of this contributor
  collections: CollectionSchema[]
  migrator: string                    // service id implementing Migrator
}

interface CollectionSchema {
  name: string                        // must start with the plugin id: 'accounts.transactions'
  indexes: { name: string, fields: string[], unique?: boolean }[]
}
```

Example for accounts:

```js
context.extensions.contribute('vault.schema', {
  id: 'accounts.schema', version: 1, migrator: 'accounts.migrator',
  collections: [
    { name: 'accounts.accounts', indexes: [{ name: 'byName', fields: ['name'], unique: true }] },
    { name: 'accounts.transactions', indexes: [
      { name: 'byAccountDate', fields: ['accountId', 'date'] },
      { name: 'byExternalId',  fields: ['accountId', 'externalId'], unique: true }
    ] }
  ]
})
```

- The vault validates ownership (the collection name starts with the
  contributor's plugin id) and creates or updates the indexes when a vault
  is created or migrated.
- Only declared collections can be used, and a plugin sees only the
  collections it owns **or** names explicitly through a service it requires
  (for example, reports reading through `accounts.service`, not directly).
- **Adding an index** is a migration: backends build it from existing
  documents. Removing one is also a migration.

### Migrations

```ts
interface Migrator {
  /** Upgrades this contributor's data from `from` to `from + 1`. Runs inside one transaction. */
  migrate(store: MigrationStore, from: number): Promise<void>
}

interface MigrationStore extends Store {
  renameCollection(from: string, to: string): Promise<void>
  dropCollection(name: string): Promise<void>
}
```

The vault takes a backup first (`shell.files.backup`), runs each migration
in a transaction, and records the new version in the file. If a migration
throws, the transaction rolls back, the vault stays closed, and the backup
is left in place.

## Backend contract

A backend turns the declared schema plus its file into a `Store`:

```ts
interface StorageHandle {
  readonly store: Store
  /** Applies declared collections and indexes; called on create and after migrations. */
  applySchema(schema: CollectionSchema[]): Promise<void>
  /** Versions of each schema contributor stored in the file. */
  schemaVersions(): Promise<Record<string, number>>
  setSchemaVersion(contributor: string, version: number): Promise<void>
  flush(): Promise<void>      // no-op for write-through backends
  close(): Promise<void>
}
```

(`StorageBackend.create/open/sniff` are as in the vault design note.)

Two implementation strategies cover the planned backends:

| Backend | Strategy | Write model |
|---|---|---|
| **SQLite** | One table per collection (`id`, `rev`, `doc` JSON). Each declared index becomes expression or generated columns plus a SQL index. Transactions map to SQL transactions. | Write-through |
| **Encrypted file** | Load everything into memory at open. Collections are maps; each index is a sorted structure built at load. Transactions apply to a copy-on-write overlay, then swap in on commit. `flush` serialises, encrypts and writes atomically through `shell.files`. | Buffered: commit marks the vault dirty |

For buffered backends, a committed transaction calls back so the vault can
set `vault.isDirty`. That is the only place the vault's save flow touches
storage.

## Conformance suite

Every backend must pass one shared test suite (to live under
`tests/storage/`, exported for backends to import). It is the real contract.
It covers:

- put/get/delete round trips and `rev` increments;
- `expectedRev` conflicts;
- unique-index violations, including inside a transaction;
- query semantics: equality, ranges, `in`, direction, `limit`, cursors that
  stay correct after inserts, and rejection of unsupported queries;
- atomicity: a throwing transaction leaves no partial writes, and a
  concurrent reader sees only committed state;
- change events: once per transaction, only after commit, none on rollback;
- persistence: close and reopen returns the same data and indexes;
- schema application, adding an index over existing data, and version
  bookkeeping;
- a crash simulation for file backends: a failure during `flush` leaves the
  previous file intact.

The in-memory backend used for domain-plugin tests is the first
implementation, and it keeps the suite honest.

## Conventions for domain plugins

The store doesn't enforce these; the docs and review should.

- **Money as integer minor units** (cents) plus a currency code, never
  floats.
- **Dates as ISO strings** (`2026-10-16`, or full timestamps in UTC) so
  string order equals time order and range queries work.
- **IDs from `store.newId()`** (ULIDs), which are sortable and need no
  coordination. Imported records keep a stable `externalId` with a unique
  index to make re-imports idempotent.
- **Soft facts stay in documents; relationships are ids.** There are no
  foreign keys. The domain plugin owns referential integrity and does
  related writes in one transaction.
- **Keep documents small and flat.** A transaction is one document; a split
  has its own records or a bounded array inside the transaction document.

## Decisions this design makes

1. **Document model with declared indexes**, not relational or key/value.
2. **Queries are data**; arbitrary predicates are available only through
   `scan()`, in-process.
3. **Optimistic concurrency via `rev`**, plus serialised writers, so a single
   writer is the rule within one vault.
4. **Transactions are first-class** (answering open question 7 of the vault
   design note), so imports and transfers are atomic on every backend.
5. **Schema ownership by name prefix**, validated by the vault, with indexes
   declared in the contribution so the contribution stays plain data.
6. **A conformance suite is part of the contract.**

## Open questions

1. **Reports and aggregation.** `query` and `scan` cover registers and
   lookups. Totals over time ranges and category breakdowns over 100k+
   transactions may need a query/aggregate service, which would let SQLite
   push `SUM ... GROUP BY` down while the file backend aggregates in
   memory. Defer until reports exist? *Leaning: yes. Specify the aggregate
   contract when the reports plugin needs it.*
2. **Multi-field ordering across collections.** Cross-collection joins are
   out of scope. Is "domain plugin joins in code" acceptable at the planned
   scale, or do we need denormalised read models?
3. **Full-text search** (payees, memos). Index declaration with a
   `type: 'text'`, or a separate search plugin over `scan()`?
4. **Document size and attachments** (receipt images). Store large blobs
   beside the vault rather than in documents? This probably needs a blob
   interface on `shell.files` or the backend.
5. **Revision semantics for sync.** Is a per-document `rev` enough, or do we
   need tombstones and vector clocks if cloud sync ever arrives?
6. **Validation.** Should schema contributions optionally include a JSON
   Schema per collection, so the backend can reject malformed documents
   regardless of which plugin wrote them?
7. **Read-only handles and concurrent readers.** Do plugins ever need a
   consistent snapshot while writers run (for example, a long report during
   an import)? Snapshot isolation is easy in the overlay model and in SQLite
   (WAL), but needs a `store.snapshot()` in the contract.

## Suggested phases

1. **Contract and in-memory backend:** types, `StoreError`, the in-memory
   store, and the conformance suite, with no files involved.
2. **Vault integration:** `vault.session.store`, schema validation and
   application, migrations with backup, and dirty tracking.
3. **Encrypted-file backend:** load, overlay transactions, atomic flush.
   This proves the contract against a buffered backend first, with no
   native module.
4. **SQLite backend:** run the same suite; settle the native-module and
   packaging question (vault design, open question 4) here.
5. **Accounts schema and migrator**, the first real consumer. Revisit open
   questions 1 and 3 with real queries in hand.
