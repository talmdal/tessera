# Design note: the storage engine (`storage.engine`)

| | |
|---|---|
| **Status** | Phases 1–4 implemented (contract, shared kit, memory engine, conformance suite, LokiJS and SQLite backends, `app-state` on the engine); phase 5 (vault integration) open. Supersedes the first `StorageEngine`, now `LegacyStorageEngine` in `tessera-types/storage-legacy.ts` |
| **Date** | 2026-10-30 |
| **Related** | [storage-api-design.md](storage-api-design.md) (the `Store` proposal this absorbs), [vault-design.md](vault-design.md), [settings-design.md](settings-design.md) |
| **Audience** | Authors of storage backends (LokiJS, SQLite…) and of plugins that store data (`app-state`, settings, vault, domain plugins) |

## Summary

`storage.engine` becomes a **document database service** in the MongoDB
style: an engine opens **named databases**, a database holds **named
collections**, a collection holds JSON documents with a string `id`.
Queries, updates and aggregations are **plain data** (a Mongo-like subset),
so any backend can answer them and they can be logged, tested and carried
over IPC.

- **Multiple databases.** `app` for framework state and settings, one per
  vault, scratch databases for caches. Each database is its own file and its
  own transaction scope, so a window-move that saves bounds no longer copies
  the ledger.
- **Pluggable backends.** A backend is one plugin implementing one
  interface, proven by a shared conformance suite. LokiJS first, SQLite
  next; an in-memory backend for tests.
- **Reporting.** A small aggregation pipeline (`$match`, `$group`, `$sort`,
  `$project`, `$lookup`) that SQLite pushes down to `SELECT … GROUP BY` and
  in-memory backends run through one shared interpreter.

This note folds the `Store` API of
[storage-api-design.md](storage-api-design.md) into the engine: what that
note calls a `Store` is a `Database` here, and the vault's `StorageHandle`
wraps one. Its decisions (documents with `id` and `rev`, queries as data,
first-class transactions, change events after commit, a conformance suite)
are kept.

## Problems with the current engine

Found by review of `plugins/storage.loki/`, `core/storage/`,
`plugins/app.state/` and their tests, and confirmed by running `lokijs`
1.5.12 directly.

| # | Problem | Where |
|---|---|---|
| 1 | **Committed transactions are never persisted, and the file is overwritten with stale data.** `beginTransaction` takes `db.copy()`, which `lokijs` builds as `new Loki(filename, { env: 'NA' })`: **no persistence adapter, autosave off**. `commit` then makes that copy the live database. Its `saveDatabase` fails with `persistenceAdapter not configured` (the callback ignores the error), and the *previous* database object keeps its autosave timer, so whatever it still holds (the pre-transaction state) is what lands in `tessera.json`. Every `AppState.set/update/remove` goes through a transaction, so after the first write in a session nothing reaches disk. **Patched** (2026-10-30): commit now loads the copy into the live instance and reports save errors; `tests/plugins/storage.loki/Persistence.test.ts` guards it. | `LokiStorageEngine.beginTransaction` / `commit` |
| 2 | **Lost updates between concurrent transactions.** Two `beginTransaction()` calls both copy the same base; the second `commit` replaces the first's result. Writers are not serialised. `useWindowState` fires a `set` on every `resize`/`move` event, so this is a realistic interleaving. **Patched** with 1: transactions are queued per engine. | same |
| 3 | **The whole store is cloned for every transaction.** One file, one Loki instance: a transaction copies every collection. Cheap today (12 ms for 100k docs), unacceptable once the vault lives in the same instance. **Fixed** in the new engine: per-collection overlays. | same |
| 4 | **Live internal objects leak across the API.** `insert` mutates the caller's object (adds `$loki` and `meta`); `get`/`getOne` return the objects Loki holds, so a caller that edits a result edits the store without an update, and re-inserting a returned object throws `Document is already in collection`. The tests strip `$loki, meta` everywhere, which is the symptom. **Fixed** in the new engine: envelopes and copies on the way out. | `LokiStorageEngine`, tests |
| 5 | **Function-valued queries in the contract.** `Query = object \| (doc) => boolean` can't cross IPC, can't be pushed to SQLite, and contradicts storage-api-design's decision that queries are data. The object form is untyped, so Loki's `$gt`/`$in` operators leak through unspecified. **Fixed** in phase 1: `Filter` is data; `scan()` covers the rest. | `tessera-types/storage.ts` |
| 6 | **No database or collection model.** Collections are created on first mention (a typo makes a new collection), there are no indexes, no unique constraints, no `rev`, no change events, no schema or versioning hook. **Fixed** in phase 1. | contract |
| 7 | **`TransactionManager` lives in core but is imported by a plugin** (`plugins/app.state` reaches into `core/storage/` by relative path). Plugins are supposed to be written against `@tessera/types` only; `tests/architecture` doesn't cover `plugins/`, so nothing caught it. Its helpers (`transactionalTransform`, `transactionalMove`) also forget to `await`, which only works because Loki is synchronous. **Fixed** in phase 3: deleted; the boundary test now covers `plugins/`. | `core/storage/TransactionManager.ts`, `AppStateStore.ts` |
| 8 | **`StorageEngineRegistry` is dead code**: nothing registers with it or calls it. **Fixed** in phase 3: deleted. | `core/storage/StorageEngineRegistry.ts` |
| 9 | **`AppState.get` writes.** A read with a default inserts the default, inside a transaction. A `__init__` sentinel document is inserted to force the collection to exist. `flush()` is a no-op that relies on autosave (see 1). **Fixed** in phase 3. | `AppStateStore.ts` |
| 10 | **Errors are swallowed**: `saveDatabase` callbacks ignore `err`; `rollback` failure masks the original error in `TransactionManager.run`; `console.log` of the whole plugin context on activation. **Fixed**: every path reports a `StorageError`; the plugins' `console.log` lines are gone. | various |
| 11 | **Tests are weak where it matters.** No persistence test (close and reopen), so 1 went unnoticed; `ShutdownLifecycle` spies on `close` and then calls `close`; no concurrency test; no `app-state` tests at all. **Fixed**: the conformance suite, both backends' file-level tests, `app-state` tests and the pipeline smoke test. | `tests/plugins/storage.loki/` |

## Goals and non-goals

**Goals**

- Several databases per engine, several collections per database; each
  database independently opened, flushed and closed.
- One backend interface small enough to implement in days, with LokiJS and
  SQLite as the first two, and an in-memory one for tests.
- Queries, updates and aggregations as plain data; no SQL and no functions
  in the contract.
- Atomic multi-write transactions, serialised writers, change events after
  commit.
- Aggregation that SQLite can push down and in-memory backends can run.
- No Loki (or SQLite) artefacts visible to callers.

**Non-goals**

- A general query language. The operators below are the whole set; a
  backend rejects anything else with `UNSUPPORTED_QUERY`.
- Joins across databases. `$lookup` works within one database only; there
  is no requirement to link databases.
- Streaming result sets. The planned data size doesn't need it; `find`
  returns arrays, `findPage` pages, `scan` batches.
- Encryption (an encrypting Loki adapter or SQLCipher) and blobs such as
  receipt images. Both fit the `Database` model unchanged and are left for
  later; blobs would live beside the database file, outside this contract.
- Sync, replication, multi-process access.
- Very large data: the working assumption is still a personal ledger
  (rarely above one million documents in total).

## Concepts

```
StorageEngine  (service 'storage.engine'; one provider, e.g. storage-loki)
  └── Database  ('app', 'vault:/path/Home.tvault', …)  one file each
        ├── Collection  ('state', 'accounts.transactions', …)
        │     ├── documents  { id, rev, …json }
        │     └── indexes    declared per collection
        ├── transaction(work)        atomic, serialised per database
        └── onDidChange(listener)    after commit
```

- **Engine.** Opens databases by name or path. Exactly one plugin provides
  `storage.engine`; which one is a deployment choice (see *Pluggable
  backends*).
- **Database.** A unit of persistence, locking and transactions. Opened by a
  *name* (stored under `<userData>/storage/<name>.<ext>`) or by an explicit
  *path* (a vault file the user chose).
- **Collection.** Named set of documents. Names are namespaced by the
  owning plugin (`accounts.transactions`) as storage-api-design requires;
  the engine doesn't enforce ownership, the vault does.
- **Document.** JSON-serialisable, `id: string` (ULID from `engine.newId()`
  unless the caller supplies one), `rev: number` maintained by the engine.
- **Index.** Declared per collection (`fields`, `unique`). Backends must
  honour `unique`; they may use the rest as hints. Unlike storage-api-design,
  queries are **not restricted** to indexed fields: at the planned scale a
  scan in Loki or SQLite is fine, and the restriction would make ad-hoc
  reporting impossible. Backends may report slow paths through `explain`.
- **Transaction.** `database.transaction(work)`: atomic, rolled back if
  `work` throws, writers serialised per database.

## Contract

The contract is the code: [tessera-types/storage.ts](../tessera-types/storage.ts)
(types, with the semantics in comments) and
[tests/storage/conformance.ts](../tests/storage/conformance.ts) (the same
semantics as tests). In outline:

```
StorageEngine   id, capabilities(), open(target, options), list(), drop(target), newId(), closeAll()
Database        collection(name), listCollections(), createCollection(schema), dropCollection(name),
                renameCollection(from, to), transaction(work), onDidChange(listener), meta, flush(), close()
Transaction     collection(name)
Collection      get, getMany, findOne, find, findPage, count, scan
                insert, insertMany, replace, updateOne, updateMany, deleteOne, deleteMany
                aggregate
                ensureIndex, dropIndex, indexes, explain
```

Documents returned are **copies**: editing one has no effect until it is
written back. `id` and `rev` are the only fields the engine adds; no `$loki`,
`meta`, `rowid` or other backend fields appear.

Semantics settled while implementing phase 1, beyond what the type comments
say:

- **Order.** `find` without `sort` is id order; any sort ends with `id`
  ascending as a tie-break, so results and page cursors are deterministic.
  Across types the order is missing < null < boolean < number < string <
  array < object; comparison operators (`$gt`…) apply only between values of
  the same type, so `{ v: { $lt: 100 } }` never matches a string, null or a
  missing field.
- **Equality is whole-value.** `{ tags: 'a' }` does not match an array
  containing `'a'` (MongoDB would); use `$contains`. `{ address: { city } }`
  matches only exactly that object; use `'address.city'` for a field in it.
- **`rev` moves only when content changes.** An update that leaves the
  document equal reports `modified: 0`, keeps `rev`, and fires no event.
- **Unique indexes are sparse**: a document missing any indexed field is
  not entered, so optional `externalId`s don't collide. A present `null`
  counts as a value.
- **Index changes are not transactional.** `ensureIndex` and `dropIndex`
  inside `transaction()` are INVALID_ARGUMENT.
- **Writes outside a running transaction** (through `db.collection(...)`
  rather than `tx.collection(...)`) are applied immediately; if the
  transaction wrote the same collection it fails with CONFLICT at commit,
  so neither write is silently lost. Collections the transaction only read
  are not checked.
- **Upsert documents** are the filter's top-level equalities (including
  `$eq` and dotted paths) with the update applied.
- **`$project`** keeps `id` (or `_id` after `$group`) unless excluded; those
  two are the only fields that may be excluded alongside inclusions.
- **`$cond`** takes `[filter, then, else]`, the filter applied to the
  current document, rather than a boolean expression.
- **Page cursors** encode the sort-key values of the last item; a cursor
  made with one sort is rejected with another.
- `Database.meta` is a plain key/value store, not transactional, for
  schema versions and similar bookkeeping.

### Filters

A data-only subset of the MongoDB query language. Field paths may be dotted
(`'address.city'`). Comparison is by JSON type; strings compare lexically,
which is why dates are stored as ISO strings.

```ts
type FieldFilter = { [field: string]: Json | Operators }

interface Operators {
  $eq?: Json; $ne?: Json
  $gt?: Json; $gte?: Json; $lt?: Json; $lte?: Json
  $in?: Json[]; $nin?: Json[]
  $exists?: boolean
  /** Pattern as a string (not a RegExp), optional flags. */
  $regex?: string; $options?: string
  /** Array field contains the value. */
  $contains?: Json
}

/**
 * Full-text search, as a top-level filter key like $and/$or. Emulated today
 * as case-insensitive whole-word matching of every term over the named
 * fields; a backend with a text index (SQLite FTS5) answers it natively and
 * reports `textSearch: 'native'`. Ranking is not part of the contract.
 */
type TextFilter = { $text: { $search: string, $fields: string[] } }
type Filter = FieldFilter | { $and: Filter[] } | { $or: Filter[] } | { $not: Filter } | TextFilter

type Sort = { [field: string]: 1 | -1 }
```

Examples:

```ts
{ accountId: 'a1', date: { $gte: '2026-01-01', $lt: '2026-02-01' } }
{ $or: [{ category: 'rent' }, { amount: { $in: [100, 300] } }] }
{ payee: { $regex: '^amazon', $options: 'i' } }
{ $text: { $search: 'amazon refund', $fields: ['payee', 'memo'] } }
```

An operator **outside this list** is rejected with `UNSUPPORTED_QUERY`;
nothing is silently ignored. An operator *inside* the list that the backend
can't push down is emulated by the shared evaluator (fetch candidates with
the rest of the filter, then apply the remaining operators in memory), so a
filter never fails because of the backend it runs on.

### Updates

```ts
interface Update {
  $set?: { [field: string]: Json }
  $unset?: { [field: string]: true }
  $inc?: { [field: string]: number }
  $push?: { [field: string]: Json }
  $pull?: { [field: string]: Json }
}
```

`rev` is incremented by every write and can't be set. A plain object without
`$` keys is rejected (`INVALID_UPDATE`) rather than treated as `$set`, so
"replace" and "patch" can't be confused.

### Aggregation

The reporting surface. A pipeline is an array of stages; each backend either
evaluates it natively (SQLite: one `SELECT` per pipeline, `$group` becomes
`GROUP BY`, `$lookup` a `LEFT JOIN` on `json_extract`) or runs the shared
interpreter over `scan()` (LokiJS, memory).

```ts
type Stage =
  | { $match: Filter }
  | { $project: { [field: string]: 0 | 1 | Expression } }
  | { $group: { _id: Expression | null, [output: string]: Accumulator | Expression | null } }
  | { $sort: Sort }
  | { $skip: number }
  | { $limit: number }
  | { $unwind: string }                                          // '$splits'
  | { $lookup: { from: string, localField: string, foreignField: string, as: string } }
  | { $count: string }

type Expression =
  | `$${string}`                                                 // field reference: '$amount', '$account.name'
  | Json                                                         // literal (objects/arrays are literals unless they hold an operator)
  | { $substr: [Expression, number, number] }                    // '$date' → '2026-01' for month buckets
  | { $concat: Expression[] }
  | { $add: Expression[] } | { $subtract: [Expression, Expression] }
  | { $multiply: Expression[] } | { $divide: [Expression, Expression] }
  | { $abs: Expression } | { $ifNull: [Expression, Expression] }
  | { $cond: [Filter, Expression, Expression] }                 // the filter is applied to the current document
  | { $year: Expression } | { $month: Expression }               // on ISO date strings

type Accumulator =
  | { $sum: Expression } | { $avg: Expression } | { $min: Expression } | { $max: Expression }
  | { $count: {} } | { $first: Expression } | { $last: Expression } | { $push: Expression }
```

Examples the reports plugin will need:

```ts
// Spending by category for a month
tx.aggregate([
  { $match: { date: { $gte: '2026-01-01', $lt: '2026-02-01' }, amount: { $lt: 0 } } },
  { $group: { _id: '$categoryId', total: { $sum: '$amount' }, count: { $count: {} } } },
  { $sort: { total: 1 } }
])

// Monthly net flow per account, with the account name
tx.aggregate([
  { $project: { accountId: 1, amount: 1, month: { $substr: ['$date', 0, 7] } } },
  { $group: { _id: { account: '$accountId', month: '$month' }, net: { $sum: '$amount' } } },
  { $lookup: { from: 'accounts.accounts', localField: '_id.account', foreignField: 'id', as: 'account' } },
  { $unwind: '$account' },
  { $sort: { '_id.month': 1, 'account.name': 1 } }
])

// Running balance is *not* a pipeline feature: fetch ordered rows and accumulate in the plugin.
```

The set is deliberately closed. If a report needs more, the options are
(a) extend this list with something every backend can do, or (b) compute
in the plugin from `find`/`scan`. Never a backend-specific escape hatch.

### Errors

`StorageError` with a stable `code`:

| Code | Meaning |
|---|---|
| `NOT_OPEN` | The database is closed |
| `READ_ONLY` | Opened read-only |
| `CONFLICT` | `expectedRev` didn't match |
| `DUPLICATE_ID` | `insert` with an existing `id` |
| `UNIQUE_VIOLATION` | A write would duplicate a unique index key (includes the index name) |
| `UNKNOWN_COLLECTION` | Collection doesn't exist and `autoCreate` is off (see below) |
| `UNSUPPORTED_QUERY` | Operator or stage the backend can't evaluate |
| `INVALID_DOCUMENT` | Not JSON-serialisable, non-string `id`, field name starting with `$` or containing `.` |
| `INVALID_UPDATE` | Update without operators, unknown operator, wrong type for `$inc`/`$push`, or touching `id`/`rev` |
| `NOT_FOUND` | `replace` of a missing document without `upsert`; `renameCollection` of a missing collection is `UNKNOWN_COLLECTION` |
| `INVALID_ARGUMENT` | Malformed options: a bad sort direction, negative limit, mixed projection, bad cursor, index change inside a transaction |
| `IO` | Backend or file failure, with `cause` |

### Collection creation

`database.collection(name)` returns a handle without touching storage. The
first write creates the collection unless the database was opened with
`schema` (then unknown names are rejected with `UNKNOWN_COLLECTION`). The
`app` database is opened with `autoCreate`; vaults are opened with the
declared schema, which is what stops a typo creating a collection.

## Configuration tiers

Where the application remembers something depends on *when it is needed*.
Anything read before plugins activate cannot be stored through a plugin,
and `storage.engine` is a plugin: a "which storage backend" or "which
plugins are enabled" key in `app.state` would need storage to find out
which storage to use. So there are three tiers, each readable without the
one above it:

| Tier | Owner | Lives in | Read | Holds |
|---|---|---|---|---|
| **0 · Bootstrap** | shell | `<userData>/tessera-bootstrap.json`, plain JSON, read synchronously ([shell/main/bootstrap/bootstrapConfig.ts](../shell/main/bootstrap/bootstrapConfig.ts)) | before any plugin activates | `disabledPlugins`, `preferredPlugins` — the choices that shape activation |
| **1 · Application state and settings** | `app-state` (later `settings`) | the `app` database through `storage.engine` | after activation | theme, window bounds, recent files, last vault, user settings |
| **2 · Financial data** | vault | a user-chosen file | when the user opens it | accounts, transactions…; the backend is chosen **per file** by `vault.backends` descriptors and `sniff` ([vault-design.md](vault-design.md)), never by a setting |

Tier 0 is deliberately tiny and boring: two arrays of plugin ids. A
missing file is defaults; an unreadable or malformed one is logged and
ignored, so it can never stop startup. `preferredPlugins` moves those
plugins to the front of the activation order, and since the first provider
of a contested service wins, that is how the active storage backend is
chosen (`["storage-sqlite"]`); `disabledPlugins` leaves plugins out
entirely. A settings page may *edit* tier 0 later, but the edit takes
effect at the next start, as with Eclipse's `config.ini` or VS Code's
`argv.json`. The rule, in one line: **bootstrap configuration never lives
behind what it configures.**

Pinning `app-state` to one backend was considered and rejected: it would
not remove the need for tier 0 (an enabled-plugins list would still be
circular), it would make `app-state` depend on an implementation id rather
than `storage.engine`, and Loki's buffered saves are the weaker choice for
window and theme state anyway.

## Pluggable backends

The framework allows one provider per service id and orders activation by
`requires`. Two cases:

1. **The application's default store** (`app` database: state, settings,
   caches). Exactly one plugin provides `storage.engine`. Today that is
   `storage-loki`; a `storage-sqlite` plugin would provide the **same id**,
   and which one is bundled decides. Two installed at once: the first
   discovered wins and the other is skipped with a warning, which is the
   framework's existing rule. `app-state` keeps `requires: ["storage.engine"]`
   and is untouched by the swap. With both bundled, `preferredPlugins` in
   the tier-0 bootstrap file chooses (see *Configuration tiers*). This is
   "pluggable" in the Eclipse sense: the id names the interface, the plugin
   supplies the implementation.

2. **Per-file choice** (vaults). Several backends may be installed and the
   user's file decides. That is the descriptor + service pattern from
   [vault-design.md](vault-design.md): each backend plugin contributes a
   `vault.backends` descriptor and provides `<plugin>.backend`, whose
   `open(path)` returns a `Database` from this note. The vault's
   `StorageHandle.store` is a `Database`.

A backend plugin therefore implements one class, `XxxStorageEngine`, and
exposes it both ways: `context.services.provide(id, 'storage.engine', engine)`
if it's the default, and as `<plugin>.backend` with a descriptor for vaults.
Core's unused `StorageEngineRegistry` is deleted; `TransactionManager` is
deleted too, since `database.transaction` replaces it and plugins mustn't
import core.

### Backend strategies

| | LokiJS (`storage-loki`) | SQLite (`storage-sqlite`) | Memory (tests) |
|---|---|---|---|
| Database | One `Loki` instance and one file per database, `<dir>/<name>.loki.json` (or the path given) | One file per database, `<dir>/<name>.sqlite` (or the path given), over `node:sqlite` (bundled with Node and Electron, synchronous, **no native module to rebuild** — settling the packaging question from vault-design.md), WAL mode | `Map`s |
| Collection | Loki collection of envelopes `{ id, doc }` with `unique: ['id']`, so Loki's `meta`/`$loki` never touch the document and `by('id')` serves `get`. Declared indexes are stored in a `__tessera.collections` collection | Three fixed tables, so collection names never become SQL identifiers: `tessera_documents (collection, id, doc)`, `tessera_collections (name, indexes)`, `tessera_meta (key, value)`. Each collection cached in memory on first touch; every write mirrored to its row | `Map<id, doc>` |
| Filter | Shared evaluator over the collection's documents (Loki's own operators have different semantics, e.g. loose equality, and are not used) | Shared evaluator over the cache. Pushing filters down to `json_extract` `WHERE` clauses is a later optimisation behind the same capability flags | Shared evaluator |
| Transaction | The kit's copy-on-write overlay per collection (`MapStore` snapshot of the envelopes' documents); commit writes the touched ids back into the Loki collection. **No `db.copy()`.** | The kit's overlay; every committed operation's mirror writes (including a multi-collection transaction's) are one `BEGIN IMMEDIATE … COMMIT`, so a crash mid-operation leaves the previous state | Overlay |
| Aggregate, `$regex`, `$text` | Shared interpreter and evaluator (`'emulated'`) | Shared interpreter and evaluator (`'emulated'`); native `GROUP BY` pushdown and FTS5 are later optimisations | Shared interpreter |
| Persistence | Buffered: a save 500 ms after the last change (`saveDelay`), through `LokiFsAdapter`, which writes `<file>~` then renames; `flush()` saves now; `close()` flushes. A failed save is an `IO` error from `flush`/`close` and logged from the timer, and the data stays in memory marked dirty | **Write-through**: durable at each operation's return, nothing to flush, no loss window | none |
| Uniqueness, `rev` | Kit's unique maps; `rev` in the document | Same (declared indexes are definitions; the kit enforces) | Same |
| `Database.meta` | `__tessera.meta` collection | `tessera_meta` table | `Map` |

The **shared pieces** live in core under `core/storage/` as platform-free
code, exported together from `core/storage/index.ts`:

- the evaluators: filter, update, sort, projection, cursor, aggregation,
  document validation, ULID, `StorageError`;
- the **kit**: `KitDatabase` (transactions, conflict detection, change
  events, auto-create and read-only rules) and `KitCollection` (every
  `Collection` method) over a small `DocumentStore` interface (documents by
  id, index declarations, unique maps, a version counter) and a
  `DatabaseBackend` interface (where stores and meta live, when to save).

A backend therefore writes two classes: a `DocumentStore` over its
collection and a `DatabaseBackend` over its database, plus the engine's
`open`/`list`/`drop`. The memory engine is ~100 lines on top of the kit and
the Loki backend ~300; both pass the same suite because the semantics are
in the kit. Bundled backend plugins reach it through
the `@core` alias at build time; when a backend is written outside the repo
the kit should be published as a package (`@tessera/storage-kit`), which is
a packaging step, not a design change.

## Conformance suite

`tests/storage/conformance.ts` exports `describeStorageEngine(name, () =>
Promise<StorageEngine>)`, and every backend's test file is one line. It is
the contract. It must cover, beyond what storage-api-design lists:

- **persistence**: write, `close`, reopen through a fresh engine, read
  back (this is the test that would have caught problem 1);
- **two databases** are independent: a transaction in one doesn't see,
  block or copy the other;
- **serialised writers**: two concurrent `transaction()` calls on one
  database both commit and neither's writes are lost;
- **returned documents are copies** without backend fields; mutating a
  result doesn't change the store;
- every filter operator, every update operator, every stage and
  accumulator, with the same expected rows on every backend;
- `$regex` and `$text` give the same rows whether native or emulated
  (the suite runs the same cases against every backend and the memory
  backend is the reference);
- `UNSUPPORTED_QUERY` for an unknown operator, `INVALID_UPDATE` for a bare
  object;
- change events once per transaction, after commit, not on rollback;
- `findPage` cursors remain correct when rows are inserted before the
  cursor;
- for buffered backends, a failure during `flush` leaves the previous file
  intact.

## `app-state` on the new engine

As implemented in `plugins/app.state/src/privileged/AppStateStore.ts`:

```ts
const db = await engine.open({ name: 'app' })
const state = db.collection<{ id: string, value: Json }>('app-state.entries')

get(key)            → state.get(key)?.value         // never writes; the default is returned, not stored
set(key, value)     → state.replace({ id: key, value }, { upsert: true })
update(key, patch)  → db.transaction(tx => read, merge, replace)
remove(key)         → state.deleteOne({ id: key })
flush()             → db.flush()                    // from onShuttingDown; the engine closes in deactivate()
```

`useWindowState` saves 250 ms after the last resize or move. Later,
`db.onDidChange` can push changes to other windows. The `app` database is
the natural home for
[settings-design.md](settings-design.md) as well (`settings.values`
collection), so one file holds everything "application", separate from any
vault.

## Decisions

1. **Engine → Database → Collection**, one file per database. This is the
   fix for "everything in one file" and for transaction cost.
2. **Mongo-like, data-only queries, updates and aggregation**, closed
   operator sets, `UNSUPPORTED_QUERY` rather than silent scans or silent
   ignores. Function predicates are gone.
3. **Queries aren't restricted to indexes.** Indexes are declared for
   uniqueness and speed; `explain` exposes the plan. Reverses
   storage-api-design on this point, for the sake of reporting.
4. **Aggregation is part of the engine contract**, with a shared interpreter
   so every backend supports it; SQLite pushes it down. Answers
   storage-api-design's open question 1.
5. **One `storage.engine` provider at a time**, swapped by bundling a
   different plugin; per-file choice goes through `vault.backends`.
6. **Transactions are overlay-based and serialised per database**, never a
   whole-store copy.
7. **Conformance suite is the contract**; backends are one-line test files.
8. **Capabilities describe speed, not availability.** Every operator, stage
   and `$text` works on every backend; the shared kit emulates what a
   backend lacks, and `capabilities()` reports `'native'` or `'emulated'`.

## Settled questions

| Question | Decision |
|---|---|
| Cross-database `$lookup` | No. Databases are independent; reference data a report needs lives in the same database as the facts. |
| Streaming `find` results | Not needed at the planned data size. `findPage` and `scan` cover large reads. |
| Full-text search | `$text` is in the contract now. Emulated as word matching over a scan; SQLite FTS5 later, behind `textSearch: 'native'`. Callers don't change. |
| Encrypted-file backend | Not required yet. Either an encrypting Loki adapter or SQLCipher can be added as a backend without touching the contract. |
| Blobs (receipt images) | Out of scope; future work beside the database file. |

## Suggested phases

1. **Contract + shared kit + memory backend + conformance suite.** *Done.*
   Types in `tessera-types/storage.ts`; evaluator, update applier,
   aggregation interpreter, sort, projection, cursors, ULID and errors in
   `core/storage/` (exported together from `core/storage/index.ts`);
   `MemoryStorageEngine` in `core/storage/memory/`; the suite in
   `tests/storage/conformance.ts`, run against the memory engine by
   `tests/storage/memory.test.ts`.
2. **LokiJS backend** on the contract. *Done.*
   `plugins/storage.loki/src/privileged/LokiStorageEngine.ts`: one instance
   and file per database, envelopes, the kit's overlay transactions,
   debounced atomic save; runs the suite plus file-level tests in
   `tests/plugins/storage.loki/LokiStorageEngine.test.ts`. The plugin
   provides it as `storage.engine`.
3. **`app-state` moved** to the `app` database. *Done.* `AppStateStore`
   keeps one document per key in `app-state.entries`; `get` no longer
   writes its default; `useWindowState` saves 250 ms after the last
   resize or move. Tests in `tests/plugins/app.state/`. `TransactionManager`,
   `StorageEngineRegistry`, `LegacyLokiStorageEngine`,
   `tessera-types/storage-legacy.ts` and `storage.engine.legacy` are
   deleted; `tests/architecture` now forbids plugins importing `core/` or
   `shell/` except `@core/storage`. No migration of the old
   `storage/tessera.json`: it is left in place and ignored. The storage
   plugin closes its databases in `deactivate()`, which the plugin manager
   runs after every dependent has deactivated, rather than in
   `onShuttingDown`, where it would run before `app-state`'s flush.
4. **SQLite backend.** *Done.*
   `plugins/storage.sqlite/src/privileged/SqliteStorageEngine.ts` on
   `node:sqlite`, so there is no native module and the packaging question
   from vault-design.md is settled by not arising. Write-through, with each
   committed operation one SQL transaction; semantics entirely from the kit
   (`aggregate/regex/textSearch: 'emulated'`). Runs the conformance suite
   plus file-level tests in `tests/plugins/storage.sqlite/`, and
   `tests/plugins/pipeline.smoke.test.ts` builds both backends through the
   real plugin pipeline and shows one `storage.engine` provider winning and
   the other skipped with a warning, per the one-provider rule. Native
   pushdown of filters and `$group` (and FTS5 for `$text`) is deliberately
   deferred: at the planned scale the cache-plus-kit path costs
   milliseconds, pushdown risks semantic drift against the suite, and the
   capability flags already leave room to flip per feature. `node:sqlite`
   is marked experimental in Node 22 (a warning on first use) and stable
   beyond; a swap to `better-sqlite3` would be contained in this one file.
5. **Vault integration**: `vault.backends` descriptors return `Database`
   handles; schema application and migrations via `database.meta`.
