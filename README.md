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

- **Importing statements** (the `import` plugin, with `import-ofx`): *File › Import…*
  imports bank and card statements into their accounts:
  - OFX and QFX files, from Microsoft Money or Quicken downloads;
  - the account is found by a remembered match or its number, or the user picks it,
    or creates it from the statement;
  - the same bank line is never added twice, even across overlapping files;
  - lines the user already entered are matched to them, fuzzily, by date, amount
    and payee, and proposed for review. The register shows the bank's version
    under each row, with **Accept** and **Change…**; the Change Match dialog moves
    a line to another transaction, unmatches it or leaves it out. The rest is
    added as new, and acknowledged the same way;
  - how the bank writes a payee is learnt from the user's choices, for matching
    and for new lines.

  Other file types are plugins of their own
  ([how](docs/plugin-creation.md#adding-an-import-format),
  [design](docs/import-manager-design.md)). There are sample statements to try in
  [samples/statements](samples/statements/).

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
- **Storage and application state:** a `StorageEngine` interface
  (collections, queries, transactions) with SQLite (the default) and LokiJS
  implementations, and an
  `app-state` plugin that keeps window, theme and per-window layout state on
  top of it, exposed to views over IPC (`app.state:get`, `:set`, `:update`,
  `:remove`).
- **Theming and Material UI:** the shell's components and icons are
  [Material UI](https://mui.com/), and plugins reach them only through
  `@tessera/ui` (never `@mui/*`), which the shell shares with plugin views. A theme
  manager follows the operating system's light or dark setting (View ▸ Theme to
  choose a theme, with a preview, or override it, for the application or one window), plugins can
  contribute themes (`shell.themes`, checked for contrast) and icons
  (`shell.icons`, fetched when first drawn), a window can use a theme of its own,
  the choice is saved, and a window stays hidden until its theme is applied. See [docs/theming-design.md](docs/theming-design.md) and
  [Styling and theming](docs/plugin-creation.md#styling-and-theming).
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
          lifecycle, events), StorageEngine and AppState. The core implements
          them, the shell composes them, and plugins are written against them.
shared/   Contracts any process may import: IPC envelope guards, manifest
          schema, menu, view and layout contracts, enablement expressions. No
          platform code.
core/     Main-process application core: plugin manager, plugin context,
          and the registry implementations (IPC, extensions, commands,
          context keys, services, lifecycle, events), the layout controller
          (LayoutService) and the storage engine registry and transaction
          manager. Depends only on tessera-types/,
          shared/ and its own ports.
shell/
  main/       Composition root and adapters: Electron menu, IPC binding,
              layout wiring (commands, keys, menus, persistence),
              file-system plugin source, tessera-plugin:// protocol.
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
| Lifecycle | run code once everything has started, or before quitting | `context.lifecycle.onShuttingDown` |

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
tests/                Vitest suites, mirroring the source folders, plus
                      architecture boundary tests and fixtures
docs/                 Plugin guide, design notes and open-work list
packages/             Libraries plugins bundle: storage-kit (the shared half
                      of every storage backend), and the Finance plugins'
                      published contracts, ledger-api, accounts-api and
                      import-api
plugins/              Source of bundled (built-in) plugins, one folder each:
                      accounts (accounts and the navigator), app-state
                      (application state), ledger (ledger files
                      and sub-ledgers), import (File › Import…) and
                      import-ofx (OFX and QFX statements), storage-sqlite (the default
                      storage engine), storage-loki (LokiJS storage
                      engine) and test-layout (exercises every layout
                      slot)
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
- [docs/vault-design.md](docs/vault-design.md): the earlier proposal for
  pluggable storage, importers and file handling; its session half is
  superseded by the account manager design
- [docs/storage-api-design.md](docs/storage-api-design.md): proposed
  `Store` API that storage backends implement and domain plugins use (the
  lower-level `StorageEngine` it would build on already exists)
- [docs/settings-design.md](docs/settings-design.md): proposed settings
  framework where plugins own their settings shape and pages
- [docs/theming-design.md](docs/theming-design.md): proposed move to
  Material UI components and icons (`@tessera/ui`), and a theme manager that
  follows the system light or dark setting, with plugin themes and per-window
  overrides
- [docs/todo.md](docs/todo.md): known gaps and planned work

## License

[MIT](LICENSE) © 2026 Tim Almdal
