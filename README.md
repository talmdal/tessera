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
  plugin is logged and skipped), and cleans up everything a plugin
  registered when it's deactivated.
- **Menu bar extension point** (`shell.menus`): hierarchical menus, groups
  separated automatically, and fixed positions for `File`, then plugin
  menus, then `Tools`, then `Help`.
- **Commands with live enablement:** menu items follow their command's
  `enablement` expression over **context keys**, such as
  `vault.isOpen && vault.isDirty`, and update while the app runs.
- **Views extension point** (`shell.views`): plugin UI is loaded at runtime
  as **Module Federation** remotes. They share the shell's React and each
  view is isolated by its own error boundary.
- **Services:** plugins provide and require services, such as `vault.store`,
  declared in their manifest.
- **IPC:** a single dispatcher channel. Each plugin's handlers live under
  `<pluginId>:<event>`, and replies are a structured success-or-error
  envelope.

## Architecture

The code is hexagonal: the core is platform-free and depends only on ports,
and Electron and the file system sit behind adapters.

```
shared/   Contracts any process may import: IPC envelope, manifest schema,
          menu and view contracts, enablement expressions. No platform code.
core/     Main-process application core: plugin manager, scoped plugin context,
          registries (IPC, extensions, commands, context keys, services).
          Depends only on shared/ and its own ports.
shell/
  main/       Composition root and adapters: Electron menu, IPC binding,
              file-system plugin source, tessera-plugin:// protocol.
  preload/    The typed bridge exposed to the renderer as window.api.
  renderer/   React host: <Slot> rendering and the federation view loader.
```

Dependencies point inwards only (`shell` → `core` → `shared`), and the
renderer never imports `core/` or main-process code.
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

The full guide to writing a plugin is
**[docs/plugin-creation.md](docs/plugin-creation.md)**.

## Getting started

Prerequisites: Node.js and npm (developed with Node 24), on Windows, macOS or
Linux.

```bash
npm install
npm run dev
```

`npm run dev` builds the main and preload bundles, starts the Vite renderer
dev server on port 5173, launches Electron, and stops the dev server when
Electron exits.

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
To experiment without touching your real profile, launch Electron with
`--user-data-dir=<some folder>`. The
[Quick start](docs/plugin-creation.md#quick-start) has a complete plugin to
try.

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Build main and preload, start the renderer dev server, launch Electron |
| `npm test` | Run the test suite once (Vitest) |
| `npm run test:watch` | Run tests in watch mode |
| `npm run test:ui` | Vitest UI |
| `npm run dev:main` / `dev:preload` | Rebuild one bundle in watch mode |
| `npm run dev:renderer` | Renderer dev server only |
| `npm run dev:electron` | Launch Electron against the current build |

Type-check with `npx tsc --noEmit -p <core|shared|shell|tests>`. Always pass
`--noEmit`: the tsconfigs don't set an output directory yet, so a bare
`tsc -b` writes `.js` files next to the sources.

## Project layout

```
core/                 Platform-free application core (see Architecture)
shared/               Cross-process contracts
shell/main/           Electron main process: composition root and adapters
shell/preload/        window.api bridge
shell/renderer/       React host and view loading
scripts/dev.ts        Development launcher used by npm run dev
tests/                Vitest suites, mirroring the source folders, plus
                      architecture boundary tests and fixtures
docs/                 Plugin guide and open-work list
plugins/              Reserved for bundled plugins (not loaded yet)
```

## Documentation

- [docs/plugin-creation.md](docs/plugin-creation.md): how to write a plugin
  and connect it to the framework
- [docs/vault-design.md](docs/vault-design.md): proposed design for the
  vault, pluggable storage, importers and file handling
- [docs/storage-api-design.md](docs/storage-api-design.md): proposed
  `Store` API that storage backends implement and domain plugins use
- [docs/todo.md](docs/todo.md): known gaps and planned work

## License

[MIT](LICENSE) © 2026 Tim Almdal
