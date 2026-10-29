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
- [ ] **Keep the shared React range in sync.** `SHARED_REACT_RANGE` in
      `scripts/build-plugins.mts` must match the shell's React; derive it from
      `package.json` or the shell's loader instead.
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
- [ ] **Shell services.** First `shell.files`: dialogs, recent files, atomic
      writes, backups and locks, as sketched in
      [vault-design.md](vault-design.md). Later `shell.notifications`,
      `shell.settings`, and a secure password prompt.

## Vault and storage (proposed designs)

Designs: [vault-design.md](vault-design.md) and
[storage-api-design.md](storage-api-design.md). Nothing here is built yet.

- [ ] **Storage contract:** `Store` types, `StoreError`, an in-memory store
      and the shared backend conformance suite.
- [ ] **Vault plugin:** `vault.session`, the `vault.backends` and
      `vault.schema` points, commands, menus and context keys.
- [ ] **Backends:** encrypted-file first (no native module), then SQLite
      (settle the native-module and packaging question).
- [ ] **Accounts plugin:** schema and migrator, `accounts.service`, register
      views, then `accounts.importers` with OFX, QIF and CSV parsers.
- [ ] **Settle the open questions** in both notes: aggregation for reports,
      passwords and keys, one vault versus several, `.mny` import.

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
      must allow the `tessera-plugin:` scheme.
- [ ] **Set `contextIsolation` and `sandbox` explicitly** on the
      `BrowserWindow` (they're currently the defaults).
- [ ] **Validate IPC senders.** The invoke handler doesn't check which frame
      or window a request came from.

## Build and packaging

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
