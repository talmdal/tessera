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
- [Asking the user: dialogs, prompts and files](#asking-the-user-dialogs-prompts-and-files)
- [Settings](#settings)
- [Remembering application state](#remembering-application-state)
- [Storing data in the ledger](#storing-data-in-the-ledger)
- [Using accounts from another plugin](#using-accounts-from-another-plugin)
- [Styling and theming](#styling-and-theming)
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
  provides and others use, such as the `ledger.session` through which plugins
  read and write the open ledger.

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
npm run build:plugins -- budget        # only these plugin ids
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
  readonly settings: {                    // scoped to your plugin; see Settings
    register<T>(definition: SettingsDefinition<T>): SettingsHandle<T>
    read<T>(id: string): SettingsReader<T>   // any plugin's, read-only
  }
  readonly state: PluginState             // your own keys in app.state; requires "app.state"
  readonly subscriptions: Disposable[]    // disposed, last first, on deactivation
  readonly paths: string                  // the application data path
  readonly logger: Logger
}
```

Most of the context is the application's own registries
([core/plugins/PluginContext.ts](../core/plugins/PluginContext.ts) builds it
from the runtime). Only `commands` and `events` are wrapped, to enforce
naming and to bind events to your plugin id, and `settings`, which only registers namespaces you own. The calls
you will use:

| Member | Call | Notes |
|---|---|---|
| `ipc` | `register(channel, handler): Disposable` | Full channel name, by convention `<pluginId>:<event>`. The handler receives `{ channel, data, correlationId? }`. |
| `extensions` | `contribute(contributor, point, id, impl): Disposable`<br>`getContributions(point)` | Pass your plugin id as `contributor`. `impl` is the contribution object. |
| `services` | `provide(provider, id, impl): Disposable`<br>`get<T>(id)`, `has(id)`, `providerOf(id)` | Pass your plugin id as `provider`. |
| `contextKeys` | `set(key, value)`, `get(key)`, `snapshot()`, `onDidChange`, `deleteNamespace(ns)` | `undefined` removes a key. |
| `lifecycle` | `phase`, `onStarted(listener)`, `onShuttingDown(listener): Disposable`, `onDidChangePhase(listener)` | The shell-only members (`markStarted`, `requestShutdown`, `onShutDown`, `markShutDown`) are on the same object; don't call them. |
| `settings` | `register(definition): SettingsHandle`<br>`read(id): SettingsReader` | Tracked: unregistered, and readers' listeners removed, on deactivation. See [Settings](#settings). |
| `state` | `get(key, default?)`, `set(key, value)`, `update(key, patch)`, `remove(key)` | Your own keys in `app.state`; needs `app.state` in `services.requires`. See [Remembering application state](#remembering-application-state). |

---

## Naming rules

The framework enforces naming only where a collision would be hard to undo,
and relies on convention elsewhere:

| What you register | Rule | Example for plugin `budget` |
|---|---|---|
| Command ids | **Enforced:** `budget` or `budget.<anything>` | `budget.newCategory` |
| Events you emit | **Enforced:** any name without `:`; `emit` adds your prefix | `saved` → `budget:saved` |
| Settings namespaces | **Enforced:** `budget` or `budget.<name>`, lower-case dotted words | `budget`, `budget.reports` |
| Settings pages | **Enforced** (a page is skipped otherwise): `budget.<anything>`, editing only your own namespaces | `budget.settings` |
| IPC channels | Convention: `<pluginId>:<event>`. Nothing stops you registering another plugin's channel, so don't | `budget:summary` |
| Contribution ids (menus, items, groups, views) | Convention: `budget` or `budget.<anything>` | `budget.menu`, `budget.summary` |
| Context keys you set | Convention: `budget` or `budget.<anything>` | `budget.hasCategories` |
| Services you provide | Any dotted id. Each id has one provider, and registering a second throws | `budget.forecast`, or a shared port like `storage.engine` |

Breaking a *command*, *event* or *settings namespace* rule throws; inside `activate`, that rolls your
plugin back. You can always **refer** to ids you don't own: placing an item
under the shell's `shell.tools` menu, executing another plugin's command,
reading another plugin's context keys, or using another plugin's service.

Service ids name an interface (a port), and different plugins may implement the
same one: the SQLite and LokiJS plugins both offer `storage.engine`. List what
you provide in the manifest's `services.provides`.
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

### Example: a notes editor

A hypothetical `notes` plugin that edits one notebook file at a time. No
notebook open: *Save* and *Close* are disabled. Notebook open: *Close* is
enabled, and *Save* only becomes enabled after a change. (The bundled
`ledger` plugin works the same way with `ledger.isOpen`; it saves as you go,
so it has no *Save*.)

```js
exports.activate = (context) => {
  const keys = context.contextKeys

  context.commands.register('notes.open', async () => {
    // … open the notebook …
    keys.set('notes.isOpen', true)
    keys.set('notes.isDirty', false)
  })

  context.commands.register('notes.save', async () => {
    // … write changes …
    keys.set('notes.isDirty', false)
  }, { enablement: 'notes.isOpen && notes.isDirty' })

  context.commands.register('notes.close', async () => {
    // … close …
    keys.set('notes.isOpen', false)
    keys.set('notes.isDirty', false)
  }, { enablement: 'notes.isOpen' })

  // The renderer reports edits; the backend owns the state
  context.ipc.register('notes:edit', async (msg) => {
    // … apply msg.data …
    keys.set('notes.isDirty', true)
  })

  const M = 'shell.menus'
  context.extensions.contribute('notes', M, 'notes.file', { kind: 'group', id: 'notes.file', parent: 'shell.file' })
  context.extensions.contribute('notes', M, 'notes.open', { kind: 'item', id: 'notes.open',  label: '&Open Notebook…', parent: 'shell.file', group: 'notes.file', command: 'notes.open' })
  context.extensions.contribute('notes', M, 'notes.save', { kind: 'item', id: 'notes.save',  label: '&Save',           parent: 'shell.file', group: 'notes.file', command: 'notes.save',  accelerator: 'CmdOrCtrl+S' })
  context.extensions.contribute('notes', M, 'notes.close', { kind: 'item', id: 'notes.close', label: '&Close Notebook', parent: 'shell.file', group: 'notes.file', command: 'notes.close' })
}
```

| State | Open Notebook… | Save | Close Notebook |
|---|---|---|---|
| Startup (no notebook) | enabled | disabled | disabled |
| After *Open* | enabled | disabled | enabled |
| After an edit (`notes:edit` over IPC) | enabled | enabled | enabled |
| After *Save* | enabled | disabled | enabled |
| After *Close* | enabled | disabled | disabled |

Because other plugins can read your keys, they can follow your state
without you knowing about them. An export plugin can register
`export.notes` with `enablement: 'notes.isOpen'`, and its menu item greys
out whenever no notebook is open. If you want other plugins to use your keys,
document them as part of your public API, as the ledger does with
`ledger.isOpen`, `ledger.isReadOnly` and `ledger.name`.

### Expression syntax

| Form | Meaning |
|---|---|
| `ledger.isOpen` | true when the key's value is truthy (`true`, a non-empty string, a non-zero number) |
| `!ledger.isReadOnly` | not |
| `a && b`, `a \|\| b` | and, or (`&&` binds tighter than `\|\|`) |
| `( … )` | grouping |
| `notes.mode == 'admin'`, `notes.count != 0`, `notes.locked == false` | compare a key with a string (single or double quotes), number or boolean literal |

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

**On the menu bar, the order is fixed:** `File`, then all plugin menus, then
`Tools`, then `Help`. `order` only sorts your menu among the other plugin
menus. It can't move a menu before File or after Tools.

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
context.events.emit('saved', { path, at: Date.now() })   // reaches views as 'notes:saved'
```

```tsx
// view
useEffect(() => {
  const stop = window.api.on<{ path: string }>('notes:saved', ({ path }) => setLastSaved(path))
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
need to *call into* what your plugin does: read the open ledger, convert
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
  "id": "budget",
  "name": "Budget",
  "version": "0.1.0",
  "privileged": { "entry": "privileged/index.js" },
  "services": { "provides": ["budget.store"] }
}
```

and provide it from `activate`:

```js
exports.activate = (context) => {
  context.services.provide('budget', 'budget.store', {
    async getCategories() { /* … */ },
    async getSpending(categoryId, range) { /* … */ },
    async setTarget(categoryId, amount) { /* … */ }
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
  discovered first wins and the other is skipped.

### Using a service

Declare what you need:

```json
{
  "id": "reports",
  "name": "Reports",
  "version": "0.1.0",
  "privileged": { "entry": "privileged/index.js" },
  "services": { "requires": ["budget.store"] }
}
```

then look it up. **Required services are always available inside your
`activate`**, so `get` is synchronous:

```js
exports.activate = (context) => {
  const store = context.services.get('budget.store')

  context.ipc.register('reports:budget-summary', async () => {
    const categories = await store.getCategories()
    return { categories: categories.length, targets: categories.reduce((sum, c) => sum + c.target, 0) }
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

- **The id names an interface, not an implementation.** Prefer `storage.engine`
  over `sqlite.engine` if other implementations could exist. Document
  the methods, their arguments and their return values. That interface is a
  contract other plugins build against.
- **Keep it in the main process.** Renderer code can't call services
  directly. A view asks its own privileged code over IPC, which calls the
  service.
- **Publish state through context keys too**, if menus should react to it.
  The ledger plugin provides `ledger.session` *and* sets `ledger.isOpen`.
- **Publish the contract as a package** when other plugins program against
  it. Plugins can't import each other, so the ledger's types and constants are
  in `@tessera/ledger-api` ([packages/ledger-api/](../packages/ledger-api/)),
  which each plugin that uses them bundles.

---

## Contributing views

Extension point: **`shell.views`** ([shared/views/types.ts](../shared/views/types.ts)):

```ts
{
  id: string        // 'budget.summary'
  title: string     // shown while loading and in error messages; the section's accessible name
  slot: string      // where to render, currently 'shell.main'
  module: string    // a module your renderer remote exposes, starting with './'
  order?: number    // sorts views within the slot; default 0
}
```

You contribute views from the **privileged** side, as data. The component
itself lives in your renderer remote, and the shell only fetches it when a
slot that shows the view is rendered.

| Slot | Where |
|---|---|
| `shell.main` | The window's main content area. The welcome text shows only when no view targets it. |

In a slot:

- Views render in order, each in its own `<section>` with a "Loading …"
  placeholder.
- **Each view has its own error boundary.** If your module fails to load, has
  no component, or throws while rendering, only your view shows
  "*title* could not be displayed." The error goes to the renderer console
  as `[views] …`.
- A view is skipped, with a `[views]` warning in the main process, if your
  manifest has no `renderer.entry`, its `module` doesn't start with `./`, or
  its id is a duplicate.

Views currently receive **no props**. Use `window.api.invoke` to get data.

## Asking the user: dialogs, prompts and files

Ask the user through the shell, never through Electron directly, so every plugin's questions look and behave the
same, stay modal to the right window, and can be tested with fakes. The shell provides two services **before any
plugin activates**, so you can list them in `services.requires`. Their types are in `@tessera/types`.

| Service | Methods | Shown as |
|---|---|---|
| `shell.prompts` (`ShellPrompts`) | `confirm`, `message`, `prompt`, `show` | native message boxes; the shell's dialog frame for `prompt` and `show` |
| `shell.files` (`ShellFiles`) | `showOpenDialog`, `showOpenFilesDialog`, `showSaveDialog`, `exists`, `trash`, `documentsPath`, `downloadsPath` | native file dialogs; the OS trash |

```json
"services": { "requires": ["shell.prompts", "shell.files"] }
```

```ts
import { SHELL_FILES_SERVICE, SHELL_PROMPTS_SERVICE, type ShellFiles, type ShellPrompts } from '@tessera/types'

const prompts = context.services.get<ShellPrompts>(SHELL_PROMPTS_SERVICE)
const files = context.services.get<ShellFiles>(SHELL_FILES_SERVICE)

// A yes/no question. `destructive` makes Cancel the default button, so Enter doesn't delete anything.
if (await prompts.confirm({
  message: 'Move “Home Finances” to the Recycle Bin?',
  detail: 'You can restore it from there.',
  confirmLabel: 'Delete',
  destructive: true
})) {
  await files.trash(path)                       // the OS trash, never a permanent delete
}

await prompts.message({ kind: 'error', message: 'Could not open the ledger', detail: String(err) })

const name = await prompts.prompt({ message: 'Name of the new sub-ledger', label: 'Name', maxLength: 60 })
if (name === undefined) return                  // cancelled; answers are trimmed, and required unless required: false

const file = await files.showSaveDialog({
  defaultPath: path.join(files.documentsPath(), 'My Finances.tessera'),
  filters: [{ name: 'Tessera ledger', extensions: ['tessera'] }]
})                                              // undefined when cancelled; the platform asks before replacing

const chosen = await files.showOpenFilesDialog({ // several files at once: a list, empty when cancelled
  defaultPath: files.downloadsPath(),           // where browsers save downloaded statements
  filters: [{ name: 'OFX statement', extensions: ['ofx', 'qfx'] }]
})
for (const statement of chosen) { /* … */ }
```

Every method takes an optional `windowId`; by default the question belongs to the focused window.

### Contributing a dialog

For anything a message box can't ask (a form), contribute a **dialog** to `shell.dialogs` and open it with
`prompts.show`. The shell draws the dialog: modal, with its title, its width, Escape and clicking outside to
cancel. Your component, exposed by your renderer remote like a view, draws the body and the buttons.

```ts
// privileged: plain data, like a view. The id must start with your plugin id.
context.extensions.contribute('budget', 'shell.dialogs', 'budget.dialog.category', {
  id: 'budget.dialog.category', title: 'New Category', module: './CategoryDialog', size: 'sm'   // xs | sm | md | lg
})

// …later, in a command. Resolves with what the dialog closed with, or undefined if it was cancelled.
const created = await prompts.show<{ id: string }>('budget.dialog.category', { parentId }, { title: 'New Subcategory' })
if (created) await select(created.id)
```

```tsx
// src/renderer/CategoryDialog.tsx, listed in renderer.expose as "./CategoryDialog"
import { useState } from 'react'
import type { DialogProps } from '@tessera/types'
import { Button, DialogActions, DialogContent, TextField } from '@tessera/ui'

export default function CategoryDialog({ input, close, setBusy }: DialogProps<{ parentId?: string }, { id: string }>) {
  const [name, setName] = useState('')
  const [error, setError] = useState<string>()

  const save = async () => {
    setBusy(true)                               // Escape and clicking outside are ignored while busy
    const reply = await window.api.invoke<{ ok: boolean, value?: { id: string }, error?: { message: string } }>(
      'budget:category.create', { name, parentId: input.parentId })
    setBusy(false)
    if (reply.ok) close(reply.value)            // resolves the caller's show() with { id }
    else setError(reply.error?.message)         // stay open and show what went wrong
  }

  return (
    <>
      <DialogContent>
        <TextField autoFocus label="Name" value={name} onChange={e => setName(e.target.value)}
          error={error !== undefined} helperText={error} />
      </DialogContent>
      <DialogActions>
        <Button onClick={() => close()}>Cancel</Button>
        <Button variant="contained" onClick={save} disabled={name.trim() === ''}>Create</Button>
      </DialogActions>
    </>
  )
}
```

- **Do the work in the dialog when it can fail** (a duplicate name), so it can show the error and stay open;
  close with the result once it has succeeded. Close without an argument to cancel.
- **`input` and the result cross IPC**, so both must be structured-cloneable.
- **Any plugin can open your dialog** by id, which is why the id must start with your plugin id; one that
  doesn't is skipped with a `[dialogs]` warning, as are a missing title, a `module` without `./`, and an
  unknown size.
- **Dialogs queue**: a window shows one at a time, in the order they were asked for. A dialog asked for before
  the window has finished loading waits for it; if the page reloads, it is shown again; if the window closes,
  `show` resolves undefined.
- **If your module fails to load or throws**, the shell shows "This dialog could not be displayed." in the frame,
  and `show` resolves undefined once the user closes it. The error is in the DevTools console.
- `show` rejects only for an id nobody contributed, or when there is no window at all.

## Settings

Settings are the user's preferences for your plugin: "reopen the last ledger at start-up", "list 10 recent
ledgers". You say what they are and what they default to; the shell keeps them, shows them in the **Options
dialog** (Tools ▸ Options…, `Ctrl+,`) with every other plugin's, and tells you when they change. (Application
state the user never sees, such as a recent-files list, belongs in `context.state` instead:
[Remembering application state](#remembering-application-state).) The design is in
[settings-design.md](settings-design.md).

**1. Register your settings** in `activate`, with their defaults. The types are in `@tessera/types`.

```ts
import type { SettingsDefinition } from '@tessera/types'

type BudgetSettings = { warnAt: number, rollOver: boolean, period: 'month' | 'year' }

const settings = context.settings.register<BudgetSettings>({
  defaults: { warnAt: 90, rollOver: true, period: 'month' },
  // The authority: run on every change and on what is loaded. Return messages for the user.
  validate: v => v.warnAt >= 50 && v.warnAt <= 100 ? [] : ['Warn at 50% to 100% of a budget.']
})

settings.get().warnAt                          // what the user chose, merged over the defaults; never partial
context.subscriptions.push(
  // After every OK or Apply (and update or reset) that changed something. `changed` names the settings that
  // changed: top-level keys, or dotted paths for keys in nested objects.
  settings.onDidChange(({ value, changed }) => { if (changed.includes('period')) recalculate(value.period) })
)
```

- `get()` is right from the first line of `activate`: the shell reads what was saved before any plugin starts.
  The value is frozen; don't change it, call `update`.
- The namespace is your plugin id. For settings that are edited and applied separately, register more, each
  with an `id` of `<pluginId>.<name>` (lower-case words). Registering an id you don't own, or twice, throws.
- Values are JSON, and the top level is an object. The defaults give the shape: a value whose `warnAt` isn't a
  number is refused, whatever `validate` says.
- `validate` must accept the defaults (`register` throws otherwise), and should hold every rule that matters.
  A saved value that fails it is ignored for the session, with a warning, and the defaults are used.
- Only what differs from the defaults is saved (in `<userData>/settings/budget.json`), so if you change a default
  in a later version, users who never changed that setting get the new one.

**2. Contribute a page** to the `shell.settings.pages` extension point. For most settings, list **fields** and
the shell draws the form:

```ts
import { SETTINGS_PAGES_EXTENSION_POINT } from '@tessera/types'

context.subscriptions.push(context.extensions.contribute('budget', SETTINGS_PAGES_EXTENSION_POINT, 'budget.settings', {
  id: 'budget.settings',                       // must start with your plugin id
  title: 'Budgets',
  description: 'When to warn, and what happens at the end of a period.',
  keywords: ['alert', 'overspend'],            // the search box also finds titles, descriptions and field labels
  fields: [
    { kind: 'number', key: 'warnAt', label: 'Warn when spending reaches', min: 50, max: 100, integer: true, unit: '%' },
    { kind: 'boolean', key: 'rollOver', label: 'Carry what is left into the next period' },
    { kind: 'choice', key: 'period', label: 'Budget period', options: [{ value: 'month', label: 'Monthly' }, { value: 'year', label: 'Yearly' }] }
  ]
}))
```

| Field `kind` | Extra properties | The default at `key` must be |
|---|---|---|
| `boolean` (a checkbox) | | `true` or `false` |
| `number` | `min`, `max`, `integer`, `unit` | a number |
| `text` | `placeholder`, `maxLength`, `required` | a string |
| `choice` (radio buttons) | `options: { value, label, description? }[]`, string or number values; `description` is shown under the option | one of the values |

Every field has a `key` (a top-level key, or a dotted path such as `alerts.warnAt`), a `label`, and an optional
`description` shown under it. The dialog checks the field's rules as the user types, and the main process checks
them again when saving. A page can also take a `parent` (another page's id, to nest it), `settings` (which of your
namespaces it edits; default your plugin id) and `order`. A page with neither fields nor a module is a category
that lists the pages under it.

**3. Or write the page yourself**, for settings a form can't express (a category editor, a "Test connection"
button). Expose a component from your renderer remote and name it with `module` instead of `fields`:

```ts
context.extensions.contribute('budget', SETTINGS_PAGES_EXTENSION_POINT, 'budget.categories', {
  id: 'budget.categories', title: 'Categories', parent: 'budget.settings', module: './CategorySettingsPage'
})
```

```tsx
// src/renderer/CategorySettingsPage.tsx, listed in renderer.expose as "./CategorySettingsPage"
import type { SettingsPageProps } from '@tessera/types'
import { FormControlLabel, Checkbox } from '@tessera/ui'

export default function CategorySettingsPage({ value, onChange, disabled }: SettingsPageProps<BudgetSettings>) {
  return (
    <FormControlLabel label="Carry what is left into the next period" disabled={disabled}
      control={<Checkbox checked={value.rollOver} onChange={e => onChange({ ...value, rollOver: e.target.checked })} />} />
  )
}
```

- The page edits a **draft**. `onChange(next)` replaces it with a new object; nothing is saved until the user
  presses OK or Apply, and Cancel throws it away. Never call the settings IPC yourself.
- Call `onValidityChange(false)` while the page holds something that can't be saved (a half-typed value); OK and
  Apply are disabled until you call it with `true`. Your `validate` still decides.
- `disabled` is true while the dialog applies, or when the settings can't be changed; `errors` holds what the
  main process refused the last time. The dialog also shows them above your page.
- Your page stays mounted once shown, so its own state survives the user visiting other pages. If it throws, only
  your page shows "This page could not be displayed."

**4. Change your own settings from code**, when the user answers something outside the dialog ("Don't ask
again"). Only the owner can: the handle `register` returned is the only way to write, and it goes through the
same settings manager and checks as the dialog, and sends the same change event:

```ts
try {
  await settings.update({ rollOver: false })   // top-level keys; the same checks as the dialog
} catch (err) {
  context.logger.warn(`[budget] ${(err as Error & { problems?: string[] }).problems?.join(' ')}`)
}
await settings.reset()                          // every default back
```

**5. Open your page** from a button or a command: `shell.settings.open` takes a page id.

```ts
await context.commands.execute('shell.settings.open', 'budget.settings')                             // privileged
window.api.invoke('shell:commands.execute', { id: 'shell.settings.open', args: ['budget.settings'] }) // a view
```

Things to know:

- **Upgrading the shape.** Give the definition a `version` (a whole number from 1), raise it when a stored value
  needs converting, and add `migrate(stored, fromVersion)`. It receives the saved overrides (not the merged
  value) and returns what to merge over the defaults. Adding a key needs no migration: its default fills in.
- **Downgrades.** Settings saved by a newer version of your plugin are used but can't be changed (the dialog says
  so, and `update` rejects), so the newer version's data isn't lost.
- **Reading another plugin's settings:** `context.settings.read(id)` gives any namespace to read, with no way to
  change it. `get()` is undefined until the owner has registered it, so read it once every plugin has activated
  (`context.lifecycle.onStarted`), or require a service the owner provides so it activates first:

  ```ts
  const ledger = context.settings.read<{ recentLimit: number }>('ledger')
  context.lifecycle.onStarted(() => showRecent(ledger.get()?.recentLimit ?? 10))
  ledger.onDidChange(({ value, changed }) => { if (changed.includes('recentLimit')) showRecent(value.recentLimit) })
  ```

  Only the user (in the Options dialog) and the owner change settings, always through the settings manager and
  the owner's checks.
- **No secrets.** Settings are plain files, and changes are pushed to every window.
- **Checking your settings:** **Tools › Settings Inspector…** (the bundled `settings-inspector` plugin) lists every
  namespace with what is in effect, its defaults and its file in `<userData>/settings`, and says whether they agree.
  A namespace at its defaults has no file; that is expected. `context.settings.snapshots()` gives the same values to
  any plugin, read-only.
- **Numbers that only make sense together** (a window, the scores within it, the threshold they add up to) should
  not be a field each: offer presets, a `choice` whose options name whole, consistent sets, each with a `description`.
  The import plugin's *Matching* setting (Strict, Balanced, Lenient) is one; see
  [import-manager-design.md › Matching tolerances](import-manager-design.md#matching-tolerances).

## Remembering application state

What your plugin remembers between runs, that the user never sets (a recent-files list, the folder a dialog showed
last, the last item selected), is **application state**. Keep it in `context.state`: your plugin's own keys in the
application's key/value store (`app.state`, kept by the `app-state` plugin in the application's database, apart from
any ledger). What the user *chooses* is a setting instead ([Settings](#settings)); a user's financial data belongs in
the ledger ([Storing data in the ledger](#storing-data-in-the-ledger)).

**1. Require the store** in your manifest, so the `app-state` plugin activates before yours:

```json
"services": { "requires": ["app.state"] }
```

This is checked: without it, every `context.state` call rejects with `used context.state without requiring
"app.state": add it to services.requires`, even when the store happens to be there already, so a missing line shows
the first time, not when the activation order changes.

**2. Read and write your keys:**

```ts
const folder = await context.state.get<string>('lastFolder', () => files.documentsPath())   // never writes the default
await context.state.set('lastFolder', chosenFolder)
await context.state.update('window', { width: 800 })        // merges into the object stored under the key
await context.state.remove('lastFolder')
```

- **Keys are yours alone.** `context.state` stores `lastFolder` as `budget.lastFolder`, so you can't read or overwrite
  another plugin's keys, and they can't reach yours. A key is any non-empty string.
- **Values are JSON.** Read them defensively: what was stored may come from an older version of your plugin, or be
  damaged; use a default rather than fail (the ledger's recent list drops any entry it can't read).
- **Calls are asynchronous**, and a failed one rejects. State is a convenience: if remembering fails, carry on with
  what the user would see the first time, and log it.
- **Nothing is removed when your plugin deactivates**, so the next run finds it. Remove keys you no longer use.

The ledger's recent ledgers (`recent`, `last`) and the import's last folder (`lastFolder`) are kept this way.

### Giving your views state

There is no channel from a view into the store: a view asks **its own plugin**, whose privileged code answers from
`context.state`, through the plugin's IPC ([IPC between your view and your privileged code](#ipc-between-your-view-and-your-privileged-code)).
Register a handler for what the view needs, not a general key/value door:

```ts
// privileged: the view's column widths, and nothing else of the plugin's state
context.subscriptions.push(
  context.ipc.register('budget:columns.get', () => context.state.get('columns', () => ({ name: 200, amount: 120 }))),
  context.ipc.register('budget:columns.set', async (msg: IpcMessage<Record<string, number>>) => {
    const widths = msg.data
    if (typeof widths !== 'object' || widths === null || !Object.values(widths).every(w => Number.isInteger(w) && w > 0)) {
      throw new Error('Column widths must be whole numbers of pixels')
    }
    await context.state.set('columns', widths)
  })
)
```

```tsx
// renderer
const widths = await window.api.invoke<Record<string, number>>('budget:columns.get')
await window.api.invoke('budget:columns.set', { ...widths, name: 240 })
```

The handler decides what a view may read and write, checks what it is given, and can only ever touch your plugin's
keys. (Any code in a window can call any channel until IPC senders are validated, so still never keep anything in
state that a view shouldn't see.)

## Storing data in the ledger

A user's financial data lives in the **open ledger**: one file, provided by the bundled `ledger` plugin as the
`ledger.session` service. (Application state, such as a recent-files list, belongs in `context.state` instead, which is
there whether or not a ledger is open.) The contract, with every id as a constant, is `@tessera/ledger-api`;
the design is in [account-manager-design.md](account-manager-design.md#the-ledger).

**1. Declare what you store**, with a `ledger.schema` contribution and a migrator service:

```json
"services": { "requires": ["ledger.session"], "provides": ["budget.migrator"] }
```

```ts
import { LEDGER_SCHEMA_POINT, LEDGER_SESSION_SERVICE, type LedgerSession, type Migrator } from '@tessera/ledger-api'

context.subscriptions.push(
  context.extensions.contribute('budget', LEDGER_SCHEMA_POINT, 'budget', {
    id: 'budget',                                  // your plugin id
    version: 1,                                    // raise it when your documents change shape
    migrator: 'budget.migrator',
    collections: [                                 // every name starts with "budget."
      { name: 'budget.targets', indexes: [{ fields: ['categoryId'], unique: true }] }
    ]
  }),
  context.services.provide('budget', 'budget.migrator', {
    async migrate(db, from) {
      if (from === 0) await db.collection('budget.targets').insert({ categoryId: 'groceries', amount: 50000 })   // seed
      // if (from === 1) … bring version 1 data to version 2
    }
  } satisfies Migrator)
)
```

- A ledger is opened with every contributor's collections, so a collection you didn't declare is refused
  (`UNKNOWN_COLLECTION`) rather than created by a typo.
- `migrate(db, from)` brings your data from `from` to `from + 1`; the ledger calls it once per version and records
  each version as it is reached. **From 0** means you have no data in this ledger yet: a new ledger, or your plugin
  was installed after the ledger was made. Use it to seed defaults.
- Before upgrading data that already exists, the ledger copies the file beside itself
  (`Home.backup-<date>.tessera`). A migrator that throws leaves the ledger closed and the backup in place, so write
  migrations that can run again.
- A ledger saved by a *newer* version of your plugin is refused, so old code never writes to new data.

**2. Read and write through the session**, which gives you your own collections only:

```ts
const session = context.services.get<LedgerSession>(LEDGER_SESSION_SERVICE)

const db = session.database('budget')              // throws NO_LEDGER when no ledger is open
await db.transaction(async tx => {                 // atomic: all or nothing
  await tx.collection('budget.targets').updateOne({ categoryId }, { $set: { amount } }, { upsert: true })
})
db.collection('ledger.subledgers')                 // throws: not yours
```

Follow the ledger with `session.onDidChange` (`opened`, `closed`) and flush anything you buffer in
`session.onWillClose`, which runs while the ledger can still be written. Menus follow the context keys
`ledger.isOpen`, `ledger.isReadOnly` and `ledger.name`.

**3. If you place items in sub-ledgers**, take part in deleting them. Deleting a sub-ledger moves everything in it to
its parent, in one transaction with yours:

```ts
context.subscriptions.push(session.participate('budget', {
  describe: async subLedgerId => `${await countIn(subLedgerId)} budgets`,     // for the confirmation
  reparent: async (tx, from, to) => {                                         // `to` null: the ledger itself
    await tx.collection('budget.budgets').updateMany({ subLedgerId: from }, { $set: { subLedgerId: to } })
  }
}))
```

**Errors.** The session throws a `LedgerError` with a `code` (`NO_LEDGER`, `DUPLICATE_NAME`, `CYCLE`,
`UNSUPPORTED_FILE`…). Test for it with `isLedgerError(err)`, not `instanceof`: each plugin bundles its own copy of
the package. For a view, `toResult(() => work())` turns one into a `{ ok: false, error }` reply it can show.

## Using accounts from another plugin

Reports, importers and budgets reach the open ledger's accounts through the **`accounts.service`** service, provided
by the bundled `accounts` plugin. Its contract is `@tessera/accounts-api`
([packages/accounts-api/](../packages/accounts-api/)). Never read the `accounts.*` collections directly: the service
is where the rules are kept.

```json
"services": { "requires": ["accounts.service"] }
```

**A report** reads:

```ts
import { ACCOUNTS_SERVICE, formatAmount, type AccountsService } from '@tessera/accounts-api'

const accounts = context.services.get<AccountsService>(ACCOUNTS_SERVICE)

const chart = await accounts.chart()              // the tree, each account's balances, totals per currency
const netWorth = chart.totals                     // { CAD: 46000 }: liabilities are negative, so it's a plain sum
const cards = await accounts.list({ types: ['creditCard'], includeClosed: false })
const business = await accounts.list({ subLedgerId: businessId, includeDescendants: true })
formatAmount(netWorth.CAD, 'CAD')                 // "$460.00", in the user's locale
```

**An importer** matches a statement to an account (or creates one), then adds its lines:

```ts
const [match] = await accounts.list({ institution: 'TD', accountNumber: { endsWith: '9012' } })
const account = match ?? await accounts.createAccount({
  name: 'TD Visa', type: 'creditCard', subLedgerId: null, currency: 'CAD',
  openingDate: '2026-01-01', openingBalance: -54000           // minor units; what is owed is negative
})
const transactions = accounts.transactions(account.id)

// Each bank line carries its id (OFX FITID, or a fingerprint of the line) as externalId, so it is never added twice
const seen = new Set((await transactions.findByExternalIds(lines.map(l => l.id))).map(t => t.externalId))
await transactions.createMany(lines.filter(l => !seen.has(l.id)).map(l => ({
  date: l.date, amount: l.amount, payee: l.payee, status: 'electronic', externalId: l.id
})))                                              // all or none, announced once; a problem names its draft: drafts[3].date

// A line that is a transaction the user already typed: it takes the bank's id, date and amount, and stays the user's
await transactions.match(typedId, { externalId: 'FIT-7', date: '2026-10-06', amount: -8412 })
// …and taken off again, putting back what the match changed, with the line as a transaction of its own
await transactions.unmatch(typedId, { restore: { date: '2026-10-05', amount: -8400, status: 'uncleared' }, add: draftOfTheLine })
```

Statement import as a whole is the `import` plugin's job
([import-manager-design.md](import-manager-design.md)); a file format is a small plugin of its own. The methods above
are for plugins that bring bank lines another way.

**A report** over transactions:

```ts
const { rows, balances } = await accounts.transactions(id).register()   // running balances, labels
const october = await accounts.transactions(id).list({ from: '2026-10-01', to: '2026-10-31' })
const categories = await accounts.categories.list()                     // categoryLabel(categories, id) → "Food : Groceries"
```

- **Money is integer minor units** (cents), signed: positive raises the balance. Turn text into an amount with
  `parseAmount(text, currency)` and back with `formatAmount` or `amountToInput`; never with floating point.
- **Follow changes** with `accounts.onDidChange`. Each event lists the account ids `created`, `updated`, `deleted`
  and whose `balances` changed, after the change is stored. Drop your own references to deleted accounts there.
- **Errors** are `AccountsError`s with a `code` (`DUPLICATE_NAME`, `ACCOUNT_CLOSED`, `CONFIRMATION_REQUIRED`…) and
  the `field` at fault. Test with `isAccountsError(err)`.
  - `CONFIRMATION_REQUIRED` carries `reasons`: ask the user, then call again with `{ confirm: reasons }`.
  - `closeAccount` needs `confirm: ['closeWithBalance']` when the balance isn't zero.
- **Every method fails with `NO_LEDGER` while no ledger is open.** Check `ledger.session.current`, or enable your
  commands on `ledger.isOpen`.
- **Transactions** (`accounts.transactions(accountId)`) follow the service's rules:
  - a closed account's transactions can't change;
  - a transfer (`transferAccountId`) is two transactions, one in each account, kept consistent;
  - a payee is created from its name on first use;
  - changing a reconciled transaction needs `confirm: ['reconciled']`.
  - **bank lines** (for importers): `externalId` identifies the line a transaction came from, is unique in the account
    (`DUPLICATE_EXTERNAL_ID`), and isn't mirrored to a transfer's other side. `createMany` is all or nothing, and its
    errors name the draft (`drafts[3].date`). `match` and `unmatch` link a line to a transaction and take it off
    again, each in one step. `match`'s `replaces` deletes the transaction the same line was added as, and only that
    one. Views can't set or clear `externalId`: the register's channels drop it.
- **The Accounts menu's commands** (`accounts.account.new`…) are user actions that follow the navigator's
  selection. From code, use the service.

### Adding a way to reconcile

The register's *Reconcile* button (a menu when there is more than one option), the navigator's account context menu
and the register's row menu list the contributions to **`accounts.reconcile.actions`**. The built-in *Reconcile with
Statement…* is one of them. A contribution is plain data naming a command; the command does the work:

```ts
import {
  ACCOUNTS_SERVICE, RECONCILE_ACTIONS_POINT,
  type AccountsService, type ReconcileActionArgs, type ReconcileActionContribution
} from '@tessera/accounts-api'

const accounts = context.services.get<AccountsService>(ACCOUNTS_SERVICE)

const match: ReconcileActionContribution = {
  id: 'bank-import.match',                  // starts with your plugin id
  label: 'Match Downloaded Statement…',
  scope: 'account',                         // or 'transaction': in a row's menu, with the selected rows
  command: 'bank-import.match',
  accountTypes: ['chequing', 'savings', 'creditCard'],   // default: every type
  icon: 'Check', description: 'Tick the transactions your bank sent'
}
context.subscriptions.push(
  context.extensions.contribute('bank-import', RECONCILE_ACTIONS_POINT, match.id, match),
  context.commands.register('bank-import.match', async (args?: unknown) => {
    const { accountId } = args as ReconcileActionArgs
    await accounts.reconciliation.begin(accountId, {
      reconcilerId: match.id, statementDate: '2026-10-31', startingBalance: 100000, statementBalance: 86975
    })
    await accounts.reconciliation.mark(accountId, idsTheBankListed, true)   // what the downloaded statement lists
    // The register is now in reconcile mode, with the Reconcile panel beside the navigator
  }, { enablement: 'ledger.isOpen && !ledger.isReadOnly' })
)
```

- **The option is enabled exactly when its command is**, so control it with the command's `enablement`. It appears
  only for `accountTypes`. An invalid contribution (no label or command, a bad scope, an id without your prefix) is
  skipped with an `[accounts]` warning.
- **The reconciliation belongs to `accounts.service`**, whichever plugin starts it: `reconciliation.get`, `begin`,
  `mark`, `pause`, `finish` and `cancel`, each taking the account id. One account has at most one at a time, and
  `begin` on an account that has one resumes it with the new figures. Marks are saved at once, so a paused
  reconciliation survives a restart; `cancel` puts back every status it changed.
- **A statement's service charge and interest** can go to `begin` as `serviceCharge` and `interest`
  (`{ amount, date, categoryId? }`, the amount unsigned as printed). Each is added as a marked transaction, with the
  sign `chargeAmount(kind, accountType, amount)` gives; `cancel` deletes them again.
- **`finish` needs `confirm: ['adjustBalance']`** when the ledger would still differ from the statement
  (`summary.adjustment` isn't zero); it then adds a reconciled *Balance adjustment* transaction. Ask the user first.
- **Your own UI** is an ordinary view with `when: "accounts.reconciler == 'bank-import.match'"`: the context key holds
  the id of the option that started the reconciliation on the register's account.
- `accounts.onDidChange` lists the accounts whose reconciliation changed in `reconciliations`.

### Marking register rows

A plugin can mark rows in an account's register, with up to two buttons per row, through
**`accounts.register.annotations`**. The import manager uses it for the bank lines to review (*Accept* and
*Change…*). The register draws everything; your plugin supplies data through a `RegisterAnnotator` service, and its
buttons run your commands:

```ts
import {
  REGISTER_ANNOTATIONS_POINT, type AccountAnnotations, type RegisterAnnotationsContribution, type RegisterAnnotator
} from '@tessera/accounts-api'

const changed = new Set<(change: { accounts: string[] }) => void>()
const annotator: RegisterAnnotator = {
  async annotate(accountId): Promise<AccountAnnotations> {
    return {
      rows: [{
        transactionId, review: true, tone: 'warning',                       // 'info', 'warning' or 'success'
        detail: { icon: 'CompareArrows', parts: [{ text: 'Possible match: ' }, { text: '57.50', emphasis: true }] },
        actions: [
          { id: 'accept', label: 'Accept', icon: 'Check', placement: 'button', command: 'bank-import.accept', args: { lineId } },
          { id: 'why', label: 'Why this match?', placement: 'menu', command: 'bank-import.explain', args: { lineId } }
        ]
      }],
      summary: { message: '1 bank line to review', actions: [/* Accept All…, as above */] }
    }
  },
  onDidChange: listener => { changed.add(listener); return { dispose: () => changed.delete(listener) } }
}
const contribution: RegisterAnnotationsContribution = { id: 'bank-import.review', service: 'bank-import.annotator' }
context.subscriptions.push(
  context.services.provide('bank-import', 'bank-import.annotator', annotator),
  context.extensions.contribute('bank-import', REGISTER_ANNOTATIONS_POINT, contribution.id, contribution)
)
// After your own data changes: the registers of these accounts reload and ask again
changed.forEach(listener => listener({ accounts: [accountId] }))
```

- **What the register shows:**
  - a row with `detail.parts` gets a second line under it, with the `emphasis` parts in the tone's colour;
  - a row with `review: true` gets a bar at its left edge, is counted in a bar above the register (with your
    `summary`), and is visited by *Next* and `F8`;
  - something to review that isn't a row (the import's bank line that lost its transaction) keeps your summary's bar
    up while `summary.outstanding` is above zero, with its actions (*Resolve…*), but no *Next*;
  - the first two `'button'` actions become buttons in a *Review* column, and `Ctrl+Enter` and `Ctrl+Shift+Enter` run
    them;
  - every action is also in the row's context menu.
- **Your commands get `args`** as their only argument (`shell:commands.execute`). A result of `{ ok: false, error: {
  message } }`, or an error thrown, is shown in the register's notice area.
- **A closed account** shows your marks, but no buttons or actions. In reconcile mode nothing is shown.
- **A broken annotator can't break the register.** Answer within 2 seconds (`ANNOTATE_TIMEOUT_MS`). One that throws,
  is slow or isn't provided is logged (`[accounts]`) and left out. What you return is checked: rows for
  transactions the register doesn't show, and actions without an id, label, command or placement, are dropped.
- **Two annotators on one row:** the first by `order` draws the second line and the buttons, and the other's actions
  go to the row's menu.
- **Reloads:** the register reloads after `accounts.onDidChange` for its account, so call your `onDidChange`
  listeners only for changes of your own.

To let the user **create an account with values filled in**, say from a statement, open the accounts plugin's own
dialog with `initial`. The form starts from it, every field stays editable, and it is checked as if typed:

```ts
const chart = await accounts.chart()
const created = await prompts.show<{ id: string }>(ACCOUNTS_DIALOGS.account, {
  mode: 'create', subLedgerId: null, subLedgers: chart.subLedgers, ledgerName: chart.ledger.name, defaultCurrency: 'CAD',
  initial: { name: 'TD Visa 3456', type: 'creditCard', currency: 'CAD', openingDate: '2026-09-30', openingBalance: -54000 }
} satisfies AccountDialogInput)                  // what is owed is negative, and shown as the amount owed
```

## Adding an import format

*File › Import…* belongs to the bundled `import` plugin (the import manager), which knows no file format. A format is
a small plugin that turns a file's bytes into statements; the import manager does everything else:
- it finds each statement's account, and remembers it;
- it leaves out lines imported before;
- it adds the rest.

The bundled OFX plugin ([plugins/import-ofx/](../plugins/import-ofx/)) is the example to follow. The contract is
`@tessera/import-api`.

```json
{ "id": "bank-csv", "name": "Bank CSV", "version": "0.1.0", "privileged": { "entry": "privileged/index.js" },
  "services": { "provides": ["bank-csv.format"] } }
```

```ts
import type { PluginContext } from '@tessera/types'
import { IMPORT_FORMATS_POINT, ImportError, canonicalDecimal, isoDate, type ImportFormat, type ImportFormatContribution } from '@tessera/import-api'

const FORMAT: ImportFormatContribution = {
  id: 'bank-csv.csv', label: 'Bank CSV export', extensions: ['csv'], service: 'bank-csv.format',
  description: 'The CSV file your bank’s website exports.'
}
const format: ImportFormat = {
  sniff: ({ head }) => new TextDecoder().decode(head).startsWith('Date,Description,Amount'),   // optional
  async parse(file, context) {
    const rows = file.text().split(/\r?\n/).slice(1).filter(Boolean).map(row => row.split(','))
    if (rows.length === 0) throw new ImportError('UNREADABLE', `${file.name} has no transactions.`)
    return {
      statements: [{
        account: { key: 'bank-csv:my-bank', keyStrength: 'weak', label: 'My Bank (CSV)' },
        lines: rows.map(([date, payee, amount]) => ({ date: isoDate(date, 'MDY')!, payee, amount: canonicalDecimal(amount)! }))
      }]
    }
  }
}

export function activate(context: PluginContext) {
  context.subscriptions.push(
    context.extensions.contribute('bank-csv', IMPORT_FORMATS_POINT, FORMAT.id, FORMAT),
    context.services.provide('bank-csv', FORMAT.service, format)
  )
}
```

- **Your extensions appear in the import dialog's filters.** With more than one format for an extension, `sniff`
  decides, and the user is asked if it can't.
- **Amounts are canonical decimal strings** (`'-84.12'`), signed from the account's side: positive raises its balance,
  so a card's charges are negative. Use `canonicalDecimal(text, { decimal })` for what a bank writes (`'1.234,56'`,
  `'(12.00)'`), and never a JavaScript number. The import manager converts them once it knows the account's currency.
- **Dates are `YYYY-MM-DD`.** `isoDate(text, 'MDY' | 'DMY' | 'YMD')` reads a bank's and refuses what is ambiguous.
  A line you can't read should go into `warnings`, not the statement.
- **Say how your files name their account**, with `account.key`:
  - `'strong'` when it is an account number: the account is then found, or remembered, without asking;
  - `'weak'` when it only suggests one (a column layout): the user is asked each time, with the last answer chosen;
  - with no key, the file's name is used, weakly.
- **Give `externalId`** when the format has the bank's own ids, so re-imports are recognised exactly. Without one,
  lines are recognised by a fingerprint of their content. Set `stableIds: false` on the contribution if your source
  changes its ids between downloads.
- **Ask the user only through a dialog of your own** (`shell.dialogs`), and resolve `undefined` if they cancel: the file
  is then skipped. `context.memory` keeps small values in the ledger between imports, such as a column layout.
- **Don't read files or touch accounts.** `parse` gets the bytes (`file.bytes`, `file.text(encoding)`); a byte-order
  mark wins over the encoding you ask for. Use `file.text('windows-1252')` rather than your own `TextDecoder`: Node's
  reads windows-1252 as ISO-8859-1 and loses `€` and curly quotes, and `text()` doesn't. Throw
  `ImportError('UNREADABLE', message)` for a file you can't read: the message is shown. `parse` has 30 seconds, and
  files over 25 MB are refused before it is called.

Other plugins can also import statements they already have (from a bank connection, say) through the `import.manager`
service: `importStatements(statements, { label }, { interactive })`. They go through the same account resolution,
duplicate checks and summary report.

## Styling and theming

The shell has a light and a dark theme and follows the operating system by
default. Your views get the same look by using what `@tessera/ui` provides, and
no colours of their own.

```tsx
import { Box, Button, Icon, Stack, Typography, useThemeState } from '@tessera/ui'

export default function Summary() {
  return (
    <Stack spacing={1}>
      <Typography variant="h6">Summary</Typography>
      {/* Theme tokens in sx, never literal colours: these follow light and dark */}
      <Box sx={{ p: 1, borderRadius: 1, bgcolor: 'action.selected', color: 'text.primary' }}>
        Balance
      </Box>
      <Button variant="outlined" startIcon={<Icon name="Save" />}>Save</Button>
    </Stack>
  )
}
```

`@tessera/ui` (version 1.3) exports a curated set, added when a view needs it:

| For | Components |
|---|---|
| Layout and surfaces | `Box`, `Stack`, `Paper`, `Divider`, `Toolbar`, `Collapse` |
| Text and feedback | `Typography`, `Alert`, `CircularProgress`, `Tooltip` |
| Buttons | `Button`, `IconButton`, `ToggleButton`, `ToggleButtonGroup` |
| Forms | `TextField`, `Autocomplete`, `Checkbox`, `Radio`, `RadioGroup`, `FormControl`, `FormControlLabel`, `FormLabel`, `FormHelperText`, `InputAdornment` |
| Lists and menus | `List`, `ListItemButton`, `ListItemIcon`, `ListItemText`, `Menu`, `MenuItem` |
| Tables | `Table`, `TableContainer`, `TableHead`, `TableBody`, `TableRow`, `TableCell` |
| Tabs and dialogs | `Tab`, `Tabs`, `Dialog`, `DialogTitle`, `DialogContent`, `DialogActions` (for a dialog of your own, prefer [`shell.dialogs`](#contributing-a-dialog)) |
| Theme, fonts and icons | `useTheme`, `useThemeState`, `useFontRoles`, `Icon`, `createSvgIcon` |

Prop types for the common ones are exported too (`TextFieldProps`, `AutocompleteProps`, `MenuProps`,
`TooltipProps`, `Theme`). Style with the `sx`
prop and the theme's tokens (`primary.main`, `text.secondary`, `background.paper`,
`action.selected`, `divider`, ...), never literal colours: a hex colour that suits the
light theme is unreadable on the dark one. (A test fails the build of the shell's own
code on a literal hex colour.) Compact density is the shell's, and fonts come from the
font roles (below), so your views match without choosing them.

**Icons.** `<Icon name="Save" />` draws one of the shell's standard icons; see
[the layout note](layout-controller-design.md#icons) for the set. For others, register
your own with `shell.icons` (`{ id: 'budget.chart', file: './icons/chart.svg' }`) and use
`<Icon name="budget.chart" />`: it is fetched when first drawn and cached, and is painted
in the text colour. Or build a component from path data with `createSvgIcon` and ship it
inside your view code. The same ids work for the `icon` of a view or bar item.

**Fonts.** Text is drawn in *font roles*, kinds of text whose font the user chooses (and a
theme may set): Interface text, Headings, Small text, Tables and registers, Amounts and
figures, Fixed-width text ([design](font-roles-design.md)). Your views follow them by using
the variants and components:

| Role | What follows it |
|---|---|
| Interface text | `body1`, `body2`, buttons, fields, menus, lists, tabs: every size follows this one |
| Headings | `h1` to `h6`, `subtitle1`, `subtitle2`, dialog titles |
| Small text | `caption`, `overline`, helper text under fields, tooltips |
| Tables and registers | `Table` and its cells |
| Amounts and figures | **`variant="numeric"`**, or `sx={{ typography: 'numeric' }}`: digits of equal width, in the size of the text around them |
| Fixed-width text | **`variant="monospace"`**, or `sx={{ typography: 'monospace' }}`: paths, file contents |

```tsx
<TableCell align="right" sx={{ typography: 'numeric' }}>{amount}</TableCell>
<Typography variant="monospace" component="pre">{json}</Typography>
```

- **Never name a font or a size:** no `fontFamily: 'monospace'`, no `fontSize: 13`, `'12px'` or
  `'0.75rem'`, and no `fontVariantNumeric` (that is what `numeric` is for). Sizes relative to
  the text around (`'0.75em'`) and `fontWeight` for emphasis are fine. A test fails on a
  literal family or size in the shell's and the bundled plugins' views.
- **Text may be larger than you designed for:** Interface text goes from 11 to 24 px. Give table
  columns widths in `em` (a width designed for 13 px text, divided by 13), the table's
  `minWidth` too, and let a table scroll sideways rather than cut an amount short: a truncated
  amount reads as a different number.
- **`useFontRoles()`** returns each role as data (the CSS family, the size in px, the weight), for
  what the theme can't style, such as a canvas or a chart. It is read only.

**Theme as data.** `useThemeState()` returns `{ theme, mode }` (`'light'` or `'dark'`),
for what the MUI theme can't style, such as a canvas or a third-party chart. It is read
only: the user changes the theme, plugins don't.

**Contributing a theme.** A plugin can offer a colour scheme by contributing to
`shell.themes`; see [theming-design.md](theming-design.md#themes) for the token set. A
theme with a `light` and a `dark` variant can follow the system; one with a single
variant is shown in that variant only.

```ts
context.extensions.contribute(context.pluginId, 'shell.themes', 'budget.sunrise', {
  id: 'budget.sunrise',                 // prefixed by your plugin id
  label: 'Sunrise',                     // what the menu shows
  light: { primary: '#c2410c', background: { default: '#fff7ed', paper: '#ffffff' } },
  dark:  { primary: '#fb923c', background: { default: '#1c1410', paper: '#271c15' } }
})
```

Set only the tokens you want to change (`primary`, `secondary`, `error`, `warning`, `info`,
`success`, `background.default`, `background.paper`, `text.primary`, `text.secondary`,
`divider`); the rest come from the shell's theme. Colours are hex or `rgb()`/`hsl()`:
colour names are rejected so every colour can be parsed and adjusted. A theme with a
mistake is skipped with a `[theme]` warning. The theme then appears on the Options dialog's
**Appearance** page (Tools ▸ Options…), as a card drawn from its colours, with a preview of
it in each mode before the user chooses; plugins can't change the theme themselves. Give it
an optional `description` (a short line) and the card shows it, and the page's filter finds
it by it.

A theme may also set **fonts**, by role (the roles are in [Fonts](#styling-and-theming) above):

```ts
context.extensions.contribute(context.pluginId, 'shell.themes', 'budget.ledgerbook', {
  id: 'budget.ledgerbook',
  label: 'Ledger Book',
  light: { primary: '#7c2d12', background: { default: '#fbf6ea', paper: '#fffdf7' } },
  fonts: {
    heading: { family: ['Georgia', 'Cambria', 'serif'], weight: 600 },
    numeric: { family: ['Cascadia Mono', 'Consolas'] }
  }
})
```

- Each role takes only what it has: a `family` for all of them; a `size` for Interface text,
  Small text, Tables and registers, and Fixed-width text; a `weight` (400, 500, 600 or 700) for
  Interface text and Headings.
- `family` is a list of font names, most wanted first, and never CSS: the shell quotes them and
  adds its own fallbacks. End it with a generic family (`serif`, `monospace`) for computers
  without your first choices. Fonts must be installed on the user's computer: a theme can't
  ship font files yet.
- Sizes are whole pixels, held to a narrower range than the user's (12 to 16 for Interface
  text and Tables and registers, 10 to 14 for Small text, 11 to 16 for Fixed-width text), so a
  theme chosen for its colours can't break a layout.
- The user's own choices on the Fonts page win, and the user can turn themes' fonts off. A
  role you don't set keeps the user's font or Tessera's. The theme's card says what it sets.
- A font that can't be used (an unknown role, a size out of range, a name with `;` in it) skips
  the theme with a `[theme]` warning, as a bad colour does.
- **Colour isn't a font's:** text is drawn in the theme's `text.primary` and `text.secondary`
  (and the status colours, such as `error` for what is owed), set per mode above and checked
  for contrast.

The sample [test-layout](../plugins/test-layout/src/privileged/index.ts) contributes two;
its Sunrise sets serif headings.

A theme that is hard to read still works, but the log says so: `Theme "budget.sunrise"
may be hard to read: text.primary on background.paper is 3.1:1 in light mode (WCAG AA asks
for 4.5:1)`. Check yours against the figures: 4.5:1 for text and 3:1 for the primary
colour on the paper.

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
| `@tessera/ui` | the shell's components, icons and theme access (see [Styling and theming](#styling-and-theming)) |

A plugin may import only `@tessera/types` and `@tessera/ui` from the framework,
and **never `@mui/*` or `@emotion/*` directly**: they are the shell's private
dependencies, and a second copy would ignore the shell's theme. The plugin build
fails with a message pointing at `@tessera/ui` if you do.

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
    await reopenLastNotebook()
  })

  context.lifecycle.onShuttingDown(async (event) => {
    if (notebookIsDirty()) {
      const choice = await askToSave()           // everything is still running here
      if (choice === 'cancel') return event.veto('user cancelled')
      if (choice === 'save') await saveNotebook()
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
  context.ipc.register('notes:edit', handler),
  context.extensions.contribute('notes', 'shell.menus', 'notes.menu', { kind: 'menu', id: 'notes.menu', label: '&Notes' }),
  context.services.provide('notes', 'notes.store', store),
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
| `cannot register command "…": ids must start with "<id>."` | `[plugins] Failed to activate` | A command id doesn't start with your plugin id. An IPC-style handler (`'budget:summary'`) belongs on `context.ipc.register`, not `commands.register` |
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
| `cannot register settings "…"` or `the defaults fail their own validation` | `[plugins] Failed to activate` | A settings id that isn't yours (or isn't lower-case dotted words), registered twice, or defaults your `validate` refuses |
| Settings page missing from Options | `[settings] Settings page "…" ignored: …` | Its id doesn't start with your plugin id, it edits settings you didn't register, or it has both `module` and `fields` |
| A field missing from a page | `[settings] Settings page "…": field "…" …; the field is left out` | Its `key` has no default, or the default doesn't suit the kind (a number field over a string) |
| Your settings are back at their defaults | `[settings] Settings "…" …` | The saved file was not JSON (it is now `<id>.json.bad`), failed `validate`, or `migrate` threw; the message says which |
| A setting doesn't seem to be saved | Tools › Settings Inspector… | A namespace at its defaults has no file, by design; one that differs should show *Matches its file*. *Differs* or *File unreadable* says why |
| `used context.state without requiring "app.state"` | the rejected call, or `[plugins] Failed to activate` | Add `"app.state"` to `services.requires` in your manifest |
| `"app.state" is not available` | the rejected call | The `app-state` plugin isn't installed, or failed to activate (look for its own message), or the storage engine it needs is missing |
| A saved setting can't be changed | `… were saved by version N of their shape …; they are read-only` | A newer version of your plugin saved it; raise your `version` and migrate, or reset it |

---

## Reference

| Concept | Value | Defined in |
|---|---|---|
| Menus extension point | `shell.menus` | [shared/menus/types.ts](../shared/menus/types.ts) |
| Reserved top-level menus | `shell.file`, `shell.tools`, `shell.help` | [shared/menus/types.ts](../shared/menus/types.ts) |
| Default menu group | `additions` | [shared/menus/types.ts](../shared/menus/types.ts) |
| Views extension point | `shell.views` | [shared/views/types.ts](../shared/views/types.ts) |
| Main slot | `shell.main` | [shared/views/types.ts](../shared/views/types.ts) |
| Dialogs extension point | `shell.dialogs` (`DialogContribution`, `DialogProps`) | [tessera-types/dialogs.ts](../tessera-types/dialogs.ts) |
| Application state | `context.state` (`PluginState`), service `app.state` (`APP_STATE_SERVICE`) | [tessera-types/app-state.ts](../tessera-types/app-state.ts), [core/state/PluginState.ts](../core/state/PluginState.ts) |
| Settings | `context.settings` (`SettingsApi`, `SettingsDefinition`, `SettingsHandle`, `SettingsReader`) | [tessera-types/settings.ts](../tessera-types/settings.ts) |
| Settings pages extension point | `shell.settings.pages` (`SettingsPageContribution`, `SettingsField`, `SettingsPageProps`) | [tessera-types/settings.ts](../tessera-types/settings.ts) |
| Opening the Options dialog | command `shell.settings.open` (optional argument: a page id) | [shell/main/settings/registerSettings.ts](../shell/main/settings/registerSettings.ts) |
| Settings page and field validation | `resolveSettingsPages`, `fieldValueProblem` | [shared/settings/](../shared/settings/) |
| Prompts and file services | `shell.prompts` (`ShellPrompts`), `shell.files` (`ShellFiles`) | [tessera-types/dialogs.ts](../tessera-types/dialogs.ts) |
| Dialog validation | `resolveDialogs` | [shared/dialogs/resolveDialogs.ts](../shared/dialogs/resolveDialogs.ts) |
| Finance plugin contracts | `@tessera/ledger-api`, `@tessera/accounts-api` | [packages/ledger-api/](../packages/ledger-api/), [packages/accounts-api/](../packages/accounts-api/) |
| Manifest schema and validation | `parseManifest` | [shared/plugins/manifest.ts](../shared/plugins/manifest.ts) |
| Plugin context (interface) | `PluginContext` | [tessera-types/plugins.ts](../tessera-types/plugins.ts) |
| Plugin context (implementation) | `createPluginContext` | [core/plugins/PluginContext.ts](../core/plugins/PluginContext.ts) |
| Service registry | `ServiceRegistry` (interface), `ServiceRegistryImpl` | [tessera-types/service.ts](../tessera-types/service.ts), [core/services/ServiceRegistry.ts](../core/services/ServiceRegistry.ts) |
| Activation ordering | `planActivation` | [core/plugins/activationPlan.ts](../core/plugins/activationPlan.ts) |
| Service id format | `SERVICE_ID_PATTERN`: dotted, e.g. `ledger.session` | [shared/plugins/manifest.ts](../shared/plugins/manifest.ts) |
| Command enablement | `enablement` option | [core/commands/CommandRegistry.ts](../core/commands/CommandRegistry.ts) |
| Enablement expression syntax | `parseWhen` / `evaluateWhen` | [shared/context/when.ts](../shared/context/when.ts) |
| Renderer bridge | `window.api.invoke` (`TesseraBridge`) | [tessera-types/ipc.ts](../tessera-types/ipc.ts), [shell/preload/preload.ts](../shell/preload/preload.ts) |
| IPC envelope and guards | `isIpcRequest`, `isIpcEvent` | [shared/ipc.ts](../shared/ipc.ts) |
| Plugin file protocol | `tessera-plugin://<id>/…` | [shell/main/plugins/pluginProtocol.ts](../shell/main/plugins/pluginProtocol.ts) |
| Shared federation modules | `react`, `react/jsx-runtime`, `react-dom` | [shell/renderer/views/federationViewLoader.ts](../shell/renderer/views/federationViewLoader.ts) |
