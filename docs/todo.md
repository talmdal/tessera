# Open work

Known gaps and planned work, grouped by area. Each item is something the
framework doesn't do yet, or does in a way we intend to change. Tick items
off, or delete them, as they land.

## Plugin runtime

- [ ] **Configurable shutdown time limit.** It is fixed at 10 seconds.
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
      returned `Disposable` onto `context.subscriptions`. `storage-loki` and
      `app-state` don't yet. Decide whether to enforce this in the core or
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
- [ ] **More shell services:** recent files, atomic writes, backups and file
      locks for `shell.files`; later `shell.notifications`, `shell.settings`,
      and a secure password prompt.

## Finance: books and accounts

Design: [account-manager-design.md](account-manager-design.md); plan, phase by
phase: [account-manager-implementation.md](account-manager-implementation.md).
The storage engine it builds on is done ([storage-engine-redesign.md](storage-engine-redesign.md)).

- [x] **Phase 0, framework prerequisites:** the `@tessera/book-api` and
      `@tessera/accounts-api` contracts, `shell.prompts`, `shell.files`,
      `shell.dialogs`, `@tessera/ui` 1.1, and SQLite as the default engine.
- [x] **Phase 1:** the `book` plugin (files, sub-books, start view, Book
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
      long registers, sorting and filtering, splits, and an `externalId` on
      drafts for import.
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
- [ ] **Later:** statement import (`accounts.importers`, from
      [vault-design.md](vault-design.md)), per-file storage formats, splits,
      `.mny` migration.

## State and settings (proposed design)

Design: [settings-design.md](settings-design.md). Nothing here is built yet.

- [ ] **State store** (`context.state`): per-plugin opaque key/value for
      recent files, window bounds and similar.
- [ ] **Settings core** (`context.settings`): defaults, versioned
      migration, validation, change events, failure handling.
- [ ] **Settings dialog and `shell.settings.pages`:** navigation tree, draft
      with OK/Apply/Cancel, Restore Defaults, search, `Ctrl+,`. Needs view
      props and main → renderer events (both listed below).
- [ ] **Optional declarative settings form** for simple plugins; **vault
      scope** for per-vault settings.

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
- [x] **Choosing a theme and giving a window its own:** View ▸ Theme lists every
      registered theme, with a "This Window" submenu (see
      [theming-design.md](theming-design.md#phase-6-results)), and **Choose Theme…**
      opens a dialog with a preview ([theming-design.md](theming-design.md#the-theme-chooser)).
- [ ] **Tick the current theme and mode in View ▸ Theme** (needs radio or
      checkbox menu items, below).
- [ ] **List themes that appear after startup in View ▸ Theme.** The menu is built
      once after activation (see "Menu structure changes at runtime"); until then such a
      theme works as a command only.
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
- [ ] **Later:** splash screen, themed title bar and window controls, and a
      settings page for the theme (needs the settings framework). Contrast checks for
      contributed themes are done (they warn).
- [ ] **Settle the open questions** in the note (curated vs complete
      `@tessera/ui`, token breadth, who may change the theme, per-window
      native chrome).

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
      menu on macOS.

## Views and the renderer

- [ ] **Main-area tabs.** The layout controller provides the five slots and
      tabbed bars, but the main area shows one active view with no tab strip
      (see phase 5 of
      [layout-controller-design.md](layout-controller-design.md)).
- [ ] **View props and context.** Views receive nothing from the shell;
      they use `window.api` directly.
- [ ] **Refresh views at runtime.** The renderer fetches the view list once.
- [ ] **Renderer takes part in shutdown.** `shuttingDown` reaches views as an
      event only. Views can't delay or veto a quit (say, to flush an editor);
      that needs an acknowledgement round trip with a time limit.
- [ ] **Hooks and typings for plugin views.** `useAppPhase` and
      `useContextKey` exist for shell components only. Offer them (and typed
      `window.api.on`) to plugin views through the SDK.
- [ ] **Events to one window.** Pushed events go to every open window; add
      targeting if multiple windows are supported.
- [ ] **Push more shell state.** Candidates: plugin list changes, settings
      changes, a "settings dialog open" request.
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

- [ ] **`npm install` fails from a clean checkout.** There is no lockfile, and
      `package.json` asks for versions that aren't published:
      `@rollup/plugin-alias@^6.0.1` (latest 6.0.0),
      `@rollup/plugin-typescript@^12.3.1` (12.3.0) and `rollup@^4.65.0`
      (4.64.12). `rollup-plugin-typescript2` also needs `--legacy-peer-deps`.
      Fix the ranges and commit a lockfile.
- [ ] **`@types/react` is not a dependency**, so every `.tsx` file reports
      "Could not find a declaration file for module 'react'" under
      `tsc --noEmit`, which hides real type errors in the renderer. Add
      `@types/react` and `@types/react-dom` (18.x) to `devDependencies`.

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
- [ ] **Linting.** ESLint isn't configured.
- [ ] **CI.** Run tests, type-checks and the architecture boundary test on
      every push.
