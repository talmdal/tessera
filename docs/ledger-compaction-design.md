# Design and implementation: ledger compaction (Archive Ledger…)

| | |
|---|---|
| **Status** | Proposed 2026-11-10, and reviewed twice the same day ([Decisions taken in review](#decisions-taken-in-review)). **Phase 0 (spike) done** on Linux with Node 24 ([results](#phase-0-results)): the removal, the balance check, `VACUUM`, read-only viewing and the size, with the design changed where it was wrong. **Phase 1 (the archive contract and the accounts rules) done**, with no visible change ([results](#phase-1-results)). **Phase 2 (imports follow the archive) done**, with nothing to see until an archive can be made ([results](#phase-2-results)). **Phase 3 (opening an archive read-only) done**, with `npm run sample:archive` to make one to try ([results](#phase-3-results)); its smoke test in Electron is still to do. **Phase 4 (the Archive Ledger command) done**: File › Archive Ledger…, its dialog and the Archiving page ([results](#phase-4-results)); then, after trying it, transactions can't be entered before an account's last archival date, and the views offer nothing that changes a read-only ledger ([changes](#after-phase-4-entering-transactions-and-read-only-views)). **Phase 5's compaction done**: the file is shrunk after an archive ([results](#phase-5-results)); committing large batches in the driver's worker is still to do. The smoke tests of Phases 3 to 5 in Electron are still to do. [Still open](#still-open): nothing at present |
| **Date** | 2026-11-10 |
| **Scope** | A **File › Archive Ledger…** command, in the same menu group as Back Up Ledger… and Restore Ledger…. It keeps a copy of the open ledger as an archive file, then removes from the ledger the transactions that are no longer needed before a date the user chooses, and the closed accounts left with nothing in them. Each account's opening balance is adjusted so every balance stays as it was. The archive file can later be opened, read-only, to see what was archived, and the ledger's file is shrunk afterwards. A page in the Options dialog sets the date the dialog suggests |
| **Builds on** | [backup-restore-design.md](backup-restore-design.md) (snapshots, the backup file format, one ledger operation at a time, Restore), [account-manager-design.md](account-manager-design.md) (opening balances, balances, transfers, reconciliation), [import-manager-design.md](import-manager-design.md) (import ids and `import.lines`), [storage-engine-redesign.md](storage-engine-redesign.md) (the `storage.engine` contract) |
| **Amends** | [backup-restore-design.md](backup-restore-design.md): a third kind of backup, `archive`, which retention never trims, which Restore lists, and which Open Ledger… opens read-only instead of refusing. [import-manager-design.md](import-manager-design.md): a statement line dated before an account's archive date is left out of an import. [account-manager-design.md](account-manager-design.md): an account gains a *last archival date*, from which its opening balance applies; its opening date stays the date it opened |
| **Layout** | [Part 1](#part-1-design) is the design (*what and why*); [Part 2](#part-2-implementation) is the phased plan (*how and in what order*), in the style of [backup-restore-design.md](backup-restore-design.md) |

- [Summary](#summary)
- [Naming](#naming)
- [Context](#context)
- [Goals and non-goals](#goals-and-non-goals)
- [Decisions](#decisions)
- **Part 1: Design**
  - [The Archive Ledger dialog](#the-archive-ledger-dialog)
  - [Which transactions are no longer required](#which-transactions-are-no-longer-required)
  - [Carrying the balance forward](#carrying-the-balance-forward)
  - [Closed accounts with nothing left](#closed-accounts-with-nothing-left)
  - [What else changes in the current ledger](#what-else-changes-in-the-current-ledger)
  - [Imports after an archive](#imports-after-an-archive)
  - [The copy: a backup of its own kind](#the-copy-a-backup-of-its-own-kind)
  - [Opening the archive file](#opening-the-archive-file)
  - [The archive, step by step](#the-archive-step-by-step)
  - [The Archiving page](#the-archiving-page)
  - [The participant contract](#the-participant-contract)
  - [Compaction: shrinking the file](#compaction-shrinking-the-file)
  - [The File menu, commands and IPC](#the-file-menu-commands-and-ipc)
  - [Where the code goes](#where-the-code-goes)
  - [Security, privacy and robustness](#security-privacy-and-robustness)
  - [Testing](#testing)
  - [Alternatives considered](#alternatives-considered)
  - [Risks](#risks)
  - [Decisions taken in review](#decisions-taken-in-review)
- **Part 2: Implementation**
  - [Ground rules](#ground-rules)
  - [Dependency graph](#dependency-graph)
  - [Phase 0: spike](#phase-0-spike-s)
  - [Phase 1: the archive contract and the accounts rules](#phase-1-the-archive-contract-and-the-accounts-rules-m)
  - [Phase 2: imports follow the archive](#phase-2-imports-follow-the-archive-m)
  - [Phase 3: opening an archive read-only](#phase-3-opening-an-archive-read-only-m)
  - [Phase 4: the Archive Ledger command](#phase-4-the-archive-ledger-command-l)
  - [Phase 5: large commits and compaction in the driver's worker](#phase-5-large-commits-and-compaction-in-the-drivers-worker-m)
  - [Phase 6: later, each scheduled separately](#phase-6-later-each-scheduled-separately)
  - [Documentation changes](#documentation-changes)

---

## Summary

**Archiving keeps a complete copy of the ledger as an archive file, and then removes from the ledger the old
transactions that nothing needs any more. Each account's opening balance takes on what the removed transactions added
up to, so every balance in the ledger is exactly what it was. The copy is never trimmed, and it opens read-only, so the
archived transactions can always be seen again.**

- **File › Archive Ledger…** sits in the backup group, after Back Up Ledger… and Restore Ledger…. Its dialog says what
  will happen, in the words agreed for it, and asks for one date: *Tessera will archive transactions that occurred
  before* [date]. It suggests the start of the current year. A new **Archiving** page in the Options dialog can make
  that another year start (a tax or fiscal year), or keep some earlier years too.
- **Before anything happens, the dialog shows what will be archived,** and **warns about transactions before the date
  that aren't reconciled**, account by account. They stay in the ledger, and the user can cancel and reconcile first.
- **"No longer required" means reconciled or void, and dated before that date.** Those are the transactions whose
  removal can't change any balance: current, cleared, reconciled or available. A transaction not yet reconciled
  stays, however old, because the next statement still needs it. A transfer goes only when both of its sides
  qualify.
- **The opening balance is carried forward.** For each account, the sum of the removed transactions (voids add
  nothing) is added to the opening balance, which becomes the opening balance of the new period. A new field, the
  account's **last archival date**, says when that period starts. The **opening date is unchanged**: it stays the date
  the account opened. The register's first row still reads *Opening balance*, dated the last archival date. The
  arithmetic is checked inside the same storage transaction. If any account's balances would differ by a single cent,
  nothing is removed.
- **Closed accounts with nothing left are removed** along with their transactions, when all of them are archived and
  the balance is zero, so no total changes. The dialog names them, and a check box keeps them instead.
- **Minimum balances are unaffected.** The available balance is the current balance less the minimum, and neither
  changes.
- **The copy comes first.** It is a snapshot of the open ledger, made exactly as a backup is
  ([backup-restore-design.md](backup-restore-design.md#taking-a-backup-copy-the-file-or-something-better)). It is a
  backup of a new kind, `archive`, saved as `Home (archive before 2026-01-01).tesserabkp` in an `Archives` folder inside
  the default backup folder. **Retention never trims it.** Nothing is removed until the copy has been written, checked
  and given its name, and the ledger refuses to remove anything that changed after the copy began.
- **Opening the archive file** (File › Open Ledger…) opens it **read-only**. The user can browse the archived
  transactions, but can't change, back up or archive the copy, and it doesn't join the recent list. Other backups are
  still refused by Open, as today. File › Restore Ledger… lists archives as well, so restoring one in place of its
  ledger undoes an archive.
- **Imports don't bring archived transactions back.** The import plugin keeps its records of the bank lines it has
  seen on and after the archive date. A statement line dated before an account's last archival date is never added, and
  is counted (it can still be matched to a transaction that stayed).
- **The ledger stays domain-free.** It owns the command, the dialog, the copy and the one storage transaction.
  The plugins whose data is archived join in as **archive participants**, as they already do when a sub-ledger is
  deleted. `accounts` removes transactions and closed accounts and carries balances forward, and `import` tidies its
  records.
- **Compaction** comes last: the ledger's file shrinks to fit what is left (SQLite's `VACUUM`, behind a new
  `Database.compact()`). Memory use and opening time drop as soon as the transactions are removed.
- **Phased:** a spike; the contract and the accounts rules; imports; opening an archive read-only; the command
  itself; compaction; then optional later work. The menu item appears only in the phase in which everything its dialog
  promises works.

---

## Naming

| Concept | User-facing name | Code name | Notes |
|---|---|---|---|
| The feature | **Archive** (*Archive Ledger…*) | `archive` | The verb Microsoft Money used for the same feature. In design notes the whole feature is **ledger compaction**: the ledger gets smaller and its balances stay the same |
| The file kept before anything is removed | **archive file** (an *archive* for short), everywhere: the dialog, messages, the Restore dialog, the status bar, Open's file filter | a backup with `backup.kind: 'archive'` | Decided in review, so the dialog and the rest of Tessera use one name. It is a backup underneath, in the backup format and extension ([The copy](#the-copy-a-backup-of-its-own-kind)), but the user never needs to know |
| The date | **archive date** | `before` | Transactions that occurred *before* it may be archived. The date itself is kept |
| The opening balance after an archive | **Opening balance** (unchanged) | `openingBalance` (unchanged field) | The opening balance of the current period: the account's opening balance plus what the removed transactions added up to. See [Carrying the balance forward](#carrying-the-balance-forward) |
| When the current period starts | **Last archival date** | `Account.lastArchiveDate` | The latest archive date that removed anything from the account. Unset for an account never archived |
| When the account opened | **Opened** (unchanged) | `openingDate` (unchanged field) | A historical fact: archiving never changes it (decided in review) |
| Shrinking the file afterwards | **Compacting** | `Database.compact()` | A step of the archive, shown as "Compacting “Home”" |

The command id is `ledger.archive`, the dialog `ledger.dialog.archive`, and the menu label `&Archive Ledger…`. **A**
isn't used by any other item in the File menu (N, O, C, I, B, R, D and X are).

---

## Context

### What exists today

| Facility | Where | What it means here |
|---|---|---|
| **An opening balance is a field, not a transaction** (`Account.openingBalance`, `openingDate`). The register shows it as a fixed first row | [account-manager-design.md](account-manager-design.md#accounts), [Register.tsx](../plugins/accounts/src/renderer/register/Register.tsx) | Carrying a balance forward is a change to one field per account. The opening date is also the date of the register's first row today, so the row needs a date of its own once the opening date stays put ([below](#how-the-register-and-the-account-dialog-show-it)) |
| **Balances:** `current = opening + Σ amount`, `cleared = opening + Σ amount where status ∈ {E, C, R}`, `reconciled = opening + Σ amount where status = R`, all excluding voids; `available = current − minimum` | `balancesFor` and `sumsByAccount` in [transactionsCore.ts](../plugins/accounts/src/privileged/transactionsCore.ts) | Only reconciled and void transactions can be moved into the opening balance without changing any of the four ([below](#why-reconciled-or-void)). The minimum balance itself is a plain field, used only for the available balance and the register's *Available* column: nothing about it depends on past transactions |
| **The running balance** is computed from the opening balance through the rows in date order | `registerOf` in [transactionsCore.ts](../plugins/accounts/src/privileged/transactionsCore.ts) | Rows dated on or after the archive date keep their running balance |
| **Transfers are two linked transactions** with the same date and opposite amounts. Each side is cleared and reconciled on its own, and the service keeps the pair consistent | [account-manager-design.md](account-manager-design.md#transfers) | One side may be reconciled while the other isn't. Removing only one would break the pair |
| **Reconciliations are documents** in `accounts.reconciliations`. A finished one lists the ids it reconciled; one in progress lists the statuses it changed and the charges it added, all of them unreconciled | [reconcileCore.ts](../plugins/accounts/src/privileged/reconcileCore.ts) | A reconciliation in progress never refers to a transaction an archive removes. Finished ones before the archive date refer only to removed transactions |
| **The next cheque number and payee suggestions** are worked out from the transactions in the ledger | `nextNumber`, `searchPayees` in [transactionsCore.ts](../plugins/accounts/src/privileged/transactionsCore.ts) | After an archive, both would forget what was removed unless told |
| **An import recognises a bank line** by its import id: the `externalId` of a transaction in the account, or a record in `import.lines`. A line whose transaction was deleted stays recorded "so it isn't imported again" | `importedBefore` in [run.ts](../plugins/import/src/privileged/run.ts), `viewOf` in [lineState.ts](../plugins/import/src/privileged/lineState.ts) | **Removing a transaction together with its line would let the same statement add it again.** The bank posts a day or more after the user's date, so this matters most around the archive date |
| **A backup is a snapshot** of the open ledger (`Database.snapshot`), checked, written under a temporary name and renamed into place. It has `backup.*` meta, `backup.kind` is `'manual'` or `'auto'`, and the ledger stays open throughout | [BackupService.ts](../plugins/ledger/src/privileged/backup/BackupService.ts), [ledger-api protocol.ts](../packages/ledger-api/protocol.ts) | The archive's copy is made the same way. Only its kind, name and folder differ |
| **Retention** trims backups of the same `ledger.id` that sit **directly** in the default backup folder, after each new backup there | [retention.ts](../plugins/ledger/src/privileged/backup/retention.ts) | An archive copy in that folder would go to the trash after 30 days, taking the only copy of the archived transactions with it. It must be kept somewhere retention doesn't look, and be excluded by its kind too |
| **Restore finds a backup's ledger by `ledger.id`**: the open ledger, then the recent list | `restore.ts` in [backup/](../plugins/ledger/src/privileged/backup/) | An archive copy has its ledger's id. If it were opened like a ledger and added to the recent list, Restore could take it for the ledger itself |
| **Open Ledger… refuses backups**, because opening one writable would upgrade and change it | `inspect` in [LedgerSessionImpl.ts](../plugins/ledger/src/privileged/LedgerSessionImpl.ts) | The dialog promises the archive file can be opened. It can, if it is opened read-only |
| **The storage kit opens a database read-only with a schema without writing anything**: declared collections that are missing are treated as empty | `KitDatabase.open` and `applySchema` in [database.ts](../packages/storage-kit/database.ts) | Viewing an archive needs no new storage feature. The session has never used it, and migrations can't run on a read-only file |
| **Sub-ledger participants:** `ledger` runs one storage transaction and hands each participant a view of it limited to its own collections (`scopedTransaction`). A participant that throws rolls back everything | [SubLedgers.ts](../plugins/ledger/src/privileged/SubLedgers.ts), [scopedDatabase.ts](../plugins/ledger/src/privileged/scopedDatabase.ts) | An archive across `accounts` and `import` can be atomic in the same way, although neither plugin can open a transaction across the other's collections |
| **One ledger operation at a time** (`beginOperation`, `ledger.isBusy`). Backups, restores and imports each take it | [backup-restore-design.md](backup-restore-design.md#one-thing-at-a-time) | An archive is one more operation. No import can run during it, and no file command either |
| **Every `accounts` write is a storage transaction**, serialised by the kit's transaction lock. A transaction fails with `CONFLICT` if a collection changed outside it | [database.ts](../packages/storage-kit/database.ts), `write` in [AccountsServiceImpl.ts](../plugins/accounts/src/privileged/AccountsServiceImpl.ts) | A register edit can't interleave with the archive's removal transaction. It waits for it |
| **SQLite commits synchronously** on the main process, one `BEGIN IMMEDIATE … COMMIT` per batch | [SqliteDriver.ts](../plugins/storage.sqlite/src/privileged/SqliteDriver.ts) | Removing tens of thousands of rows in one commit holds the main process for as long as the commit takes: 1.06 s for 135,000 documents, measured in [Phase 0](#phase-0-results). A worker thread with its own connection does it with the main thread free ([Keeping the window responsive](#keeping-the-window-responsive)) |
| **A SQLite file doesn't shrink when rows are deleted.** Freed pages are reused, and only `VACUUM` gives them back. The kit keeps the whole ledger in memory, so memory and opening time shrink at once | [SqliteDriver.ts](../plugins/storage.sqlite/src/privileged/SqliteDriver.ts), [storage-kit/backend.ts](../packages/storage-kit/backend.ts) | Compaction needs a small storage addition |
| **No reports, budgets or home view yet** | [todo.md](todo.md) | Nothing else reads old transactions today. Later plugins that do will need to take part ([The participant contract](#the-participant-contract)) |

### Why archive at all

A ledger only grows. Each year adds a few thousand transactions, with an import record for most of them. The backup
spike measured the cost of that growth ([backup-restore-design.md](backup-restore-design.md#phase-0-results)):

- opening a ledger blocks the main process while the storage kit loads it, 0.4 to 1 s at 100,000 transactions;
- the register loads every row of an account, because each running balance depends on every earlier row;
- each backup copies everything, all the way back.

Most of that history is settled: reconciled against statements years ago, and never looked at again. Archiving moves
it into a file of its own, where it can still be seen, and leaves a ledger that opens, loads and backs up as if it were
young.

---

## Goals and non-goals

**Goals**

- **Every balance is exactly what it was:** current, cleared, reconciled and available, for every account, and so
  every total and net worth. This is checked, not assumed.
- **Nothing is lost.** Everything removed is in a copy that was written and checked first, that is never trimmed, and
  that can be opened to look at and restored from.
- **Nothing half-done.** The copy is written under a temporary name and renamed. The removal is one storage transaction
  across every plugin taking part, so it happens completely or not at all.
- **Only what is settled goes.** Unreconciled transactions, and transfers with an unsettled side, stay however old
  they are. So does anything a reconciliation or import review in progress still needs. The dialog warns about them
  first, so the user can reconcile and then archive.
- **History stays true.** An account's opening date is still the day it opened, and the balance it opened with is
  kept.
- **Archived transactions never come back by themselves.** Importing an old statement again adds nothing.
- **The ledger plugin stays domain-free.** It never mentions transactions, balances or bank lines.
- **The dialog says what happens,** in the words agreed for it, and shows what will be archived before anything is.

**Non-goals (for now)**

- **Reports across the ledger and its archives.** There are no reports yet. When there are, they can read the archive
  files; see [Phase 6](#phase-6-later-each-scheduled-separately).
- **Archiving part of a ledger** (one account, one sub-ledger). One date for the whole ledger is easier to explain, and
  transfers cross accounts.
- **Summary transactions** (one line per category and year in place of the detail). They need a report plugin to be
  worth anything, and the opening balance already carries the total.
- **Deleting old payees or categories.** Small, still useful for typing, and easy to add later. (Closed accounts with
  nothing left *are* removed: decided in review.)
- **Automatic or scheduled archiving.** It's a deliberate act, a few times in a ledger's life.
- **Merging an archive back into a ledger.** Restoring the archive copy covers undoing an archive.

---

## Decisions

Reviewed on 2026-11-10; the decisions changed or added in review are marked ✓ ([Decisions taken in review](#decisions-taken-in-review)). Each is explained where it lands.

| # | Decision | Where |
|---|---|---|
| 1 ✓ | **The dialog's text is fixed,** as agreed for the feature, with a date chooser labelled *Tessera will archive transactions that occurred before*. The file is called the *archive file*, here as everywhere. The dialog also shows what will be archived, warns about unreconciled transactions before the date, names the closed accounts it removes, says where the archive file goes, and shows its progress | [The Archive Ledger dialog](#the-archive-ledger-dialog) |
| 2 | **Only reconciled and void transactions dated before the archive date are removed.** Unreconciled ones stay, however old | [Which transactions](#which-transactions-are-no-longer-required) |
| 3 | **A transfer is removed only when both sides qualify;** otherwise both stay | [Transfers](#transfers) |
| 4 ✓ | **The opening balance carries the removed amounts forward** and becomes the opening balance of the new period, which starts on the account's new **last archival date**. **The opening date never changes.** The balance the account opened with is kept too | [Carrying the balance forward](#carrying-the-balance-forward) |
| 5 | **Balances are checked inside the removal transaction;** any difference rolls the archive back | [The balance check](#the-balance-check) |
| 6 | **The copy is a backup of kind `archive`,** in an `Archives` folder inside the default backup folder. Retention never trims it, Restore lists it, and Open Ledger… opens it read-only | [The copy](#the-copy-a-backup-of-its-own-kind), [Opening the archive file](#opening-the-archive-file) |
| 7 | **The copy is made, checked and named before anything is removed,** and the removal is refused if the ledger changed after the copy began | [The archive, step by step](#the-archive-step-by-step) |
| 8 | **Archiving is one ledger operation** (`beginOperation`), run from a dialog that stays open and busy until it is done, as Restore's does | [The archive, step by step](#the-archive-step-by-step) |
| 9 | **The ledger orchestrates and plugins participate:** `ledger.session.participateInArchive(contributor, participant)`, with one storage transaction across all of them | [The participant contract](#the-participant-contract) |
| 10 | **The import plugin keeps its record of every bank line dated on or after the archive date,** and never adds a statement line dated before an account's last archival date (it can still be matched to a transaction that stayed) | [Imports after an archive](#imports-after-an-archive) |
| 11 | **Compaction is a storage addition,** `Database.compact()`, run as the archive's last step. If it fails, the archive still stands | [Compaction](#compaction-shrinking-the-file) |
| 12 ✓ | **The suggested date is the start of the current year,** 1 January by default. The Archiving page can change when the year starts and keep earlier years too | [The date](#the-date), [The Archiving page](#the-archiving-page) |
| 13 ✓ | **Closed accounts with nothing left are removed:** closed, every transaction archived, and a zero balance. A check box in the dialog keeps them | [Closed accounts with nothing left](#closed-accounts-with-nothing-left) |
| 14 ✓ | **Only archive files open read-only.** Every other backup is still refused by Open Ledger…, and restored through Restore Ledger… | [Opening the archive file](#opening-the-archive-file) |
| 15 | **The removal keeps the window responsive** ([Phase 0](#phase-0-results)): it deletes by id, never with `$in`; it yields every 2,000 writes; it checks balances with one plain pass; and the SQLite driver commits a large batch in its worker thread. The longest stall at 100,000 transactions is then about 0.14 s | [Keeping the window responsive](#keeping-the-window-responsive) |

---

# Part 1: Design

## The Archive Ledger dialog

### The text

The dialog's wording was given with the feature. It is used as given, with two typing slips corrected ("proecss" and
"backuo"), and with the file called the **archive file**, as it is everywhere else in Tessera (decided in review):

> During the archival process, Tessera makes a copy of your current ledger. Then within the current ledger, Tessera
> removes transactions that are no longer required.
>
> To access the archived transactions later, you can open the archive file.

Then a date chooser, labelled:

> Tessera will archive transactions that occurred before

The first review suggested "archival transactions" and "archived file". The second settled on "archived transactions"
and "archive file", for a small reason each:

- "Archived transactions" are the transactions that were archived. "Archival" describes the process, as in the first
  sentence.
- "Archive file" names the file by what it is: a file holding an archive. "Archived file" could be read as a file that
  has itself been put away.

The rest of this note makes each sentence true:

- *makes a copy of your current ledger*: [The copy](#the-copy-a-backup-of-its-own-kind);
- *removes transactions that are no longer required*: [Which transactions](#which-transactions-are-no-longer-required);
- *you can open the archive file*: [Opening the archive file](#opening-the-archive-file).

### The dialog

`ledger.dialog.archive`, a `shell.dialogs` contribution of the `ledger` plugin, size `md`:

```
┌ Archive Ledger ─────────────────────────────────────────────────────────┐
│ During the archival process, Tessera makes a copy of your current       │
│ ledger. Then within the current ledger, Tessera removes transactions    │
│ that are no longer required.                                            │
│                                                                         │
│ To access the archived transactions later, you can open the archive     │
│ file.                                                                   │
│                                                                         │
│ Tessera will archive transactions that occurred before                  │
│ [ 2026-01-01 ]                                                          │
│ Last archived on 3 Jan 2025, before 1 Jan 2025.                         │
│                                                                         │
│ 1,204 transactions from 6 accounts will be archived.             ← (a)  │
│                                                                         │
│ ┌ ⚠ ──────────────────────────────────────────────────────────┐  ← (d)  │
│ │ 17 transactions before 1 Jan 2026 aren’t reconciled, so they │         │
│ │ stay in the ledger:                                          │         │
│ │   Chequing 9 · Visa 4 · Line of credit 3 · Savings 1         │         │
│ │ 3 reconciled transfers stay with them, until their other     │         │
│ │ side is reconciled.                                          │         │
│ │ To archive them too, cancel, reconcile those accounts, and   │         │
│ │ archive again.                                               │         │
│ └──────────────────────────────────────────────────────────────┘         │
│                                                                         │
│ [x] Remove closed accounts with nothing left: “Old Visa”,        ← (e)  │
│     “ING Savings”                                                       │
│                                                                         │
│ The archive file is saved as “Home (archive before 2026-01-01)”  ← (b)  │
│ in “Documents › Tessera Backups › Archives”.                            │
│                                                                         │
│ ◔ Copying “Home”… 45%                                            ← (c)  │
│                                                   [ Cancel ] [ Archive ]│
└─────────────────────────────────────────────────────────────────────────┘
```

Beyond the agreed text and the date, the dialog has these additions. (a), (b) and (c) were kept in review, and (d)
and (e) were added in it:

- **(a) What will be archived,** worked out again whenever the date changes (after a short pause while typing). It
  comes from the participants' `describe` ([below](#the-participant-contract)), so the user sees the effect of a date
  before choosing it. When nothing qualifies, it says "Nothing to archive before 1 Jan 2026.", and **Archive** is
  disabled.
- **(b) Where the archive file goes,** so "the archive file" in the text is a file the user can find.
- **(c) The step in progress,** beside a spinner, once **Archive** is pressed, as in the Restore dialog: "Copying
  “Home”… 45%", "Checking the copy", "Removing archived transactions", "Compacting “Home”". The spinner is a CSS
  animation, so it keeps moving while the main process is busy.
- **(d) A warning about what isn't reconciled**, shown only when there is something to say: every transaction dated
  before the archive date that stays because it isn't reconciled (uncleared, `E` or `C`), counted by account, and the
  reconciled transfers that stay because of them. It is an `Alert` with `severity="warning"` (`@tessera/ui` has it).
  **It doesn't stop the archive.** Those transactions simply stay, and a later archive takes them once they're
  reconciled. But the user who expected a clean cut at the date sees at once that it won't be one, and can cancel,
  reconcile and come back. The counts follow the date, like (a). See [Unreconciled transactions before the
  date](#unreconciled-transactions-before-the-date).
- **(e) Closed accounts with nothing left,** named, with a check box, ticked by default, shown only when there are
  some. See [Closed accounts with nothing left](#closed-accounts-with-nothing-left).

**Archive** is the only confirmation. Nothing is lost, since the copy is made first, and the dialog says exactly what
happens. This is the same reasoning as Restore's ([backup-restore-design.md](backup-restore-design.md#the-flow)).

### The date

- **A native date input** (`TextField type="date"`), as the register and the account dialog use. `@tessera/ui` has no
  date picker, and this needs none.
- **Suggested: the start of the current year, 1 January by default** (decided in review). On 10 November 2026 that
  is 1 Jan 2026, so 2025 and earlier are archived and this year stays. The [Archiving page](#the-archiving-page) can
  move the start of the year (to 6 April for a UK tax year, or 1 July for a fiscal year), and can keep one or more
  earlier years as well. Someone who archives in January and files their taxes in April might keep one.
- **It can't be later than today.** Transactions dated in the future are never settled history.
- **Any earlier date is allowed,** including one before a previous archive's date. Only what qualifies is removed, so
  archiving twice with the same date removes nothing the second time, except transactions reconciled in between.
- **The previous archive is mentioned** under the date when there is one: "Last archived on 3 Jan 2025, before 1 Jan
  2025." (from the ledger's own record, [below](#the-ledgers-record-of-its-archives)).

### When it can be used

Enabled when a ledger is open, writable and not busy: `ledger.isOpen && !ledger.isReadOnly && !ledger.isBusy`. So it
is disabled during an import, a backup or a restore, and while an archive is being viewed, which is read-only. Opening
the dialog takes the ledger operation ([step 1](#the-archive-step-by-step)), so nothing else starts while it is open.

---

## Which transactions are no longer required

### The rule

A transaction is archived when **all** of these hold:

1. **It is dated before the archive date** (`date < before`; both are `YYYY-MM-DD` strings, so this is a string
   comparison).
2. **It is reconciled, or it is void.**
3. **If it is one side of a transfer, the other side meets 1 and 2 as well.** The two sides share a date, so in
   practice this means the other side is reconciled or void too.

Everything else stays: uncleared (blank), electronically cleared (`E`) and cleared (`C`) transactions, however old.

### Why reconciled or void

The four balances differ only in which statuses they count:

| Balance | Counts |
|---|---|
| current | every non-void transaction |
| cleared | non-void, status `E`, `C` or `R` |
| reconciled | non-void, status `R` |
| available | current, less the minimum balance |

A transaction can be moved into the opening balance without changing a balance only if that balance counts it. The
opening balance is in every balance, so the transaction must be in every balance too. **The only non-void
transactions counted by all three sums are the reconciled ones.** A void transaction is counted by none of them, so
removing it changes nothing either.

If a cleared but unreconciled transaction were archived, its amount would join the opening balance and therefore the
*reconciled* balance, which it was never part of. The next reconciliation would then start from the wrong figure. This
is not a matter of policy: it is the rule that keeps *every* balance the same.

It also matches what the user expects. A reconciled transaction has been checked against a bank statement and is
settled. An old uncleared cheque is still outstanding, and the next statement may still include it.

### Transfers

| Side in this account | Other side | Both dated before the archive date | Outcome |
|---|---|---|---|
| Reconciled | Reconciled | Yes | Both removed; each account carries its own side forward |
| Reconciled | Uncleared, `E` or `C` | Yes | **Both stay**, until the other side is reconciled |
| Void | Void (voiding mirrors to both sides) | Yes | Both removed; nothing to carry |
| A transfer with a deleted account (unlinked, an ordinary transaction now) | none | Yes | Like any transaction |

**Removing one side and unlinking the other** was considered. Delete Account does this, with a note in the memo. It
would change the other side's category and memo, and the other account would show a transfer from nowhere, all for
one transaction that the next archive removes anyway. The dialog counts transfers kept this way, so the user can
reconcile the other account and archive again.

### Worked cases

| Transaction (all dated before the archive date) | Archived? | Why |
|---|---|---|
| Reconciled payment | Yes | Settled |
| Void cheque | Yes | Counted by no balance |
| Void, and reconciled before it was voided | Yes | Void |
| Cleared (`C`), not yet reconciled | No, and warned about | In the cleared balance, not the reconciled one |
| Downloaded (`E`), not yet reconciled | No, and warned about | As above |
| Uncleared cheque from 2023 | No, and warned about | Still outstanding |
| Reconciliation's *Balance adjustment* (reconciled) | Yes | Reconciled |
| Marked during a paused reconciliation (`C`) | No, and warned about | Not reconciled; the reconciliation still needs it |
| Reconciled, with an import review still pending on it | Yes | Reconciled; the review no longer matters ([Imports](#imports-after-an-archive)) |
| In a **closed account**, reconciled | Yes | The archive file holds the account's history now. If nothing is left in the account, the account may go too ([below](#closed-accounts-with-nothing-left)) |
| Dated on the archive date itself | No | "Before" excludes the date |

### Unreconciled transactions before the date

The transactions the rule keeps because they aren't reconciled are exactly what the dialog's warning (d) lists. They
were added in review, so the user sees them before archiving rather than finding them afterwards.

- **Counted:** every transaction dated before the archive date that isn't void and isn't reconciled (uncleared, `E`
  or `C`), by account, closed accounts included. Then, separately, the reconciled transfers kept because their other
  side is one of them.
- **Not counted:** anything dated on or after the archive date, which belongs to the current period whatever its
  status.
- **Worded as what will happen,** not as an error: "17 transactions before 1 Jan 2026 aren’t reconciled, so they stay
  in the ledger". Then what the user can do about it: "To archive them too, cancel, reconcile those accounts, and
  archive again."
- **From the same plan as the archive** (`planArchive`, [below](#the-participant-contract)). The warning can't
  disagree with what happens.

An old uncleared cheque that will never clear (lost, or never cashed) is best voided. It is then archived with the
rest. The warning's text doesn't say this, but the account manager's help for voiding can.

---

## Carrying the balance forward

### The arithmetic

For each account with transactions removed:

```
carried           = Σ amount of the removed transactions that are not void
openingBalance'   = openingBalance + carried
lastArchiveDate'  = the later of lastArchiveDate (if set) and the archive date
openingDate'      = openingDate                          (never changed: decided in review)
```

`openingBalance` is now **the opening balance of the current period**, the period that starts on the account's last
archival date. For an account never archived, that period is the account's whole life, and nothing changes. It is
still the one figure every balance is built from, so `balancesFor`, the register, reconciliation's suggested starting
balance and any future plugin go on using it unchanged. That is why the carried amount goes into this field rather
than a new one.

Every removed transaction that isn't void is reconciled, so `carried` leaves each of the three sums and joins the
opening balance, which all three include. So `current`, `cleared` and `reconciled` are unchanged, and `available`
(`current − minimum`) is unchanged too. Each account's balance is unchanged, so every sub-ledger total, per-currency
total and net worth is too.

The **running balance** of every row dated on or after the archive date is unchanged as well, because every removed
transaction was dated before it. A row that stays but is dated *before* the archive date (an old uncleared cheque) now
comes after the whole carried amount rather than part of it. Its running balance can therefore differ. The balances
that matter, the ones the user compares with the bank, don't.

### An example

Chequing, opened on 1 Jan 2023 with 1,000.00, archived before 1 Jan 2025:

| Before | | | | |
|---|---|---|---|---|
| 2023-01-01 | Opening balance | | | 1,000.00 |
| 2024-03-02 | Landlord | R | −1,200.00 | −200.00 |
| 2024-06-10 | Employer | R | 3,000.00 | 2,800.00 |
| 2024-11-15 | 104 · Plumber | | −150.00 | 2,650.00 |
| 2024-12-20 | Hydro One | V | −80.00 | 2,650.00 |
| 2025-01-05 | Employer | R | 3,000.00 | 5,650.00 |

Current 5,650.00 · Cleared 5,800.00 · Reconciled 5,800.00

Removed: Landlord and Employer (reconciled, −1,200.00 + 3,000.00 = 1,800.00 carried), and Hydro One (void, nothing
carried). Kept: cheque 104 (uncleared, and listed in the dialog's warning) and everything from 2025.

| After | | | | |
|---|---|---|---|---|
| 2025-01-01 | Opening balance | | | 2,800.00 |
| 2024-11-15 | 104 · Plumber | | −150.00 | 2,650.00 |
| 2025-01-05 | Employer | R | 3,000.00 | 5,650.00 |

Current 5,650.00 · Cleared 5,800.00 · Reconciled 5,800.00, all as before. The account still opened on 1 Jan 2023, and
its last archival date is 1 Jan 2025.

### Minimum balances

**Archiving doesn't affect an account's minimum balance** (asked in review). The minimum (`minimumBalance`) and *Show
the balance above the minimum* (`showAvailableBalance`) are fields of the account, and archiving doesn't touch them.
The available balance is `current − minimum`, and the current balance is unchanged, so:

- the navigator shows the same figure, actual or available;
- the register's header shows the same *Available (above 500.00)* figure;
- the register's *Available* column is unchanged for every row dated on or after the archive date. The first row shows
  the new opening balance less the minimum, as it does today for the opening balance;
- an account that was under its minimum is still under it, in red, and one that wasn't, still isn't.

Nothing in Tessera looks back through past transactions to see whether an account *was* under its minimum, so no
history is lost. If a report ever does, that history is in the archive file, as all history before the archive date
is.

### The balance check

The accounts participant doesn't trust the arithmetic; it checks it. **Inside the removal transaction**, it works out
every account's four balances before it removes anything, and again afterwards from the transaction's own view of the
collections. It also compares the **total per currency** over the whole ledger, which is what catches a removed closed
account that still had a balance ([below](#closed-accounts-with-nothing-left)). And it checks that no transfer has lost
its other side. If any account or total differs, or any pair is broken, it throws, and the whole archive rolls back:
nothing is removed from any plugin. The copy made beforehand is then deleted, since it records an archive that didn't
happen ([step 7](#the-archive-step-by-step)).

The check sums the transactions **in one plain pass over the documents**, before the removal (the documents the plan
was made from) and after it (the transaction's view of what is left). It doesn't use the kit's aggregate, which
`sumsByAccount` uses for the register. At 100,000 transactions the aggregate took 0.35 s each time and the loop 19 ms,
with the same sums every run ([Phase 0](#phase-0-results)). The loop is `sumTransactions(docs)`, a pure function in
`accounts`, and a test holds it equal to `sumsByAccount` on random ledgers, so the check and the register can never
disagree about what a balance is. It turns the promise in the dialog into something Tessera checks every time.

### What the account records

`Account` (in `@tessera/accounts-api`) gains two optional fields, set the first time transactions are archived from the
account and updated by each archive that removes anything from it:

```ts
export interface Account {
  // …
  /** When the account opened. Never changed by archiving. */
  openingDate: string
  /** The opening balance of the current period: from `lastArchiveDate` if set, else from `openingDate`. */
  openingBalance: number
  /**
   * The last archival date (YYYY-MM-DD): the latest archive date that removed anything from this account, and so the
   * start of its current period. Every transaction archived from it was dated before. Unset if none ever was.
   */
  lastArchiveDate?: string
  /** What archiving has taken out of the account, over every archive. Set with `lastArchiveDate`. */
  archived?: AccountArchived
}

export interface AccountArchived {
  /** How many transactions have been archived from the account, in all. */
  count: number
  /** The balance the account opened with on `openingDate`, before the first archive carried anything into it. */
  originalOpeningBalance: number
  /** The highest numeric transaction number archived, so the next cheque number suggested still follows it. */
  highestNumber?: number
}
```

Both are written in the same storage transaction as the removal, by the archive only: `AccountInput` and
`AccountPatch` don't accept them. No schema version change is needed, because they are optional fields, and older
versions of Tessera ignore them.

### How the register and the account dialog show it

- **The register's first row still reads *Opening balance*** (decided in review): it is the opening balance of the
  period the register shows. It is **dated the last archival date** when there is one (or the opening date, if that
  is later), and the opening date otherwise. Its tooltip, once the account has been archived: "The opening balance on
  1 Jan 2025, the last archival date. 1,204 earlier transactions are in the archive file. The account opened on 1 Jan
  2023 with 1,000.00."
- **The account dialog** keeps *Opened* as the date the account opened, editable as today. Its *Opening balance*
  field is the current period's, with a line under it once the account has been archived: "On 1 Jan 2025, the last
  archival date. The account opened with 1,000.00." The last archival date is shown there, and can't be edited.
  Changing the opening balance still changes every balance, as it always has.
- Rows dated before the last archival date that stayed (the cheque above) appear after the first row, in date order.

### Entering transactions after an archive

Decided after Phase 4: **nothing new can be dated before an account's last archival date.** That period's history is
in the archive file, and the opening balance stands for it. A transaction dated inside it would belong to no period:
the archive file doesn't have it, yet the register would list it before the opening balance's date. Imports already
leave out statement lines dated before it ([Imports after an archive](#imports-after-an-archive)); typing one in is
now held to the same date.

The accounts service checks it wherever a transaction is written (`checkArchivePeriod` in `transactionsCore.ts`), so
the register, the statement dialog, imports and other plugins all meet the same rule:

| Writing | Before the account's last archival date |
|---|---|
| A new transaction | **Refused**, on the date field: "“Chequing” has been archived before 1 Jan 2025, so its transactions must be dated 1 Jan 2025 or later." |
| A transfer | Each side is held to **its own account's** date. An account that has never been archived (nothing was removed from it) has none |
| Editing one dated on or after the date | Moving it before the date is refused |
| Editing one that **stayed from before the date** (it wasn't reconciled when archived) | **Allowed**, its date included, as long as it stays in the old period or moves into the new one. That is the cheque the bank cashed late: it must still be cleared and reconciled |
| A statement's service charge or interest | Refused, on the dialog's field |
| Accepting an imported match | The transaction takes the bank's date, **unless that would move it before the date**: then it keeps its own (the bank posted it on 31 December; the user entered it on 2 January). The Accept button's tooltip says which |
| The adjustment that completes a reconciliation | Not held: the reconciliation makes it, on the statement's date. A statement from before the archive date, reconciled afterwards, balances as usual |

In the register, a new transaction starts on the last archival date at the earliest, and its calendar starts there.

---

## Closed accounts with nothing left

Added in review. **A closed account is removed, with its transactions, when archiving would leave it empty.** Its
history is in the archive file, and it has nothing to show in the current period. All of these must hold:

1. **It is closed** (`closed: true`).
2. **This archive removes every transaction it has.** That means all of them are reconciled or void and dated before
   the archive date, with any transfer's other side qualifying too. An account that never had a transaction qualifies.
3. **Its balance is zero.** Closed accounts still count in totals, and an account can be closed with a balance after
   a confirmation (a written-off debt, say). Removing one with a balance would change a sub-ledger total and net
   worth. So such an account stays, and the dialog says why: "“Old Visa” is closed, but stays: its balance isn’t
   zero."
4. **No reconciliation is in progress or paused on it.**
5. **The dialog's check box (e) is ticked,** as it is by default. Someone who likes to keep closed accounts in the
   navigator (under *Show closed accounts*) can untick it, and those accounts stay with a zero opening balance.

A closed account with reconciled transactions dated on or after the archive date stays. Those transactions belong to
the current period. The next year's archive removes the account.

What goes with it, in the same storage transaction:

| Data | Where | What happens |
|---|---|---|
| The account | `accounts.accounts` | Removed. Its name is free again. Its sub-ledger stays, even if now empty |
| Its transactions | `accounts.transactions` | Archived as above |
| Its reconciliations | `accounts.reconciliations` | Removed |
| Its saved account matches, line records and batches | `import.accountLinks`, `import.lines`, `import.batches` | Removed by the import participant, which finds the account in `AccountsArchived.removedAccountIds` ([The participant contract](#the-participant-contract)). A statement for that account would now ask which account it is for, as for any account Tessera doesn't know |

After the commit, `accounts` lists the account in `AccountsChange.deleted`, exactly as Delete Account does, so any
plugin holding a reference to it drops it. The [balance check](#the-balance-check) confirms that no total changed.

---

## What else changes in the current ledger

| Data | What happens | Why |
|---|---|---|
| **Finished reconciliations** whose statement date is before the archive date | Removed, **except** the one the account's `lastReconciled` names | Every transaction they reconciled is gone, and the copy holds them. Keeping the last one keeps the record *Reconcile…* starts from. A future *Undo last reconciliation* ([todo.md](todo.md)) refuses one whose transactions were archived |
| **A reconciliation in progress or paused** | Unchanged | It refers only to unreconciled transactions, which stay ([Worked cases](#worked-cases)) |
| `Account.lastReconciled` | Unchanged | The reconciled balance is unchanged, so the next statement starts from the same figure |
| `Account.minimumBalance`, `showAvailableBalance` | Unchanged | See [Minimum balances](#minimum-balances) |
| `Account.openingDate` | Unchanged | The date the account opened is a historical fact |
| **Payees** | Kept, all of them | Small, and still offered while typing. A payee used only in archived transactions loses its "last used" amount and category in the suggestions; see [Phase 6](#phase-6-later-each-scheduled-separately) |
| **Categories** | Kept | As above |
| **The next cheque number** | Still follows the highest number, archived ones included | `nextNumber` also considers `archived.highestNumber` |
| **Closed accounts that keep something** | Archived like any other. Their opening balance changes even though a closed account refuses edits | The archive isn't a user edit: no balance changes. The participant writes directly, not through `updateAccount` |
| **Closed accounts with nothing left** | Removed | See [Closed accounts with nothing left](#closed-accounts-with-nothing-left) |
| **Open accounts with nothing left** | Kept, with only their opening balance | They are still in use |
| **Sub-ledgers** | Unchanged, even if now empty | They hold no transactions, and the user made them |

After the removal commits, `accounts` announces one `AccountsChange`. It lists every account it touched in
`updated` and `balances` (with `transactions` and `chart` set) and every account it removed in `deleted`. Registers
reload and the navigator redraws; neither shows a different balance.

---

## Imports after an archive

### The problem

An import recognises a bank line it has seen before by its **import id**. That is the bank's id (OFX `FITID`), or a
fingerprint of the line, and it is found either:
- as the `externalId` of a transaction in the account; or
- as a record in `import.lines`, which is kept even after the user deletes the transaction, so that it isn't
  imported again.

Removing an archived transaction removes the first. If the archive also removed the second, importing an old
statement again, on purpose or by mistake, would add every archived transaction back. Those amounts are already in the
opening balance, so every balance would be wrong by their total.

Keeping every line record forever would be safe, but import records are a large part of a ledger: the backup spike
found ledgers about twice the size first assumed because of them. Archiving should shrink them too.

### The rule

Two halves that fit together:

1. **The import plugin removes only the records of lines dated before the archive date.** A line record goes when its
   `bank.date` is before the archive date, its account's last archival date is now on or after the archive date (so
   rule 2 covers the line), **and** either:
   - its transaction (`transactionId`, or `proposedId` for a proposal) was removed by this archive; or
   - it was skipped by the user (`outcome: 'skipped'`). In an account the archive removed nothing from, the account
     has no new last archival date, and a skipped line's record is all that keeps it from being added again, so it
     stays.

   Every other record stays, including those whose transaction was archived but whose **bank date is on or after**
   the archive date. Banks post a day or more after the date the user entered, so a transaction dated 30 December may
   be a bank line dated 2 January. Its record keeps that line from coming back. It shows as `gone` in the register,
   which is how a line whose transaction was deleted already shows.
2. **An import never adds a statement line dated before its account's last archival date**
   (`Account.lastArchiveDate`). Those are exactly the lines whose records may have been removed. They are counted in a
   new `ImportCounts.archived`, with the date in the report, and the summary says: "12 transactions added to
   “Chequing”, 3 left out as dated before 2025-01-01 (the last archival date)."

   **Such a line can still be proposed as a match** for a transaction that stayed (built this way in Phase 2, where
   the first draft left it out entirely). The warning before an archive tells the user that unreconciled transactions
   stay: an old uncleared cheque, say. When the bank at last clears it, the clearing line may be dated before the
   archival date, and leaving it out would mean the import could never match it. A proposal adds nothing until the
   user accepts it in the register, so it can't bring an archived transaction back.

A line left out by the second half is never a transaction the user is missing without knowing it. It is dated in a
period that was reconciled against the bank's statements, so a missing transaction would have shown up as a
difference when that statement was reconciled. If the user really does need one, they can enter it by hand: only
imports are held to the archival date.

### What else the import plugin does

| Record | What happens |
|---|---|
| `import.batches` | A batch with no lines left is removed. Others stay, with their counts as they were |
| A **pending review** whose transaction was archived (possible only if the user reconciled it before reviewing it) | Removed with its line, if its bank date is before the archive date; otherwise it shows as `gone`. The review no longer matters: the transaction is settled |
| A **proposal** | Never affected. Proposals are only made to unreconciled transactions, which stay |
| `import.accountLinks`, and the lines and batches of an account | Unchanged, except for a [closed account removed](#closed-accounts-with-nothing-left) by the archive: all of its records go |
| `import.payeeAliases`, `import.memory` | Unchanged |

The import plugin needs to know which transactions and accounts `accounts` removed. It learns this from `accounts`'
result, which the ledger passes along in the same transaction ([The participant contract](#the-participant-contract)).

---

## The copy: a backup of its own kind

### Made as a backup is

The copy is a snapshot of the open ledger, made by the storage engine while the ledger stays open. It is consistent
and self-contained, checked by the engine, written to `<name>.partial` and renamed into place, exactly as
[Backing up](backup-restore-design.md#backing-up) describes. The same `BackupService.backUpDatabase` makes it, with
one new kind:

```ts
export type BackupKind = 'manual' | 'auto' | 'archive'
```

and one extra meta key written into the copy only:

| Key | Value | Used by |
|---|---|---|
| `backup.kind` | `'archive'` | Retention (never trimmed), Open (read-only), Restore (listed as an archive) |
| `backup.archiveBefore` | The archive date, `YYYY-MM-DD` | The title and status bar when it is opened, the Restore dialog, the ledger's record |
| `backup.takenAt`, `backup.ledgerName`, `backup.ledgerPath`, `backup.takenWith` | As for every backup | As for every backup |

The copy is the **whole ledger as it was just before archiving**. It contains the transactions about to be removed,
everything that stays, and every other plugin's data. So it is a complete backup as well as the archive.

### Name and folder

- **Name:** `<ledger name> (archive before <date>).tesserabkp`, such as `Home (archive before 2026-01-01).tesserabkp`.
  If that name is taken, ` (2)` is added, as for backups.
- **Folder:** **`Archives`, inside the default backup folder**, for example
  `Documents\Tessera Backups\Archives`. It is created if missing.

Why a folder of its own:

- **Retention only looks at files directly in the default folder**, not in subfolders. An archive there can't be
  trimmed, even by a version of Tessera from before this feature, which doesn't know the `archive` kind.
- **Retention also skips any backup whose kind is `archive`,** wherever it is, in case the user moves one into the
  default folder. One safeguard is structural, the other explicit.
- **The user can find archives** apart from the stream of automatic backups, and the Backups page can say "Archives
  are kept in the Archives folder, and never removed."

Choosing another folder in the dialog (*Change…*) is left for later (decided in the second review).

### Never trimmed, listed by Restore

- **Retention never trims an archive** (above). Moving or deleting one is up to the user.
- **The Restore dialog lists archives,** from the `Archives` folder, after the backups in the default folder. Each is
  labelled "Archive before 1 Jan 2026 · made 10 Nov 2026". It can be restored:
  - **in place of its ledger**, which **undoes the archive**: the ledger comes back exactly as it was before archiving,
    with the current file kept under another name, as for any restore. Changes made since the archive are in the kept
    file, not in the restored one, and the dialog already says so ("opens again as it was in this backup");
  - **as a new ledger**, which gives a complete, writable ledger with everything in it and an id of its own.

### The ledger's record of its archives

The live ledger keeps a small record of each archive in its own new collection, `ledger.archives`, written in the
removal transaction. It sits beside `ledger.subledgers` as part of the ledger format. Declaring a collection needs no
migration:

```ts
interface ArchiveRecord {
  /** The archive date. */
  before: string
  /** When the archive was made, ISO 8601 UTC. */
  archivedAt: string
  /** The copy, as it was saved: its path may have changed since. */
  copy: { path: string, takenAt: string }
  /** What each participant removed, for the user: "1,204 transactions from 6 accounts". */
  summaries: string[]
}
```

It gives the dialog "Last archived…", and [Phase 6](#phase-6-later-each-scheduled-separately) the list for *Open
Archive…*. The copy itself doesn't contain its own record, because the copy is made first.

---

## Opening the archive file

The dialog says *you can open the archive file*. **File › Open Ledger…** opens it, **read-only**. Open Ledger… still
refuses every other kind of backup, and points to Restore.

### Only archive files

Asked in review: does opening archives read-only let other backups be opened read-only too? **No.** `inspect` lets a
file through to a read-only open only when its `backup.kind` is `'archive'`. A manual or automatic backup is refused
as it is today ("… is a backup, not a ledger. Use File › Restore Ledger… to restore it."). The reasons to keep it that
way, for now:

- **A backup's job is to be restored,** and Restore Ledger… already shows what each one is before anything changes.
  An archive's job is to be looked at, which is what the dialog promises.
- **Retention trims ordinary backups,** and it could try to trash one while it is open for viewing. On Windows that
  fails (the file is held). Elsewhere it succeeds, and the window is left showing a file that is gone. Archives are
  never trimmed, so the problem doesn't arise for them.
- **The mechanism is the same,** so allowing it later is a small change: the one check in `inspect`, and retention
  skipping the open file. A *View* button in the Restore dialog, to look inside a backup before restoring it, would be
  the natural way in. It is listed in [Phase 6](#phase-6-later-each-scheduled-separately).

### Why read-only

Opened writable, an archive would be upgraded, switched to WAL mode and edited, and would stop being the record of
what was archived. That is why Open refuses backups today
([backup-restore-design.md](backup-restore-design.md#open-ledger-refuses-backups)). Opened read-only, it is never
written to. The storage kit already opens a database read-only with the ledger's schema without writing anything. A
backup is in SQLite's `DELETE` journal mode. **The [Phase 0 spike](#phase-0-results) confirmed it** through the real
kit, at 10,000 and 100,000 transactions, with a newer schema, on a file the OS marks read-only and in a folder the user
can't write to:
- every kind of write was refused with `READ_ONLY`;
- the file's bytes and modification time never changed;
- no side file ever appeared.

A file in WAL mode is different. Opened read-only, it leaves an empty `-wal` and a 32 KB `-shm` beside it, though
its own bytes don't change. An archive is only in WAL mode if another SQLite tool switched it, so `inspect` reads the
mode from the file's header (byte 18 is 2 for WAL and 1 otherwise, as the spike's files showed), and the open is
logged with a warning. It still opens: the two files left beside it are empty and harmless. (The first draft had Open
say so in a message; a case this rare, and this harmless, doesn't need one.)


### What the user sees

- **It opens like a ledger.** The ledger that was open closes (and is backed up as it closes, if it changed), as with
  any Open. The navigator, registers and balances all work, and the archived transactions are there.
- **A status item** says what it is: "Archive of “Home”, before 1 Jan 2026 · read-only", with the path in its
  tooltip.
- **Everything that would change it is disabled**, through the existing `ledger.isReadOnly` key and a new
  `ledger.isArchive`:
  - New Transaction and Import… (already disabled when read-only);
  - in the views, since Phase 4's review: the register's entry row, editing, its context menu (none opens), the keys
    that change rows, and the toolbar; a reconciliation the archive was saved in the middle of, which the register
    doesn't resume; the Accounts navigator's New, Edit, Close, Reopen, Move and Delete, and its reconcile options; the
    Ledger panel's New, Rename and Delete. The views learn it from `Chart.ledger.readOnly`, `RegisterView.readOnly`
    and `LedgerTree.ledger.readOnly`. (The commands were already disabled, but the views offered them anyway, and
    running one said only "Command is disabled");
  - **Back Up Ledger…**: a backup of an archive would carry the ledger's id and a new date, and retention and Restore
    would then take the old contents for the ledger's latest backup;
  - **Archive Ledger…**;
  - **Delete Ledger…**, so an archive isn't sent to the trash by mistake. It can still be deleted in the file manager.
- **It never joins the recent list, and isn't reopened at the next start.** The recent list, and Restore's search for
  a backup's ledger, go by `ledger.id`, which the archive shares with its ledger. For the same reason the session
  leaves `id` off an open archive's `LedgerInfo`.
- **It is never backed up as it closes,** nor in the first pass of a user quit. The automatic backup skips an open
  archive: it can't have changed, and having no id, it would otherwise count as never backed up.
- **Restore can restore it while it is open:** in place of its ledger, that undoes the archive; as a new ledger, it
  gives a writable copy. The ledger it came from is found by its id, which the open archive doesn't claim.
- **Open Ledger…'s file dialog** gains a filter, "Tessera archive (*.tesserabkp)", after "Tessera ledger".

### An archive made by an older version of Tessera

A read-only file can't be migrated. When opening one needs a migration:

- **A contributor the archive doesn't have at all** (a plugin installed since) has no data in it. Its migration from 0
  is skipped, and its collections read as empty.
- **A contributor whose data is at an older version** can't be shown correctly without upgrading. Open refuses, with a
  way forward: "“Home (archive before 2026-01-01)” was made by an earlier version of Tessera. To open it, restore it as
  a new ledger with File › Restore Ledger…." Opening an upgraded temporary copy instead is in
  [Phase 6](#phase-6-later-each-scheduled-separately).

### Plugins that write when a ledger opens

Some `opened` listeners write. The import plugin settles interrupted imports, and the ledger gives an older ledger an
id. Each must check `ledger.readOnly` first. `identify` already does. [Phase 3](#phase-3-opening-an-archive-read-only-m)
finds the rest, by opening a read-only copy with every bundled plugin active, and fixes them. The storage engine is the safety net: a write to a
read-only database fails with `READ_ONLY`, so a missed guard shows up as an error in the log, and never as a change to
the archive.

---

## The archive, step by step

**File › Archive Ledger…** (`ledger.archive`) runs as **one ledger operation**. The dialog carries out the archive
itself over IPC, so it can stay open and busy, as the Restore dialog does:

| Step | Shown as | On failure |
|---|---|---|
| 1. **Begin the operation:** `beginOperation('Archiving “Home”')`. Held until the dialog closes, and until any archive it started has finished, even if the window closes first | (menu items greyed out) | Another operation is running: the message says which, and nothing opens |
| 2. **The dialog.** The user picks the date (suggested by the [Archiving page](#the-archiving-page)). They see what would be archived, with any warning (`ledger:archive.preview`), choose whether to remove closed accounts with nothing left, and press **Archive** (`ledger:archive.run`). Cancel ends here | | |
| 3. **Note the ledger's change count** (a counter the session advances on every committed change) | | |
| 4. **Copy:** `db.snapshot` to `<Archives>/<name>.tesserabkp.partial`, with `kind: 'archive'` and `backup.archiveBefore`, in the session's file-operation queue | Copying “Home”… 45% | The partial file is removed; nothing has changed. The message gives the reason, as for a backup ("The folder “E:\Backups” isn’t available.") |
| 5. **Check the copy:** `engine.readMeta` must show the ledger's format, id, `backup.takenAt` and `backup.archiveBefore` (the engine has already run its integrity check) | Checking the copy | As above |
| 6. **Name it:** rename into place, with the retry policy for held files | Checking the copy | As above |
| 7. **Remove, in one storage transaction,** through the raw database, with each participant given a view scoped to its own collections ([The participant contract](#the-participant-contract)): <br>a. refuse if the change count moved since step 3; <br>b. each participant's `archive`, in order; <br>c. the ledger's `ledger.archives` record | Removing archived transactions | Everything rolls back; nothing is removed from any plugin. **The copy is deleted** (it is ours, and it records an archive that didn't happen), and the message says nothing changed. If the change count moved, steps 3 to 7 run once more before giving up with "“Home” changed while it was being copied. Try again." |
| 8. **Tell the participants** (`committed`), so `accounts` announces its change and `import` redraws its marks; fire `onDidArchive` | | (Logged; the archive stands) |
| 9. **Compact** ([Phase 5](#phase-5-large-commits-and-compaction-in-the-drivers-worker-m)) | Compacting “Home” | Logged; the archive stands, and the file is just larger than it needs to be |
| 10. **Done:** the dialog closes, and a message confirms it | | |

The message:

> **“Home” has been archived.**
> Removed, all dated before 1 Jan 2026: 1,204 transactions from 6 accounts, and 2 closed accounts with nothing left;
> 310 imported bank lines. Each account’s balance was carried into its opening balance, so every balance is as it
> was. The archived transactions are in the archive file “Home (archive before 2026-01-01).tesserabkp”, in
> “C:\Users\tim\Documents\Tessera Backups\Archives”. To see them, open that file with File › Open Ledger….

The list after "Removed" is each participant's summary, in order, so a plugin added later says what it removed in
its own words (the first draft's single sentence could only speak for the accounts).

The status bar also says "Archived “Home” before 1 Jan 2026" for a minute, through `ledger.activity`, as backups do.

### Keeping the window responsive

The [Phase 0 spike](#phase-0-results) found that step 7, written the obvious way, holds the main process for all of
its 2.8 s at 100,000 transactions. Every `await` inside a kit transaction resolves at once, so the event loop never
turns, and the SQLite commit that follows is synchronous. The window freezes, and so do menus and every other window's
IPC. Four rules bring the longest stall down to about 0.14 s at 100,000 transactions, and 20 to 30 ms at 10,000, with
the same total time:

1. **Delete by id, one `deleteOne({ id })` at a time.** The kit finds a document by id directly. **Never
   `deleteMany({ id: { $in: ids } })`**: the kit compares every document with every id in the list, which took 1.5 s
   at only 10,000 transactions and grows with the square of the ledger.
2. **Yield every 2,000 writes** (`await new Promise(setImmediate)`), and between the steps: reading, planning, the
   checks, each participant. The transaction still holds the kit's transaction lock, so no other write can slip in.
   The event loop simply gets to turn, so the spinner's messages, menus and other windows carry on.
3. **The balance check is a plain sum** over the documents, not the kit's aggregate: 19 ms instead of 0.35 s at
   100,000 ([The balance check](#the-balance-check)).
4. **A large commit runs in the SQLite driver's worker thread.** The driver applies a batch of 5,000 changes or more
   through a second connection in its worker thread, the one that already finishes snapshots. It does this while the
   kit holds its commit lock, as it does for every commit, so nothing else can write meanwhile. `StorageBackend.commit`
   is already asynchronous, so the contract doesn't change; only the SQLite driver does. At 100,000 transactions this
   turned a 1.06 s freeze into a 52 ms one, most of it copying the list of changes to the worker. Smaller batches,
   which is every ordinary edit, stay on the main thread, where they take a few milliseconds.

One stretch can't be split: reading the transactions (`find()` clones every document, 128 ms at 100,000). That is
what the remaining stall is.

The first three are the accounts and import participants' own code
([Phase 1](#phase-1-the-archive-contract-and-the-accounts-rules-m)). The fourth is a change to the SQLite driver,
made with compaction ([Phase 5](#phase-5-large-commits-and-compaction-in-the-drivers-worker-m)), which uses the same
worker.

### Why the copy always holds everything removed

A snapshot is "one consistent state of the database, from some moment between the call and the promise resolving"
([the storage contract](backup-restore-design.md#the-storage-contract-snapshot-and-readmeta)). Writes carry on during
it. So a change committed *during* the copy may or may not be in it. Step 7a closes that gap. If nothing has been
committed since step 3, the copy is exactly the state the removal starts from, so every transaction removed is in it,
as it was.

The window is short and nothing is expected to write in it. The dialog is modal, so the register is behind it, and the
operation keeps imports and file commands out. The check is a guarantee, not a common path. Once step 7 is running, the
kit's transaction lock keeps every `accounts` write out until it commits, and its version check refuses the commit if
anything else touched the same collections.

### Nothing half-done

- A crash during the copy leaves a `.partial` file, which the next archive or backup to that name removes, as it does
  for backups.
- A crash between steps 6 and 7 leaves a complete copy and an unchanged ledger: a harmless extra backup, never
  trimmed, which the user can delete.
- A crash during step 7 loses nothing: it is one SQLite transaction, so either all of it is on disk or none of it is.
- Step 9 only rewrites the file's layout; SQLite's `VACUUM` is itself atomic.

### The command's argument

`ledger.archive` takes an optional `{ before: string, options?: Record<string, boolean> }` which skips the dialog, as
`ledger.backup` takes a path. Options not given take the participants' defaults. It is for tests and for a future
plugin (a year-end assistant, say). It follows the same steps, with no dialog to show them, and resolves the
`ArchiveOutcome` or undefined.

---

## The Archiving page

Added in review: the suggested date is the start of the current year, and a user whose year ends somewhere else, or
who wants to keep more than one year, can change that. This is **Tools › Options… › Ledger › Archiving**, a page of
the ledger plugin drawn by the shell from fields, like the Backups page.

```ts
/** Namespace `ledger.archive`. */
export interface ArchiveSettings {
  /** The month the year starts, 1 to 12. A calendar year starts in January. */
  yearStartMonth: number    // default 1
  /** The day of that month the year starts, 1 up to the month's length (28 for February). */
  yearStartDay: number      // default 1
  /** Whole years before the current one that the suggested date keeps in the ledger, 0 to 10. */
  keepYears: number         // default 0
}
```

```
Archiving
The date Archive Ledger… suggests.

The year starts in month   [  1 ]
    A calendar year starts in month 1 (January), on day 1. If you archive at the end of a tax or fiscal year, choose
    when it starts: month 4, day 6 for a UK tax year; month 7, day 1 for one starting in July.
On day                     [  1 ]
Also keep the last         [  0 ] years
    Archive Ledger… suggests archiving everything before the start of the current year. To keep the year before in
    the ledger too (for a tax return, say), keep 1.
```

As built in Phase 4: three number fields. The first draft had a drop-down for the month, but the shell draws a
`choice` field as radio buttons, and twelve of them would crowd the page
([Phase 4 results](#phase-4-results)).

**The suggested date** is the most recent start of the year on or before today, moved back `keepYears` years:

| Settings | Today | Suggested date | Archives |
|---|---|---|---|
| 1 January, keep 0 (the defaults) | 10 Nov 2026 | 1 Jan 2026 | 2025 and earlier |
| 1 January, keep 0 | 15 Jan 2027 | 1 Jan 2027 | 2026 and earlier |
| 1 January, keep 1 | 10 Nov 2026 | 1 Jan 2025 | 2024 and earlier |
| 6 April, keep 0 (a UK tax year) | 10 Nov 2026 | 6 Apr 2026 | Before the 2026–27 tax year |
| 6 April, keep 0 | 10 Feb 2027 | 6 Apr 2026 | The same: the 2026–27 tax year hasn't ended |
| 1 July, keep 0 (a fiscal year) | 10 Nov 2026 | 1 Jul 2026 | Before this fiscal year |

- **The setting only picks the suggestion.** The date in the dialog can always be changed.
- **The fields:** the month, the day and the years are whole-number fields, so no new field kind is needed (a
  drop-down kind for the month is in [todo.md](todo.md)). `validate` checks that the day exists in the month. February stops at 28, so that the
  start of the year exists every year.
- **An application setting for now.** A year start really belongs to a ledger: a household ledger follows the
  calendar, and a small business's follows its fiscal year. The settings framework has no per-ledger scope yet
  ([settings-design.md](settings-design.md#the-idea-layers-of-overrides)). When it has, this namespace is the first
  candidate to move (decided in the second review, and listed in [todo.md](todo.md)).
- **Keywords** for the Options dialog's search: `archive`, `archiving`, `year end`, `fiscal year`, `tax year`,
  `compact`.

The pure function `suggestedArchiveDate(today, settings)` sits beside the settings in
`plugins/ledger/src/privileged/archive/settings.ts`, and is tested on the table above and on each month's last days.

---

## The participant contract

`ledger` knows nothing about transactions, so it can't decide what to remove or how to carry a balance forward. The
plugins that keep the data do that, as **archive participants**. This is the same arrangement as sub-ledger
participants, which `accounts` already is.

```ts
// @tessera/ledger-api

export interface LedgerSession {
  // …
  /** A plugin whose data an archive can remove. Dispose to stop participating. */
  participateInArchive(contributor: string, participant: ArchiveParticipant): Disposable
  /** After an archive has been committed: the archive date and the archive file. */
  readonly onDidArchive: Event<LedgerArchived>          // { before: string, copy: string }
}

export interface ArchiveParticipant {
  /**
   * What archiving before `before` would remove from this plugin's data, for the Archive dialog. Reads only, and may
   * leave out what depends on other participants' choices. Undefined when there is nothing to say.
   */
  describe(before: string, options: Readonly<Record<string, boolean>>): Promise<ArchiveDescription | undefined>
  /**
   * Inside the archiving storage transaction, after the copy has been made: removes what is no longer needed from
   * before `request.before`, and adjusts what stays so nothing the user sees changes. `tx` is limited to the
   * participant's own collections. Throwing rolls the whole archive back, for every participant. What it returns in
   * `shared` is given to the participants after it.
   */
  archive(tx: Transaction, request: ArchiveRequest): Promise<ArchiveResult>
  /** After the archive has been committed: announce changes, refresh views. Not called if it rolled back. */
  committed?(): void
}

export interface ArchiveRequest {
  /** 'YYYY-MM-DD': what occurred before this date may be archived. */
  before: string
  /** The user's choice for every option the participants offered (`ArchiveDescription.options`), by option id. */
  options: Readonly<Record<string, boolean>>
  /**
   * What the participants before this one shared, by contributor id. Participants run in the order they joined,
   * which follows activation, so a plugin runs after the plugins it requires.
   */
  earlier: ReadonlyMap<string, unknown>
}

export interface ArchiveDescription {
  /** How many records this removes, or would remove. Archive is enabled when any participant's count is above 0. */
  count: number
  /** One line for the user: "1,204 transactions from 6 accounts". */
  summary: string
  /** Why something stays: "“Old Visa” is closed, but stays: its balance isn’t zero." Shown under the summary. */
  notes?: string[]
  /** What the user may want to deal with before archiving, shown in the dialog's warning. It doesn't stop the archive. */
  warnings?: ArchiveWarning[]
  /** Choices the participant offers, shown as check boxes; their values come back in `options`. */
  options?: ArchiveOption[]
}

export interface ArchiveWarning {
  message: string
  /** Short lines under the message: "Chequing 9 · Visa 4". */
  details?: string[]
}

/** What a participant's `archive` did, and what it passes to the participants after it. */
export interface ArchiveResult extends ArchiveDescription {
  shared?: unknown
}

export interface ArchiveOption {
  /** `<contributor>.<name>`, like every contribution id. */
  id: string
  /** "Remove closed accounts with nothing left: “Old Visa”, “ING Savings”". */
  label: string
  default: boolean
}
```

- **The order is activation order.** `import` requires `accounts.service`, so `accounts` activates first, joins first
  and archives first. `import` then finds `accounts`' result in `earlier`. Its shape is published in
  `@tessera/accounts-api`, which `import` already depends on:

  ```ts
  /** What the accounts participant shares with the participants after it. */
  export interface AccountsArchived {
    /** The transactions removed, so a plugin can drop what it kept about them. */
    transactionIds: string[]
    /** The accounts they were removed from, each with its last archival date. */
    accounts: { id: string, lastArchiveDate: string }[]
    /** Closed accounts removed with nothing left: a plugin drops everything it kept about them. */
    removedAccountIds: string[]
  }
  ```

  The ledger passes `shared` along without reading it, so it stays domain-free.
- **The dialog's warning and check box come through the contract.** The ledger shows any participant's `warnings`
  in the dialog's warning, and any `options` as check boxes, without knowing what they mean. The accounts plugin
  offers one option, `accounts.removeClosedAccounts` (default on), and one warning: the unreconciled transactions
  before the date. A future participant can do the same without any change to the ledger.
- **`describe` and `archive` share one rule.** The accounts plugin works out a plan with a pure function,
  `planArchive(accounts, transactions, before, options)`, and both use it, so the dialog's count, warning and list of
  closed accounts are what the archive does (unless the ledger changes in between).
- **A plugin that keeps references to transactions must participate.** Budgets and reports will, when they exist. The
  plugin guide says so ([Documentation changes](#documentation-changes)). A plugin that doesn't participate keeps its
  data, and its references to removed transactions go stale, just as they would after the user deletes those
  transactions.
- **Contributors still can't snapshot or see each other's collections.** The scoped transaction is the same one a
  sub-ledger delete uses.

---

## Compaction: shrinking the file

Removing documents from the ledger has two effects:

- **In memory, at once.** The storage kit holds the whole ledger in memory, so fewer documents means less memory, a
  faster register, faster backups and faster opening from the next open on.
- **On disk, not by itself.** SQLite keeps the freed pages in the file for reuse, so the file stays the same size until
  it is vacuumed. Loki rewrites its whole file at each save, so it shrinks on its own.

So the storage contract gains one method, with an implementation per engine:

```ts
export interface Database {
  // …
  /**
   * Gives back space the database no longer uses, so its file is as small as its contents allow. The database stays
   * open; commits wait until it finishes. Resolves at once for engines with nothing to do.
   */
  compact(): Promise<void>
}
```

| Layer | `compact` |
|---|---|
| **Storage kit** | Takes the commit lock, so no commit can run during it, then asks the backend. **The lock is required, not a courtesy:** a commit made while another connection vacuums fails at once with "database is locked" ([Phase 0](#phase-0-results)). Snapshots take turns with it too: it waits for one already running, and one started meanwhile waits for it (added in [Phase 5](#phase-5-results)) |
| **SQLite** | `VACUUM` through a second connection **in the driver's worker thread**, then `wal_checkpoint(TRUNCATE)`: in WAL mode the whole new database passes through the `-wal`, and the checkpoint empties it. Measured at 100,000 transactions: 0.08 s after removing 90%, 0.5 to 0.7 s after removing half, with the main thread never blocked more than 23 ms. On the main thread it would block for all of it. The kit's own connection works normally afterwards |
| **Loki** | A save (it already rewrites the whole file) |
| **Memory** | Nothing |
| **Scoped database** | Refused, like `snapshot`: compacting is the ledger's job |

**The file ends up exactly as small as a new database holding what is left.** In the spike it was 55% smaller after
removing half of a ledger's transactions, and 90% smaller after removing 90% (79.1 MB to 36.0 and 7.6 MB). **Opening the
ledger** afterwards took 0.11 s instead of 1.2 to 1.4 s, after removing 90%.

`VACUUM` needs **free disk space of about twice what is left** while it runs: the temporary copy, then the `-wal`. That
was 72 MB for a 36 MB result in the spike. The driver checks the free space first (`fs.statfs`) and skips compaction,
with a line in the log and in the message, rather than filling the disk. If `VACUUM` fails (no space, or another program
holding the file), the archive still stands. The failure is logged, and the file is simply larger than it needs to be.
A standalone *Compact Ledger* command is not proposed. Without an archive there is little to give back.

---

## The File menu, commands and IPC

```
File
  New Ledger…
  Open Ledger…          Ctrl+O
  Close Ledger
  ─────────────
  Import…
  ─────────────
  Back Up Ledger…
  Restore Ledger…
  Archive Ledger…               ← new, in the existing `ledger.backup` group
  ─────────────
  Delete Ledger…
  ─────────────
  Exit
```

| Id | Label | Enablement | Argument |
|---|---|---|---|
| `ledger.archive` (new) | `&Archive Ledger…` | `ledger.isOpen && !ledger.isReadOnly && !ledger.isBusy` | `{ before: string, options? }`: skip the dialog ([below](#the-commands-argument)) |
| `ledger.backup` (existing) | | as today `&& !ledger.isArchive` | |
| `ledger.delete` (existing) | | as today `&& !ledger.isArchive` | |

The menu item is `{ kind: 'item', id: 'ledger.file.archive', label: '&Archive Ledger…', parent: 'shell.file', group:
'ledger.backup', command: 'ledger.archive' }`, after Restore Ledger… in
[contributions.ts](../plugins/ledger/src/privileged/contributions.ts).

New context key: `ledger.isArchive`, set while an archive is open for viewing. New status item:
`ledger.status.archive`, shown `when: ledger.isArchive`.

New IPC in `LEDGER_CHANNELS` and `LEDGER_EVENTS`, answered only while the command has the dialog open, as Restore's
are:

| Channel | Does |
|---|---|
| `ledger:archive.preview` | `{ before, options }` → `Result<ArchivePreview>`: each participant's description (summary, notes, warnings, options), the total count, and the copy's name and folder |
| `ledger:archive.run` | `{ before, options }` → `Result<ArchiveOutcome>`: archives, pushing `archive.progress` meanwhile. Refused while one runs, for a date after today, for an option no participant offered, or when there is nothing to archive |
| `ledger:archive.progress` (event) | `{ step: 'copying' \| 'checking' \| 'removing' \| 'compacting', done? }` |

```ts
export interface ArchiveDialogInput {
  ledgerName: string
  /** 'YYYY-MM-DD', from the Archiving page's settings (`suggestedArchiveDate`). */
  suggestedBefore: string
  today: string
  lastArchive?: { before: string, archivedAt: string }
}

export interface ArchiveOutcome {
  before: string
  /** When the archive was committed, ISO 8601 UTC. */
  archivedAt: string
  /** Where the copy was saved, and its `backup.takenAt`. */
  copy: { path: string, takenAt: string }
  /** Records removed, over every participant. */
  count: number
  /** Every participant's summary. */
  summaries: string[]
}
```

New error code: `ARCHIVE_FAILED`, with a message the user can act on, as `BACKUP_FAILED` has.

---

## Where the code goes

**The command, the copy and the transaction are in the `ledger` plugin,** for the reasons the backup design gives:
they need the raw database, the session's queue and operation, and the ledger's id. **The rules are in the plugins
that own the data.** A separate `ledger-archive` plugin would need the session to expose all of that: the API the
backup design also turned down ([Where the code goes](backup-restore-design.md#where-the-code-goes)).

| File | Holds |
|---|---|
| `packages/ledger-api/protocol.ts`, `service.ts`, `model.ts`, `errors.ts` | `ledger.archive` and its argument; `ledger.dialog.archive`; the archive channels and progress event; `ArchiveParticipant`, `ArchiveRequest`, `ArchiveDescription`, `ArchivePreview`, `ArchiveOutcome`; `participateInArchive` and `onDidArchive`; `BackupKind` gains `'archive'`; `LEDGER_BACKUP_META.archiveBefore`; `LEDGER_COLLECTIONS.archives`; `LedgerInfo.archive`; `ledger.isArchive`; `ARCHIVE_FAILED`; `ArchiveOption`; `LEDGER_ARCHIVE_SETTINGS` and its page id |
| `plugins/ledger/src/privileged/archive/ArchiveService.ts` | The run: the checks, the copy (through `BackupService.backUp`), its name and the `Archives` folder, the change count and the one retry, `runArchive`, the copy deleted on failure; compaction (Phase 5) |
| `…/archive/command.ts` | File › Archive Ledger…: the operation, the dialog and its channels, the message |
| `…/archive/participants.ts` | The participants, and the one transaction they run in (Phase 1) |
| `…/archive/settings.ts` | `ARCHIVE_SETTINGS`, the Archiving page, and `suggestedArchiveDate` |
| `…/LedgerSessionImpl.ts` | `runArchive`, `describeArchive`, the record and `committed`; the change count; opening an archive read-only (`inspect` lets it through; no migrations; no id on `LedgerInfo`; not in the recent list; the close hook skips it) |
| `…/backup/BackupService.ts`, `retention.ts`, `restore.ts`, `autoBackup.ts` | The copy's `archiveBefore`, and `record: false`; archives never trimmed; Restore lists the `Archives` folder; no backup of an open archive |
| `…/contributions.ts`, `index.ts` | The menu item, the dialog, the status item, the wiring |
| `plugins/ledger/src/renderer/ArchiveDialog.tsx` | The dialog, with the participants' warnings and options |
| `packages/accounts-api/model.ts` | `Account.lastArchiveDate`, `Account.archived` (`AccountArchived`), `AccountsArchived` |
| `plugins/accounts/src/privileged/archiveCore.ts` | `planArchive` (pure: the rule, the warning, closed accounts with nothing left), `applyArchive` (removal, balances carried forward, closed accounts, reconciliations, the balance check) |
| `plugins/accounts/src/privileged/index.ts`, `transactionsCore.ts` | Joining as a participant; `nextNumber` following `archived.highestNumber` |
| `packages/accounts-api/rules.ts`, `plugins/accounts/src/renderer/display.tsx`, `register/Register.tsx`, `AccountDialog.tsx` | `periodStart`; the first row dated the last archival date, and its tooltip; the dialog's note and last archival date |
| `packages/import-api/manager.ts` | `ImportCounts.archived` |
| `plugins/import/src/privileged/archive.ts`, `run.ts`, `index.ts` | Pruning lines and batches, and every record of a removed account; leaving out lines before the last archival date; joining as a participant; no writes on opening a read-only ledger |
| `plugins/import/src/renderer/SummaryDialog.tsx` | The count of lines left out |
| `tessera-types/storage.ts`, `packages/storage-kit/*`, both engines, `scopedDatabase.ts` | `Database.compact` (Phase 5) |
| `plugins/storage.sqlite/src/privileged/SqliteDriver.ts` | Large commits, and `VACUUM` with its free-space check, in the driver's worker thread (Phase 5) |

---

## Security, privacy and robustness

- **The copy is the whole ledger**, like any backup: account numbers, balances and payees. It goes where backups go,
  under the user's own folder, with the same permissions. Archiving keeps sensitive data; it doesn't delete it.
  Someone who wants old data gone for good must delete the copy themselves, and the Backups page can say so.
- **No path comes from a view.** The dialog sends a date. The main process chooses the copy's name and folder, and
  `run` refuses a date after today.
- **Balances are checked before the commit,** not trusted ([The balance check](#the-balance-check)).
- **The copy is checked and named before anything is removed,** and the removal is refused if the ledger changed after
  the copy began ([step 7](#the-archive-step-by-step)).
- **An archive is never written to:** read-only when opened, never trimmed, never backed up or deleted from inside
  Tessera. The storage engine refuses writes to a read-only database, which is the safety net under every guard.
- **Contributors can't snapshot, compact, or see each other's data** during an archive, any more than at other times.

---

## Testing

| Tests | What |
|---|---|
| `tests/plugins/accounts/archive.test.ts` (new) | `planArchive` on the [worked cases](#worked-cases) and the [example](#an-example); transfers both ways; **the opening date never changes**; `lastArchiveDate` set, and kept at the later date when a later archive uses an earlier one; `archived` recorded and accumulated over two archives, with the original opening balance; **closed accounts with nothing left** removed only when every condition holds (one with a balance, one with a transaction after the date, one with a paused reconciliation, and the option off, each kept), and the per-currency totals unchanged; the warning's counts, by account, with the transfers kept; minimum and available balances unchanged; finished reconciliations removed except the last; one in progress untouched; the next cheque number; **a property test**: random ledgers (accounts, transfers, statuses, voids, reconciliations in progress) and random dates. After every archive, every account's four balances are unchanged, the running balance of every row on or after the date is unchanged, no transfer lacks its other side, and nothing unreconciled is gone; **the check catches a wrong carry** (the carried sum deliberately miscalculated rolls everything back) |
| `tests/plugins/import/archive.test.ts` (new) | Lines pruned only before the date and only for removed transactions or skipped lines; every record of a removed closed account gone; records kept on and after the date; batches with no lines removed; pending reviews; **importing the same statements again adds nothing**, including the corpus's posting delays (`01-posting-delays.json`) across the archive date; lines before the date counted as `archived` |
| `tests/plugins/ledger/archive.test.ts` (new, the session's half) and `archiveCommand.test.ts` (new, the command's) | The run through the command with the dialog played by the test: the copy's meta, folder and name, ` (2)`; the copy holds every removed transaction; participants in order, with `earlier`; one participant throwing rolls back every participant and deletes the copy; the change count moving (a write during the copy) makes a second copy, then gives up; the record in `ledger.archives`; the operation held throughout; disabled while busy, read-only or viewing an archive; the message and the status bar; failures at each step leave the ledger unchanged |
| `tests/plugins/ledger/archiveOpen.test.ts` (new) | Open accepts an archive and refuses other backups; read-only (every write refused); no id on `LedgerInfo`; not in the recent list, not reopened at start; no backup on close; Back Up, Archive and Delete disabled; a contributor missing from the archive reads as empty; one needing an upgrade refused with the Restore advice; **the file is byte-identical after viewing it** (on real SQLite) |
| `tests/plugins/ledger/retention.test.ts` (+) | An archive in the default folder itself is never a candidate; the `Archives` folder is never scanned |
| `tests/plugins/ledger/restore.test.ts` (+) | Archives listed and labelled; restoring one in place gives back the ledger as before archiving; Restore never takes an open archive for its ledger |
| `tests/storage/conformance.ts` (+ a `compact` group, for memory, SQLite and Loki) | Contents, indexes and meta unchanged; commits wait for it and then carry on; a closed database refuses |
| `tests/plugins/storage.sqlite/SqliteStorageEngine.test.ts` (+) | A batch of 5,000 changes or more committed in the worker, landing whole or not at all; after deleting most documents, `compact` shrinks the file to the size of a fresh copy; a commit during `compact` waits and lands; no `-wal` of the old size left; compaction skipped without room |
| `tests/plugins/ledger/renderer/archiveDialog.test.tsx` (new) | The agreed text, word for word; the date's suggestion and limits; the preview following the date, and Archive disabled when there's nothing; the warning shown only when there is one, and following the date; the check box, its default, and its value sent with the run; the steps and percentage while busy; a failure shown above the buttons |
| `tests/plugins/accounts/renderer/register.test.tsx` (+), `accountDialog.test.tsx` (+) | *Opening balance* dated the last archival date, with its tooltip, and dated the opening date when never archived; the dialog's *Opened* unchanged, its note and last archival date |
| `tests/plugins/ledger/archiveSettings.test.ts` (new) | `suggestedArchiveDate` on the [Archiving page's table](#the-archiving-page), on each month's last days and on the year start itself; the settings' checks (a day the month doesn't have) |
| `tests/plugins/ledger/files.test.ts` (+) and `sampleArchive.test.ts` (new), on real SQLite files | The whole archive of a ledger with imports: the copy opens read-only with everything in it; the ledger keeps its balances; re-importing adds nothing; after compacting, the file is smaller |

Each phase also checks that its tests fail without each change, as the backup phases did.

---

## Alternatives considered

| Alternative | Why not |
|---|---|
| **Archive every transaction before the date,** whatever its status | The reconciled balance would change, and outstanding cheques would vanish from the register while still outstanding at the bank ([Why reconciled or void](#why-reconciled-or-void)) |
| **Also archive cleared (`C`, `E`) transactions** | Same problem for the reconciled balance. A possible option later, if the carried amount were split, but the opening balance is a single figure |
| **Remove one side of a transfer, unlinking the other** (as Delete Account does) | Changes the other account's transaction and shows a transfer from nowhere, to save one row that the next archive removes anyway |
| **The copy holds only the archived transactions** (a logical export into a new database) | A second way to write a ledger, which must agree with what every engine writes, and which each plugin would have to take part in. A snapshot is consistent and complete by construction, and is also a full backup. The backup design turned down logical export for the same reasons |
| **The copy is an ordinary ledger (`.tessera`) with an id of its own** | It would be editable, so it could drift from what was archived; it would be backed up and trimmed as a ledger of its own; and as a ledger it would be listed and reopened with the others. As a backup of its own kind it can also undo the archive, through Restore |
| **Keep the copy in the default backup folder** | Retention would trim it after 30 days, by its ledger id, and with it the only copy of the archived transactions. The kind check alone wouldn't protect it from a version of Tessera that predates it |
| **Keep the copy beside the ledger** | Scatters large files next to the ledger, out of the folder the user set up for backups (possibly a synced one) |
| **Open the copy writable** | It would change on opening (WAL mode, upgrades) and then by editing, and stop being the record of the archive |
| **Keep every `import.lines` record forever** | Safe, but import records are a large part of a ledger (the backup spike found they doubled its size), so the ledger would shrink far less |
| **The import's skip rule alone, without keeping records past the date** | Misses bank lines posted after the archive date for transactions the user dated before it |
| **A separate `ledger-archive` plugin** | Needs the session's raw database, queue, operation and open internals exposed to another plugin, as the backup design found |
| **Meta keys for the ledger's record of archives** (`ledger.archives` in meta) | Meta writes aren't part of storage transactions, so the record could disagree with what was removed. A collection is written in the same transaction |
| **Move the opening date to the archive date** (the first draft) | Turned down in review: the opening date is a historical fact. The last archival date says when the current period starts |
| **Keep the opening balance as it was, and add a separate balance for the current period** | Every balance, reconciliation's suggested starting balance and every future plugin would need to know which to start from. Keeping one figure as the base of every balance means none of them change; the original is kept in `archived.originalOpeningBalance` |
| **Remove closed accounts whatever their balance** | A closed account with a balance still counts in totals, so removing it would change net worth |
| **Run the removal in chunks** (many small transactions) | Not atomic: a failure half-way would leave a ledger half-archived, with its balances right but its history split. And not needed: [Phase 0](#phase-0-results) kept one transaction with a longest stall of about 0.14 s at 100,000 transactions |
| **`VACUUM` on the main thread** | Blocks the main process for all of it: up to 0.5 s at 100,000 transactions with half removed. In the driver's worker it blocked for at most 23 ms |

---

## Risks

| Risk | Mitigation |
|---|---|
| **A balance changes** | Only reconciled and void transactions go, which is proven to keep every balance; the balance check runs inside the transaction and rolls back on any difference; a property test over random ledgers |
| **The archived transactions are lost** | The copy is written, checked and named first; it is never trimmed (its own folder, and its kind); it is never written to; the message and the ledger's record say where it is |
| **A change slips in between the copy and the removal** | The change count check; the kit's transaction lock and version check during the removal |
| **Re-importing an old statement brings archived transactions back** | Line records kept from the archive date on; lines before an account's archive date left out and counted; tested with the corpus's posting delays |
| **The removal holds the main process too long** on a very large ledger | Measured in [Phase 0](#phase-0-results): written the obvious way, 2.8 s at 100,000 transactions in one block. Deleting by id, yielding every 2,000 writes, a plain-sum balance check and a large commit in the driver's worker bring it to about 0.14 s, still one transaction ([Keeping the window responsive](#keeping-the-window-responsive)). To check on Windows in Phase 4's smoke test |
| **`VACUUM` needs disk space, or stalls the window** | Measured in [Phase 0](#phase-0-results): in the driver's worker the main thread is never blocked more than 23 ms; it needs free space of about twice what is left, which the driver checks first, skipping compaction if there isn't room; a failure leaves the archive standing |
| **A write during `VACUUM` fails** ("database is locked", shown in the spike) | The kit holds its commit lock for the whole of `compact`, so a write waits instead; a test writes during it |
| **A plugin writes when any ledger opens,** so an archive can't be viewed, or its write fails | Found and guarded in [Phase 3](#phase-3-opening-an-archive-read-only-m); the engine refuses writes, so the archive is never changed |
| **An old archive can't be opened** after Tessera's formats move on | A clear message pointing to Restore as a new ledger; an upgraded temporary copy in [Phase 6](#phase-6-later-each-scheduled-separately) |
| **Restore or retention mistakes an open archive for its ledger** (they share an id) | No id on an open archive's `LedgerInfo`, not in the recent list, no Back Up of it |
| **The user archives too recent a date,** and a future report for last year is incomplete. With the default, archiving in January removes all of last year, perhaps before a tax return is done | The Archiving page can keep earlier years; the preview shows what goes; the archive file opens read-only; Restore in place of the ledger undoes it; reports can read archives later |
| **Old transfers stay because the other account is never reconciled** | The warning counts them, so the user knows why |
| **Unreconciled transactions the user forgot about stop the archive from making a clean cut** | The warning lists them by account before anything happens; the user can cancel, reconcile (or void a cheque that will never clear) and archive again |
| **A closed account the user wanted to keep seeing is removed** | Named in the dialog, with a check box to keep it; the archive file holds it, complete |
| **Payee suggestions lose their last amounts** for payees used only in archived transactions | Acceptable; tidying payees is later work |
| **A future plugin keeps transaction ids and doesn't participate** | The contract and the plugin guide say it must; its stale references behave as after a delete |

---

## Decisions taken in review

Reviewed on 2026-11-10 and applied throughout this note.

| # | Question | Decision | Where it lands |
|---|---|---|---|
| 1 | The dialog's additions beyond the agreed text: (a) what will be archived, (b) where the copy goes, (c) the step in progress | **Keep all three** | [The dialog](#the-dialog) |
| 2 | The suggested archive date | **The start of the current year, 1 January by default** (the first draft proposed the start of last year). **It is a setting,** so a user can make the year start elsewhere, or keep earlier years too | [The date](#the-date), [The Archiving page](#the-archiving-page) |
| 3 | The register's first row after an archive | ***Opening balance***, as today: it is the opening balance of the new period (the first draft proposed *Balance carried forward*) | [How the register and the account dialog show it](#how-the-register-and-the-account-dialog-show-it) |
| 4 | Should archiving move the account's opening date? | **No: the opening date always stays the date the account opened.** A new field, the **last archival date** (`lastArchiveDate`), records when the current period starts, and dates the register's first row. The balance the account opened with is kept too (`archived.originalOpeningBalance`), so the history is complete | [Carrying the balance forward](#carrying-the-balance-forward), [What the account records](#what-the-account-records) |
| 5 | Does archiving affect minimum balances? | **No.** The minimum and the available balance are unchanged, and nothing depends on their history | [Minimum balances](#minimum-balances) |
| 6 | Does opening archive files read-only let other backups be opened read-only? | **No.** Only files of kind `archive`; other backups are still refused by Open and restored through Restore. Viewing any backup is possible later work | [Only archive files](#only-archive-files) |
| 7 | For consistency, the file's name in the dialog's text | **The *archive file*, here and everywhere else.** The review suggested "archival transactions … the archived file"; the second review settled on "archived transactions … the archive file", for the reasons given with the text | [The text](#the-text), [Naming](#naming) |
| 8 | Remove closed accounts whose transactions are all reconciled? | **Yes,** when archiving leaves them empty and their balance is zero, so that no total changes; listed in the dialog, with a check box (ticked) to keep them | [Closed accounts with nothing left](#closed-accounts-with-nothing-left) |
| 9 | Warn in the dialog about unreconciled transactions before the date? | **Yes,** by account, with the transfers kept because of them, so the user can cancel and reconcile first. It doesn't stop the archive | [The dialog](#the-dialog), [Unreconciled transactions before the date](#unreconciled-transactions-before-the-date) |

The first draft's other proposals weren't discussed, and stand as proposed:
- only reconciled or void transactions are archived, and a transfer only with both sides;
- the archive file goes in `Archives` inside the default backup folder;
- Open Ledger… opens it;
- payees are kept;
- compaction runs as the archive's last step;
- statement lines before an account's last archival date are left out of an import and counted.

Second review, the same day:

| Question | Decision | Where it lands |
|---|---|---|
| The dialog's second paragraph | **"To access the archived transactions later, you can open the archive file."** | [The text](#the-text) |
| Removing closed accounts with nothing left: always, or the user's choice? | **A check box in the dialog,** ticked by default | [Closed accounts with nothing left](#closed-accounts-with-nothing-left) |
| *Change…* for the archive file's folder | **Later;** the Backups page's folder decides it for now | [Phase 6](#phase-6-later-each-scheduled-separately) |
| The year start: an application setting, or per ledger? | **An application setting now.** Per ledger once settings have a per-ledger scope, listed in [todo.md](todo.md) | [The Archiving page](#the-archiving-page) |
| Run the spike | **Yes:** how long the removal holds the main process; how long `planArchive` and the balance check take at 100,000 transactions; what `VACUUM` costs after a large removal; that a read-only open is really read-only; how much smaller the file gets | [Phase 0](#phase-0-spike-s) |

After Phase 4, on trying it:

| Question | Decision | Where it lands |
|---|---|---|
| A transaction *entered by hand* dated before its account's last archival date: refuse it, or warn? | **Refuse it,** as imports already leave such lines out. One that stayed from before the date can still be edited | [Entering transactions after an archive](#entering-transactions-after-an-archive) |
| Should archive files have an extension of their own (say `.tesseraarchive`)? | **No.** It was asked whether one would make a read-only ledger easier to tell. It wouldn't: Open already reads the file's meta before opening it, and `backup.kind: 'archive'` is what makes it read-only. An extension would be a hint at most, since a renamed file keeps its meta and still has to be checked. Restore would list two extensions, and the backup code would need two of everything | [Opening the archive file](#opening-the-archive-file) |
| With an archive open, the register's context menu was still active, and a row could still be edited | **A bug:** the views didn't know the ledger was read-only. They now offer nothing that changes it | [What the user sees](#what-the-user-sees) |
| Compaction after an archive | **Now** (Phase 5's compaction). Committing large batches in the driver's worker, the rest of Phase 5, waits | [Phase 5 results](#phase-5-results) |

### Still open

None at present.

---

# Part 2: Implementation

## Ground rules

The [account manager's ground rules](account-manager-implementation.md#ground-rules) apply unchanged, as they did for
backup and restore:

- every phase ends with a working app and a green `npm test`;
- no menu item appears before the phase that makes it work;
- tests mirror the source folders;
- domain logic is tested against the memory engine;
- the architecture test keeps passing;
- `tsc --noEmit` adds no new errors;
- each phase ends with a manual smoke test in `npm run dev`.

Sizes: **S** is about a day, **M** a few days, **L** about a week.

Rules specific to this work:

- **Balances are checked, not trusted.** From Phase 1 on, every archive checks every account's balances inside its
  transaction, and the property test runs in every phase.
- **The copy comes first, and is never touched again.** From Phase 3 on, nothing writes to, trims or deletes an
  archive. Tests compare its bytes before and after.
- **The `ledger` plugin never mentions transactions,** accounts or bank lines. Everything domain-specific is behind
  `ArchiveParticipant`, and everything engine-specific behind `snapshot` and `compact`.
- **Nothing that could bring archived transactions back ships before the import rule.** Phase 2 is done before the
  command appears.

## Dependency graph

```
Phase 0 ──► Phase 1 ──────► Phase 2 ─────────┐
 (spike,   (contract,       (imports follow) │
  done)     accounts rules)                  ├──► Phase 4 (Archive Ledger…) ──► Phase 6
       ├──► Phase 3 (opening an archive read-only) ──┤
       └──► Phase 5 (large commits and compaction in the driver's worker) ┘  (before or with Phase 4)
```

- Phases 1 and 3 are independent once the spike is done. Phase 2 needs Phase 1's contract.
- **The command (Phase 4) needs all three.** The dialog's text promises that the copy can be opened (Phase 3), and an
  import must not bring archived transactions back (Phase 2).
- **Phase 5 is driver work that depends only on the spike,** so it can run alongside Phases 1 to 3. Done first, it lets
  the command ship with compaction and without the commit's freeze. Done later, the command ships without them, and
  Phase 5 adds both.

---

## Phase 0: spike (S)

Answers what the design depends on, in throwaway code outside the repository, on ledgers built as the backup spike
built them (1,000, 10,000 and 100,000 transactions, with import lines). The findings go into a *Phase 0 results*
section of this note.

| Question | How | Decides |
|---|---|---|
| How long does the removal hold the main process? The in-memory work under the transaction lock, then one synchronous commit deleting 50 to 90% of the transactions and lines | The real storage kit and SQLite driver, timing the longest main-thread stall, warm and cold, on Linux and Windows | One transaction as designed, or the driver's deletes batched differently or moved to a worker |
| How long do `planArchive` and the balance check take at 100,000 transactions? | Time them on the in-memory collections | How long the preview waits after the date is typed; whether the check is cheap enough to always run (expected: yes) |
| `VACUUM` after a large removal: time, main-thread stall, temporary disk space, what happens to `-wal`; and whether it can run in a worker thread with its own connection while the kit has the file open and holds its commit lock | Scratch scripts, in Node 24 and in Electron 45's main process | Phase 5's method, or whether to drop compaction for SQLite |
| Does a real read-only open of a `.tesserabkp`, with the ledger's schema, write nothing on both engines? Including a contributor missing from the file, and declared indexes the file lacks | Open through the real session's engine; hash the file before and after; list side files | Phase 3's approach |
| Which plugins write when a ledger opens, or when their views first load? | Read the `opened` listeners; open a read-only copy with every bundled plugin active and log the refused writes | Phase 3's list of guards |
| How much smaller does a ledger get, in memory, on disk after `VACUUM`, and in opening time? | Archive 80% of a 100,000-transaction ledger | What the message and the plugin guide can promise; whether compaction is worth its phase |

**Exit:** the results section is written, and the removal's shape, the compaction method and the read-only guards are
settled.

**Done 2026-11-10**, on Linux with Node 24, for the five questions the second review chose. Which plugins write when a
ledger opens moved to [Phase 3](#phase-3-opening-an-archive-read-only-m), where it is fixed. Windows and Electron are
checked in Phase 4's smoke test ([Not verified](#not-verified)).

### Phase 0 results

The spike's code was throwaway. It lived outside the repository (`/tmp/compaction-spike`), and bundled the
repository's real storage kit, SQLite driver and plugin schemas with esbuild, aliased as the plugin build aliases them.
The accounts participant was a prototype, written as this note describes it: `planArchive`, the removal in one
transaction, and the balance check. What it found is recorded here.

**How it was run.**

- **The machine.** A Linux VM with an ext4 virtual disk, 4 cores, not root. Only warm runs: a user can't evict files
  from the OS cache there, so there are no cold-disk figures.
- **The Node.** **Node 24.11.1 (SQLite 3.50.4)**, from the `node-linux-x64` npm package: the same as the backup
  spike's Linux runs, and Electron 45's line.
- **The ledgers** were built through the real kit and driver with the real schemas, shaped like real ones:
  - transactions spread over 2017 to November 2026, about a tenth of them transfers (both sides counted);
  - history up to September 2026 is 97.5% reconciled, with a few void, cleared, downloaded and uncleared transactions;
  - an import line for half the transactions, 30% of them posted a day or more after the user's date;
  - a finished reconciliation per account and month, listing the ids it reconciled, and one paused reconciliation;
  - 300 payees and 120 categories;
  - four closed accounts: one with nothing left and a zero balance at each date; one closed with a balance; one with
    reconciled activity after the archive date.

  They came to **1.3, 9.0 and 79.1 MB** at 1,000, 10,000 and 100,000 transactions. That is about 40% larger than the
  backup spike's ledgers (0.7, 5.8 and 56 MB), because of the reconciliation records and longer memos, so the times
  here lean slow.
- **Two archive dates:** before 1 Jan 2022, which removes about half, and before 1 Jan 2026, which removes about 90%.
- **The longest stall** is the longest the main thread went without turning its event loop, measured with a
  `setImmediate` chain, as the backup spike measured it. Medians of three runs unless marked.

| Question | Answer |
|---|---|
| 1. How long does the removal hold the main process? | **As first designed, all of it: 2.7 to 2.8 s at 100,000 transactions, in one block.** Every `await` inside the kit's transaction resolves at once, so the in-memory work never lets the event loop turn, and the SQLite commit that follows is synchronous too. **Three changes bring the longest stall down to 0.14 s** with the same total time (1.8 to 2.1 s). They are: yielding every 2,000 writes; the balance check as a plain sum; and the commit, when large, in a worker thread with its own connection. At 10,000 transactions the stall is then 22 to 28 ms. Deleting with `$in` must never be used: it is quadratic (1.5 s at 10,000) |
| 2. How long do `planArchive` and the balance check take at 100,000? | **`planArchive` itself: 67 to 80 ms.** Reading the collections it plans from takes 128 ms, because `find()` clones every document. **The balance check took 0.35 s** with the accounts plugin's `sumsByAccount`, the kit's aggregate with a `$cond` per document, once before the removal and again after. This note had said "a few milliseconds". **The same sums in one plain loop take 19 ms**, and agreed with `sumsByAccount` on every run |
| 3. What does `VACUUM` cost after a large removal? | **Little, in a worker: 0.08 s at 100,000 transactions with 90% removed, and 0.5 to 0.7 s with half removed,** with the main thread never blocked more than 23 ms. Its time follows what is left, not what was removed. On the main thread it blocks for all of it. It needs **free disk space of about twice what is left** (72 MB peak for a 36 MB result), not twice the original. In WAL mode the new database passes through the `-wal`, which `wal_checkpoint(TRUNCATE)` then empties in 4 to 15 ms. The kit's own connection works normally afterwards. **A commit made during another connection's `VACUUM` fails at once, "database is locked"**, so the kit must hold its commit lock throughout, as designed |
| 4. Is a read-only open really read-only? | **Yes, for an archive file.** Tested through the real kit with `readOnly` and the ledger's schema, plus a collection and an index the file didn't have, at 10,000 and 100,000 transactions. Five viewings, one with the file marked read-only by the OS and one in a folder the user can't write to: **the bytes, size and modification time were unchanged every time, and no side file ever appeared.** Every kind of write was refused with `READ_ONLY`. **A live ledger, in WAL mode, opened read-only the same way leaves an empty `-wal` and a 32 KB `-shm` beside it** (its own bytes unchanged), as the backup spike found. That is why archives stay in `DELETE` mode, which the snapshot sets |
| 5. How much smaller does the file get? | **Exactly as small as a new database holding only what is left:** `VACUUM`'s result matched `VACUUM INTO` a fresh file to the byte. **55% smaller with half removed, 90% smaller with 90% removed** (79.1 MB to 36.0 and 7.6 MB). Without `VACUUM`, the file stays 79.1 MB. **Opening takes 0.11 s instead of 1.2 to 1.4 s** after removing 90% (0.6 to 0.9 s after half) |

#### 1. The removal and the main thread

As first designed: one transaction, deleting by id, the balance check through `sumsByAccount`, and the commit on the
main thread. Times in milliseconds:

| Transactions | Archive date | Removed | In-memory work | Commit | **Longest stall** | `-wal` after the commit |
|---|---|---|---|---|---|---|
| 1,000 | 1 Jan 2022 | 491 (49%) | 47 | 11 | **65** | 0.7 MB |
| 1,000 | 1 Jan 2026 | 893 (89%) | 30 | 7 | **41** | 0.8 MB |
| 10,000 | 1 Jan 2022 | 5,001 (50%) | 162 | 42 | **200** | 3.4 MB |
| 10,000 | 1 Jan 2026 | 8,928 (90%) | 166 | 95 | **269** | 5.4 MB |
| 100,000 | 1 Jan 2022 | 49,697 (50%) | 1,900 | 711 | **2,717** | 25.9 MB |
| 100,000 | 1 Jan 2026 | 89,310 (89%) | 1,570 | 1,241 | **2,835** | 46.2 MB |

The in-memory work at 100,000, removing 89%: reading and planning 235 ms; the balance before 312 ms; deleting the
transactions and reconciliations and updating the accounts 579 ms, including the transaction's first write cloning the
whole collection; the import lines and batches 474 ms; the balance after 31 ms. Closing afterwards took 10 to 22 ms, so
SQLite had already checkpointed during the commit.

The longest stall, step by step:

| | 10,000, half | 10,000, 90% | 100,000, half | 100,000, 90% |
|---|---|---|---|---|
| As first designed | 200 | 269 | 2,717 | 2,835 |
| Yielding every 2,000 writes | 64 | 117 | 713 | 900 |
| …and the balance check as a loop, and the commit in a worker | **28** | **22** | **139** | **136** |
| Total time, with all three | 214 | 263 | 1,807 | 2,096 |

With all three, what is left of the stall is mostly the single `find()` that clones the transactions, which can't be
split. After every run, reopening the file found exactly the documents the kit held.

The commit alone, on the main thread and in a worker thread with its own connection, while the kit holds the ledger
open and idle. One `BEGIN IMMEDIATE … COMMIT` of the same `DELETE`s the kit's commit runs:

| Transactions | Archive date | Documents deleted | Main thread: time = stall | Worker: time | Worker: longest stall |
|---|---|---|---|---|---|
| 10,000 | 1 Jan 2022 | 8,119 | 48 | 38 | 9 |
| 10,000 | 1 Jan 2026 | 14,407 | 91 | 91 | 20 |
| 100,000 | 1 Jan 2022 | 75,231 | 502 | 569 | 28 |
| 100,000 | 1 Jan 2026 | 135,154 | 1,060 | 842 | 52 |

The worker's stall is mostly copying the list of changes to it. **Deleting with `$in`**, the obvious
`deleteMany({ id: { $in: ids } })`, compares every document with every id: 593 and 1,458 ms at 10,000, against 57 and
56 ms by id. At 100,000 that would be about a hundred times longer again, so it was not run.

#### 2. planArchive and the balance check

Medians of five, with the ledger open in the kit:

| Transactions | Reading the collections (`find()`) | `planArchive`, half / 90% | `sumsByAccount` (the aggregate) | The same sums, one loop |
|---|---|---|---|---|
| 1,000 | 2.8 | 1.6 / 0.9 | 5.4 | 0.5 |
| 10,000 | 14.8 | 8.8 / 10.8 | 35.4 | 3.1 |
| 100,000 | 127.5 | 66.9 / 79.8 | 351.4 | 19.0 |

The preview reads and plans the same way, so at 100,000 it takes about 0.2 s for each date the user tries. That fits
the short pause after typing that the dialog already waits.

#### 3 and 5. VACUUM, and the size

The file after the removal, after `VACUUM` and a `wal_checkpoint(TRUNCATE)`, and what a fresh database holding the same
documents takes (`VACUUM INTO`). Sizes in MB, times in ms:

| Transactions | Archive date | Before | After the removal | After `VACUUM` | Smaller by | Same as a fresh database | `VACUUM` in a worker | Its longest stall | On the main thread (stall) | Checkpoint | `-wal` after `VACUUM` | Peak extra disk |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1,000 | 1 Jan 2022 | 1.3 | 1.3 | 0.6 | 51% | Yes | 5 | 2 | 9 | 2 | 0.7 | 0.6 |
| 1,000 | 1 Jan 2026 | 1.3 | 1.3 | 0.2 | 85% | Yes | 2 | 1 | 5 | 2 | 0.2 | 0.2 |
| 10,000 | 1 Jan 2022 | 9.0 | 9.0 | 4.1 | 55% | Yes | 34 | 1 | 33 | 10 | 4.1 | 8.2 |
| 10,000 | 1 Jan 2026 | 9.0 | 9.0 | 0.9 | 90% | Yes | 7 | 1 | 10 | 5 | 0.9 | 0.9 |
| 100,000 | 1 Jan 2022 | 79.1 | 79.1 | 36.0 | 55% | Yes | 736 | 23 | 524 | 15 | 36.2 | 72.2 |
| 100,000 | 1 Jan 2026 | 79.1 | 79.1 | 7.6 | 90% | Yes | 82 | 12 | 86 | 4 | 7.7 | 15.3 |

- `integrity_check` was `ok` after every run, and no side files were left after the close.
- The kit wrote through its own connection after the other connection's `VACUUM`, and the write was in the file
  afterwards.
- The peak disk use was sampled every 2 ms by a second worker from the file system's totals, since SQLite's temporary
  files are removed as soon as they are opened. Sampling that often can miss a short peak, so the figures are lower
  bounds.

Opening the ledger again after the removal, before `VACUUM` (the time follows the documents loaded, not the file's
size), from the runs of the first table:

| Transactions | Archive date | Opening before | Opening after |
|---|---|---|---|
| 10,000 | 1 Jan 2022 | 121 to 144 ms | 61 to 73 ms |
| 10,000 | 1 Jan 2026 | 114 to 116 ms | 15 to 20 ms |
| 100,000 | 1 Jan 2022 | 1.1 to 2.7 s | 0.64 to 0.90 s |
| 100,000 | 1 Jan 2026 | 1.2 to 1.4 s | 0.11 to 0.12 s |

(Opening a 79 MB ledger took longer here than the backup spike's 0.44 to 1 s for 56 MB, which matches the larger file.)

#### 4. Read-only

| File | Viewings | Bytes, size and modification time | Side files, during and after | Writes refused |
|---|---|---|---|---|
| An archive file, as the snapshot made it (`DELETE` mode) | 3 | Unchanged | None | 13 of 13 (`READ_ONLY`) |
| The same, marked read-only by the OS (0444) | 1 | Unchanged | None | 13 of 13 |
| The same, in a folder the user can't write to (0555) | 1 | Unchanged | None | 13 of 13 |
| For contrast: the live ledger (WAL mode), opened read-only | 1 | Unchanged | **An empty `-wal` and a 32 KB `-shm`, left behind** | 13 of 13 |

The writes tried: insert, update one and many, delete one and many, a transaction, an insert into a declared collection
the file didn't have, setting and deleting meta, creating, dropping and renaming a collection, and adding an index.
`flush` succeeds, but does nothing. Every collection read back with the source's counts. The declared collection the
file lacked read as empty, and the declared index it lacked caused no write. At the SQLite level, the snapshot's copy
reported `journal_mode = delete`, and an `INSERT` through a read-only connection failed with "attempt to write a
readonly database". Run at 10,000 and at 100,000 transactions, with the same results.

#### What changes in this note

| Where | Change |
|---|---|
| [The archive, step by step](#the-archive-step-by-step) | New: **[Keeping the window responsive](#keeping-the-window-responsive)**. Delete by id, never with `$in`; yield every 2,000 writes; commit a large batch in the driver's worker |
| [The balance check](#the-balance-check) | One pass over the documents, not the aggregate: 19 ms instead of 0.35 s at 100,000. It is tested against `sumsByAccount` |
| [Compaction](#compaction-shrinking-the-file) | `VACUUM` in the driver's worker, always under the commit lock; free space of twice what is left; the measured sizes |
| [Opening the archive file](#opening-the-archive-file) | Confirmed read-only. An archive another tool switched to WAL mode leaves empty side files, so `inspect` says so |
| [Decisions](#decisions) | 15: how the removal keeps the window responsive |
| [Risks](#risks), [Alternatives considered](#alternatives-considered) | The removal's stall and `VACUUM`'s cost, measured; chunking the removal not needed |
| Phases 1, 4 and 5 | The loop check and yielding in Phase 1; the worker commit and `VACUUM` together in Phase 5, which now comes before the command where it can |

#### Not verified

| What | Where it is checked now |
|---|---|
| Windows and Electron 45: the removal's stall, the worker commit, `VACUUM` in a worker beside the kit's connection, and read-only viewing | Phase 4's smoke test, on Windows, with a 100,000-transaction ledger |
| Cold disks (Linux wouldn't let a user evict the cache here) | Phase 4's smoke test |
| The Loki engine: removal time, and a read-only open | Phase 3's and Phase 4's tests (Loki's sizes are small; its save already rewrites the file) |
| Which plugins write when a ledger opens | [Phase 3](#phase-3-opening-an-archive-read-only-m), by opening a read-only copy with every bundled plugin active |
| Anything on macOS | Each phase's smoke test, where a Mac is at hand |

---

## Phase 1: the archive contract and the accounts rules (M)

No visible change.

- **`@tessera/ledger-api`:** `ArchiveParticipant`, `ArchiveRequest` (with `options`), `ArchiveDescription` (with
  `notes`, `warnings` and `options`), `ArchiveOption`, `participateInArchive`, `onDidArchive`,
  `LEDGER_COLLECTIONS.archives`.
- **The session:**
  - the archive participants, in the order they joined;
  - an internal `runArchive(before, options)` (not on `LedgerSession`): one storage transaction on the raw database, each
    participant's `archive` with a scoped transaction and the `earlier` map, then the `ledger.archives` record; then
    `committed` on each, and `onDidArchive`;
  - the change count, advanced by the existing `onDidChange` watch.
- **`@tessera/accounts-api`:** `Account.lastArchiveDate`, `Account.archived` (`AccountArchived`), and
  `AccountsArchived` with `removedAccountIds`.
- **`accounts`:**
  - `planArchive` (pure): the rule, transfers, the carried amounts, closed accounts with nothing left, and, for
    `describe`, the counts, the warning about unreconciled transactions, the notes on closed accounts that stay, and
    the `accounts.removeClosedAccounts` option;
  - `applyArchive`: removes the planned transactions, updates each account's `openingBalance`, `lastArchiveDate` and
    `archived` (never `openingDate`), removes closed accounts with nothing left when the option is on, and removes
    finished reconciliations before the date except the last;
  - the balance check (every account, and every currency's total) and the transfer check, throwing on any difference,
    with the sums from `sumTransactions(docs)`, one plain pass, not the kit's aggregate;
  - the removal written as [Keeping the window responsive](#keeping-the-window-responsive) says: deleting by id,
    never with `$in`, and yielding every 2,000 writes and between steps (the import participant too, in Phase 2);
  - `nextNumber` follows `archived.highestNumber`;
  - the account dialog and `updateAccount` refuse to set `lastArchiveDate` and `archived`;
  - joins as a participant; `committed` announces one `AccountsChange`.
- **Tests:**
  - `accounts/archive.test.ts`: the worked cases, the example, transfers, the opening date unchanged, the last
    archival date, closed accounts with nothing left (and each reason one stays), the warning, minimum balances, two
    archives in turn, reconciliations, the cheque number, the property test, and the check catching a wrong carry;
    `sumTransactions` equal to `sumsByAccount` on random ledgers; the event loop turning during a large removal;
  - `ledger/archive.test.ts` (its session half): participants in order with `earlier`; options passed to each; a throwing participant rolls
    back every participant; the record; `committed` not called after a rollback; the change count.

**Exit:** a test archives a ledger through the session, and every balance is as it was. The suite is green.

### Phase 1 results

Done 2026-11-10. **No visible change:** the ledger can run an archive through its participants, and the accounts plugin
takes part, but nothing in the user interface starts one yet.

| What | Where |
|---|---|
| The contract: `ArchiveParticipant`, `ArchiveRequest`, `ArchiveDescription`, `ArchiveWarning`, `ArchiveOption`, `ArchiveResult`; `participateInArchive` and `onDidArchive` on `LedgerSession`; `ArchiveRecord`, `ArchiveOutcome`, `LedgerArchived`; `LEDGER_COLLECTIONS.archives`; the error code `ARCHIVE_FAILED`. API version 1.1.0 | [ledger-api service.ts](../packages/ledger-api/service.ts), [model.ts](../packages/ledger-api/model.ts), [protocol.ts](../packages/ledger-api/protocol.ts), [errors.ts](../packages/ledger-api/errors.ts) |
| The participants and their one storage transaction: in the order they joined, each with a transaction scoped to its own collections and the `earlier` map, then the record; `committed` after the commit; nothing removed refused; whatever a participant throws marked as its failure | [archive/participants.ts](../plugins/ledger/src/privileged/archive/participants.ts) |
| The session: `participateInArchive`, `onDidArchive`, and, for the ledger's own Archive command (Phase 4), `runArchive`, `describeArchive`, `archiveRecords` and `changeCount`; the date and options checked | [LedgerSessionImpl.ts](../plugins/ledger/src/privileged/LedgerSessionImpl.ts), [index.ts](../plugins/ledger/src/privileged/index.ts) |
| `ledger.archives`, declared with the ledger's own collections | [SchemaRegistry.ts](../plugins/ledger/src/privileged/SchemaRegistry.ts) |
| The accounts contract: `Account.lastArchiveDate`, `Account.archived` (`AccountArchived`), `AccountsArchived`, `ACCOUNTS_ARCHIVE_OPTIONS`; `openingDate` and `openingBalance` documented for archives. API version 1.9.0 | [accounts-api model.ts](../packages/accounts-api/model.ts), [protocol.ts](../packages/accounts-api/protocol.ts) |
| The rules: `planArchive` (pure), `describePlan`, `applyArchive`, `verifyArchive` | [archiveCore.ts](../plugins/accounts/src/privileged/archiveCore.ts) |
| `sumTransactions`, the one-pass sums; `nextNumber` following `archived.highestNumber` | [transactionsCore.ts](../plugins/accounts/src/privileged/transactionsCore.ts) |
| The participant (`archiver`); `lastArchiveDate` and `archived` refused as input and carried through every edit | [AccountsServiceImpl.ts](../plugins/accounts/src/privileged/AccountsServiceImpl.ts), [index.ts](../plugins/accounts/src/privileged/index.ts) |
| *Taking part in archives* for plugin authors; the account's new fields and the session's new members | [plugin-creation.md](plugin-creation.md#storing-data-in-the-ledger), [account-manager-design.md](account-manager-design.md#accounts) |

Decisions and departures:

- **`runArchive` needs the archive file** (`copy`), and refuses without one. It isn't on the public contract: it is the
  ledger's own, like `withOpenLedger`, for the Archive command to call once it has made the copy. So an archive can't
  be run without its file, even from inside the ledger.
- **Whatever a participant throws is `ARCHIVE_FAILED`, with its message, a ledger error included.** The session's own
  refusals keep their codes: `INVALID` on the date, and `CONFLICT`. Without this, a participant's `INVALID` would reach
  the dialog as a mistake in the date. A test caught it: the scope guard, which refuses a participant reaching another
  plugin's collection, throws an `INVALID` ledger error.
- **`CONFLICT` covers two cases.** One is the ledger changing after the copy began, which the change count catches.
  The other is the kit refusing the commit because something outside the transaction changed the same collections.
  Phase 4 tries once more on either.
- **An archive that removes nothing is refused** (`INVALID` on `before`), and writes no record. The dialog disables
  Archive then anyway.
- **The check does more than the design listed.** It also holds every opening date unchanged, and refuses the removal
  of anything unreconciled or dated on or after the archive date. It refuses an account that appears, and one that
  goes without being planned to or with a balance. It can't be switched off or bypassed. It earns its place on damaged
  data: three transactions sharing one transfer id (which the service never makes) would make the plan split the
  transfer. The check refuses that archive, and nothing is removed.
- **A transaction whose account no longer exists is never archived.** It has no balance to carry into.
- **A closed account that never had a transaction,** with a zero opening balance, counts as having nothing left, and is
  removed with the others.
- **Notes are given only for what the user can act on:** a closed account left empty that stays because of its
  balance, or because a reconciliation of it is under way. One with later activity, or kept because the option is off,
  needs no note.
- **The description's `count` is transactions plus closed accounts.** The reconciliation records that go with them
  aren't counted. `describe` always answers, with a count of 0 when nothing qualifies, so the warning about
  unreconciled transactions still shows then.
- **Messages give dates as YYYY-MM-DD,** as the accounts plugin's other messages do ("The transaction of 2026-10-02 is
  reconciled."). The dialog mock-up reads "1 Jan 2026": Phase 4 decides whether the dialog formats the date itself.
- **Records are listed newest first, with the id breaking a tie.** Two archives in the same millisecond came out oldest
  first: the fixed clock in the tests found this.
- **`@tessera/ledger-api` goes to 1.1.0.** It stayed at 1.0.0 through the backup additions, and this is its first
  change since. `@tessera/accounts-api` goes to 1.9.0, as each of its additive changes has.
- **After the commit, `accounts` announces one change.** It lists every account it touched (`updated`, `transactions`,
  `balances`), every account it removed (`deleted`), and those whose reconciliations it removed.
- **Yields:** the ledger lets the event loop turn before each participant. The accounts participant yields after
  reading, after planning, every 2,000 writes, and before the check.

Verification:

- **Tests.** The full suite passes: 147 files, 2,284 tests (2,243 before).
  - `tests/plugins/accounts/archive.test.ts` (new, 27):
    - the worked cases, the carry (voids excepted) and the highest cheque number, transfers, a missing account;
    - **the design's example**, end to end: every balance the same, the opening date unchanged, the last archival date
      and `archived`, the running balances of what stays;
    - minimum and available balances; several archives in turn (later dates, counts adding up, an earlier date after
      a later one, nothing new refused); cheque numbers; the fields refused as input and kept through an edit;
    - transfers through the service, with the warning;
    - closed accounts: offered, removed with their reconciliations, totals unchanged, names free again, kept with the
      option off, and a note for each that stays for a reason;
    - the description: the warning by account, nothing after the date, a count of 1,234 shown as "1,234";
    - **reconciliations, through the real reconcile flow**: January's and February's statements (with a balance
      adjustment) removed, each account's last kept, one under way left with its mark, and finished afterwards;
    - one change announced after the commit; everything rolled back, and nothing announced, when a participant after
      `accounts` fails; damaged data refused by the check; the event loop turning during a 2,500-transaction removal;
    - the check itself, fed a wrong carry, a moved opening date, a split transfer, an unreconciled and a too-recent
      removal, an account gone with a balance, and one that appeared;
    - **on random ledgers:** `sumTransactions` equal to `sumsByAccount` (10 ledgers); and over 40 seeded ledgers
      (accounts in two currencies, closed accounts, transfers, voids, reconciliations, some under way), every balance,
      every running balance from the date on, every total and opening date unchanged, no transfer split, nothing
      unsettled removed, and the dialog's count equal to the archive's. The test also requires that its ledgers reach
      every case. On this run all 40 archived something: 17 removed a closed account, 13 kept one because the option
      was off, 21 kept a transfer because of its other side, and 19 removed transfers whole.
  - `tests/plugins/ledger/archive.test.ts` (new, 13): joining; the order, the options and `earlier`; each reaching only
    its own collections; the description, with a failing participant left out; the record, newest first; everything
    rolled back on a failure; nothing to archive; a participant that doesn't say what it removed; `committed` and the
    event, in order, after the commit; the change count; the file-operation queue; the date (today allowed, tomorrow
    and impossible dates refused), the options and the copy checked; a participant's own ledger error reported as its
    failure.
  - `tests/plugins/accounts/activation.test.ts` (+1): the plugin joins the ledger's archives, and describes one.
  - Updated: the session's exact contract (`activation.test.ts`), and the API packages' names (`apiPackages.test.ts`).
- **The tests fail without each change.** 37 changes were undone in turn, by a script, and each time tests failed:
  - **in the rules:** cleared transactions counted as settled; a transfer's side going alone; voids carried; nothing
    carried; the opening date moved, as the first draft had it; the last archival date always the newest; the original
    opening balance overwritten; a closed account removed with a balance, or while being reconciled; the option
    ignored; each account's last reconciliation removed, or one under way; no warning; no option offered; no yield at
    the 2,000th write; the check skipped, or ignoring balances or split transfers;
  - **in the accounts plugin:** `sumTransactions` counting uncleared amounts as cleared; `nextNumber` forgetting
    archived cheques; an edit dropping the new fields; the fields accepted from a form; no change announced; the plugin
    not joining archives;
  - **in the ledger:** the public session without `participateInArchive`; participants given the unscoped
    transaction; `earlier` not passed on; an archive of nothing allowed; no record; `committed` called before the
    commit; records oldest first; a participant's ledger error passed on as it was; the change count not checked, or
    not counted; a date after today allowed; no event; the run outside the file-operation queue.

  The check being skipped was caught only after a test gave it damaged data to refuse. Until then nothing showed it
  was called, since a correct removal never needs stopping.
- **Two bugs found on the way,** both by tests: the date check threw a `RangeError` on "2026-13-01" instead of refusing
  it, and records made in the same millisecond came out oldest first.
- **On the spike's SQLite ledgers, with the code as shipped** (the real session opening the file, and the real accounts
  participant; import lines aren't pruned until Phase 2, and the commit is still on the main thread until Phase 5):

  | Transactions | Archive date | Removed | Total | Longest stall |
  |---|---|---|---|---|
  | 10,000 | 1 Jan 2022 | 5,001 transactions, 1 closed account | 186 ms | 63 ms |
  | 10,000 | 1 Jan 2026 | 8,928 transactions, 2 closed accounts | 165 ms | 59 ms |
  | 100,000 | 1 Jan 2022 | 49,697 transactions, 1 closed account | 1.25 s | 0.57 s |
  | 100,000 | 1 Jan 2026 | 89,310 transactions, 2 closed accounts | 1.56 s | 0.67 s |

  The counts are exactly those of the spike's prototype. The longest stall is the SQLite commit, as the spike
  predicted; Phase 5 moves it to the driver's worker.
- **The plugins build** (`npm run build:plugins`: all nine).
- **Types:** no new errors in any project (core 3, shell 16 and tests 28, as before; shared, plugins, scripts and the
  four packages clean).

## Phase 2: imports follow the archive (M)

No visible change until an archive exists, which only Phase 4 can make: then the import summary says how many lines
it left out, and why. Nothing to check by hand in this phase; the summary's new line is covered by the dialog's tests,
and seen in Phase 4's smoke test.

- `ImportCounts.archived` in `@tessera/import-api`.
- **The import participant** (`plugins/import/src/privileged/archive.ts`): removes the line records of removed
  transactions and skipped lines, only before the archive date; removes batches with no lines left; removes every
  record of a closed account the archive removed. It reads `AccountsArchived` from `earlier`.
- **The skip rule** in `run.ts`: lines dated before the account's `lastArchiveDate` are never added, and are counted.
  The summary dialog says how many, and why.
- **Tests** (`import/archive.test.ts`, and additions to `run.test.ts`):
  - pruning: before the date, for removed transactions and skipped lines only; records kept on and after the date;
    batches; pending reviews; proposals untouched; a removed account's links, lines and batches;
  - **re-importing every statement of an archived ledger adds nothing**, using the corpus, including posting delays
    across the date;
  - the summary's count.

**Exit:** in a test, a ledger with imported statements is archived and every statement is imported again: nothing is
added, and every balance is unchanged.

### Phase 2 results

Done 2026-11-10. **No visible change yet:** the import summary's new line appears only once an account has been
archived, which only Phase 4 can do.

| What | Where |
|---|---|
| `ImportCounts.archived` (absent when none) and `StatementReport.lastArchiveDate`. API version 1.2.0 | [import-api manager.ts](../packages/import-api/manager.ts) |
| The participant: prunes the line records an import can no longer add again, the batches left empty, and every record of a closed account the archive removed; tells the registers once the archive is committed | [archive.ts](../plugins/import/src/privileged/archive.ts) |
| Joining the ledger's archives, after `accounts` | [index.ts](../plugins/import/src/privileged/index.ts) |
| An import never adds a line dated before its account's last archival date; such a line can still be matched | [run.ts](../plugins/import/src/privileged/run.ts) (`importStatement`) |
| The summary's sentence for lines left out as dated before the last archival date | [SummaryDialog.tsx](../plugins/import/src/renderer/SummaryDialog.tsx) |

Decisions and departures:

- **A line dated before the last archival date is never *added*, but can still be *matched*** to a transaction that
  stayed. The first draft left it out altogether, which would have stopped an old outstanding cheque, which the
  archive deliberately keeps, from ever being matched when the bank finally clears it. A proposal adds nothing until
  the user accepts it, so it can't bring an archived transaction back. The matcher never proposes an archived
  transaction in any case: it is gone.
- **Records are pruned only where the import's rule now covers them:** dated before this archive's date, in an
  account whose last archival date is now at or after it. This matters for *skipped* lines. In an account the archive
  removed nothing from, the account gets no new last archival date, and the record is all that stops the line being
  added again, so it stays.
- **Only this archive's date counts, not the account's later one.** An archive to an earlier date than the last leaves
  the records between the two dates alone. They will have been dealt with when the later archive ran, or still
  belong to a transaction.
- **A batch goes only when this archive emptied it,** and never while it is still being applied: recovery from an
  interrupted import settles that one. A removed account's batches and saved account matches all go.
- **What the accounts plugin shared is read defensively.** It comes from another plugin's copy of the package. A
  malformed list is treated as empty, not read as text, which a test holds to.
- **The participant describes nothing for the dialog.** Which records go depends on what `accounts` removes, and there
  is nothing for the user to decide. The ledger's record lists what it removed: "44,675 imported bank lines".
- **`ImportCounts.archived` is absent when none was left out,** so a report for an account never archived is exactly
  as before. Batches recorded before this phase don't have the field either.
- **The summary gives the date as YYYY-MM-DD**, as Phase 1's messages do. Phase 4 decides how dialogs show dates.
- **The re-import test uses the sample statements (samples/statements), not the matching corpus.** The corpus holds
  registers and statements for the matcher, not statements to import twice. The samples are real OFX files, and
  November's repeats five October lines across the archive date. The posting delay is tested by its own case: a line
  posted after the archive date for a transaction the user dated before it.
- **The import tests reach the ledger's own session** by spying on `LedgerSessionImpl.prototype.participateInArchive`
  while the plugins activate. The spy records the session the plugins join, and is restored before anything else
  runs, since test files share workers. The ledger publishes only its public contract, and this adds nothing to it.
  The import harness now gives the ledger the same fixed clock as the import.

Verification:

- **Tests.** The full suite passes: 148 files, 2,299 tests (2,284 after Phase 1).
  - `tests/plugins/import/archive.test.ts` (new, 14):
    - the participant on records made by hand: which go (a removed transaction's, a skipped line, a pending review,
      a proposal, all before the date) and which stay (a kept transaction's, one posted after the date, a skipped
      line where the archive removed nothing); only this archive's date; an account whose last archival date is
      older; batches (emptied, partly, still being applied, untouched); a removed account's lines, batches and saved
      matches; nothing without what `accounts` shared, and a malformed share refused; the registers told only once
      the archive is committed; the event loop turning at the 2,000th removal;
    - the plugins together: **the October and November sample statements imported, reconciled, archived and imported
      again, adding nothing, with every balance the same.** October's 17 lines and November's five October lines are
      left out; November's own five are known. Also: a line posted after the archive date, whose record keeps it
      known; an old cheque matched by a line dated before the archival date, while a line never in the ledger is left
      out and one after the date is added; an account never archived unchanged; a removed closed account's records
      gone, and the registers of the rest refreshed; everything rolled back with the ledger's other participants, the
      import still knowing its lines afterwards.
  - `tests/plugins/import/renderer/dialogs.test.tsx` (+1): the summary's sentences for lines left out as dated before
    the last archival date, alone and with lines added, matched, already imported or unreadable.
- **The tests fail without each change.** 23 changes were undone in turn, by a script, and each time tests failed:
  - **in the participant:**
    - lines on or after the date pruned;
    - accounts the archive didn't reach pruned;
    - the account's date ignored;
    - skipped lines kept;
    - proposals of removed transactions kept;
    - lines of kept transactions pruned;
    - a removed account's lines kept, or its saved matches;
    - emptied batches kept;
    - a batch still being applied removed, or one only partly emptied;
    - no yield;
    - the registers not told, or told before the commit;
    - what `accounts` shared read carelessly;
    - the plugin not joining archives;
  - **in the import:**
    - lines before the date added;
    - lines before the date not even matched;
    - the lines left out not counted, or counted when there were none;
    - no date in the report;
  - **in the summary:** the lines left out not mentioned, or the nothing-new case ignoring them.

  Reading what `accounts` shared carelessly was caught only after the test's malformed list was one that would do
  harm: text read as a list of its letters, with a line whose transaction id was one of them.
- **On the spike's SQLite ledgers, with the code as shipped,** the import's records pruned now too. The commit is
  still on the main thread until Phase 5:

  | Transactions | Archive date | Removed | Total | Longest stall |
  |---|---|---|---|---|
  | 10,000 | 1 Jan 2022 | 5,001 transactions, 1 closed account, 2,476 import lines | 0.37 s | 90 ms |
  | 10,000 | 1 Jan 2026 | 8,928 transactions, 2 closed accounts, 4,404 import lines | 0.53 s | 207 ms |
  | 100,000 | 1 Jan 2022 | 49,697 transactions, 1 closed account, 24,820 import lines | 2.74 s | 0.71 s |
  | 100,000 | 1 Jan 2026 | 89,310 transactions, 2 closed accounts, 44,675 import lines | 2.88 s | 0.97 s |

  The stall is the commit, now deleting the import's lines too. Phase 5's worker commit brought a commit of this size
  to about 50 ms in the spike. Of the ledger's 49,905 import lines, 5,230 stay at the 2026 date: the lines for
  transactions still there, and lines posted on or after the date.
- **The plugins build** (all nine). **Types:** no new errors in any project (core 3, shell 16 and tests 28, as
  before; the rest clean).
- **One full run had seven failures** in the slowest form tests (the Appearance and Fonts pages, the account dialog),
  each past the 15-second test timeout while the machine was busy. None of them touches archiving, and the suite
  passed in full when run again on its own. The timeout comment in `vitest.config.ts` describes these tests.

## Phase 3: opening an archive read-only (M)

No visible change until an archive exists (tests make them with `snapshot` and `kind: 'archive'`).

- `BackupKind` gains `'archive'`; `LEDGER_BACKUP_META.archiveBefore`; `LedgerInfo.archive`; the
  `ledger.isArchive` key.
- **The session:**
  - `inspect` lets an archive through for viewing, and still refuses every other backup;
  - `openFile` opens it read-only: migrations from 0 are skipped, and a file needing any other migration is refused
    with the Restore advice;
  - no id on `LedgerInfo`, not in the recent list, not `ledger.last`;
  - the automatic backup never backs up an open archive.
- **Guards from the spike's list:** each `opened` listener that writes checks `ledger.readOnly` (the import plugin's
  recovery of interrupted imports at least).
- **Disabled for an archive:** Back Up Ledger… and Delete Ledger… gain `!ledger.isArchive`. Archive Ledger…, when it
  arrives, is already disabled by `!ledger.isReadOnly`.
- **The status item**, "Archive of “Home”, before 1 Jan 2026 · read-only".
- **Open Ledger…'s file dialog** gains the "Tessera archive" filter.
- **Retention** skips any backup of kind `archive`. **Restore** lists the `Archives` folder's archives, labelled, and
  never takes an open archive for its ledger.
- **Tests:** `ledger/archiveOpen.test.ts` (including a manual and an automatic backup still refused by Open);
  additions to `retention.test.ts` and `restore.test.ts`; on real SQLite, the archive byte-identical after being
  viewed, and no side files left.

**Exit:** an archive made by a test opens read-only with every account and transaction in it. Nothing can change it,
and the file is unchanged afterwards.

Smoke test: open an archive, browse registers, try to edit (refused), close it, and check the recent list.

### Phase 3 results

Done 2026-11-10. **Visible change, with an archive file to open:** File › Open Ledger… opens an archive file read-only,
with a status item saying what it is; File › Restore Ledger… lists archive files, and restores them. No archive can be
made in the app until Phase 4, so **`npm run sample:archive`** makes one to try (below).

| What | Where |
|---|---|
| `BackupKind` gains `'archive'`; `LEDGER_BACKUP_META.archiveBefore`; `LEDGER_ARCHIVE_FILTER`, `LEDGER_ARCHIVES_FOLDER`; `LedgerInfo.archive` (`LedgerArchiveInfo`); the context keys `ledger.isArchive` and `ledger.archive`; `BackupInfo.archiveBefore`. API version 1.2.0 | [ledger-api protocol.ts](../packages/ledger-api/protocol.ts), [model.ts](../packages/ledger-api/model.ts) |
| Open: `inspect` recognises an archive file (`archiveOf`: kind `archive` and a valid archive date) and lets it through; `openArchive` opens it read-only, with no migrations, no id, no recent list and not remembered to reopen; refuses one whose data needs upgrading; notes WAL mode; Open's file dialog offers archives; Delete refuses an open archive | [LedgerSessionImpl.ts](../plugins/ledger/src/privileged/LedgerSessionImpl.ts) |
| `LedgerDisk.walMode`, from the file's header | [disk.ts](../plugins/ledger/src/privileged/disk.ts) |
| The context keys, and the status item "Archive of “Home”, before 2026-01-01 · read-only" | [ipc.ts](../plugins/ledger/src/privileged/ipc.ts), [contributions.ts](../plugins/ledger/src/privileged/contributions.ts) |
| Never backed up: not as it closes, not on quitting, and Back Up Ledger… disabled | [autoBackup.ts](../plugins/ledger/src/privileged/backup/autoBackup.ts), [command.ts](../plugins/ledger/src/privileged/backup/command.ts) |
| Retention never trims an archive; Restore lists the `Archives` folder's archives, and restores an open one | [retention.ts](../plugins/ledger/src/privileged/backup/retention.ts), [restore.ts](../plugins/ledger/src/privileged/backup/restore.ts), [RestoreDialog.tsx](../plugins/ledger/src/renderer/RestoreDialog.tsx) |
| **The sample archive:** a household ledger over nearly four years, reconciled monthly, archived before 2026 | [scripts/sample-archive/household.ts](../scripts/sample-archive/household.ts), [scripts/sample-archive.mts](../scripts/sample-archive.mts) |

**The sample archive.** `npm run sample:archive -- [folder] [--replace]` makes `Household.tessera` and
`Archives/Household (archive before 2026-01-01).tesserabkp` (by default in `samples/archive`, which git ignores). It
takes a few seconds:

- **It is built through the real code.** The ledger session, the accounts service and the SQLite engine are bundled
  with esbuild as the plugin build bundles them.
- **It is generated, not kept in the repository,** so it is always in step with the code. An archive opens read-only
  and can't be migrated, so a kept file would stop opening the first time a plugin's data changed.
- **A test makes it too** (`sampleArchive.test.ts`), so it can't quietly stop working.

What is in it:

| Account | Its history |
|---|---|
| Chequing | Pay twice a month; rent by cheque (numbered from 101); groceries weekly; hydro; a transfer to savings and the Visa bill each month |
| Savings | A minimum balance of 5,000, shown as available; monthly interest |
| Visa | Four purchases a month, paid in full |
| Old Savings | Closed in March 2024, emptied into Savings |
| Store Card | Closed in June 2024 with 42.17 written off |

Everything is reconciled month by month to September 2026, then archived before 1 January 2026. What is left to see:

- **Archived:** 644 transactions from five accounts, and the empty Old Savings with them.
- **Still in the ledger, from before the date:**
  - a cheque never cashed;
  - a Visa charge cleared but not reconciled;
  - a year-end transfer whose savings side isn't reconciled.
- **Kept, with its note:** the Store Card, closed with a balance.

The script prints what the Archive dialog would have said, and how to try both files.

Decisions and departures:

- **An archive opened by Restore is a backup to copy, not one to view.** With `allowBackup`, the restore's own open
  takes the usual path and strips the backup meta, as before. So restoring an archive, in place or as new, gives an
  ordinary writable ledger.
- **Restore can restore an archive while it is open.** The check that refuses "the open ledger" doesn't apply to an
  open archive: restoring it in place of its ledger is how an archive is undone, and the natural moment to do it is
  while looking at it.
- **The automatic backup skips an open archive, not every read-only ledger.** The first draft said read-only. A
  read-only ledger that isn't an archive (a file lock, later) keeps today's behaviour. An archive would otherwise have
  been backed up as it closed, because with no id it counts as never backed up. A test catches that.
- **Back Up Ledger… is disabled for an archive; Delete Ledger… already was,** being disabled for every read-only ledger.
  The session refuses to delete an open archive too. A guard in the Back Up command itself was removed: the runtime
  never runs a disabled command, so it could not be reached.
- **New Ledger… is disabled while an archive is open,** as for any read-only ledger today. Open and Close work, and
  Open is how to go back to the ledger.
- **WAL mode is logged, not shown** ([above](#why-read-only)).
- **The status item gives the date as YYYY-MM-DD,** as Phase 1's messages do, since the text is made in the main
  process. The Restore dialog, in the renderer, shows it in the user's format ("1 Jan 2026"). Phase 4 settles dates
  everywhere.
- **An archive's name is its file's name without `.tesserabkp`:** "Home (archive before 2026-01-01)". The ledger's own
  name helper strips only `.tessera`; a test caught the difference.
- **No plugin writes when an archive opens.** This was the spike's open question. The sample's test opens the archive
  with every plugin that touches a ledger active (ledger, accounts, import, OFX), on real SQLite. It browses every
  register and the import's marks. Nothing is logged, not even a warning, and the file is unchanged. The import's
  recovery already checked `readOnly`.

Verification:

- **Tests.** The full suite passes: 150 files, 2,316 tests (2,299 after Phase 2).
  - `tests/plugins/ledger/archiveOpen.test.ts` (new, 10):
    - opened read-only from Open Ledger…, with its name, its archive details, no id, the keys and the file filter;
    - every write refused, and the file as it was;
    - out of the recent list, with the next start reopening the ledger;
    - never backed up: disabled, not as it closes, not on quitting, not when switching away;
    - can't be deleted;
    - gives way to the ledger;
    - every other backup still refused, one without a valid archive date, and one of another kind carrying an
      archive date;
    - a plugin installed since reads as empty, with its migrator not called;
    - one whose data needs upgrading refused, with the Restore advice;
    - WAL mode noted.
  - `tests/plugins/ledger/sampleArchive.test.ts` (new, 1): the sample made, its summary and what the dialog would have
    said, no overwriting; then the archive opened with every plugin active on real SQLite, every register and the
    import's marks read, the ledger with the same balances and without what was archived, the archive byte for byte
    as it was, nothing beside it, nothing logged.
  - `restore.test.ts` (+3): archive files listed from the `Archives` folder, and nothing else there; one restored in
    place of its ledger while open; one restored as a new ledger.
  - `retention.test.ts` (+1): an archive file in the default folder never trimmed.
  - `files.test.ts` (+1): on real SQLite, an archive opened and closed, byte for byte and in modification time as it
    was, with no side files; the header read as rollback for it and WAL for the live ledger.
  - `restoreDialog.test.tsx` (+1): "Archive file: everything before 1 Jan 2026", the date the same in every time zone.
  - Updated: the status items (`activation.test.ts`).
  - The archive tests were also run in the Vancouver, Auckland and UTC time zones. One of them would have failed west
    of UTC as first written, because it compared a UTC time with the test's local clock.
- **The tests fail without each change.** 25 changes were undone in turn, by a script, and each time tests failed:
  - **Opening:**
    - every backup let through;
    - any kind taken for an archive;
    - an archive without its date taken for one;
    - an archive opened as a ledger;
    - a restore opening an archive read-only;
    - an older archive opened;
    - opened writable;
    - given its ledger's id;
    - added to the recent list;
    - its name keeping `.tesserabkp`;
    - no note of WAL mode;
    - no archive filter in Open;
    - an open archive deleted;
    - `walMode` never true;
  - **Backups:** an archive backed up as it closes; Back Up enabled for an archive;
  - **Keys and status bar:** no `isArchive` key, no status text, no status item;
  - **Retention and Restore:**
    - archives trimmed;
    - Restore not listing the `Archives` folder, or listing anything in it;
    - an archive described as a manual backup;
    - an open archive refused by Restore;
    - the dialog not saying what an archive holds.

  "Any kind taken for an archive" was caught only once a test gave Open an ordinary backup that carried an archive
  date.
- **The plugins build** (all nine). **Types:** no new errors (core 3, shell 16 and tests 28, as before; the rest clean).
  Three errors in the new tests' own code were found by the type check and fixed.

Smoke test, in `npm run dev` (still to do):

- `npm run sample:archive`, then open the archive: the status item; the registers back to January 2023; every edit
  refused; Back Up, Delete and New greyed out.
- Open the ledger: its registers start at 2026, each with a first row of its opening balance, every balance as in the
  archive. The first row still shows the opening date until Phase 4.
- Restore the archive in place, and check the ledger's history is back.
- Close, quit and start again: the archive is not in the recent list, and isn't reopened.

## Phase 4: the Archive Ledger command (L)

**Visible change:** File › Archive Ledger….

- **The command** `ledger.archive`, with its argument, and the menu item in the `ledger.backup` group after Restore
  Ledger….
- **The dialog** `ledger.dialog.archive` (`ArchiveDialog.tsx`):
  - the agreed text, word for word, with *archive file*;
  - the date, suggested by the Archiving page's settings, with its limits, and "Last archived…";
  - the preview, refreshed after a pause while typing, with Archive disabled when there is nothing;
  - the warning about unreconciled transactions, by account;
  - the participants' options as check boxes (removing closed accounts with nothing left);
  - where the archive file goes;
  - the steps, with the percentage while copying.
- **The Archiving page** (`ledger.archive` settings namespace, `ledger.archive.settings` page under Ledger): the year
  start and the years kept, with `suggestedArchiveDate`.
- **The channels** `ledger:archive.preview` and `ledger:archive.run`, and the `ledger:archive.progress` event. They
  are answered only while the command has the dialog open, and the operation is held until any run has finished.
- **`ArchiveService`:**
  - the copy through `BackupService.backUpDatabase` (`kind: 'archive'`, `backup.archiveBefore`), into the `Archives`
    folder, named with ` (2)` when needed;
  - the check and the rename;
  - the change-count check, with one retry;
  - `runArchive` (Phase 1), and the copy deleted if it rolls back;
  - the message and the status bar text.
- **The register and the account dialog:** *Opening balance* dated the last archival date, and its tooltip; the
  dialog's note and last archival date.
- **Tests:**
  - `ledger/archive.test.ts`, the command half: end to end with the dialog played by the test; the copy's contents and
    meta; every failure step leaving the ledger unchanged; the operation; enablement;
  - `archiveDialog.test.tsx` and `archiveSettings.test.ts`;
  - the register's first row and the account dialog;
  - `files.test.ts` on real SQLite: archive, view the copy, re-import.

**Exit:**

- A user can archive a ledger, and every balance is unchanged.
- The archived transactions are in the copy, which opens read-only.
- Re-importing old statements adds nothing.
- The suite is green.

Smoke test, on Windows at least:

- archive a ledger with imports, reconciliations, an old uncleared cheque and a closed account, and compare every
  account's balances with a screenshot from before. The warning names the cheque's account; the closed account goes;
- change the year start on the Archiving page, and check the dialog's suggestion;
- open the copy, then restore it in place of the ledger, and check the ledger is as it was before archiving;
- archive a 100,000-transaction ledger, watching the steps and whether the window stays responsive.

### Phase 4 results

Done 2026-11-10. **Visible change:** File › Archive Ledger…, its dialog, the Archiving page under Tools › Options… ›
Ledger, and the register's first row dated the last archival date. Its smoke test in Electron is still to do
([below](#smoke-test-for-phase-4)).

| What | Where |
|---|---|
| `ledger.archive` and `ledger.archiveSettings`; `ledger.dialog.archive`; the channels `ledger:archive.preview` and `ledger:archive.run`, and the event `ledger:archive.progress`; `ArchiveLedgerArgs`, `ArchiveDialogInput`, `ArchiveRunRequest`, `ArchivePreview`, `ArchivePreviewPart`, `ArchiveProgress`, `ArchiveDialogResult`; `LEDGER_ARCHIVE_SETTINGS` and `LEDGER_ARCHIVE_SETTINGS_PAGE`; `displayDate`. API version 1.3.0 | [ledger-api protocol.ts](../packages/ledger-api/protocol.ts), [names.ts](../packages/ledger-api/names.ts) |
| `ArchiveService`: the dialog's starting point, the preview, and the run (the checks, the copy, the removal, the copy deleted on failure, one retry when the ledger changed during the copy) | [archive/ArchiveService.ts](../plugins/ledger/src/privileged/archive/ArchiveService.ts) |
| The command: the operation, the dialog, its channels, the progress, the message and the status bar | [archive/command.ts](../plugins/ledger/src/privileged/archive/command.ts) |
| The Archiving page and `suggestedArchiveDate` | [archive/settings.ts](../plugins/ledger/src/privileged/archive/settings.ts) |
| `BackUpOptions.archiveBefore` (written to the copy's meta, and checked) and `record` | [backup/BackupService.ts](../plugins/ledger/src/privileged/backup/BackupService.ts) |
| The menu item, the dialog, the page and the wiring; the dialog's module | [contributions.ts](../plugins/ledger/src/privileged/contributions.ts), [index.ts](../plugins/ledger/src/privileged/index.ts), [manifest.json](../plugins/ledger/manifest.json) |
| The Archive dialog | [ArchiveDialog.tsx](../plugins/ledger/src/renderer/ArchiveDialog.tsx) |
| `periodStart(account)`. API version 1.10.0 | [accounts-api rules.ts](../packages/accounts-api/rules.ts) |
| The register's first row and its tooltip; the account dialog's note | [display.tsx](../plugins/accounts/src/renderer/display.tsx), [Register.tsx](../plugins/accounts/src/renderer/register/Register.tsx), [AccountDialog.tsx](../plugins/accounts/src/renderer/AccountDialog.tsx) |
| Dates for people through `displayDate`: the accounts' descriptions and checks, the participants' refusals, the status item, the import summary, the Restore dialog | [archiveCore.ts](../plugins/accounts/src/privileged/archiveCore.ts), [participants.ts](../plugins/ledger/src/privileged/archive/participants.ts), [ipc.ts](../plugins/ledger/src/privileged/ipc.ts), [SummaryDialog.tsx](../plugins/import/src/renderer/SummaryDialog.tsx), [RestoreDialog.tsx](../plugins/ledger/src/renderer/RestoreDialog.tsx) |
| The sample archive now archives through `ArchiveService`, as the command does, and the script says how to try File › Archive Ledger… on it | [scripts/sample-archive/household.ts](../scripts/sample-archive/household.ts), [scripts/sample-archive.mts](../scripts/sample-archive.mts) |

The dialog, as built, follows [the sketch](#the-dialog): the agreed text word for word; the date, suggested by the
Archiving page and limited to today, with "Last archived on …" under it; what would be archived, asked for 300 ms
after the date or an option last changed; the participants' notes, their warnings in an `Alert`, and their options as
check boxes; where the archive file goes; then each step beside a spinner, with the percentage while copying.
**Archive** is disabled until the preview has come back with something to archive.

Decisions and departures:

- **The copy is made with `BackupService.backUp`, not `backUpDatabase`.** The plan named the inner method, which is
  for a caller that already holds the session's file-operation queue (the backup as the ledger closes). The command
  doesn't, so it takes the queue like any backup. The copy is checked and renamed into place exactly as a backup is.
- **The copy is not the ledger's latest backup** (`record: false`). A backup normally becomes the ledger's
  `backup.last`, and marks the changes before it as backed up. The archive file can still be deleted if the removal
  fails, so it mustn't: otherwise closing the ledger might skip a backup the user needs. The removal is itself a
  change, so the ledger is backed up as it closes after an archive, as a test checks.
- **The copy's archive date is checked with the rest of its meta,** as the design's step 5 says, so an archive file
  can't be taken for one before a different date.
- **Dates shown to people use `displayDate`** (new in ledger-api): the locale's medium date ("Jan 1, 2026", "1 Jan
  2026"), for the calendar day in every time zone. It replaces YYYY-MM-DD in every message Phases 1 to 3 wrote (the
  accounts' warnings and checks, "There is nothing to archive before …", the status item, the import summary) and the
  Restore dialog's own helper. **File names and logs keep YYYY-MM-DD**, which sorts and reads the same everywhere.
  Tests compare with `displayDate` rather than a fixed string, so they pass in any locale.
- **The Archiving page has three number fields,** not a drop-down for the month: the shell draws a `choice` field as
  radio buttons, and twelve would crowd the page. A drop-down field kind is in [todo.md](todo.md). The descriptions
  give the month's number with its name, and the two common cases.
- **The message lists each participant's summary** after "Removed, all dated before …", instead of one sentence about
  accounts ([above](#the-archive-step-by-step)).
- **Where the archive file goes is a full path** in the dialog and the message, not "Documents › Tessera Backups ›
  Archives" as sketched. The path is what the user would type or paste into Explorer.
- **The run refuses an option no participant offers** (INVALID, with the option's id), so a stale dialog can't send
  a choice that no longer means anything. The date's checks (a date, not after today) and the options' (each on or
  off) are the session's own, made by `describeArchive` before anything is copied. The service had its own copies at
  first; undoing them changed no test, so they were removed.
- **A date with nothing to archive is refused before the copy,** so no archive file is made and deleted again.
- **One retry** when the ledger changed during the copy: the first copy is deleted, and a second one made. A second
  change gives up with "“Home” changed while it was being copied. Try again.", leaving no archive file.
- **An archive still reports if the dialog's window closes while it runs.** The operation was already held until the
  run finished; the command now also takes what the run did, so the message and the status bar still appear.
- **The "checking" step is sent when the copy reaches 100%.** The snapshot's progress ends there, and the check and
  rename follow; the dialog shows "Checking the copy…" for both, as the design's table does.
- **The account dialog's note is a line of text under the opening balance row,** read-only: "On 1 Jan 2025, the last
  archival date. The account opened with 1,000.00." *Opened* stays editable, and saving never sends the archive's
  fields, which only an archive sets.
- **A bug found by the tests:** the service's record of a running archive was a promise that rejected with the
  archive's failure, with nothing listening. Node reported it as an unhandled rejection on every failed archive. It
  now settles either way.

Verification:

- **Tests.** The full suite passes: 153 files, 2,370 tests (2,316 after Phase 3). One run had a single timeout in a
  slow form test (the account dialog), which passes on its own, as before.
  - `tests/plugins/ledger/archiveCommand.test.ts` (new, 23):
    - end to end with the dialog played by the test: the input, the preview, the outcome, what stays and what the
      archive file holds, the record, the steps, the operation released;
    - the archive file's meta, its folder, and ` (2)` for a second one with the same date;
    - the message and the status bar text;
    - the last archive and the Archiving page's suggestion in the dialog's input;
    - options: the chosen one sent, one not offered and one not on or off refused;
    - a date after today, not a date, or with nothing to archive, refused before any copy; today allowed;
    - cancelled; the window closing while the archive runs;
    - the channels answered only while the dialog is open, and one archive at a time;
    - failures: the removal failing (the copy deleted), the copy failing (nothing removed), a change during the copy
      (copied again), a change during both copies (given up, no file);
    - the copy not recorded as the last backup, and the ledger backed up as it closes;
    - the argument: archived without the dialog with the default options, a refusal said, a wrong argument thrown;
    - enablement, and the operation held while the dialog is open;
    - the service's names, message and read-only refusal.
  - `tests/plugins/ledger/archiveSettings.test.ts` (new, 8): the [table](#the-archiving-page), the start day itself,
    years kept, the local date at midnight in UTC+14 and UTC−11, the settings' checks, and the page's fields.
  - `tests/plugins/ledger/renderer/archiveDialog.test.tsx` (new, 14): the agreed text; the date, its suggestion and
    its limit; the preview, notes, warning, option and folder; "Last archived"; one request after several quick
    changes; a date after today or none, without asking; nothing to archive; the date's refusal; the options sent;
    the defaults sent; the steps, busy, with everything disabled; a failure shown and the dialog kept open; Cancel.
  - `tests/plugins/ledger/sampleArchive.test.ts` (+1): File › Archive Ledger… with the ledger, accounts, import and
    OFX plugins active on real SQLite, the dialog played through its channels: the accounts' part with its option,
    the import plugin silent with nothing to archive, every balance unchanged, the account's new opening balance and
    record, and the archive file opened with the whole history. Nothing logged.
  - `register.test.tsx` (+2), `accountDialog.test.tsx` (+4), `accountRules.test.ts` (+1): the first row's date and
    tooltip, and none when never archived; the dialog's note for an asset and a liability, none when never archived,
    and the archive's fields never sent; `periodStart`.
  - `ledgerApi.test.ts` (+1): `displayDate` the same day in UTC+14, UTC and UTC−11.
  - Updated: the File menu, dialogs and settings pages (`activation.test.ts`); Archive disabled for an open archive
    (`archiveOpen.test.ts`); the messages now using `displayDate`.
- **The tests fail without each change.** 50 changes were undone in turn, by a script, and each time tests failed:
  - **The service:**
    - an option no one offers sent;
    - copied with nothing to archive;
    - the copy recorded as the last backup, made as a manual backup, or without its date;
    - the copy kept when the removal fails;
    - no second copy after a change, or copied again and again;
    - changes while copying unchecked;
    - the first archive file replaced;
    - no checking step, no removing step;
    - answered with the dialog closed;
    - no last archive in the dialog;
    - two archives at once;
    - the dialog's archive forgotten;
    - archive files in the backup folder itself;
    - a read-only ledger archived;
  - **The command:**
    - enabled read-only, or while busy;
    - no operation held;
    - no message, no status bar text, or a message that doesn't say where;
    - the dialog's session never ending;
    - an archive after the window closed unreported;
    - the dialog shown despite a date;
  - **The backup service:** no archive date in the meta; `record` ignored;
  - **The Archiving page:** years kept ignored; the start day itself counted as last year; 29 February allowed; today
    taken in UTC; no menu item;
  - **The dialog:**
    - asked at every change;
    - no limit on the date field;
    - a date after today accepted;
    - the options' defaults not sent;
    - Archive with nothing to archive;
    - no last archive shown;
    - warning details hidden;
    - the agreed words changed;
    - the inputs live while archiving;
  - **The accounts:** the first row dated the opening date; no tooltip; no note in the dialog; a liability's opening
    amount with its sign; the period starting on the archive date even before the account opened; ISO dates in the
    accounts' words;
  - **Dates:** `displayDate` in local time.

  "Today taken in UTC" survived at first, because the suite runs in UTC; the test now sets the time zone itself.
- **The plugins build** (all nine), with the import plugin's renderer bundling `displayDate` from
  `@tessera/ledger-api`. **Types:** no new errors (core 3, shell 16 and tests 28, as before; the rest clean). One error
  in the new tests' own code was found by the type check and fixed.

#### Smoke test for Phase 4

In `npm run dev`, on Windows (still to do):

1. **Archive the sample.** `npm run sample:archive -- --replace`, open `samples/archive/Household.tessera`, and note
   every account's balances. It is already archived before 2026, so File › Archive Ledger… before 1 Jan 2026 says
   there is nothing to archive (Archive greyed out). Choose 1 Oct 2026 instead: the preview counts what was reconciled
   in 2026, and the warning names the three unreconciled transactions' accounts. Archive. Check:
   - the steps, and the message naming the archive file and its folder;
   - every balance as before;
   - each register's first row dated 1 Oct 2026, with the tooltip on *Opening balance*;
   - Edit Account… showing the note under the opening balance.
2. **Open the new archive file** from the message's folder with File › Open Ledger…: read-only, with the status item,
   and the history back to 2023. Archive, Back Up and Delete are greyed out.
3. **Restore it in place** with File › Restore Ledger…, and check the ledger is as it was before step 1.
4. **The Archiving page:** set the year start to month 4, day 6, and keep 1 year; the dialog suggests 6 Apr 2025. Try
   month 2, day 29: refused.
5. **A ledger with imports:** import an OFX statement, reconcile it, archive before a date inside it, then import the
   same file again: nothing is added, and the summary says how many lines were left out as archived.
6. **Responsiveness,** if a large ledger is at hand (the Phase 0 spike measured 100,000 transactions; its generator
   isn't in the repository): archive it, watching the steps and whether the window keeps moving. The removal's long
   commit moves off the main thread in Phase 5.

### After Phase 4: entering transactions, and read-only views

Done 2026-11-11, after trying Phase 4 ([the decisions](#decisions-taken-in-review)).

| What | Where |
|---|---|
| `checkArchivePeriod`: no transaction newly dated before its account's last archival date, on either side of a transfer, by any path ([the rule](#entering-transactions-after-an-archive)); a statement's charge refused on the dialog's own field | [transactionsCore.ts](../plugins/accounts/src/privileged/transactionsCore.ts), [reconcileCore.ts](../plugins/accounts/src/privileged/reconcileCore.ts) |
| Accepting a match keeps the transaction's date when the bank's would fall before the last archival date (`matchedDate`), and the Accept tooltip says so | [lineState.ts](../plugins/import/src/privileged/lineState.ts), [review.ts](../plugins/import/src/privileged/review.ts), [annotator.ts](../plugins/import/src/privileged/annotator.ts) |
| The register's new row starts on the last archival date at the earliest, with the calendar starting there | [Register.tsx](../plugins/accounts/src/renderer/register/Register.tsx), [TransactionEditor.tsx](../plugins/accounts/src/renderer/register/TransactionEditor.tsx) |
| `Chart.ledger.readOnly` and `RegisterView.readOnly`; no reconciliation under way in a read-only ledger (`accounts.reconciling`). API version 1.11.0 | [accounts-api model.ts](../packages/accounts-api/model.ts), [protocol.ts](../packages/accounts-api/protocol.ts), [AccountsServiceImpl.ts](../plugins/accounts/src/privileged/AccountsServiceImpl.ts), [ipc.ts](../plugins/accounts/src/privileged/ipc.ts), [register.ts](../plugins/accounts/src/privileged/register.ts) |
| The register, the Accounts navigator and the Ledger panel offer nothing that changes a read-only ledger | [Register.tsx](../plugins/accounts/src/renderer/register/Register.tsx), [Navigator.tsx](../plugins/accounts/src/renderer/Navigator.tsx), [LedgerTree.tsx](../plugins/ledger/src/renderer/LedgerTree.tsx) |

Decisions and departures:

- **The rule is the service's, not the register's.** Every writer goes through it: the register, the statement dialog,
  an import's review, other plugins. The register only makes the common case easy (the default date and the
  calendar).
- **What stayed from before the date can still be edited,** its date included. It stayed because it wasn't
  reconciled, and it must still be cleared and reconciled: the cheque the bank cashed in January is the usual case.
  It can move into the new period, and not back.
- **An account that lost nothing in an archive has no last archival date,** and so no limit. The date is each
  account's, as it is for imports.
- **A reconciliation's own adjustment isn't held to the date.** The reconciliation makes it on the statement's date;
  a statement of the old period reconciled after the archive balances the usual way.
- **A right-click on a register that can't change opens no menu.** Every item in it changes the row, and an empty
  menu would open otherwise. A closed account's register had the same fault, and is fixed with it.
- **The navigator greys out what it can't do** rather than hiding it, as menus do; reconciling, which is offered by
  other plugins and not always there, is left out.

Verification:

- **Tests.**
  - `accounts/archive.test.ts` (+5): a new transaction, one of many, and a transfer's side refused before the date,
    and taken on it; a transaction moved before it refused, one that stayed edited and moved, then not moved back;
    a new transfer side and a moved side held to the other account's date; a statement's charge refused on its field.
  - `import/archive.test.ts` (+1): a match accepted across the date keeps the transaction's date, and the tooltip
    doesn't promise the bank's.
  - `accounts/renderer/register.test.tsx` (+3): read-only: no entry row, no editing, no menu, no key that changes a
    row, the toolbar greyed out; no reconciliation shown; the new row's date and calendar.
  - `accounts/renderer/accountDialog.test.tsx` (+2): the navigator read-only (menu, toolbar, keys), and as before
    otherwise. `ledger/renderer/views.test.tsx` (+1): the Ledger panel read-only.
  - `accounts/register.test.ts` (+1): an archive saved in the middle of a reconciliation opens with none under way.
  - `ledger/sampleArchive.test.ts`: the chart and the register view say read-only for the archive, and not for the
    ledger.
- **The tests fail without each change.** 28 changes were undone in turn, by a script, and each time tests failed:
  each of the rule's checks (a new transaction, a transfer's side, a move, an edit of what stayed, the other side, a
  new side in an edit, the date itself); the charge's field; the bank's date always taken, the tooltip, the review
  ignoring the date; the new row's date, the calendar's limit, and a limit on rows that stayed; the register editable
  read-only, an empty menu, Insert, a reconciliation, the notice; the navigator ignoring read-only, New Account,
  Insert, F2, reconciling offered; the Ledger panel; the chart, the register view and the reconciling key not saying
  read-only. "Insert in a register that can't change" was caught only once the test checked the selection stayed.
- **The suite, types and build:** see [Phase 5's results](#phase-5-results), done with these.

## Phase 5: large commits and compaction in the driver's worker (M)

**Visible change:** the ledger's file shrinks after an archive, and a large archive no longer freezes the window for
up to a second. Driver work only: it depends on nothing but the spike, so it can be done alongside Phases 1 to 3, and
ship before or with Phase 4. If it comes later, Phase 4 ships without the compacting step. Its stall at 100,000
transactions is then the commit's, 0.7 to 0.9 s; at 10,000 it is 0.06 to 0.12 s.

- **Large commits off the main thread:** the SQLite driver applies a batch of 5,000 changes or more through a second
  connection in its worker thread, with the code passed as a string like the snapshot's finishing step. The kit awaits
  it under its commit lock, as it awaits every commit. Smaller batches stay on the main thread. The threshold is a
  constant, tuned in the Windows smoke test.
- `Database.compact()` in [`tessera-types/storage.ts`](../tessera-types/storage.ts); `StorageBackend.compact` in the
  kit, **always under the commit lock**.
- **SQLite:** a free-space check (about twice the live data, from `fs.statfs`), then `VACUUM` through the worker's
  connection, then `wal_checkpoint(TRUNCATE)`. **Loki:** a save. **Memory:** nothing. **Scoped database:** refused.
- **The archive's last step,** "Compacting “Home”". A failure or a skip is logged, and the archive stands.
- **Tests:**
  - the conformance group for every engine;
  - SQLite: a large batch committed in the worker lands whole, or not at all when a change in it fails; a small one
    stays on the main thread;
  - SQLite: the file shrinks after a large delete, to the size of `VACUUM INTO` a fresh file; a commit made during
    `compact` waits for it and then lands (without the lock it would fail with "database is locked", as the spike
    showed); the `-wal` is empty afterwards;
  - compaction skipped when there isn't room;
  - the archive going on when `compact` fails.

**Exit:** after archiving most of a ledger, its file is as small as a new ledger holding what is left. Archiving
100,000 transactions never blocks the main thread for more than about 0.2 s.

Smoke test, on Windows: archive a 100,000-transaction ledger, and check the longest stall and the file's size.

### Phase 5 results

Compaction done 2026-11-11. **Visible change:** after an archive, the dialog shows "Compacting “Home”…", and the
message says how much smaller the ledger's file is: "The ledger’s file is now 7.3 MB, down from 119.4 MB." **Large
commits in the worker are not done**: the archive's commit still runs on the main thread (below).

| What | Where |
|---|---|
| `Database.compact()` in the storage contract | [tessera-types/storage.ts](../tessera-types/storage.ts) |
| The kit: `compact` under the commit lock, after the snapshots already running; a snapshot started meanwhile waits for it; READ_ONLY and NOT_OPEN as for any write. `StorageBackend.compact` | [storage-kit database.ts](../packages/storage-kit/database.ts), [backend.ts](../packages/storage-kit/backend.ts) |
| SQLite: the free-space check, then `VACUUM` and `wal_checkpoint(TRUNCATE)` in a worker thread with its own connection. `SqliteDriverOptions.freeSpace`, for tests | [SqliteDriver.ts](../plugins/storage.sqlite/src/privileged/SqliteDriver.ts) |
| Loki: a save (each one rewrites the whole file). Memory: nothing | [LokiDriver.ts](../plugins/storage.loki/src/privileged/LokiDriver.ts), [memory.ts](../packages/storage-kit/memory.ts) |
| A contributor's database refuses `compact`, as it refuses `snapshot` | [scopedDatabase.ts](../plugins/ledger/src/privileged/scopedDatabase.ts) |
| The archive's last step: `compacting`, the size on disk before and after (`ArchiveOutcome.compaction`), the message. `displaySize` (also used by the Restore dialog now). ledger-api 1.4.0 | [ArchiveService.ts](../plugins/ledger/src/privileged/archive/ArchiveService.ts), [command.ts](../plugins/ledger/src/privileged/archive/command.ts), [ledger-api model.ts](../packages/ledger-api/model.ts), [names.ts](../packages/ledger-api/names.ts) |
| The sample prints its compaction: 4,651 KB to 156 KB | [scripts/sample-archive.mts](../scripts/sample-archive.mts) |

Measured with the shipped code on the spike's ledgers (Linux, Node 24), archiving through `runArchive` and then
compacting through the session:

| Ledger | Archived before | Removed | Compacting | Longest stall of the main thread | File (with its `-wal`) before | After | A fresh copy of what is left |
|---|---|---|---|---|---|---|---|
| 10,000 | 1 Jan 2022 | 5,001 transactions | 0.13 s | 6 ms | 11.9 MB | 3.9 MB | 3.9 MB |
| 10,000 | 1 Jan 2026 | 8,928 transactions | 0.08 s | 1 ms | 13.8 MB | 0.9 MB | 0.9 MB |
| 100,000 | 1 Jan 2022 | 49,697 transactions | 1.8 s | 13 ms | 100.1 MB | 34.3 MB | 34.3 MB |
| 100,000 | 1 Jan 2026 | 89,310 transactions | 1.9 s | 19 ms | 119.4 MB | 7.3 MB | 7.3 MB |

The file ends up exactly the size of a fresh copy, and the window never waits more than 19 ms for it. At 100,000
transactions it takes longer than the spike's bare `VACUUM` (0.5 to 0.7 s): the `-wal` the archive's commit just wrote
is checkpointed as well, which is most of the "before".

Decisions and departures:

- **`compact()` resolves to nothing, as the design has it.** The archive measures the file itself (the file and its
  `-wal`, not SQLite's `-shm` index), so the contract needn't talk about sizes.
- **Snapshots and compaction take turns.** The design said commits wait; snapshots have no lock, so the kit orders
  them too: a compaction waits for a snapshot already running, and a snapshot started during one waits and copies the
  compacted file. SQLite would cope with both at once, but a backup copying a file another connection is rewriting
  would start over, or copy twice the work.
- **Room for twice what is left,** counted in pages in use (`page_count − freelist_count`), against the free space
  `fs.statfs` gives. When the platform can't say, it goes ahead. The reason names both figures: "there isn’t enough
  free space on the disk to compact it (about 72 MB is needed, and 40 MB is free)".
- **A failure never fails the archive,** which is committed by then. It is logged as a warning, and the message ends
  "The ledger’s file couldn’t be made smaller: … Everything was archived all the same."
- **No standalone Compact Ledger command,** as designed: without an archive there is little to give back.
- **Large commits in the worker are left for later.** The user asked for compaction; moving a 5,000-change commit
  off the main thread changes every large commit, imports included, and is a change of its own. Until then, the
  archive's commit holds the window for 0.7 to 0.9 s at 100,000 transactions (0.06 to 0.12 s at 10,000), as Phase 0
  measured. It stays in [todo.md](todo.md).

Verification:

- **Tests.**
  - The storage conformance suite (+4 for each of memory, SQLite and Loki): documents, indexes and meta kept, and the
    database carries on after a restart; a commit waits, then lands; a snapshot during it copies the compacted
    database; read-only and closed refused.
  - `storage/memory.test.ts` (+3), the kit with a backend the test holds: a compaction waits for a running snapshot;
    a snapshot started meanwhile waits for it; a commit and a close wait too.
  - `storage.sqlite` (+3): after deleting 90%, the file is exactly the size of `VACUUM INTO` a fresh file, the `-wal`
    is empty, the kit's connection carries on and the file passes `integrity_check`; with less than twice what is
    left free it is refused with both figures and nothing changes, and with enough it goes ahead; an unknown free
    space goes ahead.
  - `storage.loki` (+1): compacting saves at once, and the file holds only what is left.
  - `archiveCommand.test.ts` (+3): compacting after the removal, with the sizes; a failure logged, said, and the
    archive standing; the message's sentence, and none when the file is no smaller.
  - `sampleArchive.test.ts`: on real SQLite, both the sample and an archive through the command end with the file
    measured as it is, and an empty `-wal`; the sample's file smaller than before.
  - `session.test.ts`: a contributor's database refuses `compact`. `ledgerApi.test.ts` (+1): `displaySize`.
- **The tests fail without each change.** 17 changes were undone in turn, by a script, and each time tests failed:
  compaction without the commit lock; on a read-only or closed database; a snapshot during compaction; compaction under
  a snapshot; no room check; room for once what is left; no `VACUUM`; no checkpoint; Loki not saving; a contributor
  compacting; no compacting step; a failed compaction failing the archive; the `-shm` counted; no compacting progress;
  the message saying nothing of it; a file no smaller announced; sizes in bytes.
- **The full suite passes**, with the changes after Phase 4: 153 files, 2,406 tests (2,370 after Phase 4).
- **The plugins build** (all nine). **Types:** no new errors (core 3, shell 16 and tests 28, as before; the rest
  clean).

Smoke test, on Windows (still to do): archive the sample again (before 1 Oct 2026), and check the message's sizes
against the file in Explorer, with no `-wal` left beside it once Tessera closes it; archive a copy of a large ledger
if one is at hand, watching the dialog's "Compacting" step and the window.

## Phase 6: later, each scheduled separately

- **Change… for the archive file's folder (S).**
- **View a backup read-only (S):** a *View* button in the Restore dialog, to look inside any backup before restoring
  it, with retention skipping a backup while it is open ([Only archive files](#only-archive-files)).
- **The year start per ledger (S),** once settings have a per-ledger scope (in [todo.md](todo.md)).
- **From the warning to the register (S):** clicking an account in the dialog's warning cancels the dialog and shows
  that account's register, in reconcile mode, so the user can reconcile at once.
- **Opening an older archive (M):** an upgraded temporary copy, opened read-only, instead of the message pointing to
  Restore.
- **Open Archive… (S):** a list of the ledger's archives from `ledger.archives`, each opened read-only, with "moved or
  deleted" for missing files.
- **Tidying payees after an archive (S), optional:** payees no longer used by any transaction or alias.
- **Reports across archives (M),** once reports exist: a report for a period before the archive date reads the
  archive files the ledger's record lists.
- **A size reminder (S):** "“Home” holds 12 years of transactions" in the status bar, suggesting an archive.
- **Archiving cleared transactions too (M),** only if the opening balance is split into a cleared and a reconciled
  part. Not proposed.

---

## Documentation changes

| Document | Change | When |
|---|---|---|
| This note | Phase results sections and the status line | Each phase |
| [README.md](../README.md) | This note in "Documentation"; Archive Ledger… in the feature list | Review; Phase 4 |
| [todo.md](todo.md) | A "Ledger compaction" group with the phases | Review |
| [account-manager-design.md](account-manager-design.md) | The File menu gains Archive Ledger…; `Account.lastArchiveDate` and `archived`; `openingBalance` as the opening balance of the current period, and the register's first row dated the last archival date; closed accounts with nothing left removed by an archive; `accounts` as an archive participant | Phases 1 and 4 |
| [import-manager-design.md](import-manager-design.md) | Lines before an account's last archival date are left out (`ImportCounts.archived`); line records pruned only before the archive date; a removed account's records go; `import` as an archive participant | Phase 2 |
| [backup-restore-design.md](backup-restore-design.md) | The `archive` kind of backup; retention never trims archives; Restore lists them; Open Ledger… opens an archive read-only (other backups still refused); Back Up and Delete disabled while viewing one | Phase 3 |
| [settings-design.md](settings-design.md) | The year start as the first candidate for a per-ledger setting | Phase 4 |
| [plugin-creation.md](plugin-creation.md) | *Taking part in an archive*: `participateInArchive`, the order, `earlier`, and that a plugin keeping transaction ids must participate; writing nothing when a read-only ledger opens | Phases 1 and 3 |
| [storage-engine-redesign.md](storage-engine-redesign.md) | `compact` in the contract and the conformance list | Phase 5 |
