# Implementation outline: the account manager

| | |
|---|---|
| **Status** | Phases 0–2 done, phase 3 all but the home view, phases 4 (the register) and 5 (reconciliation) done ([phase 0](#phase-0-results), [phase 1](#phase-1-results), [accounts](#accounts-results-phase-2-accounts-half-and-most-of-phase-3), [transactions and register](#transactions-and-register-results-phase-2-transactions-half-and-phase-4), [reconciliation](#reconciliation-results-phase-5) results). Next: the home view, then phase 6. Review decisions of 2026-11-04 applied (Ledger and Sub-ledger with one *New Ledger…*, SQLite default, delete to trash, Money-style balances, no encryption) |
| **Date** | 2026-11-04 |
| **Design** | [account-manager-design.md](account-manager-design.md). Read it first; this note says *how and in what order*, the design says *what and why* |

## Ground rules

- **Every phase ends with a working app and a green `npm test`.** No phase
  leaves a menu item that does nothing. A command without its feature isn't
  registered yet, so its item doesn't exist yet.
- **Tests mirror the source folders**, as today: `tests/main/…` for shell
  main code, `tests/renderer/…` for the shell renderer,
  `tests/plugins/<id>/…` for plugins.
- **Domain logic is tested against the memory engine**
  (`new KitStorageEngine(memoryDriver())` from `@tessera/storage-kit`), with
  no Electron. Plugin activation is tested the way
  [tests/plugins/testLayoutSample.test.ts](../tests/plugins/testLayoutSample.test.ts)
  does it: `createPluginRuntime` plus the plugin's real `activate`.
- **Renderer components are tested with Testing Library** and a fake bridge
  ([tests/helpers/fakeBridge.ts](../tests/helpers/fakeBridge.ts)).
- **The architecture test must keep passing**: plugins import only
  `@tessera/*`, their own files and npm packages, and renderer code uses
  theme tokens, never literal colours.
- **Type-check what you touch** with `npx tsc --noEmit -p plugins` (and
  `-p shell` / `-p tests` for shell work). Those projects have known stale
  errors (todo.md), so *don't add new ones*.
- **Each phase ends with a manual smoke test** in `npm run dev`. There is no
  e2e suite yet. The checklists below are the minimum.
- Sizes are relative: **S** is about a day, **M** a few days, **L** about a
  week, for someone who knows the codebase.

## Dependency graph

```
Phase 0 ──► Phase 1 ──► Phase 2 ──► Phase 3 ──► Phase 4 ──► Phase 5
(shell)     (ledger)    (domain)    (manager UI) (register)  (reconcile)
   │                       ▲
   └── 0.1 API packages ───┘  Phase 2's domain work needs only 0.1 and Phase 1's LedgerSession
                              interface, so it can start in parallel with the rest of Phase 1,
                              against a fake session. Its participant test needs the real
                              sub-ledger delete, so it lands once Phase 1 is done.
```

---

## Phase 0: framework prerequisites (shell)

Generic additions. Nothing here mentions ledgers or accounts.

### 0.1 API packages (S)

| Task | Files |
|---|---|
| Create `packages/ledger-api/` (`package.json` name `@tessera/ledger-api`, `index.ts`) and `packages/accounts-api/` the same way. Each is empty apart from a version constant for now | `packages/ledger-api/*`, `packages/accounts-api/*` |
| Alias both like `@tessera/storage-kit` | `tsconfig.base.json` (`paths`), `vitest.config.ts`, `scripts/build-plugins.mts` (privileged alias map, **and** the renderer `resolve.alias`, which today aliases only `@tessera/types`) |
| Architecture test: both packages are platform-free and import only `@tessera/types` (and, for accounts-api, `@tessera/ledger-api`) | `tests/architecture/boundaries.test.ts` |
| Build test: a plugin importing a value (not only a type) from an API package builds in both halves | `tests/main/buildPlugins.test.ts` |

### 0.2 `shell.files` service (S)

| Task | Files |
|---|---|
| Interface `ShellFiles`: `showOpenDialog`, `showSaveDialog` (`{ title, defaultPath, filters }` → `string \| undefined`), `exists(path)`, `trash(path)`, `documentsPath()` | `tessera-types/files.ts`, export from `tessera-types/index.ts` |
| Electron adapter: dialogs parented to the focused window; `trash` through `shell.trashItem` | `shell/main/files/electronFiles.ts` |
| Provide as `shell.files` from the shell context **before** `pluginManager.activateAll()`, so `planActivation` counts it as available | `shell/main/app.ts` |
| Tests with the Electron mock: cancel → `undefined`; filters passed; `trash` called with the path | `tests/main/electronFiles.test.ts`, extend `tests/setup/mockElectron.ts` (`dialog.showOpenDialog`, `showSaveDialog`, `shell.trashItem`) |
| Test that a plugin requiring `shell.files` activates | `tests/core/activationPlan.test.ts` (a case for a shell-provided service) |

### 0.3 `shell.prompts` service: `confirm` and `message` (S)

| Task | Files |
|---|---|
| Interface `ShellPrompts` with `confirm(ConfirmOptions): Promise<boolean>`, `message(...)`, and `show(...)` (0.4) | `tessera-types/prompts.ts` |
| Electron adapter over `dialog.showMessageBox`: Cancel is the default and cancel button; `destructive` puts the confirm label first on Windows/Linux conventions | `shell/main/prompts/electronPrompts.ts` |
| Provide `shell.prompts` before activation | `shell/main/app.ts` |
| Tests: button order, default/cancel ids, result mapping | `tests/main/electronPrompts.test.ts` |

### 0.4 `shell.dialogs` extension point and dialog host (M)

The theme chooser's pattern, made generic.

| Task | Files |
|---|---|
| Contract: `DIALOGS_EXTENSION_POINT = 'shell.dialogs'`; contribution `{ id, title, module }`; `DialogProps<TInput, TResult> = { input, close(result?) }` (in `@tessera/types`, because plugin renderers need it); channels `shell:dialog.open` (event) and `shell:dialog.close` (request) | `shared/dialogs/types.ts`, `tessera-types/dialogs.ts` |
| Resolver: validate contributions (id prefix, `module` starts with `./`, plugin has a renderer) and produce descriptors with `remoteEntry`, as views do | `shared/dialogs/resolveDialogs.ts` |
| Main: `show(dialogId, input)` creates a request id, publishes `shell:dialog.open { windowId, requestId, dialog, input }` to the focused window, and resolves on `shell:dialog.close { requestId, result }`. It resolves `undefined` when the window closes or the renderer reports a load failure. Requests from another window's `close` are rejected | `shell/main/dialogs/dialogsHost.ts`, wired in `shell/main/app.ts` |
| Renderer: `DialogHost` listens for opens addressed to this window, queues them, loads the module with `createFederationViewLoader`'s federation, renders it in an error boundary, and sends the result on `close`. Mounted beside `ThemeChooser` | `shell/renderer/dialogs/DialogHost.tsx`, `shell/renderer/main.tsx` |
| Tests: resolver diagnostics; main host resolves, times out on window close, ignores foreign windows; renderer host queues two dialogs, passes `input`, reports failure | `tests/shared/dialogs.test.ts`, `tests/main/dialogsHost.test.ts`, `tests/renderer/dialogHost.test.tsx` |
| Fixture: a minimal dialog in `tests/fixtures/ui-plugins/themed` (or a new fixture) built by `buildUiFixture` | `tests/fixtures/…` |
| Plugin guide section "Contributing dialogs" | `docs/plugin-creation.md` |

### 0.5 `@tessera/ui` additions (S)

| Task | Files |
|---|---|
| Export `TextField`, `Autocomplete`, `Checkbox`, `Menu`, `MenuItem`, `List`, `ListItemButton`, `ListItemIcon`, `ListItemText`, `Collapse`, `Tooltip`, `InputAdornment`, `Table`, `TableHead`, `TableBody`, `TableRow`, `TableCell`, `TableContainer` | `tessera-ui/index.ts` |
| Update the curated-exports list; bump `TESSERA_UI_VERSION` and `tessera-ui/package.json` (minor, since the change is additive) | `tests/shared/tesseraUi.test.ts`, `tessera-ui/version.ts` |
| Add standard icons the views use (`Folder`, `CreditCard`, `Savings`, `ShowChart`, `MoreVert`, `Check`, `Block`) | `tessera-ui/standardIcons.ts`, `IconName` in `tessera-types/icons.ts`, `tests/shared/standardIcons.test.ts` |
| Plugin guide: extend the component list | `docs/plugin-creation.md` |

### 0.6 SQLite as the default storage engine (S)

Decided in review. Both storage plugins stay bundled; the bootstrap file
still has the last word.

| Task | Files |
|---|---|
| `BUILT_IN_PREFERRED_PLUGINS = ['storage-sqlite']`. `toPluginSelection` appends it after the user's `preferredPlugins`, skipping ids the user already listed or disabled | `shell/main/bootstrap/bootstrapConfig.ts` |
| Tests: no bootstrap file → `preferred` is `['storage-sqlite']`; a user preferring `storage-loki` → `['storage-loki', 'storage-sqlite']` (Loki wins); disabling `storage-sqlite` removes it from `preferred` | `tests/main/bootstrapConfig.test.ts` |
| Smoke test: the real pipeline with the shell's default selection picks `storage-sqlite` and skips `storage-loki` with a warning. The existing cases that pass `preferred` explicitly stay as they are | `tests/plugins/pipeline.smoke.test.ts` |
| Docs: the storage note's *Configuration tiers* and *Pluggable backends* name SQLite as the default; README's "Services" and "Project layout" say the same. Note in the storage note that app state starts fresh once (`app.loki.json` is ignored) | `docs/storage-engine-redesign.md`, `README.md` |

**Exit criteria:** all tests green. A throwaway command in `test-layout`
(removed after the check) can open a save dialog, a confirm box, and a
contributed dialog, and receive each result. A fresh user-data folder
(`--user-data-dir`) gets `storage/app.sqlite`, and the log shows
`storage-loki` skipped.

### Phase 0 results

Done on 2026-11-04. What was built, and where it differs from the tasks above:

| Piece | Where | Notes |
|---|---|---|
| `@tessera/ledger-api` | `packages/ledger-api/` | The whole contract: `LedgerSession` (files and the sub-ledger tree), `SubLedgerParticipant`, `SchemaContribution`, `Migrator`, `LedgerErrorCode` with `Result`/`ok`/`fail`, and every id, command, key, channel, event, view and dialog name, plus the dialogs' input and result types. The state event is `ledger:state.changed` (`ledger:state` is the request) |
| `@tessera/accounts-api` | `packages/accounts-api/` | Types and constants: the model (with `ACCOUNT_CLASS`, the Money-style `AMOUNT_COLUMNS`, `STATUS_LETTERS`), `AccountsService`, `TransactionManager`, reconciliation, `ReconcileActionContribution`, errors and protocol. **The money helpers are not here yet**: they are behaviour, and stay phase 2's first task, test-first |
| Aliases and guards | `tsconfig.base.json`, `vitest.config.ts`, `scripts/build-plugins.mts` (both halves) | Architecture test: the packages import only `@tessera/types` (and accounts-api, ledger-api). Contract tests hold every name to the plugin's prefix |
| Plugin-facing types | `tessera-types/dialogs.ts` | `ShellPrompts`, `ShellFiles`, `DialogContribution`, `DialogProps`, and the service and extension point ids. One file rather than a separate `files.ts` |
| `DialogService` | `core/dialogs/` | Platform-free. Holds a request until its window's renderer is ready (an earlier event would be lost), sends it again if the page reloads, accepts an answer only from that window, and resolves `undefined` when the window closes |
| Electron adapters | `shell/main/dialogs/` | `shell.prompts` over `dialog.showMessageBox`; `shell.files` over the file dialogs and `shell.trashItem`. Both provided from `app.ts` before plugins activate |
| Dialog host | `shell/renderer/dialogs/` | Mounted beside the theme chooser. The **shell draws the frame** (title, size, Escape, clicking outside); the plugin's component draws `DialogContent` and `DialogActions` |
| `@tessera/ui` 1.1.0 | `tessera-ui/` | The planned components plus `FormHelperText` and prop types; icons as planned plus `Delete`, `Edit`, `Error`, `Warning` |
| SQLite default | `core/plugins/PluginManager.ts`, `shell/main/bootstrap/bootstrapConfig.ts` | A new `defaultPreferred` tier in the plugin selection, ranked after the user's `preferredPlugins`, rather than appending to the user's list: that would have warned "the bootstrap configuration names storage-sqlite" in builds without it |

Additions beyond the plan, each small:

- **`shell.prompts.prompt`**: a line of text, shown by a dialog built into the
  shell's renderer (the first `shell.dialogs` contribution, `shell.prompt`).
  It asks for a sub-ledger's name, for example, without a plugin dialog.
- **`DialogProps.setBusy`**: while saving, Escape and clicking outside don't
  close the dialog, as the theme chooser already did for itself.
- **Dialog ids must start with the contributor's id**: any plugin can open a
  dialog by id, so a plugin must not be able to take over another's.
- **`registerWindowReady` takes several listeners**, so the dialog service
  hears the same ready signal as the window reveal.

Verification:

- `npm test`: 1163 passed. The 4 failures are the same environmental
  failures as before the change: a Windows path test on Linux, a Loki test
  that needs to create `/unused`, and a federation build-output check for a
  newer `@module-federation/vite`. Tests added: `tests/packages/`,
  `tests/shared/dialogs.test.ts`, `tests/core/dialogService.test.ts`,
  `tests/main/{electronPrompts,electronFiles,registerDialogs}.test.ts`,
  `tests/renderer/dialogHost.test.tsx` (including a dialog loaded through
  real module federation from the `themed` fixture), and a round trip
  through the composed `app.ts` in `tests/main/app.test.ts` (a plugin
  requiring both services asks for a dialog, and the window's answer comes
  back to it).
- The main, preload and renderer bundles build, and so do the bundled
  plugins.
- `tsc --noEmit` reports no new errors apart from the "no declaration file
  for module 'react'" family, which every `.tsx` file already has because
  `@types/react` isn't a dependency (see todo.md). With React's types
  installed temporarily, the new renderer files type-check cleanly.

**Still to do by hand:** the exit criterion's check in the running app, in
`npm run dev`. Electron couldn't be downloaded where phase 0 was built. In
particular: a fresh `--user-data-dir` gets `storage/app.sqlite`; a
confirmation's buttons and default are right on Windows; a contributed
dialog opens, takes focus, and returns its result.

---

## Phase 1: the `ledger` plugin (L)

The ledger file *and* its sub-ledger tree. Sub-ledgers belong here because
*New Ledger…* creates them (design, decision 1a).

### Files

```
packages/ledger-api/index.ts          LedgerSession, LedgerInfo, LedgerChange, LedgerTree, SubLedger,
                                      SubLedgerParticipant, NewLedgerTarget, SchemaContribution, Migrator,
                                      LedgerErrorCode, Result, LEDGER_SCHEMA_POINT, COMMANDS, CONTEXT_KEYS,
                                      CHANNELS, EVENTS, DIALOGS, FILE_EXTENSION
plugins/ledger/
├── manifest.json                     id "ledger"; requires storage.engine, app.state, shell.files, shell.prompts;
│                                     provides ledger.session; renderer.expose { "./StartView", "./NewLedgerDialog",
│                                     "./RenameDialog" }
└── src/
    ├── privileged/
    │   ├── index.ts                  activate: wiring only (commands, menus, views, dialogs, IPC, lifecycle)
    │   ├── LedgerSessionImpl.ts      create / open / close / delete, events, onWillClose
    │   ├── SubLedgers.ts             the tree: create, rename, move (cycle check), delete with participants
    │   ├── newLedger.ts              the ledger.new flow: dialog or not, file or sub-ledger, close confirmation
    │   ├── schema.ts                 reads ledger.schema contributions, validates prefixes, builds the union
    │   │                             (plus ledger's own ledger.subledgers)
    │   ├── migrations.ts             version comparison, backup, running migrators in order
    │   ├── probe.ts                  exists + header sniff + read-only meta check
    │   ├── scopedDatabase.ts         Database and Transaction wrappers limiting names to '<contributor>.'
    │   └── recent.ts                 recent list and last ledger in app.state
    └── renderer/
        ├── StartView.tsx             New / Open / recent list (open, remove from list, delete to trash)
        ├── NewLedgerDialog.tsx       Name + Parent ledger (None, or the open ledger's tree)
        └── RenameDialog.tsx          rename a sub-ledger
```

### Tasks

1. **Contract** in `@tessera/ledger-api`, exactly as in the design.
2. **`probe.ts`**: `exists`; read the first 16 bytes, classify as
   `sqlite | json | unknown`, and compare with `engine.id` to produce a
   friendly error; open `{ readOnly: true }`, read `ledger.format`, **close**.
   The engine caches databases by path, so a later read-write open would
   otherwise return the read-only handle.
3. **`schema.ts`**: collect `ledger.schema` contributions and reject any whose
   collection names lack `<id>.`, or whose version isn't a positive integer,
   with `[ledger]` warnings. Add `ledger.subledgers` (`byParent [parentId,
   order]`, unique `[parentId, nameKey]`) as part of the ledger format.
4. **`LedgerSessionImpl`**:
   - `create`: if a ledger is open, confirm "Close “X” and create a new
     ledger?" (Cancel stops); save dialog suggesting `<name>.tessera`; if
     the file exists, trash it; close current; open with schema; write meta;
     migrate every contributor from 0; publish.
   - `open`: open dialog; same-path no-op; probe; version checks (newer →
     refuse; older → `fs.copyFile` backup, then migrate); close current;
     open; publish.
   - `close`: `onWillClose` listeners (awaited, errors logged), `flush`,
     `close`, clear keys, publish.
   - `delete(path?)`: confirm, naming the file and the Recycle Bin / Trash;
     close if open; send the file and any `-wal`/`-shm` side files to the
     trash through `shell.files.trash`; remove from recent. Never
     `engine.drop`.
   - `database(contributor)`: the scoped wrapper (also wraps `tx.collection`
     inside `transaction`).
   - Publish means: context keys `ledger.isOpen`, `ledger.isReadOnly`,
     `ledger.name`; event `ledger:state.changed`; `onDidChange` listeners.
5. **`SubLedgers.ts`**: `tree`, `createSubLedger`, `renameSubLedger`
   (`expectedRev`), `moveSubLedger` (rejects `CYCLE`, keeps `order`
   dense), `deleteSubLedger`. Delete is one `db.transaction`: each
   participant's `reparent` with a `tx` scoped to that participant, then the
   child sub-ledgers move up (renaming " (2)", " (3)"… on clashes), then the
   record is deleted. `participate(contributor, participant)` returns a
   disposable. Publish `onDidChangeTree` and `ledger:tree.changed` after
   commit.
6. **`newLedger.ts`**, the `ledger.new` command with its optional
   `{ parentId }` argument:
   - no ledger open → `create()` directly;
   - otherwise `shell.prompts.show('ledger.dialog.new', { tree, parentId })`,
     with the parent preselected from the argument, or **None** without one;
   - the dialog creates a sub-ledger itself through
     `ledger:subLedger.create` (showing `DUPLICATE_NAME` inline) and closes
     with `{ kind: 'subLedger', id }`, or closes with
     `{ kind: 'file', name }`, and the command then calls `create()` with the
     name.
7. **Dialogs** contributed to `shell.dialogs`: `ledger.dialog.new`,
   `ledger.dialog.rename`.
8. **Commands and menus**: `ledger.new`, `ledger.open` (`CmdOrCtrl+O`),
   `ledger.close`, `ledger.delete`, in groups `ledger.file` and
   `ledger.danger` in `shell.file`, both above the shell's Exit group.
   `ledger.subLedger.rename { id }` and `ledger.subLedger.delete { id }`
   have no menu items of their own: `accounts` runs them (phase 3). Until
   then they are exercised by tests.
9. **Views and items**: `ledger.start` in `shell.main` with
   `when: '!ledger.isOpen'`; a `shell.bar.items` text item
   `Ledger: {ledger.name}` in `shell.bottom` with `when: 'ledger.isOpen'`.
10. **IPC**: for the start view `ledger:state`, `ledger:recent`,
    `ledger:recent.remove`, `ledger:open { path }` and `ledger:delete { path }`
    (each runs the same path as its command); for the dialogs `ledger:tree`,
    `ledger:subLedger.create` and `ledger:subLedger.rename` → `Result<…>`.
11. **Lifecycle**: `onStarted` reopens `ledger.last` if it exists (errors go to
    `ledger:state.error`, not a modal); `onShuttingDown` closes. Push every
    disposable onto `context.subscriptions`.

### Tests (`tests/plugins/ledger/`)

| File | Covers |
|---|---|
| `session.test.ts` | create → open → close → reopen round trip on the memory driver; schema applied (including `ledger.subledgers`); undeclared collection rejected; other contributors' existing collections left alone; `database('x')` refuses `'y.things'`, including inside `transaction` |
| `subLedgers.test.ts` | create at the root and nested; sibling names unique ignoring case, including at the root (`parentId: null`); rename conflicts; move into self or a descendant → `CYCLE`; delete moves child sub-ledgers up with suffixes; two fake participants are called inside one transaction with scoped `tx`s; a participant that throws rolls back everything, the participants' writes included; disposed participants aren't called |
| `newLedger.test.ts` | **with a parent: a sub-ledger is created and no file, no close, no save dialog**; with None and a ledger open: the close confirmation is asked, Cancel changes nothing, Accept closes then creates; with no ledger open: no dialog, straight to the save dialog; the `parentId` argument preselects; without it, None is preselected |
| `migrations.test.ts` | from-0 seeding on create; older file → backup, then migrators in order, then versions recorded; newer file refused and left untouched; a throwing migrator leaves the ledger closed and the backup in place |
| `probe.test.ts` | missing file is not created; non-ledger SQLite/JSON files refused without being modified; engine mismatch message |
| `commands.test.ts` | activation with fake `shell.files`/`shell.prompts`: enablement follows `ledger.isOpen`; cancelled dialogs change nothing; delete asks, then calls `trash` (never `engine.drop`) for the file and its side files, and updates recent |
| `startup.test.ts` | reopen-last when present; missing file → start view error, no throw |
| `StartView.test.tsx`, `NewLedgerDialog.test.tsx` | recent list renders, missing entries marked, buttons invoke the right channels; the dialog lists None plus the tree, shows `DUPLICATE_NAME` on the name, and closes with the right result for each choice |

Add a file-level test against the real SQLite driver: create, write, close,
reopen, then a read-only probe of a foreign SQLite file leaves it
byte-identical.

**Exit criteria (manual):**
- File › New Ledger… with nothing open creates `My Finances.tessera`. The
  start view disappears and the status bar shows the name.
- New Ledger… again, with parent *My Finances* and name *Business*: no file
  appears on disk (check the folder), and `ledger:tree` lists the
  sub-ledger (DevTools; the navigator comes in phase 3).
- New Ledger… with parent *None*: it asks to close *My Finances*, then
  creates the new file.
- Close, then reopen from the start view's recent list. Restart the app and
  the ledger reopens.
- Delete Ledger… asks, then the file is in the Recycle Bin / Trash and can
  be restored from there and reopened.
- Opening a random `.json` or `.sqlite` file is refused and the file is
  unchanged.

### Phase 1 results

Done on 2026-11-04. The plugin is `plugins/ledger/` (id `ledger`), built like the others into `modules/ledger/`.

| Piece | File | What it does |
|---|---|---|
| Session | `privileged/LedgerSessionImpl.ts` | `ledger.session`. File operations run one at a time. Open checks before it closes anything: the file exists, its first bytes match the engine, and a **read-only** open finds `ledger.format`. Only then does the open ledger close. Create asks to close the open ledger, then shows the save dialog, then trashes any file it replaces. Close forgets the last ledger; quitting remembers it |
| Sub-ledgers | `privileged/SubLedgers.ts` | Create, rename (`expectedRev`), move (cycle check, dense reordering) and delete, each one storage transaction. Delete calls every participant, deletes the record, then moves its children up, renaming clashes " (2)" |
| `ledger.schema` manager | `privileged/SchemaRegistry.ts` | Validates contributions: the id is the contributor, names are prefixed, the version is whole, the migrator is a service id. Warns once per problem. Adds the ledger's own `ledger.subledgers` |
| Migrations | `privileged/migrations.ts` | Plans before anything is written: a newer file is refused, and a backup is needed only when existing data changes. Runs one version at a time, recording each |
| Scoped database | `privileged/scopedDatabase.ts` | A contributor's view: its own collections, meta keys and change events; it can't close the database |
| Disk | `privileged/disk.ts` | Existence, header sniff (`sqlite`/`json`/`empty`/`unknown`), side files (`-wal`, `-shm`, `-journal`, `~`) and backups that never overwrite. A port, so the session is tested on the memory engine |
| Recent ledgers | `privileged/RecentLedgers.ts` | `ledger.recent` and `ledger.last` in `app.state`, read defensively |
| Commands, IPC, contributions | `privileged/commands.ts`, `ipc.ts`, `contributions.ts`, `index.ts` | As designed; failures the user caused go to a message box. The service is a facade with exactly the `LedgerSession` members |
| Views and dialogs | `renderer/StartView.tsx`, `LedgerTree.tsx`, `NewLedgerDialog.tsx`, `RenameDialog.tsx` | The dialogs save through IPC and show `DUPLICATE_NAME` and `CONFLICT` on the field, staying open |

Differences from the plan:

- **A Ledger panel (`ledger.tree`) in the left bar.** It wasn't in the plan, which left sub-ledgers invisible until
  the accounts navigator in phase 3. The panel makes them usable now. Phase 3 should hide it once the navigator
  shows the same tree (see the design note).
- **`@tessera/ledger-api` gained:**
  - `LedgerError`, `isLedgerError` (a shape check, since `instanceof` fails across plugins' copies) and `toResult`;
  - the name rules and tree helpers (`validateLedgerName`, `nameKey`, `uniqueName`, `childrenOf`, `descendantIds`,
    `flattenTree`, `pathOf`);
  - the `FILE_NOT_FOUND` and `MIGRATION_FAILED` codes;
  - `create(path, { name })`, `RecentLedger.exists`, the `ledger:recent.changed` event and the `ledger.tree` view id.
- **Dialogs start in the most recently opened ledger's folder**, even after *Close Ledger* has cleared the ledger
  to reopen at start-up.
- **`createdWith` records the ledger API version** (`ledger 1.0.0`), because plugins aren't told the application's
  version.
- **The plain plugin-build tests (`tests/main/buildPlugins.test.ts`) allow 60 s**, like the UI build tests
  already did. With the ledger's pipeline test building in parallel, their 5 s default timed out.

Verification:

- **`npm test`:** 1256 passed, with the same 4 environmental failures as before phase 0. The new tests, in
  `tests/plugins/ledger/` and `tests/packages/ledgerApi.test.ts`:
  - sub-ledger rules, including rollback when a participant fails;
  - the session's file lifecycle on the memory engine;
  - real SQLite files: a foreign SQLite file stays byte-identical, a missing file is never created, and backups
    and trashing include side files;
  - the plugin activated on a runtime: contributions resolve with no diagnostics, and the commands, IPC, events
    and lifecycle work;
  - the renderer components;
  - **the built plugin** loaded by the real plugin manager next to the real SQLite and app-state plugins, across
    two simulated runs of the app.
- **Builds:** every bundled plugin builds.
- **Type-checks:** `tsc --noEmit -p plugins/ledger` is clean with React's types installed. Without them, the
  repo-wide "no declaration file for 'react'" errors are the only ones.

**Still to do by hand, in `npm run dev`:**
- New Ledger with nothing open, then with a parent, then with None;
- rename and delete sub-ledgers from the Ledger panel;
- restart, and the ledger reopens;
- Delete Ledger puts the file in the Recycle Bin;
- opening a `.json` file is refused.

---

## Phase 2: the `accounts` domain, no UI (L)

Can start alongside Phase 1 against a fake `LedgerSession` that returns a
memory-engine `Database` and a fixed sub-ledger tree. Sub-ledgers are
`ledger`'s; `accounts` only places accounts in them and takes part in
deleting them.

### Files

```
packages/accounts-api/
├── index.ts            re-exports
├── model.ts            AccountType, ACCOUNT_CLASS, Account, Transaction, ClearingStatus,
│                       Payee, Category, Chart, RegisterSnapshot, AccountBalances, drafts and patches
├── service.ts          AccountsService, TransactionManager, ReconciliationService, WriteOptions, Confirmation
├── errors.ts           AccountsErrorCode, Result<T>
├── money.ts            parseAmount(text, currency) → minor units; formatAmount (signed balances, unsigned
│                       column amounts, as Money); isNegative for red styling; minorDigits(currency) via Intl
├── columns.ts          column labels per account type
└── protocol.ts         CHANNELS, EVENTS, COMMANDS, CONTEXT_KEYS, VIEWS, DIALOGS, RECONCILE_ACTIONS_POINT
plugins/accounts/
├── manifest.json       id "accounts"; requires ledger.session, shell.prompts; provides accounts.service,
│                       accounts.migrator
└── src/privileged/
    ├── index.ts        activate: schema contribution, migrator service, AccountsService provision
    ├── schema.ts       the collections and indexes from the design (version 1)
    ├── migrator.ts     0 → 1: starter categories
    ├── AccountsServiceImpl.ts   accounts, moveAccount, chart (ledger tree + accounts + balances), onDidChange
    ├── participant.ts  the SubLedgerParticipant: describe ("4 accounts") and reparent
    ├── TransactionManagerImpl.ts  per-account CRUD, status, void, register with running balance
    ├── transfers.ts    create / mirror / retarget / delete / unlink for both sides, inside one transaction
    ├── payees.ts, categories.ts
    ├── balances.ts     the aggregate pipeline (one account, or all accounts for the chart)
    ├── rules.ts        validation and confirmation checks, shared by every write
    └── names.ts        nameKey
```

### Tasks, in order

1. **`money.ts` first**, pure and heavily tested: no floats anywhere. Parse
   the string's digits into an integer; accept grouping separators,
   parentheses and a leading minus; reject more fraction digits than the
   currency allows.
2. **Schema and migrator**: contribute to `ledger.schema`
   (`{ id: 'accounts', version: 1, collections, migrator: 'accounts.migrator' }`);
   seed the categories at 0 → 1.
3. **Accounts in the ledger tree**: CRUD with `subLedgerId` (checked against
   `ledger.session.tree()`; `null` = directly in the ledger), `nameKey`
   uniqueness across the ledger (map the storage `UNIQUE_VIOLATION` to
   `DUPLICATE_NAME`), `moveAccount` with `order` handling, close/reopen, and
   currency change only without transactions. Opening balances of
   liabilities are entered as amounts owed and stored negative.
4. **Participant**: register with `ledger.session.participate('accounts', …)`.
   `reparent(tx, from, to)` moves accounts with `subLedgerId == from` to `to`,
   using only the given `tx`. `chart()` merges `tree()` with accounts and
   per-currency totals per sub-ledger; `onDidChangeTree` triggers a
   `chart: true` change.
5. **Transactions**: `create`, `update`, `delete`, `setStatus`, `setVoided`,
   with every rule from the design's rules table in `rules.ts`. Every
   multi-document write goes in one `db.transaction`, and every write sets
   `updatedAt` and passes `expectedRev`.
6. **Transfers** (`transfers.ts`): the mirror table from the design, row by
   row.
7. **`deleteAccount`**: delete transactions; unlink counterparts
   (`$unset` transfer fields and category, memo note); one transaction.
8. **Balances and register**: the aggregate for `current`, `cleared` and
   `reconciled`; `register()` = ordered `find` on `byAccountDate` plus a
   running sum that skips voided rows; the opening-balance row is added by the
   view, not stored.
9. **Payees and categories**: find-or-create by `nameKey`; `search(prefix)`
   returns the last category and amount per payee via `byPayee`.
10. **Change events**: each write returns the set of touched account ids plus
    `chart: boolean`; the service fires `onDidChange` once per committed
    operation.
11. **Session lifecycle**: drop cached managers on `ledger.onDidChange('closed')`;
    every call with no ledger open fails `NO_LEDGER`.

### Tests (`tests/plugins/accounts/`)

| File | Covers |
|---|---|
| `money.test.ts` | parse/format round trips for CAD, JPY (0 digits), BHD (3 digits); rejection cases; no float artefacts (`0.1 + 0.2` style inputs); balances signed (`-540.00`), column amounts unsigned |
| `chart.test.ts` | accounts directly in the ledger (`subLedgerId: null`) and in nested sub-ledgers; unknown sub-ledger → `NOT_FOUND`; account name uniqueness across the ledger, ignoring case; move; close/reopen; currency lock; per-currency sub-ledger totals; tree changes produce `chart: true` |
| `participant.test.ts` | against the real `ledger` session on the memory engine: deleting a sub-ledger moves its accounts to the parent (or the ledger) in one transaction, after the parent's existing accounts; `describe` counts closed accounts; a failure in `reparent` leaves sub-ledgers and accounts untouched |
| `transactions.test.ts` | CRUD; validation errors carry `field`; closed account read-only; `expectedRev` conflicts; status transitions; void keeps status and amount and is excluded from balances; unvoid restores |
| `reconciledGuards.test.ts` | every guarded change without `confirm` → `CONFIRMATION_REQUIRED` with the right reasons, including via a transfer's reconciled counterpart; with `confirm` it succeeds |
| `transfers.test.ts` | each row of the mirror table; currency mismatch; closed target; **invariant check after every operation**: pairs complete, amounts opposite, dates equal |
| `deleteAccount.test.ts` | transactions gone; counterparts unlinked with their status kept; other balances unchanged |
| `balances.test.ts` | current/cleared/reconciled with every status and voids; running balances in date-then-entry order; chart totals per currency |
| `payees.test.ts` | create on first use; case-insensitive reuse; last category and amount |
| `events.test.ts` | one `onDidChange` per operation with the right accounts; none on a failed write |
| `activation.test.ts` | real `activate` with a fake ledger session: schema contributed, services provided, `NO_LEDGER` before open |
| `scale.test.ts` | 10,000 transactions in one account: `register()` under a stated budget (e.g. 200 ms on the memory engine); skipped in CI if flaky, but recorded |

**Exit criteria:** the suite passes. No UI yet, so the manual check is a dev
IPC call from DevTools (`window.api.invoke('accounts:chart')`) after opening
a ledger.

---

## Phase 3: account manager UI (L)

### Files

```
plugins/accounts/src/
├── privileged/
│   ├── selection.ts       selection (ledger, sub-ledger or account) → accounts.selection.* keys;
│   │                      register account → accounts.register.*
│   ├── commands.ts        every Accounts-menu command (optional { id } argument; falls back to the selection);
│   │                      the sub-ledger ones delegate to ledger.new / ledger.subLedger.*
│   ├── menus.ts           the Accounts menu contributions (menu groups: accounts.account, accounts.subLedger,
│   │                      accounts.move, accounts.transaction)
│   ├── ipc.ts             chart, select, account.save, move → Result<…>; emits chart.changed
│   └── views.ts           navigator, home, register (register body lands in phase 4), dialogs
└── renderer/
    ├── Navigator.tsx      the ledger as root, sub-ledgers and accounts (List + Collapse), balances
    │                      (negatives in error.main), context menu, "show closed", [+ Account] [+ Ledger]
    ├── AccountsHome.tsx   all accounts with balances, by sub-ledger; click → register
    ├── Balance.tsx        one signed-amount component, red when negative, used everywhere a balance shows
    ├── useChart.ts        subscribe to chart.changed, then load
    └── dialogs/
        ├── AccountDialog.tsx   create / edit: name, type, sub-ledger, currency, institution, number,
        │                       opening date and balance (as owed, for liabilities), credit limit,
        │                       notes; inline errors
        └── MoveDialog.tsx      destination tree, for accounts and sub-ledgers
```

There is no group dialog: sub-ledgers are created with `ledger`'s New Ledger
dialog and renamed with its rename dialog (phase 1).

### Tasks

1. `selection.ts` and the context keys. The navigator calls `accounts:select`
   on every selection change, including selecting the ledger itself.
2. Account commands per the design's table:
   - *New Account…* → `shell.prompts.show('accounts.dialog.account', { mode: 'create', subLedgerId })`
     → select and open the new account.
   - *Close Account…* → confirm, with a second confirmation for a non-zero
     balance (`closeWithBalance`).
   - *Delete Account…* → confirm, stating the transaction count, the
     accounts whose transfers will be unlinked, and that it can't be undone.
3. Sub-ledger commands, thin wrappers that turn the selection into
   arguments:
   - *New Sub-Ledger…* → `ledger.new { parentId }`: the selected sub-ledger,
     the selected account's sub-ledger, or `null` when the ledger itself is
     selected. **The same New Ledger dialog** opens, with the parent chosen.
   - *Rename Sub-Ledger…* → `ledger.subLedger.rename { id }`.
   - *Delete Sub-Ledger…* → `ledger.subLedger.delete { id }`. Its
     confirmation includes `accounts`' "4 accounts" from the participant.
   - *Move To…* → the move dialog; accounts move through
     `accounts.service.moveAccount`, sub-ledgers through
     `ledger.session.moveSubLedger`.
4. The Accounts menu (top level, `&Accounts`), with menu groups as in the
   design's menu tree.
5. The navigator view (`shell.left`, icon `AccountBalance`,
   `when: 'ledger.isOpen'`): the open ledger as the root, type icons, closed
   accounts dimmed, sub-ledger totals, negative balances in red, and a
   context menu that runs the same commands with `{ id }`. *[+ Ledger]* runs
   `accounts.subLedger.new`. Keyboard: arrows, `Enter` opens the register,
   `F2` edits or renames.
6. The home view, and `accounts.open` in the View menu.
7. The dialogs, contributed to `shell.dialogs`. Each saves through IPC,
   shows `Result` errors on their fields, and closes with `{ id }`.
8. A placeholder register view that shows the account's name and balances.
   Phase 4 replaces it, but this lets phase 3 ship navigation end to end.

### Tests

| File | Covers |
|---|---|
| `tests/plugins/accounts/commands.test.ts` | enablement for every command across selection states (none, ledger, sub-ledger, open account, closed account); commands use `{ id }` over the selection; *New Sub-Ledger…* runs `ledger.new` with the right `parentId` for each selection; cancelled dialogs and declined confirmations change nothing |
| `tests/plugins/accounts/menus.test.ts` | contributions pass the shell's `resolveMenus` with no diagnostics; no bare-key accelerators |
| `tests/plugins/accounts/renderer/Navigator.test.tsx` | tree renders the ledger as root with sub-ledgers and accounts; selection invokes `accounts:select`; `chart.changed` re-renders; closed accounts hidden until toggled; negative balances styled with the error colour |
| `tests/plugins/accounts/renderer/AccountDialog.test.tsx` | validation; `DUPLICATE_NAME` shown on the name field; liability opening balance entered as owed is sent negative; success closes with the id |

**Exit criteria (manual):**
- Build a chart with two nested sub-ledgers, made through *New Sub-Ledger…*
  and through File › New Ledger… with a parent, and four accounts of
  different types, including a credit card with a balance owed. The card
  shows negative and red in the navigator and the home view, and in the
  totals.
- Rename, move, close, reopen and delete accounts and sub-ledgers.
- Delete a sub-ledger and see its accounts and sub-ledgers move up.
- Menu items grey out correctly as the selection changes.
- The status bar and the home view stay in step.

### Accounts results (phase 2, accounts half, and most of phase 3)

Done on 2026-11-04. The accounts half of phase 2 and the account-management UI of phase 3, as the `accounts` plugin
(`plugins/accounts/`). **Still open from these phases:** the transactions half of phase 2 (transactions, transfers,
payees, categories, balances from transactions), and from phase 3 the home view and the placeholder register.

| Piece | Where | What it does |
|---|---|---|
| The contract | `packages/accounts-api/` | `service.ts`: `AccountsService` as implemented, with `AccountFilter` for importers and reports, and `AccountsChange` listing created, updated, deleted and balance-changed ids. `planned.ts`: the transactions half, not yet on the service. `money.ts`: text to minor units and back, locale-aware, without floating point. `rules.ts`: the account rules the service and dialogs share. `errors.ts`: `AccountsError`, `isAccountsError`, `toAccountsResult` |
| Schema | `privileged/schema.ts` | `ledger.schema` version 1: `accounts.accounts`, unique `nameKey`, `bySubLedger`. The migrator has nothing to seed yet |
| Service | `privileged/AccountsServiceImpl.ts` | Every rule: names unique in the ledger ignoring case; type, currency, dates and amounts valid; credit limits only on cards and lines of credit; closed accounts read-only; closing with a balance needs confirmation. Writes are transactions, events come after commit, and ordering stays dense. It is also the sub-ledger participant: deleting a sub-ledger moves its accounts up in the ledger's transaction |
| Selection and commands | `privileged/selection.ts`, `commands.ts` | The selection, published as context keys, and valid after deletes and closes. Commands for every Accounts menu item; the sub-ledger ones hand over to the ledger's commands |
| Navigator and dialogs | `renderer/Navigator.tsx`, `AccountDialog.tsx`, `MoveDialog.tsx`, `display.tsx` | As designed: balances Money-style (negative in `error.main`); "Amount owed" for liabilities, stored negative |
| Ledger changes | `@tessera/ledger-api`, `plugins/ledger/` | `registerNavigator` and `ledger.hasNavigator`, so the Ledger panel hides while the navigator shows the tree. The tree helpers accept any `{ id, parentId, name, order }`. The panel no longer repeats the ledger's name in its toolbar. Moving a sub-ledger out of the middle no longer leaves a gap in its old siblings' order |

Decisions made on the way:

- **The service promises only what is implemented.** The transactions interfaces moved to `planned.ts` rather than
  sitting on `AccountsService` as methods that throw.
- **Balances are the opening balance until transactions exist.** `balances()` and the chart already have their
  final shape.
- **Commands follow the selection.** `{ id }` names the item, but enablement follows the navigator's selection, so
  the menu greys out to match. Other plugins use the service.
- **The navigator lists sub-ledgers before accounts** under each node, as a file explorer lists folders before
  files. `list()` returns the same order.
- **The edit form sends the whole account**, so a field the user emptied is cleared. In a patch, `null` clears only
  the optional fields; `subLedgerId: null` means the ledger itself. A test found this.

Verification:

- **`npm test`:** 1324 passed, with the same 4 environmental failures. The new tests:
  - `tests/packages/money.test.ts` and `accountRules.test.ts`;
  - `tests/plugins/accounts/`:
    - the service on a real ledger session: CRUD, validation by field, filters, the chart, moves, participants,
      events;
    - both plugins activated together: contributions, the facade, selection and enablement, every command, IPC;
    - the renderer;
    - **the built bundles** on real SQLite files across two runs of the app.
- **Type-checks:** `tsc` is clean for both plugins and their tests with React's types.
- **Builds:** every bundled plugin builds.

**Still to do by hand, in `npm run dev`:**
- The Accounts panel replaces the Ledger panel.
- New Account in a sub-ledger: a credit card with an amount owed shows negative and red, and the sub-ledger and
  ledger totals follow.
- Edit, Move To…, Close (with a balance), Show closed accounts, Reopen and Delete.
- Delete a sub-ledger holding accounts, and they move up.

### Transactions and register results (phase 2, transactions half, and phase 4)

Done on 2026-11-04, with two review requests:
- **The currency field's alignment in the account dialog.**
  - Cause: the shell theme gives every `TextField` a dense top margin, and a `Stack` row removes it only from its
    direct children. The currency field is nested in an `Autocomplete`, so it kept 8 px.
  - Fix: `margin="none"` on that field.
  - Test: it renders under the real theme, and fails without the fix.
- **Minimum balances.** `minimumBalance` and `showAvailableBalance` on asset accounts; `available` in every
  `AccountBalances`; the navigator marks an account shown that way "avail.".
  - Follow-up from review: the register's running balance follows the flag too. Each `RegisterRow` has `available`
    beside `balance`, the column is headed *Available* while adjusted, and the opening row is adjusted as well. The
    choice is `showsAvailable` / `shownRunningBalance` in the API, shared with the navigator.

**Assumed, as agreed: no migration.** Ledgers start fresh, so the transaction collections and the starter categories
joined schema version 1 rather than a version 2.

| Piece | Where | What it does |
|---|---|---|
| The contract | `packages/accounts-api/transactions.ts`, `service.ts`, `rules.ts` | `TransactionManager`, `PayeeDirectory` and `CategoryDirectory` moved from `planned.ts` onto `AccountsService` (`planned.ts` now holds reconciliation only). `AccountsChange` gained `transactions` and `categories`. The rules gained the transaction limits, `categoryLabel`, `transferLabel` and `MINIMUM_BALANCE_TYPES`, and the model gained `shownBalance` |
| Schema and seed | `privileged/schema.ts` | Four collections with the design's indexes, and the starter categories, seeded once |
| Transaction rules | `privileged/transactionsCore.ts` | Create, update, delete, status and void as functions over one storage transaction. Transfers are pairs sharing a `transferId`: amount, date, payee, memo and void are mirrored, and number and status are each side's own; a transfer can end, move to another account, or begin from an ordinary transaction. Changes that reach a reconciled balance need confirmation, on either side of a transfer. Deleting an account unlinks its transfers' other sides, with a note. Balances come from one aggregate pass |
| Service | `privileged/AccountsServiceImpl.ts`, `store.ts` | Each transaction operation is one storage transaction, announced after commit with every account it touched. The currency is locked once an account has transactions, and the minimum-balance rules are enforced |
| Register state, IPC, commands | `privileged/register.ts`, `ipc.ts`, `commands.ts` | Which account the register shows (`accounts.register.account`, `accounts.register.editable`); Open Register; New Transaction (Ctrl+N); the register's requests; a change published as the chart, the accounts whose transactions changed, and categories |
| Register view | `renderer/register/` | `Register.tsx` (header balances, the table, row keys, context menu, the in-view question), `TransactionEditor.tsx` (inline editing, payee and category autocomplete, creating a category, date and number keys), `model.ts` (pure), `useRegister.ts` |

Found and fixed on the way:
- **A change published just as the ledger closed logged "No ledger is open" as an error.** The publisher now treats a
  ledger that closed meanwhile as closed.
- **MUI 9 passes an Autocomplete's input props as `params.slotProps`.** Overriding `slotProps` would have dropped the
  input's ref and adornments, so they are merged.

Verification:

- **`npm test`:** 1378 passed, with the same 4 environmental failures. The new tests:
  - `tests/plugins/accounts/transactions.test.ts`: transfers, with an invariant check after every operation that
    pairs are whole, opposite and on the same date; reconciled guards; balances and the register; deleting an
    account with transfers; payees, categories and minimum balances;
  - `register.test.ts`: the plugin's register flow, activated;
  - `renderer/registerModel.test.ts`, `register.test.tsx` and `accountDialog.test.tsx`: the register, the dialog's
    new fields, the navigator's register keys, and the alignment regression;
  - the built-bundle pipeline test, which now keeps transactions and a transfer across runs.
- **Type-checks:** `tsc` is clean for both plugins and their tests with React's types.
- **Builds:** every bundled plugin builds.

**Still to do by hand, in `npm run dev` (with a fresh ledger):**
- The currency field lines up with its row.
- A savings account with a minimum, shown as available.
- Enter a month of transactions by keyboard, including a transfer, and check its other side.
- Edit an amount on one side of the transfer.
- Void a cheque, delete a transfer, and clear with Space.
- Close an account and see its register go read-only.

---

## Phase 4: the register (L)

### Files

```
plugins/accounts/src/renderer/
├── Register.tsx                 header (account, toolbar), table, balances footer; normal mode
└── register/
    ├── useRegister.ts           subscribe (transactions.changed, register.changed, transaction.new), then load
    ├── RegisterTable.tsx        columns by account type; selection; keyboard navigation
    ├── TransactionRow.tsx       one line, read-only; `lines` prop reserved for a two-line layout
    ├── TransactionEditor.tsx    inline inputs + memo line + Enter/Cancel; field focus order
    ├── PayeeField.tsx           Autocomplete over accounts:payees.search; fills empty fields on new entries
    ├── CategoryField.tsx        categories, then "Transfer to: …" entries; "Create category 'X'"
    ├── AmountFields.tsx         decrease/increase pair; parse with money.ts; one clears the other
    ├── DateField.tsx, NumberField.tsx   +/−/T shortcuts
    ├── RowMenu.tsx              edit, delete, void/unvoid, mark cleared/uncleared (+ reconcile actions, phase 5)
    ├── confirm.tsx              in-view Dialog for CONFIRMATION_REQUIRED and delete confirmation
    └── editorState.ts           a pure reducer: idle / editing(id) / new, draft, errors, dirty
```

### Tasks

1. **`editorState.ts` first**: a pure reducer, fully unit-tested. It covers
   select, begin edit, change field, save requested, save failed (errors),
   save succeeded (move to a new entry), cancel, and leave row (save if
   dirty).
2. **Display**: `RegisterTable` and `TransactionRow` for the snapshot.
   Opening-balance row first; `V` rows struck through (`textDecoration`,
   colour `text.disabled`); status letter column; type-specific headers from
   `columns.ts`. Money-style amounts: unsigned in the amount columns, signed
   in the Balance column and footer through the shared `Balance` component
   (red when negative). Compare the column labels with Money Plus's registers
   and adopt Money's wording where it differs (update `columns.ts` and the
   design's table).
3. **Editing**: `TransactionEditor` with the fields. Save via
   `accounts:transaction.save` with `expectedRev`. Handle `Result` errors per
   field, `CONFLICT` (reload and keep the draft visible), and
   `CONFIRMATION_REQUIRED` (ask, then resend with `confirm`).
4. **New-entry row**: defaults (last date, next number); `Enter` saves and
   starts another.
5. **Row actions**: `Space` toggles cleared, `Delete` with confirmation,
   `Ctrl+Shift+V` void toggle, all also in `RowMenu` and the toolbar.
   *New Transaction* from the Accounts menu arrives as
   `accounts:transaction.new` and focuses the entry row.
6. **Read-only states**: closed account or read-only ledger: no entry row;
   editing refused with a message.
7. **Replace** the phase 3 placeholder.

### Tests (`tests/plugins/accounts/renderer/`)

| File | Covers |
|---|---|
| `editorState.test.ts` | every transition of the reducer |
| `Register.test.tsx` | renders rows, running balances and the opening row; headers per account type; amounts unsigned in their columns, negative balances signed and red; reloads on `transactions.changed` for its account only |
| `TransactionEditor.test.tsx` | Enter saves with the right payload (minor units, payee name, category or transfer); Esc cancels; Tab order; field errors shown; conflict keeps the draft; confirmation round trip |
| `PayeeField.test.tsx` / `CategoryField.test.tsx` | autocomplete, fill-from-last-payee only into empty fields, transfer entries exclude closed and other-currency accounts, create-category offer |
| `keyboard.test.tsx` | arrows, Space, Delete, `+`/`−`/`T` in date and number fields |

Performance check: 10,000 rows render and scroll acceptably in
`npm run dev`. If not, add virtualisation here (a windowed list in the plugin,
or a shared component in `@tessera/ui`) before moving on.

**Exit criteria (manual):** enter a month of transactions by keyboard alone.
Include a transfer to savings and check that the savings register shows the
other side. Edit an amount on one side and see it mirrored. Void a cheque.
Delete a transfer, which removes both sides. Try to edit a reconciled
transaction and accept the warning (mark one reconciled via DevTools IPC
until phase 5).

---

## Phase 5: reconciliation (M–L)

### Files

```
plugins/accounts/src/
├── privileged/
│   ├── ReconciliationServiceImpl.ts   begin, mark, summary, finish (+ adjustment), postpone, cancel
│   ├── reconcileActions.ts            reads accounts.reconcile.actions, validates, resolves per account/scope
│   └── balanceReconciler.ts           contributes accounts.reconcile.balance and its command
└── renderer/
    ├── register/ReconcileMenu.tsx     toolbar menu from accounts:reconcile.actions (scope 'account')
    ├── register/ReconcileBar.tsx      statement, cleared, difference; Finish / Postpone / Cancel
    ├── register/ReconcileMode.tsx     candidate list with check column bound to mark
    └── dialogs/BalanceDialog.tsx      statement date, ending balance, interest, service charge
```

### Tasks

1. **The session service**, with one active session per account (the unique
   `activeFor` index). `finish` is one transaction: statuses, the account's
   `lastReconciled`, and the session record with reconciled ids. A non-zero
   difference requires `adjustment`.
2. **Context keys** `accounts.reconciling` and `accounts.reconciler`, and the
   `accounts:reconcile.changed` event.
3. **Extension point reader**: validate contributions (prefix, scope,
   command) and resolve `{ id, label, icon, enabled }` per request, with
   `enabled = commands.isEnabled(command)`.
4. **Register integration**: the Reconcile menu in the toolbar;
   transaction-scope actions in `RowMenu` (run with
   `{ accountId, transactionIds }`); reconcile mode when a session is active
   for the register's account; a banner when it's on another account.
5. **Balance Account**: dialog, optional interest and service-charge
   transactions, `begin`, reveal.
6. **Guide**: document `accounts.reconcile.actions` for plugin authors,
   either as a section in the design note or as
   `docs/accounts-extension-points.md`.

### Tests

| File | Covers |
|---|---|
| `tests/plugins/accounts/reconciliation.test.ts` | begin refuses a second session; candidates exclude voided and reconciled; mark persists; summary arithmetic from `lastReconciled`; finish is atomic (inject a failure and nothing changes); adjustment path; postpone then resume after "restart" (a new service instance over the same memory driver) |
| `tests/plugins/accounts/reconcileActions.test.ts` | a **fixture plugin** contributes an account action and a transaction action: both resolve for matching account types, are hidden for others, follow command enablement, and run with the right arguments; invalid contributions are warned and skipped |
| `tests/plugins/accounts/renderer/ReconcileMode.test.tsx` | check column calls mark; difference updates from events; Finish disabled until the difference is 0 or an adjustment is accepted |

**Exit criteria (manual):** reconcile a chequing account against a real
statement with Balance Account. Postpone midway, restart the app, and resume.
Finish and see `R` on the cleared rows and the reconciled balance in the
footer. A fixture reconciler (from a user-plugins folder) shows up in the
Reconcile menu and in row menus.

### Reconciliation results (phase 5)

Done on 2026-11-04, together with three review requests from trying the register:
- **One click opens a register.** Clicking an account in the navigator shows its register. The arrow keys only move
  the selection (so browsing doesn't load registers), Enter shows the register, and F2 edits the account. The click
  waits for the plugin to have the selection before running `accounts.register.show`, whose enablement depends on it.
- **Reconciling starts from the statement.** See the design note's
  [Reconciliation](account-manager-design.md#reconciliation-and-its-extension-point) for the flow: the dialog, the
  register's reconcile mode, and the Reconcile panel with Complete, Pause and Cancel.
- **Voiding and correcting amounts.** In reconcile mode each row can be voided, and its amount corrected in place.
  The normal register has a toolbar for the selected row: Edit, Mark Cleared, Void and Delete.

How it differs from the plan above, and why:

| Planned | Built | Why |
|---|---|---|
| A `ReconcileSession` object with methods | `reconciliation.get/begin/mark/pause/finish/cancel(accountId, …)` on the service, returning a `ReconcileState` snapshot | A snapshot crosses IPC as it is, and any view or plugin can pick a reconciliation up by account, including after a restart |
| Balance Account: statement date and ending balance, interest, service charge | Reconcile with Statement: statement date, **starting** and ending balance, service charge and interest (added in a follow-up, below); anything else through the entry row, which stays in reconcile mode | Requested in review. The starting balance catches a statement that starts elsewhere than the ledger |
| A summary bar in the register with Finish / Postpone / Cancel | The Reconcile panel in the left bar (`accounts.reconcile`, shown while `accounts.reconciling`), with Complete / Pause / Cancel | Requested in review. It keeps the register's width for the list |
| Cancel keeps the marks | Cancel puts back each status the reconciliation changed | Requested in review: cancelling should leave the account as it was |
| `finish({ adjustment })` | `finish({ confirm: ['adjustBalance'] })`, adding a reconciled "Balance adjustment" for `summary.adjustment` | The same confirmation pattern as every other guarded change |

| Piece | Where | What it does |
|---|---|---|
| The contract | `packages/accounts-api/reconciliation.ts`, `protocol.ts` | `ReconciliationService`, `ReconcileState`, `StatementFigures`; the channels (`reconcile.*`, `transaction.patch`), the `reconcile.changed` event, the dialog, view and command ids, `ResolvedReconcileAction`. `planned.ts` is gone: everything it held is implemented. API version 1.3.0 |
| Reconciliation rules | `privileged/reconcileCore.ts` | Begin or resume, mark (recording each status before its first change), pause, cancel (restoring them), finish (the adjustment guard, statuses, adjustment, `lastReconciled`, the finished record) |
| Service | `privileged/AccountsServiceImpl.ts` | `reconciliation`, each operation one storage transaction, announced with `reconciliations` in `AccountsChange`. Deleting an account deletes its reconciliations |
| Extension point | `privileged/reconcileActions.ts`, `contributions.ts` | Validates `accounts.reconcile.actions` (one warning per problem), resolves them per account type and scope with their commands' enablement. The built-in reconciler is contributed through it |
| Command, keys, IPC | `commands.ts`, `register.ts`, `ipc.ts` | `accounts.reconcile.statement`; `accounts.reconciling` and `accounts.reconciler`; the requests, and `reconcile.changed` for every account whose reconciliation or transactions changed |
| Views | `renderer/reconcile/` | `ReconcileDialog.tsx`, `ReconcilePanel.tsx`, `ReconcileList.tsx` (reconcile mode), `useReconcile.ts`. `Register.tsx` gained the toolbar, the Reconcile button or menu, the paused note, and transaction-scope options in the row menu; `Navigator.tsx` the one-click register and the account's reconcile options |

Found and fixed on the way:
- **The amount field saved twice.** Enter saved, then focus left the field, whose blur saved again from stale state;
  Escape was followed by a save too. The field's state is now kept in a ref as well, and a save in flight blocks
  another.

Verification:

- **`npm test`:** 1433 passed, with the same 4 environmental failures. The new tests:
  - `tests/plugins/accounts/reconciliation.test.ts`: the service: candidates, marks, figures, completing with and
    without an adjustment, a statement starting elsewhere, pause surviving a reopen, cancel restoring only its own
    changes, one per account, and following edits and voids;
  - `register.test.ts`: the command and IPC flow, activated with the ledger, and the extension point with a second
    plugin's contributions (types, scopes, enablement, invalid ones);
  - `renderer/reconcile.test.tsx`: the dialog (prefill, liabilities, validation, resume), the panel (figures,
    adjustment question, pause, cancel question), reconcile mode (ticks, Space, amount correction, void, entry row);
  - `renderer/register.test.tsx`, `views.test.tsx`, `accountDialog.test.tsx`: the toolbar, the Reconcile button and
    menu, plugin row options, the paused note, and the navigator's click, arrows and reconcile options.
- **Type-checks:** `tsc` is clean for the plugins with React's types; the tests add no new errors.
- **Builds:** every bundled plugin builds, with `./ReconcileDialog` and `./ReconcilePanel` exposed.

**Follow-up: service charge and interest on the statement dialog.** Requested after the first round, as Money's
Balance Account has them:
- **The dialog** (now `sm` wide) has a row each for the service charge and interest (*Interest earned*, or *Interest
  charged* on a liability): amount, date (following the statement date unless changed) and category (suggested by the
  command: *Bank fees*; *Interest*, or the new starter category *Interest paid* on a liability, else *Bank fees*).
- **`begin`** takes them as `StatementInput.serviceCharge` / `.interest` (unsigned; `chargeAmount` in the API gives
  the sign) and adds each as a cleared transaction in the same storage transaction, or nothing if one is invalid. The
  reconciliation records them in `addedIds`; **Cancel deletes them**, and the panel's Cancel question says so.
  Resuming adds any new ones. API version 1.4.0.
- **Tests** (1445 passing, the same 4 environmental failures): signs for assets and liabilities, all-or-nothing
  validation with the dialog's field names, resuming and cancelling, completing with a charge; the command's
  suggested categories; the dialog's rows, defaults, labels and errors.

**Still to do by hand, in `npm run dev`:**
- Reconcile a chequing account against a statement with a service charge and interest; correct an amount and void a
  transaction on the way.
- Pause, restart the app, and resume from the register's note.
- Complete with a difference, and accept the adjustment.
- Cancel one, and see the ticks go back.
- Reconcile a credit card, entering the amounts owed.

---

## Phase 6 and later (not scheduled)

| Item | Notes |
|---|---|
| Split transactions | `splits` is already reserved; an editor with a splits sub-grid; balances unaffected, category reports via `$unwind` |
| Category manager | a main view or dialog; merge categories; hidden categories |
| Statement import | `accounts.importers` from vault-design.md; sets `externalId` and `electronic`; a transaction-scope "match" reconcile action |
| Per-file storage formats (`ledger.formats`) | first move storage drivers into packages, so a format plugin isn't skipped by the `storage.engine` contest |
| File locks | `shell.files.lock`; open read-only when held elsewhere (`ledger.isReadOnly`) |
| Ledger encryption | Not in the first release (review decision 5). SQLCipher or an encrypting format would arrive through `ledger.formats`, together with a password prompt in `shell.prompts` |
| Renaming a ledger file from the app | Close, rename through `shell.files`, reopen, update the recent list |
| Undo last reconciliation | uses the reconciled ids recorded by `finish` |
| Two-line register, sort and filter options, drag-and-drop ordering in the navigator | |
| Investment holdings, loan schedules | their own plugins on `accounts.service`; likely an `accounts.types` extension point then |

---

## Documentation changes, alongside the phases

| When | Change |
|---|---|
| Phase 0 | `plugin-creation.md`: contributing dialogs, `shell.files` and `shell.prompts`, the new `@tessera/ui` components. `storage-engine-redesign.md` and `README.md`: SQLite is the default engine (0.6) |
| Phase 1 | `vault-design.md`: status "Superseded by account-manager-design.md" at the top. `README.md`, `plugin-creation.md` and `todo.md`: replace the `vault.*` examples (`vault.isOpen`, `vault.save`, `vault.store`…) with `ledger.*` equivalents, and the *Vault and storage* section of `todo.md` with the phases here. Document `ledger.schema` and sub-ledger participants for plugin authors |
| Each phase | Tick the phase in `todo.md`; record results and deviations in the design note, as the theming and layout notes do |

## Definition of done (every phase)

- [ ] `npm test` green, including the architecture boundaries
- [ ] No new errors from `npx tsc --noEmit -p plugins` (and `-p shell`, `-p tests` when touched)
- [ ] Every disposable pushed onto `context.subscriptions`
- [ ] Manual smoke checklist for the phase done in `npm run dev`, in light and dark themes
- [ ] Docs updated as listed above
