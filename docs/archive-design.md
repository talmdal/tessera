# Design note: archiving a book

| | |
|---|---|
| **Status** | **Built: phases 0–8.** Read-only books that say so; the archive writer and `npm run archive:book`; the participant registration and plan (surveys run in **two passes**, see [Participants](#participants)); all three participants — accounts, recurring (with the series roll-forward) and exchange; the Archive dialog and *File › Archive…*; archive restore through the existing Restore dialog and Restorer; the archived-period barrier for accounts, imports and recurring entries; and the Archive options page, settings and documentation. Timings in [Phase 5 results](#phase-5-results): no progress bar needed. **Windows and network-share checks on real hardware remain pending.** Open questions answered 2026-11-20 and folded in |
| **Date** | 2026-11-20 |
| **Scope** | Closing out old years: taking a complete, frozen, read-only copy of a book as an archive, then removing from the working book the transactions nothing needs any more, with every account's opening balance and opening date moved forward so no ending balance changes |
| **Builds on** | [backup-restore-design.md](backup-restore-design.md) (`Database.snapshot()`/`load()`, the backup writer, the Restorer's staging, the File menu's `book.backup` group), [account-manager-design.md](account-manager-design.md) (accounts, transactions, transfers, reconciliation), [options-framework-design.md](options-framework-design.md) (`context.options`, `shell.options.pages`), [storage-engine-redesign.md](storage-engine-redesign.md) (atomic batches, `readOnly`) |
| **Delivers** | An archive file that is an ordinary book, frozen read-only; in the `book` plugin: an archive planner, writer and pruner, a `book.archive.participants` extension point, a *File › Archive…* command in the `book.backup` group, an Archive dialog and an Archive options page; in `accounts`, `recurring` and `exchange`: archive participants |
| **Supersedes** | The *Archive* line in [backup-restore-design.md](backup-restore-design.md#later) |

- [Summary](#summary)
- [Context](#context)
- [Goals and non-goals](#goals-and-non-goals)
- [Decisions](#decisions)
- [Where it lives](#where-it-lives)
- [The archive file](#the-archive-file)
- [Opening an archive](#opening-an-archive)
- [What is removable](#what-is-removable)
- [Moving the opening balance](#moving-the-opening-balance)
- [Participants](#participants)
- [The archive sequence](#the-archive-sequence)
- [Restoring an archive](#restoring-an-archive)
- [The archived period is closed](#the-archived-period-is-closed)
- [The Archive dialog](#the-archive-dialog)
- [Options](#options)
- [The Archive options page](#the-archive-options-page)
- [The menu](#the-menu)
- [Failures and how they are reported](#failures-and-how-they-are-reported)
- [Contracts](#contracts)
- [Alternatives considered](#alternatives-considered)
- [Open questions](#open-questions)
- [Later](#later)
- [Phases](#phases)

## Summary

- **An archive is a whole book, frozen.** *File › Archive…* writes
  `<Book> Archive through <date>.tessera`: a complete copy of the book as it
  is at that moment — every account, every transaction, every payee,
  category, reconciliation, series and import batch, including the recent
  ones. It is a real book file, written by the active storage engine, so
  **it opens with *Open Book*** like any other. A meta flag makes it
  **read-only**, and Tessera honours that for the whole session.
- **The copy is taken first, and is the safety net.** Nothing is removed
  from the working book until the archive has been written, closed, reopened
  and verified in full. If anything later goes wrong, the archive is the book
  as it was.
- **Then the working book is pruned.** Transactions dated before the cut-off
  that are **reconciled or voided**, and that nothing still needs, are
  deleted. Everything else stays — in particular, **unreconciled
  transactions before the cut-off are kept**, because they are still work in
  progress.
- **Ending balances never change.** For each account, the signed sum of the
  transactions removed is added to its `openingBalance`, and its
  `openingDate` moves forward to the cut-off. `current`, `available`,
  `cleared` and `reconciled` are identical before and after; only
  `transactionCount` falls. This is checked per account, inside the pruning
  transaction, and a mismatch rolls the whole thing back.
- **The cut-off is a date, suggested as the first day of the current year.**
  *Archive data before this date.* The user can change it in the dialog;
  an *Options › Book › Archive* page holds the defaults (the suggestion rule,
  where archives go, what counts as removable).
- **It warns about unreconciled transactions before the cut-off**, by
  account, with counts and the oldest date, before anything happens. They are
  kept, so the user can archive anyway, or cancel and reconcile first.
- **Other plugins take part** through `book.archive.participants`: `recurring`
  drops old postings, `exchange` drops import batches whose undo window has
  gone, `accounts` does the transactions and the opening balances. Each one
  surveys first (for the confirmation) and prunes inside the single storage
  transaction.
- **It belongs to the `book` plugin**, beside backup and restore, for the
  same reasons: only the book holds the unscoped database and the serial
  file-operation queue.

## Context

What exists today:

- **Backup gives us most of the machinery.** `Database.snapshot()` takes a
  consistent in-memory copy of a whole book under the commit lock, and
  `Database.load()` writes one into an empty database in a single atomic
  commit ([backup-restore-design.md](backup-restore-design.md#taking-a-snapshot)).
  The `Restorer` already uses both to build a **new book file** from a
  snapshot, stage it under a temporary name, verify it and open it through
  the normal *Open* path
  ([`Restorer.ts`](../plugins/book/src/privileged/backups/Restorer.ts)).
  Writing an archive is that, with the snapshot coming from the open book
  rather than from a file.
- **Read-only books already work end to end.** `Database` has `readOnly`,
  and `KitDatabase` refuses every write with `StorageError('READ_ONLY')`
  ([`database.ts`](../packages/storage-kit/database.ts)). `BookInfo.readOnly`
  is published, the context key `book.isReadOnly` is set
  ([`protocol.ts`](../packages/book-api/protocol.ts)), and views consume it —
  the register turns off editing through
  `ACCOUNTS_CONTEXT_KEYS.registerEditable`
  ([`register.ts`](../plugins/accounts/src/privileged/register.ts)). What is
  missing is a way for a book to *declare itself* read-only: today
  `BookSessionImpl.openNow` always opens writable, and `readOnly` only ever
  comes back true when the engine could not open the file for writing.
- **A transaction's state is its `status` and `voided` flag**
  (`uncleared | electronic | cleared | reconciled`, plus `voided`)
  ([`model.ts`](../packages/accounts-api/model.ts)). A voided transaction is
  excluded from every balance but keeps its amount, so unvoiding restores it.
- **An account carries its own opening balance and date** (`openingBalance`,
  signed; `openingDate`), and `AccountBalances.current` is "opening balance
  plus every transaction". The register draws the opening row itself, above
  the rows, from the account (`Register.tsx`). So moving the opening balance
  forward is exactly the adjustment this feature needs, and the register
  needs no new concept to show it.
- **A transfer is two transactions**, one in each account, sharing
  `transferId` and naming each other through `transferAccountId`.
- **Reconciliation leaves a trail**: `accounts.reconciliations` documents and
  `account.lastReconciled = { date, balance, reconciliationId }`.
- **Other plugins point at transactions.** `recurring.postings` hold
  `transactionId` for each occurrence entered
  ([`model.ts`](../packages/recurring-api/model.ts)); `exchange.batches` hold
  `created` and `merged` records so an import can be undone
  ([`model.ts`](../packages/exchange-api/model.ts)). Both must be given a
  chance to clean up, or they are left pointing at nothing.
- **The import/export note already assumes this feature exists.** It argues
  that keeping a book whole is "backup, restore and archive — separate
  planned work — not export", and that "archiving will keep the working set
  small" ([import-export-design.md](import-export-design.md)).
- **The File menu has a `book.backup` group**, order 5, holding *Back Up
  Now*, *Back Up To…* and *Restore from Backup…*
  ([`contributions.ts`](../plugins/book/src/privileged/contributions.ts)).
  The request is that *Archive…* joins it.

## Goals and non-goals

**Goals**

- A user who has kept a book for fifteen years can cut it back to the current
  year or two, and still have every figure they had: balances, the reconciled
  balance, the last reconciliation.
- Nothing is lost. The archive is complete — not only the removed part — and
  is a book the user can open, read, search and report on with the ordinary
  Tessera they already have.
- An archive can never be edited, and can never be mistaken for the working
  book.
- Archiving is all-or-nothing. Either the archive exists and the book is
  pruned, or the book is untouched.
- Plugins that keep data about transactions are told, and prune their own
  data in the same transaction, scoped to their own collections.
- The user is told what will happen — how many transactions, from which
  accounts, and what is in the way — before anything happens.

**Non-goals (for now)**

- **Automatic archiving on a schedule.** Archiving is a deliberate act with a
  decision in it. See [Later](#later).
- **Merging an archive into a book that has moved on since.** Putting an
  archive *back* is supported, through the ordinary restore path
  ([Restoring an archive](#restoring-an-archive)); reconciling it against
  work done after the prune is a feature of its own.
- **Archiving one account or one sub-book.** The cut-off is a date and
  applies to the whole book.
- **Removing payees and categories that are no longer used.** That is a
  tidy-up feature of its own, and removing a category would change the
  meaning of the archive's reports. They are kept.
- **Compacting the book file.** SQLite's `VACUUM` and LokiJS's rewrite are a
  separate concern; the archive's own file is written fresh, so it is already
  compact.
- **Changing what reports can reach.** A report run on the pruned book sees
  what is in the pruned book. Running old reports means opening the archive.
- **Encryption.** As for backups: an archive is as readable as the book.

## Decisions

| # | Decision | Why |
|---|---|---|
| 1 | **The archive is an ordinary `.tessera` book file, not a `.tessera-backup`** | The request is that it opens with *Open Book*. A book file does that with no new reader, no new dialog and no new format. The backup *mechanism* — `snapshot`, `load`, staged write, verify-by-reopening — is reused wholesale ([The archive file](#the-archive-file)) |
| 2 | **The archive holds the whole book, not just the removed part** | "A complete copy of the book as an archive file." A copy of only the old transactions would be a book with no recent context: transfers pointing at nothing, half a reconciliation. It is also the safety net for step 2, which a partial copy could not be |
| 3 | **Read-only is a property of the file** (`ledger.readOnly` in meta), honoured at open | A read-only book has to stay read-only when it is moved, renamed or copied to another machine. File permissions do not travel, and are not under Tessera's control |
| 4 | **The archive is written, closed, reopened and verified before anything is removed** | A snapshot that was written but is unreadable is not a safety net. Reopening through the ordinary probe is the same check *Open Book* would make |
| 5 | **Removable means: before the cut-off, and reconciled or voided, and unreferenced** | What the user asked for, with the referential cases made explicit ([What is removable](#what-is-removable)). "Reconciled" is the user's own statement that the figure is settled |
| 6 | **Unreconciled transactions before the cut-off are kept, and warned about** | They are unfinished business. Removing them would silently fold a figure the user has not agreed to into the opening balance |
| 7 | **Both sides of a transfer are removed, or neither** | Removing one side leaves the other showing "Transfer to: …" against an account whose matching row has gone, and makes the pair unexplainable |
| 8 | **The opening balance absorbs exactly the signed sum of what was removed; the opening date moves to the cut-off** | It is the only adjustment that leaves every ending balance identical, and it needs no new document type ([Moving the opening balance](#moving-the-opening-balance)) |
| 9 | **The whole prune is one storage transaction, and the balance check is inside it** | Atomic batches are what the storage kit gives for exactly this. A per-account balance that does not match is a bug, and must roll back rather than ship |
| 10 | **Other plugins prune through `book.archive.participants`**, surveying first and pruning inside the transaction | The same shape as `SubBookParticipant`, which already solves "a cross-plugin delete that must be atomic and must be explained first" |
| 11 | **Archiving needs the book closed to no one but itself**: it runs inside the session's `serial` queue, like restore | A concurrent *Open*, *Close* or *Delete* between the write and the prune would be unrecoverable |
| 12 | **The suggested cut-off is 1 January of the current year**, and the suggestion rule is an option | The request. A rule rather than a stored date, so the suggestion stays right next year without anyone editing it |
| 13 | **Archiving is refused on a read-only book, and on a book with a reconciliation in progress** | The first cannot be pruned at all; the second holds marks on transactions that are about to be deleted |
| 14 | **An archive can be restored, through the existing *Restore from Backup…* path** | It is the way back when a prune turns out to have been a mistake. The Restorer already stages, verifies, swaps and reopens; an archive is one more thing it can read, and the restored copy is writable ([Restoring an archive](#restoring-an-archive)) |
| 15 | **The archived period is closed to new data.** Imports and recurring entries dated before an account's opening date are held back, and taking one anyway is a deliberate, explained act | The opening balance is a statement that everything up to the cut-off is accounted for. Nothing may contradict it by accident, and duplicate detection cannot protect the user there, because what it would match against has gone ([The archived period is closed](#the-archived-period-is-closed)) |
| 16 | **The book does not remember which archives it produced** | An archive may live on a removable drive, a share or another machine. A remembered path is wrong more often than it is right, and the archive already records which book it came from |

## Where it lives

The `book` plugin, in a new `privileged/archive/` folder beside `backups/`:

```
plugins/book/src/
├── privileged/
│   ├── archive/
│   │   ├── ArchiveWriter.ts    snapshot → staged book file → freeze → reopen → verify
│   │   ├── ArchivePlan.ts      pure: survey + plan from participants, totals, warnings
│   │   ├── Archiver.ts         the sequence: plan, confirm, write, prune, report
│   │   ├── participants.ts     the `book.archive.participants` point and its validation
│   │   ├── naming.ts           archive file names and the cut-off suggestion rules
│   │   └── options.ts          the `archive` part of the `book` options namespace
│   ├── backups/…               reused: BackupDisk, the staging and rename helpers
│   ├── BookSessionImpl.ts      + the read-only meta flag at open; `exclusive()` already exists
│   └── contributions.ts        + the File menu item, the dialog, the options page
└── renderer/
    ├── ArchiveDialog.tsx
    └── ArchiveOptionsPage.tsx
```

The participants live with their own data:

```
plugins/accounts/src/privileged/archiveParticipant.ts     transactions, transfers, reconciliations, opening balances
plugins/recurring/src/privileged/archiveParticipant.ts    old postings
plugins/exchange/src/privileged/archiveParticipant.ts     spent import batches
```

The contract types (`ArchivePlan`, `ArchiveOptions`, `ArchiveParticipant`,
the command and dialog ids) go in `@tessera/book-api`, with backup's.

## The archive file

**Name.** `<Book> Archive through <YYYY-MM-DD>.tessera`, using the cut-off,
e.g. `Home Finances Archive through 2026-01-01.tessera`. The same name rules
as every other book file apply (`validateBookName`, the Windows-forbidden
characters, no trailing dot or space). If the name is taken, ` (2)` is
appended; the writer never overwrites.

**Where.** The archive folder from the options, defaulting to
`<Documents>/Tessera Archives`. The dialog shows it and offers *Browse…*,
and the file can be put anywhere the OS will write.

**How it is written.** Reusing backup's machinery, inside
`session.exclusive()`:

1. `snapshot()` the open book's unscoped database — one pass over the
   in-memory maps, taken between commits, so it is consistent and the user is
   not blocked for long.
2. Open a **new, empty** database at `<final name>.<random>.partial` with the
   active engine, and `load()` the snapshot into it: one atomic commit.
3. Set the archive's own meta, which is all that distinguishes it from the
   book it came from:

   ```jsonc
   "ledger.id":        "01JE…",          // a new id: it is a different book from the one it was cut from
   "ledger.readOnly":  true,
   "ledger.archive":   { "of": "01JD…",             // the book it was cut from
                         "ofName": "Home Finances",
                         "takenAt": "2026-11-20T10:14:02.771Z",
                         "through": "2026-01-01",   // the cut-off: what was removed from the working book
                         "app": "book 0.1.0" }
   ```

   `ledger.format` and every contributor's schema version come across with
   the snapshot, so the archive is at exactly the version the book was.
4. `flush`, `close`, then `rename` the staged file (and any side files) to
   the first free final name.
5. **Verify**: reopen the final file through `session.exclusive`'s `probe`,
   confirm `ledger.readOnly`, `ledger.archive`, the collection count and the
   document count against the snapshot, then close it. A failure deletes the
   file and fails the archive, and the working book is untouched.

Only after step 5 does anything get removed.

**Why not write a `.tessera-backup` as well.** The archive is the complete
book, verified, in a format Tessera opens. A second copy in a second format
would be two things to keep and two things to explain. A user who wants a
`.tessera-backup` of the pre-archive book can take one with *Back Up Now*;
the Archive dialog says so, and the confirmation offers it as a checkbox when
the book's last backup is older than the archive would be (see
[The Archive dialog](#the-archive-dialog)).

## Opening an archive

`BOOK_META.readOnly = 'ledger.readOnly'` is read during `probe`, which
already opens the file read-only to check it. When it is `true`:

- `openNow` opens the database with `{ readOnly: true }`, and `attach`
  publishes `BookInfo.readOnly = true`. The context key `book.isReadOnly`
  follows, and the views that already consume it — the register's
  `registerEditable`, the account and sub-book commands, the recurring
  *Enter* actions, the exchange *Import* command — turn off as they do today
  for a book on a read-only volume.
- **No migrations run, and none are needed in the normal case**: the archive
  was written at the current version. An archive from an older Tessera whose
  plan would change existing data (`needsBackup`: any step from a version
  above 0) cannot be migrated in place, because it cannot be written. It is
  refused with *"“X” is an archive made by an older version of Tessera and
  can't be brought up to date, because an archive can't be changed. Make a
  writable copy to open it."* Making that copy is [Later](#later). A step
  *from 0* is only seeding for a plugin installed after the archive was made,
  with no data in the file to convert; it is skipped with a log line, and
  that plugin sees empty collections — which it must bear anyway. Refusing
  there would make every archive unopenable the day any new plugin is
  installed.
- **No book id is written.** `identify()` already returns a path-derived id
  for a read-only book, and the archive has a real `ledger.id` anyway.
- **No automatic backup is taken when it closes.** The backup listeners skip
  a read-only book at open (nothing to watch) and at close — before
  `isBackupDue`, whose "never backed up" rule would otherwise make one due.
- The status bar replaces *Book: Home Finances* with
  *Archive of “Home Finances” through 1 Jan 2026* (a `Lock`-iconed bar item
  on `book.isArchive`, the date from the `book.archiveThrough` context key,
  formatted locally). A plain read-only book (one on a locked volume) keeps
  today's wording.

The working book is not marked in any way, and is not tied to its archives:
an archive is a file the user keeps, moves or deletes. What the book does
record is one meta key for the dialog's benefit,
`ledger.lastArchivedThrough = '2026-01-01'`, so the next archive can suggest
a later cut-off and refuse an earlier one.

## What is removable

A transaction may be removed when **all** of these hold:

| | Rule | Why |
|---|---|---|
| 1 | `date < before` (the cut-off, exclusive) | "Archive data before a given date" |
| 2 | `voided === true`, **or** `status === 'reconciled'` | What nothing needs any more. A voided transaction contributes nothing to any balance; a reconciled one has been agreed against a statement |
| 3 | It is not marked by a reconciliation in progress | Those marks are unfinished work. In practice this cannot arise, because archiving is refused while any reconciliation is in progress (decision 13), but the participant checks rather than assumes |
| 4 | If it is one side of a transfer, the other side is removable too | Decision 7. Checked by `transferId`; a transfer whose partner is missing already is removable on its own |
| 5 | No participant objects | [Participants](#participants) |

Everything else stays, including:

- **unreconciled, cleared and electronically cleared transactions** before
  the cut-off — the warning is about exactly these;
- every transaction on or after the cut-off, whatever its status;
- every account, payee, category and sub-book;
- the **latest reconciliation of each account** — the one
  `account.lastReconciled.reconciliationId` points at — even when it is
  before the cut-off. Earlier ones are removed.

Which statuses count is an option (`removeReconciled`, `removeVoided`,
both on by default), so a user who wants to keep voided transactions as a
record can. Turning both off makes the archive a copy with no pruning, which
the dialog says plainly.

## Moving the opening balance

For each account that had anything removed, inside the same transaction:

```
removed      = the transactions removed from this account
delta        = Σ t.amount for t in removed where not t.voided     // voided ones contribute nothing
openingBalance' = openingBalance + delta
openingDate'    = max(openingDate, min(before, earliest remaining transaction date))
```

- **`delta` ignores voided transactions**, because they were never in a
  balance. Removing one therefore changes nothing at all, which is the point.
- **The opening date** moves forward to the cut-off, which is what "the
  opening balance as of the archive date" means. The two clamps keep it
  honest: it never moves *backwards* (an account opened after the cut-off is
  left alone), and it never moves past a transaction that is still in the
  register (an unreconciled 2019 transaction that stayed keeps the opening
  row above it, where the register draws it). When an account has no
  transactions left, `min` has nothing to offer and the date is the cut-off.
- **Accounts with nothing removed are not touched at all** — not their
  balance, not their date, not their `rev`.
- `lastReconciled` is left exactly as it is. Its `balance` is still the
  balance at that statement, and its `reconciliationId` still resolves,
  because that reconciliation is kept (rule above).

**The invariant, checked per account before the transaction commits** — and
checked against the **stored** post-image, not the values the prune meant to
write: the account is read back from the collection and its balances
recomputed from the transactions that are actually left, so even a write that
quietly stored the wrong number is caught (a test simulates exactly that):

```
current', available', cleared', reconciled'  ==  current, available, cleared, reconciled
```

The balances are computed from the pre-image the participant already holds
and from the post-image it is about to write, without re-reading the
database. Any difference throws `ARCHIVE_BALANCE_MISMATCH`, which rolls the
transaction back and leaves the book as it was — with the archive file still
on disk, and the message naming the account.

Why it holds: `current` is `openingBalance + Σ amounts`. Every removed
non-voided amount leaves the sum and enters `openingBalance`, so the total is
unchanged; every removed voided amount was in neither. `cleared` and
`reconciled` are the same sum restricted to statuses that every removed
non-voided transaction has (a removed one is `reconciled`, which is in both
`CLEARED_STATUSES` and the reconciled set), so they move across identically.
`available` is `current` less a constant. `transactionCount` does change, and
is the one figure the dialog reports as changing.

**Multi-currency** needs no special handling: the adjustment is per account,
and an account has one currency.

## Participants

A registration on `book.session`, `participateInArchive`, mirroring
`participate` for sub-books. It is a method rather than an extension point
because a participant is *behaviour*: extension points carry data that can be
validated before any plugin code runs, which a pair of functions cannot be.

```ts
export interface ArchiveParticipant {
  /**
   * What this plugin would remove for a cut-off, without removing it. Must not write. Used for the dialog's
   * summary and its warnings, and recomputed nowhere else: the plan the user confirms is the plan that runs.
   */
  survey(request: ArchiveRequest): Promise<ArchiveSurvey>
  /**
   * Inside the single archiving transaction, with `tx` scoped to this participant's own collections: remove
   * what `survey` said, and make whatever adjustments keep the book true. Throwing rolls the whole archive
   * back — the archive file is kept, the book is unchanged.
   */
  prune(tx: StorageTransaction, request: ArchiveRequest): Promise<ArchiveResult>
}

export interface ArchiveRequest {
  /** Exclusive: transactions dated strictly before this are candidates. `YYYY-MM-DD`. */
  before: string
  removeReconciled: boolean
  removeVoided: boolean
}

export interface ArchiveSurvey {
  /** For the confirmation, e.g. "8,412 transactions in 6 accounts" or "213 recurring postings". */
  describe: string
  /** How many documents this participant would remove; for the totals line. */
  documents: number
  /** Things the user should know before agreeing. Shown as a list, most important first. */
  warnings: ArchiveWarning[]
  /** Rows for the dialog's Details disclosure: one per account, with its new opening row already formatted. */
  rows?: ArchiveRow[]
  /** Ids other plugins may point at — the transactions `accounts` removes. Carried into every `prune`. */
  removesIds?: readonly string[]
  /** Why this participant cannot take part at all; archiving is refused and this is the message. */
  blocker?: string
}

/** One Details row. Generic, so the book plugin never learns what an account is. */
export interface ArchiveRow {
  id: string
  label: string
  removed: number
  /** Already formatted by the participant, which alone knows the currency: "Opening balance $1,234.56 as of 1 Jan 2026". */
  detail?: string
}

export interface ArchiveWarning {
  kind: 'unreconciled' | 'openImport' | 'other'
  message: string          // "Chequing: 14 transactions before 1 Jan 2026 are not reconciled (oldest 3 Mar 2019)."
}

export interface ArchiveResult {
  documents: number
}
```

Order matters, and is fixed rather than left to registration order: `accounts`
prunes **last**, so a participant that wants to keep a transaction (because
its own record still needs it) can say so first. A participant declares
`before: string[]` — plugin ids it must run before — in its contribution;
`accounts` runs after everything.

What the three participants do:

| Plugin | Surveys and removes | Keeps |
|---|---|---|
| `accounts` | Transactions by the rules in [What is removable](#what-is-removable); reconciliations before the cut-off; then the opening-balance adjustment and the balance check | Accounts, payees, categories, each account's latest reconciliation, `lastReconciled` |
| `recurring` | Postings whose `dueDate` is before the cut-off, except each series' most recent posting and its `SOURCE_POSTING_INDEX` posting; clears `transactionId` on any posting it keeps whose transaction `accounts` removed; **rolls each series' next occurrence forward past the cut-off**, recording what it passed over as `outcome: 'skipped'` postings ([The archived period is closed](#the-archived-period-is-closed)) | Every series, every holiday calendar |
| `exchange` | Import batches whose `closedAt` is set and whose rows are all before the cut-off and all removed — their undo window is gone with the transactions | Account links, payee rules, profiles, pending statements, open batches. An open batch, or a pending statement whose period reaches before the cut-off, raises an `openImport` warning |

`recurring` and `exchange` need to know which transactions went, and
`ArchiveRequest` is not enough on its own. **The ids come from the surveys,
not from the prune**: each survey publishes `removesIds` — `accounts`
publishes the transactions it is removing — and the plan hands them to every
`prune` as `ArchiveContext.removedIds`.

**Surveys run in two passes.** `exchange` removes a batch only when every
transaction it created is going, so its *survey* needs the ids too — and no
survey ordering can satisfy both it and `accounts`. So `buildArchivePlan`
asks everyone twice: the first pass runs with an empty set and only collects
what each publishes; the second runs with the full set and is the plan. A
participant that ignores the set simply answers the same both times (a test
holds `recurring` to that).

*(An earlier draft had `accounts` fill a shared set as it pruned. That cannot
work while `accounts` also runs last: `recurring` would prune first and read
an empty set. Carrying the ids from the surveys settles it, and keeps the
promise that the plan the user agreed to is the plan that runs.)*

Ordering therefore decides only **when** each participant runs, which still
matters: `accounts` moves the opening balances and checks that no balance
moved, and that must happen after everything else has had its say.

A plugin with no participant is not consulted and keeps all its data; its
collections come across into the archive regardless, because the snapshot is
of the database, not of what plugins declare.

## The archive sequence

Inside `session.exclusive()`, so no *Open*, *Close* or *Delete* can run
between the steps:

| | Step | On failure |
|---|---|---|
| 1 | **Refuse the impossible**: no book open; the book is read-only; a reconciliation is in progress; the cut-off is not a date, is in the future, or is not after `ledger.lastArchivedThrough`; a participant returned a `blocker` | Nothing has happened. The message says which |
| 2 | **Survey** every participant and build the plan: per-participant counts, the per-account transaction counts, the warnings, the total | Nothing has happened |
| 3 | **Confirm**, showing the plan ([The Archive dialog](#the-archive-dialog)) | Cancelled; nothing has happened |
| 4 | **Write and verify the archive** ([The archive file](#the-archive-file)) | The staged file is deleted. The book is untouched |
| 5 | **Prune**, in one `db.transaction`: each participant's `prune` in order, then the balance check | The transaction rolls back; the book is exactly as it was. **The archive file is kept**, and the message says where it is and that nothing was removed |
| 6 | **Record** `ledger.lastArchivedThrough` and flush | Logged; harmless if it fails — the next archive only loses its suggestion |
| 7 | **Report**: a message naming the archive file, what was removed and the new opening date; the tree and the views refresh through the existing `opened`-style change events | — |

Step 5 is deliberately not interruptible and not given a progress bar: it is
one in-memory transaction and one commit. On the seeded 300,000-document
book, backup's own figures put a full snapshot at 174 ms and a load at about
a second, so a whole archive run is seconds, not minutes. The dialog shows a
busy state and the shell stays responsive; if the measurements in phase 5
disagree, the fallback is a modal progress dialog with no cancel.

**Views.** Every domain plugin already rebuilds on data change, but nothing
today announces "a great deal of this book just changed". The book fires a
new `BookChange` variant, `{ type: 'pruned', book, through }`, after step 6;
`accounts`, `recurring` and `exchange` treat it as they treat `opened` and
rebuild their stores. Without it the open register would show rows that are
gone.

## Restoring an archive

An archive is a book, so *Open Book* is enough to read it. But a user who
archived too far, or who needs the old transactions back in the working book,
needs a way back, and there already is one: **the Restore path takes an
archive as well as a backup file**.

- **The Restore dialog lists both.** Its list is the backup folder's
  `.tessera-backup` files, plus the archives in the archive folder, grouped
  under *Backups* and *Archives* and sorted newest first. *Browse…* accepts
  both extensions.
- **`Restorer.inspect` reads either.** For an archive it opens the file
  read-only through the ordinary `probe` and reads `ledger.archive`, giving
  back the same `BackupInfo` shape with `trigger: 'archive'` and `takenAt`
  from the marker. The same refusals apply: a newer `ledger.format`, or an
  installed contributor whose data is newer than it understands, is listed
  with its `problem` and cannot be restored.
- **`Restorer.restore` gains one step for an archive**: having staged and
  verified the copy, it **clears `ledger.readOnly` and `ledger.archive` and
  gives it a fresh `ledger.id`**, with `ledger.restoredFrom` naming the
  archive. The restored book is an ordinary, writable book. An archive that
  stayed read-only after a restore would be useless, and one that kept its id
  would collide with the archive file it came from in the backup ledger.
- **Both targets work.** *Replace the open book* takes the usual pre-restore
  backup of what it is replacing and trashes the old file; *as a new book*
  writes a new file, suggested as `<Book> (restored 2026-11-20).tessera`.
- **The confirmation says what this means**, because restoring an archive
  undoes more than restoring a backup does:

  > **Replace “Home Finances” with the archive from 20 Nov 2026?**
  > The archive holds the book as it was before it was archived through
  > 1 Jan 2026, so everything entered since then is lost. “Home Finances” as
  > it is now is backed up first, then its file is moved to the Wastebasket.

This answers "unarchiving" for the case that matters — *put it back the way
it was* — without any merge. Merging an archive into a book that has moved on
since remains a non-goal.

## The archived period is closed

Archiving makes a promise: *everything before the cut-off is in the opening
balance*. Three things can break it afterwards, and all three come down to a
transaction being created with a date before an account's `openingDate`.

**Why it must not happen by accident:**

- **Double counting.** A reconciled transaction that was removed is already
  inside `openingBalance`. Importing the same row again adds it a second
  time, and the ending balance is wrong by its amount.
- **Duplicate detection cannot help.** The exchange planner finds duplicates
  by `externalId` and by date/amount/payee against transactions in the book
  ([import-export-design.md](import-export-design.md)). After a prune there
  is nothing in the book to match: every archived row looks new. This is the
  heart of it — the protection the user relies on silently stops working
  exactly in the archived window.
- **The register stops making sense.** A row dated before the opening row,
  whose running balance starts from an opening balance that claims to include
  it.

### The barrier

**The per-account barrier is `account.openingDate`**, not the book's cut-off.
It is already the right answer for every case: an account archived to 1 Jan
2026 has that date; an account opened in March 2026 has March; an account the
prune did not touch has whatever it always had, and nothing changes for it.
`BookInfo` also gains `archivedThrough?: string` (from
`ledger.lastArchivedThrough`), pushed with the book state, for the one place
that needs the book-wide answer: telling the user up front that a whole file
is for an archived period.

**Importing.** The exchange planner classifies every row it is about to
propose against the barrier of the account it is going into:

- A statement **whose whole period is before the barrier** is stopped before
  review: *"“rbc-2025-11.qfx” covers 1–30 Nov 2025, which was archived on
  20 Nov 2026. Open the archive to see those transactions."* with
  **[ Cancel ]  [ Import Anyway… ]**.
- A statement **that straddles the barrier** — the common case, a file
  downloaded a little too far back — goes to review with its early rows
  present, **excluded by default**, under their own heading:

  > **Before 1 Jan 2026 — already archived (14 rows, not imported)**
  > These dates are covered by “Chequing”'s opening balance. Importing them
  > would add them a second time. Tessera can't check them against the
  > archived transactions.

  Each row can be ticked individually, as any other excluded row can.
- **Accepting one is allowed**, because the legitimate case is real: a late
  statement for a period that was archived while some of its transactions had
  never been entered. Accepting needs a confirmation naming the sum and the
  effect:

  > **Import 3 transactions dated before the archive?**
  > “Chequing”'s balance changes by −$412.80, and Tessera can't tell whether
  > these are already in the archive.

- **The account's opening date follows them back.** Accepting a transaction
  dated before `openingDate` moves that account's `openingDate` back to the
  new earliest transaction date and **leaves `openingBalance` alone**. The
  opening row stays above every row in the register, and the balance it
  states is still the one the prune computed — the imported rows simply add
  to it, which is exactly what the user asked for. This is the same clamp as
  [Moving the opening balance](#moving-the-opening-balance), running in the
  other direction, and it lives in `accounts.service` where transactions are
  created, so **it holds for every way a transaction can appear** — import,
  the register, a recurring entry, a QIF read.

**Recurring.** A series whose next occurrence is due before the barrier would
quietly re-create what was just archived. Two parts:

- At archive time, `recurring`'s participant **rolls each series forward**
  past the cut-off, recording the occurrences it skipped as postings with
  `outcome: 'skipped'` so the history says what happened rather than going
  silent. This is also what stops the Due list filling with overdue
  occurrences the moment a prune finishes.
- Afterwards, *Enter* on an occurrence dated before the barrier asks the same
  confirmation the import does, and is skipped by *Enter All*.

**Archiving, in the other direction.** The `exchange` participant already
warns about an open import batch with rows before the cut-off
([Participants](#participants)); it also warns about a **pending statement**
(one read but not yet reviewed) whose period reaches before the cut-off, with
the same wording. Neither blocks: both are warnings, because the user may
well mean to abandon them.

## The Archive dialog

*File › Archive…* opens `book.dialog.archive` (`md`), in three parts.

**1. The date.**

> **Archive data before**  `[ 2026-01-01 ▾ ]`
> Transactions before this date that are reconciled or voided are removed
> from “Home Finances” and kept in the archive.

The field is a date picker, prefilled from the suggestion rule
([Options](#options)) — by default **1 January of the current year**. It is
validated as it is typed: a date in the future, or on or before
`ledger.lastArchivedThrough`, disables *Archive* with the reason beneath.

**2. Where the archive goes.**

> **Archive file**  `Home Finances Archive through 2026-01-01.tessera`
> in `/home/tim/Documents/Tessera Archives`   **[ Browse… ]**

The name follows the date as it changes, unless the user has edited it.

**3. What will happen.** Recomputed (through `book:archive.plan`) whenever
the date settles:

> **8,412 transactions** in 6 accounts, **213 recurring postings** and
> **19 import batches** will be removed. Each account's opening balance moves
> to 1 Jan 2026. **No account's balance changes.**
>
> ⚠ **Chequing**: 14 transactions before 1 Jan 2026 are not reconciled
> (oldest 3 Mar 2019). They stay in the book.
> ⚠ **Visa**: 2 transactions before 1 Jan 2026 are not reconciled
> (oldest 11 Nov 2025). They stay in the book.
> ⚠ One import of “rbc-2025-12.qfx” is still open. Its batch is kept.
>
> ▸ **Details** *(a disclosure, closed by default)*
>
> ☐ Back up “Home Finances” first *(shown, and ticked, when the book's last
> backup is older than its last change)*

**Details** opens a table of `ArchivePlan.accounts` — one row per account
with something to remove, showing how many transactions go, and the opening
balance and opening date it will have afterwards. It is closed by default
because the warnings are what needs reading; it is there because "no
account's balance changes" is a claim, and a user is entitled to check it
before agreeing rather than after.

The **backup-first** checkbox appears only when the book has changed since
its last backup, and runs an ordinary *Back Up Now* before step 4. The
archive is itself a complete, verified copy, so this is belt and braces for
users who keep their backups somewhere else — a different drive, say, from
the one the archive is going to.

Then **[ Cancel ]  [ Archive ]**. *Archive* is destructive-styled. Pressing
it asks once more, naming the counts, because the removal cannot be undone
except by restoring:

> **Archive “Home Finances” through 1 Jan 2026?**
> 8,644 records are removed from the book. A complete copy is saved as
> “Home Finances Archive through 2026-01-01.tessera” first, and can be
> reopened at any time — but it can't be changed, and the records can't be
> put back into this book except by restoring it as a new book.
> **[ Cancel ]  [ Archive ]**

The warnings are what the request asks for — "when archiving starts it warns
about unreconciled transactions before the date" — raised at the point the
user picks the date, not after they commit to it.

## Options

The `archive` key of the existing `book` options namespace
([`options.ts`](../packages/book-api/options.ts)), so the page edits one
draft alongside backups:

```ts
export type ArchiveSuggestion = 'startOfThisYear' | 'startOfLastYear' | 'oneYearAgo' | 'twoYearsAgo'

export interface BookArchiveOptions {
  /** Which date the Archive dialog offers. The dialog always lets the user change it. */
  suggest: ArchiveSuggestion
  /** An absolute folder path; null for the default, `<Documents>/Tessera Archives`. */
  folder: string | null
  /** Remove reconciled transactions before the cut-off. */
  removeReconciled: boolean
  /** Remove voided transactions before the cut-off. */
  removeVoided: boolean
}

export const BOOK_OPTIONS_DEFAULTS: BookOptions = {
  backups: { /* unchanged */ },
  archive: { suggest: 'startOfThisYear', folder: null, removeReconciled: true, removeVoided: true }
}
```

`validateBookOptions` grows the matching checks, with the same rules as the
backup folder (absolute path, existence deliberately unchecked). The
suggestion is a **rule, not a date**, so it stays right as years pass
(decision 12); `suggestedCutoff(rule, today)` is a pure function in
`@tessera/book-api/options.ts`, which is what makes it testable across year
ends and leap years. The folder picker is shared as `book:chooseFolder`; each
caller supplies its own starting folder and dialog title.

## The Archive options page

*Tools › Options › Book › Archive*, a second page in the existing `book`
category, built like `BackupsOptionsPage.tsx`:

- **Suggest archiving data before** — a select over the four rules, with the
  date each would give today shown beside it ("1 Jan 2026").
- **Keep archives in** — a read-only path field with *Browse…* and *Use
  Default*, through the existing `book:backups.chooseFolder` channel renamed
  to `book:chooseFolder` (it has nothing backup-specific in it).
- **Remove** — two checkboxes, *Reconciled transactions* and *Voided
  transactions*, with the note that unreconciled transactions are always
  kept. Unticking both shows "Archiving will copy the book without removing
  anything."
- **Last archived** — status, not an option: *“Home Finances” was archived
  through 1 Jan 2026* from `ledger.lastArchivedThrough`, or *Never archived*.

The page reads the active book's `archivedThrough` value as status; with no
book open it asks the user to open one. It edits the shared options draft and
does not apply settings itself.

Keywords for the options search: `archive`, `cut-off`, `transactions`,
`folder`, `reconciled`, `voided`.

## The menu

```ts
{ kind: 'item', id: 'book.file.archive', label: '&Archive…', parent: FILE_MENU,
  group: 'book.backup', command: BOOK_COMMANDS.archive, order: 30 }
```

In the `book.backup` group, as asked, after *Restore from Backup…*:

```
File
  New Book…  Open Book…  Close Book
  ─────────
  Back Up Now   Back Up To…   Restore from Backup…   Archive…
  ─────────
  Delete Book…
```

Enablement is `book.isOpen && !book.isReadOnly`, so it is greyed out with no
book and on an archive. No accelerator: it is a rare, deliberate command.

## Failures and how they are reported

Every failure is a `BookError`, so the IPC passes it on and the command's
`reportingFailures` wrapper shows it.

| Code | When | What the user is told |
|---|---|---|
| `NO_BOOK` | No book open | "Open a book to archive it." |
| `READ_ONLY` | The book is an archive, or on a read-only volume | "“X” can't be archived, because it can't be changed." |
| `ARCHIVE_BLOCKED` | A participant returned a `blocker` — today only "a reconciliation of Chequing is in progress" | The blocker's own message, plus what to do about it |
| `ARCHIVE_NOTHING_TO_DO` | The plan removes no documents | "There is nothing to archive before 1 Jan 2026." — shown in the dialog, not as an error |
| `ARCHIVE_DATE` | The cut-off is in the future, or not after the last one | "“X” has already been archived through 1 Jan 2026. Choose a later date." |
| `ARCHIVE_CHANGED` | A participant removed a different count than its survey promised: the book changed between the plan the user confirmed and the prune (domain writes don't go through the file-operation queue) | "“X” changed while it was being archived, so nothing was removed. Try again. The archive was saved as “…”." The transaction rolls back; the archive, a true copy from moments before, is kept |
| `FILE_EXISTS` / disk errors | The archive cannot be written | The OS message, with the path. The book is untouched |
| `ARCHIVE_VERIFY_FAILED` | The written archive did not reopen, or did not match the snapshot | "The archive couldn't be verified, so nothing was removed from “X”." The staged file is deleted |
| `ARCHIVE_BALANCE_MISMATCH` | The invariant failed (a bug) | "Archiving was stopped because “Chequing” would not have balanced. Nothing was removed. The archive was saved as “…”." Logged with both balance sets |
| A participant threw | Anything in `prune` | "Archiving was stopped by *recurring*: …. Nothing was removed." The archive file is kept |

Every outcome, good or bad, is written to the Problems log with the cut-off,
the counts per participant and the archive path.

## Contracts

### `@tessera/book-api`

```ts
BOOK_META.readOnly             = 'ledger.readOnly'
BOOK_META.archive              = 'ledger.archive'
BOOK_META.lastArchivedThrough  = 'ledger.lastArchivedThrough'

BOOK_COMMANDS.archive          = 'book.archive'
BOOK_COMMANDS.archiveSettings  = 'book.archiveSettings'
BOOK_DIALOGS.archive           = 'book.dialog.archive'
BOOK_ARCHIVE_OPTIONS_PAGE      = 'book.options.archive'

export const DEFAULT_ARCHIVE_FOLDER_NAME = 'Tessera Archives'

/** What `ledger.archive` holds in an archive file. Absent in a working book. */
export interface ArchiveMarker {
  of: string            // the id of the book it was cut from
  ofName: string
  takenAt: string       // ISO
  through: string       // the cut-off, YYYY-MM-DD
  app: string
}

/** What the dialog shows and what the user confirms. */
export interface ArchivePlan {
  before: string
  /** Where it would go; filled in by the Archiver, not by the surveys. */
  file?: string
  documents: number
  /** One line per participant, in run order. */
  parts: { contributor: string, describe: string, documents: number }[]
  /** The Details rows of every participant, each saying which one it came from. */
  rows: (ArchiveRow & { contributor: string })[]
  warnings: ArchiveWarning[]
  blocker?: string
  /** Every survey's `removesIds`, carried into the prune. */
  removedIds: readonly string[]
}

export interface ArchiveOutcome {
  file: string
  before: string
  documents: number
}

/** `BookChange` gains: a large part of the open book was removed; rebuild. */
| { type: 'pruned', book: BookInfo, through: string }

/** `BookInfo` gains two fields, so every plugin can see what the open book is. */
interface BookInfo {
  // …
  /** The cut-off of the most recent archive of this book: `ledger.lastArchivedThrough`. Absent if never archived. */
  archivedThrough?: string
  /** Set when this book *is* an archive: `ledger.archive`. Implies `readOnly`. */
  archive?: ArchiveMarker
}

/** `BackupTrigger` gains `'archive'`, so the Restore dialog can list and label archives. */
export type BackupTrigger = 'auto' | 'manual' | 'pre-restore' | 'archive'

export const ARCHIVE_FILE_FILTER = { name: 'Tessera archives', extensions: ['tessera'] }
```

The one change to the accounts contract is a rule, not a type:
`accounts.service` moves an account's `openingDate` back to the date of any
transaction created before it, leaving `openingBalance` alone
([The archived period is closed](#the-archived-period-is-closed)).

Plus `ArchiveParticipant`, `ArchiveRequest`, `ArchiveSurvey`, `ArchiveRow`,
`ArchiveWarning`, `ArchiveContext`, `ArchiveResult`, `BookArchiveOptions`,
`ArchiveSuggestion` and `suggestedCutoff` as above, and on `BookSession`:

```ts
/** Takes part in archiving. Push the disposable onto your subscriptions. */
participateInArchive(contributor: string, participant: ArchiveParticipant, options?: { before?: string[] }): Disposable
```

### IPC (`book:` channels)

| Channel | Request | Response |
|---|---|---|
| `book:archive.input` | — | `{ book: BookInfo, suggested: string, lastArchivedThrough?: string, folder: string }` |
| `book:archive.plan` | `{ before: string }` | `ArchivePlan` |
| `book:archive.run` | `{ before: string, file: string, backupFirst: boolean }` | `ArchiveOutcome \| undefined` |
| `book:chooseFolder` | `{ current?: string }` | `string \| undefined` *(the renamed `book:backups.chooseFolder`)* |

### `@tessera/types`

No change. `Database.snapshot()`, `load()` and `readOnly` already exist, and
the engine already honours `{ readOnly: true }`.

## Alternatives considered

| Alternative | Why not |
|---|---|
| **The archive is a `.tessera-backup`** | It would not open with *Open Book*, which is the request. Reading one means a restore, which means a writable copy — the opposite of read-only. The backup format stays the right thing for backups, and its machinery is reused here (decision 1) |
| **The archive holds only the removed transactions** | Not a complete copy, so not a safety net (decision 2); and the removed part on its own is unreadable — transfers to accounts that are not there, reconciliations with nothing to reconcile |
| **Keep an "archived" opening-balance *transaction* per account rather than moving `openingBalance`** | A new transaction the user can edit or delete, breaking the invariant, and one the register would have to special-case. The account already has exactly the field this needs |
| **Delete unreconciled transactions before the cut-off too** | Silently settles a figure the user has not agreed to. Warning and keeping is the honest behaviour (decision 6), and it is what the request asks for |
| **Archive one account at a time** | The cut-off is a property of the book's history, and transfers cross accounts: archiving one side of a transfer and not the other is exactly the case decision 7 refuses |
| **Mark read-only with file permissions** | Does not survive a copy, a move to another machine, or a filesystem without them, and would make Tessera change permissions on the user's files |
| **An `archive` plugin of its own** | Needs the unscoped database and the session's serial queue, same as backup ([backup-restore-design.md](backup-restore-design.md#where-it-lives)) |
| **Run the prune outside a single transaction, in batches, with progress** | The kit commits one atomic batch anyway, and the measured numbers do not need it. Batching would mean a half-archived book is reachable |
| **Let participants register in any order** | `recurring` must see what `accounts` removed, and `accounts` must be able to hear objections first. A declared order costs one field and removes a class of bug |

## Open questions

Every question was answered on 2026-11-20, and the answers are folded into
the note above.

| # | Question | Answer |
|---|---|---|
| A | Should archiving offer *and perform* a `.tessera-backup` first, or only link to *Back Up Now*? | **Answered: offer it**, as a checkbox shown and ticked when the book's last backup is stale, since the archive is itself a verified complete copy ([The Archive dialog](#the-archive-dialog)) |
| B | Should the working book remember **which** archive files it produced (paths), so the start view could offer "Open the 2025 archive"? | **Answered: no.** An archive may be on a removable drive, a share or another machine, so a remembered path is wrong more often than right. The book records only `lastArchivedThrough`, a date (decision 16) |
| C | Should an archive be allowed to be *restored over* a working book? | **Answered: yes, through the existing *Restore from Backup…* path.** The Restorer reads an archive as well as a backup file, and the restored copy is writable, with a new id (decision 14, [Restoring an archive](#restoring-an-archive)) |
| D | Should the cut-off be allowed to move **backwards** when the user has no `lastArchivedThrough` (an older book)? | **Answered: yes**, though nothing is expected to need it: the refusal applies only when a previous archive is recorded |
| E | Does `recurring` want to keep every posting regardless, as a history, with only the `transactionId` cleared? | **Answered: no.** Remove them, keeping each series' most recent posting and its source posting |
| F | Should the dialog show per-account rows (it has them in `ArchivePlan.accounts`), or only the warnings? | **Answered: warnings by default, with a *Details* disclosure** listing the accounts, their counts and their new opening balances |
| G | What happens when an import brings rows for a period that has been archived? | **Answered:** the archived period is closed. The barrier is each account's `openingDate`; a wholly-archived statement is stopped before review, a straddling one has its early rows excluded by default, and accepting one is a confirmed, explained act. Accepting moves the opening date back without changing the opening balance, as a rule in `accounts.service` that holds for every way a transaction can be created (decision 15, [The archived period is closed](#the-archived-period-is-closed)) |

## Later

- **A writable copy of an archive** — *File › Save a Copy…* on a read-only
  book, which also solves opening an archive made by an older Tessera.
- **A list of archives** in the Restore dialog's *Archives* group that
  reaches beyond the archive folder — remembering folders the user has
  browsed to, rather than paths to files (decision 16).
- **Scheduled or prompted archiving** — "it has been two years; archive?" at
  a year end.
- **Reports across book and archive**, reading the archive read-only
  alongside the open book, so a five-year chart still works after a prune.
- **Compacting the pruned book** (`VACUUM`, LokiJS rewrite) as a step 7, so
  the file shrinks as well as the data.
- **Removing unused payees and categories**, as a separate tidy-up with its
  own confirmation.
- **Archiving a sub-book** (a closed business, a wound-up estate) rather than
  a date — a different feature that shares the writer.

## Phases

Effort on the scale this repository's other notes use: **S** a day or two,
**M** about a week, **L** two weeks or more, for one developer.

| Phase | Delivers | Effort | Depends on |
|---|---|---|---|
| **0** | *(done)* **Read-only books that say so.** `BOOK_META.readOnly` and `BOOK_META.archive` with `ArchiveMarker`/`isArchiveMarker`; `probe` reading them; `openNow` opening read-only when set, skipping from-0 seeding and refusing real migrations; `BookInfo.archive`; the `book.isArchive` and `book.archiveThrough` context keys and the archive status-bar item (`Lock` added to the standard icons); the backup listeners skipping read-only books; the `frozen` fixture and `tests/plugins/book/readOnly.test.ts` | **S** | — |
| **1** | *(done)* **The archive writer, headless.** `ArchiveWriter.ts`: snapshot → staged new book → `load` → archive meta → rename → reopen → verify, reusing `BackupDisk` (folders) and the Restorer's staging; `naming.ts` (`isIsoDate`, `isoDay`, `archiveFileName`, `archiveStagingName`, `suggestedCutoff`); `ArchiveSuggestion` and `DEFAULT_ARCHIVE_FOLDER_NAME` in `@tessera/book-api`; round trips through real SQLite and LokiJS files. No pruning, no UI: `npm run archive:book` writes an archive and checks the book is unchanged | **M** | 0 |
| **2** | *(done)* **The participant registration and the plan.** `ArchiveParticipants` (validation, declared ordering, cycle detection) and `participateInArchive` on `BookSession`; `buildArchivePlan` from the surveys, with every survey checked before it is believed; `accounts`' `archiveCore.ts` (removability, transfer pairing, the held-by-reconciling guard, stale reconciliations, the opening-balance and opening-date arithmetic) and its participant's **survey** — rows, warnings, blocker and `removesIds`. The prune throws until phase 3, and nothing calls it | **M** | 0 |
| **3** | *(done)* **Pruning.** The `accounts` participant's `prune`: removal, the opening-balance and opening-date adjustment, the per-account invariant checked on the stored post-image, rolling back on any mismatch; `Archiver.ts` (`plan` and `archive` inside `session.exclusive`, one storage transaction, `ARCHIVE_CHANGED` when a participant's count differs from its survey, the archive kept on every rollback); `ledger.lastArchivedThrough`; the `pruned` `BookChange`, with `accounts.announceArchived` fanning out to recurring (via `accounts.onDidChange`) and exchange (via `session.onDidChange`); the headless `book.archive` command taking `{ before }`, confirming with the plan and the warnings | **L** | 1, 2 |
| **4** | *(done)* **The other participants.** `recurring` (old postings with the keep-latest and keep-source rules, `transactionId` cleared on kept postings via `$unset`, every still-due series rolled past the cut-off with `skipped` postings — paused ones included, ending ones ended) and `exchange` (spent batches by the all-rows-removed rule, the open-import and unreviewed-statement warnings), each exposed on its service and registered with `before: ['accounts']`. Made the survey contract **two-pass** so `exchange`'s survey can know what `accounts` removes | **S** | 3 |
| **5** | *(done)* **The dialog and the menu.** `ArchiveDialog.tsx` (date with the main process' own `today`, folder with Browse…, the live plan, warnings, the Details disclosure table, the backup-first checkbox shown only when `Backups.stale` says so); `book:archive.input/plan/run` with the second confirmation, the optional backup and the run all in the main process; `runArchive` shared by the dialog and the headless command; *File › Archive…* in the `book.backup` group; `./ArchiveDialog` exposed in the manifest. Timing a 303,321-document book surfaced and fixed two storage-kit bugs: `$in` was a linear deep-equality scan (now a `Set` for primitive lists) and a transaction's `push(...changes)` overflowed the stack on 100,000+ deletes ([Phase 5 results](#phase-5-results)) | **M** | 3 |
| **6** | *(done)* **Restoring an archive.** `Restorer.inspect` reading an archive as well as a backup file; `BackupTrigger: 'archive'`; the restore clearing `ledger.readOnly`/`ledger.archive` and assigning a new id and `restoredFrom`; the Restore dialog's *Archives* group, its extended *Browse…* and its stronger confirmation | **S** | 1, 5 |
| **7** | *(done)* **The archived-period barrier.** `BookInfo.archivedThrough` and `archive`, pushed with the book state; the `accounts.service` rule that moves `openingDate` back for earlier transaction creation, edits and transfers; the exchange planner's classification, separate whole-file override, straddling-row warning and per-row confirmation; *Enter* confirmation and *Enter All* filtering in `recurring` | **M** | 3, 4 |
| **8** | *(done)* **Options and documentation.** The `archive` options key, defaults and validation; `ArchiveOptionsPage.tsx` and the generic `book:chooseFolder`; [plugin-creation.md](plugin-creation.md) on writing an `ArchiveParticipant`; [import-export-design.md](import-export-design.md) on the barrier; `todo.md`; this note's *Status*. Windows and network-share checks on real hardware remain pending | **S** | 7 |

**Total: about seven to eight weeks for one developer.** Phase 4 can run
alongside phase 5 once phase 3 is in, and phases 6 and 8 alongside 7, which
brings it to about five weeks with two people.

**What must ship together.** The first release has to include **phase 7**:
archiving without the barrier leaves a book whose duplicate detection has a
silent hole in it, which is worse than not archiving. Phases 0–5 are a
usable feature in a demo and not a shippable one. Phase 6 could follow in a
later release — an archive can be opened and read without it, and a user who
needs the data back has the pre-archive backup — but it is a day or two, and
"what if I archive too far?" is the first question anyone will ask.
Phase 3 on its own is safe to land behind no UI, because nothing runs it.

### Tests, by phase

| Phase | What is tested |
|---|---|
| 0 | A book with `ledger.readOnly` opens read-only and sets `book.isReadOnly`; one without opens writable as today; no book id is written to a read-only book; no automatic backup is taken when one closes; an archive whose plan has migration steps is refused with its own message and nothing is written; the title and status text name the archive and its cut-off |
| 1 | The archive round-trips exactly (deep-equal snapshot) on memory, SQLite and LokiJS; its meta holds a new id, `readOnly` and a correct `ArchiveMarker`; the source book is byte-for-byte unchanged; a name collision appends ` (2)` and never overwrites; a staged write that fails leaves no final file and no `.partial`; a corrupted final file fails verification and is deleted; `suggestedCutoff` across all four rules at a year end, in a leap year and on 1 January |
| 2 | Removability: before/on/after the cut-off; each status and the voided flag; both options off, each on; a transfer with one removable side keeps both, with both removable removes both, with a missing partner removes the one; a transaction marked by a reconciliation in progress is never removable; each account's latest reconciliation survives; the warnings list every account with unreconciled transactions before the cut-off, with the right count and oldest date; an empty plan reports nothing to do |
| 3 | **The invariant**: for a seeded book with every account type, currencies, transfers, voided and unreconciled transactions, `current`, `available`, `cleared` and `reconciled` are identical before and after, per account and in total; `transactionCount` falls by exactly the number removed; opening dates move to the cut-off, never backwards, and never past a remaining transaction; an account with nothing removed is untouched including its `rev`; a deliberately wrong adjustment throws and rolls back with nothing changed; a participant that throws rolls back and leaves the archive file; the `pruned` event reaches the accounts, recurring and exchange stores and their views show the pruned data |
| 4 | `recurring` keeps each series' latest and source postings, removes the rest, and leaves no posting pointing at a removed transaction; a series due before the cut-off is rolled forward past it, with one `skipped` posting per occurrence passed over, and the Due list is empty afterwards; `exchange` removes only closed batches entirely before the cut-off, keeps open ones and pending statements and warns about both, and leaves links, rules and profiles alone |
| 5 | The dialog prefills the suggestion and recomputes the plan when the date settles; a future date and a date not after the last archive each disable *Archive* with the reason; the warnings are shown before the user commits; *Details* lists every account with something to remove, with its new opening balance and date; the backup-first box appears only when the last backup is stale, and takes one; cancelling at either confirmation changes nothing; the run reports the file, the counts and the new opening date; each failure in [Failures](#failures-and-how-they-are-reported) shows its message and leaves the files exactly as it says; the menu item sits in the `book.backup` group and is disabled with no book and on an archive; timing recorded in the phase results |
| 6 | The Restore dialog lists archives and backups in their own groups; an archive restored as a new book is writable, has a new id, `restoredFrom`, and no `ledger.readOnly` or `ledger.archive`, and opens with the pre-archive contents; replacing the open book with an archive takes the pre-restore backup first and trashes the old file; an archive from a newer Tessera is listed with its problem and cannot be chosen; the confirmation names what is lost |
| 7 | A transaction created before an account's `openingDate` — by import, by the register, by a recurring entry — moves the opening date back to it and leaves the opening balance unchanged, and the register still draws the opening row first; a statement wholly before the barrier is stopped before review; a straddling statement reaches review with its early rows excluded, counted and headed, and each can still be ticked; accepting one needs the confirmation and names the right sum; the resulting balance is the old balance plus exactly what was accepted; an account the prune never touched imports as it always did, with no barrier message; *Enter All* in `recurring` skips occurrences before the barrier |
| 8 | The page edits the draft and nothing takes effect before Apply; an invalid folder disables Apply; unticking both *Remove* boxes shows the copy-only note; the last-archived line matches the book's meta |

### Phase 5 results

With `npm run archive:book -- --book Household.tessera --prune --factor 200`
(the seeded Household book's transactions repeated 200×, SQLite, WSL2):

| Documents | Book | Plan | Write + verify | Prune (removals) |
|---|---|---|---|---|
| 1,836 | 1.1 MB | 6 ms | 27 ms | 14 ms (1,199) |
| 303,321 | 134 MB | 505 ms | 2,548 ms | 1,525 ms (239,800) |

The whole run on a book far larger than a lifetime's personal finances is
under five seconds, so the dialog shows a busy state and no progress bar —
as hoped. The live plan recomputes in ~half a second even at that size, fast
enough to follow the date field.

