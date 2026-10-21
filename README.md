# Tessera

Tessera is a desktop personal-finance application, intended as a replacement
for Microsoft Money Plus, built with Electron, React and TypeScript.

It's built as a **framework that doesn't know about any business
function**, with Finance supplied by plugins. The shell provides a window, a
menu bar, IPC and a plugin runtime. Everything else is contributed by
plugins through extension points and services, in the spirit of the Eclipse
platform.

> **Status: early.** The shell and plugin framework work end to end. There
> are no Finance features yet; those will arrive as plugins. See
> [docs/todo.md](docs/todo.md) for what's still open.

## What works today

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
  `vault.isOpen && vault.isDirty`, and update while the app runs.
- **Views extension point** (`shell.views`): plugin UI is written as
  `.tsx` and loaded at runtime as a **Module Federation** remote. Views
  share the shell's React, and each is isolated by its own error boundary.
- **Built-in plugins:** source in `plugins/<id>/`, built (TypeScript and
  TSX) into `modules/<id>/` with `npm run build:plugins`, and loaded before
  user-installed plugins.
- **Services:** plugins provide and require services, such as `vault.store`,
  declared in their manifest. Two exist today: `storage.engine` (provided by
  the `storage-loki` plugin) and `app.state` (provided by `app-state`, which
  requires `storage.engine`).
- **Storage and application state:** a `StorageEngine` interface
  (collections, queries, transactions) with a LokiJS implementation, and an
  `app-state` plugin that keeps window, theme and sidebar state on top of it,
  exposed to views over IPC (`app.state:get`, `:set`, `:update`, `:remove`).
- **IPC:** a single dispatcher channel. Handlers are registered on channels
  named `<pluginId>:<event>` by convention, and replies are a structured
  success-or-error envelope. Events flow the other way too: the shell publishes its phase,
  context keys and views, and plugins push their own events to views.

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
          schema, menu and view contracts, enablement expressions. No
          platform code.
core/     Main-process application core: plugin manager, plugin context,
          and the registry implementations (IPC, extensions, commands,
          context keys, services, lifecycle, events) plus the storage engine
          registry and transaction manager. Depends only on tessera-types/,
          shared/ and its own ports.
shell/
  main/       Composition root and adapters: Electron menu, IPC binding,
              file-system plugin source, tessera-plugin:// protocol.
  preload/    The typed bridge exposed to the renderer as window.api.
  renderer/   React host: <Slot> rendering and the federation view loader.
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
| Command | let the user trigger an action | `vault.save` |
| Context key | publish state that enablement depends on | `vault.isDirty` |
| Service | let other plugins call into your code | `vault.store` |
| IPC | connect your view to your own privileged code | `window.api.invoke('vault:edit')` |
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
plugins/              Source of bundled (built-in) plugins, one folder each:
                      app.state (application state) and storage.loki
                      (LokiJS storage engine)
modules/              Build output of plugins/ (gitignored); loaded at startup
```

## Documentation

- [docs/plugin-creation.md](docs/plugin-creation.md): how to write a plugin
  and connect it to the framework
- [docs/vault-design.md](docs/vault-design.md): proposed design for the
  vault, pluggable storage, importers and file handling
- [docs/storage-api-design.md](docs/storage-api-design.md): proposed
  `Store` API that storage backends implement and domain plugins use (the
  lower-level `StorageEngine` it would build on already exists)
- [docs/settings-design.md](docs/settings-design.md): proposed settings
  framework where plugins own their settings shape and pages
- [docs/todo.md](docs/todo.md): known gaps and planned work

## License

[MIT](LICENSE) © 2026 Tim Almdal
