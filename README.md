# Tessera

Tessera is a desktop personal-finance application, intended as a replacement
for Microsoft Money Plus, built with Electron, React and TypeScript.

It's built as a **framework that doesn't know about any business
function**, with Finance supplied by plugins. The shell provides a window, a
menu bar, IPC and a plugin runtime. Everything else is contributed by
plugins through extension points and services, in the spirit of the Eclipse
platform.

> **Status: early.** The shell, plugin framework and window layout work end
> to end. The first Finance feature is arriving as plugins: **ledgers,
> sub-ledgers, accounts, transactions, the register and reconciliation**
> work today; the accounts home view comes next
> ([plan](docs/account-manager-implementation.md)). See
> [docs/todo.md](docs/todo.md) for what's still open.

## What works today

- **Ledgers** (the `ledger` plugin): File › New, Open, Close and Delete
  Ledger. A ledger is one SQLite file (`.tessera`) holding everything, with
  **sub-ledgers** nested inside it, created with the same *New Ledger…* by
  choosing a parent. Deleting sends the file to the OS trash. The last ledger
  reopens at start-up; a start view lists recent ledgers; a *Ledger* panel in
  the left bar manages sub-ledgers. Other plugins store their data in the open
  ledger through the `ledger.session` service and the `ledger.schema`
  extension point ([@tessera/ledger-api](packages/ledger-api/),
  [design](docs/account-manager-design.md#the-ledger)).
- **Backups** (the `ledger` plugin): *File › Back Up Ledger…* writes a checked
  copy of the open ledger (`.tesserabkp`) while it stays open, suggesting
  *Documents/Tessera Backups*; expired backups of the ledger there are trimmed
  (30 days, always the newest five). *File › Restore Ledger…* lists the
  backups there and restores one as a new ledger, or in place of its ledger
  with the current file kept under another name: nothing is replaced or
  deleted, and a message says where each file is. The ledger is also backed
  up as it closes (Close Ledger, opening another, quitting, an OS shutdown)
  when it has changed since its last backup; a failure shows as "Last backup
  failed" in the status bar. Tools › Options… › Ledger › Backups sets the
  folder, backing up on close and retention. One long operation at a time:
  while an import, a backup or a restore runs, the ledger's file commands
  wait, and quitting asks first ([design](docs/backup-restore-design.md)).
- **Archiving** (the `ledger` plugin, with the accounts and import plugins
  taking part): *File › Archive Ledger…* keeps a copy of the open ledger as an
  archive file (in *Tessera Backups/Archives*, never trimmed), then removes the
  reconciled and void transactions before a date the user chooses, and closed
  accounts left with nothing. Each account's balance is carried into its
  opening balance, so every balance stays the same, and the register's first
  row is dated the last archival date; nothing can be entered before it. The
  ledger's file is then compacted, and the message says how much smaller it
  is. The dialog shows what will go and warns about what isn't reconciled.
  *File › Open Ledger…* opens an archive file read-only, and nothing in it can
  be changed; *Restore Ledger…* restores one. Tools › Options… › Ledger ›
  Archiving sets the date the dialog suggests
  ([design](docs/ledger-compaction-design.md)).
- **Accounts** (the `accounts` plugin): chequing, savings, credit card,
  mortgage, investment and other accounts, in the ledger or any sub-ledger.
  An *Accounts* menu and an *Accounts* navigator in the left bar (which
  replaces the Ledger panel) create, edit, move, close, reopen and delete
  them. Balances are shown the Microsoft Money way (what you owe is negative,
  in red), with totals per currency. Reports and importers use the
  `accounts.service` service ([@tessera/accounts-api](packages/accounts-api/),
  [how](docs/plugin-creation.md#using-accounts-from-another-plugin)).
  An account can keep a **minimum balance** and show the balance above it.
- **Transactions and the register**: each account's **register** (in the
  main area; click an account) shows one line per transaction with a
  running balance. Enter edits a row in place, and a new-entry row at the
  bottom adds one, with payee autocomplete, categories and transfers
  between accounts (kept consistent on both sides). A toolbar edits, clears,
  voids and deletes the selected row (also Space, Ctrl+Shift+V and Delete);
  voiding keeps the amount but drops it from balances.
- **Reconciliation**: *Reconcile…* asks for a statement's date, starting
  and ending balances, and any service charge and interest (added as
  transactions), then the register lists what the statement can include. Tick what it shows, correct an amount or void a transaction on the
  way, and a panel beside the accounts shows the difference, with Complete
  (adding a balance adjustment if you agree), Pause and Cancel. Other plugins
  add ways to reconcile through `accounts.reconcile.actions`
  ([how](docs/plugin-creation.md#adding-a-way-to-reconcile)).

- **Importing statements** (the `import` plugin, with `format-ofx`, `format-csv` and `format-qif`): *File › Import…*
  imports bank and card statements into their accounts:
  - OFX, QFX and QBO files, from Microsoft Money, Quicken or QuickBooks (Web Connect) downloads. Ids a conversion
    tool made up (numbering each file's lines 1, 2, 3…) are recognised, and those lines are known by their content;
  - banks' CSV exports, with a header or without, in English or French, with one amount column or money out and
    money in. Every file's columns are shown for checking (**CSV Columns**), with a preview of what will be imported:
    recognised or guessed the first time, remembered after. Pending rows are left out, and a file with an account
    number column finds each account by its number. A CSV export named `.txt` imports through *All files*;
  - QIF files, to bring accounts over from Microsoft Money or Quicken: an account's history with its opening balance,
    payees, memos, cheque numbers and categories (where the ledger has them, once the user says so), or a whole
    Quicken file, an account at a time. Splits come in as their totals, investment accounts are left out, and a file
    whose dates or amounts read two ways is asked about once (**QIF Options**);
  - the account is found by a remembered match or its number, or the user picks it,
    or creates it from the statement;
  - the same bank line is never added twice, even across overlapping files, and a bank id reused for a different
    transaction (as some banks and conversion tools do) doesn't hide the new one;
  - a line that looks like a transaction already imported from another kind of file (the bank's CSV, then its OFX)
    is proposed as **Already imported?** instead of being added: *Accept* says it is the same, *Change…* adds it
    after all;
  - a statement whose amounts look the wrong way round for its account (a card's charges written as positive) is
    asked about before it is imported (**Amounts Reversed?**), and the answer is remembered for its source;
  - lines the user already entered are matched to them, fuzzily, by date, amount
    and payee, and proposed for review. The register shows the bank's version
    under each row, with **Accept** and **Change…**; the Change Match dialog moves
    a line to another transaction, unmatches it or leaves it out. The rest is
    added as new, and acknowledged the same way. How closely a line must match
    is a setting (Tools › Options… › Import): Strict, Balanced or Lenient, each a
    consistent set of tolerances;
  - how the bank writes a payee is learnt from the user's choices, for matching
    and for new lines;
  - everything imports remember (saved account matches, payee names learnt, CSV
    columns, QIF options, category and sign choices) is listed in one place,
    *File › Saved Import Choices…*, to change or forget.

  Other file types are plugins of their own
  ([how](docs/plugin-creation.md#adding-an-import-format),
  [design](docs/import-manager-design.md)). There are sample statements to try in
  [samples/statements](samples/statements/).

- **Exporting transactions** (the `export` plugin, with `format-csv`, `format-qif` and `format-ofx`): *File › Export…* writes an open ledger's
  transactions to a file, starting from the account the user is looking at: one account, several, or all of them, for
  a range of dates. *Accounts › Export Account…* does the same for the selected account. The Export dialog shows how many transactions the file will hold, and what will be changed or left
  out, before a file is chosen; the format's own options are drawn from what it declares. Nothing in the ledger
  changes, so a ledger open read-only (an archive file too) can be exported. The file is saved under a temporary name
  and renamed into place, so a failure never leaves half a file; the choices are remembered for next time.
  - **CSV**, for spreadsheets: one row per transaction with its running balance, in UTF-8 with a byte-order mark and
    ISO dates by default (or month or day first, comma decimals with semicolons, Money out and Money in columns,
    Windows characters), with cells a spreadsheet would run as formulas protected. Tessera's own CSV import reads the
    file back with nothing to guess;
  - **QIF**, standard QIF (Money's "strict") for Quicken, Money, GnuCash or another Tessera ledger: one account or a
    whole ledger, with its category list, each account's opening balance, categories, transfers, cheque numbers and
    statuses. As standard QIF has them, category and account names keep their first 15 characters, and payees 32 (the
    whole payee is kept in the memo); two accounts whose names would be one are refused, with a message saying which.
    Imported back into the account it came from, it adds nothing; into a new ledger, each account comes over at the
    same balance.

  - **OFX, QFX and QBO**, one bank or card account's statement, as banks give them for Money, Quicken and QuickBooks
    (OFX 1.0.2). Each line keeps a stable id, the bank's own when it came from the bank, so an overlapping export isn't
    doubled; imported back into its account, it adds nothing. The statement says which account it is by the account's
    number and *Bank number*, and QFX and QBO add the bank's *Intuit bank id*: new fields of an account (in the Account
    dialog's *Downloads and exports*), which OFX imports fill in where they are empty, as they do an empty account
    number. The Export dialog shows them, and what is typed there is used for that file only. An account number of four
    characters or fewer is warned about, as it may be only the last digits of a masked one.

  An account with nothing in the dates isn't in the file; the Export dialog says which ones. Other file types are
  plugins of their own ([how](docs/plugin-creation.md#adding-an-export-format), [design](docs/export-design.md)).

- **Plugin runtime:** discovers plugins on disk, validates their manifests,
  orders activation by service dependencies, isolates failures (a broken
  plugin is logged and skipped), and disposes what the plugin context tracks
  (commands and anything pushed onto `context.subscriptions`) when a plugin
  is deactivated.
- **Menu bar extension point** (`shell.menus`): hierarchical menus, groups
  separated automatically, and fixed positions for `File`, then plugin
  menus, then `Tools`, then `Help`.
- **Commands with live enablement:** menu items follow their command's
  `enablement` expression over **context keys**, such as
  `ledger.isOpen && !ledger.isReadOnly`, and update while the app runs.
- **Views extension point** (`shell.views`): plugin UI is written as
  `.tsx` and loaded at runtime as a **Module Federation** remote. Views
  share the shell's React, and each is isolated by its own error boundary.
  A view targets a layout slot and can carry a `when` expression.
- **Layout controller:** the window is a fixed frame of five slots
  (`shell.main` in the centre, `shell.top`, `shell.bottom`, `shell.left` and
  `shell.right` around it). A bar is hidden when nothing targets it,
  collapsed to an icon rail, or expanded with its views as tabs; bars resize
  with a keyboard-accessible splitter and `F6` cycles regions. The state is
  per window and lives in the main process (`LayoutService`). `shell.layout.*`
  commands, context keys and a `View` menu drive it, and it is persisted
  through `app-state`. See
  [docs/layout-controller-design.md](docs/layout-controller-design.md).
- **Bar items extension point** (`shell.bar.items`): command buttons and
  status text with icons, placed in a bar without writing a React view.
- **Built-in plugins:** source in `plugins/<id>/`, built (TypeScript and
  TSX) into `modules/<id>/` with `npm run build:plugins`, and loaded before
  user-installed plugins.
- **Services:** plugins provide and require services, such as `ledger.session`,
  declared in their manifest. The shell provides `shell.prompts` and
  `shell.files`; plugins provide `storage.engine` (the `storage-sqlite` plugin
  by default, or `storage-loki`) and `app.state` (provided by `app-state`,
  which requires `storage.engine`).
- **Dialogs, prompts and files:** plugins ask the user through the shell:
  native confirmation and message boxes, a text prompt, open and save file
  dialogs, the OS trash, and modal dialogs of their own (`shell.dialogs`),
  drawn in the shell's frame. See
  [Asking the user](docs/plugin-creation.md#asking-the-user-dialogs-prompts-and-files).
- **Settings (preferences):** a plugin registers its settings and their
  defaults (`context.settings`), reads them from the first line of `activate`,
  and hears which of them changed. Other plugins may read them, never change
  them: changes go through the settings manager. It contributes pages to the **Options** dialog
  (Tools › Options…, `Ctrl+,`) through `shell.settings.pages`: a list of fields
  the shell draws, or a component of its own. The dialog has a page tree with
  search, and OK, Apply, Cancel and Restore Defaults. Every change is checked in
  the main process, and only what differs from the defaults is saved, as one
  plain JSON file per plugin under `settings/` in the user-data folder. The
  ledger's start-up, recent-ledger and backup settings are examples; field
  kinds include a folder, chosen with the platform's folder dialog. See
  [Settings](docs/plugin-creation.md#settings). To check them, **Tools ›
  Settings Inspector…** shows, for every plugin's settings, what is in effect,
  the defaults and the file on disk, and whether they agree.
- **Storage and application state:** a `StorageEngine` interface
  (collections, queries, transactions) with SQLite (the default) and LokiJS
  implementations, and an
  `app-state` plugin that keeps window, theme and per-window layout state on
  top of it. Plugins keep what they remember between runs there through
  `context.state`, under their own keys; a view reaches its plugin's state
  only through its own plugin's IPC.
- **Theming and Material UI:** the shell's components and icons are
  [Material UI](https://mui.com/), and plugins reach them only through
  `@tessera/ui` (never `@mui/*`), which the shell shares with plugin views. A theme
  manager follows the operating system's light or dark setting. The theme is chosen
  on the Options dialog's **Appearance** page (a gallery of every theme, drawn from
  its colours, with a preview), and is kept as a setting; OK or Apply re-themes every
  window. Plugins can contribute themes (`shell.themes`, checked for contrast) and
  icons (`shell.icons`, fetched when first drawn), and a window stays hidden until
  its theme is applied. See [docs/theming-design.md](docs/theming-design.md) and
  [Styling and theming](docs/plugin-creation.md#styling-and-theming).
- **Fonts:** text is drawn in *font roles* (Interface text, Headings, Small text,
  Tables and registers, Amounts and figures, Fixed-width text). The Options
  dialog's **Fonts** page, under Appearance, sets each one's font, size and weight,
  choosing from the fonts installed on the computer, with a live preview; the choice
  is a setting, and OK or Apply re-fonts every window. A theme may set fonts too
  (the user's choices win, and themes' fonts can be turned off). Plugin views follow
  the roles through `@tessera/ui`. See [docs/font-roles-design.md](docs/font-roles-design.md).
- **IPC:** a single dispatcher channel. Handlers are registered on channels
  named `<pluginId>:<event>` by convention, and replies are a structured
  success-or-error envelope. Events flow the other way too: the shell publishes its phase,
  context keys, views, bar items and layout, and plugins push their own events to views.

## Architecture

The code is hexagonal: the core is platform-free and depends only on ports,
and Electron and the file system sit behind adapters.

```
tessera-types/
          The common interfaces (@tessera/types): PluginContext, the registry
          interfaces (IPC, commands, extensions, context keys, services,
          lifecycle, events, settings), StorageEngine and AppState. The core
          implements them, the shell composes them, and plugins are written
          against them.
shared/   Contracts any process may import: IPC envelope guards, manifest
          schema, menu, view and layout contracts, enablement expressions. No
          platform code.
core/     Main-process application core: plugin manager, plugin context,
          and the registry implementations (IPC, extensions, commands,
          context keys, services, lifecycle, events), the layout controller
          (LayoutService), the settings service (SettingsService) and the
          storage engine registry and transaction manager. Depends only on
          tessera-types/, shared/ and its own ports.
shell/
  main/       Composition root and adapters: Electron menu, IPC binding,
              layout wiring (commands, keys, menus, persistence),
              settings files, file-system plugin source,
              tessera-plugin:// protocol.
  preload/    The typed bridge exposed to the renderer as window.api.
  renderer/   React host: <LayoutController> (bars, main area, splitters)
              and the federation view loader.
```

Dependencies point inwards only (`shell` → `core` → `shared`), and the
renderer never imports `core/` or main-process code. `@tessera/types` is
interfaces (plus a few helpers such as `channelFor`), so every layer may import it. The plugin context hands
plugins the application's shared registries. Only `commands` (ids must be
prefixed with the plugin id) and `events` (bound to the plugin id) are scoped.
[tests/architecture/boundaries.test.ts](tests/architecture/boundaries.test.ts)
enforces this on every test run.

How a plugin connects:

| Mechanism | Use it to… | Example |
|---|---|---|
| Extension point | add something the shell, or another plugin, shows or collects | a menu item, a view |
| Command | let the user trigger an action | `ledger.open` |
| Context key | publish state that enablement depends on | `ledger.isOpen` |
| Service | let other plugins call into your code | `ledger.session` |
| IPC | connect your view to your own privileged code | `window.api.invoke('ledger:tree')` |
| Lifecycle | run code once everything has started; on a user quit, do slow work and say why not to close yet; tidy up as the app shuts down | `context.lifecycle.onStarted`, `onWillQuit`, `onShuttingDown` |

The full guide to writing a plugin is
**[docs/plugin-creation.md](docs/plugin-creation.md)**.

## Getting started

Prerequisites: Node.js and npm (developed with Node 24), on Windows, macOS or
Linux.

```bash
npm install
npm run dev
```

`npm run dev` ([scripts/dev.mts](scripts/dev.mts)) builds the main and preload
bundles and the bundled plugins, starts the Vite renderer dev server on port
5173, launches Electron, and stops the dev server when Electron exits.

> **Running from VS Code's integrated terminal?** It may set
> `ELECTRON_RUN_AS_NODE=1`, which makes Electron run as plain Node. You'll
> see `does not provide an export named 'BrowserWindow'`. Unset it first:
> `env -u ELECTRON_RUN_AS_NODE npm run dev` in bash, or
> `Remove-Item Env:ELECTRON_RUN_AS_NODE` in PowerShell.

### Installing a plugin locally

Plugins are loaded from the `modules` folder in Electron's user-data
directory:

| OS | Folder |
|---|---|
| Windows | `%APPDATA%\tessera\modules\` |
| macOS | `~/Library/Application Support/tessera/modules/` |
| Linux | `~/.config/tessera/modules/` |

Copy a plugin folder there (each needs a `manifest.json`) and restart.
Plugins that ship with Tessera are built from `plugins/` into `modules/`
instead; see [Built-in plugins](docs/plugin-creation.md#built-in-plugins).
To experiment without touching your real profile, launch Electron with
`--user-data-dir=<some folder>`. The
[Quick start](docs/plugin-creation.md#quick-start) has a complete plugin to
try.

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Build main, preload and bundled plugins, start the renderer dev server, launch Electron |
| `npm run build:plugins` | Build `plugins/<id>/` into `modules/<id>/` |
| `npm run sample:archive -- [folder] [--replace]` | Make a sample ledger and its archive file to try archives by hand (default folder `samples/archive`, not kept in git) |
| `npm run anonymise -- <files…> [options]` | Take the personal data out of real statement files (OFX, QFX, QBO, CSV, QIF), keeping their dialect, so they can be added to the tests; refuses a file in which anything still looks personal. `--check` scans files without changing them. See [tests/fixtures/import/real/README.md](tests/fixtures/import/real/README.md) |
| `npm test` | Run the test suite once (Vitest) |
| `npm run test:watch` | Run tests in watch mode |
| `npm run test:ui` | Vitest UI |
| `npm run dev:main` / `dev:preload` | Rebuild one bundle in watch mode |
| `npm run dev:renderer` | Renderer dev server only |
| `npm run dev:electron` | Launch Electron against the current build |

Type-check with `npx tsc --noEmit -p <core|shared|shell|plugins|scripts|tests>`.
Always pass `--noEmit`: the tsconfigs don't set an output directory yet, so a
bare `tsc -b` writes `.js` files next to the sources. The shell and tests
projects currently report errors from stale imports left by the restructure
(see [docs/todo.md](docs/todo.md)); the root `tsc --noEmit -p .` checks no
files because it only holds project references.

## Project layout

```
tessera-types/       @tessera/types: shared interfaces (no implementation)
tessera-ui/          @tessera/ui: the curated Material UI components plugin
                      views may use (renderer only; the shell provides it)
core/                 Platform-free application core (see Architecture)
shared/               Cross-process contracts
shell/main/           Electron main process: composition root and adapters
shell/preload/        window.api bridge
shell/renderer/       React host and view loading
scripts/dev.mts       Development launcher used by npm run dev
scripts/build-plugins.mts  Builds bundled plugins from plugins/ into modules/
scripts/anonymise.mts Takes the personal data out of real statement files (npm run anonymise)
tests/                Vitest suites, mirroring the source folders, plus
                      architecture boundary tests and fixtures
docs/                 Plugin guide, design notes and open-work list
packages/             Libraries plugins bundle: storage-kit (the shared half
                      of every storage backend), and the Finance plugins'
                      published contracts, ledger-api, accounts-api,
                      import-api and export-api
plugins/              Source of bundled (built-in) plugins, one folder each:
                      accounts (accounts and the navigator), app-state
                      (application state), ledger (ledger files
                      and sub-ledgers), import (File › Import…),
                      format-ofx (OFX, QFX and QBO files),
                      format-csv (CSV files) and format-qif (QIF files
                      from banks, Quicken and Money): one plugin per file
                      type, which reads it and writes it, export
                      (File › Export…, Accounts › Export Account…),
                      storage-sqlite (the default
                      storage engine), storage-loki (LokiJS storage
                      engine), test-layout (exercises every layout
                      slot) and settings-inspector (Tools › Settings
                      Inspector…, a developer's view of the settings)
modules/              Build output of plugins/ (gitignored); loaded at startup
samples/statements/   Sample bank statements to import by hand, with walkthroughs (importing, matching)
```

## Documentation

- [docs/plugin-creation.md](docs/plugin-creation.md): how to write a plugin
  and connect it to the framework
- [docs/layout-controller-design.md](docs/layout-controller-design.md): the
  layout controller: slots, bars, `shell.bar.items`, commands and persistence
- [docs/account-manager-design.md](docs/account-manager-design.md): design
  of the first Finance feature: ledgers and sub-ledgers, accounts,
  transactions, the register and reconciliation; with its
  [implementation outline](docs/account-manager-implementation.md)
- [docs/import-manager-design.md](docs/import-manager-design.md): the design
  and implementation plan for importing statements (phases 0 to 2 done): the
  `import.formats` extension point for file-format plugins, choosing the
  account (and remembering it), fuzzy matching against entered transactions,
  and accepting or changing matches in the register
- [docs/import-file-types-design.md](docs/import-file-types-design.md): the
  five file types Tessera imports (CSV, OFX, QFX, QBO, QIF) in one place: how
  importing works, exactly how each type is read, and what is left to do
- [docs/export-design.md](docs/export-design.md): the design and plan for
  exporting to the same five file types (phases X1 to X3 done: the export
  plugin, CSV, QIF, and OFX, QFX and QBO)
- [docs/vault-design.md](docs/vault-design.md): the earlier proposal for
  pluggable storage, importers and file handling; its session half is
  superseded by the account manager design
- [docs/storage-api-design.md](docs/storage-api-design.md): proposed
  `Store` API that storage backends implement and domain plugins use (the
  lower-level `StorageEngine` it would build on already exists)
- [docs/settings-design.md](docs/settings-design.md): the settings
  framework: plugins own their settings' shape and pages, the shell owns
  storage, the Options dialog and the edit lifecycle
- [docs/theming-design.md](docs/theming-design.md): proposed move to
  Material UI components and icons (`@tessera/ui`), and a theme manager that
  follows the system light or dark setting, with plugin themes and per-window
  overrides
- [docs/font-roles-design.md](docs/font-roles-design.md): font roles (the kinds
  of text Tessera styles separately), a Fonts page in the Options dialog, and
  fonts in themes; phases 1 to 5 are done (the roles, their use throughout,
  the setting, the Fonts page, and fonts in themes)
- [docs/backup-restore-design.md](docs/backup-restore-design.md): backing up
  and restoring ledgers: snapshots by the storage engine, File › Back Up
  Ledger… and Restore Ledger…, retention, backing up on close, a two-pass quit,
  and one long operation at a time; phases 0 to 4 are done (the spike,
  snapshots in the engines, Back Up with retention, Restore, the Backups page
  with backing up on close and the two-pass quit)
- [docs/ledger-compaction-design.md](docs/ledger-compaction-design.md):
  archiving a ledger (ledger compaction): File › Archive Ledger… keeps a copy
  as an archive file, removes the settled transactions before a date (and
  closed accounts left with nothing), carries their total into each account's
  opening balance so every balance stays the same, and shrinks the file; phases
  0 to 4 are done (the spike, the archive contract with the accounts rules,
  imports following the archive, opening an archive file read-only, and the
  Archive Ledger command with its dialog and the Archiving page;
  `npm run sample:archive` makes a sample to try), and so is phase 5's
  compaction (shrinking the file); committing large batches off the main
  thread is still to do
- [docs/todo.md](docs/todo.md): known gaps and planned work

## License

[MIT](LICENSE) © 2026 Tim Almdal
