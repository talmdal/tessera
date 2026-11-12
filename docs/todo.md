# Open work

Known gaps and planned work, grouped by area. Each item is something the
framework doesn't do yet, or does in a way we intend to change. Tick items
off, or delete them, as they land.

## Plugin runtime

- [ ] **Configurable shutdown time limit.** It is fixed at 10 seconds.
- [ ] **Order plugins that use `context.state` automatically.** Today the order is
      explicit: a plugin lists `app.state` in `services.requires`, so the
      `app-state` plugin activates first, and `context.state` refuses to work
      without that line. The framework could add the dependency itself, from a
      manifest flag or from the plugin using `context.state`, so authors need not
      know that the store is a plugin. It must keep the all-or-nothing rule (no
      store, no activation) or define what `context.state` does without one.
- [ ] **Build tooling for user-installed plugins.** Built-in plugins get
      TSX compilation and the federation remote from `scripts/build-plugins.mts`.
      Third-party authors have no equivalent; package it as a small CLI or
      SDK (with the `PluginContext`, `window.api` and view-prop types).
- [ ] **Type-check plugin source.** The build strips types (esbuild). Add a
      `plugins/tsconfig.json` and a CI step so `plugins/**` is checked; today
      only the test fixture is.
- [ ] **Federation build: CSS, assets and multiple views.** Verified with one
      TSX view. Check stylesheets, images, several exposed modules and shared
      third-party libraries.
- [x] **Keep the shared React range in sync.** The plugin build now reads it
      from `package.json`'s `dependencies.react` (a test checks the built ranges).
- [ ] **Built-in plugins: watch mode.** Rebuild and reload on source changes
      during `npm run dev`.
- [ ] **Built-in plugins: packaging.** Copy `modules/` into the packaged app
      as `resources/modules` (the path the loader already expects).
- [ ] **Built-in plugins: policy.** Decide whether users can disable (or
      deliberately override) a built-in plugin. Today the bundled copy always
      wins on a duplicate id.
- [ ] **Developer plugins in a packaged app.** `test-layout` and
      `settings-inspector` (Tools › Settings Inspector…) are bundled like every
      built-in plugin. Decide whether a release ships them, or leaves them out
      (they can already be turned off with `disabledPlugins` in
      `tessera-bootstrap.json`).
- [ ] **Built-in plugin dependencies.** The build bundles a plugin's npm
      dependencies into its file. Decide how shared libraries are handled so
      plugins don't each carry a copy.
- [ ] **Install, uninstall or update without restarting.** Discovery and
      activation happen once, at startup.
- [ ] **Lazy activation.** Every plugin activates at startup. Consider
      activation events (on first command, on view shown) as in Eclipse and
      VS Code.
- [ ] **Compatibility checks.** The manifest has no `engines.tessera`
      (framework version range), and `version` isn't validated as semver.
- [ ] **Declared extension points.** `ExtensionRegistry` accepts any point
      name. Let owners declare points (id and schema), and validate
      contributions against them.
- [ ] **Plugin trust.** Privileged code runs with full Node access in the
      main process. Decide on signing, a trust prompt, or a permission
      model before third-party plugins are supported.
- [ ] **Plugin SDK package.** Publish the `PluginContext` typings and
      contract types so plugin authors don't copy them from the repo.

## Plugin context and cleanup

- [ ] **Ownership and cleanup for the shared registries.** The plugin context
      hands plugins the shared `ipc`, `extensions`, `services`,
      `contextKeys` and `lifecycle`. Only `commands` (id prefix) and
      `events` are scoped, so a plugin can register another plugin's IPC
      channel, contribution id, context key or service id, and its
      registrations are not removed on deactivation unless it pushes the
      returned `Disposable` onto `context.subscriptions`. `storage-loki` doesn't
      yet (`app-state` does now). Decide whether to enforce this in the core or
      keep it as convention, and update the plugin guide to match.
- [ ] **`services.provides` is not enforced.** `createPluginContext` still
      accepts a `provides` option, but nothing checks it; only the
      "declared but not provided" warning remains.
- [ ] **Built plugin `package.json`.** The build writes `{"type":"cjs"}`;
      Node's valid value is `commonjs`. Changing it breaks loading the ESM
      renderer remote in tests, so decide how to separate the two.
- [ ] **Plugins import core code.** `app-state` imports
      `core/storage/TransactionManager` by relative path. Move shared
      storage helpers behind `@tessera/types` or a service.

## Services

- [ ] **Optional dependencies.** `has()` and `get()` work for undeclared
      services, but nothing orders their provider first. Add
      `services.optional`: order like `requires`, without the all-or-nothing
      rule.
- [ ] **Service versioning**, so breaking changes to a service like
      `vault.store` can be told apart from compatible ones.
- [ ] **Typed service tokens** for TypeScript plugins (`get<T>()` currently
      trusts the caller).
- [x] **Shell services: asking the user.** `shell.prompts` (native confirm and
      message boxes, a text prompt, `show` for contributed dialogs), the
      `shell.dialogs` extension point with the renderer's dialog host, and
      `shell.files` (open and save dialogs, `exists`, the OS trash). See
      [Asking the user](plugin-creation.md#asking-the-user-dialogs-prompts-and-files).
- [ ] **More shell services:** recent files, atomic writes and file locks for
      `shell.files`; later `shell.notifications` and a secure password prompt.
      (Settings are done, as `context.settings`. Backups aren't a `shell.files`
      job: a copy of an open ledger needs the storage engine; see
      [backup-restore-design.md](backup-restore-design.md).)

## Finance: ledgers and accounts

Design: [account-manager-design.md](account-manager-design.md); plan, phase by
phase: [account-manager-implementation.md](account-manager-implementation.md).
The storage engine it builds on is done ([storage-engine-redesign.md](storage-engine-redesign.md)).

- [x] **Phase 0, framework prerequisites:** the `@tessera/ledger-api` and
      `@tessera/accounts-api` contracts, `shell.prompts`, `shell.files`,
      `shell.dialogs`, `@tessera/ui` 1.1, and SQLite as the default engine.
- [x] **Phase 1:** the `ledger` plugin (files, sub-ledgers, start view, Ledger
      panel). Results in
      [account-manager-implementation.md](account-manager-implementation.md#phase-1-results).
- [x] **Accounts:** phase 2's accounts half (the service, rules, money
      helpers) and phase 3's navigator, Accounts menu and dialogs. Results in
      [account-manager-implementation.md](account-manager-implementation.md#accounts-results-phase-2-accounts-half-and-most-of-phase-3).
- [x] **Phase 2, transactions half, and phase 4, the register:**
      transactions, transfers, payees, seeded categories, balances from
      transactions, minimum balances, and the register. Results in
      [account-manager-implementation.md](account-manager-implementation.md#transactions-and-register-results-phase-2-transactions-half-and-phase-4).
- [ ] **Phase 3, rest:** the accounts home view.
- [ ] **Register, later:** the two-line layout, windowed rendering for very
      long registers, sorting and filtering, and splits. (`externalId` on
      drafts is done, with the other methods importers need: see
      [import-manager-design.md](import-manager-design.md#03-results).)
- [x] **Phase 5, reconciliation:** Reconcile with Statement (statement date,
      starting and ending balance), the register's reconcile mode (ticks,
      correcting amounts, voiding), the Reconcile panel (Complete with an
      optional balance adjustment, Pause, Cancel restoring the marks), and
      `accounts.reconcile.actions` for other plugins. Also from review: one
      click opens a register, and the register has a toolbar for the selected
      row. Results in
      [account-manager-implementation.md](account-manager-implementation.md#reconciliation-results-phase-5).
- [x] **Reconciliation: service charge and interest** on the statement
      dialog, added as marked transactions (deleted again on Cancel).
- [ ] **Reconciliation, later:** undo last reconciliation, and a history of
      past statements.
- [x] **Statement import, phases 0 and 1:** *File › Import…* with OFX and QFX
      files, the account found or chosen and remembered, no line imported twice.
      Design and results: [import-manager-design.md](import-manager-design.md).
- [x] **Statement import, phase 2:** fuzzy matching to transactions the user
      entered, proposals reviewed in the register (*Accept*, *Change…*, *Accept
      All…*), the Change Match dialog with *Unmatch*, and payee aliases.
      Results: [import-manager-design.md](import-manager-design.md#phase-2-results).
- [ ] **Statement import, more formats**
      ([import-formats-design.md](import-formats-design.md), reviewed
      2026-11-11; it replaces phase 3):
  - [x] **F0:** `@tessera/import-api` 1.3 (format dialogs without the parse
        time limit, `CANCELLED`, per-statement `stableIds`, category hints
        with a remembered choice per source, `text('auto')`, date helpers)
        and the bank-id collision guard. Results:
        [import-formats-design.md](import-formats-design.md#phase-f0-results).
  - [x] **F0, by hand:** the Cedar Credit Union samples in `npm run dev`
        ([walkthrough](../samples/statements/README.md#ids-a-bank-used-before)):
        seen in the dark theme. The light theme is still to look at.
  - [x] **F1:** QBO (QuickBooks Web Connect) in `import-ofx`, with made-up
        bank ids detected; `npm run anonymise` for OFX, QFX and QBO, and the
        fixtures' privacy test. Results:
        [import-formats-design.md](import-formats-design.md#phase-f1-results).
  - [x] **F1, by hand:** the QBO walkthroughs, seen on Windows in the dark
        theme, and `npm run anonymise` on two real downloads, now fixtures
        (`tests/fixtures/import/real/ofx/`).
  - [x] **F2:** *Already imported?* proposals for a line seen before from
        another source. Results:
        [import-formats-design.md](import-formats-design.md#phase-f2-results).
  - [x] **F2, by hand:** the walkthrough
        [The same transactions from another file](../samples/statements/README.md#the-same-transactions-from-another-file),
        seen on Windows in the dark theme.
  - [x] **F3:** the sign cross-check (*Amounts Reversed?*), with what it
        needs retained per source and account. Results:
        [import-formats-design.md](import-formats-design.md#phase-f3-results).
  - [ ] **F3, by hand:** the walkthrough
        [Amounts the wrong way round](../samples/statements/README.md#amounts-the-wrong-way-round),
        in light and dark themes.
  - [x] **F4:** the `import-csv` plugin: guessed layouts, the CSV Columns
        dialog on every file, remembered layouts; the anonymiser for CSV.
        Results:
        [import-formats-design.md](import-formats-design.md#phase-f4-results).
  - [ ] **F4, by hand:** the rest of the walkthrough
        [CSV files](../samples/statements/README.md#csv-files) (the October
        chequing and French files were seen on Windows, dark theme), in light
        and dark themes; the role pickers' menus since they replaced native
        selects; and the CSV Columns dialog with a wide file.
  - [x] **F5:** the `import-qif` plugin, including Money and Quicken
        exports; the anonymiser for QIF. Results:
        [import-formats-design.md](import-formats-design.md#phase-f5-results).
  - [ ] **F5, by hand:** the walkthrough
        [Bringing accounts over from Money or Quicken](../samples/statements/README.md#bringing-accounts-over-from-money-or-quicken),
        in light and dark themes, and QIF Options.
  - [x] **F6:** *Remembered choices*: *File › Saved Import Choices…*, with
        the saved account matches and payee names too (ahead of phase 4's
        history and undo). Results:
        [import-formats-design.md](import-formats-design.md#phase-f6-results).
  - [ ] **F6, by hand:** *File › Saved Import Choices…* after the samples'
        walkthroughs, in light and dark themes.
  - [ ] **Real files:** anonymise real downloads
        ([how](../tests/fixtures/import/real/README.md)). Two banks' QBO and
        CSV files are in, and a Money account exported as loose and as strict
        QIF. Next: a Quicken export (a whole file, if possible); a bank's CSV
        and QBO anonymised together, to test *Already imported?* on a real
        pair.
  - [ ] **Decide:** a QIF file's categories beyond exact paths (Money's
        *Groceries* isn't Tessera's *Food : Groceries*): match by the last
        part when unique, or offer to create them. See
        [Later](import-formats-design.md#later).
- [ ] **Statement import, phase 4:** history and undo, and navigator badges.
      (Its Saved Account Matches dialog is built, as Saved Import Choices, in
      F6.)
- [ ] **Native file dialogs follow Windows, not Tessera's theme:** with Windows
      in dark mode and Tessera light, *File › Import…*'s file dialog is still
      dark. The shell sets Electron's `nativeTheme.themeSource` to Tessera's
      mode, which themes menus and the title bar, but Windows 11 draws its file
      dialogs in the system's mode. Check whether anything else can be done.
- [ ] **Statement import, by hand:** go through the matching walkthrough in
      [samples/statements](../samples/statements/README.md#matching-and-review) in
      `npm run dev`, in light and dark themes: the register's marks, buttons and
      review bar, and the Change Match dialog, have only been tested, not seen.
- [ ] **Later:** per-file storage formats, splits, `.mny` migration.
- [ ] **The import holds the main process for a whole statement:** 0.3 s per
      1,000 lines against an empty account, longer against a long history
      (measured in the backup spike). Menus and every window's IPC wait
      meanwhile. Yield while matching.
- [ ] **Opening a ledger blocks the main process while the storage kit loads
      it:** 0.4 to 1 s at 100,000 transactions (measured in the backup spike).
      Load in steps, or off the main thread.

## State and settings

Design: [settings-design.md](settings-design.md); guide:
[plugin-creation.md › Settings](plugin-creation.md#settings).

- [x] **Settings core** (`context.settings`): defaults, several namespaces per
      plugin, versioned migration, validation (shape, fields, `validate`),
      change events, read-only values from a newer version, and failure
      handling, in `core/settings/SettingsService.ts`; one JSON file per
      namespace under `<userData>/settings/`, written atomically.
- [x] **Options dialog and `shell.settings.pages`:** page tree, search, drafts
      with OK/Apply/Cancel, Restore Defaults, the unsaved-changes question,
      `Ctrl+,` (Tools › Options…, `shell.settings.open`).
- [x] **Declarative settings form:** pages of `fields` (boolean, number, text,
      choice) that the shell draws. The `ledger` plugin's page is one.
- [x] **State store** (`context.state`): a plugin's own keys in `app.state`
      (stored as `<pluginId>.<key>`, as before, so nothing saved was lost), for
      what it remembers between runs. Needs `app.state` in `services.requires`,
      and says so when it is missing. The ledger and import plugins use it.
      See [plugin-creation.md](plugin-creation.md#remembering-application-state).
- [x] **Views can no longer reach any `app.state` key.** The `app-state`
      plugin's IPC (`app.state:get`, `:set`, `:update`, `:remove`) took any key
      from any view. No view used it (its renderer helper was never built), so
      it is gone; a view asks its own plugin, which answers from `context.state`
      ([plugin-creation.md](plugin-creation.md#giving-your-views-state)).
- [ ] **Per-ledger settings: scopes** (proposed, for review:
      [settings-design.md › Proposal: scopes](settings-design.md#proposal-scopes-per-ledger-settings)).
      Layers of overrides, defaults ← application ← ledger, each kept where its
      context lives; plugins provide the layers, and namespaces opt in. Settle
      the proposal's open questions first (per namespace or per key, trust,
      resource scopes, the owner's default layer), then:
  - [ ] **Core:** `context.settings.provideScope`, `scopes` on `register`, the
        resolution chain, change events as scopes open and close, checking and
        migrating a scope's documents, `update(…, { scope })`, `inspect()`.
  - [ ] **The ledger provides the `ledger` scope:** a `ledger.settings`
        collection in the ledger, read-only ledgers, opening and closing with
        the session.
  - [ ] **Options dialog:** the scope switcher, override marks and "Use the
        application value", drafts per layer, the wire contract, and the
        `scope` and `inherited` props for a plugin's own page.
  - [ ] **First user:** the import's matching preset per ledger.
  - [ ] **Later, if needed:** resource scopes (per sub-ledger or account),
        per-key opt-in, a settings field kind for lists.
- [x] **The theme on a settings page:** the Appearance page (the shell's first
      built-in page), over the `shell.theme` setting.
- [x] **A settings page for the import matcher's tolerances:** three presets
      (Strict, Balanced, Lenient), each a consistent set, on the Options
      dialog's Import page
      ([import-manager-design.md](import-manager-design.md#matching-tolerances)).
- [ ] **More field kinds** when plugins need them: a folder with Browse…, a
      list of strings, a drop-down. The Archiving page's year start would use
      a drop-down for the month: a `choice` draws radio buttons, and twelve is
      too many, so it is a number for now.
- [x] **Reading other plugins' settings, read-only** (`context.settings.read`),
      and change events that name the settings that changed (`changed`).
      Every change goes through the settings manager (decided in review).
- [ ] **Enforce that in the renderer.** `shell:settings.commit` is meant for
      the Options dialog only, but any code in a window can reach it; the
      owner's checks still apply. Needs "Validate IPC senders" below.
- [ ] **Live apply** (deferred): settings that take effect as the user edits,
      with Cancel reverting.

## Theming and Material UI (proposed design)

Design: [theming-design.md](theming-design.md). Nothing here is built yet.

- [x] **Phase 0 spike:** `tessera-ui/` with a few components served to a
      plugin as a federation singleton; confirmed it sees the shell's theme.
      Results in [theming-design.md](theming-design.md#phase-0-results).
- [x] **Theme manager:** `ThemeService`, `ThemePort` over Electron
      `nativeTheme`, the `shell.themes` point, global selection plus
      per-window override, `shell.theme.*` commands and context keys,
      persistence in `app-state` (migrating the old `light`/`dark` value).
      The unused `useThemeState` hook is gone. Results in
      [theming-design.md](theming-design.md#phase-1-results).
- [x] **Choosing a theme and giving a window its own:** View ▸ Theme listed every
      registered theme, with a "This Window" submenu, and **Choose Theme…** opened a
      dialog with a preview ([theming-design.md](theming-design.md#the-theme-chooser)).
      Both replaced by the next item.
- [x] **The theme in the Options dialog:** the Appearance page, with a gallery of
      every theme drawn from its colours, the mode and a preview; the application's
      theme is the `shell.theme` setting, followed by the theme manager; the chooser
      and View ▸ Theme are removed
      ([theming-design.md](theming-design.md#the-appearance-page)).
- [ ] **A way to give one window its own theme** again, if it is wanted: the commands
      remain (`shell.theme.setForWindow`, `clearWindowOverride`), but nothing in the UI
      runs them since View ▸ Theme went, and changing the application's theme clears
      windows' own.
- [ ] **Look at reduced motion and forced colours in the real app** (Windows "show
      animations" off, and a high-contrast theme). Tested only through the theme and CSS.
- [x] **MUI foundation and no flash:** `ShellThemeProvider`, `CssBaseline`,
      `tessera.default` light and dark, hidden window until the theme is
      applied. Results in [theming-design.md](theming-design.md#phase-2-results).
- [ ] **Check the first frame for real.** Phase 2 was verified in the running
      app over the DevTools protocol, but nothing asserts that no frame is ever
      painted in the wrong colours. A screenshot-on-launch check in an e2e suite
      would (see "End-to-end tests in the repo").
- [ ] **Show a splash screen** in the interval a window is hidden.
- [x] **`@tessera/ui` and icons:** curated MUI exports for plugins, standard
      icon set on `@mui/icons-material`, plugin-registered icons
      (`shell.icons`) loaded lazily and cached. Results in
      [theming-design.md](theming-design.md#phase-3-results).
- [x] **Shell components** (`Bar`, `ItemStrip`, rail, splitter styling) on
      MUI, and `test-layout` without hardcoded colours. Results in
      [theming-design.md](theming-design.md#phase-4-results).
- [x] **Plugins:** share `@tessera/ui`, reject direct `@mui/*` imports in the
      plugin build, "Styling and theming" guide section, sample themed plugin.
      Results in [theming-design.md](theming-design.md#phase-5-results).
- [ ] **Re-evaluate density.** The shell is compact throughout; revisit once
      there are real finance screens.
- [ ] **Later:** splash screen, themed title bar and window controls. (The
      settings page for the theme is done: the Appearance page.) Contrast checks for
      contributed themes are done (they warn).
- [ ] **Settle the open questions** in the note (curated vs complete
      `@tessera/ui`, token breadth, who may change the theme, per-window
      native chrome). Token breadth is answered for typography by font roles
      (below): themes may set fonts.

## Fonts

Design: [font-roles-design.md](font-roles-design.md): font roles (kinds of
text), a Fonts page in the Options dialog, and fonts in themes.

- [x] **Phase 0, spike:** the type scale, listing installed fonts, the new
      variants through federation, the picker, the layout at 10 to 24 px.
      Results in [font-roles-design.md](font-roles-design.md#phase-0-results).
- [x] **Phase 1, roles as data:** the six roles, names and CSS, resolution,
      the roles in the MUI theme, with no visible change. Results in
      [font-roles-design.md](font-roles-design.md#phase-1-results).
- [x] **Decided:** the interface minimum is 11 px; the Navigator scales
      horizontally, as the register does.
- [x] **Phase 2, roles in the code:** `useFontRoles`, `@tessera/ui` 1.3,
      the literals migrated, registered icons sized like MUI's, the register's
      widths in `em` (no amount is cut to 24 px), the status column, the
      Navigator and tab strips, the guard test. Results in
      [font-roles-design.md](font-roles-design.md#phase-2-results).
- [ ] **Check phases 2 and 3 in Electron:** large sizes (phase 2 was checked in
      Chromium, in light mode), and a hand-edited `settings/shell.fonts.json`
      read at start-up with no flash (phase 3 was checked by tests and in
      Chromium, light and dark).
- [x] **Phase 3, the `shell.fonts` setting,** delivered to every window with
      the theme snapshot; nothing looks different at the defaults. Results in
      [font-roles-design.md](font-roles-design.md#phase-3-results).
- [x] **Phase 4, the Fonts page** (Tools ▸ Options… ▸ Appearance ▸ Fonts),
      listing installed fonts from a hidden probe window. Results in
      [font-roles-design.md](font-roles-design.md#phase-4-results).
- [ ] **Finish checking phase 4 in Electron.** Seen working on Windows: the
      page, saving, re-fonting. Still to check: the installed fonts are listed; the
      main window can't list them itself (`(await queryLocalFonts()).length` in its
      developer tools is 0); a restart keeps the fonts with no flash; macOS and
      Linux. See the results' checklist.
- [x] **Phase 5, themes set fonts,** by role, checked like colours; the
      user's choices win, and themes' fonts can be turned off. Results in
      [font-roles-design.md](font-roles-design.md#phase-5-results).
- [ ] **Later:** fonts shipped inside themes, roles contributed by plugins,
      text-size shortcuts, per-mode theme fonts, a "larger headings"
      percentage.

## Backup and restore

Design: [backup-restore-design.md](backup-restore-design.md): File › Back Up
Ledger… and Restore Ledger…, retention, backing up when the ledger closes, a
Backups page, and one long ledger operation at a time.

- [x] **Phase 0, spike:** snapshot methods, timings, the trash, locked files,
      side files, an import on quit, the quit budget; confirmed in Electron 45
      on Windows. Results in
      [backup-restore-design.md](backup-restore-design.md#phase-0-results).
- [x] **Phase 1, snapshots in the storage engines:** `Database.snapshot` and
      `StorageEngine.readMeta` on the memory, SQLite and Loki engines; Open
      checks a ledger from its meta. No visible change. Results in
      [backup-restore-design.md](backup-restore-design.md#phase-1-results).
- [x] **The three open points, settled:** a user quit is two passes (Retry,
      Quit Anyway, Cancel), with the backup on quit in the first; where there is
      no trash, expired backups are deleted.
- [x] **Phase 2:** File › Back Up Ledger…, retention in the default backup
      folder (the trash, or deleted where there is none), one ledger operation
      at a time (the import takes it), the ledger's id. Results in
      [backup-restore-design.md](backup-restore-design.md#phase-2-results).
- [ ] **Check phase 2 in Electron, the rest:** the status bar's result;
      Close, Open and Import greyed out during an import; a large ledger's
      percentage; the trash on a network share and a USB drive (Windows).
- [x] **Check phase 2 in Electron (Windows), first part:** Back Up Ledger…,
      the save dialog in Documents › Tessera Backups, the backup written and
      synced by OneDrive (the reviewer's screenshots).
- [x] **Phase 3:** File › Restore Ledger… and the Restore dialog (the
      backups in the default folder, Browse…), as a new ledger or in place of
      its ledger with the current file kept under a name the user chooses:
      never replaced or deleted. Results in
      [backup-restore-design.md](backup-restore-design.md#phase-3-results).
- [x] **Check phase 3 in Electron (Windows), first part:** a restore in place
      of the open ledger, the current file kept beside it (the reviewer's
      screenshots).
- [ ] **Check phase 3 in Electron, the rest:** open the kept file; restore as
      new; a pre-upgrade `.backup-….tessera`; a ledger damaged by hand, from
      the start view; a large ledger's steps; the rename with a second copy of
      Tessera or OneDrive holding the file.
- [x] **Phase 4:** the Backups page (the default folder, backing up on close,
      retention), the `folder` field kind; backing up as the ledger closes,
      in pass 1 of a user quit and within 3 s on an OS shutdown; the two-pass
      quit (Retry, Quit Anyway, Cancel; dialogs cancelled before pass 2);
      "Last backup failed" in the status bar; a message when a restore
      completes. Results in
      [backup-restore-design.md](backup-restore-design.md#phase-4-results).
- [ ] **Check phase 4 in Electron:** the Backups page and Browse…; Close
      Ledger after a change leaves a backup, and again without one doesn't;
      File › Exit and closing the window after a change; a quit during an
      import (Retry, Quit Anyway, Cancel); the backup drive unplugged (the
      reason on quit, "Last backup failed" at the next start); an OS shutdown.
- [ ] **Later:** Show in Folder, compression, reminders, pre-upgrade backups
      in the backup folder.

## Ledger compaction (archiving)

Design: [ledger-compaction-design.md](ledger-compaction-design.md): File ›
Archive Ledger…, which keeps a copy of the ledger as an archive file, removes
the reconciled and void transactions before a date (and closed accounts left
with nothing), carries each account's balance into its opening balance, and
shrinks the file.

- [x] **Phase 0, spike:** how long the removal holds the main process;
      `planArchive` and the balance check at 100,000 transactions; `VACUUM`
      after a large removal; a read-only open really being read-only; how much
      smaller the file gets. Results in
      [ledger-compaction-design.md](ledger-compaction-design.md#phase-0-results):
      the removal must delete by id (never `$in`), yield, check balances with a
      plain sum, and commit large batches in the SQLite driver's worker (longest
      stall 2.8 s → 0.14 s at 100,000 transactions); `VACUUM` in the worker,
      under the commit lock, shrinks the file to the size of what is left;
      read-only viewing changes nothing.
- [ ] **Check Phase 0 on Windows, in Electron 45:** the removal's stall, the
      worker commit, `VACUUM` beside the kit's connection, read-only viewing
      (in Phase 4's smoke test).
- [x] **Phase 1:** the archive participant contract and the accounts rules
      (no visible change): `participateInArchive` and the ledger's one
      storage transaction, `ledger.archives`; `lastArchiveDate` and
      `archived` on accounts; the rule, the carry, closed accounts with
      nothing left, the warning, and the check that no balance changed.
      Results in
      [ledger-compaction-design.md](ledger-compaction-design.md#phase-1-results).
- [x] **Phase 2:** imports follow the archive: the import's records of
      archived transactions pruned where an import can no longer add them
      again; a statement line dated before an account's last archival date
      never added (it can still be matched to a transaction that stayed), and
      counted in the summary. Results in
      [ledger-compaction-design.md](ledger-compaction-design.md#phase-2-results).
- [x] **Decided:** a transaction can't be dated before its account's last
      archival date (refused, however it is entered; one that stayed from
      before the date can still be edited). Archive files keep `.tesserabkp`.
      See [ledger-compaction-design.md](ledger-compaction-design.md#entering-transactions-after-an-archive).
- [x] **Phase 3:** opening an archive file read-only (File › Open Ledger…),
      never backed up, deleted or listed as recent; Restore lists and restores
      archive files; retention never trims them; `npm run sample:archive` makes
      a sample ledger and archive to try. Results in
      [ledger-compaction-design.md](ledger-compaction-design.md#phase-3-results).
- [ ] **Check Phase 3 in Electron:** `npm run sample:archive`, open the archive
      (status item, edits refused, Back Up and Delete greyed out), open the
      ledger, restore the archive in place, restart (not reopened). See the
      results' smoke test.
- [x] **Phase 4:** File › Archive Ledger…, its dialog, and the Archiving page
      (Tools › Options… › Ledger › Archiving); the register's first row dated
      the last archival date, with a tooltip, and a note in the account
      dialog; dates in messages in the user's format (`displayDate`). Results
      in [ledger-compaction-design.md](ledger-compaction-design.md#phase-4-results).
- [ ] **Check Phase 4 in Electron (Windows):** archive the sample again before
      1 Oct 2026 and compare balances; the register's first row and tooltip;
      open the new archive file; restore it in place; the Archiving page's
      suggestion; re-import a statement after archiving. See the results'
      [smoke test](ledger-compaction-design.md#smoke-test-for-phase-4).
- [x] **After Phase 4:** transactions refused before the last archival date;
      the register, the Accounts navigator and the Ledger panel offer nothing
      that changes a read-only ledger (the register's context menu and editing
      were still active in an archive file).
      [Changes](ledger-compaction-design.md#after-phase-4-entering-transactions-and-read-only-views).
- [ ] **Check in Electron (Windows):** in an archive file, right-click a
      register row (no menu), double-click it (a note, no editor), the
      navigator's menu greyed out; in the ledger, a new transaction dated before
      the last archival date refused on its date field.
- [x] **Phase 5, compaction:** `Database.compact` (SQLite `VACUUM` in the
      driver's worker, after checking for room), run as the archive's last
      step; the message gives the file's new size. Results in
      [ledger-compaction-design.md](ledger-compaction-design.md#phase-5-results).
- [ ] **Check Phase 5 in Electron (Windows):** the "Compacting" step and the
      message's sizes against Explorer, with no `-wal` left once closed.
- [ ] **Phase 5, large commits in the worker:** commit a batch of 5,000
      changes or more through the SQLite driver's worker, so archiving 100,000
      transactions doesn't hold the window for 0.7 to 0.9 s (it would be about
      50 ms). Not started; see the design's Phase 5.
- [ ] **Later: the year start per ledger.** The Archiving page's year start
      (and years kept) is an application setting for now. A household ledger
      follows the calendar and a business's its fiscal year, so it belongs to
      the ledger once settings have a per-ledger scope
      ([settings-design.md](settings-design.md#the-idea-layers-of-overrides)).
- [ ] **Later:** Change… for the archive file's folder; viewing any backup
      read-only from the Restore dialog; opening an older archive through an
      upgraded temporary copy. See the design's Phase 6.

## Localisation

- [ ] **Localise the application**: menus, views, dialogs, messages, and the
      titles, field labels and messages of settings pages, from one
      application-wide mechanism rather than per feature.

## Menus, commands and context keys

- [ ] **Visibility.** Items can be disabled but not hidden; add a `when`
      expression for visibility.
- [ ] **Dynamic labels**, e.g. `Save "Home Vault"`.
- [ ] **Checkbox and radio items.**
- [ ] **Context menus and toolbars** as extension points bound to the same
      commands.
- [ ] **Menu structure changes at runtime.** The structure is built once,
      after activation; only enabled state is live.
- [ ] **Context keys in the renderer**, so views can enable buttons from the
      same state as menus.
- [ ] **macOS application menu.** No app-name menu is added as the first
      menu on macOS. It would hold "Preferences…" (`shell.settings.open`),
      which is Tools › Options… elsewhere.

## Views and the renderer

- [ ] **Main-area tabs.** The layout controller provides the five slots and
      tabbed bars, but the main area shows one active view with no tab strip
      (see phase 5 of
      [layout-controller-design.md](layout-controller-design.md)).
- [ ] **View props and context.** Views receive nothing from the shell;
      they use `window.api` directly. (Dialogs and settings pages do receive
      props: `DialogProps`, `SettingsPageProps`.)
- [ ] **Refresh views at runtime.** The renderer fetches the view list once.
- [ ] **Renderer takes part in shutdown.** `shuttingDown` reaches views as an
      event only. Views can't delay or veto a quit (say, to flush an editor);
      that needs an acknowledgement round trip with a time limit.
- [ ] **Hooks and typings for plugin views.** `useAppPhase` and
      `useContextKey` exist for shell components only. Offer them (and typed
      `window.api.on`) to plugin views through the SDK.
- [ ] **Events to one window.** Pushed events go to every open window; add
      targeting if multiple windows are supported.
- [ ] **Push more shell state.** Candidates: plugin list changes. (Settings
      changes and the request to open the Options dialog are pushed:
      `shell:settings.changed`, `shell:settings.open`.)
- [ ] **Example plugin with a real federation build**, e.g.
      `@module-federation/vite`, checked into the repo. Then the plugin
      guide can show tested build config instead of requirements only.

## Security

- [ ] **Content-Security-Policy.** None is set (Electron warns in dev). It
      must allow the `tessera-plugin:` scheme, and Emotion's runtime styles
      once MUI lands (use a nonce; see
      [theming-design.md](theming-design.md#plugins-and-module-federation)).
- [ ] **Set `contextIsolation` and `sandbox` explicitly** on the
      `BrowserWindow` (they're currently the defaults).
- [ ] **Validate IPC senders.** The invoke handler doesn't check which frame
      or window a request came from.

## Build and packaging

- [ ] **Commit a lockfile.** A plain `npm install` from a clean checkout
      works again (checked on 2026-11-06, with no `--legacy-peer-deps`), but
      with no lockfile two installs of the same package.json can differ: that
      is how two copies of `@testing-library/dom`, and React 19's types, got
      in. (`package-lock.json` is in `.gitignore`.) It is also how an old
      `@module-federation/vite` (before 1.16.0) stayed installed after the range
      moved, and broke the build once there were three federated plugins. The
      range is now `^1.23.0`, and `build-plugins.mts` names an old install
      (see [import-manager-design.md](import-manager-design.md#fixes-after-the-first-windows-run)).
- [x] **`@types/react` and `@types/react-dom` 18.x are devDependencies.**
      Without them `tsc` hid every renderer type error. Once MUI's optional
      peer brought in React 19's types, it also reported false ones. `tsc -p plugins`
      is clean. `-p shell` (16) and `-p tests` (34) still report the stale
      imports below, which the missing types used to bury under ~380 errors.

- [ ] **Production loading.** The window always loads
      `http://localhost:5173`; add a production `loadFile` path, a renderer
      production build, and packaging (e.g. electron-builder).
- [ ] **Clean `dist/` deliberately.** None of the three builds empties
      `dist/` any more, so files from renamed or removed bundles stay
      there. Add a `clean` step, or give each bundle its own output folder.
- [ ] **Stale imports from the restructure.** `tsc --noEmit -p shell` and
      `-p tests` report errors: modules still import `Logger`, `Disposable`
      and `PluginContext` from `core/ports` and `core/plugins/PluginContext`
      (they now live in `@tessera/types`), and `core/lifecycle/shutdown.ts`
      imports `AppLifecycle` from the implementation file. `lokijs` has no
      type declarations. These are type-only, so the app still runs.
- [ ] **`core/vite.config.ts` sits in `core/`**, and the boundary test has to
      skip `*.config.ts` files to allow it.
- [ ] **Debug logging.** `PluginManager`, `ServiceRegistryImpl` and the
      `storage-loki` plugin still print `console.log` diagnostics, including
      the whole plugin context.
- [ ] **`tsc -b` emits `.js` next to sources.** The tsconfigs have no
      `noEmit` or `outDir`, and project references lack `composite: true`.
- [ ] **Path aliases are inconsistent.** In `shell/preload/vite.config.ts`,
      `@shared` points to `shell/`. `@core` and `@extensions` aliases (and
      the `extension-registry` folder) don't match the code. The code
      itself mostly uses relative imports.
- [ ] **`@types/node` 26 vs Electron 30.** The type clash is currently
      hidden by `skipLibCheck`; align the Node types with Electron's Node
      version.
- [ ] **`scripts/dev.mts`:** it launches Electron on every stdout chunk
      containing `http://localhost:` (it could start more than one), and it
      swallows the renderer dev server's stdout.

## Testing and tooling

- [ ] **End-to-end tests in the repo.** The Playwright `_electron` driver
      used to verify features in the real app lives outside the repo; check
      it in as an e2e suite, or as a project run skill.
- [ ] **One Electron mock.** `tests/main/app.test.ts` defines its own inline
      mock alongside the global one in `tests/setup/mockElectron.ts`.
- [ ] **Vitest mock defaults.** `vitest.config.ts` sets `clearMocks`,
      `mockReset` and `restoreMocks` to `false` because Vitest 5 resets
      mocks before each test, which discards the calls made when the preload
      script is imported.
- [ ] **Slow dialog tests.** Tests that type into MUI forms key by key take 1 to 4 seconds each in jsdom, because
      every keystroke re-renders the whole form. The full suite flaked at Vitest's default 5-second timeout, so it is
      now 15 seconds (`vitest.config.ts`). Making those forms cheaper to re-render, or typing only where per-key
      behaviour is what is tested (`userEvent.paste` elsewhere), would let the limit come back down. Now the suite has
      grown, the account dialog's tests in `tests/plugins/accounts/renderer/views.test.tsx` and `accountDialog.test.tsx`
      (*creates an account where it was asked to…*, *relabels the balance for a liability…*, *saves both, in minor
      units*) sometimes pass 15 seconds under a full run on a 4-core machine, and pass alone and on the next run: the
      first candidates for pasting. The Fonts page (`tests/renderer/fontsPage.test.tsx`, *shows what the window's
      theme sets…*, *cannot be changed when the settings are read-only*) has done the same once, and so have the
      reconcile statement dialog (`tests/plugins/accounts/renderer/reconcile.test.tsx`) and the ledger's start view
      (`tests/plugins/ledger/renderer/views.test.tsx`). Which ones time out varies from run to run on a 4-core
      machine. The CSV Columns tests were brought well under the limit by finding elements by label and text
      rather than by role and accessible name (see import-formats-design.md, phase F4): the same would help here.
- [ ] **A SQLite snapshot failed once under a full run:** *lets writes carry on, and copies one committed state*
      (`tests/plugins/storage.sqlite/SqliteStorageEngine.test.ts`) gave `could not snapshot database … : not an error`,
      and passed alone and on the next run. SQLite's online backup can return BUSY while a write holds the database;
      the snapshot may need to retry a step then, rather than report it.
- [x] **React `act(...)` warnings fail the test.** They were noise that came and went with timing: a test asserted
      before the component had settled (a click's reply, a load on mount). `tests/setup/setupTests.ts` now fails the
      test that caused one, naming the component. Wait for what the user sees (`findBy…`, `waitFor`); when nothing
      visible changes, such as a load that confirms what is drawn, `await settle()` from `tests/helpers/settle.ts`.
      The 18 tests that warned were fixed, plus 7 plugin-dialog tests whose race showed only with slower replies.
- [x] **One copy of `@testing-library/dom`.** It is a peer dependency of user-event, and wasn't in package.json, so a
      plain `npm install` put 10.x at the top for user-event and kept React Testing Library's 9.x nested. user-event's
      events then skipped act(...), and about 90 tests failed with act errors in MUI's ForwardRef and Transition.
      React Testing Library is now 16, which takes `@testing-library/dom` as a peer dependency, and package.json
      names the `^10.4.0` all three share. (The first fix, pinning 9.x for React Testing Library 14, clashed with
      jest-dom 6.10's peer dependency on 10.x, and a clean install failed.) `tests/setup/singleDomCopy.ts` stops the
      run with the real cause if two copies appear again. The missing lockfile (see "Build and packaging") is why two
      installs of the same package.json differed.
- [x] **Test files share workers where they can** (`vitest.config.ts` projects): `electron` (tests/main,
      tests/preload) stays isolated, because those tests mock Electron per file and load `shell/main` against the mock;
      `shared` (everything else) runs with `isolate: false`, about a third faster here. The setup file unmounts every
      test's components itself, and switches on React's act checks for every file: Testing Library does both only in
      a worker's first file, so later files had no cleanup and no act warnings at all.
      A test that mocks modules (`vi.mock`) must go in the isolated project. Checked with shuffled file and test order,
      which also found that `tests/main/app.test.ts` (one app shared by the file) depended on its test order; its
      theme test now restores the theme, and the file keeps its written order (`shuffle: false`), as its start-up test
      needs.
- [ ] **Quiet the expected output.** The build tests print Module Federation's warnings about shared dependencies,
      one test builds a broken plugin on purpose, and error-path tests log (a missing icon, a provider outside its
      tree). None is a failure, but they fill the output; capture or silence them in the tests that cause them.
- [ ] **Linting.** ESLint isn't configured.
- [ ] **CI.** Run tests, type-checks and the architecture boundary test on
      every push.
