# Design note: settings

| | |
|---|---|
| **Status** | Proposed, not implemented |
| **Date** | 2026-10-17 |
| **Scope** | Application-wide settings: how plugins define, store, edit and read them |
| **Related** | [plugin-creation.md](plugin-creation.md), [vault-design.md](vault-design.md), [todo.md](todo.md) |

## Summary

**Plugins own the shape of their settings and the UI that edits them. The
framework owns persistence, the settings dialog, and the edit lifecycle.**
This follows the Eclipse preference-page model.

- A plugin registers **defaults** for its settings namespace and
  contributes one or more **settings pages**: ordinary views, loaded through
  the existing Module Federation machinery.
- The framework stores the values, hosts the pages in a settings dialog,
  holds the **draft**, and handles OK, Apply, Cancel and Restore Defaults the
  same way for every plugin.
- Plugins read their settings through `context.settings` and are notified of
  changes.
- Settings are separate from **framework state** (recent files, window
  bounds), though both use one persistence layer.

## Context

The shell knows nothing about any business function, so it can't know which
settings exist. Plugins will have very different needs: a currency picker, a
category tree editor, a "test connection" button on a bank importer. A purely
declarative form (a list of typed fields rendered by the shell) can't
express the richer ones. Letting plugins bring their own pages can, and the
view-loading, error isolation and lazy loading already exist.

The cost is consistency: pages can look different, and "search all settings"
is harder. This design recovers most of that by keeping the *lifecycle*
(draft, validation, apply, reset, search metadata) in the framework, and
leaves room for an optional declarative form later (see Phases).

### State versus settings

| | Framework state | Settings |
|---|---|---|
| Written by | The plugin, silently | The user, through a settings page (defaults from the plugin) |
| Shape | Opaque key/value | Plugin-defined JSON with registered defaults |
| Examples | Recent files, window bounds, last vault opened | `vault.autoBackup`, default currency |
| Shown in UI | No | Yes |

Per-vault data (accounts, categories) belongs in the vault's own store, not
in either of these.

## Goals and non-goals

**Goals**

- Plugins define their own settings shape and page UI.
- One consistent edit experience: draft, validate, apply, cancel, restore
  defaults.
- Settings survive plugin upgrades through versioned migration.
- A corrupt or invalid settings file never prevents startup.
- Plain, human-readable files on disk.

**Non-goals (for now)**

- Per-vault scope. Application scope only. The API reserves a `scope`
  argument; vault scope is designed once the vault exists.
- A settings editor for users who edit JSON by hand. The files are readable,
  but no text editor integration is planned.
- Syncing settings between machines.
- Storing secrets. Passwords and keys must never go in settings; see the
  keychain question in the vault design note.

## Components

```
 plugin (privileged)                        plugin (renderer remote)
 ───────────────────                        ────────────────────────
 context.settings.register(defaults, …)     ./VaultSettingsPage  (a React component)
 context.extensions.contribute(                    ▲
   id, 'shell.settings.pages', pageId, {...})      │ props: value, defaults, onChange,
        │                                          │        onValidityChange, disabled
        ▼                                          │
 ┌───────────────────────────────────┐   IPC   ┌───┴───────────────────────────────┐
 │ main: SettingsService             │◄───────►│ renderer: settings dialog (shell) │
 │  get / commit / reset / events    │         │  nav tree, search, draft,         │
 │  validate, migrate, merge defaults│         │  OK / Apply / Cancel / Restore    │
 └───────────────┬───────────────────┘         └───────────────────────────────────┘
                 │ uses
                 ▼
 ┌───────────────────────────────────┐
 │ JsonPersistence (port in core)    │  adapter in shell/main:
 │  read / write atomic / flush      │  userData/settings/<pluginId>.json
 └───────────────────────────────────┘  userData/state/<pluginId>.json
```

| Component | Lives in | Responsibility |
|---|---|---|
| `JsonPersistence` | port in `core/`, JSON-file adapter in `shell/main` | Atomic, debounced writes of small JSON documents; flush on quit |
| `SettingsService` | `core/` | Registered defaults, merge, validate, migrate, commit, reset, change events |
| `context.settings` | plugin context | Each plugin's scoped view of the service. Not in `PluginContext` today; it would be added to [tessera-types/plugins.ts](../tessera-types/plugins.ts) |
| `shell:settings.*` IPC | `shell/main` | Lets the dialog read and commit values |
| Settings dialog | `shell/renderer` | Navigation, search, page hosting, draft and button handling |
| `shell.settings.pages` | extension point | Plugins contribute pages |

## Plugin-facing API

### Registering settings (privileged side)

```js
exports.activate = (context) => {
  const settings = context.settings.register({
    version: 2,
    defaults: { autoBackup: true, backupCount: 5, backupFolder: null },

    // Upgrades stored values written by an older plugin version
    migrate(old, fromVersion) {
      return fromVersion < 2 ? { ...old, backupCount: old.keepBackups ?? 5 } : old
    },

    // Authoritative validation, run on every commit; return error messages
    validate(value) {
      return value.backupCount >= 1 ? [] : ['Keep at least one backup']
    }
  })

  settings.get()                       // → merged value, never partial
  settings.onDidChange((value, previous) => { /* react */ })
}
```

```ts
interface SettingsApi {
  register<T extends Json>(options: {
    defaults: T
    version?: number                        // default 1
    migrate?(stored: Json, fromVersion: number): T
    validate?(value: T): string[]
    scope?: 'application'                   // 'vault' reserved for later
  }): SettingsHandle<T>
}

interface SettingsHandle<T> {
  get(): T
  onDidChange(listener: (value: T, previous: T) => void): Disposable
}
```

- A plugin has **one settings namespace**: its plugin id. `register` is
  called at most once, from `activate`.
- A plugin reads only its own settings. If another plugin needs a value, the
  owner exposes it through a service, the same rule as for the vault store.
- `get()` returns the stored overrides deep-merged over the defaults, so keys
  added in a newer version appear without migration.

### Contributing a page

```js
context.extensions.contribute('vault', 'shell.settings.pages', 'vault.settings', {
  id: 'vault.settings',                  // plugin-prefixed, like every contribution
  title: 'Vault',
  parent: 'shell.settings.general',      // a category, or another page
  module: './VaultSettingsPage',         // exposed by the plugin's renderer remote
  keywords: ['backup', 'autosave'],
  order: 10
})
```

```ts
interface SettingsPageDescriptor {
  id: string
  title: string
  parent?: string        // page or category id; omitted = top level
  module?: string        // omit for a category-only node
  keywords?: string[]
  order?: number
}
```

- The shell contributes a few **categories** (no `module`), starting with
  `shell.settings.general`, so plugins have somewhere to nest.
- Pages are validated and ordered like views: invalid or duplicate
  descriptors are skipped and logged.
- A page edits the namespace of the plugin that contributed it. Several
  pages from one plugin share one draft.

### Writing a page (renderer side)

The page is a default-exported React component, loaded from the plugin's
remote like any view:

```tsx
export default function VaultSettingsPage({ value, defaults, onChange, onValidityChange, disabled }: SettingsPageProps<VaultSettings>) {
  return (
    <label>
      <input type="checkbox" disabled={disabled} checked={value.autoBackup}
             onChange={e => onChange({ ...value, autoBackup: e.target.checked })} />
      Back up automatically
    </label>
  )
}
```

```ts
interface SettingsPageProps<T> {
  value: T                              // the current draft
  defaults: T
  onChange(next: T): void               // replaces the draft
  onValidityChange(valid: boolean): void  // gates OK and Apply; UX only, not authoritative
  disabled: boolean                     // true while a commit is in progress
}
```

Pages don't call the settings IPC. The dialog does that, and passes the draft
down. Pages can still call their own plugin's IPC for actions such as "Test
connection". This is the first time views receive props, which is the "view
props and context" item in the todo list.

## Persistence

| | |
|---|---|
| Location | `<userData>/settings/<pluginId>.json` |
| Format | `{ "version": 2, "values": { … } }` |
| What's stored | Only the values that **differ from the defaults** |
| Read | Deep-merge the stored overrides over the registered defaults. Objects merge; arrays and scalars replace wholesale |
| Write | Atomic (temp file then rename), debounced, flushed on quit |
| Restore defaults | Delete the stored overrides |

Storing overrides means new defaults in a plugin update reach users who never
changed that setting. The state store uses the same `JsonPersistence` under
`<userData>/state/`.

**Failure handling.** None of these prevents startup:

- *Invalid JSON:* the file is renamed to `<name>.json.bad`, a warning is
  logged, and defaults are used.
- *Older version:* `migrate` runs on load; the upgraded value is written at
  the next save.
- *Newer version than the plugin knows (a downgrade):* values are used
  read-only and not rewritten, with a warning.
- *Fails `validate`:* a warning is logged and defaults are used for the
  session. The file is left untouched until the user saves.
- *Plugin no longer installed:* its file is kept and ignored.

## The settings dialog

Opened by the command `shell.settings.open` (Tools › Options…,
`Ctrl+,`).

- **Layout:** a navigation tree built from page descriptors (`parent` and
  `order`), with the selected page on the right and a search box above the
  tree. Search matches `title` and `keywords`.
- **Draft:** the dialog holds one draft per plugin namespace, initialised
  from the current value. A namespace is *dirty* when its draft differs from
  the stored value.
- **Buttons:**
  - **Apply:** commit every dirty namespace, keep the dialog open.
  - **OK:** Apply, then close.
  - **Cancel:** discard all drafts and close. Closing a dirty dialog asks
    first.
  - **Restore Defaults** (per page): sets the draft to the defaults.
- **Commit:** `shell:settings.commit` runs the plugin's `validate`. On
  errors, nothing is saved, and the messages are shown on the page's
  namespace. On success, the value is persisted and `onDidChange` fires in
  the main process.
- **Validity:** a page that calls `onValidityChange(false)` disables OK and
  Apply until it's valid again. This is a convenience; `validate` in the main
  process is authoritative.
- **Failed page:** an error boundary around each page, as for views. A
  crashed page shows an error, and the others still work.

Opening the dialog from a main-process command needs a main → renderer
event. That channel is already on the todo list, and the renderer-side
context keys need it as well (see Open questions).

## Reading settings

| Reader | How |
|---|---|
| The plugin's privileged code | `handle.get()`, `handle.onDidChange(...)` |
| The plugin's own views | Ask their privileged code through plugin IPC |
| Another plugin | Through a service the owner provides |
| The shell | Its own settings use the same API under namespace `shell` |

The settings IPC is not exposed to views for reading, so views do not
subscribe to settings changes directly in v1. A plugin that needs live
updates in a view pushes them itself once main → renderer events exist.

## Key flows

### Startup

1. The shell creates `SettingsService` with `JsonPersistence`.
2. Each plugin's `activate` calls `context.settings.register(...)`. The
   service loads that plugin's file, then migrates, validates and merges.
   `get()` is valid immediately.
3. Plugins contribute their pages. The dialog reads the descriptors when it
   opens, so contributions from every plugin are present.

### Change a setting

1. The user opens Options, picks the Vault page, and toggles a checkbox: the
   page calls `onChange`, and the dialog updates the draft.
2. The user clicks OK. The dialog sends the draft to
   `shell:settings.commit` for `vault`.
3. The service runs `validate`, persists the overrides, and fires
   `onDidChange` in the vault plugin.
4. The vault reacts, for example by rescheduling backups.

## Alternatives considered

| Alternative | Why not (as the only mechanism) |
|---|---|
| **Declarative schema rendered by the shell** | Uniform and searchable, but can't express a category editor or a "test connection" action. Kept as an optional later convenience. |
| **Pages edit settings directly through IPC** | Every plugin would re-implement apply/cancel, and a cancelled dialog could leave half-saved changes. |
| **One shared `settings.json`** | A corrupt plugin entry could take down everyone's settings, and writes would contend. One file per plugin isolates failures. |
| **Storing full values, not overrides** | New defaults in plugin updates would never reach existing users. |
| **Settings in the vault** | Application settings must exist before any vault is open. Per-vault settings will live there later. |

## Framework prerequisites

1. **Deactivate and flush on quit** (todo), so debounced writes aren't lost.
2. **`JsonPersistence` port and adapter**, shared with the state store.
3. **View props**: pass props to a view, from the host (todo: "View props
   and context").
4. **Main → renderer events** (todo), to open the dialog from a command.
5. **Declared extension points** (todo), which would let the shell declare
   `shell.settings.pages` with a schema. Helpful, but not blocking.

## Open questions

1. **Opening the dialog.** A main → renderer event (leaning), or a separate
   modal `BrowserWindow` loading a settings route of the same renderer,
   which avoids the event channel but adds routing and window management.
2. **Draft ownership across pages.** All pages of one plugin share one draft.
   Is that a problem for plugins with many independent pages? Per-page
   namespaces would complicate `register`.
3. **Live apply.** Should some settings (theme, say) apply as the user edits,
   with Cancel reverting? That needs a preview hook beyond the draft model.
4. **Trust.** Any plugin's renderer code can call the settings IPC for any
   namespace, since `window.api` is shared. The dialog is the only intended
   caller, but nothing enforces it. This is the existing "plugin trust" and
   "validate IPC senders" todo, and settings make it more sensitive.
5. **Arrays and the overrides model.** Replacing arrays wholesale is simple
   but means a plugin update can't add default elements to a list the user
   customised. Acceptable?
6. **Localisation** of page titles, keywords and validation messages.
7. **Import and export** of settings (a backup for moving machines): the
   framework can zip the settings folder, but should plugins be able to opt
   keys out (machine-specific paths)?

## Suggested phases

1. **Foundations:** deactivate on quit, `JsonPersistence` and its adapter, and
   the state store on top.
2. **Settings core:** `SettingsService`, `context.settings`, versioning,
   migration, validation, failure handling, with tests including corrupt
   and newer-version files. No UI yet; a plugin can already read its values,
   and users can edit the file.
3. **Dialog:** view props, main → renderer events, the navigation tree,
   draft and buttons, the `shell.settings.open` command and Tools menu item,
   and `shell.settings.pages` handling.
4. **Polish:** search, Restore Defaults, unsaved-changes prompt, keyboard
   navigation, accessibility.
5. **Optional extras:** a declarative field form for simple plugins that
   generates a page; vault scope; import and export.
