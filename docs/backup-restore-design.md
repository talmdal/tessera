# Design note: book backup and restore

| | |
|---|---|
| **Status** | **Phases 0–2 done**: `Database.snapshot()`/`load()` ([Taking a snapshot](#taking-a-snapshot)), the stable book id ([Book identity](#book-identity)), `shell.files.showFolderDialog` ([Contracts](#contracts)), the backup file with its disk port ([The backup file](#the-backup-file)), and automatic backups on close ([As built](#automatic-backups-as-built)). Phase 3 (the Backups options page) is next. Open questions all answered 2026-11-19 |
| **Date** | 2026-11-19 |
| **Scope** | Keeping a whole book safe: automatic backups taken when a book closes, on a schedule the user chooses; backups on demand; restoring a backup over the open book or as a new book; the Backups options page that controls it |
| **Builds on** | [account-manager-design.md](account-manager-design.md) ("The book"), [account-manager-implementation.md](account-manager-implementation.md) (`BookSessionImpl`, `disk.ts`, migrations), [storage-engine-redesign.md](storage-engine-redesign.md) (the kit, backends, atomic batches), [options-framework-design.md](options-framework-design.md) (`context.options`, `shell.options.pages`) |
| **Delivers** | A backup file format (`.tessera-backup`); `snapshot()`/`load()` on the storage contract; `shell.files.showFolderDialog`; in the `book` plugin: a backup scheduler, writer, reader, pruner and restorer, three File menu commands, a Restore dialog and a Backups options page |
| **Supersedes** | The *backup* parts of [vault-design.md](vault-design.md) (`vault.backup`, `shell.files.backup`) and the backup example in [settings-design.md](settings-design.md) |

- [Summary](#summary)
- [Context](#context)
- [Goals and non-goals](#goals-and-non-goals)
- [Decisions](#decisions)
- [Where it lives](#where-it-lives)
- [The backup file](#the-backup-file)
- [Taking a snapshot](#taking-a-snapshot)
- [Book identity](#book-identity)
- [Options](#options)
- [The Backups options page](#the-backups-options-page)
- [Automatic backups](#automatic-backups)
- [Backing up on demand](#backing-up-on-demand)
- [Retention](#retention)
- [Restore](#restore)
- [Failures and how they are reported](#failures-and-how-they-are-reported)
- [Contracts](#contracts)
- [Alternatives considered](#alternatives-considered)
- [Open questions](#open-questions)
- [Later](#later)
- [Phases](#phases)

## Summary

- **A backup is a single engine-neutral file**, `<Book> <date time>.tessera-backup`:
  a gzip-compressed stream of JSON lines with a readable header, every
  collection with its indexes and documents, the book's meta, and a closing
  checksum. It is not a copy of the `.tessera` file. A backup taken under
  SQLite restores under LokiJS, and the reverse.
- **Automatic backups happen when a book closes**, whether by *Close Book*,
  opening another book, or quitting. They happen at most as often as the user
  asks: *every time the book closes*, *once a day*, *once a week* or *once a
  month*. **A book that has not changed since its last backup is never backed
  up again.**
- **Closing never waits on a backup.** The data is copied from memory
  (`Database.snapshot()`, a consistent view taken between commits) before the
  book flushes. The backup file is written after the book has closed, to a
  temporary name that is renamed into place only when it is complete.
- **The user chooses where backups go and how many to keep** on a new
  *Tools › Options › Book › Backups* page. This is the first plugin consumer
  of the options framework, as that note planned. The default folder is
  `Documents/Tessera Backups`.
- **The frequency is a minimum gap, not a quota.** A book closed after a week
  away gets one backup, not seven. Nothing is backed up at startup or when a
  book opens. A failed backup is retried at the next close.
- **Old automatic backups are pruned** to the newest *n* for each book, by
  moving them to the Trash. Where the drive has no Trash, they are deleted.
  Manual backups and safety copies taken before a restore are never pruned.
- **Restore never merges.** It either **replaces the open book**, after a
  safety backup of it is taken and the old file is moved to the Trash, or it
  **creates a new book** from the backup. In both cases the backup is
  verified in full and written to a temporary file first. The result is
  opened through the normal *Open* path, so an older backup is migrated like
  any older book, and one written by a newer Tessera is refused like any newer
  book.
- **It belongs to the `book` plugin.** Only the book holds the unscoped
  database, serialises file operations and knows how to close, replace and
  reopen the file. Domain plugins need no changes: they already rebuild
  themselves on `opened` and `closed`.

## Context

What exists today:

- **A book is one file** (`.tessera`). The active storage engine (SQLite or
  LokiJS, chosen in `tessera-bootstrap.json`) writes it. `BookSessionImpl`
  refuses to open a file written by the other engine
  (`ENGINE_FILE_KIND`). SQLite keeps `-wal` and `-shm` side files beside it
  while the file is open.
- **A pre-migration copy already exists.** `BookSessionImpl.backup()` copies
  the file and its side files to `<name>.backup-<stamp>.tessera` beside the
  book before a migration changes existing data
  ([`BookSessionImpl.ts`](../plugins/book/src/privileged/BookSessionImpl.ts)).
  It is a raw copy, taken while the file is closed, for one purpose. This
  design keeps it and does not reuse it (see
  [Alternatives](#alternatives-considered)).
- **The kit keeps the whole database in memory.** `KitDatabase` loads every
  collection at open, answers every query from memory, and gives the backend
  one atomic batch per commit
  ([`database.ts`](../packages/storage-kit/database.ts)). A consistent copy
  of a whole book therefore costs one pass over in-memory maps, taken under
  the commit lock. Loading a book from such a copy is one atomic
  `backend.commit`.
- **Options exist.** `context.options.register` (synchronous, versioned,
  validated) and the `shell.options.pages` extension point are done. The
  options note named *a book Backups page* as the first consumer
  ([options-framework-design.md](options-framework-design.md#phase-3--page-hosting-and-the-edit-lifecycle)).
- **Export is explicitly not backup.** The import/export note keeps
  QIF/OFX/CSV for handing data to other programs. Every one of those formats
  loses something, and that note defers "keeping a book whole" to separate
  work ([import-export-design.md](import-export-design.md)). This is that work.
- **Shutdown has a 10-second limit** for `onShuttingDown` listeners
  ([`AppLifecycle.ts`](../core/lifecycle/AppLifecycle.ts)). After that the
  shell carries on without them. A backup on quit must fit inside that limit,
  and it must never hold up the book's own flush. LokiJS buffers writes, so a
  flush that never runs loses data.
- **`shell.files` has no folder picker.** It has `showOpenDialog`
  (`openFile`) and `showSaveDialog`
  ([`electronFiles.ts`](../shell/main/dialogs/electronFiles.ts)).

## Goals and non-goals

**Goals**

- A user who never opens the options dialog still has recent backups of every
  book they use.
- A backup is complete: every collection in the book, including those of
  plugins that are not installed right now, plus meta and index definitions.
  Restoring it gives back exactly what was there.
- A backup can be identified (book, date, how it was made, what is in it)
  without being restored, and a damaged or truncated one is detected before
  anything is changed.
- Restoring can never leave the user with less than they had. The book being
  replaced is backed up first and moved to the Trash, not deleted.
- Closing a book and quitting stay as fast as they are today.
- Backups survive engine changes and Tessera upgrades. Old backups restore
  into newer versions through the existing migrations.

**Non-goals (for now)**

- **Partial restore** (one account, one sub-book, one date range).
- **Merging** a backup into an existing book.
- **Encryption** of backups. A backup is as readable as the book itself.
- **Periodic backups while a book stays open** for a long time. See
  [Later](#later).
- **Cloud or network targets** beyond "a folder the OS can write to". A
  folder synced by Dropbox, OneDrive or iCloud already works.
- **Per-book backup settings.** Backup options are application-wide until
  the options framework has `scope: 'book'`.
- **Backing up options or application state** (`tessera-options.json`,
  `app` database). They are not part of a book.

## Decisions

| # | Decision | Why |
|---|---|---|
| 1 | **A logical backup file, not a copy of the book file** | Engine-neutral, consistent while the book is open, self-describing, checksummed. See [The backup file](#the-backup-file) and [Alternatives](#alternatives-considered) |
| 2 | **Backups are taken from an in-memory snapshot**, before the book flushes and closes, and written afterwards | Closing never waits for compression or disk I/O. LokiJS's flush is never delayed past the shutdown limit |
| 3 | **"Frequency" means "at most once per period, when the book closes"**, and only if the book changed | Matches the request ("frequency of backups when the book is closed"). It never piles up identical backups of a book the user only looked at |
| 4 | **Backup bookkeeping lives in `app.state`, not in the book** | Writing "last backed up" into the book on close would itself be a change. A restored copy would carry a stale stamp. The folder is per machine, and so is the schedule |
| 5 | **Each book gets a stable id** (`ledger.bookId` in its meta) | Backups can be grouped and pruned per book even when two books share a name, and a book keeps its backups when it is renamed or moved |
| 6 | **Restore never overwrites in place.** It writes to a temporary file, verifies, then swaps; the replaced book is safety-backed-up and trashed | A failure at any step leaves the original reachable |
| 7 | **Restore opens the result through `BookSession.open`** | Migrations, newer-version refusal, recent-books handling and every plugin's `opened` handling all come for free and stay in one place |
| 8 | **Only automatic backups are pruned**, and only files whose header Tessera can read and that belong to the same book. Pruned files go to the Trash, and are deleted only where the drive has none | Pruning can never remove a backup the user made on purpose, a different book's backup, or a file Tessera did not write. A pruned backup can still be recovered wherever the OS allows it |
| 9 | **A user-chosen folder is never created**; the default folder is | An unmounted USB drive on Linux or macOS leaves its mount point as an empty directory. Creating the path would quietly write the backup to the internal disk |
| 10 | **It is built into the `book` plugin**, not a new plugin | See [Where it lives](#where-it-lives) |
| 11 | **Missed periods are never made up.** One close gives at most one automatic backup | A book closed after seven days away with `daily` gets one backup. Seven would all hold the same data |
| 12 | **No backup is ever started at startup or when a book opens.** A failed or interrupted backup is retried at the next close | Opening is when the user is waiting, and the request was for backups when the book closes (open question D) |

## Where it lives

The `book` plugin, in a new `privileged/backups/` folder:

```
plugins/book/src/
├── privileged/
│   ├── backups/
│   │   ├── backupFile.ts     write/read .tessera-backup (streams), header, trailer, checksum
│   │   ├── schedule.ts       isBackupDue(): pure, no clock of its own
│   │   ├── naming.ts         file names, sanitising, timestamps
│   │   ├── BackupDisk.ts     port: list folder, read header, write-then-rename, unlink, stat
│   │   ├── BackupLedger.ts   per-book bookkeeping in app.state
│   │   ├── Backups.ts        take / write / verify / prune; the backup queue; the shutdown budget
│   │   ├── Restorer.ts       inspect, stage, verify, swap, reopen
│   │   └── options.ts        the `book` options namespace: defaults, validate
│   ├── BookSessionImpl.ts    + snapshot(), restore hooks (runs inside `serial`)
│   └── …
└── renderer/
    ├── BackupsOptionsPage.tsx
    └── RestoreDialog.tsx
```

Why not a separate `backup` plugin requiring `book.session`?

- The backup needs the **unscoped** database. Contributors only ever see a
  `scopedDatabase` limited to their own prefix, and that is deliberate.
- Restore must close the book, replace its file and reopen it **inside the
  session's `serial` queue**, so a concurrent *Open* cannot run between the
  steps. Exposing that from `book.session` would publish the session's
  internals as a contract.
- The book already owns the `BookDisk` port, the side-file rules, the probe
  and the migration plan that restore depends on.

The **Backups** contract types (`BackupInfo`, `BookBackupOptions`, commands,
dialogs) go in `@tessera/book-api` with the rest of the book's protocol. A
`book.backups` service for other plugins is in [Later](#later).

## The backup file

*Naming:* this note says **backup file** for the `.tessera-backup` format and
its code (`backupFile.ts`). *Archive* is kept for the separate archive feature
in [Later](#later), which may reuse this format but is a different thing.

### Format

One file, `.tessera-backup`, a **gzip stream** (`node:zlib`, no new
dependency) of **UTF-8 JSON lines**, in this order:

```jsonc
// 1. Header: always the first line, so listing backups reads only the first few KB
{ "kind": "tessera-backup", "version": 1,
  "book": { "id": "01JD…", "name": "Home Finances", "path": "/home/…/Home Finances.tessera" },
  "takenAt": "2026-11-19T18:42:10.512Z",
  "trigger": "auto",                         // "auto" | "manual" | "pre-restore"
  "app": "book 0.1.0", "engine": "storage-sqlite",
  "bookFormat": 1,                           // BOOK_FORMAT_VERSION
  "schemaVersions": { "accounts": 3, "recurring": 2, "exchange": 1 },
  "counts": { "collections": 14, "documents": 48211, "meta": 9 } }

// 2. Meta, one line per key
{ "t": "meta", "key": "ledger.format", "value": 1 }

// 3. Per collection: its definition, then its documents
{ "t": "collection", "name": "accounts.transactions", "indexes": [ … ] }
{ "t": "doc", "c": "accounts.transactions", "doc": { "id": "01J…", "rev": 4, … } }

// 4. Trailer: always the last line
{ "t": "end", "documents": 48211, "sha256": "<hex digest of every byte of lines 1..n-1>" }
```

- **Readable header, streamable body.** The restore dialog and the pruner
  decompress only until the first newline. Writing and verifying are streams,
  so no second full-size string is built in memory.
- **Completeness is proven by the trailer.** A file with no `end` line, a
  document count that differs, or a digest that does not match is *damaged*
  and is refused before anything is changed.
- **Everything in the book, not just what installed plugins declare.** The
  snapshot is the database's own contents, so a collection belonging to a
  plugin that is currently disabled is still backed up and restored
  verbatim. This is the same rule migrations already follow for absent
  contributors.
- **`version` is the backup file format** (`BACKUP_FILE_VERSION`), independent of `bookFormat` and the
  contributors' `schemaVersions`. A reader refuses a `version` it does not
  know, with "made by a newer Tessera".
- **The original path is recorded** only to suggest where *Restore as new
  book* should put the file. It is never used to write anywhere without the
  user confirming.

### Reading, and what is refused

*Built (phase 1)*, in
[`backups/backupFile.ts`](../plugins/book/src/privileged/backups/backupFile.ts).

| Function | Reads | Use |
|---|---|---|
| `readBackupHeader` | Only up to the first newline (at most 1 MB), then stops and closes the file | Listing a folder, pruning |
| `verifyBackup` | Everything, keeping nothing | After writing; before a restore |
| `readBackup` | Everything, returning the `DatabaseSnapshot` | Restore |
| `restoreProblem` | The header only | Whether *this* Tessera can restore it, as text for the dialog |

Failures are `BookError`s, so the IPC can pass them on as results:

- **`UNSUPPORTED_FILE`**, "This is not a Tessera backup." The file is not
  gzip, its first line is not JSON, or its `kind` is not `tessera-backup`. Or
  "made by a newer version of Tessera", for a backup file `version` newer than
  this one. That check comes before the rest of the header is looked at,
  because a newer format may have changed its shape.
- **`DAMAGED`**, "This backup is damaged and can't be used: …", for a file
  that starts as a backup but is wrong after that. Each cause has its own
  reason:
  - cut off after any line, or part-way through one;
  - any value changed (digest mismatch);
  - a document missing or added (trailer count);
  - counts that don't match the header, even with a re-signed trailer;
  - lines out of order, or a collection or meta key twice;
  - an unknown line kind;
  - anything after the trailer;
  - a header that is ours but incomplete;
  - compressed bytes cut off or corrupted.

  Whether a decompression error means *damaged* or *not a backup* is decided
  by the gzip signature (`1f 8b`), not by whether any output appeared first.
  A small file decompresses in one piece, so a corrupt byte fails before any
  output exists.
- An I/O error from the file itself (for example `EIO`) is passed on as it
  is, not reported as damage.
- `restoreProblem` follows `planMigrations`' rule: a newer `bookFormat`, or
  any *installed* contributor whose data in the backup is newer than it
  understands, is refused. A contributor whose plugin isn't installed is
  fine.

### File names

`<Book name> <YYYY-MM-DD HH.mm.ss>[ (manual)| (before restore)].tessera-backup`,
local time, no colons (Windows). Characters that Windows, macOS or Linux reject
in a file name are replaced in the book name, and a trailing dot or space is
dropped (the rules `checkDatabaseName` enforces). Names collide only within the
same second. The writer then appends ` (2)`, and it never overwrites: it
renames into a name only after checking it is free. Backups are written one at
a time within Tessera, so only another running copy of Tessera could take the
name in between.

The name is for people. **Tessera identifies a backup by its header**, never
by its name, so a user who renames a backup loses nothing.

### Writing

1. Stream the snapshot through gzip into `<final name>.<random>.partial` in
   the target folder. The random part means a `.partial` file left by a crash
   never collides with a new one.
2. `fsync` and close (the write stream's `flush` option, Node 21+), then
   `rename` to the first free final name, then `fsync` the folder where the
   platform allows it.
3. **Verify** (except under the shutdown budget, see below): re-read the
   file, check the trailer and digest. A failure deletes the file and reports
   the backup as failed. A backup that has never been read back is not
   trusted.
4. On any error, or when abandoned at shutdown, the `.partial` file is
   deleted. A leftover `.partial` from a crash is ignored by listing and
   removed by the next prune.

## Taking a snapshot

*Built (phase 0).* Two methods on the storage contract
([`tessera-types/storage.ts`](../tessera-types/storage.ts)), implemented once,
in `KitDatabase` ([`database.ts`](../packages/storage-kit/database.ts)), so
every engine has them:

```ts
export interface CollectionSnapshot {
  name: string
  indexes: Required<IndexDefinition>[]
  docs: Doc[]                       // with id and rev, in id order
}

export interface DatabaseSnapshot {
  collections: CollectionSnapshot[] // in name order
  meta: Record<string, Json>
}

interface Database {
  /** Everything committed so far, between commits; works read-only; the result is the caller's copy. */
  snapshot(): Promise<DatabaseSnapshot>
  /** Fills an empty database from a snapshot, checked in full first, as one atomic write. */
  load(snapshot: DatabaseSnapshot): Promise<void>
}
```

- **`snapshot()`** holds the commit lock only while it takes references out
  of the `CollectionState` maps. Stored documents are never mutated in place:
  `CollectionState` already relies on that to share them between a state and
  its clone. So the deep copy is made *after* the lock is released and still
  copies one consistent state. A transaction still running is not in the
  snapshot. Collections, documents and meta keys come out sorted, so two
  snapshots of the same data are identical.
- **`load()`** needs a database that holds **no collection and no meta
  value**. Opening the target with a `schema` would create collections, so
  restore opens it without one. Before anything is written it checks the
  whole snapshot as strictly as ordinary writes are checked:
  - collection names, including the reserved `__tessera` prefix;
  - index definitions;
  - every document's JSON validity and field names;
  - `id` and `rev` (a whole number, at least 1);
  - duplicate ids and unique keys.

  A bad snapshot fails with `INVALID_ARGUMENT`, `INVALID_DOCUMENT`,
  `DUPLICATE_ID` or `UNIQUE_VIOLATION`, and nothing is written. A good one
  becomes one `StorageChange[]` handed to `backend.commit` once: one
  `BEGIN IMMEDIATE … COMMIT` on SQLite, one atomic save on LokiJS. If the
  backend refuses it, the database stays empty and can be loaded again.
  Documents keep their `rev`. Listeners hear one change event.
- **Meta values** are copied the way `meta.set` stores them, which is laxer
  than document validation (a meta value may contain `$` or `.` keys). So
  anything `meta.set` accepted loads back.
- **`scopedDatabase` rejects both** with `BookError('INVALID')`, as it
  already rejects `close()`. Only the book may copy or replace the whole book.
- The index type is the public `Required<IndexDefinition>` that
  `Collection.indexes()` already returns, not storage-kit's `IndexSpec`, so
  the contract does not leak the kit.
- **Tests:** a `snapshot and load` block in the storage conformance suite
  ([`tests/storage/conformance.ts`](../tests/storage/conformance.ts)), 35
  cases run on memory, SQLite and LokiJS. Kit-level tests with a recording,
  failing backend ([`tests/storage/snapshot.test.ts`](../tests/storage/snapshot.test.ts))
  cover one batch per load and an empty database after a refused one. The
  book's session tests cover `scopedDatabase` refusing both.

## Book identity

*Built (phase 0)*, in
[`BookSessionImpl.ts`](../plugins/book/src/privileged/BookSessionImpl.ts).
`BOOK_META.id = 'ledger.bookId'`, and every `BookInfo` now carries it as `id`.

- **`create()`** writes a new ULID (`engine.newId()`) along with the other
  creation metadata.
- **`open()`** gives a book that has no id one, after its migrations and
  before it is attached. This is a single meta write, not a migration: no
  data changes, so no pre-migration copy is taken. It is logged at info
  level. From then on the id stays the same across closing, reopening,
  renaming and moving the file.
- **Any non-empty string is kept** as the id, not only a ULID, so an id
  carried in from a restored backup is never rewritten. A stored value that
  is unusable (empty, blank, not a string) is replaced with a new ULID, with
  a warning.
- **A read-only book with no id** can't be written. It is known as
  `path-<32 hex>`, the SHA-256 of its resolved path (case-folded on Windows
  and macOS, as the recent-books list compares paths), until it is opened
  writable and given a real id. Today the session always opens books
  writable, so this is a safeguard rather than a path anyone takes yet. The
  tests reach it by making the engine open read-only.
- *Phase 5, not built yet:* **Replace the open book** keeps the id that is
  already in the backup. The book is the same book, so its backups stay one
  group. **Restore as new book** gives the result a fresh id and records
  `ledger.restoredFrom: { bookId, takenAt }`, so the copy's automatic
  backups never prune the original's.

## Options

Registered by the `book` plugin through `context.options` (namespace `book`):

```ts
export interface BookOptions {
  backups: {
    /** Back up automatically when a book closes. */
    automatic: boolean                                        // true
    /** The most often an automatic backup is taken. */
    frequency: 'everyClose' | 'daily' | 'weekly' | 'monthly'  // 'daily'
    /** Absolute folder path; null = <Documents>/Tessera Backups. */
    folder: string | null                                     // null
    /** Automatic backups kept per book; older ones go to the Trash (or are deleted where there is none). */
    keep: number                                              // 10 (1–999)
  }
}
```

- `validate`: `frequency` is one of the four values, `keep` is an integer in
  range, and `folder` is `null` or an absolute path. **Whether the folder
  exists is not validated.** A drive may be unplugged when the user presses
  Apply and plugged in by the time a backup runs. That is checked, and
  reported, at backup time.
- `onDidChange`: nothing needs rescheduling, because the schedule is
  evaluated at each close. The page's status line refreshes.
- *Never* is not a frequency. It is `automatic: false`, which leaves the
  frequency and folder settings in place for when the user turns it back on.
- Changing the folder **does not move existing backups**. The page says so,
  and the restore dialog can browse to the old folder.

## The Backups options page

Contributed as `book.options.backups`, under a `book.options` category
("Book"), module `./BackupsOptionsPage`.

```
Book › Backups
──────────────────────────────────────────────────────────────────────────
[✓] Back up automatically when a book closes

    How often     [ Once a day                       ▾ ]
                    Every time the book closes / Once a day / Once a week / Once a month
                  A book that hasn't changed since its last backup isn't backed up again.

    Keep          [ 10 ] automatic backups of each book
                  Older ones are moved to the Trash. Backups you make yourself are always kept.

Backup folder     /home/kim/Documents/Tessera Backups          [Browse…] [Use Default]
                  Choose a folder on another drive, or one your cloud service syncs,
                  so a failed disk doesn't take your backups with it.
                  Existing backups stay where they are when you change this.

Last backup       “Home Finances”: today at 18:42  ·  Home Finances 2026-11-19 18.42.10.tessera-backup
                  ⚠ The last automatic backup failed: the folder “/media/kim/USB/Backups” can't be found.
──────────────────────────────────────────────────────────────────────────
```

- **Browse…** calls the plugin's own IPC (`book:backups.chooseFolder`),
  which calls the new `shell.files.showFolderDialog`. The result goes into
  the draft through `onChange`. The options note allows a page to call its
  own plugin's IPC for actions like this.
- The **Last backup** line is *status*, not an option. It comes from
  `book:backups.status` and is not part of the draft. It shows the open book,
  or the most recently opened one when none is open.
- The controls under the checkbox are disabled (not hidden) when automatic
  backups are off.

## Automatic backups

### When one is due

A pure function, tested without a clock:

```ts
isBackupDue(entry: LedgerEntry | undefined, options: BookOptions['backups'], now: Date): boolean
```

| Condition | Due? |
|---|---|
| `automatic` is off | No |
| The book has never been backed up on this machine | Yes |
| Nothing changed since the last successful backup | **No** |
| `everyClose` | Yes |
| `daily` | The last backup was on an earlier **local calendar day** |
| `weekly` | At least 7 **local calendar days** after the last backup's |
| `monthly` | At least one calendar month has passed (day clamped, as the recurring engine does) |
| The last attempt failed or was interrupted | Yes, whatever the frequency, as long as something changed |

Calendar days rather than 24 hours for `daily`: someone who closes the book
at 21:00 on Monday and 08:00 on Tuesday expects a backup on Tuesday.

**The frequency sets the minimum time between backups. It is not a quota to
fill.** Each close produces at most one backup, and the question asked is only
"has a period passed since the last one?" Missed periods are never made up.
A book that was last backed up on 1 November and is next closed on
8 November, with `daily`, gets **one** backup on the 8th, not one for each of
the seven days in between. There is also nothing to make up: every one of
them would hold the same data. The same holds for `weekly` after a month away,
or `monthly` after a year.

### Bookkeeping

`BackupLedger` keeps one `app.state` key, `book.backups`:

```ts
type BackupLedger = Record<string /* bookId */, {
  lastBackupAt?: string          // ISO, last successful automatic or manual backup
  lastFile?: string              // its path, for the status line
  lastResult?: 'ok' | 'failed' | 'interrupted'
  lastError?: string
  /** Something was written to the book since lastBackupAt. */
  changed: boolean
}>
```

- **Change tracking.** While a book is open, the session listens to the
  *unscoped* database's `onDidChange`. On the **first** change of a session
  it sets `changed: true`, which is one `app.state` write per session, not
  one per edit. A successful backup clears it.
- Because `changed` persists, an edit on Monday that was not backed up
  (frequency `weekly`) is still backed up on Friday, even if the user only
  looked at the book that day.

### The close sequence

`BookSessionImpl.closeOpen` already awaits its `willClose` listeners before
it flushes. The backup's listener is the **last** one, so it sees whatever
earlier listeners wrote:

```
closeOpen()
 ├─ willClose listeners (plugins)            existing
 ├─ backups.onWillClose(book)                new
 │    if isBackupDue(): snapshot = await db.snapshot()   ← fast, in memory
 │                      queue.push(write(snapshot))      ← not awaited
 ├─ db.flush(); db.close()                   existing, never delayed
 └─ 'closed' event                           existing
                  ⋮
 queue: write → verify → prune → ledger      runs after the book has closed
```

Taking the snapshot is cheap: copying references out of in-memory maps, well
under 100 ms for any personal book. Compression and disk I/O, the slow part,
never sit between the user and a closed book.

### On quit

The book already closes on `lifecycle.onShuttingDown`. The same listener then
**waits for the backup queue to drain, up to a budget**
(`BACKUP_SHUTDOWN_BUDGET_MS = 6000`, inside the shell's 10 s limit). It is one
listener so the two steps can't run out of order:

- Within budget: the backup finishes, without the read-back verification;
  the digest computed while writing is kept.
- Over budget: the write is abandoned, the `.partial` file is deleted
  synchronously, and the ledger records `lastResult: 'interrupted'` with
  `changed: true`. A truncated file can never appear under a final name,
  because only a completed, renamed file has one.

### Nothing happens at startup or open

Backups are taken **only when a book closes** (and on demand). Starting
Tessera, reopening the last book, or opening any book never starts a backup,
even if the last automatic backup failed or was cut short at quit.

A failed or interrupted backup is retried at the **next close**. `changed`
is still true and `lastResult` is not `ok`, so `isBackupDue` says yes
whatever the frequency, as the last row of the table above shows. This holds
even if the user made no edits in that session: the work from the session
whose backup was missed is still in the book, so it is captured then. The
gap is one session, and the Start view and status-bar warning (see
[Failures](#failures-and-how-they-are-reported)) tell the user about it in
the meantime.

### Automatic backups as built

*Built (phase 2)*, in [`backups/`](../plugins/book/src/privileged/backups/):

| File | Role |
|---|---|
| `schedule.ts` | `isBackupDue`, pure |
| `BackupLedger.ts` | The `book.backups` key in `app.state`. Reads and writes go through one queue, and anything malformed is dropped when read |
| `Backups.ts` | The close hook, the write queue, verification, retention and `drain` |

The options contract (`BookOptions`, `BOOK_OPTIONS_DEFAULTS`,
`validateBookOptions`) is in `@tessera/book-api`, so the Phase 3 page can
share it.

Where the build is more specific than the sections above:

- **Backups use ordinary session events, and close listeners run last
  registered first.** `onWillClose` listeners run in reverse registration
  order, as plugins shut down: a plugin's listener runs before those of the
  plugins it depends on. `Backups.attach(session)` is called as the book
  plugin activates, before any other plugin can reach `book.session`, so the
  backup's listener is guaranteed to run last and sees whatever the others
  wrote.
  - It follows changes from the public `opened` event, which now carries
    `migrated`.
  - It reads the whole book through `BookSessionImpl.unscopedDatabase()`,
    which `publicSession` leaves out, so contributors never see it.
  - A failing listener is logged and never stops a book closing.

  (An earlier cut used special internal session hooks, because close
  listeners then ran in registration order and the book's would have run
  first.)
- **All three frequencies count local calendar days.** `daily` is a later
  date; `weekly` is 7 dates on; `monthly` is the same date next month,
  clamped. So a daylight-saving change never makes a day 23 or 25 hours.
- **Opening a book that ran migrations counts as a change.** Its data
  changed before any change event could be seen.
- **A clock set back** before the last backup makes a backup due, rather
  than stopping backups until the clock catches up. An unreadable
  `lastBackupAt` is treated as never backed up.
- **A change made while the previous backup is still being written** keeps
  `changed: true`. Each book's change count is captured with its snapshot.
- **At quit, pruning is skipped** along with the read-back. The next
  successful backup prunes.
- **A snapshot that fails** is recorded as a failed backup, and the book still
  closes.
- **The missing-folder message** names the folder and what to do: "The backup
  folder “…” can’t be found. If it is on a drive that isn’t connected,
  connect it, or choose another folder in Tools › Options › Book › Backups."
- **Shutdown:** `onShuttingDown` listeners also run last registered first, the
  reverse of start-up, so dependents run before the plugins they depend on and
  the shell's own listeners run last. (Before, `app.state` flushed *before*
  the book closed and wrote to it; nothing was lost, because storage closes
  every database last, but the order was a trap.) The book has one
  `onShuttingDown` listener, which closes the book and then drains the backup
  queue. `deactivate` drains too, for a plugin deactivated without a
  shutdown. See [plugin-creation.md](plugin-creation.md).
- **Tests** (`tests/plugins/book/backups/`):
  - `schedule.test.ts`: every frequency, the month-end, leap-year, year-end
    and daylight-saving boundaries, and "a week away is one backup".
  - `backups.test.ts`: a real session over the memory engine, with an
    in-memory backup disk that can hold or fail writes. It covers closing
    never waiting, a write during close being included, the frequencies, the
    failures and retries, retention with a Trash and without one, stale
    partials, and the shutdown budget, including abandonment followed by a
    retry after a restart.
  - `activation.test.ts`: quitting the app produces the backup.

  Every other test that activates the book plugin is given the in-memory
  backup disk, so no test writes real backup files.

## Backing up on demand

| Command | Menu | Enabled | Does |
|---|---|---|---|
| `book.backupNow` | File › Back Up Now | a book is open | Snapshot now, write to the backup folder, verify, report "Backed up “Home Finances” to …" in a message. `trigger: 'manual'`. Ignores the frequency and `changed` |
| `book.backupTo` | File › Back Up To… | a book is open | The same, to a file chosen in a save dialog (a USB stick, a share). Not recorded as the book's last backup unless it is in the backup folder: Tessera manages only that folder (open question E) |
| `book.restore` | File › Restore from Backup… | always | Opens the Restore dialog. See [Restore](#restore) |

They go in a new `book.backup` group of the File menu, between `book.file`
and `book.danger`. The Start view gets a **Restore Backup…** button beside
*New Book…* and *Open Book…*. Someone who has lost a book often has no other
book to open.

Manual backups are taken while the book stays open. `snapshot()` is
consistent even with writers running, which is exactly what a file copy of
an open SQLite database in WAL mode cannot promise.

## Retention

After each successful automatic backup:

1. List `*.tessera-backup` in the backup folder and read each header. Only
   the first line is decompressed, so this stays cheap even for hundreds of
   files.
2. Keep files whose header is unreadable, or whose `book.id` is a different
   book. **These are never touched.**
3. Of this book's backups with `trigger: 'auto'`, keep the newest `keep` by
   `takenAt` (from the header, not the file time) and **move the rest to the
   Trash**.
4. Remove stray `.partial` files older than one hour. These are incomplete
   files, so they are deleted rather than trashed.

**Pruned backups go to the Trash when the drive they are on has one.** Each
file goes through `shell.files.trash`, the same call *Delete Book* uses.
Some volumes have no trash: many network shares, some removable drives
formatted FAT/exFAT on Linux, and drives where the OS trash is turned off.
On those the call rejects, and the pruner **deletes the file permanently**
instead. It logs one `[book]` info line per prune that says so ("the backup
folder's drive has no Trash; 3 old backups were deleted"), and tells the user
nothing more. Keeping old automatic backups indefinitely on such a drive
would defeat `keep`.

- The decision is made **per file**, from the trash call's result. Tessera
  does not try to detect the volume type in advance. That differs by
  platform, and the OS is the authority on whether it can trash a file.
- A trash call that fails for any other reason (permissions, a Trash that
  is full or broken) falls back to deletion in the same way. That is
  acceptable only because the files are automatic backups beyond `keep`;
  the newest `keep` are never touched.
- **Windows check (phase 6):** for a file on a volume without a Recycle Bin,
  Electron's `shell.trashItem` must *reject*. It must not delete silently, or
  show a "permanently delete?" confirmation dialog while the app is closing.
  A silent delete is harmless, because it is the fallback anyway. A dialog is
  not. If the check finds one, the pruner skips the trash call for
  network paths (UNC and mapped drives) and deletes them directly. Phase 6
  settles how mapped drives are recognised.

Manual and *before restore* backups are never pruned (decision 8). The page
tells the user so.

## Restore

### The dialog

`book.dialog.restore`, `RestoreDialog.tsx`, size `md`:

```
Restore from Backup
──────────────────────────────────────────────────────────────────────────
Backups in /home/kim/Documents/Tessera Backups                [Browse…]

  ▾ Home Finances
      Today 18:42                automatic   2.1 MB   48,211 items
      Yesterday 09:15            automatic   2.1 MB   48,180 items
      Nov 12 20:03               manual      2.0 MB   47,902 items
  ▸ Rental Property (3)

  Selected: Home Finances, taken 19 Nov 2026 at 18:42 by book 0.1.0 (SQLite)

  ( ) Replace the open book, “Home Finances”
        A backup of it is made first, and its file is moved to the Trash.
  (•) Restore as a new book…
──────────────────────────────────────────────────────────────────────────
                                              [Cancel]  [Restore…]
```

- The list comes from `book:backups.list` (headers only), grouped by book id
  and newest first. The open book's group is expanded.
- **Browse…** picks any `.tessera-backup` file through `showOpenDialog`, so
  a backup on a USB stick or in an old folder can be restored.
- A backup that cannot be restored is listed **disabled with its reason**:
  "made by a newer Tessera", "damaged", "needs the *X* plugin at data
  version 4". The reason comes from the same checks as a real restore.
- **Replace the open book** is offered only when a book is open and
  writable. If the backup's `book.id` is a different book, the option says
  so: "This backup is of “Rental Property”, not “Home Finances”."
- Choosing **Restore as a new book…** opens a save dialog after *Restore…*,
  defaulting to `<original folder>/<name> (restored 2026-11-19).tessera`.
- *Restore…* always ends in a confirmation that names what will happen to
  which file. Replacing is a destructive confirmation.

Item counts are documents. The book is domain-free and does not know what an
"account" is. A later hook may let participants describe a backup the way
they describe a sub-book ([Later](#later)).

### The sequence

All of it runs inside `BookSessionImpl.serial`, so no *Open*, *Close* or
*Delete* interleaves.

```
restore(backupFile, target: 'replace' | { newPath })
 1. inspect        read header; refuse unknown backup file version, newer bookFormat,
                   or any schemaVersion newer than the installed contributor
                   (planMigrations' rule)
 2. verify         stream the whole file: every line parses, counts and sha256 match
 3. stage          staging = <target folder>/.<name>.restoring-<ulid>.tessera
                   engine.open({ path: staging }) → db.load(snapshot) → [new id if 'new'] → close
 4. probe          the existing read-only probe on the staged file
 ── nothing outside the staging file has changed up to here ──
 5a. replace       pre-restore backup of the open book (trigger 'pre-restore', from a snapshot)
                   closeOpen({ forget: false })
                   trash the book file and its side files
                   rename staging → original path
 5b. new           trash an existing file at newPath (the save dialog already asked)
                   rename staging → newPath
 6. open           this.open(path): migrations if the backup is older, attach, recent books,
                   'opened' event → every plugin rebuilds as for any open
```

- **Failure before step 5** deletes the staging file, and the open book is
  untouched.
- **Failure in or after step 5** reports what is where: "The restored book
  could not be opened. Your previous book is in the Trash, and a backup of it
  was saved as “Home Finances 2026-11-19 18.50.02 (before restore)”." The
  user is never left without both copies.
- The staging file lives **in the target folder**, so step 5 is a rename on
  the same volume, never a cross-device copy. On Windows, `rename` cannot
  replace an existing file, which is why the original is trashed first
  rather than overwritten.
- The staged database is closed before the rename, so SQLite has
  checkpointed and removed its `-wal` and `-shm` files and there are no side
  files to carry.
- **Restoring into an empty book** is simply *Replace the open book* while a
  freshly created book is open. It needs no special case. The pre-restore
  backup of an empty book is skipped.

## Failures and how they are reported

Automatic backups run when the user is leaving, so they **never show a modal
dialog**. Failures go to three places:

1. `context.logger.warn('[book] Automatic backup of “…” failed: …')`, which
   reaches the Problems log the user can open.
2. The ledger (`lastResult`, `lastError`), which drives the options page's
   status line and the retry at the next close.
3. The Start view and the book status-bar item show a small warning when the
   current or last book's most recent automatic backup failed, for example
   "Last backup failed — the backup folder can't be found." It links to the
   Backups page.

| Failure | Handling |
|---|---|
| User-chosen folder missing (drive unplugged) | Fail; do **not** create it (decision 9); message names the folder |
| Default folder missing | Create it (`mkdir -p`) |
| Folder not writable, disk full | Fail; `.partial` removed; message from the OS error |
| Verify fails after writing | File deleted; fail ("the backup could not be read back") |
| Over the shutdown budget | Abandoned; `interrupted`; retried at the next close |
| A pruned backup can't go to the Trash (no Trash on that drive) | Deleted instead; one info line logged ([Retention](#retention)) |
| Prune fails on one file | Logged; the backup itself still counts as successful |
| Read-only book | Automatic backups still run (reading is all they need); bookkeeping is by path hash if there is no id |

Manual commands and restore report failures in a message box through the
existing `reportingFailures` helper.

## Contracts

### `@tessera/types`

- `Database.snapshot()`, `Database.load()`, `DatabaseSnapshot`.
- `ShellFiles.showFolderDialog(options?: FolderDialogOptions): Promise<string | undefined>`.
  `FolderDialogOptions` is `FileDialogOptions` without `filters`. It uses
  Electron's `showOpenDialog` with `openDirectory` and `createDirectory`, is
  modal to the focused (or given) window, and drops any filters passed in.
  *Built (phase 0)*, in [`electronFiles.ts`](../shell/main/dialogs/electronFiles.ts).

### `@tessera/book-api`

```ts
BOOK_META.id = 'ledger.bookId'
BOOK_META.restoredFrom = 'ledger.restoredFrom'

BOOK_COMMANDS.backupNow = 'book.backupNow'
BOOK_COMMANDS.backupTo  = 'book.backupTo'
BOOK_COMMANDS.restore   = 'book.restore'
BOOK_DIALOGS.restore    = 'book.dialog.restore'

export const BACKUP_FILE_EXTENSION = '.tessera-backup'
export const BACKUP_FILE_FILTER = { name: 'Tessera backups', extensions: ['tessera-backup'] }

export type BackupTrigger = 'auto' | 'manual' | 'pre-restore'

/** What the restore dialog and the options page are told about one backup file. */
export interface BackupInfo {
  file: string
  bookId: string
  bookName: string
  takenAt: string
  trigger: BackupTrigger
  app: string
  engine: string
  sizeBytes: number
  documents: number
  /** Why it can't be restored here, when it can't. */
  problem?: string
}

export interface BackupStatus {
  book?: { id: string, name: string }
  lastBackupAt?: string
  lastFile?: string
  lastResult?: 'ok' | 'failed' | 'interrupted'
  lastError?: string
  folder: string               // resolved, never null
}

export type RestoreTarget = { kind: 'replace' } | { kind: 'new', path?: string }
```

### IPC (`book:` channels, privileged ⇄ the book's own views)

| Channel | Request | Response |
|---|---|---|
| `book:backups.status` | — | `BackupStatus` |
| `book:backups.chooseFolder` | `{ current?: string }` | `string \| undefined` |
| `book:backups.list` | `{ folder?: string }` | `BackupInfo[]` |
| `book:backups.inspect` | `{ file: string }` | `BackupInfo` (verified in full) |
| `book:backups.restore` | `{ file: string, target: RestoreTarget }` | `BookInfo \| undefined` |
| `book:backups.changed` | event | `BackupStatus`, after every backup attempt |

## Alternatives considered

| Alternative | Why not |
|---|---|
| **Copy the `.tessera` file** (as the pre-migration backup does) | Engine-specific: a SQLite copy cannot be restored while LokiJS is active, because the probe refuses it. Copying an open SQLite file in WAL mode is not consistent without a checkpoint. There is no header, so listing backups means opening each one. There is no integrity check. It stays the right tool for the pre-migration copy, where the file is closed and the copy is only ever reopened by the same engine |
| **SQLite `VACUUM INTO` / the online backup API** | Excellent for SQLite, and nothing for LokiJS. It would give two backup paths to maintain, and still no engine-neutral restore |
| **A zip file** | Needs a dependency for no gain while a book is one stream of documents. Revisit when books carry attachments (receipts), which want to be separate entries |
| **Export to QIF/OFX** | Lossy by design ([import-export-design.md](import-export-design.md)) |
| **Back up on a timer while the app runs** | Requires a snapshot while the user is mid-edit, wakes the disk for books nobody touched, and was not asked for. Close-time backups, with a retry at the next close after a failure, cover the real risk. A long-session timer is in [Later](#later) |
| **Back up at open instead of close** | Open is when the user is waiting. It would also back up a state that is already on disk, rather than the work just done. Not used at all, not even to catch up after a failure (open question D) |
| **Store "last backup" in the book's meta** | Writing on close is a change. A restored or copied book would carry a stale or misleading stamp. It ties a per-machine schedule to a portable file (decision 4) |
| **A separate `backup` plugin** | Would need the unscoped database and the session's serial queue as public contract ([Where it lives](#where-it-lives)) |
| **Restore by merging into the open book** | Merge semantics for every contributor's collections, with conflicts, is a feature of its own. Replacing is what people mean by "restore" |

## Open questions

Every question was answered on 2026-11-19, and the answers are folded into
the note above.

| # | Question | Answer |
|---|---|---|
| A | "Restore … to the current or an empty collection": does *collection* mean *book*? | **Answered: yes.** Restore either replaces the open book or creates a new book from the backup |
| B | Default folder: `Documents/Tessera Backups`, or a `Backups` folder beside each book? | **Answered: `Documents/Tessera Backups`** |
| C | Default frequency and count | **Answered: `daily`, keep `10`.** The frequency is a minimum gap, not a quota: a book not opened for seven days gets one backup at its next close, not seven (decision 11, [When one is due](#when-one-is-due)) |
| D | Should a backup run at startup or when a book opens, to catch up on a missed one? | **Answered: no.** Backups start only when a book closes, or on demand. A failed or interrupted backup is retried at the next close (decision 12, [Nothing happens at startup or open](#nothing-happens-at-startup-or-open)) |
| E | Should *Back Up To…* count as the book's last backup when the file is outside the backup folder? | **Answered: no.** Tessera manages only the backup folder and has no visibility into other locations: it cannot list, verify or prune a file elsewhere, or know it still exists |
| F | Delete or trash pruned backups? | **Answered: trash them where the drive allows it,** and delete them where it has no Trash ([Retention](#retention)) |

## Later

- **Periodic backups while a book stays open**, e.g. every *n* hours of an
  open session with changes, for users who never close the app.
- **A `book.backups` service** so other plugins can ask for a backup, e.g.
  *exchange* taking one before a large import, or a migration-heavy plugin
  upgrade.
- **Participants describe a backup** ("312 accounts, 48,000 transactions")
  through a hook like `SubBookParticipant.describe`, computed at backup time
  and stored in the header.
- **Per-book settings** once the options framework has `scope: 'book'`.
- **Encrypted backups**, with the key handling that implies (and the same
  answer for the book file itself).
- **Open the backup folder** in the OS file manager from the page
  (needs `shell.files.reveal`).
- **Archive**: a read-only copy of a book as of a date, for closing out
  years. A feature of its own, with its own design note. It may reuse the
  backup file format to store the copy.
- **Back up and restore the options and application state** for moving
  machines (the options note's own *Later* item).

## Phases

Effort on the scale this repository's other notes use: **S** a day or two,
**M** about a week, **L** two weeks or more, for one developer.

| Phase | Delivers | Effort | Depends on |
|---|---|---|---|
| **0** | *(done)* **Prerequisites.** `Database.snapshot()`/`load()` and `DatabaseSnapshot` in `@tessera/types`, implemented in `KitDatabase`; `scopedDatabase` rejecting both; the in-place-mutation check that decides whether the snapshot clones; `ShellFiles.showFolderDialog` in the shell and its Electron adapter; `BOOK_META.id`, assigned at create and on first writable open | **M** | — |
| **1** | *(done)* **The backup file, headless.** `backupFile.ts` (streaming write and read, header, trailer, digest, every refusal: unknown version, truncated, miscounted, bad digest, newer book format, newer contributor); `naming.ts`; the `BackupDisk` port with a Node adapter (write `.partial` → fsync → rename; header-only reads); round-trip tests on the memory engine and on real SQLite and LokiJS files, including SQLite → LokiJS and back | **M** | 0 |
| **2** | *(done)* **Automatic backups.** The `book` options namespace (defaults, validate); `isBackupDue` (pure); `BackupLedger` and change tracking; the close-time listener and the post-close queue; verify; retention, trashing pruned backups with a delete fallback; the shutdown budget and abandonment; retry at the next close; logging to the Problems log. No UI beyond what logging shows | **M** | 1 |
| **3** | **The Backups options page.** `BackupsOptionsPage.tsx` with the frequency, keep, automatic and folder controls; *Browse…* and *Use Default* through `book:backups.chooseFolder`; the status line from `book:backups.status`, refreshed on `book:backups.changed`; the `book.options` category and page contributions | **S** | 2 |
| **4** | **Backing up on demand.** *Back Up Now* and *Back Up To…* commands and File menu group; the Start-view and status-bar warning for a failed last backup | **S** | 2 |
| **5** | **Restore.** `Restorer` (inspect, verify, stage, probe, swap, reopen) inside the session's serial queue, with every failure path's message; pre-restore backups; new id and `restoredFrom` for restore-as-new; `book:backups.list/inspect/restore`; `RestoreDialog.tsx` (grouped list, disabled-with-reason rows, Browse…, the two targets, confirmations); *Restore from Backup…* in the File menu and on the Start view | **L** | 1, 2 |
| **6** | **Hardening and documentation.** A seeded large book (`npm run seed:book`) timed through snapshot, write, verify and restore, to confirm the shutdown budget with margin; Windows rename and trash behaviour checked on a real machine, including `trashItem` on a network share and a removable drive, where it must reject without a dialog (see [Retention](#retention)); [plugin-creation.md](plugin-creation.md) updated for `snapshot`/`load` and `showFolderDialog`; `todo.md` updated; this note's *Status* | **S** | 5 |

**Total: about six to seven weeks for one developer.** Phases 3 and 4 can
run in parallel with phase 5 once phase 2 is in, which brings it to about
five weeks with two people. The first useful release is the end of
phase 3: automatic backups the user can configure. Restore without the
dialog (a command taking a file path) could be pulled forward into it if
having backups without a way to restore them is a concern.

### Tests, by phase

| Phase | What is tested |
|---|---|
| 0 | `snapshot` returns every collection (declared or not), index and meta value; a snapshot taken while a transaction is pending excludes it, and one taken after includes it; `load` into an empty database restores everything and fires no partial state; `load` into a non-empty database fails and writes nothing; a backend that throws mid-`load` leaves the file empty; `scopedDatabase` rejects both; `showFolderDialog` passes `openDirectory`; a book without an id gets one on writable open and not on read-only open |
| 1 | Round trip is exact (deep-equal snapshot) on memory, SQLite and LokiJS, and across engines; the header is readable from the first chunk alone; truncation at any line, a flipped byte, a missing trailer, a wrong count, an unknown backup file version and a newer contributor version are each refused with their own message; names never collide or overwrite, and never contain characters Windows rejects |
| 2 | `isBackupDue` across every frequency, calendar-day and month-end boundaries, the never-backed-up, unchanged and after-failure cases; close takes a backup only when due and never delays `flush`; a backup during quit completes within the budget, and an artificially slow writer is abandoned with no final-named file and an `interrupted` ledger entry; the next close retries even with no edits, and no open or startup ever starts a backup; a close after seven days away with `daily` takes exactly one backup; a missing user-chosen folder is not created and the default folder is; retention keeps the newest *n* automatic backups of this book and never touches manual, pre-restore, other books' or unreadable files; pruned files go to the Trash, and are deleted, with one log line, when the trash call rejects |
| 3 | The page edits the draft and nothing takes effect before Apply; Browse… fills the folder; invalid `keep` disables Apply; the status line shows success and failure and refreshes after a backup |
| 4 | *Back Up Now* writes a verified `manual` backup of an open book with writers running; *Back Up To…* writes where chosen and does not change the ledger outside the backup folder; the warning appears after a failed automatic backup and goes after a successful one |
| 5 | Restore as new creates a book that opens with the backup's contents, a new id and `restoredFrom`; replace takes a pre-restore backup, trashes the old file and side files, and reopens with the backup's contents and the same id; an older backup is migrated on open and a newer one refused before anything changes; a failure at each step leaves the files exactly as the message says; a concurrent *Open* waits for the restore; other plugins' views show the restored data after the `opened` event |
| 6 | Timing of a large seeded book recorded in the phase results, with the budget's margin |
