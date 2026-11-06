# Design note: the account manager (ledgers, accounts and transactions)

| | |
|---|---|
| **Status** | Implemented: the framework prerequisites, the `ledger` plugin (ledgers and sub-ledgers), and the `accounts` plugin (accounts with minimum balances, transactions, transfers, payees, categories, the service other plugins use, the navigator, the dialogs and the register), and reconciliation against a statement with its extension point. Not yet: the home view, splits and import. Review decisions applied 2026-11-04 (see [Decisions taken in review](#decisions-taken-in-review)) |
| **Date** | 2026-11-04 |
| **Scope** | The first Finance feature: the file that holds a user's finances, the chart of accounts inside it (sub-ledgers and accounts), the transactions in each account, the register UI that shows and edits them, and the extension point for reconciliation |
| **Builds on** | [storage-engine-redesign.md](storage-engine-redesign.md) (the `storage.engine` contract, implemented), [layout-controller-design.md](layout-controller-design.md) (slots, views, `shell.layout.reveal`), [plugin-creation.md](plugin-creation.md) |
| **Replaces** | The session half of [vault-design.md](vault-design.md), under a new name (see [Naming](#naming)). Importers (`accounts.importers`) from that note are unchanged and remain future work |
| **Companion** | [account-manager-implementation.md](account-manager-implementation.md): phases, files, tasks and tests |

## Summary

- **A *ledger* is the file that holds a user's finances**, as a `.mny`
  file did for Microsoft Money. It is what File › Open, Close and Delete act
  on, and it is the root of the chart of accounts. Ledger files are SQLite
  databases, SQLite now being the default storage engine.
- **A ledger contains *sub-ledgers***, which can nest to any depth, and
  **accounts** (chequing, savings, credit card, mortgage, investment…),
  which live in the ledger itself or in any sub-ledger. Sub-ledgers are
  records inside the ledger's file, not files of their own, so transfers
  between any two accounts are atomic.
- **One *New Ledger…* command creates both.** Its dialog has a *Parent
  ledger* field:
  - with a parent, it creates a sub-ledger inside the open ledger, and no
    file is created;
  - with no parent, it asks to close the open ledger, then creates a new
    ledger file.
- **Each account has a transaction manager** that owns its transactions:
  date, internal id, number, amount, payee, category, memo and a clearing
  status (uncleared, electronically cleared, cleared or reconciled), plus a
  separate *voided* flag.
- **Two plugins, split along the rule the repository already follows**
  (storage knows nothing about the domain):
  - `ledger`: the ledger tree (the file and its sub-ledgers), domain-free.
    Sub-ledgers are named containers and know nothing about money. It
    provides `ledger.session` and contributes the File menu items and the
    New Ledger dialog.
  - `accounts`: accounts, transactions, payees, categories, the navigator,
    the register and the Accounts menu. It provides `accounts.service`.
- **The register** shows one transaction per line. Selecting a row and
  pressing Enter turns it into an inline editor, and a blank entry row at the
  bottom adds new transactions, as in Money. Balances follow Money's
  conventions: what you owe is shown as a negative balance, in red.
- **Reconciliation is an extension point**, `accounts.reconcile.actions`.
  Contributions add account-level options (the register's *Reconcile* menu)
  and transaction-level options (a row's context menu). The reconcile
  *reconciliation* itself (the statement's figures, the marks, the
  difference, completing) belongs to `accounts`, so every reconciler shares
  the same bookkeeping. The built-in "Reconcile with Statement…" is
  contributed through the same point.
- **Removing a ledger sends its file to the OS trash** (Recycle Bin), where
  it can be recovered.
- **Framework prerequisites are small and generic**: a `shell.files` service
  (file dialogs, trash), a `shell.prompts` service (confirmations), a
  `shell.dialogs` extension point for modal dialogs that plugins supply, a
  few more `@tessera/ui` components, and SQLite as the default
  `storage.engine`.

---

## Naming

"Chart of accounts" is accurate accounting vocabulary but long for a menu
("Open Chart of Accounts…"), and "vault" is not to be used. **Decided:**

| Concept | User-facing name | Code name | Notes |
|---|---|---|---|
| The file, and the root of the tree | **Ledger** | `ledger`, `LedgerInfo` | *New Ledger…, Open Ledger…, Close Ledger, Delete Ledger…* |
| A container inside a ledger | **Sub-ledger** | `subLedger`, `SubLedger` | Created with *New Ledger…* and a parent. Accounting uses "subsidiary ledger" for a ledger that holds the detail of a set of accounts, which is the same idea |
| A financial-institution account | **Account** | `account`, `Account` | |
| The list of an account's transactions | **Register** | `register` | Money's and Quicken's term |
| The tree as a whole | **Chart of accounts** | `chart` | Used in prose, not in menus |

Alternatives considered for the file:

| Name | Verdict |
|---|---|
| **Ledger** | **Chosen.** Short, singular, financial, and reads well in every menu item. In accounting a ledger holds accounts and their entries, which is exactly what the file holds. |
| Books | Plural makes labels awkward, and "close the books" already means period-end closing, which would confuse *Close Books*. |
| Chart of Accounts | Accurate, but long, and it names the tree rather than the file that also holds payees, categories and, later, budgets. |
| Household | Friendly, but assumes a family and excludes a sole proprietor's business ledger. |
| Finance file / Workspace | Bland; "workspace" suggests developer tools. |

For the container, *Account group* and *Folder* were considered. *Sub-ledger*
was chosen because it makes the container the same kind of thing as the
file, one level down, which is why one *New Ledger…* command can create
either.

The file extension is **`.tessera`**, as Money's was `.mny`. (`.ledger` is
avoided because ledger-cli uses it for plain-text journals.)

These names become ids (plugin `ledger`, context key `ledger.isOpen`,
command `ledger.open`, type `SubLedger`) that other plugins depend on. Labels
alone can change at any time.

---

## Context: what the framework gives us, and what it lacks

What exists and this design relies on:

| Facility | Used for |
|---|---|
| `storage.engine` with `open({ path }, { schema })`, declared indexes, `transaction()`, `aggregate()`, `meta` ([tessera-types/storage.ts](../tessera-types/storage.ts)) | The ledger file. Opening with `schema` creates the declared collections and indexes, rejects undeclared names, and keeps other existing collections readable |
| Services with `requires` ordering | `accounts` requires `ledger.session`; reconcilers and importers require `accounts.service` |
| Commands with `enablement` over context keys | Greying out menu items while no ledger is open, or nothing is selected |
| `shell.menus`, `shell.views` (with `when`), `shell.bar.items`, `shell.layout.reveal` | File and Accounts menus, the navigator in the left bar, the register in the main area |
| `context.events.emit` → `window.api.on` and `shell:commands.execute` | Pushing changes to views; views running commands with arguments |
| `app.state` | The recent-ledgers list and the last-opened ledger |
| `lifecycle.onStarted` / `onShuttingDown` | Reopening the last ledger; closing it cleanly on quit |

Gaps that affect this feature, and how the design handles each:

| Gap | Handling |
|---|---|
| No file dialogs or confirmations for plugins (the planned `shell.files` doesn't exist) | **Prerequisite:** `shell.files` and `shell.prompts` services |
| A command (main process) can't open a form in the window; plugin views are mounted only while shown | **Prerequisite:** `shell.dialogs` extension point and a renderer dialog host, the theme chooser's pattern made generic |
| Menu items can't be hidden, relabelled or checked, and a click passes no arguments | Paired items (*Close Account* / *Reopen Account*), greyed by enablement. Commands act on the **current selection**, held in the privileged half, and take an optional argument when run from a view |
| Plugins may import only `@tessera/*`, so a reconciler can't import `accounts`' types | The two plugins publish their contracts as packages: `@tessera/ledger-api`, `@tessera/accounts-api` (like `@tessera/storage-kit`) |
| Context keys aren't available in plugin views | Views get their state over the plugin's own IPC and events, as `test-layout` does |
| No declared extension points | `accounts` validates `accounts.reconcile.actions` contributions itself and logs `[accounts]` warnings, as the shell does for menus |
| Only one view is shown in the main area, with no tabs | The register is one main view that shows the *current* account, and a navigator in the left bar switches it |

---

## Goals and non-goals

**Goals**

- Create, open, close and delete ledgers from the File menu, and reopen the
  last ledger at start-up.
- Build a chart of accounts: create, edit, move, close, reopen and delete
  accounts, and organise them in sub-ledgers nested to any depth, created
  with the same *New Ledger…* command as a ledger.
- Keep every account's transactions with the fields Money has: date, number,
  amount, payee, category, memo, and cleared / electronically cleared /
  reconciled / void.
- Transfers between accounts that stay consistent on both sides.
- A fast, keyboard-driven register: single-line display, inline editing, a
  new-entry row.
- A reconciliation extension point, with one built-in reconciler.
- No data loss: every change is committed when the user leaves the row, and
  nothing implicit deletes user data.

**Non-goals for this feature** (each has a place in the model; see
[Phases](#phases))

- Split transactions (the document reserves `splits`), and a category
  manager beyond creating categories inline.
- Investment holdings, securities, prices and lots. Investment and retirement
  accounts are cash registers for now.
- Loan amortisation schedules; mortgages are liability registers.
- Statement import (OFX, QIF, CSV): `accounts.importers` from vault-design.md,
  later.
- Several ledgers open at once, and several windows with separate
  selections.
- Currency conversion. Each account has a currency; totals are per currency.
- Encrypting ledger files. Not needed for the first release; account numbers
  are stored as entered and masked on screen.
- Renaming a ledger file from inside the app (its name is the file name).
  Sub-ledgers can be renamed.
- Undo.

---

## Decisions

| # | Decision | Why |
|---|---|---|
| 1 | **The ledger file is the root container; sub-ledgers are records inside it**, not separate files | Transfers between accounts must be atomic, and the storage design makes databases independent (no cross-database transactions or `$lookup`). One file is also what Money users expect |
| 1a | **One *New Ledger…* command creates a ledger or a sub-ledger**, chosen by its *Parent ledger* field. No parent means a new file, after asking to close the open ledger | Decided in review: a sub-ledger is a ledger one level down, so one command and one dialog cover both |
| 2 | **`ledger` owns the ledger tree and is domain-free; `accounts` owns the domain** | The rule vault-design.md established. Sub-ledgers belong to `ledger` because *New Ledger…* creates them, and they are named containers with no financial meaning. Budgets and reports can later place their own items in sub-ledgers, and store their own collections in the same file through `ledger.schema`, without touching `ledger` |
| 3 | **One ledger open at a time.** Opening another closes the current one | As in Money. Menus, context keys and the register all assume one current ledger |
| 4 | **Write-through semantics: there is no Save command** | Money saves as you go. With SQLite as the default engine each committed change is durable when it returns; the ledger has no dirty state |
| 4a | **SQLite is the default `storage.engine`** | Decided in review. Write-through durability for financial data, and every ledger file is a SQLite database. Loki stays bundled and can still be chosen in the bootstrap file |
| 5 | **Money as integer minor units, signed from the account's point of view**: positive raises the account's balance | Storage convention already agreed. One rule for every account type; column labels differ by type, the arithmetic never does |
| 6 | **Clearing status and void are separate fields** | Voiding must not lose clearing history, un-voiding must restore it, and balances exclude voids regardless of status. The register still shows one status letter, as Money does |
| 7 | **Transfers are two linked transactions**, one per account, written in one storage transaction | Each side is cleared and reconciled independently against its own statement |
| 8 | **The service is the integrity boundary.** Every rule is enforced in `accounts.service`, not only in the UI | Reconcilers, importers and reports write through the service, not through collections |
| 9 | **Deleting never cascades silently into other accounts' balances** | Deleting an account unlinks the other side of its transfers rather than deleting them; deleting a sub-ledger moves its accounts and sub-ledgers up to its parent |
| 10 | **Changes to reconciled transactions need explicit confirmation**, enforced by the service | Protects the reconciled balance, which the next statement starts from |
| 11 | **Reconciliation bookkeeping belongs to `accounts`; reconcilers contribute the way in and their own UI** | Every reconciler then finishes the same way (status updates, the last-reconciled balance, history) |
| 12 | **Closing an account makes it read-only and hides it by default**; deleting removes it | "Close" here is the banking sense (the account was closed at the bank). History must stay for reports |
| 13 | **Removing (deleting) a ledger sends the file to the OS trash**, never unlinks it | Decided in review. A deleted ledger can be recovered from the Recycle Bin |
| 14 | **Balances are displayed the Microsoft Money way**: signed as stored, so liabilities (what you owe) show as negative balances, and negative balances are shown in red | Decided in review. It matches Money, and net worth is simply the sum |

---

## Components

```
  shell (built in)
   provides  shell.files      showOpenDialog, showSaveDialog, exists, trash
             shell.prompts    confirm, message, show(dialogId, input)
   owns      shell.dialogs    modal dialogs whose component a plugin supplies
                │
                │ requires
  ┌─────────────▼──────────────────┐      requires      ┌──────────────────────┐
  │ ledger                          │───────────────────►│ storage.engine        │
  │  provides ledger.session        │                    │ (storage-sqlite by    │
  │  owns     ledger.schema         │◄── app.state ──────│  default)             │
  │  ledger tree (sub-ledgers)      │                    └──────────────────────┘
  │  File menu, New Ledger dialog,  │
  │  start view                     │
  └─────────────▲──────────────────┘
                │ requires ledger.session; contributes to ledger.schema
  ┌─────────────┴──────────────────┐
  │ accounts                        │
  │  provides accounts.service      │
  │  owns     accounts.reconcile.actions
  │  Accounts menu, navigator, register, dialogs
  └─────────────▲──────────────────┘
                │ requires accounts.service; contributes reconcile actions
  ┌─────────────┴──────────────────┐
  │ future: reconcilers, importers, │
  │ budgets, reports                │
  └─────────────────────────────────┘
```

| Component | Kind | Provides | Requires | Owns (extension points) |
|---|---|---|---|---|
| shell | built in | `shell.files`, `shell.prompts` | | `shell.dialogs` |
| `ledger` | bundled plugin | `ledger.session` (file session and ledger tree) | `storage.engine`, `app.state`, `shell.files`, `shell.prompts` | `ledger.schema` |
| `accounts` | bundled plugin | `accounts.service` | `ledger.session`, `shell.prompts` | `accounts.reconcile.actions` |
| `@tessera/ledger-api` | package (types, constants) | | `@tessera/types` | |
| `@tessera/accounts-api` | package (types, constants, money helpers) | | `@tessera/types` | |

The API packages exist because plugins can't import one another. They hold
each plugin's published contract: service interfaces, document types, IPC
channel names, context-key names and pure helpers. They contain no
behaviour that touches storage or Electron.

---

## The ledger

### Storage format and durability

A ledger is one database opened through `storage.engine` with
`{ path }`. Its `meta` marks it as a ledger:

| Meta key | Value |
|---|---|
| `ledger.format` | `1`, the ledger's own format version. A file without it is not a ledger |
| `ledger.createdAt` | ISO timestamp |
| `ledger.createdWith` | Application version |
| `ledger.schema.<contributor>` | Schema version of each `ledger.schema` contributor, such as `ledger.schema.accounts` = `1` |

**SQLite is the default engine** (decided in review). It is write-through:
each change is durable when the write returns, so there is no window in
which a crash loses the last edit. Every ledger file is therefore a SQLite
database. How the default is set:

- Both storage plugins stay bundled. The shell adds a **built-in
  preference** for `storage-sqlite` *after* the user's own `preferredPlugins`
  in the tier-0 bootstrap file. With no bootstrap file, SQLite wins the
  `storage.engine` contest; a user who lists `storage-loki` still gets Loki.
  The bootstrap file stays the single place that chooses, as
  [storage-engine-redesign.md](storage-engine-redesign.md#configuration-tiers)
  intends.
- The application's own `app` database moves with it (`app.sqlite` instead
  of `app.loki.json`). Window positions, theme and layout start fresh once;
  the old file is left in place and ignored, as was done when the storage
  engine was redesigned. No ledgers exist yet, so nothing else migrates.

The file format still follows the active engine, so a ledger can't be opened
by a user who has switched their engine to Loki. `ledger` sniffs the file's
first bytes (`SQLite format 3\0` versus JSON) and reports "This ledger is a
SQLite file, but the active storage engine is LokiJS" rather than a raw IO
error.

Choosing the format per file (vault-design.md's `vault.backends`, here
`ledger.formats`) is deferred to a later phase. **It needs a change the
storage notes don't mention.** A plugin that provides a contested service is
*skipped entirely* ([core/plugins/activationPlan.ts](../core/plugins/activationPlan.ts)),
so a storage plugin cannot both lose the `storage.engine` contest and offer a
per-file backend. The likely fix is to move each driver into a package
(`packages/storage-sqlite`) so that a separate small plugin can offer it as a
ledger format.

### The ledger tree: sub-ledgers

The ledger is the root of a tree. Its sub-ledgers are records in the
ledger's own collection, `ledger.subledgers`. This collection is part of the
ledger format (`ledger.format`), not a `ledger.schema` contribution.

```ts
// @tessera/ledger-api
export interface SubLedger {
  id: string
  /** The containing sub-ledger, or null when it sits directly in the ledger. */
  parentId: string | null
  name: string
  order: number
  notes?: string
  /** The storage revision, sent back as `expectedRev`. Every document read from the service carries one. */
  rev: number
}

export interface LedgerTree {
  ledger: LedgerInfo
  /** Every sub-ledger, in no particular order; build the tree from parentId and order. */
  subLedgers: SubLedger[]
}
```

- Names are unique among siblings, ignoring case (a `nameKey` field, the
  trimmed lower-cased name, carries a unique index on `[parentId, nameKey]`).
  Top-level sub-ledgers store `parentId: null` explicitly. The engine's
  unique indexes are sparse on *missing* fields but treat a present `null`
  as a value, which is what root-level uniqueness needs.
- Sub-ledgers nest to any depth. Moving one into itself or a descendant is
  rejected with `CYCLE`.
- **Deleting a sub-ledger never deletes what is in it.** Its accounts and
  sub-ledgers move to its parent, after the parent's existing children, in
  one storage transaction. A moved sub-ledger whose name clashes gets a
  suffix, " (2)", and the confirmation says so. Nothing is lost, so there is
  nothing to send to the trash.
- `ledger` knows nothing about what other plugins keep in a sub-ledger.
  Plugins that place items in sub-ledgers register as **participants**, and
  `ledger` calls them inside the deleting transaction (see below).
  `accounts` is the first participant; budgets could be one later.

### `ledger.session` (service)

```ts
// @tessera/ledger-api
export interface LedgerInfo {
  path: string
  /** The file name without `.tessera`; shown in the title and the start view. */
  name: string
  readOnly: boolean
}

export type LedgerChange =
  | { type: 'opened', ledger: LedgerInfo, created: boolean }
  | { type: 'closed', ledger: LedgerInfo }

/** Where a new ledger goes: a new file, or a sub-ledger of the open ledger (parentId null = its root). */
export type NewLedgerTarget = { kind: 'file' } | { kind: 'subLedger', parentId: string | null }

export interface LedgerSession {
  readonly current: LedgerInfo | undefined

  /**
   * The open ledger's database, limited to collections named `<contributor>.*`: any other name is
   * rejected, so a plugin can't read or write another plugin's data by accident. Throws NO_LEDGER
   * when none is open.
   */
  database(contributor: string): Database

  // ---- Files
  /**
   * Creates a ledger file. Asks to close the open ledger first, and prompts for a location when `path`
   * is omitted, suggesting `options.name` as the file name. Resolves undefined if the user cancels.
   */
  create(path?: string, options?: { name?: string }): Promise<LedgerInfo | undefined>
  /** Prompts when `path` is omitted. Closes the current ledger first. */
  open(path?: string): Promise<LedgerInfo | undefined>
  close(): Promise<void>
  /** Confirms, closes the ledger if it is the one open, and sends the file to the OS trash. */
  delete(path?: string): Promise<boolean>

  // ---- The tree of the open ledger
  tree(): Promise<LedgerTree>
  createSubLedger(input: { name: string, parentId: string | null }): Promise<SubLedger>
  renameSubLedger(id: string, name: string, options?: { expectedRev?: number }): Promise<SubLedger>
  /** `to` is a sub-ledger id, or null for the ledger itself. */
  moveSubLedger(id: string, to: string | null, index?: number): Promise<void>
  /** Moves the sub-ledger's contents to its parent (participants included), then deletes it. */
  deleteSubLedger(id: string): Promise<void>

  /** A plugin that places items in sub-ledgers. Dispose to stop participating. */
  participate(contributor: string, participant: SubLedgerParticipant): Disposable

  /** Runs, awaited, before the database closes, while it is still writable. */
  onWillClose(listener: (ledger: LedgerInfo) => void | Promise<void>): Disposable
  readonly onDidChange: Event<LedgerChange>
  /** After any sub-ledger is created, renamed, moved or deleted. */
  readonly onDidChangeTree: Event<LedgerTree>
}

export interface SubLedgerParticipant {
  /** For the delete confirmation: what this plugin keeps directly in the sub-ledger, e.g. "4 accounts". */
  describe(subLedgerId: string): Promise<string | undefined>
  /**
   * Inside the deleting transaction: move everything kept directly in `from` to `to` (null = the ledger
   * itself). `tx` is scoped to the participant's own collections. Throwing rolls the whole delete back.
   */
  reparent(tx: Transaction, from: string, to: string | null): Promise<void>
}
```

Errors are `LedgerError`s with a code, as in `accounts` (see [Errors across IPC](#errors-across-ipc)):
`NO_LEDGER`, `READ_ONLY`, `NOT_FOUND`, `DUPLICATE_NAME`, `CYCLE`, `INVALID` (with the `field`),
`CONFLICT`, `UNSUPPORTED_FILE`, `FILE_NOT_FOUND` and `MIGRATION_FAILED`. Each plugin bundles its own copy
of `@tessera/ledger-api`, so `instanceof` fails across plugins: `isLedgerError(err)` checks the shape
instead, and `toResult(work)` turns one into a `Result` for a view. The package also holds the name
rules (`validateLedgerName`, `nameKey`, `uniqueName`) and tree helpers (`childrenOf`, `flattenTree`,
`descendantIds`, `pathOf`), so the session, the dialogs and the accounts navigator apply the same rules.

### `ledger.schema` (extension point)

Domain plugins declare what they store. `ledger` opens every ledger with the
union of these collections (plus its own `ledger.subledgers`) and runs
migrations.

```ts
export interface SchemaContribution {
  /** The contributing plugin id. Every collection name must start with `<id>.`. */
  id: string
  /** The contributor's current schema version, ≥ 1. */
  version: number
  collections: CollectionSchema[]   // from @tessera/types: { name, indexes }
  /** Service id implementing Migrator. */
  migrator: string
}

export interface Migrator {
  /**
   * Brings this contributor's data from `from` to `from + 1`. `from === 0` means the contributor has no
   * data in this ledger yet: a new ledger, or a plugin installed after the ledger was created. It seeds
   * defaults (accounts seeds its starter categories). Must be safe to re-run after a crash.
   */
  migrate(db: Database, from: number): Promise<void>
}
```

Treating "new" as migration from 0 gives one code path for new ledgers and
for plugins added later. Contributions whose collections don't carry the
contributor's prefix are rejected with a warning.

`ledger` can't list migrators in `services.requires`: `accounts` already
requires `ledger.session`, so that would be a cycle. It looks migrators up
with `services.get` when a ledger opens. That is always after every plugin has
activated: a command, or `onStarted` for the reopen at start-up. A
contribution whose migrator service is missing makes the open fail with a
message naming the plugin, rather than leaving half-migrated data.

### Flows

**New Ledger…** (`ledger.new`, optional argument `{ parentId: string | null }`)

One command creates either a ledger file or a sub-ledger, as decided in
review.

- **No ledger is open:** there is nothing to be a parent, so it goes
  straight to creating a file (below).
- **A ledger is open:** it shows the **New Ledger** dialog
  (`ledger.dialog.new`, a `shell.dialogs` contribution). Here it was opened
  from *New Sub-Ledger…* with the ledger itself selected:

  ```
  ┌ New Ledger ──────────────────────────────────────────┐
  │ Name           [ Business                          ] │
  │ Parent ledger  [ Home Finances                   ▾ ] │
  │                   None (create a new ledger file)    │
  │                   Home Finances                      │
  │                     Personal                         │
  │                     Rentals                          │
  │                                   [Create] [Cancel]  │
  └──────────────────────────────────────────────────────┘
  ```

  The parent defaults to the `parentId` argument when one is given: the
  navigator and the Accounts menu's *New Sub-Ledger…* pass the selection.
  Otherwise, as from File › New Ledger…, it defaults to **None**.
  - **With a parent:** `createSubLedger({ name, parentId })`. No file is
    created, nothing closes, and the new sub-ledger is selected. A duplicate
    name is shown on the Name field, and the dialog stays open.
  - **None:** `create()`, below, with the name as the suggested file name.

**Creating a ledger file** (`create`)

1. If a ledger is open, confirm through `shell.prompts.confirm`:
   "Close “Home Finances” and create a new ledger?", detailed with
   "Everything in “Home Finances” is already saved." The buttons are *Close
   and Create* and *Cancel*, and Cancel stops here.
2. `shell.files.showSaveDialog` with the filter `Tessera ledger (*.tessera)`,
   suggesting `<name>.tessera` (or `My Finances.tessera`) in the open
   ledger's folder or in Documents. The native dialog asks about replacing
   an existing file. If the user accepts, that file is sent to the trash
   first. The ledger's name is the file name the user finally chose.
3. Close the current ledger, if any.
4. `engine.open({ path }, { schema })`, then set the `ledger.*` meta keys.
5. Run every contributor's migrator from 0, then record its version.
6. Set context keys, add the ledger to the recent list, fire `opened` with
   `created: true`. `accounts` reveals its home view.

**Open Ledger…** (`ledger.open`, `CmdOrCtrl+O`)

1. `shell.files.showOpenDialog`. If the chosen path is the open ledger, do
   nothing.
2. **Check before writing anything.** The file must exist: both engines
   *create* a missing file on open. Then sniff its header and open it
   **read-only** to read `ledger.format`. A read-write open would let the
   SQLite driver add its tables to any SQLite file the user picked. Close the
   probe before reopening: the engine caches open databases by path, not by
   options.
3. Compare each contributor's version in the file with its plugin's version:
   - **file is newer:** refuse ("saved by a newer version of Accounts");
   - **file is older:** copy the file to `<name>.backup-<date>.tessera`,
     then migrate;
   - **contributor missing** (its plugin isn't installed): leave its
     collections untouched.
4. Close the current ledger, open read-write with the schema, migrate, and
   then proceed as step 6 of creating a file.

**Close Ledger** (`ledger.close`): run `onWillClose` listeners, flush, close
the database, clear context keys, and fire `closed`. The start view
reappears, because its `when` is `!ledger.isOpen`.

**Delete Ledger…** (`ledger.delete`): *remove* means **send to the trash**,
as decided in review. The command is enabled while a ledger is open and acts
on that ledger, so the user sees what they are deleting. It confirms through
`shell.prompts.confirm`: "Move “Home Finances” to the Recycle Bin?" (or
"Trash" on macOS and Linux), detailed with "All of its sub-ledgers, accounts
and transactions go with it. You can restore the file from the Recycle Bin."
It then closes the ledger, sends the file (and any `-wal`/`-shm` side files)
to the trash, and removes it from the recent list. The start view offers the
same for a recent ledger that isn't open.

**Sub-ledger commands.** These take the sub-ledger's id as an argument, so
any view can offer them. The Accounts menu and the navigator pass the
selection (see [Selection and commands](#selection-and-commands)).

- `ledger.subLedger.rename { id }`: a small dialog (`ledger.dialog.rename`);
  a duplicate name is shown inline.
- `ledger.subLedger.delete { id }`: collects each participant's `describe`,
  and the count of child sub-ledgers, for the confirmation: "Delete
  sub-ledger “Business”? Its 2 sub-ledgers and 4 accounts will move to “Home
  Finances”. No transactions are deleted." Then one storage transaction:
  every participant's `reparent`, then the child sub-ledgers move (with
  suffixes on clashes), then the record is deleted. A participant that
  throws rolls the whole delete back.
- Moving is a session method (`moveSubLedger`). The UI for it is the
  navigator's *Move To…*, which also moves accounts.

**Start-up:** in `onStarted`, reopen `ledger.last` from `app.state` if the
file still exists. A failure is logged and shown in the start view; it is
never a modal at start-up.

**Quit:** `onShuttingDown` closes the ledger. `ledger` requires
`storage.engine`, so it deactivates before the storage plugin closes its
databases.

### Commands, menu and context keys

| Command | Menu (File) | Accelerator | Enablement |
|---|---|---|---|
| `ledger.new` | New Ledger… | | `!ledger.isReadOnly` |
| `ledger.open` | Open Ledger… | `CmdOrCtrl+O` | |
| `ledger.close` | Close Ledger | | `ledger.isOpen` |
| `ledger.delete` | Delete Ledger… (own group) | | `ledger.isOpen && !ledger.isReadOnly` |
| `ledger.subLedger.rename` | (argument `{ id }`; run from the Accounts menu and the navigator) | | `ledger.isOpen && !ledger.isReadOnly` |
| `ledger.subLedger.delete` | (argument `{ id }`; run from the Accounts menu and the navigator) | | `ledger.isOpen && !ledger.isReadOnly` |

```
File
├── New Ledger…
├── Open Ledger…          Ctrl+O
├── Close Ledger
├── ───────────
├── Delete Ledger…
├── ───────────
└── Exit
```

| Context key | Meaning |
|---|---|
| `ledger.isOpen` | A ledger is open |
| `ledger.isReadOnly` | Opened read-only (reserved for file locks, later) |
| `ledger.name` | Display name of the open ledger, usable in status text (`{ledger.name}`) |

A **start view** (`ledger.start`, `shell.main`, `when: '!ledger.isOpen'`)
offers *New Ledger* and *Open Ledger* and lists recent ledgers. Each entry
can be opened, removed from the list, or deleted (sent to the trash), and
missing files are marked "not found". Menus are built once, so an *Open
Recent* submenu can't list files; the start view stands in for it. A
status-bar text item shows `{ledger.name}`.

A **Ledger panel** (`ledger.tree`, `shell.left`) shows the open ledger and
its sub-ledgers as a tree, with buttons and keys for *New Sub-Ledger*
(Insert), *Rename* (F2) and *Delete* (Delete), all run through the commands
above. A plugin whose own view shows the tree, such as the accounts
navigator with accounts in it, calls `ledger.session.registerNavigator(id)`.
While any registration is held, the ledger sets its own key
`ledger.hasNavigator` and the panel hides (`when: 'ledger.isOpen &&
!ledger.hasNavigator'`). The registration is disposed with its plugin, so if
that plugin goes away the panel comes back. The ledger stays domain-free: it
never names the plugin that replaced it.

---

## The chart of accounts

The chart is the ledger tree from `ledger.session.tree()` with `accounts`'
accounts placed in it: each account sits directly in the ledger or in one
sub-ledger. A sub-ledger's total is the sum of the current balances of every
account beneath it, **per currency**.

`accounts` registers as a [sub-ledger participant](#the-ledger-tree-sub-ledgers):

- `describe(id)` returns "4 accounts" (counting closed ones);
- `reparent(tx, from, to)` moves those accounts to `to`, appending them after
  its existing accounts.

Account names are unique in the whole ledger, so moving accounts never
clashes.

### Accounts

```ts
export type AccountType =
  | 'chequing' | 'savings' | 'cash'
  | 'creditCard' | 'lineOfCredit'
  | 'loan' | 'mortgage'
  | 'investment' | 'retirement'
  | 'otherAsset' | 'otherLiability'

export type AccountClass = 'asset' | 'liability'

export interface Account {
  id: string
  /** The sub-ledger holding the account, or null when it sits directly in the ledger. */
  subLedgerId: string | null
  name: string                 // unique in the ledger, ignoring case
  type: AccountType
  currency: string             // ISO 4217, e.g. 'CAD'
  institution?: string
  /** As entered, unencrypted (ledger encryption is not in the first release); shown masked (•••• 1234). */
  accountNumber?: string
  openingDate: string          // 'YYYY-MM-DD'
  openingBalance: number       // minor units
  creditLimit?: number         // minor units; credit cards and lines of credit
  minimumBalance?: number      // minor units; asset accounts: the balance the bank requires it to keep
  showAvailableBalance?: boolean  // show the balance above the minimum instead of the actual one
  closed: boolean
  closedOn?: string
  order: number
  notes?: string
  lastReconciled?: { date: string, balance: number, reconciliationId: string }
}
```

| Type | Class | Register columns (decrease / increase) |
|---|---|---|
| Chequing, Savings, Cash | asset | Payment / Deposit |
| Investment, Retirement (cash only for now) | asset | Withdrawal / Deposit |
| Other asset | asset | Decrease / Increase |
| Credit card, Line of credit | liability | Charge / Payment |
| Loan, Mortgage, Other liability | liability | Increase / Payment |

Amounts use one rule for every type: **positive raises the balance**. Only
the column labels depend on the type. Check the labels against Money Plus's
registers during phase 4, and prefer Money's wording where it differs.

**Balances are displayed the Microsoft Money way** (decided in review):

- A balance is shown **signed, as stored**. Liabilities (credit cards,
  lines of credit, loans, mortgages) normally have **negative** balances:
  a credit card on which 540.00 is owed shows **-540.00**.
- **Negative balances are shown in red**, using the theme's `error.main`
  token, never a literal colour, so that it works in both light and dark
  themes. This applies in the register's Balance column, the navigator, the
  home view and totals.
- Sub-ledger and ledger totals are plain sums, so **net worth** is assets
  plus (negative) liabilities with no special cases.
- Amounts *in a transaction's columns* are always shown unsigned, as in
  Money: a 100.00 withdrawal shows as 100.00 in the Payment column.

Other rules:

- **Account names are unique in the whole ledger** (transfers are shown as
  "Transfer: Savings", so names must be unambiguous).
- **Currency** can change only while the account has no transactions
  (enforced once transactions exist).
- **Type** can change freely; the stored amounts keep their meaning.
- **Minimum balance** (decided in review): some bank accounts must keep a
  minimum. An asset account can record it (`minimumBalance`, zero or more),
  and `showAvailableBalance` chooses which balance the navigator shows: the
  actual balance, or the balance above the minimum (`available = current −
  minimumBalance`, marked "avail." and explained in the tooltip). The
  register follows the same flag: its running balance column, headed
  *Available*, shows each row's balance above the minimum, including the
  opening row. Its header always shows both figures. Each `RegisterRow`
  carries `balance` and `available`, and `showsAvailable` /
  `shownRunningBalance` in `@tessera/accounts-api` make the choice, so every
  view agrees. **Totals always add actual
  balances**, so net worth stays true whatever each account shows. An
  available balance below zero shows red, like any negative balance: the
  account is under its minimum. Changing the type to one without a minimum
  (a liability) drops both fields, and the flag can't be set without a
  minimum.
- **Opening balance** is a field, not a transaction. The register shows it as
  a fixed first row, and the reconciled balance starts from it. For a
  liability it is entered as the amount owed and stored negative.
- **Close Account** sets `closed` and `closedOn`. A closed account is
  read-only: no new transactions, no edits, and transfers into it are
  refused. It is hidden in the navigator unless *Show closed accounts* is on,
  and it still counts in totals. Closing with a non-zero balance needs
  confirmation. **Reopen Account** reverses it.
- **Delete Account** removes the account and its transactions after a
  confirmation that states how many. It deletes records inside the ledger,
  so there is no trash; the confirmation says it can't be undone. The other
  side of each transfer is **kept and unlinked**: it loses its transfer link
  and category, keeps its status, and gets the memo note "(transfer with
  deleted account 'Savings')". Other accounts' balances don't change.

### Selection and commands

Menu clicks pass no arguments, so `accounts` keeps a **selection** in its
privileged half. The navigator reports it over IPC, and it is published as
context keys. The selection can be the ledger itself, a sub-ledger or an
account. Every command also takes an optional `{ id }` argument naming the
item. Enablement still follows the selection, so the menu greys out to match,
and the navigator selects a row (on click or right-click) before running a
command on it. Commands are user actions: other plugins change accounts
through `accounts.service`, not through commands.

The sub-ledger items are thin `accounts` commands. They turn the selection
into arguments for `ledger`'s commands, because the selection belongs to the
navigator and `ledger` knows nothing about it. *New Sub-Ledger…* therefore
opens **the same New Ledger dialog** as File › New Ledger…, with the parent
already chosen.

| Command | Menu (Accounts) | Runs | Enablement |
|---|---|---|---|
| `accounts.account.new` | New Account… | account dialog, in the selected (sub-)ledger or beside the selected account | `ledger.isOpen && !ledger.isReadOnly` |
| `accounts.account.edit` | Edit Account… | account dialog | `accounts.selection.kind == 'account'` |
| `accounts.account.close` | Close Account… | | `accounts.selection.kind == 'account' && !accounts.selection.isClosed` |
| `accounts.account.reopen` | Reopen Account | | `accounts.selection.kind == 'account' && accounts.selection.isClosed` |
| `accounts.account.delete` | Delete Account… | | `accounts.selection.kind == 'account'` |
| `accounts.subLedger.new` | New Sub-Ledger… | `ledger.new { parentId }`, parent = the selected sub-ledger, the selected account's sub-ledger, or null for the ledger | `ledger.isOpen && !ledger.isReadOnly` |
| `accounts.subLedger.rename` | Rename Sub-Ledger… | `ledger.subLedger.rename { id }` | `accounts.selection.kind == 'subLedger'` |
| `accounts.subLedger.delete` | Delete Sub-Ledger… | `ledger.subLedger.delete { id }` | `accounts.selection.kind == 'subLedger'` |
| `accounts.move` | Move To… | move dialog; accounts through `accounts.service`, sub-ledgers through `ledger.session.moveSubLedger` | `accounts.selection.kind == 'account' \|\| accounts.selection.kind == 'subLedger'` |
| `accounts.transaction.new` | New Transaction (`CmdOrCtrl+N`) | event to the register | `accounts.register.editable` |
| `accounts.open` | (View) Accounts | reveals the home view | `ledger.isOpen` |
| `accounts.register.show` | | argument: account id | `ledger.isOpen` |

Edit commands also check `!ledger.isReadOnly`; the table omits it for
brevity.

```
Accounts
├── New Account…
├── Edit Account…
├── Close Account…
├── Reopen Account
├── Delete Account…
├── ───────────
├── New Sub-Ledger…
├── Rename Sub-Ledger…
├── Delete Sub-Ledger…
├── ───────────
├── Move To…
├── ───────────
└── New Transaction       Ctrl+N
```

**Accelerators avoid bare keys.** A menu accelerator such as `Delete` would
fire while the user edits text in the register. Row keys (`Delete`, `Space`,
`Enter`) are handled inside the register view.

| Context key | Meaning |
|---|---|
| `accounts.selection.kind` | `'ledger'`, `'subLedger'`, `'account'`, or unset |
| `accounts.selection.id` | The selected sub-ledger or account (unset for the ledger) |
| `accounts.selection.isClosed` | The selected account is closed |
| `accounts.register.account` | Id of the account the register shows |
| `accounts.register.editable` | That account is open, and the ledger writable |
| `accounts.reconciling` | Id of the register's account while it is being reconciled (not while paused) |
| `accounts.reconciler` | Id of the reconcile action that started it |

Context keys are application-wide. With one window, this is right. Several
windows with separate selections are a non-goal.

Forms are `shell.dialogs` contributions: `accounts.dialog.account` and
`accounts.dialog.move` from `accounts`, and `ledger.dialog.new` and
`ledger.dialog.rename` from `ledger`. A dialog saves through its plugin's IPC
and shows domain errors (a duplicate name) inline, so it closes only on
success and returns the new id, which the command then selects. Destructive
confirmations use the native `shell.prompts.confirm`.

---

## Transactions and the transaction manager

### The transaction document

```ts
export type ClearingStatus = 'uncleared' | 'electronic' | 'cleared' | 'reconciled'

export interface Transaction {
  /** Internal identifier: a ULID from the engine. Never shown, never reused, sorts by creation. */
  id: string
  accountId: string
  date: string                 // 'YYYY-MM-DD', a calendar date with no time zone
  /** The transaction number: a cheque number or a code such as 'ATM', 'EFT', 'DEP'. */
  number?: string
  /** Integer minor units. Positive raises this account's balance. */
  amount: number
  payeeId?: string
  /** Absent for transfers (and, later, splits). */
  categoryId?: string
  /** Set on both sides of a transfer: the shared pair id, and the other account. */
  transferId?: string
  transferAccountId?: string
  memo?: string
  status: ClearingStatus
  voided: boolean
  /** Reserved: split lines, summing to `amount` (later). */
  splits?: { amount: number, categoryId?: string, memo?: string }[]
  /** The bank line this transaction is (OFX FITID, or an importer's fingerprint); unique in the account. See import-manager-design.md. */
  externalId?: string
  createdAt: string
  updatedAt: string
}
```

The storage engine adds `rev`, which the register sends back as
`expectedRev`, so an edit made elsewhere (another view, a reconciler) is
detected as `CONFLICT` rather than overwritten.

**Number** is a string because Money accepts codes as well as cheque
numbers. A duplicate cheque number gives a warning, not an error. For a new
entry, the register suggests one more than the account's highest numeric
number.

**Payee** is a reference to `accounts.payees` (`{ id, name }`), created on
first use. Choosing a known payee in a new entry fills the category and
amount from that payee's most recent transaction, as Money does (index
`[payeeId, date]`).

**Category** is a reference to `accounts.categories`
(`{ id, parentId, name, kind: 'income' | 'expense' }`), shown as
`Parent : Child`. Typing an unknown name in the register offers to create
it. A new ledger is seeded with a short starter list by the migration from
0. A full category manager is later work.

### Clearing status and void

| Letter | Status | Set by | Counts towards the cleared balance |
|---|---|---|---|
| (blank) | `uncleared` | default | no |
| `E` | `electronic` | import or matching: the bank reported it | yes |
| `C` | `cleared` | the user (click, or `Space`), or marking during reconcile | yes |
| `R` | `reconciled` | finishing a reconciliation | yes |
| `V` | *voided* (flag) | Void | never (excluded from every balance) |

- The register shows **one letter**: `V` when voided, otherwise the status.
- **Void** keeps the amount and the clearing status. A voided row is shown
  struck through and adds nothing to any balance. **Unvoid** restores it as
  it was. Voiding one side of a transfer voids both.
- Toggling cleared cycles `uncleared ↔ cleared`. `electronic → cleared`
  confirms a downloaded transaction.
- `reconciled` is set by finishing a reconciliation. Setting it by hand, or
  leaving it, needs confirmation.

**Balances** (per account; all exclude voided transactions):

```
current    = openingBalance + Σ amount
available  = current − minimumBalance            (current when there is no minimum)
cleared    = openingBalance + Σ amount where status ∈ { electronic, cleared, reconciled }
reconciled = openingBalance + Σ amount where status = reconciled
```

These come from one `aggregate` per request: `$match` on the account (or on
every account, for the navigator), then `$group` by account and status. The
**running balance** in the register is computed in `accounts` from the
rows ordered by `date`, then `id`. The engine breaks sort ties by `id`, and
ULIDs sort by creation, so same-day transactions keep the order they were
entered.

### Transfers

A transfer is **two transactions sharing a `transferId`**, one in each
account, with opposite amounts. Both are written in one `db.transaction`.

| Action on one side | Effect on the other |
|---|---|
| Create (category "Transfer to: Savings") | Created with the opposite amount, same date, payee and memo. Its number and status are independent |
| Change amount or date | Mirrored |
| Change payee or memo | Mirrored |
| Change number or status | Not mirrored: each side is reconciled against its own statement |
| Change the category away from the transfer | The other side is deleted |
| Change the transfer to another account | The other side moves to that account (a new id in the new account) |
| Void or unvoid | Mirrored |
| Delete | Both deleted; the confirmation names the other account |

Transfers need both accounts in the same currency (`CURRENCY_MISMATCH`
otherwise), and both open.

### Rules the service enforces

| Rule | Error |
|---|---|
| No ledger open / ledger read-only | `NO_LEDGER` / `READ_ONLY` |
| The account exists and is open (not closed) | `NOT_FOUND` / `ACCOUNT_CLOSED` |
| `date` is a valid calendar date; `amount` is a safe integer within ±10¹³ | `INVALID` (with `field`) |
| Payee, category and transfer account exist | `NOT_FOUND` |
| Transfer sides are consistent (both exist, opposite amounts, same date) | Internal invariant; tests check it after every operation |
| Changing the amount, date or void state of a reconciled transaction, deleting it, or changing its status needs `confirm: ['reconciled']`. This also applies when only the *other side* of a transfer is reconciled | `CONFIRMATION_REQUIRED` (with `reasons`) |
| `expectedRev` matches | `CONFLICT` |
| Account names are unique in the ledger; the target sub-ledger of a create or move exists | `DUPLICATE_NAME` / `NOT_FOUND` |

### `accounts.service` and the transaction manager

`accounts.service` is the integrity boundary and the way other plugins (reports, importers, budgets) reach the
accounts and their transactions. Accounts, transactions and reconciliation are implemented (see
[Reconciliation and its extension point](#reconciliation-and-its-extension-point) for `reconciliation`).

```ts
// @tessera/accounts-api — implemented
export interface AccountsService {
  get(id: string): Promise<Account | undefined>
  /** In navigator order: under each node, its sub-ledgers (with their contents), then its own accounts. */
  list(filter?: AccountFilter): Promise<Account[]>
  /** The ledger tree with accounts and balances, and totals per currency (closed accounts included). */
  chart(options?: { includeClosed?: boolean }): Promise<Chart>
  /** Until transactions exist, every balance is the opening balance; the shape won't change when they do. */
  balances(id: string): Promise<AccountBalances>

  createAccount(input: AccountInput): Promise<Account>
  /** `null` clears an optional field; a new subLedgerId moves the account to the end there. ACCOUNT_CLOSED if closed. */
  updateAccount(id: string, patch: AccountPatch, options?: WriteOptions): Promise<Account>
  /** Needs confirm: ['closeWithBalance'] when the balance isn't zero. */
  closeAccount(id: string, options?: WriteOptions & { closedOn?: string }): Promise<Account>
  reopenAccount(id: string, options?: WriteOptions): Promise<Account>
  deleteAccount(id: string, options?: WriteOptions): Promise<void>
  /** `to` is a sub-ledger id, or null for the ledger itself. (Sub-ledgers move through ledger.session.) */
  moveAccount(id: string, to: string | null, index?: number): Promise<void>

  readonly onDidChange: Event<AccountsChange>
}

/** What reports and importers ask for. Every condition given must hold. */
export interface AccountFilter {
  subLedgerId?: string | null           // directly in it; null: directly in the ledger
  includeDescendants?: boolean          // …and everything beneath it
  types?: AccountType[]
  classes?: AccountClass[]              // 'asset' | 'liability'
  currency?: string
  includeClosed?: boolean               // default true: reports need closed accounts' history
  /** Ignoring spaces, dashes and case; { endsWith } for statements that show only the last digits. */
  accountNumber?: string | { endsWith: string }
  institution?: string                  // ignoring case
}

export interface AccountsChange {
  created: string[]
  updated: string[]                     // changed, moved, closed or reopened
  deleted: string[]                     // so a plugin can drop its references to them
  balances: string[]
  chart: boolean                        // anything the chart shows, including the tree and which ledger is open
}

export interface WriteOptions {
  expectedRev?: number
  confirm?: Confirmation[]              // 'closeWithBalance' now; 'reconciled' with transactions
}
```

Errors are `AccountsError`s (test with `isAccountsError`, as for the ledger) with a `code`, the `field` at fault
and, for `CONFIRMATION_REQUIRED`, the `reasons`. The package also carries what every caller needs to agree on:
the money helpers (`parseAmount`, `formatAmount`, `amountToInput`, `minorDigits`, `isCurrencyCode`; text to minor
units without floating point, in the user's locale) and the account rules (`validateAccountName`, `isIsoDate`,
`ACCOUNT_TYPE_LABELS`, `CREDIT_LIMIT_TYPES`, `maskAccountNumber`…), used by both the service and the dialogs.

**Transactions (implemented):** the service also has `transactions(accountId): TransactionManager`, `payees`
(`search(prefix)`, with what each payee was last used for) and `categories` (`list()`, `create('Parent : Child',
kind)`). `AccountsChange` also lists the accounts whose `transactions` changed and whether `categories` were
added, and the accounts whose `reconciliations` started, changed or ended:

```ts
export interface TransactionManager {
  readonly accountId: string
  list(range?: { from?: string, to?: string }): Promise<Transaction[]>
  /** Rows in display order with the running balance, plus the account's balances. */
  register(): Promise<RegisterSnapshot>
  get(id: string): Promise<Transaction | undefined>
  create(draft: TransactionDraft): Promise<Transaction>
  update(id: string, patch: TransactionPatch, options?: WriteOptions): Promise<Transaction>
  delete(ids: string[], options?: WriteOptions): Promise<void>
  setStatus(ids: string[], status: ClearingStatus, options?: WriteOptions): Promise<void>
  setVoided(ids: string[], voided: boolean, options?: WriteOptions): Promise<void>
  balances(): Promise<AccountBalances>
  /** One more than the highest numeric transaction number, if any. */
  nextNumber(): Promise<string | undefined>
}
```

`TransactionDraft` takes the user's terms: a payee *name* (created if new),
a category *id* or a transfer *account id*, and optionally a status. The
manager turns these into documents. One collection holds every
transaction; the manager is a per-account view over it. That keeps
transfers, reports and aggregates in one collection, while giving callers
the per-account object the feature calls for.

**Change notification** comes from the service, not from the database's
`onDidChange`. The service knows which accounts each write touched, while a
storage delete event carries only ids. All writes go through the service, so
nothing is missed.

### Errors across IPC

The preload keeps only an `Error`'s message, so **expected outcomes are
results, not exceptions**:

```ts
export type Result<T> =
  | { ok: true, value: T }
  | { ok: false, error: { code: AccountsErrorCode, message: string, field?: string, reasons?: Confirmation[] } }
```

`ledger` uses the same shape for its dialogs, with its own codes.

A view that receives `CONFIRMATION_REQUIRED` asks the user in the view (an
in-view `Dialog`), then resends with `confirm`. Unexpected failures are
still thrown and logged.

---

## Storage schema (`accounts`)

| Collection | Indexes |
|---|---|
| `accounts.accounts` | `bySubLedger [subLedgerId, order]`; unique `[nameKey]` |
| `accounts.transactions` | `byAccountDate [accountId, date]`; `byTransfer [transferId]`; `byPayee [payeeId, date]`; `byCategory [categoryId, date]`; unique `[accountId, externalId]` (sparse, so only imported rows) |
| `accounts.payees` | unique `[nameKey]` |
| `accounts.categories` | unique `[parentId, nameKey]` |
| `accounts.reconciliations` | `byAccount [accountId, startedAt]`; unique `[activeFor]` (set only while a reconciliation is in progress or paused, so there is at most one per account) |

Sub-ledgers themselves are in `ledger`'s `ledger.subledgers` collection (see
[The ledger tree](#the-ledger-tree-sub-ledgers)). Accounts directly in the
ledger store `subLedgerId: null` explicitly, so the `bySubLedger` index finds
them. Top-level categories store `parentId: null` for the same reason as
top-level sub-ledgers: the engine treats a present `null` as a value in
unique indexes.

**Version 1 (implemented)** declares `accounts.accounts`,
`accounts.transactions`, `accounts.payees` and `accounts.categories`.
`accounts.reconciliations` arrived with reconciliation, still in version 1:
declaring a collection or an index needs no migration, because the ledger
creates declared collections and indexes when it opens. Migration `0 → 1` seeds the starter
categories (income: Salary, Interest, Dividends…; expenses: Housing, Utilities,
Food, Transportation… with children such as Food : Groceries).

The transaction collections joined version 1 rather than a version 2 because
ledgers are expected to start fresh at this point (decided in review). A
ledger made before then opens, but has no starter categories; they can be
created from the register.

---

## The register UI

### Layout

```
┌ File  View  Accounts  Tools  Help ──────────────────────────────────────────────────────────────────────────────────────────┐
│ ACCOUNTS (left bar)        │ Chequing · TD Bank                                                 [+ New]  [Reconcile ▾]      │
│ ▾ Home Finances            │  St Num  Date        Payee            Category            Payment   Deposit     Balance        │
│   ▾ Personal     12,700.00 │          2026-10-01  Opening balance                                           1,000.00        │
│     Chequing      2,700.00 │  R  101  2026-10-02  Landlord         Housing : Rent     1,200.00               -200.00        │
│     Savings      10,000.00 │  C  ATM  2026-10-05  Cash withdrawal  Cash                 100.00               -300.00        │
│   ▾ Credit cards   -540.00 │  E       2026-10-06  Employer         Salary                       3,000.00    2,700.00        │
│     Visa           -540.00 │  V  102  2026-10-07  Hydro One        Utilities             80.00              2,700.00        │
│   ▸ Business      5,000.00 │ ┌────────────────────────────────────────────────────────────────────────────────────────────┐ │
│   ▾ Loans      -250,000.00 │ │ [ ] [103 ] [2026-10-08] [Payee        ▾] [Category       ▾] [        ] [        ]          │ │
│     Mortgage   -250,000.00 │ │     Memo [                                     ]           [Enter] [Cancel]                │ │
│                            │ └────────────────────────────────────────────────────────────────────────────────────────────┘ │
│ [+ Account] [+ Ledger]     │  Current 2,700.00 · Cleared 2,700.00 · Reconciled -200.00                                      │
├────────────────────────────┴────────────────────────────────────────────────────────────────────────────────────────────────┤
│ Ledger: Home Finances                                                                                                       │
└─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

Negative balances (-200.00, -540.00, -250,000.00) are drawn in red
(`error.main`), as Money does. The toolbar (*New*, the row actions and *Reconcile*) sits
under the heading in the implementation; see *As implemented* below. The navigator's root is the open ledger, with
its sub-ledgers (Personal, Credit cards, Business, Loans) and accounts
beneath it; *[+ Ledger]* opens the New Ledger dialog with the selection as
parent.

| View | Slot | `when` | Module |
|---|---|---|---|
| `ledger.start` | `shell.main` | `!ledger.isOpen` | `ledger` `./StartView` |
| `ledger.tree` | `shell.left` (icon `AccountBalance`) | `ledger.isOpen` | `ledger` `./LedgerTree`: sub-ledgers only; to give way to the navigator |
| `accounts.navigator` | `shell.left` (icon `AccountBalance`) | `ledger.isOpen` | `./Navigator` (implemented) |
| `accounts.home` | `shell.main` | `ledger.isOpen` | `./AccountsHome`: every account with balances, arranged by sub-ledger as in the chart (later) |
| `accounts.register` | `shell.main` | `ledger.isOpen` | `./Register`: the register of `accounts.register.account` (implemented) |
| `accounts.reconcile` | `shell.left` (icon `Check`) | `accounts.reconciling` | `./ReconcilePanel`: the statement's figures, the difference, and Complete, Pause and Cancel (implemented) |

**The navigator** (implemented) shows the ledger, its sub-ledgers and their
accounts. Under each node come its sub-ledgers (with their contents) first,
then its accounts, as in a file explorer. Each account has a type icon and its
balance; each sub-ledger and the ledger show totals per currency. Negative
amounts are in the theme's error colour, and closed accounts are dimmed and
hidden unless *Show closed accounts* is on. It has toolbar buttons (New
Account, New Sub-Ledger, Edit or Rename, Delete, and More), a context menu
per row, and keys: arrows, `Enter`/`F2` to edit, `Delete`, `Insert` for a new
account, and `Shift+F10` for the context menu. Clicking an account runs
`accounts.register.show`, which records the account, sets the
`accounts.register.*` keys and reveals `accounts.register`; the arrow keys
move the selection without opening registers, and Enter opens the selected
one. An open account's context menu also lists the account-scope
reconciliation options. Drag and drop to move items comes later.

### Display: one line per transaction

Columns: **status**, **Num**, **Date**, **Payee**, **Category**, the two
amount columns for the account's type, and **Balance**. A transfer shows
"Transfer to: Savings" or "Transfer from: Savings" as its category. The memo
appears as a tooltip on the payee cell. Voided rows are struck through and
show the balance unchanged. The opening balance is a fixed first row. Rows
are sorted by date, then entry order. Amount columns show unsigned amounts;
the Balance column is signed, with negative balances in red, as in Money
(see [Accounts](#accounts)).

A row is a `TransactionRow` component with a `lines` setting, so a
two-line layout (memo on a second line) can be added later without
restructuring.

### Edit mode: updating and adding

- **Selecting** a row and pressing `Enter` (or double-clicking) replaces it
  with `TransactionEditor`, the same columns as inputs. Edit mode adds a
  second line with **Memo** and *Enter* / *Cancel* buttons.
- **The new-entry row** is always last. Typing into it starts a new
  transaction, with the date defaulting to the last date entered and the
  number to the next cheque number when the previous entry had one.
- **Enter** saves and moves to a fresh new-entry row. **Esc** cancels.
  **Tab** / **Shift+Tab** move between fields. Leaving a changed row by
  clicking elsewhere saves it (Money's behaviour), and a row that fails
  validation stays in edit mode with the error shown.
- **Amounts:** two inputs with the type's labels. Typing in one clears the
  other. Input is parsed straight to minor units without floating point, and
  accepts `1,234.56`, `1234.5` and `(12.00)`. The currency's minor digits
  come from `Intl.NumberFormat`.
- **Payee**: an autocomplete over payees. A known payee fills the empty
  fields of a new entry.
- **Category**: an autocomplete listing categories as `Parent : Child`, then
  "Transfer to: *account*" entries for every other open account in the same
  currency. An unknown name offers "Create category 'X'".
- **Date**: a native date input. In the date field, `+` and `-` move a day
  and `T` sets today. In the number field, `+` and `-` step the number.
- **Row keys** outside edit mode: `↑`/`↓` select; `Space` toggles cleared;
  `Delete` deletes after confirmation; `Ctrl+Shift+V` voids or unvoids.
  These actions are also in the row's context menu and in the toolbar.
- **Conflicts:** a `CONFLICT` result reloads the row and shows "This
  transaction was changed elsewhere", keeping the user's input visible for
  re-entry.
- **Confirmations:** `CONFIRMATION_REQUIRED` (editing a reconciled
  transaction) asks in the view, then resends.
- **Closed accounts** and read-only ledgers show the register without the
  new-entry row, and editing is refused with a message.

In-progress edits live only in the view. If the ledger closes or the app
quits mid-edit, the unsaved row is lost, because views can't take part in
shutdown yet (see todo.md). Money loses only the row being typed, too, since
everything else is already saved.

**As implemented:**
- **Opening the register:** one click on an account in the navigator shows
  its register (changed in review: a double-click was one step too many). The
  arrow keys only move the selection, so browsing the tree doesn't load
  registers; Enter shows the selected account's register, and F2 edits the
  account. Accounts › Open Register and the row's context menu also open it.
- **The toolbar** under the register's heading has *New*, and, for the
  selected row, *Edit*, *Mark Cleared* (or *Mark Uncleared*), *Void* (or
  *Unvoid*) and *Delete*, greyed out until a transaction is selected, while
  one is being edited, and in a closed account. On the right is *Reconcile…*
  (see [Reconciliation](#reconciliation-and-its-extension-point)); with more
  than one reconciliation option it is a menu. The same row actions are in the
  row's context menu, with any transaction-scope options plugins contribute.
- **The category field** lists categories as `Parent : Child`, then
  "Transfer: *account*" for every other open account in the same currency. A
  saved transfer's row reads "Transfer to: …" or "Transfer from: …", by the
  sign of its amount.
- **Dates** display in the user's locale (`Oct 2, 2026`) and are edited in a
  native date input.
- **Keys:**
  - outside edit mode: arrows, Home and End move; Enter edits; Space clears or
    uncleares; Delete deletes after asking; Ctrl+Shift+V voids or unvoids;
    Insert goes to the entry row;
  - Accounts › New Transaction (Ctrl+N) does the same from anywhere;
  - the status cell of a selected row also toggles cleared when clicked.
- **Confirmations** (a change reaching a reconciled transaction, or a delete)
  are asked in the view, and a confirmed change is resent with `confirm`.
- **A `CONFLICT`** reloads the register and says the row was changed
  elsewhere.
- **Not yet:** the two-line layout, windowed rendering for very long
  registers, and splits.

### Data flow

```
Register view                                  accounts (privileged)
─────────────                                  ─────────────────────
on('accounts:transactions.changed') ─────────► (subscribe first)
invoke('accounts:register.load', {accountId}) ► transactions(id).register()
        ◄──────────────────────────────────────  RegisterSnapshot { account, rows[{ tx, balance }], balances }
invoke('accounts:transaction.save', {accountId, draft, id?, expectedRev?, confirm?})
        ◄──────────────────────────────────────  Result<Transaction>
                                                service.onDidChange ─► emit('transactions.changed', { accounts })
re-invoke register.load if its account is listed ◄──────────────────────
```

Events carry *which accounts changed*, and the view reloads. Reloading is
idempotent, so a replayed event is harmless, as the plugin guide requires.
The register loads every row of the account, because each running balance
depends on all earlier rows. That is a few thousand rows for a personal
account. If measurements show a cost, virtualised rendering and windowed
loading can come later without changing the contract.

---

## Reconciliation and its extension point

Reconciling checks the register against a statement from the bank: the user
enters the statement's figures, ticks each transaction the statement lists,
and completes when the ticked transactions account for the change in
balance. Everything ticked then becomes *reconciled*, and the statement's
ending balance is where the next reconciliation starts.

### How it looks (implemented)

1. **Reconcile…** on the register's toolbar (also Accounts › Reconcile with
   Statement…, and the account's context menu in the navigator) opens
   `accounts.dialog.reconcile`. It asks for the **statement date** (today by
   default), the **starting balance**, filled in with the balance the last
   reconciliation left (or the opening balance, the first time), and the
   **ending balance**. For a credit card or loan both balances are *amounts
   owed*, as the statement prints them; they are stored negative, like every
   liability balance. A starting balance other than the ledger's is allowed,
   with a note that completing may then need an adjustment.

   Below the balances, as in Money's Balance Account, are optional rows for
   the statement's **service charge** and **interest** (*Interest earned* on
   an asset account, *Interest charged* on a credit card, loan or other
   liability). Each has an amount, typed unsigned as the statement prints it;
   a date, which follows the statement date unless changed; and a category,
   which starts as *Bank fees* for the service charge, *Interest* for interest
   earned, and *Interest paid* for interest charged (a new starter category;
   *Bank fees* in a ledger without it). Each amount given becomes a
   transaction in the account, with the payee *Service charge* or *Interest*,
   already ticked. A service charge lowers the balance; interest raises an
   asset's balance and adds to what a liability owes. Blank or zero adds
   nothing. On resuming, the rows start blank: charges entered before are
   already in the register, and an amount entered now adds another.
2. **The register switches to reconcile mode.** It lists only the
   transactions a statement can include: not yet reconciled, and not void.
   Those dated up to the statement date come first; later ones are set apart
   under *After the statement date*, since they usually belong to the next
   statement. Each row has a tick box (*on the statement*), and each group a
   tick box for all of it. `Space` ticks the selected row.
   - **Correcting an amount:** clicking an amount (or the pencil, or `Enter`)
     edits it in place; the statement's figure is typed unsigned, and the
     transaction keeps its direction. It is saved through
     `accounts:transaction.patch`, which changes only the amount and checks
     the row's revision.
   - **Voiding:** the row's *Void* button voids a transaction that never
     happened; it leaves the list.
   - **Adding:** the register's entry row stays at the bottom, for anything
     else on the statement the register lacks. It is added uncleared, and
     then ticked.
3. **The Reconcile panel** (`accounts.reconcile`, in the left bar beside the
   navigator, shown while `accounts.reconciling` is set) follows the figures:
   starting balance, the ticked transactions' total and count, the ending
   balance, and the **difference**, which is green with a tick at zero. It
   has three buttons:
   - **Complete** makes every ticked transaction reconciled, and records the
     statement as the account's last reconciliation. If the ledger would
     still disagree with the statement, it asks first, and with the user's
     agreement adds a reconciled *Balance adjustment* transaction (memo
     "Reconciliation adjustment", dated the statement date) for the
     difference, as Money does.
   - **Pause** keeps the ticks and leaves reconciling for later. The register
     returns to normal with a note that reconciling is paused, and *Resume*
     (or *Reconcile…* again) reopens the dialog with the figures already
     entered, which can be corrected.
   - **Cancel** asks first, then puts back the status of every transaction
     the reconciliation ticked or unticked, deletes the service charge and
     interest it added, and forgets the figures.

Ticks are saved as they are made (a tick sets the transaction's status to
cleared, an untick to uncleared), so a paused reconciliation survives closing
the ledger or the app. The reconciliation records each transaction's status
before its first change, which is what Cancel restores. A status changed by
hand outside the reconciliation isn't its to restore.

**The difference and the adjustment.** The panel's difference is the
statement's own arithmetic: ending balance − (starting balance + ticked).
Completing compares the statement with the ledger instead: ending balance −
(the ledger's reconciled balance + ticked). The two are the same unless the
statement's starting balance differs from the ledger's, and then the panel
says so, with the adjustment completing would add. This catches a statement
that balances on its own but starts somewhere the ledger doesn't.

### `reconciliation` in `accounts.service` (implemented)

```ts
export interface StatementFigures {
  statementDate: string                 // YYYY-MM-DD
  startingBalance: number               // minor units, signed
  statementBalance: number              // the ending balance
}

export interface StatementCharge {
  amount: number                        // minor units, positive, as the statement prints it
  date: string
  categoryId?: string
}

/** What the dialog gives `begin`: the figures, and the charges to add. */
export interface StatementInput extends StatementFigures {
  serviceCharge?: StatementCharge       // added as −amount
  interest?: StatementCharge            // +amount on an asset, −amount on a liability (chargeAmount)
}

export interface ReconciliationService {
  /** The reconciliation in progress for an account, paused or not. */
  get(accountId: string): Promise<ReconcileState | undefined>
  /** Starts one, or, when one is in progress, updates its figures and resumes it. Charges are added, marked. */
  begin(accountId: string, statement: StatementInput & { reconcilerId: string }): Promise<ReconcileState>
  /** Marks transactions as on the statement (cleared), or not (uncleared). */
  mark(accountId: string, ids: string[], marked: boolean): Promise<ReconcileState>
  pause(accountId: string): Promise<void>
  /** Needs confirm: ['adjustBalance'] when the ledger would still differ from the statement. */
  finish(accountId: string, options?: { confirm?: Confirmation[] }): Promise<ReconcileResult>
  /** Ends it, putting back every status it changed and deleting the charges it added. */
  cancel(accountId: string): Promise<void>
}

export interface ReconcileState {
  account: Account
  reconciliation: Reconciliation        // the figures, reconcilerId, paused, startedAt
  summary: {
    starting: number, marked: number, markedCount: number,
    difference: number,                 // statement balance − (starting + marked)
    lastReconciledBalance: number,
    adjustment: number                  // statement balance − (last reconciled + marked)
  }
  /** Every transaction not yet reconciled and not void, in register order, each marked or not, and after the statement date or not. */
  candidates: ReconcileCandidate[]
}
```

The service takes the account id on each call rather than handing out a
session object, so a reconciliation is just data: any plugin, view or restart
can pick it up by account. The reconciliation is a document in
`accounts.reconciliations`; its unique `activeFor` index (set only while it
is in progress) keeps one per account. Beginning runs in one storage
transaction: the charges are added and the reconciliation recorded together,
or, if a charge is invalid (its `field` is `serviceCharge` or `interest`),
neither. The reconciliation keeps the ids of the transactions it added
(`addedIds`). Finishing runs in one storage transaction too: the statuses,
the adjustment, the account's `lastReconciled` and the finished record (with
the ids it reconciled, for a later "undo last reconciliation"). Deleting an
account deletes its reconciliations. `accounts.reconciling` and
`accounts.reconciler` are set while the register's account is being
reconciled and not paused.

### `accounts.reconcile.actions` (extension point, implemented)

Contributions are plain data, as the repository's other contributions are.
Behaviour lives in the command they name.

```ts
export const RECONCILE_ACTIONS_POINT = 'accounts.reconcile.actions'

export interface ReconcileActionContribution {
  id: string                               // '<plugin>.<name>'
  label: string                            // 'Match Downloaded Statement…'
  /**
   * 'account': an option in the register's Reconcile menu and the navigator's account context menu.
   * 'transaction': an option in a row's context menu, for the selected rows.
   */
  scope: 'account' | 'transaction'
  /** Run with one argument, ReconcileActionArgs: { accountId } or { accountId, transactionIds }. */
  command: string
  /** Shown only for these account types. Default: all. */
  accountTypes?: AccountType[]
  description?: string                     // tooltip
  icon?: string                            // a shell icon name
  order?: number
}
```

- **Visibility** is by `accountTypes`. **Enabled** state is the command's
  enablement, so a contributor controls it with ordinary expressions.
  Plugins can't evaluate `when` expressions themselves, because the parser
  lives in `shared/`, which they may not import.
- The register asks `accounts:reconcile.actions { accountId, scope }` for
  both scopes when it shows an account, and again when the chart changes.
  The navigator asks when an account's context menu opens, and shows the
  account's register before running the option, since reconciling happens
  there. Invalid contributions (no command or label, a bad scope, an id
  without the contributor's prefix, a duplicate) are skipped with one
  `[accounts]` warning each.
- **A reconciler's own UI** is an ordinary `shell.views` contribution with
  `when: "accounts.reconciler == '<its action id>'"`, for example a
  statement-matching panel in the right bar. A reconciler calls
  `reconciliation.begin(accountId, { …figures, reconcilerId: '<its action id>' })`
  and then `mark` and `finish` like the built-in one, so every reconciler
  finishes the same way. Rendering another plugin's component *inside* the
  register would need a framework facility, and is left for later.

### The built-in reconciler: Reconcile with Statement

`accounts` contributes `accounts.reconcile.statement` ("Reconcile with
Statement…", scope `account`) through the same point, which proves the seam.
Its command, `accounts.reconcile.statement`:

1. takes `{ accountId }`, or acts on the register's account; a closed
   account is refused with a message;
2. shows `accounts.dialog.reconcile` (titled *Resume Reconciliation* when one
   is paused) with the ledger's categories and the suggested ones for the
   charges, and calls `reconciliation.begin(...)` with the figures and
   charges;
3. shows the account's register and reveals the register and the Reconcile
   panel.

Transaction-scope examples a plugin might add: *Match to downloaded
statement line*, *Mark as electronically cleared*. An importer plugin would
naturally contribute both.

---

## IPC and events (`accounts`; `ledger` is analogous)

| Channel | Request → response |
|---|---|
| `accounts:chart` | `{ includeClosed }` → `Chart` (the ledger tree, accounts, balances) |
| `accounts:select` | `{ kind, id } \| null` → void (sets the selection context keys) |
| `accounts:account.save`, `accounts:move` | input (+ `id`, `expectedRev`, `confirm`) → `Result<…>` (used by the dialogs) |
| `accounts:register.load` | `{ accountId }` → `RegisterSnapshot` |
| `accounts:transaction.save` | `{ accountId, id?, draft, expectedRev?, confirm? }` → `Result<Transaction>` |
| `accounts:transaction.delete` / `.setStatus` / `.setVoided` | `{ accountId, ids, …, confirm? }` → `Result<void>` |
| `accounts:payees.search` | `{ prefix }` → `Payee[]` (with last category and amount) |
| `accounts:categories.list` | → `Category[]` |
| `accounts:transaction.patch` | `{ accountId, id, patch, expectedRev?, confirm? }` → `Result<Transaction>`: only the fields given change (the reconcile list's amount correction) |
| `accounts:reconcile.actions` | `{ accountId, scope }` → `ResolvedReconcileAction[]` (`{ id, label, scope, command, icon?, description?, enabled }`) |
| `accounts:reconcile.state` | `{ accountId }` → `ReconcileState`, or null |
| `accounts:reconcile.mark` / `.finish` / `.pause` / `.cancel` | `{ accountId, ids?, marked?, confirm? }` → `Result<…>` |

| Event | Payload |
|---|---|
| `accounts:chart.changed` | The whole `Chart` (small, absolute) |
| `accounts:transactions.changed` | `{ accounts: string[] }`: reload these registers |
| `accounts:register.changed` | `{ accountId }`: the register should show this account |
| `accounts:reconcile.changed` | `{ accountId, state }`: the account's `ReconcileState`, or null when it has none. Sent when its reconciliation or its transactions change |
| `accounts:transaction.new` | `{}`: *New Transaction* from the menu; the register focuses the entry row |
| `ledger:state.changed` | `LedgerState`: `{ isOpen, ledger?, error? }` (requested as `ledger:state`) |
| `ledger:tree.changed` | The whole `LedgerTree` (small, absolute), or null when the ledger closed. `accounts` also folds it into `accounts:chart.changed` |
| `ledger:recent.changed` | `RecentLedger[]`, each with `exists` |

Channel and event names are constants in the API packages, so both halves
of a plugin and its tests share them.

---

## Framework prerequisites

**Implemented in phase 0** (results in the
[implementation outline](account-manager-implementation.md#phase-0-results)).
All are generic; none mentions ledgers or accounts. How plugins use them is in
the plugin guide, [Asking the user](plugin-creation.md#asking-the-user-dialogs-prompts-and-files).

1. **`shell.files` service** (`ShellFiles` in `tessera-types/dialogs.ts`),
   provided by the shell before plugins activate so `requires` can name it:
   `showOpenDialog`, `showSaveDialog` (modal to the focused window, with
   filters; the platform asks before replacing a file), `exists`, `trash`
   (Electron `shell.trashItem`; never a permanent delete) and
   `documentsPath`. Locks, atomic writes and backups come later; a backup is
   a file copy the ledger can make itself.
2. **`shell.prompts` service** (`ShellPrompts`): `confirm({ message, detail,
   confirmLabel, destructive })` and `message(...)` as native message boxes
   (for `destructive`, Cancel is the default button); `prompt(...)`, a line
   of text in the shell's own built-in dialog; and `show(dialogId, input,
   { title })`, below. Every method takes an optional `windowId`.
3. **`shell.dialogs` extension point and dialog host.** A contribution
   `{ id, title, module, size? }` names a module in the plugin's renderer
   remote; its id must start with the plugin id. `shell.prompts.show` asks
   `DialogService` (core), which sends `shell:dialog.open` to the target
   window once its renderer is ready, and again if the page reloads. The
   renderer's `DialogHost` draws the frame (modal, title, size, Escape and
   clicking outside to cancel), loads the module with the federation loader,
   and renders it with `DialogProps<TInput, TResult> = { input, close(result?),
   setBusy(busy) }`. The answer returns over `shell:dialog.close`, accepted
   only from that window, and resolves the promise. A closed window or a
   failed module resolves `undefined`. Dialogs in one window are queued.
4. **`@tessera/ui` 1.1**: `TextField`, `Autocomplete`, `Checkbox`, `Menu`,
   `MenuItem`, `List`, `ListItemButton`, `ListItemIcon`, `ListItemText`,
   `Collapse`, `Tooltip`, `InputAdornment`, `FormHelperText`, `Table`,
   `TableContainer`, `TableHead`, `TableBody`, `TableRow`, `TableCell`, and
   the standard icons `Block`, `Check`, `CreditCard`, `Delete`, `Edit`,
   `Error`, `Folder`, `MoreVert`, `Savings`, `ShowChart`, `Warning`. All in
   `@mui/material` and `@mui/icons-material`, so no new dependency. The date
   input is a native `type="date"` field.
5. **Two API packages**, `@tessera/ledger-api` and `@tessera/accounts-api`,
   aliased like `@tessera/storage-kit` (tsconfig, vitest, and the plugin
   build for both the privileged and the renderer bundles), with an
   architecture test that keeps them free of platform imports.
6. **SQLite as the default `storage.engine`**: `defaultPreferred` in the
   plugin selection, after the user's `preferredPlugins` (see
   [Storage format and durability](#storage-format-and-durability)).

---

## Alternatives considered

| Alternative | Why not |
|---|---|
| **Sub-containers as separate files** (a ledger of ledgers) | Transfers across files couldn't be atomic, reports would need cross-database queries (the storage design rules them out), and users would juggle several files. A sub-ledger gives the same organisation in one file |
| **One plugin for file and domain** | Simpler at first, but budgets and reports would then depend on account code to reach the file, which is the coupling the vault note's rule 1 exists to prevent |
| **A single status enum including `void`** (Money's one column) | Loses the clearing status on void, so unvoiding can't restore it. The register still shows one letter |
| **Opening balance as a transaction** (Quicken) | Works, but it is a transaction that can't be a transfer, can't be deleted, and must stay first. A field is simpler, and the register can still show it as a row |
| **One collection per account** | Transfers, payee history, category reports and aggregates would all span collections. The storage design favours few collections with indexes |
| **Account and ledger forms as main-area pages** instead of dialogs | Works with today's framework, and is the fallback if `shell.dialogs` slips. But a modal form is what a *New Account…* menu item leads users to expect, and other plugins need dialogs too |
| **Reconcile UI embedded in the register by other plugins** | Needs a framework facility to render one plugin's component in another's view. Contributed actions plus `when`-gated views achieve the goal with today's framework |
| **Deleting a ledger permanently** (`engine.drop`) | Irreversible for the user's most valuable file. The trash is recoverable |

---

## Risks

| Risk | Mitigation |
|---|---|
| A user who switches their engine to Loki can't open their (SQLite) ledgers | SQLite is the default and switching is a deliberate bootstrap-file edit; sniffing gives a clear message; `ledger.formats` later (after the driver-packaging fix above) |
| Switching the default engine resets window positions, theme and layout once | Accepted: early in the project, and no financial data is involved. The old `app.loki.json` is left in place |
| Two copies of the app opening the same ledger | Out of scope for now; file locks belong in `shell.files` later. SQLite serialises the writes, but each copy's in-memory state goes stale |
| Deleting a sub-ledger touches several plugins' data | One storage transaction across every participant; a participant that throws rolls the whole delete back |
| Register performance for long-lived accounts | Measure at 10,000 rows in phase 4; virtualise and window if needed |
| Migration crash between `migrate` and recording its version (`meta` isn't transactional) | Migrators must be re-runnable; a backup is taken before any migration |

---

## Decisions taken in review

Decided on 2026-11-04 and applied throughout this note.

| # | Question | Decision | Where it lands |
|---|---|---|---|
| 1 | Names | **Ledger** and **Sub-ledger**. *New Ledger…* creates both: with a parent ledger it creates a sub-ledger in the open file, and no file is created. With no parent it asks to close the open ledger, then creates a new ledger file | [Naming](#naming), [The ledger tree](#the-ledger-tree-sub-ledgers), [Flows](#flows) |
| 2 | Default storage engine | **SQLite** | [Storage format and durability](#storage-format-and-durability) |
| 3 | Meaning of "remove" a ledger | **Send the file to the OS trash** | [Flows](#flows) (Delete Ledger…) |
| 4 | Liability display | **The Microsoft Money approach**: signed balances, liabilities negative, negatives in red | [Accounts](#accounts) |
| 5 | Encryption | **Not in the first release**; account numbers stored as entered and masked on screen | [Goals and non-goals](#goals-and-non-goals) |

Smaller choices made while applying them. Each is easy to change; flag any
that are wrong:

- **File › New Ledger… defaults the parent to None** (a new file), even when
  a ledger is open. *New Sub-Ledger…* in the Accounts menu, and the
  navigator's *[+ Ledger]*, open the same dialog with the selection as
  parent.
- **With no ledger open, New Ledger… skips the dialog** and goes straight
  to the save dialog, since there is no possible parent.
- **Sub-ledgers belong to the `ledger` plugin**, not `accounts`, because *New
  Ledger…* creates them. Plugins that place items in sub-ledgers take part
  in deleting them as participants.
- **Deleting a sub-ledger moves its contents up to its parent** and deletes
  only the empty container, so nothing is lost and there is nothing to send
  to the trash. Deleting an account is permanent, after a confirmation.
- **Only the ledger file's name can't be changed in the app**; sub-ledgers
  can be renamed.

Later review points (2026-11-04), after trying the register:

- **One click on an account opens its register**; arrows only move the
  selection, Enter opens, F2 edits. See [Layout](#layout).
- **The register has a toolbar** for the selected row (Edit, Mark Cleared,
  Void, Delete), so voiding doesn't depend on knowing Ctrl+Shift+V.
- **Reconciling starts from the statement**: the statement date (default
  today), the starting balance (prefilled from the last reconciliation) and
  the ending balance. The register then lists only what the statement can
  include, and a panel beside the navigator shows the difference with
  *Complete*, *Pause* and *Cancel*. Amounts can be corrected, and
  transactions voided, in that list. **Cancel puts the marks back**, where
  the first draft of this note kept them. See
  [Reconciliation](#reconciliation-and-its-extension-point).

---

## Phases

Detailed in [account-manager-implementation.md](account-manager-implementation.md).

| Phase | Delivers |
|---|---|
| 0 | Framework prerequisites: `shell.files`, `shell.prompts`, `shell.dialogs`, `@tessera/ui` additions, API packages, SQLite as the default engine |
| 1 | `ledger` plugin: New Ledger (file or sub-ledger), open, close, delete to trash, the sub-ledger tree and participants, recent ledgers, start view, schema and migrations |
| 2 | `accounts` domain with no UI: accounts in the ledger tree, transactions, transfers, payees, categories, balances, tested against the memory engine |
| 3 | Account manager UI: navigator, Accounts menu, dialogs, home view |
| 4 | The register: single-line display, inline editing, new-entry row, keyboard |
| 5 | Reconciliation: the reconciliation in `accounts.service`, reconcile mode and the Reconcile panel, `accounts.reconcile.actions`, Reconcile with Statement (done) |
| 6+ | Splits, category manager, import, per-file formats, locks, investments |
