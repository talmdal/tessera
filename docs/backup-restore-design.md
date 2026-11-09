# Design and implementation: ledger backup and restore

| | |
|---|---|
| **Status** | Proposed 2026-11-09, reviewed five times the same day ([Decisions taken in review](#decisions-taken-in-review)); nothing is [still open](#still-open). **Phase 0 (spike) done and closed**: run on Linux with Node 24, and its key checks confirmed in Electron 45 on Windows ([results](#phase-0-results)). **Phase 1 (snapshots in the storage engines) done**, with no visible change ([results](#phase-1-results)). **Phase 2 (Back Up Ledger…, retention, one operation at a time) done**, and seen working in Electron on Windows ([results](#phase-2-results)). **Phase 3 (Restore Ledger…) done**, and seen working in Electron on Windows ([results](#phase-3-results)). **Phase 4 (the Backups page, backing up on close, two-pass quitting) done**, with a confirmation when a restore completes; its smoke test in Electron is still to do ([results](#phase-4-results)). Phase 5 is optional, each item scheduled separately |
| **Date** | 2026-11-09 |
| **Scope** | A **Back Up Ledger…** and a **Restore Ledger…** command in a new File menu group; restoring over the ledger or as a new ledger with another name; trimming backups older than a retention period; an optional automatic backup when the ledger closes or Tessera quits; a **Backups** page in the Options dialog for the default backup folder and the automatic backup; and one long ledger operation at a time |
| **Builds on** | [account-manager-design.md](account-manager-design.md) (the `ledger` plugin, its file flows and the pre-upgrade backup), [storage-engine-redesign.md](storage-engine-redesign.md) (the `storage.engine` contract and storage kit), [settings-design.md](settings-design.md) (namespaces, pages, field kinds), [import-manager-design.md](import-manager-design.md) (the import run) |
| **Amends** | [todo.md](todo.md)'s "backups for `shell.files`" and [vault-design.md](vault-design.md)'s `shell.files.backup(path)`: a consistent backup of an open ledger needs the storage engine, so backups are not a `shell.files` job (see [Where the code goes](#where-the-code-goes)). The import plugin's run also marks the ledger busy ([One thing at a time](#one-thing-at-a-time)) |
| **Layout** | [Part 1](#part-1-design) is the design (*what and why*); [Part 2](#part-2-implementation) is the phased plan (*how and in what order*), in the style of [font-roles-design.md](font-roles-design.md) |

- [Summary](#summary)
- [Context](#context)
- [Goals and non-goals](#goals-and-non-goals)
- [Decisions](#decisions)
- **Part 1: Design**
  - [Taking a backup: copy the file, or something better?](#taking-a-backup-copy-the-file-or-something-better)
  - [Does backing up close and reopen the ledger?](#does-backing-up-close-and-reopen-the-ledger)
  - [One thing at a time](#one-thing-at-a-time)
  - [Showing progress](#showing-progress)
  - [The backup file](#the-backup-file)
  - [The storage contract: `snapshot` and `readMeta`](#the-storage-contract-snapshot-and-readmeta)
  - [Backing up](#backing-up)
  - [Retention: trimming old backups](#retention-trimming-old-backups)
  - [Backing up when the ledger closes](#backing-up-when-the-ledger-closes)
  - [Restoring](#restoring)
  - [The File menu and commands](#the-file-menu-and-commands)
  - [The Backups page](#the-backups-page)
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
  - [Phase 1: snapshots in the storage engines](#phase-1-snapshots-in-the-storage-engines-m)
  - [Phase 2: Back Up Ledger…, retention, and one thing at a time](#phase-2-back-up-ledger-retention-and-one-thing-at-a-time-l)
  - [Phase 3: Restore Ledger…](#phase-3-restore-ledger-l)
  - [Phase 4: the Backups page and backing up on close](#phase-4-the-backups-page-and-backing-up-on-close-m)
  - [Phase 5: later, each scheduled separately](#phase-5-later-each-scheduled-separately)
  - [Documentation changes](#documentation-changes)

---

## Summary

**A backup is a consistent snapshot of the open ledger, written by the storage engine while the ledger stays open. It
is not a copy of the file. Restoring puts a backup back, either over its ledger or as a new ledger with another name.
Replacing the open ledger is the one case that closes and reopens it, and that happens only after the user confirms.
Tessera is a single-user desktop application, so the ledger does one long job at a time, and the window stays
responsive while it does.**

- **Not a file copy.** Ledgers are SQLite databases in write-ahead-log (WAL) mode, so recent commits sit in a `-wal`
  file beside the ledger until SQLite moves them into the main file. A copy of the main file taken while the ledger was
  open was measured to have **no tables at all** ([measurements](#what-was-measured)). Copying the side files as well
  is a race. Instead, the storage contract gains **`Database.snapshot(to)`**, which each engine answers natively. For
  SQLite that is the online backup API: a transactionally consistent, self-contained, checked file, written without
  closing the ledger or freezing the window. The spike measured 0.1 to 3 s for a very large ledger (100,000
  transactions, 56 MB), with the main thread never blocked for more than a few milliseconds.
- **Backing up never closes the ledger.** Closing runs every plugin's close listeners and sends the user back to the
  start view, and reopening would load the whole ledger again. None of that is needed, because a snapshot is
  consistent on its own.
- **One thing at a time.** A backup, a restore and an import are each a **ledger operation**. While one runs, the
  ledger is busy (`ledger.isBusy`). The others, and New, Open, Close and Delete, are disabled until it ends. So **no
  backup is taken while an import is running**, and no import starts during a backup. The user can still read and edit
  the ledger, and writes carry on during a snapshot. **A user quit is two passes:** first each plugin is asked whether
  it can close, and a reason (an import running, a backup that failed) is shown with **Retry**, **Quit Anyway** and
  **Cancel**; then the shutdown runs as today. An OS shutdown skips the question
  ([Quitting while the ledger is busy](#quitting-while-the-ledger-is-busy)).
- **Restoring never replaces the current file.** A backup is restored as a new ledger, or in its ledger's place: the
  current file is then renamed to a name the user chooses and kept, and the backup takes its name. Restoring in place
  of the open ledger has to close it, since the storage kit keeps the whole ledger in memory. The restore is one
  operation: it checks the backup, closes the ledger, keeps the current file, puts the backup in its place and reopens
  it. If anything fails, it puts the current file back.
- **A backup is its own kind of file,** `Home 2026-11-09 10-14-05.tesserabkp`. It is the engine's format, so
  restoring is a check and a copy. It carries its own metadata: which ledger it came from (a new **ledger id**), when it
  was taken, how, and by which version of Tessera. Open Ledger… refuses backups and points to Restore.
- **File › Back Up Ledger…** asks where to save, with a suggested name in the default backup folder.
  **File › Restore Ledger…** lists the backups in the default backup folder (Browse… for others), and restores the
  one chosen **as a new ledger**, with a name and a folder, or **in place of its ledger**, keeping the current file.
  Restore works with no ledger open, because "my ledger won't open" is when people need it most.
- **Retention only looks in the default backup folder.** After each new backup there, older backups *of the same
  ledger* in that folder are trimmed. Everything newer than the retention period (default 30 days) is kept, and always
  the newest five. The rest go to the OS trash, or are deleted where there is no trash. A backup saved anywhere else
  is never trimmed, so nothing needs to keep track of manual backups.
- **Backing up when the ledger closes** is on by default. That covers Close Ledger, opening or creating another ledger,
  and quitting. It runs only when the ledger changed since its last backup. On a user quit it runs in the first pass,
  with no time limit, so a slow folder just takes longer and a failure can be retried. It never stops the ledger closing.
  A failure is shown in the status bar.
- **Progress without interruption.** A typical backup takes under 0.2 s and shows only its result in the status bar.
  One that takes longer than half a second shows "Backing up “Home”… 45%" there, and the user can carry on working. A
  restore shows its steps and a progress bar in the Restore dialog, which stays open until it is done. There is no
  modal progress dialog for backups ([Showing progress](#showing-progress)).
- **A Backups page** (Tools › Options… › Ledger › Backups) holds the default folder, backing up on close and the
  retention period. The folder needs two small, generic shell additions: a `folder` settings field kind and
  `shell.files.showOpenFolderDialog`.
- **Phased:** a spike; snapshots in the storage engines; Back Up… with retention and the one-operation rule;
  Restore…; the Backups page, backing up on close and the two-pass quit; later, optional work (Show in Folder,
  compression, reminders, moving the pre-upgrade backups into the same scheme).

---

## Context

### What exists today

| Facility | Where | What it means here |
|---|---|---|
| A **pre-upgrade backup**: before a migration changes existing data, the ledger copies the file and its side files to `Home.backup-<UTC stamp>.tessera` beside it, never overwriting | [LedgerSessionImpl.ts](../plugins/ledger/src/privileged/LedgerSessionImpl.ts) (`backup`), [disk.ts](../plugins/ledger/src/privileged/disk.ts) (`copyWithSideFiles`) | Safe there only because the file being copied **isn't open yet**. The same copy of an open ledger is not safe (below). These backups stay as they are for now ([Phase 5](#phase-5-later-each-scheduled-separately)) |
| SQLite is the default engine, in **WAL mode** with `synchronous = NORMAL`, through `node:sqlite`'s synchronous `DatabaseSync` | [SqliteDriver.ts](../plugins/storage.sqlite/src/privileged/SqliteDriver.ts) | Committed data may be only in `Home.tessera-wal`. Every SQLite call blocks the main process while it runs |
| The **storage kit keeps the whole database in memory**. A backend loads it at open and persists each committed batch; all querying is in memory | [storage-kit/backend.ts](../packages/storage-kit/backend.ts), [database.ts](../packages/storage-kit/database.ts) | A file replaced under an open ledger is never seen, and the next commit writes over it. Commits are serialised by a lock, so a snapshot taken under that lock is consistent |
| The engine **caches open databases by path**, not by options | [storage-kit/engine.ts](../packages/storage-kit/engine.ts) | A backup or restore must never open the live ledger's path a second time |
| **File operations are serialised** in the session (`serial`): a second Open waits for the first | `LedgerSessionImpl.serial` | Back Up and Restore join the same queue, so neither can run during an Open, a Close or an upgrade |
| Closing a ledger runs **`onWillClose` listeners**, flushes, closes, and fires `closed` | `LedgerSessionImpl.closeOpen` | The import plugin **aborts a running import** on close ([run.ts](../plugins/import/src/privileged/run.ts)). Views with `when: ledger.isOpen` disappear and the start view returns |
| **An import runs as one exclusive job** (`exclusively`), from the file dialog through the format, account and summary dialogs. It sets `import.isRunning`, which disables File › Import… | [run.ts](../plugins/import/src/privileged/run.ts), [import index.ts](../plugins/import/src/privileged/index.ts) | An import can be "running" for minutes while the user answers its dialogs, not only while it writes. Nothing stops a backup, a restore or Close Ledger meanwhile |
| **All of a ledger's data is in its file.** Domain plugins store through `ledger.schema`; `app.state` holds only the recent list, the last ledger and the last import folder | [accounts](../plugins/accounts/src/privileged/index.ts), [import](../plugins/import/src/privileged/index.ts) | A snapshot of the file is a complete backup. Nothing else needs to take part |
| Quitting runs **`onShuttingDown` listeners** one at a time, within **10 s in total**, with `reason: 'user' \| 'system'`. The ledger's listener closes the ledger | [AppLifecycle.ts](../core/lifecycle/AppLifecycle.ts), [quit.ts](../shell/main/lifecycle/quit.ts) | The backup on quit has a budget, and an OS shutdown is shorter still |
| `shell.files`: open, open-many and save dialogs, `exists`, `trash`, documents and downloads folders | [tessera-types/dialogs.ts](../tessera-types/dialogs.ts), [electronFiles.ts](../shell/main/dialogs/electronFiles.ts) | **No folder picker**, which the default-folder option needs |
| Settings field kinds: `boolean`, `number`, `text`, `choice`; pages nest with `parent` | [tessera-types/settings.ts](../tessera-types/settings.ts), [fields.ts](../shared/settings/fields.ts) | **No folder field** |
| Status-bar text items show context keys (`Ledger: {ledger.name}`) and may run a command when clicked | [tessera-types/layout.ts](../tessera-types/layout.ts) (`BorderTextItem`) | Enough for progress and results without a new kind of item |
| A ledger's meta holds `ledger.format`, `ledger.createdAt`, `ledger.createdWith` and each contributor's schema version | [ledger-api/protocol.ts](../packages/ledger-api/protocol.ts) (`LEDGER_META`) | **A ledger has no identity.** Nothing tells "Home" from another ledger called "Home", which retention needs. [settings-design.md](settings-design.md#why-not-sub-groups-in-the-applications-files) already assumes a "ledger id" |
| File menu groups, by `order`: `ledger.file` 0 (New, Open, Close), `import.file` 5 (Import…), `ledger.danger` 10 (Delete), `shell.exit` 10 000 | [ledger contributions.ts](../plugins/ledger/src/privileged/contributions.ts), [import contributions.ts](../plugins/import/src/privileged/contributions.ts), [coreMenus.ts](../shell/main/menus/coreMenus.ts) | The new group goes at 7: after Import, before Delete |

### What was measured

The first drafts of this note rested on a few scratch measurements. The [Phase 0 spike](#phase-0-results) repeated
them carefully with Node 24, the Node that Electron 45 embeds, on ledgers shaped like real ones. The points that
matter most here:

| Test | Result |
|---|---|
| 2,000 transactions committed, then the process killed; the **main file alone** copied | **It had no tables at all** ("no such table"). Every commit was still in the `-wal`. That is what a plain file copy of an open ledger can give |
| The online backup API, `backup()`, at 100,000 transactions (56 MB) | **0.1 to 3 s**, depending on what else the disk was doing. The main thread was **never blocked for more than a few milliseconds**, and writes carried on during it. Its `progress` callback gives a real percentage |
| `VACUUM INTO` in a worker thread (the fallback) | 0.2 to 0.3 s at 56 MB, main thread free; no percentage |
| `VACUUM INTO` on the main thread | Blocks the main process for the whole copy: 0.15 s at 56 MB here. One early scratch run took 1.5 s, when the disk was cold |
| gzip of a synthetic 24 MB ledger | 14× smaller in 0.3 s. Real ledgers will compress less, but still well |

---

## Goals and non-goals

**Goals**

- A backup the user can trust: transactionally consistent, complete, checked before it is called done, and never left
  half-written under a real backup's name.
- The window stays responsive during a backup or restore, and the user can always see that something is happening.
- **One long ledger operation at a time.** Backups, restores and imports never overlap, and nothing closes the ledger
  under any of them.
- Restoring is hard to get wrong. The user sees what a backup is before anything changes, replacing is confirmed, and a
  failed restore leaves the ledger as it was.
- Retention that can't delete what the user didn't expect: only in the default backup folder, only backups of the same
  ledger, only after a new backup has succeeded, always keeping the newest few, and into the OS trash.
- Engine-agnostic: the `ledger` plugin never mentions SQLite; the Loki engine works too.

**Non-goals (for now)**

- **Encrypted backups.** Ledgers aren't encrypted either ([account-manager decision 5](account-manager-design.md#decisions-taken-in-review)).
  Backups get the same protection as the ledger: the user's own folder.
- **Cloud or scheduled backups** run by Tessera itself. Pointing the backup folder at a synced folder covers most of
  the need. A plugin could add a cloud destination later ([Phase 5](#phase-5-later-each-scheduled-separately)).
- **Incremental or differential backups.** Ledgers are megabytes, and a whole snapshot takes well under a second at
  typical sizes.
- **Restoring part of a ledger** (one account, one month). That is import or merge, a different feature.
- **Restoring across storage engines.** A backup is in its engine's format, as the ledger is. Moving between engines
  is the planned `ledger.formats` work.
- **File locks against a second copy of Tessera.** This is an existing risk ([account-manager risks](account-manager-design.md#risks)),
  not made worse here.

---

## Decisions

Decisions confirmed or changed in review are marked ✓. Each is explained where it lands.

| # | Decision | Where |
|---|---|---|
| 1 | **A backup is an engine snapshot, not a file copy.** New `Database.snapshot(to, options)` in the storage contract. For SQLite the online backup API, confirmed by the spike in Electron 45 on Windows; the fallback, `VACUUM INTO` in a worker thread, works there too | [Taking a backup](#taking-a-backup-copy-the-file-or-something-better) |
| 2 | **Backing up never closes the ledger.** Only restoring in place of the open ledger closes it, once, and reopens it | [Does backing up close…](#does-backing-up-close-and-reopen-the-ledger) |
| 3 ✓ | **A backup has its own extension, `.tesserabkp`,** and is in the engine's format with backup metadata in its meta. Open Ledger… refuses it | [The backup file](#the-backup-file) |
| 4 | **Ledgers get an identity,** `ledger.id` (a ULID) in meta, assigned when created or first opened writable. A ledger restored as new gets a new id | [Ledger identity](#ledger-identity) |
| 5 ✓ | **Retention considers only the default backup folder,** after each new backup there, and only backups of the same ledger. It keeps the newest *N* and all younger than the period; the rest go to the trash. Backups elsewhere, manual or not, are never trimmed and never tracked | [Retention](#retention-trimming-old-backups) |
| 6 ✓ | **Back up when the ledger closes, on by default:** on Close Ledger, on switching to another ledger, and on quitting; only when the ledger changed since its last backup | [Backing up when the ledger closes](#backing-up-when-the-ledger-closes) |
| 7 ✓ | **Restore never replaces the current file.** In place, it is renamed to a name the user chooses and kept (with a new id, as a ledger of its own), and the backup takes its name; nothing is trashed or deleted. Any failure puts it back | [Restoring in place](#restoring-in-place) |
| 8 ✓ | **One ledger operation at a time.** `LedgerSession.beginOperation(label)` marks the ledger busy; backups, restores and imports each take it. While it is held, the ledger's file commands and Import are disabled | [One thing at a time](#one-thing-at-a-time) |
| 9 ✓ | **Progress in the status bar, not a modal dialog,** shown only for backups that take more than half a second. A restore shows its progress in its own dialog | [Showing progress](#showing-progress) |
| 10 | **The feature lives in the `ledger` plugin,** which owns the file, the session queue and the close and open steps. It is not in `shell.files` or a separate plugin | [Where the code goes](#where-the-code-goes) |
| 11 | **Settings are application settings** (namespace `ledger.backup`), not per-ledger: a backup folder belongs to a computer | [The Backups page](#the-backups-page) |
| 12 | **Generic shell additions:** a `folder` settings field kind, `shell.files.showOpenFolderDialog`, and `{key}` in status item tooltips; and in the lifecycle, pass 1 of a user quit (`onWillQuit`) | [The Backups page](#the-backups-page), [Quitting while the ledger is busy](#quitting-while-the-ledger-is-busy) |
| 13 ✓ | **The status bar is the confirmation after a manual backup.** *Show in Folder* is an optional future enhancement. **A restore is confirmed with a message** saying where the files are (fifth review) | [Phase 5](#phase-5-later-each-scheduled-separately), [The flow](#the-flow) |
| 14 ✓ | **A user quit is two passes.** Pass 1 asks each plugin whether it can close, with no time limit; a reason shows with Retry, Quit Anyway and Cancel. The backup on quit is made in pass 1. Pass 2 is the shutdown as today, with open plugin dialogs cancelled first | [Quitting while the ledger is busy](#quitting-while-the-ledger-is-busy) |
| 16 ✓ | **Where there is no trash, an expired backup is deleted** | [Retention](#retention-trimming-old-backups) |
| 15 | **No lock during a snapshot.** Writes carry on; the copy is consistent as of a single moment (the spike showed it for both SQLite methods) | [SQLite: …](#sqlite-the-online-backup-api-or-vacuum-into) |

---

# Part 1: Design

## Taking a backup: copy the file, or something better?

**The file should not simply be copied.** The ledger is a live SQLite database in WAL mode, and the storage kit writes
to it on every commit. The options:

| Approach | Consistent? | Ledger stays open? | Verdict |
|---|---|---|---|
| **Copy the main file** | **No.** Recent commits are only in `-wal`. The measured copy had no tables | Yes | Loses data silently |
| **Copy the main file and its `-wal` and `-shm`** (what `copyWithSideFiles` does) | **No.** The copies are separate async reads, and a commit or an automatic checkpoint between them (SQLite checkpoints at 1,000 WAL pages) gives a torn pair. `-shm` is a shared-memory index that means nothing in a copy | Yes | A race, and it fails only sometimes, which is the worst kind of failure for a backup |
| **Checkpoint (`wal_checkpoint(TRUNCATE)`), then copy** | Only if nothing writes between the two, and only if no other connection is reading | Yes, with writes blocked | Ties the `ledger` plugin to SQLite's internals, and still produces a file copy that nobody checked |
| **Close the ledger, copy, reopen** | Yes | **No** | Disruptive ([next section](#does-backing-up-close-and-reopen-the-ledger)) |
| **Logical export**: write every collection from the kit's memory to a new file | Yes | Yes | Engine-independent, but restoring then means rebuilding a database, a second path that must match what the engine writes. That is a separate *Export* feature |
| **Engine snapshot: the database copies itself**, through the storage contract | **Yes:** SQLite copies a single consistent state of the database | **Yes** | **Chosen** |

### Why an engine snapshot

- **It is consistent by construction.** Every storage-kit commit is one SQLite transaction, and SQLite copies a single
  committed state, so no batch is ever half in the copy. A power cut leaves the same kind of state, and
  [the spike](#phase-0-results) confirmed that every plugin already recovers from it. And because a backup never runs
  during an import ([One thing at a time](#one-thing-at-a-time)), it never captures an import half-applied.
- **It is self-contained.** One file, with no side files to lose along the way.
- **It is checked.** The engine runs its own integrity check on the copy before reporting success. (A plain copy is
  never checked.)
- **It leaves the ledger alone.** No close, no reload, no events.
- **The `ledger` plugin stays engine-agnostic.** It asks the database for a snapshot. Loki answers with a serialised
  copy, SQLite with its backup API, and the memory engine with a copy of its maps for the tests.

### SQLite: the online backup API, or `VACUUM INTO`

Both are transactionally consistent. What matters in an Electron main process, which also serves every window's IPC
and menus, is that the window stays responsive:

| | Online backup API (`node:sqlite` `backup()`) | `VACUUM INTO` on the main thread | `VACUUM INTO` in a worker thread |
|---|---|---|---|
| Main process while it runs | **Keeps running:** the steps run on libuv's thread pool (never more than 3 ms blocked, measured) | **Blocked** for the whole copy | **Keeps running:** its own read-only connection, on another thread (3 ms at most, measured) |
| Writes to the ledger meanwhile | Carry on; the copy includes them up to its end | Wait | Carry on; the copy is the state when it started |
| Progress | **Yes**, from its `progress` callback | No | No: "Backing up…" without a percentage |
| Output | Page-for-page, in WAL mode | Compacted, rollback-journal mode | As the main-thread version |
| Work afterwards | Create the target exclusively first (**`backup()` silently replaces an existing database**), then switch the copy to `journal_mode = DELETE` so it has no side files, write the backup's meta, `quick_check`. **In a worker:** on the main thread this took up to 190 ms | Write the meta, `quick_check` | As the main-thread version, in the worker |
| Availability | Node 22.16 and later. **Confirmed in Electron 45.0** (Node 24.22, SQLite 3.53.4) on Windows, behaving as on Linux | Any SQLite since 3.27 | **Works in Electron 45's main process** on Windows, with the worker's code as a string, so a bundled plugin needs no second file |

**Chosen: the online backup API,** because it is the only one that both keeps the window responsive and reports
progress. **Fallback: `VACUUM INTO` in a worker thread.** It was measured to keep the main thread responsive too, and
the price is an indeterminate progress indicator. `VACUUM INTO` on the main thread is ruled out: it freezes the window
for large ledgers. At ordinary sizes (a few thousand transactions, about 1 MB) each takes well under 200 ms.

**No lock is needed.** The first draft held the kit's commit lock during a snapshot, so writes would wait. The spike
found that both methods stay consistent while the ledger is written to:
- `backup()` ran while the main thread committed 1,542 times, and the copy included every commit up to its end, with
  `integrity_check` ok;
- the worker's copy was the state when it started.

So writes carry on, and a register edit during a backup is never delayed.

---

## Does backing up close and reopen the ledger?

**No.** Closing and reopening would give a consistent file, but everything else it does is wrong for a backup:

| What a close and reopen does | Why that matters for a backup |
|---|---|
| Runs every `onWillClose` listener | Plugins tidy up as if the ledger were going away. The import plugin, for instance, aborts its run |
| Fires `closed`; `ledger.isOpen` goes false | The register, navigator and reconcile panel disappear. The start view shows, and then everything comes back with the selection and scroll position lost |
| Reopens through `probe` → `engine.open` → migrations → `attach` | Loads the whole ledger into memory **twice** (the read-only probe, then the real open): seconds on a large ledger, with the window useless meanwhile. A failed reopen leaves the user with no ledger open |
| `attach` updates the recent list and fires `opened` | Other plugins react as if the user had opened a ledger (the import plugin re-checks for interrupted imports, for example) |

A snapshot needs none of this, so **Back Up Ledger… and the backup on close take a snapshot of the open database**.
(When the ledger is closing anyway, the backup is taken at the right point in that sequence:
[Backing up when the ledger closes](#backing-up-when-the-ledger-closes).)

**Restore is different.** Restoring in place of the *open* ledger has to close it, because the kit holds the ledger in
memory and would otherwise write its old state over the restored file. So it is never silent. The user chooses **In
place of “Home”**, which the dialog says will close and reopen it, and watches it happen in the Restore dialog as one
operation that puts everything back if it fails ([Restoring in place](#restoring-in-place)). Restoring as a new ledger
closes the current one the way Open Ledger… does, which needs no confirmation because everything is already saved.

---

## One thing at a time

Tessera is a single-user desktop application. The ledger only needs to do one long job at a time, as long as the
window stays responsive while it does. Today nothing enforces that. An import runs from its file dialog to its summary,
possibly for minutes while the user answers questions. Meanwhile Close Ledger would abort it, and a backup would
capture it half-applied.

### The ledger operation

The session gains one generic notion, in `@tessera/ledger-api`:

```ts
export interface LedgerSession {
  // …
  /**
   * Marks the ledger busy with a long operation (an import, a backup, a restore) until the returned handle is disposed.
   * Throws LedgerError('BUSY') while another operation runs, so only one runs at a time. `label` is for the user:
   * "Importing statements", "Backing up “Home”". Session-wide: it works with no ledger open (a restore).
   */
  beginOperation(label: string): Disposable
  /** The running operation's label, or undefined. */
  readonly operation: string | undefined
}
```

It publishes two context keys: `ledger.isBusy`, and `ledger.operation` (the label, for the status bar and tooltips).
A new `LedgerErrorCode`, **`BUSY`**, says *Wait for “Importing statements” to finish.*

The ledger stays domain-free: it doesn't read `import.isRunning` or know what an import is. Any long job a plugin adds
later, such as a year-end close or a sync, takes the same operation and gets the same rule.

### Who takes it, and what it disables

| Operation | Held from … to … |
|---|---|
| **Back Up Ledger…** | The command's start (before the save dialog) to its result |
| **Restore Ledger…** | The command's start (before the file dialog) until the restored ledger is open, or the user cancels |
| **Import** | The whole run, as `exclusively` already spans it. The import plugin takes `session.beginOperation('Importing statements')` beside its own `import.isRunning` flag: a few lines in [run.ts](../plugins/import/src/privileged/run.ts) |

| While `ledger.isBusy` | |
|---|---|
| **Disabled:** Back Up Ledger…, Restore Ledger…, Import…, New Ledger…, Open Ledger…, Close Ledger, Delete Ledger… | Their enablement gains `!ledger.isBusy`. **The session enforces it too:** the same methods reached over IPC (the start view's recent list) or from another plugin reject with `BUSY` |
| **Still available:** reading, editing the register, reconciling, the Options dialog, quitting | Writes carry on during a snapshot |

**A change from today, agreed in review:** Close, Open, New and Delete are disabled during an import, where Close used
to abort it. Every ledger command behaves the same way while the ledger is busy. The import's own Cancel is the way to
stop it.

### Quitting while the ledger is busy

Quitting can't be disabled. An OS shutdown can't be refused, and the user must always be able to get out. But a user
who quits in the middle of an import, or a restore, should be asked first. The spike found two things that decide
where that question can go:

- **It can't be asked from an `onShuttingDown` listener.** Those listeners share the quit's 10 s limit. A user who takes
  longer than that to answer finds the quit carrying on with the question still on screen, and their "Keep Working"
  is ignored (a test in the spike shows exactly this).
- **An import waiting in one of its dialogs doesn't end when the ledger closes.** Its abort signal is only checked
  between statements, so it waits for the dialog to be answered. What happens depends on how the user quits:
  - **File › Exit** (and Cmd+Q on macOS) starts the quit with the window still open. The import's dialog stays up, and
    the import was still running 10 s later.
  - **Closing the last window** on Windows and Linux closes the window *before* the quit starts. Its dialogs resolve
    as cancelled (`DialogService.windowClosed`), and the import ended 3 ms later.

So the question has to be asked **before** the shutdown listeners run, and **before** the last window closes. A user
quit therefore becomes **two passes** (settled in the third review):

1. **Pass 1, "can we close?"** Plugins register `context.lifecycle.onWillQuit(async () => reason | undefined)`. Each
   returns a reason not to close yet, or nothing. A plugin may also do work here, because pass 1 has **no time limit**
   and the window is still open. The ledger makes its backup on quit in pass 1 (see
   [Backing up when the ledger closes](#backing-up-when-the-ledger-closes)). The listeners run one at a time, **newest
   first** (reverse activation order), so a plugin hands its last writes to the plugins it depends on before they do
   their own pass-1 work: the ledger runs last, and its backup holds everything. Pass 1 runs only for a user quit, and
   before anything is shut down:
   - in `before-quit` (File › Exit, Cmd+Q, the OS's Quit menu);
   - in the last window's `close` event on Windows and Linux, which is cancelled while pass 1 runs.

   If a plugin gives a reason, the shell shows it, with no time limit, and three choices:

   > **Tessera can't close yet.**
   > “Importing statements” is still running.
   > [Retry] [Quit Anyway] [Cancel]

   - **Cancel** leaves everything as it was, with the window still open. It is the default button.
   - **Retry** runs pass 1 again: the import may have finished, or the backup drive been plugged back in.
   - **Quit Anyway** goes on to pass 2.

   Every plugin's reason is listed, in one box. The `ledger` plugin's reasons are its running operation ("“Importing
   statements” is still running") and a failed backup on quit ("“Home” couldn't be backed up: the folder “E:\Backups”
   isn't available"). The same question therefore protects an import, a backup and a restore in progress.
2. **Pass 2, the shutdown as today:** the `onShuttingDown` listeners, within their 10 s, then deactivation. Before the
   listeners run, **open plugin dialogs are cancelled** (as a closing window already does). An import waiting for an
   answer then ends at once (3 ms, measured), after a Quit Anyway.

An OS shutdown skips pass 1: it can't be refused and nobody is there to answer. It runs pass 2 only, with its dialogs
cancelled the same way.

A statement that is being matched and applied can't be interrupted, but it doesn't need to be. The spike found that
the import holds the main thread for a whole statement, 0.3 s per 1,000 lines, so a quit can only begin once the
statement is complete. A statement is therefore **never half-imported by quitting**. (That the import holds the main
thread so long is a separate responsiveness issue for the import plugin, listed in
[Documentation changes](#documentation-changes).)

---

## Showing progress

**Does the user need a progress bar?** Not a modal one, and not for most backups. The user does need to see that
something is happening whenever it takes long enough to notice. The usual thresholds:

- under about 0.1 s feels instant;
- under about 1 s keeps the user's flow;
- beyond a few seconds, people want to see progress.

A modal progress dialog for a 200 ms backup would flash on screen and look like a glitch.

| Operation | Typical time | What the user sees |
|---|---|---|
| **Back Up Ledger…**, an ordinary ledger (a few thousand transactions) | Under 0.2 s | The result only, in the status bar for a minute: **"Backed up “Home” at 10:14"** |
| **Back Up Ledger…**, a large ledger | 0.1 to 3 s at 100,000 transactions (measured; it depends on the disk) | **After 0.5 s**, the status bar shows **"Backing up “Home”… 45%"**, from `snapshot`'s `onProgress`, updated at most four times a second. Then the result as above. The user can keep working. Back Up, Restore, Import and the file commands are disabled until it ends |
| **Backup when the ledger closes** (Close Ledger, switching ledgers) | As above | The same status item, then the ledger closes (or the other ledger opens) |
| **Backup on quit** | As above | Nothing: the windows may already be gone. A failure shows at the next start |
| **Restore Ledger…** | Copying the backup: 0.9 s at 56 MB from a cold disk. **Reopening loads the whole ledger into memory, and blocks the main process while it does:** 0.4 to 1 s at 100,000 transactions (measured) | **In the Restore dialog**, which stays open and busy (`setBusy(true)`) until the restored ledger is open: the current step ("Copying the backup", "Closing “Home”", "Keeping the current “Home” as “…”", "Opening “Home”") beside a spinner, which shows the percentage while copying. While opening it spins without one: **a CSS animation, which keeps moving in the renderer while the main process is busy**, since progress messages can't be sent then. Nothing else can be done with the ledger meanwhile (it is closed during a restore in place), so a dialog is right here. (`@tessera/ui` has a spinner, `CircularProgress`, but no progress bar) |
| A failure | | A message box with the reason (manual backup, restore), or a status-bar warning (backup on close) |

Notes:

- **The percentage needs the engine to report it.** The online backup API does: in the spike, 58 callbacks as a
  20,000-transaction backup went from 2% to 100%. The worker-thread `VACUUM INTO` fallback doesn't, and shows
  "Backing up “Home”…" without one.
- **A status-bar text item is enough.** It is bound to a context key, `ledger.activity`, and needs nothing new in the
  shell. A real progress-bar kind of status item, and progress on the taskbar icon (Electron's
  `BrowserWindow.setProgressBar`), would be generic shell additions that an import could use too. They are optional,
  in [Phase 5](#phase-5-later-each-scheduled-separately).
- **The disabled menu items are feedback too.** They show that the ledger is busy, and a tooltip on the status item
  names the operation (`ledger.operation`).

---

## The backup file

### Format and name

- **The engine's own format,** the same as a ledger file: a SQLite database, or Loki JSON. Restoring is then a check
  and a copy, and the backup opens with ordinary SQLite tools if it ever needs rescuing.
- **Its own extension, `.tesserabkp`** (filter "Tessera backup"). Microsoft Money (`.mbf`) and Quicken (`.QDF-backup`)
  make the same distinction. The extension:
  - keeps backups out of Open Ledger…'s default filter;
  - gives Restore Ledger… something to filter on;
  - lets retention consider only files that are unmistakably backups.
- **Suggested name: `<ledger name> <local date> <local time>.tesserabkp`**, for example
  `Home 2026-11-09 10-14-05.tesserabkp`. It sorts by date, and it is valid on every platform (no colons). If the name is
  taken, ` (2)` is added. Local time appears because people read the name; the meta holds UTC.

### What a backup carries

The snapshot copies the ledger's meta, including `ledger.id`, and the engine writes these extra keys **into the copy
only** (`snapshot`'s `meta` option). The live ledger never gains them:

| Key | Value | Used by |
|---|---|---|
| `backup.takenAt` | ISO 8601, UTC | Retention's age; the restore dialog |
| `backup.kind` | `'manual'` (Back Up Ledger…) or `'auto'` (when the ledger closed) | The restore dialog ("taken automatically when Tessera closed") |
| `backup.ledgerName` | `Home` | The restore dialog, and the suggested name when restoring as new |
| `backup.ledgerPath` | The ledger's absolute path when backed up | Finding its ledger to restore in place of ([Restoring](#restoring)) |
| `backup.takenWith` | `ledger <LEDGER_API_VERSION>`, as `ledger.createdWith` | Diagnostics |

New constants in `@tessera/ledger-api`: `LEDGER_BACKUP_EXTENSION`, `LEDGER_BACKUP_FILTER`, `LEDGER_BACKUP_META`, and
`LEDGER_META.id` and `LEDGER_META.restoredFrom`.

**A file counts as a backup only if it has both `ledger.format` and `backup.takenAt`.** The extension alone isn't
enough: it makes a file a candidate, and the meta confirms it.

### Open Ledger… refuses backups

The probe already opens a file read-only and reads its meta before anything is written. It gains one check: a file
with `backup.takenAt` is refused with *“Home 2026-11-09 10-14-05” is a backup. Use File › Restore Ledger… to restore
it.* Opening a backup directly would turn it into a live ledger: in WAL mode, upgraded, and then written to, which
would change the backup itself.

### Ledger identity

Retention has to tell *this* ledger's backups from another ledger's with the same name in the same folder. Restore
has to know which ledger a backup belongs to. So a ledger gets an id:

- **`ledger.id`**: a ULID (`engine.newId()`), written by `create()`.
- **Existing ledgers** get one the first time they are opened writable, in `attach` before `opened` fires. It is one
  meta write, not a migration. A read-only ledger has none until it is next opened writable. Its backups still work,
  but retention skips them, because "same ledger" can't be proved.
- **Restoring as a new ledger assigns a new id** and records `ledger.restoredFrom: { id, takenAt }`. Otherwise two
  live ledgers would share an id, and retention would treat their backups as one history.
- **Replacing keeps the id.** It is the same ledger, at an earlier point.

The same id is what [settings-design.md](settings-design.md#scopes-are-provided-by-plugins)'s ledger scope needs, so
this is useful beyond backups.

---

## The storage contract: `snapshot` and `readMeta`

Two additions to [`tessera-types/storage.ts`](../tessera-types/storage.ts), implemented once in the storage kit and
once per backend:

```ts
export interface SnapshotOptions {
  /** Meta entries written into the copy only; the database itself is not changed. */
  meta?: Record<string, Json>
  /** Abandons the snapshot: the partial copy is deleted and the promise rejects with an IO error. */
  signal?: AbortSignal
  /** Called now and then with the fraction done, 0 to 1, by engines that can tell. */
  onProgress?(done: number): void
}

export interface Database {
  // …
  /**
   * Writes a consistent, self-contained copy of the database as of the last commit to `to.path`, which must not exist.
   * The database stays open, and commits carry on meanwhile. The copy is one consistent state of the database, from
   * some moment between the call and the promise resolving. It is checked before the promise resolves; on any failure
   * (an abort included) nothing is left at `to.path`.
   */
  snapshot(to: { path: string }, options?: SnapshotOptions): Promise<void>
}

export interface StorageEngine {
  // …
  /**
   * A database's meta, read without loading its documents and without writing anything. For an open database, its
   * current meta. Rejects with NOT_FOUND for a missing file, and IO for one the engine can't read.
   */
  readMeta(target: DatabaseTarget): Promise<Record<string, Json>>
}
```

| Layer | `snapshot` | `readMeta` |
|---|---|---|
| **Storage kit** (`KitDatabase`) | Rejects for a closed database, then asks the backend. No lock: the backend copies a committed state | `KitStorageEngine`: from memory if the target is open, else `driver.readMeta` |
| **Backend contract** (`StorageBackend`, `BackendDriver`) | `StorageBackend.snapshot(file, options)` (required) | `BackendDriver.readMeta(target)` (required) |
| **SQLite** | Create the target with `'wx'` (exclusive), because `backup()` silently replaces an existing database. Then `backup(db, file, { progress })`; throwing from `progress` cancels it. Then, **in a worker thread**, on the copy: `journal_mode = DELETE`, insert the extra meta rows, `PRAGMA quick_check`. On any failure, delete the target: a cancelled `backup()` leaves an empty file. The fallback (if Electron disappoints): `VACUUM INTO` in the same worker, with its own read-only connection | Open `readOnly`, `SELECT key, value FROM tessera_meta`, close: under 1 ms per file, whatever the size (41 backups of 56 MB read in 7 to 40 ms). **Leaves nothing behind for a backup**, which is in `DELETE` mode. A read-only open of a WAL-mode file (a live ledger) leaves an empty `-wal` and `-shm` beside it, which its next read-write open removes |
| **Loki** | Flush pending saves, `serialize()` the in-memory Loki with the extra meta added to the copy, write to `<file>~` and rename (as its saves do) | Parse the file's meta collection. Loki has to read the whole file, which is acceptable for Loki's sizes |
| **Memory** | Deep copy of the maps into the driver's store under the path, so tests can `readMeta` and open it. Reports progress once, at the end | From the store |

Two rules keep this safe:

- **Contributors can't snapshot.** `scopedDatabase` (what `ledger.session.database(contributor)` hands out) answers
  `snapshot` with a rejection, as it already does for `close`. A plugin that could write the whole ledger to any path
  could read other plugins' data.
- **Conformance tests for every engine.** [`tests/storage/conformance.ts`](../tests/storage/conformance.ts) gains a
  `snapshot` and `readMeta` group, so the memory engine the ledger tests use behaves like SQLite (see
  [Testing](#testing)).

**The probe uses `readMeta` too** (done in Phase 1). The ledger's `probe` used to load an entire ledger read-only just
to read its meta, then load it again for real. The spike measured the load at 0.4 to 1 s for 100,000 transactions,
with the main process blocked for all of it. Using `readMeta` removes one of the two, which halves the freeze when
opening (and restoring) a large ledger.

The full read-only load had a second job: a damaged file failed it **before** the open ledger closed, so a bad pick
left the user where they were. To keep that guarantee, Open now opens the new ledger, which reads it in full, **before**
it closes the current one. The steps are:
1. probe the meta;
2. plan the migrations, and take the pre-upgrade backup if one is needed;
3. open the new ledger;
4. close the current one, its close listeners running as before;
5. migrate and attach.

A failure up to step 3 leaves the current ledger open. For a moment both ledgers are in memory.

---

## Backing up

**File › Back Up Ledger…** (`ledger.backup`), enabled while a ledger is open and not busy, read-only ledgers included:

1. **Begin the operation:** `beginOperation('Backing up “Home”')`. It is released however the command ends.
2. **Ask where.** `shell.files.showSaveDialog`:
   - title "Back Up Ledger" and button "Back Up";
   - filter "Tessera backup";
   - `defaultPath` is the [default backup folder](#the-backups-page) plus the suggested name. The default folder is
     created if it doesn't exist.

   Cancel ends the command. `.tesserabkp` is added if the user typed a name without it, so a backup can never take the
   ledger's own name.
3. **In the session's queue** (`serial`), so it can't overlap an Open or a Close:
   1. `db.snapshot({ path: '<chosen>.partial' }, { meta: backupMeta('manual'), signal, onProgress })`. The copy is
      written under a temporary name in the chosen folder, so a crash or a full disk never leaves a half-backup under a
      real name, and the rename in the next step is on the same volume. Progress goes to the status bar
      ([Showing progress](#showing-progress)).
   2. **Verify.** `engine.readMeta` of the partial file must show the ledger's `ledger.format`, `ledger.id` and
      `backup.takenAt`.
   3. **Rename into place,** with the [retry policy for held files](#restoring-in-place): antivirus may be scanning the
      file just written. If the user chose to replace an existing file in the save dialog, that file goes to the trash
      first, as `create()` does for a replaced ledger.
4. **Remember it.** `context.state` key `backup.last`: `{ [ledgerId]: { takenAt, path } }`. This is what "changed
   since its last backup" and (later) reminders are measured against. It is not used for retention.
5. **Say so.** "Backed up “Home” at 10:14" in the status bar. A failure is an error message box with the reason ("The
   folder “E:\Backups” isn't available.", "There isn't enough space…"), and the partial file is removed.
6. **Trim**, if the backup was saved in the default backup folder ([Retention](#retention-trimming-old-backups)).
   This happens only now, after a verified backup, and after the result is shown: on Windows the Recycle Bin takes
   about 50 ms a file (measured). The ledger operation ends when trimming has.

The command also takes an argument, `{ path?: string }`, so another plugin or a test can back up without the dialog.

---

## Retention: trimming old backups

### The rule

After each **successful** backup **saved in the default backup folder**, automatic or manual:

1. **Candidates:**
   - files directly in the default backup folder (not in subfolders) ending `.tesserabkp`;
   - whose `readMeta` succeeds;
   - which have `backup.takenAt`;
   - and whose `ledger.id` is the ledger just backed up.

   A file that can't be read, or has no id, is never touched.
2. **Kept:**
   - the backup just made;
   - the newest `keepAtLeast` candidates by `backup.takenAt` (default 5, counting the new one);
   - every candidate younger than `retentionDays` (default 30).
3. **Trimmed:** the rest go to the OS trash through `shell.files.trash`, with `path.resolve`d paths as Electron
   requires. **The trash isn't always available.** On Linux the spike found it refused on volumes the OS treats as
   internal, and on desktops without `gio`. Network shares are likely to refuse it on every OS. In every case the spike
   saw, the file stayed where it was. **Where the trash refuses a backup, it is deleted** (settled in the third review):
   otherwise a default folder on a network share would grow without limit. A file that can't be deleted either is left,
   and the failure logged.
4. Nothing happens if `trim` is off.

**A backup saved anywhere else is never trimmed,** and nothing keeps a list of them. Someone who backs up by hand to a
USB drive or an archive folder before the year-end keeps that backup for as long as they like. Moving a backup out of
the default folder is also how to keep one for good. The Backups page says both.

"The default folder" is compared after resolving the path (`realpath`), case-insensitively on Windows and macOS, so a
manual backup the user saves there through the save dialog counts. **Changing the default folder leaves the old one
alone:** its backups are no longer trimmed, and the page says so.

**Trashed backups still use disk space** until the trash is emptied. Windows caps the Recycle Bin's size, and macOS can
empty it after 30 days, but many Linux desktops never empty it. The Backups page says so.

Timestamps come from the meta, not from file dates, so copying a backup around doesn't change its age. A `takenAt` in
the future (a wrong clock) counts as young.

### Why this shape

- **Only the default folder:** Tessera only trims where Tessera puts backups by itself. Nothing needs to track where
  manual backups went, and the rule fits in one sentence on the Backups page.
- **Only the same ledger id:** two ledgers backing up to the default folder never trim each other's backups.
- **Only after success:** a run of failed backups can never trim away the good ones.
- **Keep-at-least:** someone who comes back after three months and backs up once still has their last five backups,
  not just today's.

### A pure function

Retention is a pure function in `privileged/backup/retention.ts`. It is tested exhaustively, with no files:

```ts
export interface RetentionPolicy { trim: boolean, days: number, keepAtLeast: number }
export interface BackupRecord { path: string, takenAt: string }

/** The backups to trim, oldest first. Never `justMade`, never one of the newest `keepAtLeast`, never one younger than `days`. */
export function backupsToTrim(records: BackupRecord[], policy: RetentionPolicy, now: Date, justMade: string): BackupRecord[]
```

| Situation (30 days, keep 5) | Trimmed |
|---|---|
| A backup a day for 40 days, then one today, all in the default folder | The 10 older than 30 days |
| Six backups, all over 30 days old, then one today | The oldest two: today's and the four newest old ones are kept |
| Three backups, all over a year old, then one today | None (four in all, fewer than five) |
| A manual backup saved to another folder | Retention doesn't run. Backups in that folder are never candidates |
| `trim: false` | None |
| A backup of another ledger called "Home" in the default folder | Never a candidate |
| A `.tesserabkp` that can't be read | Never a candidate |

---

## Backing up when the ledger closes

When **Back up the ledger when it closes** is on (the default), the ledger is backed up to the default folder as it
closes, if it changed since its last backup:

| How the ledger closes | Backed up? |
|---|---|
| **Close Ledger** | Yes |
| **Opening or creating another ledger**, or **restoring one as new** | Yes, before the other ledger opens |
| **Quitting**, by the user | Yes, in pass 1 of the quit, with no time limit ([Quitting while the ledger is busy](#quitting-while-the-ledger-is-busy)) |
| **An OS shutdown** | Yes, within the shutdown's budget |
| **Delete Ledger…** | No: the user is discarding it, and the file goes to the trash |
| **Restoring in place** | No: the current file is kept under the name chosen ([Restoring in place](#restoring-in-place)) |

```
Close Ledger, switching  ─► closeOpen({ why }) ─┬─ onWillClose listeners run     (plugins finish their writes)
OS shutdown (pass 2)                            ├─ the close hook (why):         'close' | 'switch' | 'system' back up;
                                                │    'delete' | 'restore' | 'quit' don't
                                                │  snapshot → verify → rename    (kind 'auto', default folder)
                                                │  retention on the default folder
                                                ├─ flush, close
                                                └─ fired: closed

User quit, pass 1        ─► onWillQuit: busy? → reason.  Needed? → snapshot → verify → rename → retention.
                             Failed? → reason (Retry / Quit Anyway / Cancel).  Pass 2 closes with why 'quit': no backup.
```

The session says **why** the ledger is closing, and calls one **close hook** with it, after the `onWillClose`
listeners and before the database is flushed and closed. The hook is the ledger's own (it isn't part of the
`LedgerSession` contract), and a hook that fails is logged: the ledger closes anyway.

| Why | Where from |
|---|---|
| `close` | Close Ledger |
| `switch` | Open, New, and a restore as new, closing the open ledger for another |
| `delete` | Delete Ledger… |
| `restore` | A restore in place, closing the ledger it restores |
| `quit` | A user quit's pass 2, after pass 1 backed up (or the user chose Quit Anyway) |
| `system` | An OS shutdown |

- **Taken inside the close** on Close Ledger, when switching ledgers and on an OS shutdown: after the `onWillClose`
  listeners and before the database closes. Whatever plugins write as the ledger closes is in the backup, and there is
  no second open.
- **Taken in pass 1 on a user quit,** while the window is still open and nothing has a time limit. A slow folder just
  takes longer, with its progress in the status bar. A failure (an unplugged drive, a full disk) becomes pass 1's
  reason, so the user can plug the drive back in and **Retry**, **Quit Anyway** without a backup, or **Cancel**. Pass 2
  then finds nothing changed since, and closes without backing up again.
- **Only when there is something new.** Otherwise closing five times without changes would make five identical
  backups and let retention push the meaningful ones out. A backup is made when:
  - the ledger **changed** since it opened, or since a backup of it (manual or automatic) began. The session watches
    `onDidChange` on the raw database, and an upgrade on opening counts. A backup that fails puts the flag back;
  - or its **last automatic backup failed** (`backup.lastAutoError` names it). Its changes may then be in no backup,
    even if it is unchanged since it reopened;
  - or it has **no recorded backup** (`backup.last`): a new ledger, or one never backed up on this computer.
- **Never during an import.** Close, Open and New are disabled while the ledger is busy, so a close by command never
  meets a running import. On a user quit, a running import is pass 1's reason, and is only abandoned by Quit Anyway;
  its dialogs are then cancelled, and it ends within milliseconds. An OS shutdown asks nothing, but its dialogs are
  cancelled the same way. In pass 2 the backup waits up to 2 s for a running operation to end. If it hasn't, **the
  backup is skipped** and recorded as skipped, rather than capturing a half-applied import.
- **On Close Ledger and switching:** the window is there, so the status bar shows progress as for a manual backup.
  The close continues afterwards whatever happened.
- **On an OS shutdown, within a budget.** The lifecycle gives all quit listeners 10 s together. The backup gets up to
  **3 s** (`event.reason === 'system'`), through `snapshot`'s `signal`. Past that it is abandoned, the partial file is
  removed, and the shutdown continues. The session queue means the storage engine can't close under a running
  snapshot: it waits for the abort. **The spike's measurements fit:**
  - the whole job on quit (snapshot, finishing, verify, rename, a retention scan of 41 backups, trashing 6, close) took
    0.1 to 0.5 s at 10,000 transactions on Linux, and 0.3 to 0.5 s on Windows;
  - at 100,000 transactions (56 MB) it took 0.4 to 3.4 s on Linux, depending on how busy the disk was, and about
    0.6 s on Windows.

  Only a very large ledger on a busy or slow disk could miss the 3 s budget. A user quit has no budget at all.
- **The ledger closing is never stopped,** and an OS shutdown is never stopped either. Only a user quit can be held
  back, and only by the user's own choice in pass 1.
- **Failures and skips are shown in the status bar.** The ledger records `backup.lastAutoError` (`{ ledger,
  ledgerName, message, at }`, where `ledger` is its id) in its state. A warning item, "Last backup failed", appears
  with the details in its tooltip, at once on Close Ledger or at the next start after a quit:

  > ⚠ Last backup failed — *“Home” wasn’t backed up when it closed (9 Nov 2026, 10:14). The folder “E:\Backups”
  > isn’t available.*

  Clicking it opens the Backups page (`ledger.backupSettings`). It clears after the next successful backup **of that
  ledger**, manual or automatic; a backup of another ledger leaves it. A missing backup folder (an unplugged drive) is
  reported this way instead of falling back somewhere the user didn't choose. No message box: the close has
  happened, and the user may be on their way out.

---

## Restoring

**The current file is never replaced, sent to the trash or deleted** (decided in the fourth review). A backup is
restored either as a new ledger, or in its ledger's place, in which case the current file is renamed to a name the
user chooses, and kept.

### The flow

**File › Restore Ledger…** (`ledger.restore`, in the backup group after Back Up Ledger…) is enabled whenever the ledger
isn't busy, **with or without a ledger open**. The start view offers it too, beside New and Open, and in its "could not
be reopened" warning, because a ledger that won't open is the most common reason to restore.

1. **Begin the operation** (`Restoring a ledger`). It is held while the dialog is open, and until any restore it
   started has finished, even if the dialog's window closes first.
2. **The Restore dialog** (`ledger.dialog.restore`) lists the backups in the default backup folder, newest first. Each
   row gives its ledger, when it was taken, how (by hand, or automatically) and its size. **Browse…** adds one from
   elsewhere, and the command's argument `{ path }` adds one shown chosen. Every file is checked before it is listed,
   read-only and from its meta (`inspect`, Open's own checks). A file that can't be restored is listed with the
   reason, and can't be chosen: from a newer Tessera, not a ledger, made by the other engine, or the open ledger itself.
   A ledger file that isn't a backup (a pre-upgrade `Home.backup-….tessera`, a copy made by hand) can be restored too.
3. **The chosen backup's plan:** how it can be restored, with free names.

```
┌ Restore Ledger ───────────────────────────────────────────────────────────┐
│ Choose a backup                                                           │
│ In “C:\Users\tim\Documents\Tessera Backups”, newest first.                 │
│ ┌───────────────────────────────────────────────────────────────────────┐ │
│ │ “Home” — 9 Nov 2026, 10:14            Backed up by hand · 24 KB       │ │
│ │ “Home” — 8 Nov 2026, 21:26            Backed up automatically · 24 KB │ │
│ │ “Future” — 1 Nov 2026, 09:00          Saved by a newer version of …   │ │
│ └───────────────────────────────────────────────────────────────────────┘ │
│ [ Browse… ]                                                               │
│                                                                           │
│ Restore it as                                                             │
│ (•) A new ledger                                                          │
│       Name    [ Home (restored 2026-11-09) ]   Saved as “Home (restored…)” │
│       Folder  [ C:\Users\tim\Documents    ] [ Change… ]                    │
│ ( ) In place of “Home”                                                    │
│       Keep the current file as [ Home (before restore 2026-11-09 10-14) ] │
│       “Home.tessera” is renamed to “Home (before restore …).tessera”, and │
│       the backup takes its name. Nothing is deleted.                      │
│       “Home” is open: it closes, and opens again as it was in this backup.│
│                                                                           │
│ ◔ Copying the backup…                                                     │
│                                                  [ Cancel ]  [ Restore ]  │
└───────────────────────────────────────────────────────────────────────────┘
```

- **A new ledger is the default.** Its name is `<name> (restored <date>)`. Its folder is its ledger's folder when that
  is known and there, else the documents folder; **Change…** opens the folder picker. When the ledger is gone from its
  folder, the suggestion is its own name, in its own place.
- **In place of a ledger:** the ledger the backup belongs to, found in this order:
  1. the open ledger, if it has the backup's `ledger.id`;
  2. else a recent ledger with that id, which finds a ledger that has moved since the backup;
  3. else the file the backup was taken from (`backup.ledgerPath`), if it is still there and is the same ledger, or has
     no id to tell.

  Otherwise the option is disabled with the reason: "“Home” isn’t on this computer, or has been moved or deleted", or
  "A different ledger is at … now".
- **No confirmation:** nothing is lost either way. The dialog says exactly what happens to each file.
- **Names are checked** before anything is copied: a valid file name (not one Windows reserves), not taken. A refusal
  is shown on its field.
- **The dialog carries out the restore itself,** over IPC (`ledger:restore.run`), so it can stay open, busy, and show
  each step (`ledger:restore.progress`): the copy with its percentage, then closing, keeping the current file, and
  opening. The spinner is a CSS animation, so it keeps moving while the main process is busy opening the ledger.
- **Only files the dialog was shown can be restored.** The dialog's requests are answered only while the command has
  it open, and `run` refuses any other path: a view can't make the main process copy a file of its choosing.

4. **Then** the dialog closes, the restored ledger is open, and a message confirms it (added in the fifth review),
   saying where the files are:

   > **“Home” has been restored.**
   > It is as it was on 9 Nov 2026, 10:14. The file you had before is kept as “Home (before restore 2026-11-09
   > 10-14).tessera”, in “C:\Users\tim\Documents”.

   For a new ledger, the second sentence is "It is “Home (restored 2026-11-09).tessera”, in “…”." The status bar
   also says "Restored “Home” as it was on 9 Nov 2026, 10:14", for a minute.

### Restoring in place

As **one job in the session queue** (`withFileOperations`: the session's own close and open steps, which the held
operation would otherwise refuse), each step shown in the dialog:

| Step | Shown as | On failure |
|---|---|---|
| 1. Copy the backup to `.<name>.restoring-<stamp>.tessera` **in the ledger's folder** (same volume, so step 5 is a rename), never over a file. Check it with `readMeta` | Copying the backup (with a percentage) | Remove the copy. Nothing else has changed |
| 2. If the ledger is open: close it (its `onWillClose` listeners run) | Closing “Home” | (Closing doesn't fail; its errors are logged) |
| 3. **Keep the current file:** rename `Home.tessera` to the name chosen, `Home (before restore 2026-11-09 10-14).tessera`, **with its side files**. They belong to it: after a crash, its last writes may be only in its `-wal` | Keeping the current “Home” as “…” | Reopen the ledger if it was open |
| 4. **Check that no side file is left** at the ledger's path. A `-wal` left beside the restored file would be applied to it by SQLite: in the spike, the "restored" ledger opened as the old one, with `integrity_check` saying ok | (as step 3) | Put the current file back; reopen it if it was open |
| 5. Rename the copy to `Home.tessera`, with the retry policy below | (as step 3) | Put the current file back; reopen it if it was open |
| 6. Open it, checked as Open checks it (migrating an older backup, with its own pre-upgrade copy). Before it is shown, its `backup.*` keys are removed: it is the same ledger, with the same id, as it was | Opening “Home” | Remove the restored copy; put the current file back; reopen it if it was open |
| 7. **The kept file gets a new `ledger.id`**, so it is a ledger of its own: if it is opened and backed up later, its backups are never taken for Home's. Best effort: a damaged file that can't be opened keeps its id | | (Logged; the restore has succeeded) |

The kept file is an ordinary ledger: Open Ledger… opens it. The restored ledger keeps its place in the recent list.
If the current file can't be put back after a failure (another program holding it, say), the message says where it is:
"…couldn’t be put back: it is safe as “Home (before restore …).tessera”".

**Renaming a file another program holds.** Windows refuses a rename while another program has the file open without
sharing deletion. **On Windows, Node reports this as `EBUSY`**: the spike held a file with each sharing mode and
renamed it. Every mode without `Delete` gave `EBUSY`; with `Delete`, the rename worked even while the file was held.
Antivirus scanning a file just written can hold a file this way, and so can sync clients, sometimes the indexer, and
another copy of Tessera with the ledger open (SQLite doesn't share deletion). Linux and macOS don't refuse. The policy, which follows `graceful-fs` (the file-system layer npm itself uses, which retries
the same codes for up to 60 s):

- rename only to a name that doesn't exist, so a refusal means the *source* is held, and waiting can help;
- retry `EBUSY`, and `EPERM` and `EACCES` as `graceful-fs` does, with a backoff of 10, 20 … 100 ms, for at most
  **10 s** (an interactive restore, not npm's 60 s);
- after 1 s, say what it is waiting for;
- then give up with the original error, having changed nothing.

Against simulated locks:
- a 300 ms antivirus scan passed silently after 367 ms;
- a 3 s lock passed, with the notice shown;
- a lock that never ends gave up at 10 s;
- any other error failed at once.

A hold that never ends is most likely another copy of Tessera. Windows doesn't say which program holds a file
(Windows' Restart Manager can, later), so the message names the likely causes.
[Phase 0](#phase-0-results) lists the cases still to try on Windows: a second copy of Tessera, and a OneDrive folder.

**Why rename the current file rather than replace it, or back it up first.** Renaming is instant, can't fail for lack
of space, and works on a damaged ledger that can't be opened, which may be why the user is restoring. And it deletes
nothing: the first draft sent the current file to the trash once the restore had worked; the fourth review kept it
instead, under a name the user chooses.

### Restoring as a new ledger

1. Check the name (a valid file name, not taken in the folder) and that the folder is there.
2. Copy the backup to `<folder>/.<name>.restoring-<stamp>.tessera`, check it, and rename it to `<name>.tessera`. The
   name is checked again just before the rename.
3. Open it. The ledger that was open closes, as with Open Ledger…. Before it is shown:
   - it gets a **new `ledger.id`**: a ledger of its own;
   - `ledger.restoredFrom` records `{ id, takenAt }` of the backup;
   - the `backup.*` keys are removed.

   If it won't open, the file the restore made is removed, and the ledger that was open stays open.
4. It joins the recent list under its new name.

### Edge cases

| Case | Behaviour |
|---|---|
| An import or a backup is running | Restore Ledger… is disabled ([One thing at a time](#one-thing-at-a-time)) |
| The backup is from a newer Tessera, or a newer plugin | Listed, with the reason, and can't be chosen |
| The backup is from an older Tessera | Restored, then upgraded as it opens, with the usual pre-upgrade copy |
| The backup was made with the other engine (Loki JSON under SQLite) | Listed with the engine message Open gives, and can't be chosen |
| The chosen file is a ledger, not a backup (a pre-upgrade copy, a copy made by hand) | Restored like a backup. Its own name isn't its ledger's (`Home.backup-…`), so the suggested name comes from its ledger's, when its id finds it |
| The chosen file *is* the open ledger | Listed as "This is the open ledger.", and can't be chosen |
| The ledger won't open (the reason to restore) | Restore from the start view's warning. In place works: the damaged file is kept as it is, under the name chosen |
| The folder is read-only, or full | Step 1 fails, saying so; nothing has changed |
| The dialog's window closes during a restore | The restore finishes; the ledger is let go only then |
| Tessera crashes mid-restore | At most a hidden `.restoring-…` copy is left beside the ledger, and the current file may be under its kept name. Both are ordinary ledger files the user can open. A later phase could find them at the next start and offer to finish or undo ([Phase 5](#phase-5-later-each-scheduled-separately)) |

---

## The File menu and commands

```
File
  New Ledger…
  Open Ledger…          Ctrl+O
  Close Ledger
  ─────────────
  Import…
  ─────────────
  Back Up Ledger…               ← new group `ledger.backup`, order 7
  Restore Ledger…
  ─────────────
  Delete Ledger…
  ─────────────
  Exit
```

| Id | Label | Enablement | Argument |
|---|---|---|---|
| `ledger.backup` | `&Back Up Ledger…` | `ledger.isOpen && !ledger.isBusy` | `{ path?: string }`: skip the dialog |
| `ledger.restore` | `&Restore Ledger…` | `!ledger.isBusy` | `{ path?: string }`: skip the file dialog and go straight to the Restore dialog |
| `ledger.new`, `ledger.open`, `ledger.close`, `ledger.delete` (existing) | | as today `&& !ledger.isBusy` | |
| `import.file` (existing, import plugin) | | as today `&& !ledger.isBusy` | |

- **Verb, not noun:** "Back Up" in menus, "backup" for the file, as in the platform guidelines and Money.
- **Mnemonics:** **B** and **R** aren't used in the File menu (N, O, C, I, D, X are).
- **Group order 7** puts the group after Import (5) and before Delete (10), as the import contribution notes.
- **Added to `LEDGER_COMMANDS`** and the menu group to `MENUS` in [contributions.ts](../plugins/ledger/src/privileged/contributions.ts).
  Each item arrives in the phase that makes it work.

New context keys: `ledger.isBusy`, `ledger.operation` (the label), `ledger.activity` (the status bar's progress and
result text). New IPC (`LEDGER_CHANNELS`, `LEDGER_EVENTS`) for the Restore dialog:

| Channel | Does |
|---|---|
| `ledger:restore.list` | → `{ folder, backups: BackupInfo[] }`: the backups in the default backup folder, newest first |
| `ledger:restore.browse` | → `Result<BackupInfo \| undefined>`: one chosen in the open dialog, modal to the dialog's window |
| `ledger:restore.plan` | `{ path }` → `Result<RestorePlan>`: how a listed backup can be restored, with free names |
| `ledger:restore.folder` | `{ defaultPath }` → `string \| undefined`: the folder picker, modal to the dialog's window |
| `ledger:restore.run` | `{ backup, mode: 'new', folder, name } \| { backup, mode: 'inPlace', keepAs }` → `Result<LedgerInfo>`: restores. A name to change comes back as INVALID with its `field` |
| `ledger:restore.progress` (event) | `{ step, done? }` while `run` works |

They are answered only while File › Restore Ledger… has the dialog open, and `run` takes only a backup the dialog was
shown.

---

## The Backups page

### The settings

A second namespace of the ledger plugin, **`ledger.backup`**, separate from `ledger` so the page can reset its own
values and future backup settings have a home:

```ts
export interface BackupSettings {
  /** The default backup folder. '' means Tessera's default, <Documents>/Tessera Backups. */
  folder: string
  /** Back up the ledger when it closes (Close Ledger, switching ledgers, quitting), if it changed since its last backup. */
  onClose: boolean          // default true
  /** After each backup in the default folder, move older backups of the same ledger there to the trash. */
  trim: boolean             // default true
  retentionDays: number     // 1 to 3650, default 30
  keepAtLeast: number       // 1 to 100, default 5
}
```

- **An application setting, not a per-ledger one.** A folder is a place on a computer. A ledger copied to another
  computer, or restored from a backup, shouldn't bring a path that means nothing there. (The per-ledger scope in
  [settings-design.md](settings-design.md#the-idea-layers-of-overrides) could later offer per-ledger retention if anyone
  asks.)
- **`''` for the default** rather than a stored path, so moving to a new computer or a renamed Documents folder just
  works.
- **`validate`**: `folder` is `''` or an absolute path; the numbers are whole and in range. *Whether the folder exists*
  isn't validated, since a drive can be unplugged and plugged back in. It is checked when a backup is made.

### The page

Tools › Options… › **Ledger › Backups** (`parent: 'ledger.settings'`), drawn by the shell from fields:

```
Backups
Where backups go, and when Tessera makes them.

Backup folder
[ C:\Users\tim\Documents\Tessera Backups               ] [ Browse… ] [ Default ]
  Back Up Ledger… starts here, and automatic backups are saved here. A folder on
  another drive, or one your cloud service syncs, also protects you if this disk fails.

[x] Back up the ledger when it closes
    When you close it, open another ledger or quit Tessera, if it has changed since
    its last backup.

[x] Remove old backups
    After each backup in this folder, older backups of the same ledger here go to the
    Recycle Bin. Backups you save anywhere else are never removed; to keep a backup
    for good, move it out of this folder.

Keep backups for          [ 30 ] days
Always keep the newest    [  5 ] backups
```

Keywords: `backup`, `back up`, `restore`, `retention`, `archive`, `automatic`.

### Generic shell additions

Each is small, reusable, and mentions nothing about ledgers:

1. **`shell.files.showOpenFolderDialog(options)`** → `Promise<string | undefined>`: Electron's `showOpenDialog` with
   `openDirectory` and `createDirectory`, modal as the other dialogs are. It is used by the Restore dialog's
   **Change…** and by the field below.
2. **A `folder` settings field kind:**
   - `{ kind: 'folder', key, label, description?, placeholder? }`, where the default must be a string, and `''` shows
     the placeholder (here the resolved default path, computed when the page is contributed);
   - **Browse…** opens the folder dialog through a shell channel from the Options window, and **Default** sets `''`;
   - checked in [`shared/settings/fields.ts`](../shared/settings/fields.ts) and drawn in
     [`FieldsPage.tsx`](../shell/renderer/settings/FieldsPage.tsx).

   The import plugin's "last folder" could become a setting with it later.
3. **`{key}` in a status item's tooltip,** replaced with the context key's value as in a text item's text, so "Last
   backup failed" can carry what happened without a view of its own.

A custom page module was considered. It could show "12 backups of Home here, 48 MB" and an *Open folder* button. But
it would be the only hand-drawn plugin page for what is otherwise a plain form. The field kind keeps every page alike,
with search, Restore Defaults and validation for free.

---

## Where the code goes

**In the `ledger` plugin.** Backup and restore are file operations on the ledger, like New, Open and Delete:

- they need the **raw database** (contributors get a scoped one without `snapshot`);
- they need the **session's queue and its operation**, so they never overlap an Open, a Close or an import;
- they need the **close and open internals** (`closeOpen`, `probe`, `attach`);
- they need the **ledger id**.

| Considered | Why not |
|---|---|
| **`shell.files.backup(path)`** ([todo.md](todo.md), [vault-design.md](vault-design.md)) | The shell can only copy files, and copying an open ledger is exactly what [doesn't work](#taking-a-backup-copy-the-file-or-something-better) |
| **A separate `ledger-backup` plugin** | It would need the session to expose its queue, a raw database and its close and reopen steps to another plugin: a wide, fragile API for one feature. Revisit if a cloud-backup plugin appears; it can then build on the `ledger.backup` command and an event |

Files (privileged unless noted), as built:

| File | Holds |
|---|---|
| `plugins/ledger/src/privileged/backup/BackupService.ts` | `backUp` and `backUpDatabase` (the partial-verify-rename sequence), `needsBackup`, `backup.last`, `backup.lastAutoError`, retention after a backup |
| `…/backup/autoBackup.ts` | The backup as the ledger closes (the session's close hook), in pass 1 of a user quit, and on an OS shutdown (its wait and budget) |
| `…/backup/command.ts` | File › Back Up Ledger… |
| `…/backup/restore.ts`, `…/backup/restoreCommand.ts` | Describing and listing backups, the plan, restoring as new and in place with every rollback; File › Restore Ledger… and the dialog's channels |
| `…/backup/retention.ts` | `backupsToTrim` (pure) and `trimFolder` (lists, `readMeta`, trashes or deletes) |
| `…/backup/naming.ts`, `…/backup/rename.ts`, `…/backup/activity.ts` | Suggested names and `(2)` suffixes; renaming a held file with retries; the status bar text |
| `…/backup/settings.ts` | `BACKUP_SETTINGS` and the Backups page |
| `…/disk.ts`, `…/paths.ts` | `LedgerDisk` gains `list`, `rename`, `remove`, `mkdir`, `realpath`, `copy` (exclusive, with progress), `stat`, `isFolder`; comparing paths |
| `…/LedgerSessionImpl.ts` | `beginOperation` and the `BUSY` checks; `ledger.id`; `inspect` (backups refused unless allowed); `withOpenLedger` and `withFileOperations`; why the ledger closes, the close hook, the change flag |
| `…/index.ts`, `…/contributions.ts`, `…/ipc.ts` | The wiring, the menu group, the status items, `onWillQuit` |
| `plugins/ledger/src/renderer/RestoreDialog.tsx`, `StartView.tsx` | The Restore dialog; "Restore from a Backup…" |
| `packages/ledger-api/protocol.ts`, `errors.ts`, `service.ts`, `names.ts` | Commands, channels, events, context keys, dialog id, meta keys, extension and filter; `BUSY`, `BACKUP_FAILED`, `RESTORE_FAILED`; `beginOperation`; `validateLedgerFileName` |
| `plugins/import/src/privileged/run.ts`, `index.ts` | The import takes the ledger operation; Import… is disabled while the ledger is busy |
| `tessera-types/storage.ts`, `packages/storage-kit/*`, both engines | `snapshot`, `readMeta` |
| `tessera-types/dialogs.ts`, `tessera-types/settings.ts`, `shell/main/dialogs/electronFiles.ts`, `shared/settings/fields.ts`, `shell/renderer/settings/FieldsPage.tsx` | The folder dialog and field kind |
| `tessera-types/app-lifecycle.ts`, `core/lifecycle/AppLifecycle.ts`, `shell/main/lifecycle/quit.ts`, `quitPrompt.ts`, `core/dialogs/DialogService.ts` | The two-pass quit, its question, and cancelling dialogs before pass 2 |

---

## Security, privacy and robustness

- **A backup is the whole ledger:** account numbers, balances, payees. It goes only where the user points it, and the
  default is inside their Documents folder, with the same permissions as the ledger. The Backups page suggests another
  drive or a synced folder for safety. It doesn't suggest a shared one.
- **Contributors can't snapshot** ([above](#the-storage-contract-snapshot-and-readmeta)), and the backup IPC channels
  take no paths from views without a dialog or a check: the restore dialog's `check` only *tests* a name, and `run`
  uses the backup chosen in the file dialog, never a path the view sends.
- **Never a half-written backup under a real name** (the partial file and the rename), and **never a trim after a
  failure**.
- **The trash first:** retention, and a backup replacing a file the user chose to replace, use the trash. Where the
  trash refuses a file (no trash on that volume), it is deleted, as agreed in review; only expired backups of the same
  ledger, in the default folder, are ever deleted this way, and the one just made never is. **A restore deletes
  nothing:** the current file is kept under another name.
- **Never a backup of a half-applied import,** because the two can't overlap.
- **Stale side files** move with the kept file, and none may be left where the restored file takes the ledger's name
  (step 4 of [Restoring in place](#restoring-in-place)). This is the one way a restore could corrupt a ledger.
- **File names come from the user or from the ledger's name.** A ledger name is already a valid file name. A name
  typed in the Restore dialog is checked for reserved characters, reserved Windows names (`CON`, `NUL`…) and
  trailing dots or spaces. That is stricter than the storage kit's `checkDatabaseName`, which doesn't check reserved
  names.

---

## Testing

| Tests | What |
|---|---|
| `tests/storage/conformance.ts` (+ a `snapshot` / `readMeta` group, run for memory, SQLite and Loki) | The copy has every collection, index and meta value; extra meta only in the copy; the source is unchanged and still usable; a write made during the snapshot waits and isn't in it; a transaction not yet committed isn't in it; an existing target is refused; an abort leaves nothing; progress never goes backwards and ends at 1; `readMeta` on an open, a closed and a missing database |
| `tests/plugins/storage.sqlite/SqliteStorageEngine.test.ts` (+) | The copy is one file (no `-wal`), `quick_check` ok, opened by plain `DatabaseSync`, and a read-only open of it leaves no side files; the target is never overwritten; a cancelled snapshot leaves nothing; **a naive file copy of the open database loses data** (a regression test for why) |
| `tests/plugins/ledger/operation.test.ts` (new) | `beginOperation`: a second one is `BUSY`; disposing ends it; `ledger.isBusy` and `ledger.operation` follow; New, Open, Close, Delete, Back Up and Restore reject with `BUSY` over IPC as well as by command; quitting during an operation still closes the ledger |
| `tests/plugins/ledger/retention.test.ts` (new) | `backupsToTrim`: the table above and property-style cases (never the new one, never more than *total − keepAtLeast*, never one younger than the period) |
| `tests/plugins/ledger/backup.test.ts` (new) | Naming and `(2)`; the partial file and rename; a failed verify leaves nothing; replacing an existing backup trashes it; retention only after success, **only in the default folder** (also when reached by another spelling of its path), only this ledger id; a manual backup elsewhere triggers no retention; unreadable files untouched; trash failure leaves the file; `backup.last`; the status text, and nothing shown for a fast backup until its result |
| `tests/plugins/ledger/restore.test.ts` (new) | Each step of a restore in place failing in turn leaves the current file in place, and open again if it was; side files moved with the kept file, and **a crashed ledger's `-wal` never applied to the restored file** (on real SQLite files); restore as new gets a new id, `restoredFrom` and no `backup.*`; in place keeps the id and the kept file gets a new one; which ledger a backup belongs to; a newer backup refused; a ledger file restorable; Open refuses a backup; the progress events in order |
| `tests/plugins/ledger/session.test.ts` (+) | `ledger.id` on create, and on first writable open; none written read-only; the backup on close runs on Close, on switching and on quit but not on Delete or Replace; after the `onWillClose` listeners and before close; only when dirty; abandoned at its budget; skipped if an operation doesn't end in time; recorded for the status bar |
| `tests/plugins/import/run.test.ts` (+) | An import takes the ledger operation for its whole run and releases it however it ends; it can't start while the ledger is busy; with its dialog cancelled by a quit, it ends at once |
| `tests/main/quit.test.ts`, `tests/core/lifecycle.test.ts`, `tests/core/dialogService.test.ts` (+) | The quit guard: asked for a user quit on both paths, never for an OS shutdown, no time limit; Keep Working cancels the window's close; a confirmed quit cancels open dialogs before the shutdown listeners run |
| `tests/plugins/ledger/renderer/restoreDialog.test.tsx` (new) | What the dialog shows for each kind of file; *In place* disabled with a reason; inline name errors; busy with steps and progress while running; an error shown in place |
| `tests/plugins/ledger/activation.test.ts` (+) | Menu group and items, enablement with `ledger.isBusy`, the settings page, the status items |
| `tests/shared/settingsPages.test.ts`, `tests/renderer/settingsDialog.test.tsx`, `tests/main/electronFiles.test.ts` (+) | The `folder` field kind (definition checks, Browse, Default, validation) and `showOpenFolderDialog` |

The ledger tests run on the memory engine with the fake disk in
[`tests/plugins/ledger/harness.ts`](../tests/plugins/ledger/harness.ts), which gains `rename`, `list` and trash
failures. A few tests run on real SQLite files in a temporary folder, as [files.test.ts](../tests/plugins/ledger/files.test.ts)
already does.

---

## Alternatives considered

| Alternative | Why not |
|---|---|
| **Copy the file** (with or without side files) | Inconsistent while the ledger is open: [measured](#what-was-measured) |
| **Close, copy, reopen** for every backup | Correct, but resets the views and reloads the ledger twice. See [above](#does-backing-up-close-and-reopen-the-ledger) |
| **`VACUUM INTO` on the main thread** | Blocks the main process for the whole copy (0.15 s at 56 MB in the spike, 1.5 s on a cold first run), where the alternatives block it for 3 ms at most |
| **Let backups and imports overlap,** relying on crash consistency | A backup of a half-applied import is a state nobody would choose to restore. The one-operation rule is simpler to reason about and costs nothing at these sizes |
| **The ledger reads `import.isRunning`** instead of a generic operation | Couples the domain-free `ledger` plugin to one domain plugin, and the next long job would need the same special case |
| **Retention in whatever folder the backup went to** (the first draft) | It would trim a manual archive the next time the user backed up to the same place. Keeping to the default folder needs no tracking and is easier to explain (review answer 1) |
| **A catalogue of manual backups in `app.state`**, so retention could find them anywhere | Lost with the profile, blind to backups copied in, and out of date as soon as the user moves a file |
| **Asking "Quit anyway?" from an `onShuttingDown` listener**, with its veto | The listeners' 10 s limit overrides a slow answer, so the quit carries on with the question showing (shown in the spike). On the last-window path the window is already closed when the listeners run |
| **A commit lock during snapshots**, so writes wait (the first draft) | Not needed: the spike showed both SQLite methods consistent while the ledger is written to |
| **A modal progress dialog for every backup** | It would flash for the usual 200 ms backup, block work that doesn't need blocking, and add a dialog to every close |
| **Backups as plain `.tessera` files** (as the pre-upgrade copy is) | A backup then looks like a ledger. Open would turn it into one and write to it, Restore couldn't filter for backups, and retention couldn't be sure a file was a backup |
| **`.tesserabackup`** (the first draft's extension) | Long. `.tesserabkp` (review answer 4) says the same thing |
| **A zip container** (`manifest.json` + the database) | Room for attachments and checksums, but a new dependency. A restore then has to extract before it can check anything, and retention would read the manifest out of each zip. Compression can come later without it ([Phase 5](#phase-5-later-each-scheduled-separately)) |
| **A sidecar `.json` beside each backup** for its metadata | Two files to keep together. The meta inside the database travels with it |
| **Identify backups by file name** for retention | Names can be edited, and two ledgers can share a name. The id in the meta is certain |
| **Permanent delete for every trimmed backup** | Against the app's rule ([decision 3](account-manager-design.md#decisions-taken-in-review)). Trash costs disk space only until the OS empties it. Deleting is the fallback only where there is no trash |
| **Staging the backup on quit in a local folder**, then moving it (the proposal for slow folders) | Not needed: a user quit backs up in pass 1, with no time limit |
| **Grandfather-father-son thinning** (daily for a week, weekly for a month…) | Better coverage for the same space, but harder to explain than "N days, at least N backups". A possible later policy |
| **A fresh backup before restoring in place**, instead of keeping the current file by renaming it | Slower, can fail for lack of space, and impossible for a damaged ledger, which is often the reason for restoring |
| **Replacing the current file** (the first draft's *Replace*, sending it to the trash afterwards) | The fourth review: the current file is never replaced. Renaming it keeps it where the user can see it, under a name they chose, and deletes nothing |

---

## Risks

| Risk | Mitigation |
|---|---|
| `backup()` behaves differently on macOS | Confirmed in Electron 45 on Windows and in Node 24 on Linux, identically; macOS is checked in the phases' smoke tests. `VACUUM INTO` in a worker thread is the fallback, also confirmed in Electron |
| Disabling Close, Open and New during an import surprises someone who used Close to abandon one | Agreed in review. The import's own Cancel is the way out, and the status item names the running operation |
| An import waiting in a dialog keeps running through a quit, so the backup on quit is skipped | The quit guard asks first, and a confirmed quit cancels the dialogs: the import then ends in milliseconds (measured) |
| The quit guard leaves the app running with no window | It runs in the last window's `close` event, before the window closes, and cancelling that event keeps the window |
| Opening a large ledger freezes the main process (0.4 to 1 s at 100,000 transactions), during Restore and every Open | The probe reads meta only (`readMeta`), halving it; the restore dialog's indeterminate bar is a CSS animation. Loading in steps is separate work for the storage kit |
| Retention trims something the user wanted | Only the default folder; only after success; only this ledger id; keep-at-least; to the trash; stated on the page |
| The backup folder is on a removable or network drive that is missing | The manual backup fails with a clear message; the backup on close reports in the status bar; no silent fallback location |
| The trash is unavailable (network shares; Linux system mounts or no `gio`, as the spike found) | The expired backup is deleted instead, as agreed in review; a file that can't be deleted is left and logged |
| A stale `-wal` makes a restore silently do nothing (shown in the spike) | Side files move aside with the old file, and step 4 checks none remain; a test on real SQLite files |
| Windows refuses a rename (`EBUSY`, confirmed) because antivirus, a sync client or another copy of Tessera holds the file | Retries for up to 10 s with a notice after 1 s, renaming only to free names, for the backup's rename too. Then the original is put back and the user is told |
| The backup on close makes closing or quitting feel slow | Only when the ledger changed; 0.1 to 0.5 s at 10,000 transactions (measured); progress shown on Close; 6 s at most on quit |
| A slow network backup folder | A user quit backs up in pass 1, with no time limit, and a failure offers Retry. Only an OS shutdown has a budget (3 s) |
| Backups in a synced folder cause sync conflicts | The partial-then-rename write gives sync clients one complete file |
| Disk use: 30 days of automatic backups of a 5 MB ledger is up to about 150 MB, more now that switching ledgers backs up too | Skip-if-unchanged; retention; compression later |

---

## Decisions taken in review

Reviewed on 2026-11-09 and applied throughout this note.

| # | Question | Decision | Where it lands |
|---|---|---|---|
| — | Backups while an import is running (raised in review) | **Disabled.** More generally, one long ledger operation at a time, as long as the window stays responsive. Imports are small (usually under 1,000 transactions), so the wait is short | [One thing at a time](#one-thing-at-a-time) |
| 1 | Should manual backups be exempt from retention? | **Retention considers only the default backup folder.** Manual backups saved anywhere else are never trimmed, and nothing tracks them in `context.state` | [Retention](#retention-trimming-old-backups) |
| 2 | Back up on close on by default? | **Yes** | [The Backups page](#the-backups-page) |
| 3 | Also back up on Close Ledger and when switching ledgers? | **Yes**, with the same setting and the same skip-if-unchanged rule. Moved from Phase 5 into Phase 4 | [Backing up when the ledger closes](#backing-up-when-the-ledger-closes) |
| 4 | The extension | **`.tesserabkp`**: shorter than `.tesserabackup` | [The backup file](#the-backup-file) |
| 5 | A confirmation after a manual backup | **The status bar's "Backed up “Home” at 10:14" is the confirmation.** *Show in Folder* is flagged as an optional future enhancement (settled in the second review) | [Phase 5](#phase-5-later-each-scheduled-separately) |
| — | Does the user need a progress bar? (raised in review) | **Not a modal one.** A backup over 0.5 s shows its progress as a percentage in the status bar, and a restore shows steps and a progress bar in its dialog. A proper progress-bar status item and taskbar progress are optional, later | [Showing progress](#showing-progress) |

Second review, the same day:

| Question | Decision | Where it lands |
|---|---|---|
| Should every ledger command be disabled while an import runs (Close, Open, New, Delete too)? | **Yes**, for consistency | [One thing at a time](#who-takes-it-and-what-it-disables) |
| Should a quit be cancelled (for the application, not the OS) while an import runs? | **Proposed in answer: yes, as a question, "Quit anyway?", not a hard block.** The spike showed it can't be asked from a shutdown listener, and that File › Exit leaves an import's dialog open. So it is a generic shell quit guard, run before the shutdown listeners and before the last window closes, and a confirmed quit cancels open dialogs. It covers backups and restores in progress too. An OS shutdown never asks | [Quitting while the ledger is busy](#quitting-while-the-ledger-is-busy) |
| What "optional" meant for the confirmation | *Show in Folder* is a future optional enhancement; there is no setting | [Phase 5](#phase-5-later-each-scheduled-separately) |
| Run the Phase 0 spike | Done on Linux with Node 24; what still needs Windows, macOS or Electron is listed | [Phase 0 results](#phase-0-results) |

Third review, after the spike:

| Question | Decision | Where it lands |
|---|---|---|
| The shape of the quit question | **Two passes.** Pass 1 asks "can we close?"; a "no" comes with its reason, and the user chooses **Cancel**, **Quit Anyway** or **Retry** (run pass 1 again). Pass 2 is the shutdown | [Quitting while the ledger is busy](#quitting-while-the-ledger-is-busy) |
| Retention in a folder with no trash | **Delete the expired backup** | [Retention](#retention-trimming-old-backups) |
| Backing up on quit to a slow folder | **Handled by the two passes:** the backup on a user quit is made in pass 1, which has no time limit, and a failure offers Retry. The local staging folder isn't needed | [Backing up when the ledger closes](#backing-up-when-the-ledger-closes) |

Fourth review, with Phase 2 seen working in Electron on Windows:

| Question | Decision | Where it lands |
|---|---|---|
| Should a restore replace the current file? | **Never.** At most, the current file is renamed (to a name the user chooses) and kept, and the backup takes its name. Nothing is trashed or deleted, so no confirmation is needed | [Restoring](#restoring), [Restoring in place](#restoring-in-place) |
| How is the backup chosen? | **In the Restore dialog**, which lists the backups in the default backup folder, with Browse… for others | [The flow](#the-flow) |

Fifth review, with Phase 3 seen working in Electron on Windows:

| Question | Decision | Where it lands |
|---|---|---|
| A confirmation when a restore completes? | **Yes, a message:** “Home” has been restored, as it was when, and where the restored file and the kept file are | [The flow](#the-flow) |
| Implement backing up on close, with the two-pass quit | **Yes,** as designed. Pass 1 runs the plugins **in reverse activation order**: not because a provider might be gone (in pass 1 every plugin is still active), but so a plugin finishes and hands its last writes to the plugins it depends on before they do their own pass-1 work. The ledger, which most plugins depend on, runs last, and its backup then holds everything | [Quitting while the ledger is busy](#quitting-while-the-ledger-is-busy), [Phase 4 results](#phase-4-results) |
| The Backups page | **As designed:** the default folder, and whether to back up when the ledger closes, with the retention settings | [The Backups page](#the-backups-page) |

### Still open

Nothing. Questions that come up in the phases are recorded in their results.

---

# Part 2: Implementation

## Ground rules

The [account manager's ground rules](account-manager-implementation.md#ground-rules) apply unchanged:

- every phase ends with a working app and a green `npm test`;
- no menu item appears before the phase that makes it work;
- tests mirror the source folders;
- domain logic is tested against the memory engine;
- the architecture test keeps passing;
- `tsc --noEmit` adds no new errors;
- each phase ends with a manual smoke test in `npm run dev`.

Sizes: **S** is about a day, **M** a few days, **L** about a week.

Three rules specific to this work:

- **Nothing is ever left half-done on disk.** Every write goes to a temporary name and is renamed into place.
  Every phase's tests include a failure at each step.
- **The `ledger` plugin never mentions SQLite,** nor any domain plugin. Everything engine-specific is behind `snapshot`
  and `readMeta`, and the conformance suite holds all engines to it. Everything import-specific is behind
  `beginOperation`.
- **The window never freezes.** No SQLite work of more than a few milliseconds runs synchronously on the main thread.
  Phase 0's measurements are repeated in each phase's smoke test on a 100,000-transaction ledger.

## Dependency graph

```
Phase 0 ──► Phase 1 ──► Phase 2 ──┬──► Phase 3 (Restore…)
 (spike)    (snapshot,  (Back Up…, │
            readMeta)   retention, └──► Phase 4 (Backups page, backup on close) ──► Phase 5
                        operation)         ▲
            4a (folder field kind, folder dialog) ─ can start at any time
            4c (quit guard, dialogs cancelled on quit) ─ can start at any time
```

Phases 3 and 4 are independent of each other once Phase 2 is done. Phases 4a and 4c are generic shell work that depends on
nothing here, and Phase 3's **Change…** button uses its folder dialog. If 4a isn't done by then, Phase 3 uses a save
dialog for the new ledger's location instead. The one-operation rule is in Phase 2, before anything that closes or
replaces a ledger, so that backups and imports never overlap in any released phase.

---

## Phase 0: spike (S)

Answers the questions the design depends on, in throwaway code. The findings go into a *Phase 0 results* section of this
note.

| Question | How | Decides |
|---|---|---|
| Is `node:sqlite`'s `backup()` in Electron 45's Node, and does it behave as measured here? Progress callbacks; aborting (throwing from `progress`?); the copy's journal mode | Run the scratch scripts from [What was measured](#what-was-measured) inside Electron's main process | `backup()` or the fallback in the SQLite driver |
| Does the fallback work in Electron's main process: a `worker_threads` worker loading `node:sqlite`, reading a WAL database that the main thread has open? | The worker-thread script, packaged as the plugin build packages a privileged entry | Whether the fallback is available, and how the driver ships the worker's code |
| How long a snapshot takes, and whether the window stays responsive | 1k, 10k, 100k transactions, on Windows, macOS and Linux, to a local SSD and to a network share; scroll the register while it runs | The 0.5 s threshold for showing progress; the budgets on quit |
| How long an aborted import takes to unwind on quit | Quit during each of the import's dialogs, and during its apply | The 2 s wait before the backup on quit is skipped |
| What `shell.trashItem` does on a network share, a USB (FAT/exFAT) drive, and a OneDrive or Dropbox folder, on each OS | Trash a file in each place | Whether retention can rely on the trash there, or must leave files |
| Renaming over the ledger on Windows while Explorer's indexer, Defender or OneDrive has it open | Loop rename-over while each is active | The retry policy in Replace |
| Which side files remain after a clean close, and after a kill | Kill Electron mid-write; list the folder | Step 4 of Replace; the crash-recovery idea in Phase 5 |
| Whether a quit listener can still finish a 1 s backup once the windows have closed, including a Windows OS shutdown with `blockShutdown` | Trigger each kind of quit with a backup in progress | The budgets on quit; the 'system' behaviour |

**Exit:** the results section is written, and the SQLite method, the thresholds, the budgets and the trash behaviour
are settled.

**Done 2026-11-09**, on Linux with Node 24. The key checks were then run on Windows in Electron 45
([Windows results](#windows-results)). What still needs Windows, macOS or special folders is listed at the end of the
results.

### Phase 0 results

The spike's code was throwaway. It lived outside the repository, and was deleted once the Windows checks were in
(2026-11-09). What it found is recorded here.

**How it was run.**

- **The machine.** A Linux VM with an ext4 virtual disk. Electron's binary couldn't be downloaded there (only the npm
  registry was reachable).
- **The Node.** Electron 45 depends on `@types/node ^24.9`, so it embeds Node 24. The spike ran on **Node 24.11.1**
  (SQLite 3.50.4), from the `node-linux-x64` npm package.
- **The ledgers** were built with the SQLite driver's exact tables and pragmas, with documents shaped like the accounts
  and import plugins': every transaction, an import line for half of them, 300 payees and 120 categories. 1,000
  transactions came to 0.7 MB, 10,000 to 5.8 MB, and 100,000 to 56 MB. (A ledger is about twice the size the first
  draft assumed, because of the import lines.)
- **Questions that need the real code** (opening, the import, the lifecycle) ran as Vitest tests against the real
  plugins, with the same Node.
- **"Cold" runs** evicted the ledger from the OS cache first. The VM's disk is cached by its host too, so these aren't
  true cold-disk figures.
- **The repository:** its ledger, import and storage suites passed (25 files, 445 tests), and nothing in it was changed.

| Question | Answer |
|---|---|
| 1. Does Electron support `backup()`? | **In Node 24.11.1, Electron 45's line: yes**, and it behaves as the design needs. Progress is a real fraction (58 callbacks over 20,000 transactions). Throwing from `progress` cancels it, but **leaves an empty target file**. **It silently replaces an existing database at the target**, so the driver creates the target exclusively first. Its copy is in WAL mode until switched to `DELETE`. **Writes carry on during it, and the copy stays consistent:** 1,542 commits ran during one backup, the copy had all of them up to its end, and `integrity_check` was ok. **Confirmed in Electron 45 on Windows, identically** ([below](#windows-results)) |
| 2. Does the `VACUUM INTO` fallback work in a worker thread? | **Yes**, with the worker's code passed as a string (`eval: true`), so a bundled plugin needs no second file. It uses its own read-only connection, while the main thread keeps the ledger open and writes to it: 57 commits, none blocked. The copy is the state when the worker started, one self-contained file. At 56 MB it took 0.2 to 0.3 s, with the main thread never blocked more than 3 ms. `terminate()` cancels it, but leaves a partial file. **Confirmed in Electron 45's main process on Windows** ([below](#windows-results)) |
| 3. How long does a snapshot take? | **Far less than feared.** At 100,000 transactions (56 MB), `backup()` took 0.1 to 0.2 s in a quiet run, and up to 3.1 s while the disk was busy writing other files. The main thread was blocked for at most 3 ms. The synchronous finishing step blocked it for 50 to 190 ms, so that moves to the worker. At 10,000 transactions (6 MB), 15 to 160 ms. The 1.5 s of the first draft was a cold first run. **Opening a ledger is the slow part, and it blocks the main process:** 0.44 to 1 s at 100,000 transactions. Details below |
| 4. How long does a cancelled import take to unwind on quit? | **It depends on where the import is.** Waiting in one of its dialogs, it **doesn't unwind at all while the window is open**: still running 10 s after the ledger closed, then 3 ms after the dialog closed. In the middle of a statement, it can't be interrupted, and the quit can't even start until the statement is done, because the import holds the main thread for a whole statement (75 ms per 200 lines, 285 ms per 1,000, 595 ms per 2,000). So **a statement is never half-imported by quitting**, and a quit during a dialog needs the dialogs cancelled. Details below |
| 5. Can retention rely on the trash? | **Usually, not always; and where it can't, the file is left, never deleted.** On Linux (`gio trash`, which Electron runs), files on the home volume went to the trash. The trash was **refused** on a tmpfs volume ("Trashing on system internal mounts is not supported") and when `gio` wasn't installed. Both times the file stayed. Network shares are expected to refuse it on every OS. **On Windows, a local folder's file went to the Recycle Bin.** *Still to check on Windows and macOS:* a network share, a USB drive and a synced folder. Also, trashed backups use disk space until the trash is emptied |
| 6. Renaming on Restore while another program holds the file | **Retry, only onto free names, for at most 10 s, then put everything back.** Linux doesn't lock, so the policy was tested against simulated `EPERM`s. A 300 ms hold passed silently; a 3 s hold passed with the "waiting" notice; a hold that never ended gave up at 10 s with nothing changed. It follows `graceful-fs`, which retries the same codes for 60 s and only when the destination doesn't exist. The likeliest holder is antivirus scanning the copy just written (step 5). **On Windows, a held file gives `EBUSY`**, with every sharing mode except `Delete` ([below](#windows-results)) |
| 7. Which side files are left after a close, or a kill? | **Clean close: none.** **Killed: `-wal` and `-shm`, and the committed data may be only in the `-wal`**: the main file alone had no tables. 20 kills mid-write all reopened intact, with only whole batches. **A read-only open of a WAL-mode file leaves an empty `-wal` and `-shm`**; a `DELETE`-mode backup leaves nothing. **A stale `-wal` beside a replaced file makes the restore silently do nothing.** Details below |
| 8. Can a backup finish within the 10 s limit on close? | **Yes, on a local disk.** The whole job on quit (snapshot, finishing, verify, rename, scanning 41 backups, trashing 6, closing) took 0.1 to 0.5 s at 10,000 transactions, and 0.4 to 3.4 s at 100,000. That is inside the 6 s budget, and usually inside the 3 s OS-shutdown budget. A slow network folder could miss both; the third review settled this by moving the backup on a user quit into a first pass with no time limit ([Decisions taken in review](#decisions-taken-in-review)). A quit during an import needs the dialogs cancelled, or the backup is skipped. Also: **a "Quit anyway?" question can't be asked from a shutdown listener**, because the 10 s limit overrides the answer. *To check on Windows:* a real OS shutdown with `blockShutdown` |

#### 3. Snapshot times

Median of three. "Total / stall" is the elapsed time, and the longest the main thread was blocked. Cold means the ledger
was evicted from the OS cache first.

| Transactions | Ledger | `backup()`: warm | `backup()`: cold | Finishing, if on the main thread | `VACUUM INTO` in a worker: warm | … cold | `VACUUM INTO` on the main thread (stall) | Copying the backup for a restore (cold) |
|---|---|---|---|---|---|---|---|---|
| 1,000 | 0.7 MB | 3 / 2 ms | 4 / 2 ms | 4 ms | 52 / 2 ms | 43 / 2 ms | 5 ms | 2 ms |
| 10,000 | 5.8 MB | 15 / 2 ms | 44 / 2 ms | 9 ms | 59 / 2 ms | 55 / 2 ms | 19–24 ms | 7 ms |
| 50,000 | 28 MB | 67 / 2 ms | 66 / 2 ms | 29 ms | 104 / 2 ms | 137 / 2 ms | 82–85 ms | 117 ms |
| 100,000 | 56 MB | 110 / 2 ms | 198 / 2 ms | 55 ms | 190 / 2 ms | 194 / 2 ms | 147–149 ms | 877 ms |

Opening a ledger with the real storage kit and SQLite driver (what Restore's last step, and every Open, costs). The
whole of it blocks the main process:

| Transactions | 1,000 | 10,000 | 50,000 | 100,000 |
|---|---|---|---|---|
| Open (stall the same) | 6 ms | 34 ms | 210 ms | 436 ms (1,022 ms in an earlier run) |

**The disk's state matters more than the ledger's size.** In the quit runs (question 8), the same 100,000-transaction
snapshot took 0.3 s on one run and 3.1 s on another, when the disk was still writing back 2 GB of seed files. The
budgets are set for the slow case.

#### 4. An import when Tessera quits

Run through the real quit: `lifecycle.requestShutdown('user')`, which closes the ledger, whose close aborts the
import.

| Where the import was | What happened |
|---|---|
| Waiting in its account dialog | The quit's listeners finished in 1 ms, and the ledger closed. **The import was still running 10 s later.** When the dialog closed (as when its window closes), it ended 3 ms later, as "cancelled" |
| Matching and applying 200 / 1,000 / 2,000 lines | It holds the main thread for the whole statement: 75 / 285 / 595 ms. A quit due half-way could only start 26 / 171 / 294 ms late, once the statement was done, which was "imported" whole |

The statements in the spike were matched against an empty account. Against a long history, matching takes longer, and
so does the wait.

#### 5. The trash on Linux

| Where | `gio trash` (what Electron runs on Linux) |
|---|---|
| The home volume (ext4), in and outside the home folder | Trashed, to `~/.local/share/Trash` |
| A tmpfs volume (`/dev/shm`) | **Refused:** "Trashing on system internal mounts is not supported". The file stayed |
| `gio` not installed (a minimal desktop) | **Refused** (command not found). The file stayed |

Electron's `trashItem` documentation says only that it rejects on an error, and that paths must use the platform's
separator (`path.resolve`).

#### 7. Side files

| Situation | Side files left | Notes |
|---|---|---|
| Open, after writing | `-wal` (1.3 MB), `-shm` | |
| Closed cleanly | **None** | |
| Killed with the ledger open | `-wal`, `-shm` | **The main file alone had no tables**; with its `-wal`, all 2,001 committed transactions |
| Then opened read-only (the probe) and closed | `-wal`, `-shm` | It saw all 2,001 |
| Then opened read-write and closed | **None** | |
| A read-only open of a clean WAL-mode ledger, closed | **An empty `-wal` and `-shm`** | A backup in `DELETE` mode leaves nothing |
| 20 kills at random moments during steady writing | `-wal`, `-shm` each time | All 20 reopened with `integrity_check` ok, holding whole batches only |
| A crashed ledger's `-wal` and `-shm` left beside a restored backup | | **It opened as the old ledger** (500 transactions, not the backup's 3,000), with `integrity_check` ok |

#### What changes in this note

| Where | Change |
|---|---|
| [SQLite: …](#sqlite-the-online-backup-api-or-vacuum-into), [the storage contract](#the-storage-contract-snapshot-and-readmeta) | **No commit lock;** writes carry on. The target is created exclusively. A cancelled snapshot's file is deleted. The finishing step runs in a worker. `backup()` stays the choice, with the worker's `VACUUM INTO` as the fallback |
| [The storage contract](#the-storage-contract-snapshot-and-readmeta), Phase 1 | **The probe uses `readMeta`:** no longer optional, since each full load blocks the main process for up to a second |
| [Quitting while the ledger is busy](#quitting-while-the-ledger-is-busy) (new), Phase 4 | The quit guard, asked before the shutdown listeners and before the last window closes; a confirmed quit cancels open dialogs |
| [Restoring in place](#restoring-in-place) (then "Replacing a ledger") | Side files move aside with the old file, and step 4 checks none remain (the stale-WAL finding). The retry policy for held files |
| [Showing progress](#showing-progress) | The measured times; the restore's "Opening" bar is a CSS animation, because the main process is blocked while opening |
| [Retention](#retention-trimming-old-backups) | A trash refusal leaves the file and warns once per folder; trashed backups still use disk space |
| [Backing up when the ledger closes](#backing-up-when-the-ledger-closes) | The measured budgets; the wait for the import relies on cancelled dialogs |
| [Still open](#still-open) | The quit guard's shape; what to do where there's no trash; staging backups on quit for slow folders |
| [Documentation changes](#documentation-changes) | Two existing issues found on the way, for the import plugin and the storage kit |

#### Windows results

Run by the reviewer on 2026-11-09, with Electron **45.0.0** (Node 24.22.0, SQLite 3.53.4, newer than the Linux runs'
3.50.4).

| Check | Result | What it means |
|---|---|---|
| Q1, `backup()`, in Electron's main process | The same as on Linux, line for line: 58 progress callbacks; a WAL-mode copy, `DELETE` afterwards with no side files and `quick_check` ok; cancelling leaves an empty file; a target that isn't a database is refused. 328 commits during a 65 ms backup, the copy consistent | **The chosen method works in Electron 45.** Nothing in the design changes |
| Q2, `VACUUM INTO` in a worker, in Electron's main process | 308 ms at 54 MB; 24 commits on the main thread meanwhile, none blocked; a snapshot as of the start; `terminate()` leaves a partial file | **The fallback works in Electron too.** The longest "stall", 16 ms, is Windows' default timer granularity (about 15.6 ms), the finest the meter can see there, not a block |
| Q6, `q6-windows-lock.ps1` | Held with `FileShare` None, Read or ReadWrite: **`EBUSY`**. Held with Delete, or ReadWrite and Delete: renamed | The retry policy covers what Windows gives. The backup's own rename of its partial file now uses it too |
| Q5, `trashItem` in a local folder | Trashed; the file gone from the folder | The Recycle Bin works for a local default folder |
| Q8, the whole backup on quit, in Electron, with the real `shell.trashItem` (after the script was made portable; its first run called Linux's `gio`) | 10,000 transactions: **0.33 to 0.46 s** (snapshot 28 ms, finishing 20 ms, a scan of 41 backups 17 to 23 ms, **trashing 6 files 265 to 390 ms**). 100,000 transactions: **0.58 to 0.62 s** (snapshot 187 to 202 ms, finishing 95 ms, trashing 255 to 312 ms). Longest main-thread stall 133 ms, from the finishing step | **Well inside both budgets** on a local disk. On Windows the Recycle Bin is the slowest step, at about 50 ms a file. Retention therefore trashes in the background after the backup is reported, except on quit, where it uses what is left of the budget. The finishing step's stall confirms it belongs in the worker |
| Q3, `node q3-timing.mjs` (warm only: Windows can't evict a file from the cache) | `backup()`: 4 / 20 / 64 / 135 ms at 1k / 10k / 50k / 100k transactions. The worker's `VACUUM INTO`: 25 / 43 / 92 / 159 ms. **`VACUUM INTO` on the main thread blocked it for 16 / 21 / 79 / 142 ms.** Finishing on the main thread: 6 / 12 / 36 / 68 ms | As on Linux. Every "stall" of 15 to 16 ms is Windows' timer granularity. The main-thread `VACUUM INTO` is the only method that really blocks |

#### Not verified: the spike is closed

The reviewer closed the spike after the Windows runs. What it didn't check moves into the smoke tests of the phases
that need it:

| What | Where it is checked now |
|---|---|
| `trashItem` on a network share, a USB drive and a OneDrive or Dropbox folder (trashed, refused, or deleted?) | Phase 2's smoke test, on Windows. The code already assumes the trash can be refused |
| The rename code when a second copy of Tessera, or a OneDrive folder, holds the ledger (expected `EBUSY`) | Phase 3's smoke test, on Windows |
| A backup during an OS shutdown with `blockShutdown` | Phase 4's smoke test, on Windows |
| Anything on macOS | Each phase's smoke test, where a Mac is at hand |

---

## Phase 1: snapshots in the storage engines (M)

No visible change.

- `SnapshotOptions` (with `onProgress`), `Database.snapshot`, `StorageEngine.readMeta` in
  [`tessera-types/storage.ts`](../tessera-types/storage.ts).
- Storage kit:
  - `StorageBackend.snapshot` and `BackendDriver.readMeta`;
  - `KitDatabase.snapshot` (no lock);
  - `KitStorageEngine.readMeta`, from memory when the database is open.
- **The SQLite driver:**
  - `backup()`, into a target created exclusively;
  - cancelling by throwing from `progress`;
  - the finishing step (`DELETE` journal mode, meta, `quick_check`) in a worker thread, with its code as a string;
  - the target deleted on any failure.

  The worker's `VACUUM INTO` isn't built: `backup()` behaved the same in Electron 45 on Windows. It stays documented
  as the fallback.
- The Loki driver and the memory driver.
- `scopedDatabase.snapshot` rejects, as `close` does.
- **The ledger's `probe` reads meta with `readMeta`** instead of a full read-only open.
- **Tests:**
  - the conformance group, for every engine: progress; writes during a snapshot carry on, and the copy is consistent;
    an existing target is refused; a cancelled snapshot leaves nothing;
  - SQLite: the single-file copy, and a read-only open of it leaving no side files; the naive-copy regression;
  - the scoped database refusing `snapshot`.

**Exit:** every engine passes the conformance group, and the suite is green.

### Phase 1 results

Done 2026-11-09. **No visible change:** the engines can snapshot a database and read its meta, and Open checks a
ledger from its meta, but nothing in the user interface uses snapshots yet.

| What | Where |
|---|---|
| `SnapshotOptions`, `Database.snapshot`, `StorageEngine.readMeta`, and the error code `ABORTED` | [tessera-types/storage.ts](../tessera-types/storage.ts) |
| `StorageBackend.snapshot` and `BackendDriver.readMeta` in the kit's backend contract | [packages/storage-kit/backend.ts](../packages/storage-kit/backend.ts) |
| `KitDatabase.snapshot` (checks its arguments, takes no lock, tracks running snapshots), `close()` waiting for them, and `KitStorageEngine.readMeta` (from memory for an open database) | [database.ts](../packages/storage-kit/database.ts), [engine.ts](../packages/storage-kit/engine.ts) |
| The memory driver: a snapshot is a deep copy in the driver's store; `readMeta` never creates a database | [memory.ts](../packages/storage-kit/memory.ts) |
| The SQLite driver: `backup()` into a target created exclusively, cancelled by throwing from `progress`; the finishing step (`DELETE` journal mode, the meta, `quick_check`) in a worker thread with its code as a string; everything removed on failure; `readMeta` as one read-only query | [SqliteDriver.ts](../plugins/storage.sqlite/src/privileged/SqliteDriver.ts) |
| The Loki driver: the in-memory database rebuilt as a copy, the meta added to it, saved through the adapter; `readMeta` from the saved file's meta collection | [LokiDriver.ts](../plugins/storage.loki/src/privileged/LokiDriver.ts) |
| Contributors can't snapshot | [scopedDatabase.ts](../plugins/ledger/src/privileged/scopedDatabase.ts) |
| The probe reads meta only, and Open reads the new ledger before closing the current one | [LedgerSessionImpl.ts](../plugins/ledger/src/privileged/LedgerSessionImpl.ts), [migrations.ts](../plugins/ledger/src/privileged/migrations.ts) |
| The contract, the errors table and the conformance list; a note for plugin authors | [storage-engine-redesign.md](storage-engine-redesign.md), [plugin-creation.md](plugin-creation.md) |

Decisions and departures:

- **A new error code, `ABORTED`**, rather than the IO error the first draft of the contract named, so a caller can
  tell "abandoned, as asked" from "failed".
- **`close()` waits for running snapshots, and the tests check the order.** SQLite would survive a close during a
  backup on its own: it defers closing the connection until the backup ends, and the copy still completes. But what
  quitting relies on is that the snapshot has *finished* once `close()` resolves, and that is what the tests assert.
- **The Loki copy is built from the in-memory database,** so it includes writes whose buffered save hasn't reached
  the file yet. It is written through the same adapter as the database (`<file>~`, then renamed).
- **Open reads the new ledger before closing the current one** ([above](#the-storage-contract-snapshot-and-readmeta)),
  so that moving the probe to `readMeta` didn't lose the check against damaged files.
- **A `VACUUM INTO` fallback isn't built.** `backup()` behaved the same in Electron 45 as in Node.
- **A gap in the existing tests, found on the way:** nothing checked that opening another ledger closes the open one.
  Deleting that step passed every test. It has a test now, since this phase moved that step.

Verification:

- **Tests.** The full suite passes: 137 files, 2,104 tests (2,060 before).
  - `tests/storage/conformance.ts` (+11, run for the memory, SQLite and Loki engines, so +33):
    - every collection, index and meta value copied, with the meta in the copy only;
    - the copy is a database in its own right;
    - writes carry on, and the copy holds whole transactions only;
    - progress ends at 1 and never goes back;
    - an existing target is refused and left alone;
    - an abandoned snapshot leaves nothing;
    - bad arguments and a closed database are refused;
    - a read-only database can be copied;
    - `close` waits for a running snapshot;
    - `readMeta` on open, closed and copied databases; `{}` and NOT_FOUND, creating nothing.
  - `tests/plugins/storage.sqlite/SqliteStorageEngine.test.ts` (+6):
    - the copy is one checked file, and reading it leaves nothing beside it;
    - **a plain copy of an open database's file loses what was written**, the regression test for why backups are
      snapshots;
    - abandoned half-way, nothing is left and the database carries on;
    - `close` waits for a snapshot copied in several steps;
    - a file is never replaced, even one that isn't a database;
    - `readMeta` on a foreign SQLite file (`{}`, left byte-identical) and on a file that isn't one (IO).
  - `tests/plugins/storage.loki/LokiStorageEngine.test.ts` (+2): the copy includes writes not yet saved; `readMeta`
    on JSON that isn't a Loki database, and on text.
  - `tests/plugins/ledger/session.test.ts` (+2, and one extended):
    - a contributor can't snapshot;
    - Open reads the file once;
    - opening another ledger closes the open one (close listeners, then `closed`, then `opened`).
  - `tests/plugins/ledger/files.test.ts` (+1): on real SQLite, a ledger whose meta is fine but whose data is damaged
    is refused, and the open ledger stays open and usable.
- **The tests fail without each change.** Each change was undone in turn, and each time the tests for it failed:
  - `close` not waiting: 2;
  - a non-exclusive SQLite target: 3;
  - the copy left in WAL mode: 1;
  - an abandoned copy not removed: 1;
  - `readMeta` creating a database: 2;
  - the meta written to the original too: 1;
  - `readMeta` ignoring an open database: 1;
  - contributors allowed to snapshot: 1;
  - not closing the old ledger: 1;
  - closing it before reading the new one (the old order): 1;
  - the probe loading the whole file (the old way): 1.
- **The built plugin.** `npm run build:plugins` builds all nine. The bundled `storage-sqlite` plugin was activated in
  plain Node 24 (Electron 45's line), and snapshotted a ledger in steps: progress 0.30, 0.60, 0.89, 1.00. The worker
  wrote the copy's meta, and the copy had no side files.
- **Types:** no new errors in any project (core 3, shell 16 and tests 28, as before; shared, plugins, scripts and the
  storage kit clean).

## Phase 2: Back Up Ledger…, retention, and one thing at a time (L)

- **The ledger operation:**
  - `LedgerSession.beginOperation` and `operation`;
  - the `BUSY` error;
  - the `ledger.isBusy` and `ledger.operation` context keys;
  - `!ledger.isBusy` in the enablement of New, Open, Close and Delete, and the same checks in the session for IPC and
    other plugins;
  - **the import plugin takes the operation** in `exclusively`, and Import… gains `!ledger.isBusy`.

  This is the first step of the phase. It ships even if the rest slips.
- **Ledger identity:**
  - `LEDGER_META.id`, written by `create` and by `attach` when it is missing and the ledger is writable;
  - the recent list records it.
- **Backups refused by Open**, in `probe`.
- `LEDGER_BACKUP_EXTENSION` (`.tesserabkp`), `LEDGER_BACKUP_FILTER` and `LEDGER_BACKUP_META` in `@tessera/ledger-api`.
- `LedgerDisk` gains `list`, `rename`, `remove`, `mkdir` and an exclusive `copy`; so does the test harness's fake.
- **The `ledger.backup` settings namespace,** with its defaults and `validate`. There is no page yet: the default
  folder is `<Documents>/Tessera Backups`.
- **`BackupService`:**
  - naming;
  - snapshot to the partial file, verify, rename;
  - `renameWithRetry` (10 s at most, a notice after 1 s, only onto free names; `EBUSY`, `EPERM`, `EACCES`), tested
    against simulated locks. Restore uses it too;
  - `backup.last`;
  - retention (`backupsToTrim` and `trimFolder`), in the default folder only.
- **The `ledger.backup` command,** and the File menu group `ledger.backup` (order 7) with **Back Up Ledger…**.
- **Feedback:** the `ledger.activity` status item (progress after 0.5 s, then the result), and an error message box on
  failure.
- **Tests:** `operation.test.ts`, the import's `run.test.ts` additions, `retention.test.ts`, `backup.test.ts`, the
  `ledger.id` tests, Open refusing a backup, activation.

**Exit:**

- A user can back up, and sees the backup in the default folder.
- Backups past the period go to the trash; backups saved elsewhere are left alone.
- During an import, Back Up, Close and Open are greyed out.
- The suite is green.

Smoke test:

- Back up twice, and check the `(2)` suffix.
- Open the backup with a SQLite tool.
- Back up a 100,000-transaction ledger, and watch the percentage while scrolling the register.

### Phase 2 results

Done 2026-11-09. **Visible change:** File › Back Up Ledger… (in a new group after Import…), the backup's progress
and result in the status bar, retention in the default backup folder, and the ledger's file commands and Import…
greyed out while an import or a backup runs.

| What | Where |
|---|---|
| **One operation at a time:** `LedgerSession.beginOperation(label)` and `operation`; the `BUSY` error; the context keys `ledger.isBusy` and `ledger.operation`; New, Open, Close and Delete disabled while busy, and their methods refusing (the start view's IPC included) | [ledger-api service.ts](../packages/ledger-api/service.ts), [LedgerSessionImpl.ts](../plugins/ledger/src/privileged/LedgerSessionImpl.ts), [commands.ts](../plugins/ledger/src/privileged/commands.ts), [ipc.ts](../plugins/ledger/src/privileged/ipc.ts) |
| **The import takes the operation** for its whole run, and Import… is disabled while the ledger is busy | [import run.ts](../plugins/import/src/privileged/run.ts), [import index.ts](../plugins/import/src/privileged/index.ts) |
| **The ledger's identity:** `ledger.id` on create, and on the first writable open of an older ledger; `LedgerInfo.id`; the id in the recent list | [LedgerSessionImpl.ts](../plugins/ledger/src/privileged/LedgerSessionImpl.ts), [RecentLedgers.ts](../plugins/ledger/src/privileged/RecentLedgers.ts) |
| **Open refuses a backup** ("… is a backup, not a ledger, so it can’t be opened.") | `probe` in [LedgerSessionImpl.ts](../plugins/ledger/src/privileged/LedgerSessionImpl.ts) |
| `LEDGER_BACKUP_EXTENSION`, `LEDGER_BACKUP_FILTER`, `LEDGER_BACKUP_META`, `LEDGER_META.id`, the `ledger.backup` command and its argument, the `ledger.activity` context key, the error code `BACKUP_FAILED` | [ledger-api protocol.ts](../packages/ledger-api/protocol.ts), [errors.ts](../packages/ledger-api/errors.ts), [model.ts](../packages/ledger-api/model.ts) |
| `LedgerDisk` gains `list`, `rename`, `remove`, `mkdir` and `realpath` | [disk.ts](../plugins/ledger/src/privileged/disk.ts) |
| **The backup:** `BackupService` (snapshot to `<name>.partial`, verify by `readMeta`, replace a chosen file through the trash, rename with `renameWithRetry`, `backup.last`); retention (`backupsToTrim`, `trimFolder`, `discard`); names; the `ledger.backup` settings namespace (no page yet); the status text (`Activity`); the command | [backup/](../plugins/ledger/src/privileged/backup/) |

Decisions and departures:

- **The backup uses the session's queue through `withOpenLedger`,** an internal hook (not on `LedgerSession`) that runs
  work with the raw database while nothing can open or close. The snapshot, the check and the rename happen inside it;
  retention happens after it, outside the queue.
- **The operation is held for the whole command,** from before the save dialog until retention has finished, as the
  import holds it through its dialogs.
- **A file the user chose to replace** goes through the same `discard` as retention: the trash, or deleted where the
  trash refuses. If neither works, the backup fails and the old file is left.
- **Failures are told as what to do,** not as an engine's message:
  - "The folder “…” isn’t available." (a missing folder or drive);
  - "There isn’t enough space…";
  - "Tessera can’t write to “…”.";
  - "Another program, such as a sync or antivirus program, is using “…”. Try again in a moment." (a held file);
  - anything else as "The backup couldn’t be written: …".

  They are found from the error's `code` and its causes, since the storage engine wraps what the file system threw.
- **Open's message for a backup doesn't mention Restore,** which arrives in Phase 3; Phase 3 adds it.
- **The start view is unchanged:** in this phase an operation needs an open ledger, and the start view shows only
  with none. Restore, in Phase 3, runs from it.
- **`backup.last` is recorded** (each ledger's last backup, by id) but not read yet: it is for backing up on close and
  reminders.
- **Two test traps, found by breaking the code:** an assertion inside a fake that the code catches (the trash, an
  import's dialog) fails silently, because the code takes the throw for a refusal and carries on. Those tests now
  record inside the fake and assert afterwards.

Verification:

- **Tests.** The full suite passes: 141 files, 2,160 tests (2,104 after Phase 1).
  - `tests/plugins/ledger/backup.test.ts` (new, 19):
    - File › Back Up Ledger… end to end: the suggested folder and name, the copy's meta and contents, the ledger left
      open and unchanged;
    - the result shown for a minute, and `backup.last`;
    - the extension added, ` (2)`, a cancelled dialog, replacing a file, a path as the argument;
    - the ledger held meanwhile (file commands disabled and refusing, editing carrying on), and the command disabled
      with no ledger open or while another operation runs;
    - failures: a missing folder, a full disk, a copy that doesn't read back, a held file waited for, and one held for
      good, each leaving nothing behind;
    - retention: the expired backups of this ledger only, nothing after a backup elsewhere, the trash refusing, the
      settings, and trimming only after the result is shown;
    - Open refusing a backup.
  - `tests/plugins/ledger/retention.test.ts` (new, 10): `backupsToTrim` on the design's cases and on 300 random
    folders (its rules hold every time); `trimFolder` skipping other ledgers, subfolders, other extensions, unreadable
    files and files without a format; deleting where the trash refuses; `discard`.
  - `tests/plugins/ledger/backupParts.test.ts` (new, 15): names, ` (2)`, the extension; `renameWithRetry` (a brief
    hold, the notice after a second, giving up at ten, `EPERM` and `EACCES`, no retry for other errors or onto a name
    that exists); the status text (nothing under half a second, the percentage, the note, a minute for the result,
    newer work replacing older); the settings' checks and the default folder.
  - `tests/plugins/ledger/operation.test.ts` (new, 8): one operation at a time; the file commands and methods while
    busy, the start view's IPC too; editing meanwhile; quitting still closes the ledger; the ledger's id on create,
    on reopening, for an older ledger, and in the recent list.
  - `tests/plugins/ledger/files.test.ts` (+1): on real files with SQLite and the Node disk: a backup, a second one
    ` (2)`, one checked SQLite file in `DELETE` mode holding the sub-ledger, and retention moving the expired one to the
    trash.
  - `tests/plugins/import/run.test.ts` (+3): the import holds the operation through its dialogs (the backup and file
    commands disabled meanwhile), releases it however it ends, and can't start while another operation runs.
  - Three tests updated for the new contract: the session's keys, the File menu and status items, and `LedgerInfo.id`.
- **The tests fail without each change.** Each change was undone in turn, and each time tests failed:
  - a second operation allowed;
  - the file methods not refused while busy;
  - Close enabled while busy;
  - the import not taking the operation;
  - Import enabled while the ledger is busy;
  - retention outside the default folder;
  - no delete when the trash refuses;
  - keep-at-least ignored;
  - a partial file left on failure;
  - the copy not verified;
  - no retry for a held file;
  - Open accepting a backup;
  - older ledgers given no id;
  - the result not shown, or shown only after trimming;
  - progress shown at once;
  - the backup's meta incomplete.
- **The plugins build** (`npm run build:plugins`: all nine).
- **Types:** no new errors in any project.
- **Seen in Electron on Windows** (the reviewer's screenshots, 2026-11-09): Back Up Ledger… in its own group; the save
  dialog in `Documents › Tessera Backups` with the suggested name; the backup written (24 KB), and synced by OneDrive.
  Still to see: the status bar's result; Close and Import greyed out during an import; a large ledger's percentage.

## Phase 3: Restore Ledger… (L)

- **`describe`:** Open's checks (`inspect`) plus `readMeta`, for a backup or a ledger file.
- **The Restore dialog** (`./RestoreDialog`, `ledger.dialog.restore`):
  - the backups in the default folder, Browse…, *A new ledger* and *In place of*, and the rules for which ledger a
    backup belongs to;
  - it runs the restore itself, showing the steps and a spinner;
  - its IPC channels and progress event.
- **In place:**
  - the seven steps with their rollbacks;
  - side files moved with the kept file, and step 4's check, with **the stale-WAL case as a test on real SQLite
    files**;
  - `renameWithRetry`, from Phase 2, for steps 3 and 5;
  - the kept file given a new id; nothing trashed.
- **Restore as new:** the new id, `restoredFrom`, and the `backup.*` keys removed.
- **The `ledger.restore` command** (taking the ledger operation), and **Restore Ledger…** in the group.
  **Restore from a backup…** on the start view, and in its "could not be reopened" message.
- **Tests:** `restore.test.ts` (a failure at every step), `restoreDialog.test.tsx`, activation.

**Exit:** every row of [Edge cases](#edge-cases) is covered by a test. Smoke test:

- Restore in place of the open ledger, and open the kept file.
- Restore as new.
- Restore a pre-upgrade `.backup-….tessera`.
- Damage a ledger by hand so it won't open, then restore it from the start view.
- Restore a 100,000-transaction ledger, and watch the steps.

### Phase 3 results

Done 2026-11-09. **Visible change:** File › Restore Ledger… (after Back Up Ledger…), the Restore dialog, and Restore
from a Backup… on the start view and in its "could not be reopened" warning.

| What | Where |
|---|---|
| `RestoreService`: the dialog's session; describing a backup (Open's checks, `inspect`); listing the default folder; Browse…; the plan (which ledger a backup belongs to, free names); restoring as new and in place, with every rollback | [backup/restore.ts](../plugins/ledger/src/privileged/backup/restore.ts) |
| The command, holding the operation while the dialog is open and until a restore has finished; the dialog's IPC | [backup/restoreCommand.ts](../plugins/ledger/src/privileged/backup/restoreCommand.ts) |
| The Restore dialog | [RestoreDialog.tsx](../plugins/ledger/src/renderer/RestoreDialog.tsx) |
| The start view's Restore from a Backup… | [StartView.tsx](../plugins/ledger/src/renderer/StartView.tsx) |
| The session: `inspect` (the probe, public to the plugin), `openFile` with `allowBackup` and `prepare`, `withFileOperations` | [LedgerSessionImpl.ts](../plugins/ledger/src/privileged/LedgerSessionImpl.ts) |
| `LedgerDisk` gains `copy` (exclusive, with progress, made durable), `stat` and `isFolder` | [disk.ts](../plugins/ledger/src/privileged/disk.ts) |
| The contract: `ledger.restore`, `ledger.dialog.restore`, the restore channels and progress event, `BackupInfo`, `RestorePlan`, `RestoreRequest`, `RESTORE_FAILED`, `LEDGER_META.restoredFrom`, `validateLedgerFileName` | [ledger-api](../packages/ledger-api/) |
| `shell.files.showOpenFolderDialog` (from Phase 4a) | [tessera-types/dialogs.ts](../tessera-types/dialogs.ts), [electronFiles.ts](../shell/main/dialogs/electronFiles.ts) |

Decisions and departures:

- **The current file is never replaced** (the fourth review). The first draft's *Replace*, its confirmation and its
  trashing are gone. In their place is *In place of “Home”*, which renames the current file to a name the user
  chooses (suggested `Home (before restore 2026-11-09 10-14)`) and keeps it.
- **The kept file gets a new `ledger.id`,** so it is a ledger of its own. This is the one change made to it: without
  it, the kept file and the restored ledger would share an id, and their backups would be taken for one ledger's.
- **The Restore dialog lists the backups itself,** rather than starting from an open-file dialog: the default folder's
  backups, each described, with Browse… for others.
- **A ledger that has moved** since its backup is found through the recent list, by its id.
- **A ledger file that isn't a backup** (a pre-upgrade copy) can be restored. Its suggested name comes from its
  ledger, when its id finds it, not from its own file name.
- **The restored file is prepared before it is shown** (`openFile`'s `prepare`): its backup meta removed, and for a
  new ledger a new id and `restoredFrom`. There is no second load, and Open still refuses backups.
- **No progress bar:** `@tessera/ui` has none, so the dialog shows the step beside a spinner (`CircularProgress`),
  which shows the percentage while copying.
- **The folder picker** came forward from Phase 4a.

Verification:

- **Tests.** The full suite passes: 143 files, 2,192 tests (2,160 after Phase 2).
  - `tests/plugins/ledger/restore.test.ts` (new, 20), through the command with the dialog played by the test:
    - the list: the folder, newest first, kinds, and the reason for each file that can't be restored;
    - the dialog answered only while the command has it open, and only backups it was shown restored;
    - plans: the open ledger, a recent ledger, a ledger that has moved, one that is gone;
    - the command's argument and Browse…;
    - the ledger held while the dialog is open;
    - as new: the backup's contents, a new id, `restoredFrom`, no backup meta, the current ledger untouched; refused
      names and folders;
    - in place: the current file kept under the name chosen, with a new id, nothing trashed, the steps in order;
      restoring a ledger that isn't open; side files moving with the kept file; refused names;
    - failures, each leaving the files as they were: a full disk, a current file held for good, a copy that can't
      take the name, a restored copy that won't open;
    - a damaged ledger restored from the start; a pre-upgrade copy restored; a restore outliving its dialog's window.
  - `tests/plugins/ledger/files.test.ts` (+1): **on real SQLite, a crashed ledger (a write only in its `-wal`) restored
    in place.** The restored file holds exactly the backup, and the kept file everything, the write in its `-wal`
    included.
  - `tests/plugins/ledger/renderer/restoreDialog.test.tsx` (new, 10): the list and the choice; as new; in place, with
    what happens to each file said; a reason for in place or for the whole backup; a refused name on its field, other
    failures above the buttons; a name checked before sending; the steps and percentage while busy; Browse… and
    Change…; a backup given to the command; an empty folder. Text is pasted, not typed key by key.
  - `tests/plugins/ledger/renderer/views.test.tsx` (2 extended): the start view's Restore from a Backup…, and in its
    warning.
  - `tests/main/electronFiles.test.ts` (+1): the folder picker.
  - Updated for the new contract: the File menu, the dialogs, and Open's message for a backup.
- **The tests fail without each change.** Each change was undone in turn, and each time tests failed:
  - side files not moved with the kept file;
  - the current file deleted instead of kept;
  - the kept file keeping the restored ledger's id;
  - a ledger restored as new keeping the backup's id;
  - the restored file keeping its backup meta;
  - the current file not put back after a failed rename, or after the restored copy won't open;
  - any file restorable;
  - the ledger let go before a restore finishes;
  - the recent list not searched. This one wasn't caught at first, because the backup's own path found the same
    ledger; a moved-ledger test now covers it;
  - the dialog defaulting to in place;
  - a restore refused by Open's backup check.

  Re-checking the name just before the rename guards a race, and no test covers it.
- **The plugins build,** the Restore dialog exposed in the ledger's remote.
- **Types:** no new errors in any project.
- **Seen working in Electron on Windows:** a restore in place of the open ledger, with the current file kept as
  `My_Finances (before restore …).tessera` beside the restored one.

## Phase 4: the Backups page and backing up on close (M)

**4a (shell, generic, can run at any time):**

- `shell.files.showOpenFolderDialog` (**done in Phase 3**, for the Restore dialog's Change…);
- the `folder` settings field kind:
  - its definition check and value check in `shared/settings/fields.ts`;
  - drawn in `FieldsPage.tsx` with **Browse…** and **Default**, through a shell channel from the Options window;
- in [plugin-creation.md](plugin-creation.md), the folder dialog in "Asking the user", and the field kind in the
  settings section.

**4b (ledger):**

- **The Backups page** (`ledger.backup.settings`, parent `ledger.settings`).
- **Backing up when the ledger closes:**
  - `onClose`;
  - the dirty tracking;
  - the session's close hook, told why the ledger is closing: it backs up for Close Ledger, switching ledgers and an OS
    shutdown, but not for Delete, a restore in place or pass 2 of a user quit. It runs after the `onWillClose`
    listeners and before the close;
  - on a user quit, the backup in the ledger's pass-1 handler (`onWillQuit`), with a failure as its reason;
  - on an OS shutdown: the wait for a running operation, and the 3 s budget;
  - `backup.lastAutoError`, and the "Last backup failed" status item that opens the page.
- The Restore dialog's **Change…** uses the folder dialog.

**4c (shell, generic, can run at any time; needed before 4b's backup on quit is reliable):**

- **Pass 1 of a user quit:** `context.lifecycle.onWillQuit(async () => reason | undefined)`, run for user quits in
  `before-quit` and in the last window's `close` event (Windows, Linux), before the shutdown listeners, with no time
  limit. The reasons are shown in one box with **Retry** (run pass 1 again), **Quit Anyway** and **Cancel** (the
  default).
- **Pass 2, when the quit goes ahead, and an OS shutdown, cancel open plugin dialogs** (`DialogService`), as a closing
  window does.
- The `ledger` plugin's handler returns its running operation's label.
- **Tests:**
  - pass 1 runs on both paths, and not for an OS shutdown;
  - Cancel leaves the window open and nothing shut down;
  - Retry runs pass 1 again, and goes on when no reason is left;
  - Quit Anyway cancels the dialogs, then runs pass 2;
  - an import waiting in a dialog ends after Quit Anyway;
  - a late veto in `onShuttingDown` is ignored (the spike's test), which is why the question is in pass 1.

**Tests for 4a and 4b:**

- the field kind and the folder dialog;
- the page's fields and validation;
- the backup on close: on each way of closing; only when dirty; in the right order; abandoned at its budget; skipped
  when an import doesn't unwind in time; shown in the status bar.

**Exit:**

- With the defaults, closing or switching after a change leaves a backup; doing it again without changes doesn't.
- Quitting after a change leaves a backup.
- An unplugged backup drive is reported in the status bar.

Smoke test on each OS, including an OS shutdown, and a quit during an import.

### Phase 4 results

Done 2026-11-09, with the fifth review's confirmation after a restore. **Visible changes:**

- Tools › Options… › Ledger › **Backups**;
- a backup as the ledger closes, shown in the status bar;
- **Tessera can't close yet** on a quit during an import or a failed backup;
- a **Last backup failed** status item;
- a message when a restore completes.

| What | Where |
|---|---|
| **4a.** The `folder` field kind: its type, definition and value checks, and the field (read-only path, Browse…, Default) | [tessera-types/settings.ts](../tessera-types/settings.ts), [shared/settings/fields.ts](../shared/settings/fields.ts), [FieldsPage.tsx](../shell/renderer/settings/FieldsPage.tsx) |
| **4a.** Browse… from the Options window: `shell:settings.chooseFolder`, answered with `shell.files.showOpenFolderDialog` for the window that asked | [shared/settings/types.ts](../shared/settings/types.ts), [registerSettings.ts](../shell/main/settings/registerSettings.ts), [SettingsDialog.tsx](../shell/renderer/settings/SettingsDialog.tsx), [app.ts](../shell/main/app.ts) |
| **4a.** `{key}` in status item tooltips | [ItemStrip.tsx](../shell/renderer/layout/ItemStrip.tsx), [tessera-types/layout.ts](../tessera-types/layout.ts) |
| **4c.** Pass 1: `onWillQuit` and `askToQuit` (newest first, no time limit, one shared run for concurrent quits) | [tessera-types/app-lifecycle.ts](../tessera-types/app-lifecycle.ts), [AppLifecycle.ts](../core/lifecycle/AppLifecycle.ts) |
| **4c.** The two passes, on `before-quit` and the last window's `close`; an OS shutdown taking over from a pass 1 that waits on the user | [lifecycle/quit.ts](../shell/main/lifecycle/quit.ts), [app.ts](../shell/main/app.ts) |
| **4c.** The question: Retry, Quit Anyway, Cancel (the default), every reason in one box | [lifecycle/quitPrompt.ts](../shell/main/lifecycle/quitPrompt.ts) |
| **4c.** Open plugin dialogs cancelled before pass 2: `DialogService.cancelAll`, and `shell:dialog.dismiss` taking each down in its window | [DialogService.ts](../core/dialogs/DialogService.ts), [shared/dialogs/types.ts](../shared/dialogs/types.ts), [DialogHost.tsx](../shell/renderer/dialogs/DialogHost.tsx) |
| **4b.** The Backups page and `onClose` | [backup/settings.ts](../plugins/ledger/src/privileged/backup/settings.ts) |
| **4b.** Backing up as the ledger closes, in pass 1, and on an OS shutdown (the 2 s wait for an operation, the 3 s budget) | [backup/autoBackup.ts](../plugins/ledger/src/privileged/backup/autoBackup.ts) |
| **4b.** `backUpDatabase` (the backup inside the close), `needsBackup`, the abort signal, `backup.lastAutoError` | [backup/BackupService.ts](../plugins/ledger/src/privileged/backup/BackupService.ts), [backup/rename.ts](../plugins/ledger/src/privileged/backup/rename.ts) |
| **4b.** The session: why it closes (`CloseReason`), the close hook, `changedSinceBackup` and `backupStarting`, `shutdown(reason)` | [LedgerSessionImpl.ts](../plugins/ledger/src/privileged/LedgerSessionImpl.ts) |
| **4b.** The wiring; "Last backup failed" and `ledger.backupSettings` | [index.ts](../plugins/ledger/src/privileged/index.ts), [contributions.ts](../plugins/ledger/src/privileged/contributions.ts), [ledger-api](../packages/ledger-api/protocol.ts) |
| The message after a restore (`RestoreOutcome`: the ledger, and the file kept) | [backup/restoreCommand.ts](../plugins/ledger/src/privileged/backup/restoreCommand.ts), [ledger-api](../packages/ledger-api/protocol.ts) |

Decisions and departures:

- **A close hook, told why, instead of `closeOpen({ backup })`.** The session calls one hook as the ledger closes with
  the reason (`close`, `switch`, `delete`, `restore`, `quit`, `system`), and the backup decides. The session doesn't
  need to know about backups, and the reasons are tested on their own. The hook and the change flag are the ledger's
  internals: the `LedgerSession` contract is unchanged.
- **Pass 2 of a user quit never backs up.** Pass 1 did, or the user chose Quit Anyway after it failed; backing up then
  would make them wait for what they chose to skip.
- **A new ledger starts unchanged,** but has no backup, so its first close backs it up. A flag for "created" would
  say the same thing twice.
- **A failed automatic backup makes the next close back up, even if nothing changed since the ledger reopened.**
  Without this, the changes the failed backup missed would be in no backup once the ledger closed and reopened. The
  problem record already names the ledger, so it carries this at no cost.
- **The problem clears only when that ledger is backed up.** Backing up another ledger says nothing about this one.
- **No message box when a backup fails as the ledger closes.** The close has happened and the user may be leaving.
  The status item says it, with the details in its tooltip. The generic `{key}` tooltip was the smallest way to carry
  them.
- **A rename waiting for a held file stops when the budget is spent,** so an OS shutdown isn't held up to 10 s by an
  antivirus scan.
- **Pass 1 in reverse activation order** (the fifth review): not for availability, since in pass 1 every plugin is still
  active, but so a plugin finishes, and hands its last writes to the plugins it depends on, before they do their own
  pass-1 work. The ledger runs last, and its backup holds everything.
- **The Restore dialog keeps its list newest first** as backups are added to it. A test found the order depended on
  when the chosen backup's plan arrived.

Verification:

- **Tests.** The full suite passes: 145 files, 2,243 tests (2,192 after Phase 3).
  - `tests/plugins/ledger/autoBackup.test.ts` (new, 25), through the activated plugin:
    - on Close Ledger, after a change, in the default folder, with the result in the status bar;
    - none when nothing changed, or only a manual backup since; one for a ledger never backed up, or whose record is
      gone;
    - before another ledger opens, or a new one is created;
    - including what `onWillClose` listeners write;
    - none on Delete, or with the setting off;
    - in the folder chosen on the page, and trimmed there;
    - changes a failed manual backup missed, backed up on close;
    - a failure: the ledger still closes, the status item and its text, the next close trying again and clearing it,
      the problem shown at the next start, the item opening the Backups page, another ledger's backup leaving it;
    - pass 1: the backup, progress and result; nothing when unchanged; a failure as the reason, then Retry; no second
      try in pass 2 after Quit Anyway; a running operation as the reason, with or without changes or a ledger; nothing
      with no ledger or the setting off;
    - an OS shutdown: the backup and retention; abandoned at 3 s, leaving nothing, recorded; a 2 s wait for an
      operation to end, then the backup; skipped and recorded when it doesn't; nothing when unchanged.
  - `tests/plugins/ledger/session.test.ts` (+6): the change flag (writes, a backup beginning, its undo, an upgrade,
    another ledger), the reason for each way of closing, the hook's place between the listeners and the close, and a
    failing hook.
  - `tests/plugins/ledger/restore.test.ts`: a restore as new backs up the ledger it closes; a restore in place doesn't.
    The message after each.
  - `tests/main/quit.test.ts` (+8) and `tests/main/quitPrompt.test.ts` (new, 2): pass 1 on both paths and not for an
    OS shutdown; Cancel, Retry and Quit Anyway; dialogs cancelled before pass 2; an OS shutdown taking over; the box.
  - `tests/core/lifecycle.test.ts` (+1): newest first, one at a time, reasons trimmed, a failing listener logged, a
    shared run, the phase unchanged.
  - `tests/core/dialogService.test.ts` (+1), `tests/renderer/dialogHost.test.tsx` (+1): cancelling every open dialog.
  - `tests/shared/settingsPages.test.ts` (+1), `tests/main/registerSettings.test.ts` (+2),
    `tests/renderer/settingsDialog.test.tsx` (+2): the folder field, Browse…, Default, a cancelled Browse….
  - `tests/renderer/layoutFeatures.test.tsx` (+1): `{key}` in tooltips. `tests/plugins/ledger/backupParts.test.ts`
    (+1): a rename's wait ending with its signal. `activation.test.ts`: the page and the status item.
- **The tests fail without each change.** Each was undone in turn, and each time tests failed:
  - the backup on close skipped on Delete or a restore in place, or made in pass 2 of a user quit;
  - the setting ignored; the OS shutdown path; its wait for an operation, and the subscription that ends the wait;
    retention after a backup on close, and on an OS shutdown;
  - the change flag: not set by writes, not reset when a backup begins, not put back when one fails, put back on
    another ledger, not set by an upgrade;
  - "never backed up" and "last backup failed" as reasons to back up;
  - the problem not cleared, or cleared by another ledger's backup;
  - the close hook not called, or a restore's close given as a Close;
  - pass 1: a running operation not given as a reason when nothing needs backing up; the question not asked; Cancel
    ignored; dialogs not cancelled; the last window not held; the order not reversed;
  - `cancelAll` not resolving; the dismissed dialog not taken down;
  - a folder value not checked; a cancelled Browse… clearing the folder (caught once the test chose a folder first);
    Default not clearing it;
  - tooltips not interpolated; a rename ignoring its signal.

  `changed = false` on close was redundant (the flag reads false with no ledger open) and was removed.
- **The plugins build;** the main process and the renderer build.
- **Types:** no new errors in any project.
- **Not yet seen in Electron.** The smoke test above is still to do.

## Phase 5: later, each scheduled separately

- **Show in Folder (S), an optional future enhancement** (review answer 5): clicking the status bar's "Backed up
  “Home” at 10:14" shows the backup in the file manager, through `shell.files.showItemInFolder`, a new generic method.
  The Backups page could offer the same for the default folder.
- **A progress-bar status item and taskbar progress (S–M), optional:** a generic `progress` kind of status item, and
  `BrowserWindow.setProgressBar` behind a small shell service. Both backups and imports could use them.
- **Compressed backups (M).** gzip the snapshot; the file is then sniffed as gzip or plain database, so older backups
  still restore. For the meta to stay cheap to read, it goes in a small uncompressed header. Measurements on real
  ledgers decide whether it's worth it: 14× on synthetic data is an upper bound.
- **Backup reminders (S):** "“Home” hasn't been backed up for 30 days" in the status bar, from `backup.last`.
- **Pre-upgrade backups into the backup folder (S),** as `.tesserabkp` with `kind: 'upgrade'`, so they're restorable
  from the same dialog and trimmed by the same rule, instead of piling up beside the ledger.
- **Finishing or undoing an interrupted restore (M)** at the next start, from the `.restoring-` and `.before-restore-`
  files.
- **Other destinations (L):** a `ledger.backup.destinations` extension point, so a plugin can offer a cloud service. It
  would build on the snapshot and retention here.

---

## Documentation changes

| Document | Change | When |
|---|---|---|
| This note | Phase results sections and the status line | Each phase |
| [README.md](../README.md) | This note in "Documentation"; Back Up and Restore in the feature list | Review; Phase 3 |
| [todo.md](todo.md) | A "Backup and restore" group with the phases; "backups" removed from the `shell.files` item, pointing here | Review |
| [account-manager-design.md](account-manager-design.md) | The File menu gains the backup group; `ledger.id` in the meta; `beginOperation` in the session; the framework-prerequisites remark "a backup is a file copy the ledger can make itself" corrected for open ledgers (done) | Phase 2 |
| [import-manager-design.md](import-manager-design.md) | An import takes the ledger operation, and Import… is disabled while the ledger is busy (done) | Phase 2 |
| [todo.md](todo.md) | Two issues the spike found on the way, outside this feature: **the import holds the main process for a whole statement** (0.3 s per 1,000 lines against an empty account, longer against a long history), and should yield while matching; **opening a ledger blocks the main process** (0.4 to 1 s at 100,000 transactions) while the storage kit loads it | Review |
| [plugin-creation.md](plugin-creation.md) (lifecycle section) | `onWillQuit`, the quit guard; dialogs are cancelled when a quit goes ahead (done) | Phase 4 |
| [storage-engine-redesign.md](storage-engine-redesign.md) | `snapshot` and `readMeta` in the contract (done) | Phase 1 |
| [plugin-creation.md](plugin-creation.md) | `showOpenFolderDialog`; the `folder` field kind; contributors can't snapshot; long jobs take `beginOperation` (done) | Phases 1, 2 and 4 |
| [layout-controller-design.md](layout-controller-design.md) | `{key}` in bar item tooltips (done) | Phase 4 |
| [vault-design.md](vault-design.md) | `shell.files.backup` marked superseded by this note | Review |
