# Creating a Tessera plugin

Tessera is a framework that doesn't know about any particular business
function. The shell provides a window, a menu bar, IPC and a plugin runtime,
and everything else, including features like Finance, comes from plugins. This
guide explains how to write a plugin and connect it to the framework's
extension points.

- [How a plugin fits in](#how-a-plugin-fits-in)
- [Quick start](#quick-start)
- [Plugin layout and installation](#plugin-layout-and-installation)
- [Built-in plugins](#built-in-plugins)
- [The manifest](#the-manifest)
- [The privileged entry](#the-privileged-entry)
- [Naming rules](#naming-rules)
- [Commands](#commands)
- [Enabling and disabling commands](#enabling-and-disabling-commands)
- [Contributing menus](#contributing-menus)
- [IPC between your view and your privileged code](#ipc-between-your-view-and-your-privileged-code)
- [Providing and using services](#providing-and-using-services)
- [Contributing views](#contributing-views)
- [Contributing colours and themes](#contributing-colours-and-themes)
- [The renderer remote](#the-renderer-remote)
- [Application lifecycle](#application-lifecycle)
- [Lifecycle and cleanup](#lifecycle-and-cleanup)
- [Troubleshooting](#troubleshooting)
- [Reference](#reference)

---

## How a plugin fits in

A plugin has up to two halves, and they run in different processes:

| Half | Runs in | Can use | Purpose |
|---|---|---|---|
| **Privileged** (required) | Electron main process | Node.js and the `PluginContext` | Registers commands, IPC handlers and contributions |
| **Renderer** (optional) | The window (Chromium) | React (shared with the shell) and `window.api` | Supplies the UI components for your views |

The two halves talk to each other only through IPC. Plugins never import the
shell or each other; they connect in two ways:

- **Extension points**, for adding things: named places where the shell, or
  another plugin, accepts contributions such as menu items and views. You
  describe what you contribute, and the owner decides where and when to use
  it.
- **Services**, for calling things: objects with methods that one plugin
  provides and others use, such as a `vault.store` that reads and writes the
  vault.

```
 manifest.json ──► PluginManager ──► activate(context)
                                        │
          ┌─────────────────────────────┼────────────────────────────┐
          ▼                             ▼                            ▼
 context.commands.register   context.extensions.contribute   context.ipc.register
          │                    'shell.menus' / 'shell.views'         │
          ▼                             │                            ▼
   menu item clicks ◄── native menu bar │              window.api.invoke('<id>:<event>')
                                        ▼                            ▲
                         <Slot> in the window ── loads ──► your renderer remote
                                                         (Module Federation)
```

Contributions are **plain data**. Menus and views name a command id or a
module rather than holding functions. This keeps them serialisable, which
lets the shell resolve, validate, order and lazy-load them.

---

## Quick start

This is a complete, working plugin called `budget`. It adds a **Budget** menu
with one command, and a view in the main window area that fetches data from
its own privileged code.

```
budget/
├── manifest.json
├── src
    ├── privileged/
    │   └── index.js
    └── renderer/
        └── remoteEntry.js
```

**`manifest.json`**

```json
{
  "id": "budget",
  "name": "Budget",
  "version": "0.1.0",
  "privileged": { "entry": "privileged/index.js" },
  "renderer": { "entry": "renderer/remoteEntry.js" }
}
```

**`src/privileged/index.js`**

```js
exports.activate = (context) => {
  // Backend endpoint, reachable from the renderer as 'budget:summary'
  context.ipc.register('budget:summary', async () => ({ month: 'October', remaining: 412.5 }))

  // A command, and a menu that runs it
  context.commands.register('budget.newCategory', () => console.log('[budget] new category'))
  context.extensions.contribute('budget', 'shell.menus', 'budget.menu',
    { kind: 'menu', id: 'budget.menu', label: '&Budget' })
  context.extensions.contribute('budget', 'shell.menus', 'budget.newCategory', {
    kind: 'item', id: 'budget.newCategory', label: '&New Category…',
    parent: 'budget.menu', command: 'budget.newCategory'
  })

  // A view in the main slot, implemented by the renderer remote's ./SummaryView
  context.extensions.contribute('budget', 'shell.views', 'budget.summary', {
    id: 'budget.summary', title: 'Budget Summary', slot: 'shell.main', module: './SummaryView'
  })
}
```

**`src/renderer/remoteEntry.js`**: a minimal hand-written Module Federation
container. In practice you'll generate this with a build tool (see
[The renderer remote](#the-renderer-remote)), but this version runs as is.

```js
let shareScope
export function init(scope) { shareScope = scope }

async function shared(name) {
  const versions = shareScope[name]
  return (await versions[Object.keys(versions)[0]].get())()
}

export async function get(module) {
  if (module !== './SummaryView') throw new Error(`Module ${module} is not exposed`)
  const React = await shared('react')   // the shell's React, not a bundled copy

  function SummaryView() {
    const [summary, setSummary] = React.useState()
    React.useEffect(() => { window.api.invoke('budget:summary').then(setSummary) }, [])
    if (!summary) return React.createElement('p', null, 'Loading…')
    return React.createElement('p', null, `${summary.month}: $${summary.remaining} remaining`)
  }

  return () => ({ default: SummaryView })
}
```

Copy the `budget/` folder into the plugins directory (see below) and start
Tessera. You'll see `File | Budget | Tools | Help` in the menu bar, and the
summary in place of the welcome text.

---

## Plugin layout and installation

At startup the shell scans every folder in the plugins directory for a
`manifest.json`:

| OS | Plugins directory |
|---|---|
| Windows | `%APPDATA%\tessera\modules\` |
| macOS | `~/Library/Application Support/tessera/modules/` |
| Linux | `~/.config/tessera/modules/` |

(This is Electron's `app.getPath('userData')` plus `modules`.)

- The folder name doesn't matter; the manifest `id` identifies the plugin.
  `budget-0.1.0/` is fine.
- Folders without a `manifest.json` are ignored.
- Every path in the manifest is relative to the plugin folder and must stay
  inside it.
- Plugins are discovered and activated **once, at startup**. Restart Tessera
  after installing or changing a plugin.

---

## Built-in plugins

Plugins that ship with Tessera (Finance, and eventually the shell's own
features) use the same mechanism as user plugins. They differ only in where
they come from:

| | Built-in (bundled) | User-installed |
|---|---|---|
| Source | `plugins/<id>/` in the repository | Not part of the repo |
| Loaded from | `modules/<id>/` next to the app (the build output; `resources/modules/` when packaged) | The user-data `modules/` folder above |
| Scanned | **First** | Second |

Both locations are scanned at startup. If two plugins share an `id`, **the
first one found wins, so a built-in plugin can't be replaced by a user plugin**.
The other is skipped with a warning naming where the winner came from.

### Source layout

```
plugins/budget/
├── manifest.json              entries name the BUILT paths, as for any plugin
└── src/
    ├── privileged/
    │   └── index.ts           the privileged entry (also index.js / index.mjs)
    └── renderer/
        ├── SummaryView.tsx    a view: a React component with a default export
        └── AccountsView.tsx
```

`manifest.json` is the same file a user-installed plugin has, so
`privileged.entry` and `renderer.entry` are the *built* paths (for example
`privileged/index.js` and `renderer/remoteEntry.js`), not source paths. The one
addition is `renderer.expose`, which says which source files become views:

```json
{
  "id": "budget",
  "name": "Budget",
  "version": "0.1.0",
  "privileged": { "entry": "privileged/index.js" },
  "renderer": {
    "entry": "renderer/remoteEntry.js",
    "expose": {
      "./SummaryView": "src/renderer/SummaryView.tsx",
      "./AccountsView": "src/renderer/AccountsView.tsx"
    }
  }
}
```

The keys are the `module` names your `shell.views` contributions use, and the
values are source files, relative to the plugin folder. `expose` is read only
by the build, which removes it from the built manifest.

You never write `remoteEntry.js`. The build generates it (see below).

### Building

```bash
npm run build:plugins                  # every plugin under plugins/ → modules/
npm run build:plugins -- budget        # only these plugins, by id or by folder name
npm run build:plugins -- --src <dir> --out <dir>
```

`npm run dev` builds bundled plugins before it starts, so a normal dev
session needs no extra step. **Rebuild and restart after changing a plugin's
source**; there is no watch mode yet.

For each plugin the build:

1. **Bundles** `src/privileged/index.*` into one **CommonJS** file (esbuild,
   `platform: node`) at the manifest's `privileged.entry`, **with the plugin's
   own dependencies included**. Node built-ins and `node_modules` packages
   (`packages: 'external'`, plus `lokijs`) stay external. The `@core`,
   `@shared`, `@shell`, `@plugins` and `@tessera/types` aliases resolve to the
   repository folders. Source maps are written beside the bundle.
2. **Writes `package.json`** into the built folder (currently
   `{"type":"cjs"}`; Node's valid value is `commonjs`, so this is a known
   oddity). The renderer remote is an ES module that the shell fetches over
   the plugin protocol, not through Node, so it is unaffected.
3. **Compiles the renderer**, when the manifest has `renderer.expose`: every
   listed `.tsx` / `.ts` module is built with Module Federation
   (`@module-federation/vite`), which **generates `remoteEntry.js`** and its
   chunks in the folder of `renderer.entry`. React, `react/jsx-runtime` and
   `react-dom` are shared with the shell as singletons, and **no copy of React
   is bundled**. JSX uses the automatic runtime, so no `import React` is needed.
   Each renderer is built in a Node process of its own
   (`scripts/build-renderer.mjs`), because the federation plugin keeps
   per-process state and a second remote built in the same process comes
   out incomplete.
4. **Writes the manifest** to the built folder, without `renderer.expose`.
5. **Checks** that the manifest's `renderer.entry`, if any, was produced.

The build fails, naming the plugin, when `renderer.expose` isn't a map of
`"./Name"` keys to existing files, when `renderer.entry` is missing, or when a
`renderer/` folder exists beside `renderer.expose` (the build would overwrite
it).

A build deletes the plugin's previous output first, so renamed or removed
files don't linger. One plugin failing to build is reported (the command
exits non-zero), and the others still build. `modules/` is gitignored.

Write built-in privileged code as TypeScript with named exports. The types
come from the `@tessera/types` package ([tessera-types/](../tessera-types/)),
which the core, the shell and plugins all share:

```ts
import type { PluginContext } from '@tessera/types'

export async function activate(context: PluginContext) { /* … */ }
export function deactivate() { /* optional */ }
```

### Writing a view

A view is an ordinary React component, default-exported:

```tsx
// plugins/budget/src/renderer/SummaryView.tsx
import { useEffect, useState } from 'react'

export default function SummaryView() {
  const [summary, setSummary] = useState<{ month: string, remaining: number }>()

  useEffect(() => {
    window.api.invoke<{ month: string, remaining: number }>('budget:summary').then(setSummary)
  }, [])

  return summary
    ? <p>{summary.month}: ${summary.remaining} remaining</p>
    : <p>Loading…</p>
}
```

Contribute it from `activate` with `module: './SummaryView'`, as in
[Contributing views](#contributing-views). Notes:

- **Don't bundle React.** Import `react` normally; the build maps it to the
  shell's copy. Using your own copy would break hooks.
- **`window.api` is typed** inside the repo (`TesseraBridge` in
  [tessera-types/ipc.ts](../tessera-types/ipc.ts); the global declaration is in
  [tessera-types/global.ts](../tessera-types/global.ts)). There is no separate
  plugin SDK yet; plugins in the repo import `@tessera/types` directly.
- **Types are not checked by the build.** It compiles with esbuild, which strips
  types. Run `npx tsc --noEmit` over your plugin to check them.
- **CSS and assets** imported by a view should be emitted beside the remote
  entry and served through the plugin protocol, but **this is untested**: the
  sample view has no stylesheet. Check it before relying on it.
- **Colours and fonts come from the theme.** Write
  `color: var(--shell-foregroundMuted)` rather than a literal, and the view
  follows a theme switch with no code; see
  [Contributing colours and themes](#contributing-colours-and-themes).

---

## The manifest

```json
{
  "id": "budget",
  "name": "Budget",
  "version": "0.1.0",
  "privileged": { "entry": "privileged/index.js" },
  "renderer": { "entry": "renderer/remoteEntry.js" }
}
```

| Field | Required | Rules |
|---|---|---|
| `id` | yes | Lower case, digits and single dashes, starting with a letter (`budget`, `bank-import`). It prefixes everything you register. `shell` is reserved. |
| `name` | yes | Human-readable name. |
| `version` | yes | Your plugin version. |
| `privileged.entry` | yes | Module that exports `activate`. |
| `renderer.entry` | only if you contribute views | Your Module Federation remote entry (the built path). |
| `renderer.expose` | built-in plugins that have views | Build time only: `{ "./ViewName": "src/renderer/ViewName.tsx" }`. The build removes it from the built manifest. |
| `services.provides` | if you provide services | Service ids you provide from `activate`. See [Providing and using services](#providing-and-using-services). |
| `services.requires` | if you use services | Service ids you need. You're activated after their providers, or skipped if one is missing. |

A manifest that fails validation is skipped with a warning; other plugins
still load. Two plugins with the same `id`: the first one wins.

---

## The privileged entry

The privileged entry is loaded with a native `import()` in the main process.
Both of these forms work:

```js
// CommonJS: a .js file with no package.json declaring "type": "module"
exports.activate = (context) => { /* … */ }
exports.deactivate = () => { /* optional */ }
```

```js
// ES module: index.mjs, or "type": "module" in your plugin's package.json
export function activate(context) { /* … */ }
export function deactivate() { /* optional */ }
// or: export default { activate, deactivate }
```

`activate` may be `async`; the shell waits for it to finish. If `activate`
throws or rejects, the error is logged, **the registrations the context tracks
(see [Lifecycle and cleanup](#lifecycle-and-cleanup)) are rolled back**, and
startup carries on without it.

### The `PluginContext`

`activate` receives a `PluginContext`. The interfaces are defined once, in
[tessera-types/plugins.ts](../tessera-types/plugins.ts), and are the same ones
the core implements:

```ts
interface PluginContext {
  readonly pluginId: string
  readonly ipc: IpcRouter                 // shared router
  readonly commands: {                    // scoped to your plugin
    register(id: string, handler: CommandHandler, options?: CommandOptions): Disposable
    has(id: string): boolean
    isEnabled(id: string): boolean
    execute(id: string, ...args: unknown[]): Promise<unknown>
  }
  readonly contextKeys: ContextKeyService // shared service
  readonly extensions: ExtensionRegistry  // shared registry
  readonly services: ServiceRegistry      // shared registry
  readonly events: {                      // scoped to your plugin
    emit(event: string, data?: unknown): void   // → window.api.on('<pluginId>:<event>', …) in views
  }
  readonly lifecycle: AppLifecycle        // shared
  readonly subscriptions: Disposable[]    // disposed, last first, on deactivation
  readonly paths: string                  // the application data path
  readonly logger: Logger
}
```

Most of the context is the application's own registries
([core/plugins/PluginContext.ts](../core/plugins/PluginContext.ts) builds it
from the runtime). Only `commands` and `events` are wrapped, to enforce
naming and to bind events to your plugin id. The calls you will use:

| Member | Call | Notes |
|---|---|---|
| `ipc` | `register(channel, handler): Disposable` | Full channel name, by convention `<pluginId>:<event>`. The handler receives `{ channel, data, correlationId? }`. |
| `extensions` | `contribute(contributor, point, id, impl): Disposable`<br>`getContributions(point)` | Pass your plugin id as `contributor`. `impl` is the contribution object. |
| `services` | `provide(provider, id, impl): Disposable`<br>`get<T>(id)`, `has(id)`, `providerOf(id)` | Pass your plugin id as `provider`. |
| `contextKeys` | `set(key, value)`, `get(key)`, `snapshot()`, `onDidChange`, `deleteNamespace(ns)` | `undefined` removes a key. |
| `lifecycle` | `phase`, `onStarted(listener)`, `onShuttingDown(listener): Disposable`, `onDidChangePhase(listener)` | The shell-only members (`markStarted`, `requestShutdown`, `onShutDown`, `markShutDown`) are on the same object; don't call them. |

---

## Naming rules

The framework enforces naming only where a collision would be hard to undo,
and relies on convention elsewhere:

| What you register | Rule | Example for plugin `budget` |
|---|---|---|
| Command ids | **Enforced:** `budget` or `budget.<anything>` | `budget.newCategory` |
| Events you emit | **Enforced:** any name without `:`; `emit` adds your prefix | `saved` → `budget:saved` |
| IPC channels | Convention: `<pluginId>:<event>`. Nothing stops you registering another plugin's channel, so don't | `budget:summary` |
| Contribution ids (menus, items, groups, views) | Convention: `budget` or `budget.<anything>` | `budget.menu`, `budget.summary` |
| Context keys you set | Convention: `budget` or `budget.<anything>` | `budget.hasCategories` |
| Services you provide | Any dotted id. Each id has one provider, and registering a second throws | `budget.forecast`, or a shared port like `vault.store` |

Breaking a *command* or *event* rule throws; inside `activate`, that rolls your
plugin back. You can always **refer** to ids you don't own: placing an item
under the shell's `shell.tools` menu, executing another plugin's command,
reading another plugin's context keys, or using another plugin's service.

Service ids name an interface (a port), and different plugins may implement the
same one: a SQLite plugin and an encrypted-file plugin could both offer
`vault.store`. List what you provide in the manifest's `services.provides`.
That list drives activation order, and a warning is logged if you declare a
service and never provide it. Registering the same id twice throws
`Service "<id>" is already provided by "<provider>"`.

---

## Commands

A command is a named action. Menu items refer to commands by id, so the menu
never holds a function.

```js
context.commands.register('budget.newCategory', async (...args) => {
  // runs in the main process
})

await context.commands.execute('shell.about')   // run someone else's command
```

Registering an id that's already registered throws. Executing a command
that is currently disabled rejects with `Command is disabled: <id>`.

---

## Enabling and disabling commands

Menu items don't have their own enabled flag. **An item is enabled exactly
when its command is enabled**, so every place a command appears (menu item,
keyboard accelerator, and later toolbars) always agrees. A command's
enablement is computed from **context keys**: named pieces of state that
plugins publish.

1. **Publish state** with `context.contextKeys.set(key, value)` whenever it
   changes. Values are booleans, strings or numbers; `undefined` removes the
   key. By convention you set only your own keys (`<pluginId>.*`), and the
   shell clears every key in your namespace when your plugin deactivates.
2. **Give the command an `enablement` expression** when you register it. The
   command is enabled, and its menu items clickable, only while the
   expression is true.
3. **The shell keeps menus current.** Whenever a key changes, or a command is
   registered or removed, affected menu items are enabled or disabled
   immediately, even while the app is running. A disabled command also
   refuses to run if something calls it programmatically.

### Example: a vault manager

No vault open: *Save* and *Close* are disabled. Vault open: *Close* is
enabled, and *Save* only becomes enabled after a change.

```js
exports.activate = (context) => {
  const keys = context.contextKeys

  context.commands.register('vault.open', async () => {
    // … open the vault …
    keys.set('vault.isOpen', true)
    keys.set('vault.isDirty', false)
  })

  context.commands.register('vault.save', async () => {
    // … write changes …
    keys.set('vault.isDirty', false)
  }, { enablement: 'vault.isOpen && vault.isDirty' })

  context.commands.register('vault.close', async () => {
    // … close …
    keys.set('vault.isOpen', false)
    keys.set('vault.isDirty', false)
  }, { enablement: 'vault.isOpen' })

  // The renderer reports edits; the backend owns the state
  context.ipc.register('vault:edit', async (msg) => {
    // … apply msg.data …
    keys.set('vault.isDirty', true)
  })

  const M = 'shell.menus'
  context.extensions.contribute('vault', M, 'vault.file', { kind: 'group', id: 'vault.file', parent: 'shell.file' })
  context.extensions.contribute('vault', M, 'vault.open', { kind: 'item', id: 'vault.open',  label: '&Open Vault…', parent: 'shell.file', group: 'vault.file', command: 'vault.open',  accelerator: 'CmdOrCtrl+O' })
  context.extensions.contribute('vault', M, 'vault.save', { kind: 'item', id: 'vault.save',  label: '&Save',        parent: 'shell.file', group: 'vault.file', command: 'vault.save',  accelerator: 'CmdOrCtrl+S' })
  context.extensions.contribute('vault', M, 'vault.close', { kind: 'item', id: 'vault.close', label: '&Close Vault', parent: 'shell.file', group: 'vault.file', command: 'vault.close' })
}
```

| State | Open Vault… | Save | Close Vault |
|---|---|---|---|
| Startup (no vault) | enabled | disabled | disabled |
| After *Open* | enabled | disabled | enabled |
| After an edit (`vault:edit` over IPC) | enabled | enabled | enabled |
| After *Save* | enabled | disabled | enabled |
| After *Close* | enabled | disabled | disabled |

Because other plugins can read your keys, they can follow your state
without you knowing about them. An export plugin can register
`export.vault` with `enablement: 'vault.isOpen'`, and its menu item greys
out whenever no vault is open. If you want other plugins to use your keys,
document them as part of your public API.

### Expression syntax

| Form | Meaning |
|---|---|
| `vault.isOpen` | true when the key's value is truthy (`true`, a non-empty string, a non-zero number) |
| `!vault.isReadOnly` | not |
| `a && b`, `a \|\| b` | and, or (`&&` binds tighter than `\|\|`) |
| `( … )` | grouping |
| `vault.mode == 'admin'`, `vault.count != 0`, `vault.locked == false` | compare a key with a string (single or double quotes), number or boolean literal |

A key that has never been set is `undefined`: falsy, and not equal to any
literal. An invalid expression makes `register` throw, so mistakes show up
when your plugin activates rather than silently disabling an item.

---

## Contributing menus

Extension point: **`shell.menus`**. There are three kinds of contribution
([shared/menus/types.ts](../shared/menus/types.ts)):

```ts
// A menu: on the menu bar if it has no parent, otherwise a submenu
{ kind: 'menu',  id, label, parent?, group?, order? }

// A clickable item
{ kind: 'item',  id, label, parent, command, group?, accelerator?, order? }

// A group of entries inside a menu, set apart by separators
{ kind: 'group', id, parent, order? }
```

### Where things go

**On the menu bar, the order is fixed:** `File`, then `View`, then all plugin
menus, then `Tools`, then `Help`. `order` only sorts your menu among the other
plugin menus. It can't move a menu before File or after Tools. The `View`
menu (`shell.view`) holds the window-layout commands, and plugins add their
own page-opening items to it.

**Inside a menu**, entries are placed in **groups**:

- Every group is set apart from its neighbours by separators. The shell
  merges adjacent separators into one, removes separators at either end, and
  drops submenus that end up empty, so you never manage separators yourself.
- Groups are sorted by `order` (default `0`), then by registration order.
- An entry without a `group` goes into the implicit `additions` group (order
  `0`).
- You can point an entry at a group nobody declared; the group is created
  implicitly with order `0`.
- Entries within a group are sorted by `order`, then by registration order.
- The shell's own groups (`shell.exit` in File, `shell.developer` in Tools,
  `shell.about` in Help) have order `10000`. Anything you add to those menus
  appears above them unless you choose a larger order.

**Submenus** are `menu` contributions with a `parent`, and you can nest them
as deep as you like.

### Example: a submenu in the Tools menu

```js
const M = 'shell.menus'
context.extensions.contribute('budget', M, 'budget.tools', { kind: 'group', id: 'budget.tools', parent: 'shell.tools', order: 50 })
context.extensions.contribute('budget', M, 'budget.reports', { kind: 'menu',  id: 'budget.reports', label: 'Budget &Reports', parent: 'shell.tools', group: 'budget.tools' })
context.extensions.contribute('budget', M, 'budget.reports.monthly', { kind: 'item',  id: 'budget.reports.monthly', label: '&Monthly', parent: 'budget.reports', command: 'budget.reports.monthly' })
context.extensions.contribute('budget', M, 'budget.reports.annual', { kind: 'item',  id: 'budget.reports.annual',  label: '&Annual',  parent: 'budget.reports', command: 'budget.reports.annual' })
```

Result:

```
Tools
├── Budget Reports ▸ ├── Monthly
│                    └── Annual
├── ──────────────
└── Toggle Developer Tools
```

### Details

- **Labels:** `&` marks the keyboard mnemonic (`'&Budget'` → Alt+B).
- **`accelerator`:** an Electron accelerator string, e.g. `'CmdOrCtrl+Shift+B'`.
- **Disabled items:** an item is disabled while its command is unregistered
  or its `enablement` is false, and this updates live (see
  [Enabling and disabling commands](#enabling-and-disabling-commands)).
- **When the menu is built:** the *structure* is built once, after every
  plugin has activated, so new menu contributions appear after a restart.
  The *enabled state* of existing items is always current.
- **Invalid contributions:** wrong shape, unknown parent, duplicate id or a
  parent cycle are skipped and logged as `[menus] …` warnings. The rest of
  the menu still builds.

---

## IPC between your view and your privileged code

The renderer has no Node access. When your view needs data or side effects
(files, a database, the network), it calls your privileged code over IPC.

**Privileged side:**

```js
context.ipc.register('budget:accounts.list', async (msg) => {
  // msg = { channel: 'budget:accounts.list', data, correlationId }
  return await loadAccounts(msg.data.includeClosed)
})
```

**Renderer side:**

```js
const accounts = await window.api.invoke('budget:accounts.list', { includeClosed: false })
```

- By convention the channel is `<pluginId>:<event>`, and you pass the whole name to `register`.
- `data` and the return value must be structured-cloneable: plain objects,
  arrays, primitives, `Date`, `Map` and so on. No functions or class
  instances with behaviour.
- If the handler throws, or the channel doesn't exist, `invoke` rejects with
  an `Error` whose message is `CODE: message`, where `CODE` is `NO_HANDLER`,
  `HANDLER_ERROR` or `BAD_REQUEST`. Handler errors are also logged in the main
  process.
- Handlers are looked up per request, so a handler is callable as soon as
  it's registered.

### Events from the backend to your views

IPC also flows the other way. Your privileged code can **push** a named event
to every open window, and your views listen for it:

```js
// privileged
context.events.emit('saved', { path, at: Date.now() })   // reaches views as 'vault:saved'
```

```tsx
// view
useEffect(() => {
  const stop = window.api.on<{ path: string }>('vault:saved', ({ path }) => setLastSaved(path))
  return stop                                            // on() returns the unsubscribe function
}, [])
```

- The event name is always `<pluginId>:<event>`. `emit` adds your prefix, and an
  event name containing `:` is rejected.
- `data` must be structured-cloneable (plain objects, arrays, primitives). Views
  receive only the data, never Electron's event object.
- Events are **fire and forget**, delivered in order, to every open window. A view
  that wasn't listening yet **misses** them, and nothing is replayed.
- So to show current state, **subscribe first, then request the current value**
  with `invoke`, and apply any events that arrived in between. Send **absolute
  values** in events (the new state), not "+1" deltas, so applying one twice is
  harmless. The shell's own state works exactly this way (below).
- A listener that throws is logged and the others still run.

**The shell publishes its state this way too.** Each item has a request for the
current value and an event for changes:

| State | Request (`window.api.invoke`) | Event (`window.api.on`) and payload |
|---|---|---|
| Application phase | `shell:lifecycle.get` → `'starting' \| 'started' \| 'shuttingDown' \| 'shutDown'` | `shell:lifecycle.changed` → `{ phase }` |
| Context keys | `shell:contextKeys.snapshot` → `{ [key]: value }` | `shell:contextKeys.changed` → `{ [key]: value \| null }` (`null` = removed) |
| The set of views | `shell:views.list` → views | `shell:views.changed` (no payload; the shell reloads the list itself) |
| The set of bar items | `shell:bar.items.list` → items, with `enabled` flags | `shell:bar.items.changed` (no payload) |
| This window's layout | `shell:layout.get` → `LayoutState` | `shell:layout.changed` → `LayoutState` (ignore other windows' ids), `shell:layout.revealed` → `{ windowId, viewId, slot }` |

`shuttingDown` is **informational**: the window may close right after it, and
a view can't delay or veto the quit. If the quit is vetoed, the phase returns to
`started`. Do real shutdown work in your privileged `onShuttingDown` listener.

The shell's own components use ready-made hooks (`useAppPhase()`,
`useContextKey(key)`). Plugin views can't import them, because the shell
shares only React with remotes, so views use `window.api` as above.

---

## Providing and using services

A **service** is an object with methods that one plugin provides and any
number of other plugins call, in the main process. Use one when other plugins
need to *call into* what your plugin does: read the vault, convert
currencies, fetch quotes.

| If you want to… | Use |
|---|---|
| let the shell or another plugin **show or collect** something you offer | an extension point (`shell.menus`, `shell.views`) |
| let other plugins **call into** your code | a service |
| let the user **trigger** an action | a command, usually with a menu item |

### Providing a service

Declare it in the manifest:

```json
{
  "id": "vault",
  "name": "Vault",
  "version": "0.1.0",
  "privileged": { "entry": "privileged/index.js" },
  "services": { "provides": ["vault.store"] }
}
```

and provide it from `activate`:

```js
exports.activate = (context) => {
  context.services.provide('vault', 'vault.store', {
    async getAccounts() { /* … */ },
    async getTransactions(accountId, range) { /* … */ },
    async addTransaction(accountId, tx) { /* … */ }
  })
}
```

- The service must be an object (or function). Its methods are called
  directly, in the same process, so they can take and return anything,
  including class instances and callbacks. Unlike IPC, nothing is copied.
- Declare every id you provide in `services.provides`. If you declare a
  service but never provide it, a warning is logged and the plugins that
  require it are skipped. (The context does not currently reject an
  undeclared `provide`, but activation ordering only knows about declared ids.)
- `provide` returns a `Disposable`. Push it onto `context.subscriptions` so the
  service is removed when your plugin deactivates.
- Each id has **one** provider. If two plugins declare the same id, the one
  discovered first wins and the other is skipped, unless the user's
  `tessera-bootstrap.json` lists one of them in `preferredPlugins` (it can
  also leave plugins out with `disabledPlugins`). That file is read by the
  shell before any plugin runs; it is the only place for configuration that
  decides *which plugins activate*, because `app.state` and settings are
  themselves provided by plugins.

### Using a service

Declare what you need:

```json
{
  "id": "reports",
  "name": "Reports",
  "version": "0.1.0",
  "privileged": { "entry": "privileged/index.js" },
  "services": { "requires": ["vault.store"] }
}
```

then look it up. **Required services are always available inside your
`activate`**, so `get` is synchronous:

```js
exports.activate = (context) => {
  const store = context.services.get('vault.store')

  context.ipc.register('reports:net-worth', async () => {
    const accounts = await store.getAccounts()
    return { accounts: accounts.length, total: accounts.reduce((sum, a) => sum + a.balance, 0) }
  })
}
```

What `requires` guarantees:

- **Ordering:** you're activated after the providers of everything you
  require, whatever order the plugin folders are discovered in.
- **All or nothing:** if a required service has no provider, its provider
  was skipped or failed to activate, or the dependencies form a cycle, your
  plugin is **skipped** with a `[plugins] Skipping "<id>": …` warning
  explaining why. Your `activate` never runs with a service missing.
- **Teardown order:** if a provider is deactivated, every plugin that
  requires its services is deactivated first, so you never hold a dead
  service.

`context.services.has(id)` and `get(id)` also work for services you didn't
declare, as an optional dependency. But nothing guarantees the provider
activates before you, so check `has` first and don't rely on it during
`activate`. `get` throws `Service not available: <id>` when there's no
provider.

### Designing a service

- **The id names an interface, not an implementation.** Prefer `vault.store`
  over `sqlite-vault.store` if other implementations could exist. Document
  the methods, their arguments and their return values. That interface is a
  contract other plugins build against.
- **Keep it in the main process.** Renderer code can't call services
  directly. A view asks its own privileged code over IPC, which calls the
  service.
- **Publish state through context keys too**, if menus should react to it.
  The vault plugin can provide `vault.store` *and* set `vault.isOpen`.

---

## Contributing views

Extension point: **`shell.views`** (`ViewContribution` in
[tessera-types/views.ts](../tessera-types/views.ts); slot ids in
[shared/views/types.ts](../shared/views/types.ts)):

```ts
{
  id: string        // 'budget.summary'
  title: string     // tab label, rail tooltip, loading and error messages
  slot: string      // where to render (see the slot table)
  module: string    // a module your renderer remote exposes, starting with './'
  icon?: string     // REQUIRED for bar slots: './file.svg' in your renderer folder, or a shell icon name
  order?: number    // sorts views within the slot; default 0
  when?: string     // context-key expression; the view is absent while it is false
}
```

You contribute views from the **privileged** side, as data. The component
itself lives in your renderer remote, and the shell only fetches it when the
view is first shown.

The window manager lays the window out as a main content area with a bar on
each side (see [window-manager-design.md](window-manager-design.md)):

| Slot | Where |
|---|---|
| `shell.main` | The centre. One view is shown at a time, chosen by the `shell.layout.reveal` command; the welcome text shows only when no view targets it. |
| `shell.left`, `shell.right`, `shell.top`, `shell.bottom` | The bars. Views in a bar are **tabs**; a bar is hidden entirely while nothing targets it, and the user can collapse it to a rail of view icons. |

In a bar:

- The bar appears as soon as your view is present (contributed, plugin
  active, `when` true) and disappears when nothing is left.
- Your `icon` is shown on the view's tab and on the collapsed rail, where
  clicking it expands the bar on your view. Icons are either files in your
  renderer folder (`'./icons/accounts.svg'`, monochrome SVG, painted with the
  theme colour) or a name from the shell's set
  ([shared/layout/icons.ts](../shared/layout/icons.ts)).
- A shown view stays mounted when its tab is inactive or the bar collapses,
  so its state survives; a view that has never been shown is not loaded.
- **Each view has its own error boundary.** If your module fails to load, has
  no component, or throws while rendering, only your view shows
  "*title* could not be displayed." The error goes to the renderer console
  as `[views] …`.
- A view is skipped, with a `[views]` warning in the main process, if your
  manifest has no `renderer.entry`, its `module` doesn't start with `./`,
  its `slot` is unknown, a bar view has no `icon`, its `when` doesn't parse,
  or its id is a duplicate.

To open one of your views programmatically (after opening a vault, from a
menu item, from a click in a navigation view), execute the shell's command:

```js
await context.commands.execute('shell.layout.reveal', 'budget.summary')
```

It makes the view active in its slot, expands its bar if collapsed, and
focuses it. From a view, use
`window.api.invoke('shell:commands.execute', { id: 'budget.show' })` to run a
command (usually one of your own that ends in a reveal).

Views currently receive **no props**. Use `window.api.invoke` to get data.

**A complete example** is the built-in
[`plugins/layout.sample/`](../plugins/layout.sample/): a view in every slot,
a button in each bar view that `invoke`s the plugin's privileged code, which
pushes the new state back with `context.events.emit` (every view re-renders
from it) and switches the content page with `shell.layout.reveal`. Its
[end-to-end test](../tests/plugins/layout.sample/endToEnd.test.tsx) shows the
whole loop running without Electron.

### Bar items: buttons and status text

Extension point: **`shell.bar.items`** (`BarItemContribution` in
[tessera-types/layout.ts](../tessera-types/layout.ts)). For things a bar shows
directly, with no React component and no renderer remote: a button bound to a
command, or a piece of status text driven by context keys.

```js
const B = 'shell.bar.items'
// A toolbar button: enabled exactly when its command is enabled, like a menu item
context.extensions.contribute('vault', B, 'vault.toolbar.save', {
  kind: 'button', id: 'vault.toolbar.save', slot: 'shell.top',
  label: 'Save', icon: 'save', command: 'vault.save', tooltip: 'Save the vault'
})
// Status text: {key} is replaced with that context key's value, live
context.extensions.contribute('vault', B, 'vault.status.name', {
  kind: 'text', id: 'vault.status.name', slot: 'shell.bottom',
  text: 'Vault: {vault.name}', when: 'vault.isOpen', align: 'end'
})
```

Items take `slot` (bar slots only), `align: 'start' | 'end'`, `order`, `when`,
`tooltip` and `icon`, and are validated like views (invalid ones are skipped
with a `[layout]` warning). A bar with only items is content-sized, so a
status bar is as tall as its text.

---

## Contributing colours and themes

The shell never draws a colour literal: every colour is a named **token**
(`shell.accent`, `shell.bar.background`) that the active **theme** gives a
value, and the result reaches every view as a CSS variable
(`--shell-accent`). Plugins take part at both ends. The design is in
[style-manager-design.md](style-manager-design.md); the built-in
[`plugins/theme.sample/`](../plugins/theme.sample/) does everything below.

### Using the theme in a view

Nothing to register. Write `var(--<token with dots as dashes>)` in a
stylesheet or an inline style, and the view follows every theme switch:

```tsx
<td style={{ borderColor: 'var(--shell-border)', color: 'var(--shell-foregroundMuted)' }}>…</td>
<tr style={{ background: 'var(--accounts-reconciled)' }}>…</tr>
```

Text colour, background and fonts are inherited from the document, so most
views need nothing at all. The shell's tokens are listed in
[shared/theme/tokens.ts](../shared/theme/tokens.ts) and its fonts in
[shared/theme/typography.ts](../shared/theme/typography.ts)
(`--shell-font-family`, `--shell-font-size`, `--shell-font-sizeSmall`,
`--shell-font-monoFamily`). Code that needs the value itself (a chart on a
canvas) requests the snapshot and listens for changes:

```ts
const theme = await window.api.invoke<ThemeState>('shell:theme.get')
theme.colors['accounts.positiveAmount']                       // '#107c10'
window.api.on<ThemeState>('shell:theme.changed', next => redraw(next.colors))
```

### Contributing a colour token

Extension point: **`shell.colors`** (`ColorContribution` in
[tessera-types/theme.ts](../tessera-types/theme.ts)). A token is a colour
your views use, with a default for light and for dark themes, so it looks
right in any theme its author never saw. Any theme may override it.

```js
const C = 'shell.colors'
context.subscriptions.push(
  context.extensions.contribute('accounts', C, 'accounts.positiveAmount', {
    id: 'accounts.positiveAmount', description: 'Credits in a register',
    defaults: { light: '#107c10', dark: '#89d185' }
  }),
  context.extensions.contribute('accounts', C, 'accounts.negativeAmount', {
    id: 'accounts.negativeAmount', description: 'Debits in a register',
    defaults: 'shell.error'                   // a reference: follows whatever the theme says
  })
)
```

- `id` is dotted and must start with your plugin id; `description` is
  required (a future picker shows it).
- A default is a hex colour (`#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`) or
  the id of another token, whose value is used instead. One value serves
  both kinds; an object gives one per kind.
- Your views read it as `var(--accounts-positiveAmount)`.

### Contributing a theme

Extension point: **`shell.themes`** (`ThemeContribution` in
[tessera-types/theme.ts](../tessera-types/theme.ts)). A theme is a colour
palette over the token catalogue: a label, a kind, and the tokens it sets.
Whatever it leaves out comes from the theme it `extends`, then from each
token's default for the kind, so a theme that only tints the shell is a
few lines.

```js
context.subscriptions.push(
  context.extensions.contribute('money-classic', 'shell.themes', 'money-classic.sepia', {
    id: 'money-classic.sepia', label: 'Money Classic', kind: 'light', extends: 'shell.light',
    colors: {
      'shell.background': '#fbf6ea',
      'shell.bar.background': '#efe6cf',
      'shell.accent': '#7a5c1e',
      'accounts.positiveAmount': '#3f6b1c'    // another plugin's token; fine
    }
  })
)
```

- `kind` is `light` or `dark`; `extends` must name a theme of the same
  kind (default: the shell's theme of that kind, `shell.light` or
  `shell.dark`).
- `colors` values are hex colours or token references, like defaults. A
  token the catalogue does not know is kept and applies if that token's
  plugin is activated later, in whatever order.
- One invalid value skips the whole theme with a `[theme]` warning, since
  a half-applied theme is worse than none.
- The user picks themes from View › Theme, or the chooser dialog
  (View › Theme › Choose Theme…, or the `shell.theme.choose` command); the
  choice is kept across restarts. If your plugin is deactivated while your
  theme is active, the shell falls back to its own theme of the same kind
  and returns to yours when it is back.
- Your views and bar items can run the shell's theme commands:
  `shell.theme.choose`, `shell.theme.toggleDark`, `shell.theme.useSystem`,
  and `shell.theme.select` with a theme id or `'system'`. The context keys
  `shell.theme.active`, `shell.theme.kind` and `shell.theme.system` are
  there for `when` and `enablement`.

---

## The renderer remote

Your `renderer.entry` must be a **Module Federation remote entry in ES-module
form** (federation type `module`). The shell:

1. Serves your renderer folder, the folder containing `renderer.entry`, at
   `tessera-plugin://<pluginId>/`. Only files in that folder and its
   subfolders can be fetched, so put every chunk and asset your build emits
   there.
2. Registers your plugin as a federation remote whose name is your plugin
   `id`.
3. For a view with `module: './SummaryView'`, calls
   `loadRemote('<pluginId>/SummaryView')` and renders its **default export**.

### Shared dependencies

The shell provides these as **singletons**, and your remote must use them
rather than bundle its own copies:

| Package | Provided version |
|---|---|
| `react` | the shell's React 18 (`requiredVersion: ^<shell version>`) |
| `react/jsx-runtime` | same as React |
| `react-dom` | the shell's react-dom |

Bundling your own React breaks hooks ("Invalid hook call"), because your
components would run on a different React from the one rendering them.

### Building the remote

Any Module Federation build tool works if its output meets these
requirements:

- **Remote entry format:** ESM (federation type `module`), written to the
  path in `renderer.entry`.
- **Exposes:** one key per view `module`, e.g. `'./SummaryView': './src/SummaryView.tsx'`.
  Each exposed module default-exports a React component.
- **Shared:** `react`, `react/jsx-runtime` and `react-dom` marked as
  singletons and *not* eagerly bundled.
- **Output location:** all chunks and assets alongside, or below, the
  remote entry, referenced by relative URLs.

**Built-in plugins** get this for free: `npm run build:plugins` runs
`@module-federation/vite` with exactly these settings (see
[Built-in plugins](#built-in-plugins)). The configuration has been tested
against the shell: the generated entry loads through the `tessera-plugin://`
protocol, shares the shell's React, and renders a TSX view that calls its
plugin's backend.

**User-installed plugins** have no build step provided yet, so a third-party
author must produce a remote that meets the requirements above, with
`@module-federation/vite`, `@module-federation/enhanced` (webpack) or
rspack's Module Federation. Mark `react`, `react/jsx-runtime` and
`react-dom` as shared singletons with `import: false` so no fallback copy is
bundled. The hand-written container in the [Quick start](#quick-start) is
for illustration: it shows the protocol the tools generate, where
`init(shareScope)` receives the shared modules and `get('./Expose')` returns a
factory for the exposed module.

---

## Application lifecycle

Besides your own `activate` / `deactivate`, the whole application moves
through four phases:

| Phase | Starts when | You can observe it? |
|---|---|---|
| `starting` | The app begins; plugins are activating | Your `activate` *is* your starting hook |
| `started` | **Every** plugin has activated and the window exists | `context.lifecycle.onStarted` |
| `shuttingDown` | The app is asked to quit, **before any plugin deactivates** | `context.lifecycle.onShuttingDown` |
| `shutDown` | The last plugin has deactivated | No: you're already gone. `deactivate()` is your hook |

```js
exports.activate = (context) => {
  // Runs after ALL plugins are active, so it's safe to use services you didn't
  // declare. If the app has already started, it runs immediately.
  context.lifecycle.onStarted(async () => {
    await reopenLastVault()
  })

  context.lifecycle.onShuttingDown(async (event) => {
    if (vaultIsDirty()) {
      const choice = await askToSave()           // everything is still running here
      if (choice === 'cancel') return event.veto('user cancelled')
      if (choice === 'save') await saveVault()
    }
  })
}
```

**`onShuttingDown` is where interactive or slow work belongs**: prompting to
save, flushing buffers. Rules:

- Listeners run **one at a time, in registration order**, and the shell waits
  for async ones.
- `event.veto()` **cancels a user-initiated quit**. Later listeners are skipped,
  nothing is deactivated, and the app keeps running. Calling it for
  `event.reason === 'system'` (the OS is shutting down) has no effect, because
  that can't be refused.
- There is a **time limit of 10 seconds** for all shutdown listeners together.
  After that the shutdown carries on without them, so don't wait on the user
  indefinitely. A veto that arrives after the limit is ignored.
- A listener that throws is logged, and the others still run.
- After the listeners, plugins deactivate (dependents before the plugins they
  depend on), and the shell does its final flushes.
- **Don't release anything in `onShuttingDown`.** A later listener may veto,
  and then the app carries on with whatever you closed. Flush and ask here;
  close files, stop timers and drop handles in `deactivate()`. This matters
  most if you **provide a service**: listeners run in registration order,
  and you registered before the plugins that require you, so a provider that
  closed in `onShuttingDown` would pull the service from under its dependents
  while they are still flushing. `deactivate()` runs only after every
  dependent has deactivated.

`onShuttingDown` returns a `Disposable`. Push it onto `context.subscriptions`
if the listener should be removed when your plugin deactivates.

> Quitting is not guaranteed to run any of this: a crash, a force-quit or a
> forced OS shutdown skips it. Save important data as it changes, and use
> `onShuttingDown` for tidying up and for asking the user.

---

## Lifecycle and cleanup

1. **Discover:** read `manifest.json` from each plugin folder.
2. **Validate** the manifest; skip the plugin on failure.
3. **Order:** sort plugins so service providers come before the plugins that
   require them, otherwise keeping discovery order. Skip plugins whose
   services conflict, are missing, or form a cycle.
4. For each plugin in that order, **load** `privileged.entry` and **call
   `activate(context)`**. A plugin whose required service is unavailable,
   because its provider failed, is skipped at this point.
5. After all plugins have activated, the shell builds the menu bar, opens the
   window, and then fires `onStarted` (see
   [Application lifecycle](#application-lifecycle)).
6. The renderer fetches the view list and lazy-loads views as slots render.

The context **tracks** what you register through `context.commands.register`,
and everything you push onto `context.subscriptions`. The IPC router, the
extension registry, the service registry and the lifecycle are shared, so their
registrations are **not** tracked automatically. Each call returns a
`Disposable`, and you push it yourself:

```js
context.subscriptions.push(
  context.ipc.register('vault:edit', handler),
  context.extensions.contribute('vault', 'shell.menus', 'vault.menu', { kind: 'menu', id: 'vault.menu', label: '&Vault' }),
  context.services.provide('vault', 'vault.store', store),
  context.lifecycle.onShuttingDown(flush)
)
```

When your plugin is deactivated (or `activate` throws):

1. Every active plugin that **requires a service you provide** is
   deactivated first.
2. The shell calls your `deactivate()`, if any.
3. Everything tracked is disposed, in reverse order, and every context key in
   your namespace is cleared. Menu items bound to your commands become
   disabled, and any service you pushed disappears.

Registrations you did not push stay in place until the app exits.

For resources you create yourself (timers, watchers, connections), push a
disposable so they're released too:

```js
const timer = setInterval(syncPrices, 60_000)
context.subscriptions.push({ dispose: () => clearInterval(timer) })
```

> On a normal quit the shell runs every `onShuttingDown` listener, then
> deactivates your plugin, so `deactivate` is reliable for releasing
> resources. It is **not** guaranteed after a crash or force-quit, so don't
> rely on it to save data; save as you go.

---

## Troubleshooting

All diagnostics go to the **main process console** (the terminal running
`npm run dev`), except renderer view errors, which go to the window's
DevTools console (Tools › Toggle Developer Tools).

| Symptom | Look for | Usual cause |
|---|---|---|
| Plugin does nothing | `[plugins] Skipping …` | Invalid manifest (id format, missing field), invalid JSON, or a duplicate id |
| App won't quit | `[lifecycle] Shutdown cancelled: …` | An `onShuttingDown` listener called `event.veto()` |
| Quit is slow, then proceeds | `[lifecycle] Shutdown listeners exceeded … ms` | An `onShuttingDown` listener took longer than the 10 s limit |
| `onStarted` listener never runs | none | It was registered after the app had shut down, or `activate` threw before reaching it |
| Plugin does nothing | `[plugins] Failed to activate "<id>"` | `activate` threw, e.g. you registered an id without your prefix |
| Plugin does nothing | `Privileged entry does not export an activate function` | Wrong export, or ESM syntax in a `.js` file treated as CommonJS |
| Plugin does nothing | `Skipping "<id>": requires service "…", which no plugin provides` | The provider isn't installed, or the id in `services.requires` has a typo |
| Plugin does nothing | `Skipping "<id>": requires service "…", but its provider "…" was skipped` / `required service "…" is not available` | The provider was skipped or failed to activate; look for its own message just before |
| Plugin does nothing | `Skipping "<id>": service "…" is also provided by "…"` | Two plugins declare the same service id; only the first is used |
| Plugin does nothing | `Skipping "<id>": has a circular service dependency` | Plugins require each other's services, directly or indirectly |
| `Service "…" is already provided by "…"` | `[plugins] Failed to activate` | Two plugins provide the same id, or a plugin provided it twice |
| `declares service "…" but did not provide it` | `[plugins]` warning | `activate` never called `context.services.provide` for a declared id, or passed the arguments in the wrong order (it is `provide(provider, id, impl)`) |
| `cannot register command "…": ids must start with "<id>."` | `[plugins] Failed to activate` | A command id doesn't start with your plugin id. An IPC-style handler (`'app.state:get'`) belongs on `context.ipc.register`, not `commands.register` |
| `Service not available: <id>` | the thrown error | `get` for a service that has no provider; add it to `services.requires`, or check `has` first |
| Menu missing or misplaced | `[menus] …` | Unknown parent, wrong `kind`, duplicate id; or the menu has no items, so it was dropped |
| Menu item greyed out | none | Its command isn't registered or has a typo; or its `enablement` is false. Check the keys with `context.contextKeys.get` |
| Menu item never greys out | none | The command has no `enablement`, or you never set the keys it reads |
| `Command is disabled: <id>` | the rejected `execute` | Something called the command while its `enablement` was false |
| `Invalid expression "…"` | `[plugins] Failed to activate` | Syntax error in an `enablement` string |
| View missing | `[views] …` in the main console | No `renderer.entry`; `module` doesn't start with `./` |
| "*title* could not be displayed." | `[views] View "<id>" failed` in DevTools | Remote entry not found, module not exposed, no default export, or a render error |
| "Invalid hook call" | DevTools | Your remote bundles its own React; mark React as shared |
| `invoke` rejects with `NO_HANDLER` | none | Channel typo, or the handler isn't registered; channels are `<pluginId>:<event>` |
| Colour token or theme missing | `[theme] … ignored: "<id>" may only contribute …` | The token or theme id doesn't start with your plugin id |
| Colour token or theme missing | `[theme] … has an invalid default/colour "…"` | Not a hex colour or a token id (`red`, `rgb(…)` are rejected) |
| Theme missing | `[theme] Theme "…" cannot extend "…"` / `is part of an extends cycle` | `extends` names a theme of the other kind, or the chain loops |
| A token has no CSS variable | `[theme] Colour token "…" references unknown token "…"` / `reference cycle` | A default or theme value references a token that doesn't exist, or references loop |
| Your theme stopped applying | `[theme] Theme "…" is not available; using "shell.…"` | Your plugin was deactivated; the shell fell back and will return to your theme when it's back |

---

## Reference

| Concept | Value | Defined in |
|---|---|---|
| Menus extension point | `shell.menus` | [shared/menus/types.ts](../shared/menus/types.ts) |
| Reserved top-level menus | `shell.file`, `shell.view`, `shell.tools`, `shell.help` | [shared/menus/types.ts](../shared/menus/types.ts) |
| Default menu group | `additions` | [shared/menus/types.ts](../shared/menus/types.ts) |
| Views extension point | `shell.views` | [shared/views/types.ts](../shared/views/types.ts) |
| View contribution and descriptor | `ViewContribution`, `ViewDescriptor` | [tessera-types/views.ts](../tessera-types/views.ts) |
| Slots | `shell.main`, `shell.top`, `shell.bottom`, `shell.left`, `shell.right` | [shared/views/types.ts](../shared/views/types.ts) |
| Bar items extension point | `shell.bar.items` | [shared/layout/types.ts](../shared/layout/types.ts) |
| Bar item contribution and descriptor | `BarItemContribution`, `BarItemDescriptor` | [tessera-types/layout.ts](../tessera-types/layout.ts) |
| Layout state and IPC payloads | `LayoutState`, `LayoutSlotSetRequest`, `LayoutRevealedEvent`, `CommandsExecuteRequest` | [tessera-types/layout.ts](../tessera-types/layout.ts) |
| Layout channels and defaults | `shell:layout.*`, `shell:bar.items.*`, `shell:commands.execute` | [shared/layout/types.ts](../shared/layout/types.ts) |
| Layout commands | `shell.layout.toggle.<side>`, `.collapseAll`, `.expandAll`, `.reset`, `.reveal` | [shell/main/layout/registerLayout.ts](../shell/main/layout/registerLayout.ts) |
| Layout context keys | `shell.layout.<side>.hasContent` / `.collapsed` / `.visible` / `.activeView`, `shell.layout.main.activeView` | [shell/main/layout/registerLayout.ts](../shell/main/layout/registerLayout.ts) |
| Shell icon set | names | [shared/layout/icons.ts](../shared/layout/icons.ts) |
| Colour tokens extension point | `shell.colors` | [shared/theme/types.ts](../shared/theme/types.ts) |
| Themes extension point | `shell.themes` | [shared/theme/types.ts](../shared/theme/types.ts) |
| Token and theme contributions, theme state | `ColorContribution`, `ThemeContribution`, `ThemeState` | [tessera-types/theme.ts](../tessera-types/theme.ts) |
| Shell colour tokens and fonts | `shell.*` tokens → `--shell-*` variables | [shared/theme/tokens.ts](../shared/theme/tokens.ts), [shared/theme/typography.ts](../shared/theme/typography.ts) |
| Theme channels | `shell:theme.get`, `shell:theme.set`, `shell:theme.changed` | [shared/theme/types.ts](../shared/theme/types.ts) |
| Theme commands and context keys | `shell.theme.choose` / `.toggleDark` / `.useSystem` / `.select`; `shell.theme.active` / `.kind` / `.system` | [shell/main/theme/registerTheme.ts](../shell/main/theme/registerTheme.ts) |
| Built-in themes | `shell.light`, `shell.dark` | [shared/theme/themes.ts](../shared/theme/themes.ts) |
| Manifest schema and validation | `parseManifest` | [shared/plugins/manifest.ts](../shared/plugins/manifest.ts) |
| Plugin context (interface) | `PluginContext` | [tessera-types/plugins.ts](../tessera-types/plugins.ts) |
| Plugin context (implementation) | `createPluginContext` | [core/plugins/PluginContext.ts](../core/plugins/PluginContext.ts) |
| Service registry | `ServiceRegistry` (interface), `ServiceRegistryImpl` | [tessera-types/service.ts](../tessera-types/service.ts), [core/services/ServiceRegistry.ts](../core/services/ServiceRegistry.ts) |
| Activation ordering | `planActivation` | [core/plugins/activationPlan.ts](../core/plugins/activationPlan.ts) |
| Service id format | `SERVICE_ID_PATTERN`: dotted, e.g. `vault.store` | [shared/plugins/manifest.ts](../shared/plugins/manifest.ts) |
| Command enablement | `enablement` option | [core/commands/CommandRegistry.ts](../core/commands/CommandRegistry.ts) |
| Enablement expression syntax | `parseWhen` / `evaluateWhen` | [shared/context/when.ts](../shared/context/when.ts) |
| Renderer bridge | `window.api.invoke` (`TesseraBridge`) | [tessera-types/ipc.ts](../tessera-types/ipc.ts), [shell/preload/preload.ts](../shell/preload/preload.ts) |
| IPC envelope and guards | `isIpcRequest`, `isIpcEvent` | [shared/ipc.ts](../shared/ipc.ts) |
| Plugin file protocol | `tessera-plugin://<id>/…` | [shell/main/plugins/pluginProtocol.ts](../shell/main/plugins/pluginProtocol.ts) |
| Shared federation modules | `react`, `react/jsx-runtime`, `react-dom` | [shell/renderer/views/federationViewLoader.ts](../shell/renderer/views/federationViewLoader.ts) |
