# Open work

Known gaps and planned work, grouped by area. Each item is something the
framework doesn't do yet, or does in a way we intend to change. Tick items
off, or delete them, as they land.

## Plugin runtime

- [ ] **Deactivate plugins on quit.** `PluginManager.deactivateAll()` exists
      but isn't called when the app quits, so plugins can't rely on
      `deactivate` to flush state.
- [ ] **Bundled plugins.** Only the user-data `modules/` folder is scanned.
      Load built-in plugins from a folder shipped with the app (the reserved
      `plugins/` directory), so Finance, and eventually the shell's own
      features, go through the same mechanism.
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

## Services

- [ ] **Optional dependencies.** `has()` and `get()` work for undeclared
      services, but nothing orders their provider first. Add
      `services.optional`: order like `requires`, without the all-or-nothing
      rule.
- [ ] **Service versioning**, so breaking changes to a service like
      `vault.store` can be told apart from compatible ones.
- [ ] **Typed service tokens** for TypeScript plugins (`get<T>()` currently
      trusts the caller).
- [ ] **Shell services.** Candidates: `shell.dialogs` (open/save/message
      boxes), `shell.notifications`, `shell.settings`.

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

- [ ] **Slot layouts.** `<Slot>` stacks views one after another. Add a real
      layout (tabs or navigation for the main area) and more slots (sidebar,
      status bar).
- [ ] **View props and context.** Views receive nothing from the shell;
      they use `window.api` directly.
- [ ] **Refresh views at runtime.** The renderer fetches the view list once.
- [ ] **Main → renderer events.** IPC only goes renderer → main; add push
      events (e.g. "contributions changed", "context keys changed").
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
- [ ] **`tsc -b` emits `.js` next to sources.** The tsconfigs have no
      `noEmit` or `outDir`, and project references lack `composite: true`.
- [ ] **Path aliases are inconsistent.** In `shell/preload/vite.config.ts`,
      `@shared` points to `shell/`. `@core` and `@extensions` aliases (and
      the `extension-registry` folder) don't match the code. The code
      itself mostly uses relative imports.
- [ ] **`@types/node` 26 vs Electron 30.** The type clash is currently
      hidden by `skipLibCheck`; align the Node types with Electron's Node
      version.
- [ ] **`scripts/dev.ts`:** it launches Electron on every stdout chunk
      containing `http://localhost:` (it could start more than one), and it
      swallows the renderer dev server's stdout.

## Testing and tooling

- [ ] **End-to-end tests in the repo.** The Playwright `_electron` driver
      used to verify features in the real app lives outside the repo; check
      it in as an e2e suite, or as a project run skill.
- [ ] **One Electron mock.** `tests/main/app.test.ts` defines its own inline
      mock alongside the global one in `tests/setup/mockElectron.ts`.
- [ ] **Linting.** ESLint isn't configured.
- [ ] **CI.** Run tests, type-checks and the architecture boundary test on
      every push.
