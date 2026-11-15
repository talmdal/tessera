# Design note: options framework

| | |
|---|---|
| **Status** | **All five phases done**; see [Phase results](#phase-results). A first plugin consumer (a book Backups page) is the natural next piece of work, and the [Later](#later) list holds what was deliberately deferred. The open questions of the first draft are answered; see [Decisions](#decisions) |
| **Date** | 2026-11-14 |
| **Scope** | Application options: how plugins define, store, edit and read them; the options store, the options dialog and its extension point |
| **Supersedes** | [settings-design.md](settings-design.md). The lifecycle and plugin-facing API carry over; the store moves below the plugin layer |
| **Related** | [storage-engine-redesign.md](storage-engine-redesign.md) ([Configuration tiers](storage-engine-redesign.md#configuration-tiers)), [theming-design.md](theming-design.md), [plugin-creation.md](plugin-creation.md), [todo.md](todo.md) |

- [Summary](#summary)
- [Context](#context)
- [Goals and non-goals](#goals-and-non-goals)
- [Decisions](#decisions)
- [Why options cannot live in app.state](#why-options-cannot-live-in-appstate)
- [Where options live](#where-options-live)
- [Components](#components)
- [Plugin-facing API](#plugin-facing-api)
- [Hierarchical options](#hierarchical-options)
- [Persistence](#persistence)
- [The options dialog](#the-options-dialog)
- [Namespace ownership and trust](#namespace-ownership-and-trust)
- [Appearance: the theme becomes an option](#appearance-the-theme-becomes-an-option)
- [Plugins are not options](#plugins-are-not-options)
- [Key flows](#key-flows)
- [Alternatives considered](#alternatives-considered)
- [Later](#later)
- [Phased implementation plan](#phased-implementation-plan)
- [Phase results](#phase-results)

## Summary

**Plugins own the shape of their options and the pages that edit them. The
shell owns the store, the options dialog, and the edit lifecycle.** This is
the Eclipse preference-page model, with one structural constraint that
decides the design:

> **The shell reads options before it loads plugins, so the option store
> cannot live behind a plugin.**

The store is therefore **shell-owned, plain JSON, read synchronously at
startup** — a sibling of today's
[`tessera-bootstrap.json`](../shell/main/bootstrap/bootstrapConfig.ts) in the
same tier 0. It is in place before `PluginManager` runs, which means:

- `context.options` is part of the `PluginContext`, like `logger` and
  `paths` — not a service a plugin must `require`. **Every** plugin can have
  options, including the storage backends and `app-state`, which activate
  before any options service built on them could exist.
- Values are already in memory, so `register` and `get()` are
  **synchronous**. No `await` to read an option.
- The shell reads its own options at startup, so the theme no longer waits
  for plugin activation.

Plugins register versioned **defaults** (with `migrate` and `validate`) and
contribute **pages** to the `shell.options.pages` extension point; pages form
a hierarchy, as Eclipse preference pages do. The shell hosts them in one
dialog with a uniform draft / Apply / OK / Cancel / Restore Defaults
lifecycle, and **nothing takes effect until the user applies it**.

`app.state` keeps doing what it does today — opaque *state* (window bounds,
recent books, per-window theme overrides) in the `app` database. It is not
the options store.

## Context

The shell knows nothing about any business function, so it cannot know which
options exist. Plugins have very different needs — a default-currency picker,
a category-tree editor, a "test connection" button on a bank importer — and a
declarative form rendered by the shell cannot express the richer ones.
Letting plugins bring their own pages can, and the view loading, error
isolation, theming (`@tessera/ui`) and dialog machinery already exist.

Two things have changed since [settings-design.md](settings-design.md) was
written:

- **The dialog system exists** (`shell.dialogs`, `shell.prompts`), so hosting
  plugin React components in a shell-drawn modal frame is proven, including
  passing props across the federation boundary — which that note listed as a
  missing prerequisite.
- **Tier 0 exists.** `tessera-bootstrap.json` and the *Configuration tiers*
  section of [storage-engine-redesign.md](storage-engine-redesign.md#configuration-tiers)
  establish a shell-owned, pre-plugin JSON configuration file and the rule
  that **configuration never lives behind what it configures**. The options
  store is a second application of that rule, not a new idea.

### Options versus state

| | Application state | Options |
|---|---|---|
| Written by | The plugin, silently | The user, through an options page |
| Shape | Opaque value per key | Plugin-defined JSON with registered defaults, version, validation |
| Examples | Window bounds, recent books, last book, per-window theme override | Application theme, default currency, auto-backup, date format |
| Read | After activation | **At startup, before activation** |
| Lives in | `app.state` → `app` database (tier 1) | The options store (tier 0) |
| Shown in UI | No | Yes, in the options dialog |

Per-book data (accounts, categories) belongs in the book, in neither of
these. Plugin *selection* is neither: see [Plugins are not
options](#plugins-are-not-options).

## Goals and non-goals

**Goals**

- Options are readable by the shell before any plugin activates, and by
  every plugin — including those that activate first.
- Plugins define their own options shape and page UI; the shape may be
  hierarchical (nested objects) and the pages may be hierarchical (a tree).
- One consistent edit experience: draft, validate, apply, cancel, restore
  defaults — identical for every plugin, with no change taking effect before
  the user asks for it.
- Options survive plugin upgrades through versioned migration, and corrupt
  or stale values never prevent startup.
- A plugin can only read and write **its own** options.
- The application theme becomes an option, and its chooser moves into the
  options dialog.

**Non-goals (for now)**

- Per-book scope. Application scope only; the API reserves a `scope`
  argument for later.
- Secrets. Passwords and keys never go in options.
- Managing plugins. Enablement stays tier-0 bootstrap configuration.
- Replacing `app.state`. Opaque, silently-written state stays there.
- Localisation, import/export, syncing between machines. See [Later](#later).

## Decisions

These answer the open questions of the first draft.

| # | Decision | Consequence |
|---|---|---|
| 1 | **The application theme is an option**, and the theme chooser moves into the options dialog | `themeHost.load()` moves *before* `pluginManager.activateAll()`; View ▸ Theme's global items and the separate chooser dialog go away. See [Appearance](#appearance-the-theme-becomes-an-option) |
| 2 | **No live apply.** An edit changes nothing until Apply or OK | Simpler model, no preview hook, no revert-on-cancel machinery. A page may still *show* a preview of its own, as the theme page does |
| 3 | **Namespace ownership is enforced**, not conventional | `context.options` is namespace-bound in the main process; the options IPC validates its sender and requires a dialog session. See [Namespace ownership and trust](#namespace-ownership-and-trust) |
| 4 | **One draft set per dialog session.** Every edit, on every page and in every namespace, stays pending until Cancel, Apply or OK | Moving between pages never commits or discards. No per-page draft branches |
| 5 | **Plugin enablement is not an option** | `tessera-bootstrap.json` and `bootstrapConfig.ts` stay exactly as they are; the options store is a separate tier-0 file. A plugin manager UI is out of scope for this note |
| 6 | Localisation: later | Titles, keywords and messages are English strings for now |
| 7 | Import and export: later | The store is one readable file, so a manual copy already works |

## Why options cannot live in app.state

The first draft of this note led with a circularity: the storage engine is
chosen by an option, and `app.state` needs the storage engine. **Decision 5
withdraws that argument** — engine selection is bootstrap configuration, not
an option. Three reasons remain, and they are enough:

1. **The shell needs options before it activates plugins.** The clearest
   case is the theme. Today [`app.ts`](../shell/main/app.ts) must do
   `await themeHost.load()` *after* `pluginManager.activateAll()`, with the
   comment *"the saved theme is in app-state, which has only now
   activated"*. Every shell concern that wants a user choice before plugins
   inherits that awkwardness, and some cannot tolerate it at all.
2. **An options service above `app.state` cannot serve the plugins below
   it.** `app.state` requires `storage.engine`, so `storage-sqlite`,
   `storage-loki` and `app-state` itself all activate before any such
   service exists. Those plugins could then never expose an option — a hole
   in a framework whose premise is that everything is a plugin. A tier-0
   store has no such floor.
3. **Options should be reachable when the stack below is broken.** If the
   storage engine fails to open its database, the user can still open the
   dialog and change the setting that might fix it. Options that depend on
   storage disappear exactly when they are most needed.

A fourth, smaller point: a plugin-provided service would force every
option-using plugin to add a `requires` entry and make every read `async`,
for a value that is a few bytes of JSON already on disk.

## Where options live

Tier 0 holds two files, with different owners and different writers. They
are siblings, not layers:

| Tier | File / store | Owner | Holds |
|---|---|---|---|
| **0 · Bootstrap** | `<userData>/tessera-bootstrap.json` | shell, unchanged | `disabledPlugins`, `preferredPlugins` — which plugins activate, and in what order |
| **0 · Options** | `<userData>/tessera-options.json` | shell, new | Every user-visible option, one namespace per plugin, plus the shell's own |
| **1 · Application state** | the `app` database through `storage.engine` | `app-state` | Window bounds, recent books, per-window theme overrides, caches |
| **2 · Financial data** | a user-chosen file | book | Accounts, transactions… |

Keeping them apart follows decision 5: the bootstrap file answers *what runs*
and is read by the plugin manager before anything else; the options file
answers *how what runs behaves* and is read by the options service. They
have different shapes, different validation and different audiences, and
merging them would put the plugin manager's input behind a registry of
plugin-registered defaults.

The options store is small by construction — only values that differ from a
registered default are written — so reading it synchronously costs one
`readFileSync` and one `JSON.parse`, exactly as the bootstrap file does
today.

**Core may not import `node:*`** (enforced by `tests/architecture`), so this
follows the established port/adapter split: an `OptionsStore` port in
[core/ports.ts](../core/ports.ts), a JSON-file adapter in `shell/main`, and
the service itself in `core/options/`.

## Components

```
 shell/main (before plugins)                   plugin (renderer remote)
 ───────────────────────────                   ────────────────────────
 const options = new OptionsService(           ./BackupOptionsPage  (React component)
   new JsonOptionsStore(userData))                    ▲
 options.register('shell.appearance', { … })          │ props: value, defaults, onChange,
 themeHost.load()        ◄── no longer waits for      │        onValidityChange, disabled
 pluginManager.activateAll()  plugin activation       │
        │                                             │
        ▼                                             │
 ┌─────────────────────────────────────┐   IPC   ┌────┴──────────────────────────────┐
 │ core: OptionsService                │◄───────►│ shell renderer: options dialog    │
 │  register / get / commit / reset    │         │  nav tree, search, one draft set, │
 │  defaults, migrate, validate, merge │         │  Apply / OK / Cancel / Restore    │
 │  onDidChange                        │         └───────────────────────────────────┘
 └───────────────┬─────────────────────┘
                 │ OptionsStore port
                 ▼
 ┌─────────────────────────────────────┐
 │ shell/main: JsonOptionsStore        │   <userData>/tessera-options.json
 │  readSync / write (atomic) / flush  │   { "book": { version, values }, … }
 └─────────────────────────────────────┘

 plugin (privileged)
 ───────────────────
 context.options.register({ defaults, version, migrate, validate })
 context.extensions.contribute(id, 'shell.options.pages', pageId, { … })
```

| Component | Lives in | Responsibility |
|---|---|---|
| `OptionsStore` | port in [core/ports.ts](../core/ports.ts) | Read the whole document synchronously; write it atomically; flush |
| `JsonOptionsStore` | `shell/main/options/` | The adapter: `tessera-options.json`, temp-file-and-rename, debounced writes, flush on quit |
| `OptionsService` | `core/options/` | Registered defaults, deep merge, versioning, migration, validation, commit, reset, change events |
| `context.options` | `PluginContext` | Each plugin's namespace-bound view; added to [tessera-types/plugins.ts](../tessera-types/plugins.ts) |
| `options:*` IPC | `shell/main` | Lets the dialog list pages, read drafts and commit, under a session |
| Options dialog | `shell/renderer` | Navigation tree, search, page hosting, the draft set and the buttons |
| `shell.options.pages` | extension point | Plugins contribute pages and categories |

## Plugin-facing API

### Registering options (privileged side)

```ts
export function activate(context: PluginContext) {
  const options = context.options.register({
    version: 2,
    defaults: { autoBackup: true, backup: { count: 5, folder: null } },

    // Upgrades stored values written by an older plugin version
    migrate(old, fromVersion) {
      return fromVersion < 2 ? { ...old, backup: { count: old.keepBackups ?? 5, folder: null } } : old
    },

    // Authoritative validation, run on every commit; return error messages
    validate(value) {
      return value.backup.count >= 1 ? [] : ['Keep at least one backup']
    }
  })

  options.get()                                  // merged value, never partial — synchronous
  options.onDidChange((value, previous) => { /* reschedule backups */ })
}
```

```ts
interface OptionsApi {
  // T is unconstrained rather than `T extends Json`: a TypeScript interface has no implicit index signature, so
  // the natural `interface BookOptions { … }` would not satisfy `Json`. Values must still be JSON data.
  register<T>(spec: {
    defaults: T
    version?: number                         // default 1
    migrate?(stored: Json, fromVersion: number): T
    validate?(value: T): string[]
    scope?: 'application'                    // 'book' reserved for later
  }): OptionsHandle<T>
}

interface OptionsHandle<T> {
  get(): T                                   // synchronous: the store is already in memory
  onDidChange(listener: (value: T, previous: T) => void): Disposable
}
```

- A plugin has **one options namespace**: its plugin id, bound by the
  context. There is no namespace argument, so a plugin cannot name
  another's (decision 3). The shell registers its own namespaces
  (`shell.appearance`, …) through the same service.
- `register` is called at most once, from `activate`, and returns
  synchronously. A second call throws, as a duplicate command id does.
- `get()` returns the stored overrides deep-merged over the defaults, so
  keys added in a newer plugin version appear without migration.
- If another plugin needs a value, the owner exposes it through a service —
  the same rule as for the book store.

### Contributing a page

```ts
context.extensions.contribute('book', 'shell.options.pages', 'book.options.backup', {
  id: 'book.options.backup',
  title: 'Backups',
  parent: 'book.options',              // a category, or another page
  module: './BackupOptionsPage',       // exposed by the plugin's renderer remote
  keywords: ['backup', 'autosave'],
  order: 10
})
```

```ts
interface OptionsPageDescriptor {
  id: string             // plugin-prefixed, like every contribution
  title: string
  parent?: string        // page or category id; omitted = top level
  module?: string        // omit for a category-only node
  keywords?: string[]    // matched by the dialog's search, with title
  order?: number         // sorts among siblings; default 0
}
```

- The shell contributes root **categories** (`shell.options.general`,
  `shell.options.appearance`) so plugins have somewhere standard to nest; a
  plugin may also create its own top-level node, as Finance likely will.
- Descriptors are validated like views and menus: wrong shape, duplicate id,
  unknown parent or a parent cycle is skipped and logged (`[options] …`),
  and the rest of the tree still builds.
- A page edits the namespace of the plugin that contributed it. All pages
  from one plugin share one draft (decision 4).

### Writing a page (renderer side)

A page is a default-exported React component in the plugin's remote, built
with `@tessera/ui`, receiving props the way dialog components already do:

```tsx
import type { OptionsPageProps } from '@tessera/types'
import { Checkbox, FormControlLabel } from '@tessera/ui'

export default function BackupOptionsPage({ value, onChange, disabled }: OptionsPageProps<BookOptions>) {
  return (
    <FormControlLabel label="Back up automatically" control={
      <Checkbox disabled={disabled} checked={value.autoBackup}
                onChange={e => onChange({ ...value, autoBackup: e.target.checked })} />
    } />
  )
}
```

```ts
interface OptionsPageProps<T> {
  value: T                                 // the current draft (the whole namespace)
  defaults: T
  onChange(next: T): void                  // replaces the draft
  onValidityChange(valid: boolean): void   // gates Apply and OK; UX only, not authoritative
  disabled: boolean                        // true while a commit is in progress
}
```

Pages never touch the options IPC; the dialog owns the draft and the commit
(decision 3). A page may still call its own plugin's IPC for actions such as
"Test connection".

## Hierarchical options

Hierarchy appears in two independent places, and conflating them is the
classic mistake:

1. **The page tree.** `parent` + `order` on descriptors build the dialog's
   navigation tree, nested arbitrarily deep. Presentation only.
2. **The value shape.** A namespace's value is one JSON document, and nested
   objects are natural (`backup.count` above). Deep merge over defaults means
   a page can edit one branch while other branches keep their values:
   several pages of one plugin typically each edit one branch of the shared
   draft.

Merge rules: objects merge key by key; arrays and scalars replace wholesale.
Replacing arrays wholesale is simple, but means an upgrade can't append
defaults to a user-customised list — accepted, revisitable per key later.

## Persistence

| | |
|---|---|
| File | `<userData>/tessera-options.json` |
| Shape | `{ "<namespace>": { "version": 2, "values": { … } }, … }` |
| What's stored | Only the values that **differ from the defaults** |
| Read | Once, synchronously, at startup, before plugins |
| Merge | Overrides deep-merged over the registered defaults, at `register` |
| Write | Whole file, temp file then rename, debounced, flushed on quit |
| Restore defaults | Delete the namespace's entry |

Storing overrides means new defaults in a plugin update reach every user who
never changed that setting, and the file stays small and readable.

**One file, not one per plugin.** The earlier note put each plugin in its own
file to isolate corruption. Here the file must be read in one synchronous
step before anything else happens, so a directory scan and *n* reads would be
the wrong shape, and one file is what a user or a support article edits by
hand. Corruption is isolated per namespace instead: a namespace whose entry
is malformed falls back to its defaults and is logged, without affecting the
others.

**Failure handling.** None of these prevents startup:

- *Unreadable or malformed file:* logged, copied aside to
  `tessera-options.json.bad` as it is read (while its contents are certainly
  in hand), the original left in place, and **every** namespace uses
  defaults. This matches today's bootstrap behaviour.
- *Malformed namespace entry* (not `{ version, values }`): logged, that
  namespace uses defaults; the entry is replaced at its next commit.
- *Older version:* `migrate` runs at `register`; the upgraded value is
  written back so migration runs once.
- *Newer version than the plugin knows (a downgrade):* values are used
  read-only and never rewritten, with a warning.
- *Fails `validate`:* logged, defaults are used for the session, the stored
  entry is left untouched until the user commits.
- *Plugin not installed, or not yet registered:* its entry is **kept
  verbatim** and written back unchanged. A plugin disabled for one session
  must not lose its options.

## The options dialog

Opened by the command `shell.options.open` (**Tools › Options…**, `Ctrl+,`),
registered by the shell. The dialog is shell renderer UI — a dedicated modal
(MUI `Dialog`, large), not a `shell.dialogs` contribution, because it hosts
remotes from *every* plugin and needs the two-pane layout; it reuses the same
remote-loading and error-boundary machinery.

- **Layout:** navigation tree on the left built from the descriptors, the
  selected page on the right, a search box above the tree filtering by
  `title` and `keywords` (matching pages shown with their ancestors).
  Selecting a category-only node shows its first child.
- **The draft set (decision 4).** Opening the dialog starts one draft set
  covering every namespace. A page's edits go into it and **stay pending
  while the user moves around the tree**; nothing is committed or discarded
  by navigating. A namespace is *dirty* when its draft differs from the
  stored value, and the tree marks dirty pages.
- **Nothing applies early (decision 2).** The running application is
  untouched until Apply or OK, the theme included. A page that wants to show
  the effect of a change renders its own preview.
- **Buttons:** **Apply** commits every dirty namespace and stays open, with
  the draft set carrying on; **OK** applies then closes; **Cancel** discards
  the whole draft set and closes, asking first if anything is dirty (via
  `shell.prompts`); **Restore Defaults** sets the current page's namespace
  draft back to its defaults, which is itself just another pending edit.
- **Commit:** `options:commit` runs each namespace's `validate` in the main
  process. Namespaces commit independently, so one plugin's validation
  failure blocks only its own: the others are saved, the failing pages show
  their messages, and the dialog stays open.
- **Validity:** `onValidityChange(false)` disables Apply and OK until valid
  again — a convenience; main-process `validate` is authoritative.
- **Failed page:** each page has its own error boundary, as views do. A
  crashed page shows an error; the rest of the dialog still works.

## Namespace ownership and trust

Decision 3. Ownership is enforced at three points, strongest first:

1. **The privileged side is airtight.** `context.options` has no namespace
   argument: a plugin's handle is bound to its plugin id when the context is
   built, exactly as `commands` and `events` already are. No plugin can
   read or write another's options from the main process.
2. **The options IPC validates its sender.** `options:*` handlers check that
   the sender is a shell window the application created, which is the
   existing "validate IPC senders" todo applied here first.
3. **Commits need a dialog session.** `shell.options.open` mints a session
   id in the main process and hands it to the dialog host. `options:get`
   and `options:commit` require a live session id, and the session is
   invalidated when the dialog closes. Option writes are therefore possible
   only while the user has the dialog open, through the dialog that opened
   it. Pages receive props, never the session id, and never a channel.

**The honest limit.** A plugin's renderer remote runs in the same page as
the dialog and shares its JavaScript realm, so a determined plugin could dig
the session id out of memory. Within one window this is a bar, not a wall.
Raising it to a wall means rendering the options dialog in its own
`BrowserWindow`, where sender validation becomes decisive — the alternative
the earlier settings note raised. That is the escalation path if plugin
trust becomes a real requirement (it belongs with the broader "plugin trust"
todo); it is not worth the routing and window management today, when every
plugin is bundled.

## Appearance: the theme becomes an option

Decision 1. Today the application-wide theme selection is state in
`app.state`, and it is chosen from **View ▸ Theme** and the **Choose
Theme…** dialog. It satisfies every test for an option in the table above —
a user choice, with a default, shown in the UI — and it is the value the
shell most wants before plugins activate.

**What moves**

| Piece | Today | After |
|---|---|---|
| Application theme selection | `app.state`, `THEME_STATE_KEY` | `shell.appearance` options namespace |
| Per-window override | `app.state`, per window key | Unchanged: it is state, per window, and inherently a quick action |
| The chooser | `ThemeChooser.tsx`, its own dialog, opened by `shell.theme.choose` | The **Appearance** options page, reusing `ThemePreview.tsx` |
| View ▸ Theme global items (Follow System, Light, Dark, Toggle, each theme) | Apply instantly | Removed. One place to choose, one timing |
| View ▸ Theme ▸ This Window | Unchanged | Unchanged |
| `themeHost.load()` | After `pluginManager.activateAll()` | Before it |

**Why the preview matters here.** Decision 2 says nothing applies before
Apply, so the page cannot show the new theme by switching the window to it.
That is what `ThemePreview` already does — render a sample in a candidate
theme — so the existing component becomes the page's centrepiece rather
than being dropped.

**Resolution order.** Plugin-contributed themes are registered by
`shell.themes` during activation, so a selection naming a plugin theme
cannot be resolved at startup. The selection is **data, not a resolved
theme**: the shell applies what it can at once (`system`, `light`, `dark`
and built-in themes), then re-resolves after `activateAll()`, when the full
list exists. Windows are created after `bootstrap()` returns, so in practice
resolution completes before the first window appears; an id no theme claims
falls back to the default with a warning, as it must anyway for an
uninstalled plugin.

**Migration.** On the first start after the upgrade, if `shell.appearance`
has no stored selection and the legacy `app.state` key exists, the value is
imported once and written to the options file. The import can only run after
`app-state` activates, so that one start applies the default theme first and
switches when the import lands; every later start reads it from tier 0.
Losing the setting instead was considered — the storage swap already reset it
once — but a visible one-time flicker is cheaper than a user re-picking their
theme.

## Plugins are not options

Decision 5. Which plugins are enabled, and which are preferred, stay in
`tessera-bootstrap.json`, read by `loadBootstrapConfig` exactly as today.
They are not an options namespace, and this note changes nothing about them.

The reasoning: plugin selection configures *the framework itself* rather
than a plugin's behaviour. It is read by the plugin manager before any
namespace could be registered, it is the one setting whose effect is always
deferred to the next start, and it has no owning plugin to register defaults
or a `validate` for. Routing it through a registry that plugins populate
would invert the layering — the plugin manager's input would depend on the
plugins having loaded.

A plugin manager UI is still worth building: a list of what is installed,
with name, version, origin, and why a plugin was skipped. It needs plugin
metadata in the renderer, enable/disable writing to the bootstrap file, and a
restart prompt — none of which is this framework. It deserves its own design
note, and it may well *appear* as a node in the options dialog's tree when
it exists, as a shell page with its own commit path rather than an options
namespace.

## Key flows

### Startup

1. The shell reads `tessera-options.json` synchronously and builds
   `OptionsService`. Nothing else has happened yet.
2. The shell registers its own namespaces (`shell.appearance`, …) and loads
   the theme, which no longer waits for plugins.
3. `PluginManager` reads `tessera-bootstrap.json` and activates plugins, as
   it does today.
4. Each plugin's `activate` calls `context.options.register(...)`: its entry
   is migrated, validated and merged against the defaults. `get()` is valid
   immediately, synchronously.
5. Plugin themes are now registered, so the theme selection is re-resolved.
6. Plugins contribute pages. The dialog reads the descriptors when it opens.

### Change an option

1. The user opens **Tools › Options…**; a session and a draft set start.
2. They change the theme on the Appearance page — the preview updates, the
   window does not — then move to the Backups page and toggle a checkbox.
   Both edits are pending; both pages show as dirty.
3. They click OK. The dialog sends the draft set to `options:commit` with
   its session id.
4. The service validates each namespace, diffs against the defaults, writes
   the file atomically, and fires `onDidChange` for each.
5. The theme manager applies the new theme; the book plugin reschedules its
   backups; the dialog closes and the session is invalidated.

## Alternatives considered

| Alternative | Why not |
|---|---|
| **Options in `app.state`** | The shell needs options before plugins activate; the plugins below `app.state` (storage backends, `app-state` itself) could never have options; and options must survive a broken storage layer. See [Why options cannot live in app.state](#why-options-cannot-live-in-appstate) |
| **Split: early options in a file, the rest in `app.state`** | Two stores, two merge semantics and two commit paths behind one dialog, with a boundary that moves whenever a plugin needs a value earlier |
| **Merge the options store into `tessera-bootstrap.json`** | Decision 5: plugin selection is not an option. The plugin manager's input would end up behind a registry the plugins populate |
| **One file per plugin** (the earlier note) | The store is read in one synchronous step before plugins; a directory scan plus *n* reads is the wrong shape, and one hand-editable file is friendlier. Corruption is isolated per namespace instead |
| **Options as a service plugins `require`** | A plugin providing it would sit above the plugin manager and above the storage plugins, so the earliest plugins could never have options, and every read would be `async` |
| **Live apply with revert on Cancel** | Decision 2: the user controls when a change takes effect. It also removes a preview/revert hook from every page's contract |
| **Per-page drafts, committed on navigation** | Decision 4: surprising, and it makes Cancel a lie |
| **Declarative schema rendered by the shell** | Uniform and searchable, but can't express a category editor or a "test connection" action. Kept as an optional later convenience |
| **Pages edit options directly through IPC** | Every plugin re-implements apply/cancel, a cancelled dialog could leave half-saved changes, and it would undo decision 3 |

## Later

Deliberately deferred, in rough order of likely value:

- **A plugin manager** with its own design note (see above).
- **Localisation** of page titles, keywords and validation messages
  (decision 6), alongside whatever the rest of the application adopts.
- **Import and export** of the options file, with a way for plugins to opt
  machine-specific keys out (decision 7). The file is already one readable
  JSON document, so copying it works meanwhile.
- **A declarative field form** (`fields: [...]` instead of `module`) for
  plugins with simple needs — a generated page, uniform look, searchable
  field labels.
- **`scope: 'book'`**, per-book options stored in the book.
- **`requiresRestart`** on a descriptor, with a restart prompt. There is no
  consumer today — plugin selection, the obvious one, is not an option — so
  it waits for the first real one, likely a locale setting.
- **The options dialog in its own `BrowserWindow`**, if plugin trust becomes
  a hard requirement.

## Phased implementation plan

Each phase lands independently, is useful on its own, and is testable
without the later ones.

### Phase 1 — The store and the service (no UI)

- `OptionsStore` port in `core/ports.ts`; `JsonOptionsStore` adapter in
  `shell/main/options/` (synchronous read, atomic debounced write, flush on
  quit, `.bad` quarantine).
- `OptionsService` in `core/options/`: `register`, deep merge, versioning,
  `migrate`, `validate`, overrides-only diffing, `onDidChange`, and all the
  failure handling above.
- Built in `app.ts` before `pluginManager`, with one shell namespace
  registered to prove the path.
- Contracts in `@tessera/types`: `OptionsApi`, `OptionsHandle`,
  `OptionsPageDescriptor`, `OptionsPageProps`.
- Tests: merge semantics, migration (up, same, newer/downgrade), malformed
  file and malformed namespace, validation failure, unregistered namespaces
  preserved verbatim, and that nothing in `core/` imports `node:*`.

*Exit criteria:* a hand-edited `tessera-options.json` survives a restart and
reaches a reader, before any plugin activates. `tessera-bootstrap.json` is
untouched.

### Phase 2 — `context.options` and the extension point

- `context.options` on the `PluginContext`, namespace-bound (decision 3,
  point 1), disposed with the plugin; documented in
  [plugin-creation.md](plugin-creation.md).
- `shell.options.pages`: descriptor validation and tree building (parent,
  order, cycles, duplicates), shell root categories.
- `shell.options.open` command, **Tools › Options…** menu item, `Ctrl+,`.
- The dialog frame in the shell renderer: navigation tree from descriptors,
  page area showing the title and a placeholder, Cancel wiring, IPC to list
  descriptors with sender validation (decision 3, point 2).

*Exit criteria:* a plugin registers options and reads them synchronously in
`activate`; the dialog opens and shows the contributed tree; invalid
descriptors are skipped with warnings.

### Phase 3 — Page hosting and the edit lifecycle

The part that makes it real.

- Load page modules from plugin remotes (reusing the dialog component
  loader), pass `OptionsPageProps`, error boundary per page.
- The dialog-wide draft set, dirty tracking and dirty marks in the tree,
  Apply / OK / Cancel / Restore Defaults, unsaved-changes prompt.
- `options:get` / `options:commit` under a dialog session (decision 3,
  point 3); per-namespace validation and error reporting.
- First real consumer, end to end: the **book Backups page**.

*Exit criteria:* a user edits an option on one page, navigates away and
back to find it pending, applies it, and the owning plugin reacts; Cancel
discards everything; a validation failure keeps the dialog open on the
failing page while other namespaces still save.

### Phase 4 — Appearance: the theme moves to options

Decision 1, as its own phase because it touches the theme manager, the
menus and startup order.

- `shell.appearance` namespace; `ThemePersistence` splits — global selection
  to options, per-window override staying in `app.state`.
- `themeHost.load()` moves before `pluginManager.activateAll()`; re-resolve
  after activation for plugin-contributed themes.
- The **Appearance** page, reusing `ThemePreview.tsx`; `ThemeChooser.tsx`
  and `shell.theme.choose` removed, along with View ▸ Theme's global items;
  **This Window** stays.
- One-time import of the legacy `app.state` theme key.

*Exit criteria:* the theme is chosen in the options dialog, previewed before
Apply, applied on Apply, and read from tier 0 at the next start; an existing
user's theme survives the upgrade.

### Phase 5 — Polish

- Search over titles and keywords, with ancestor-preserving filtering.
- `onValidityChange` gating and busy state during commit.
- Keyboard navigation and accessibility (tree focus, labelled pages).
- Restore Defaults confirmation; clear reporting when Apply partially fails.

## Phase results

### Phase 1 — The store and the service

Done. `OptionsStore` port in [core/ports.ts](../core/ports.ts), the JSON adapter in
[shell/main/options/JsonOptionsStore.ts](../shell/main/options/JsonOptionsStore.ts), the service in
[core/options/](../core/options/), and the contracts in [tessera-types/options.ts](../tessera-types/options.ts).
Built in `app.ts` before `pluginManager`, and flushed while shutting down.

Decided while building:

- **`migrate` maps overrides to overrides**, not whole values: it receives the stored partial and its result is
  merged over the defaults and diffed again. This is what the design's own example assumed.
- **A migrated value is written back at `register`**, so a migration runs once rather than at every start. The
  writeback is skipped when validation fails or the entry came from a newer version.
- **An explicit commit over a newer version's entry is allowed**, and logged. "Never rewritten" governs what the
  framework does on a plugin's behalf; refusing the user's own save would look like a broken dialog.
- **`get()` copies in both directions**, so neither a caller nor a mutated defaults object can reach into the
  service's state.
- **`T` is unconstrained** rather than `T extends Json`, so an ordinary `interface` can describe an option value.

### Phase 2 — `context.options` and the extension point

Done. `context.options` is namespace-bound in [core/plugins/PluginContext.ts](../core/plugins/PluginContext.ts);
`shell.options.pages` resolves through
[shared/options/resolveOptionPages.ts](../shared/options/resolveOptionPages.ts); the command, the Tools ▸ Options…
item (`Ctrl+,`), the shell categories and the pages IPC are in
[shell/main/options/registerOptions.ts](../shell/main/options/registerOptions.ts); the frame is
[shell/renderer/options/OptionsDialog.tsx](../shell/renderer/options/OptionsDialog.tsx).

Decided while building:

- **The runtime always has an options service.** `createPluginRuntime` falls back to an in-memory store when the
  shell does not supply one, so `context.options` is never absent and a plugin never has to ask.
- **A registration is disposed with its plugin** (`unregister`), keeping the stored values. A plugin that is
  deactivated and activated again finds its options where it left them.
- **Page ids are owned, not conventional.** A page id must be the contributor's id or start with it, as dialog
  ids are: the id is what other plugins name as a `parent`.
- **The namespace a page edits is its contributor**, never anything the descriptor says.
- **Parents resolve after every contribution is in**, so a page may be contributed before the category it nests
  under — plugins activate in dependency order, not in tree order.
- **Sender validation landed with the first IPC**: only a real window may ask for the page tree. The honest limit
  in [Namespace ownership and trust](#namespace-ownership-and-trust) still applies, and the dialog session
  arrives with the commit path in phase 3.

### Phase 3 — The session, the draft set and page hosting

Done, except the first real consumer (the book Backups page), which moved to the next step so it lands beside the
Appearance page. The edit channels and sessions are in
[shell/main/options/registerOptions.ts](../shell/main/options/registerOptions.ts); the draft set, page hosting and
buttons in [shell/renderer/options/OptionsDialog.tsx](../shell/renderer/options/OptionsDialog.tsx); the value
helpers moved to [shared/options/values.ts](../shared/options/values.ts) so the renderer tracks dirtiness with the
same equality the service commits with.

Decided while building:

- **The open command mints the session** and the `shell:options.open` event carries it, so the dialog never asks
  for one: holding a live session *is* the permission. One session per window; reopening replaces it, closing
  ends it, and every edit channel checks the session against the window the request actually came from.
- **There is no reset IPC.** Restore Defaults sets the draft to the defaults — a pending edit like any other —
  and a committed value that equals the defaults already deletes the stored entry.
- **Drafts are seeded lazily**, one `options:get` per namespace per session, the first time one of its pages is
  shown.
- **A commit answers per namespace** (`{ [namespace]: messages[] }`): what passed is saved and becomes the
  dialog's new baseline, what failed keeps its draft, shows its messages, and OK keeps the dialog open on the
  first failing page.
- **A page whose plugin registered no options** gets a warning panel, not the component: there is no value or
  defaults to give it.
- **The unsaved-changes prompt is a nested MUI dialog**, not `shell.prompts`: the renderer cannot call
  main-process services, and the native round trip would buy nothing.
- **`onValidityChange` gating landed early** (it was listed under phase 4): the props existed, so wiring Apply
  and OK to it cost a dozen lines, tested.
- The renderer test drives the real main-side session, commit and service through the real IPC router, with only
  Electron and the federation loader stood in for.

### Phase 4 — Appearance: the theme moved to options

Done. The shell namespace and the glue are in
[shell/main/theme/appearanceOptions.ts](../shell/main/theme/appearanceOptions.ts); the page is
[shell/renderer/options/AppearancePage.tsx](../shell/renderer/options/AppearancePage.tsx), reusing
`ThemePreview`; `ThemeChooser.tsx`, `shell.theme.choose` and the View ▸ Theme global items are gone, and the menu
that remains is **View ▸ Theme for This Window**. `themeHost.load()` runs before `pluginManager.activateAll()` in
[app.ts](../shell/main/app.ts), and the legacy `app.state` key is imported once after activation.

Decided while building:

- **The namespace is `shell`, not `shell.appearance`.** The framework's own rule — a page edits its contributor's
  namespace — makes the selection the `appearance` *branch* of the shell's one namespace, exactly how a plugin
  with several pages works. The first draft's wording was corrected by its own design.
- **Shell pages are built in**, as shell dialogs are: a module page from `SHELL_CONTRIBUTOR_ID` gets no remote
  entry and resolves against `BUILT_IN_OPTION_PAGES`, so the Appearance *category* simply became the Appearance
  *page*.
- **The option → theme bridge is tolerant, not strict.** It applies a committed selection with `applyGlobal` —
  the same path `loadGlobal` uses at startup — so a selection naming an unregistered theme is kept, shows the
  default with a warning, and resolves itself when the theme's plugin arrives. The strict `setGlobal` would have
  refused it after the option was already stored, leaving the two out of step. `applyGlobal` also never saves,
  so the user's commit is the only write and there is no loop.
- **The option validates shape only** (a theme id and a known mode), never membership of the registered theme
  list: options are read before theme-contributing plugins activate, and must outlive an uninstalled one.
- The old `appStatePersistence.ts` is gone; `createThemeOptionsPersistence` splits the data as the design says —
  global selection in tier 0, per-window overrides in `app.state`.
- The app smoke test now changes the theme the way the dialog does — open a session, commit the option — since
  there is deliberately no command left that does it.

### Phase 5 — Polish

Done, all of it in [OptionsDialog.tsx](../shell/renderer/options/OptionsDialog.tsx) and its tests.

- **Search**, in a field above the tree (focused as the dialog opens), matching titles and keywords. A match
  keeps its ancestors in sight for context and brings its descendants (so a matching category shows its pages); a
  search that hides the selected page moves the selection to the first page still visible, and a pending edit
  survives searching and clearing. An empty result says so.
- **Keyboard navigation**: the arrow keys walk the visible rows, selecting as they go, with Home and End at the
  ends; the selected row carries `aria-current="page"`. A category reached by arrow shows its own panel rather
  than redirecting, so traversal never jumps.
  *(Corrected after the first attempt: the handler hung off the rows, so it only answered once a row had focus —
  and the dialog opens with the focus in the search field, where the user actually is. It now hangs off the
  navigation column, so the arrows work from the search field too, and the focus only follows the selection when
  the keys came from a row. The test that passed over this had focused a row first, proving the implementation
  rather than the path a user takes.)*
- **Enter is the dialog's default action**, OK, as in any desktop dialog — it had no default at all, so Enter did
  nothing. It stands aside for anything that does its own thing with Enter (a button, a link, a multi-line
  field), for a question open over the top (each of which now focuses its safe answer, so Enter means *keep*),
  and while a page reports something unusable.
- **Tab reaches the tree once, not once per page**: a roving `tabIndex` keeps the selected row the only tab stop.
- **Asking for an open dialog again keeps it.** `Ctrl+,` twice used to mint a second session and invalidate the
  first, which stranded the dialog on a session its commits would be refused under and quietly dropped whatever
  was pending; the command now reuses the live session for that window and the dialog is left exactly as it is.
- **A failed save stops talking once the user acts**: editing a namespace clears the messages and the summary
  entry belonging to it, instead of leaving a stale complaint under a value that has since changed.
- **Apply and OK say why they are off** when a page reports something unusable, naming the page.
- **Restore Defaults asks first**, and the confirmation says the restore is still only a pending edit.
- **A partial Apply reports itself**: a banner names what was saved and what was not, the failing pages are
  marked in the tree (`⚠`, coloured, beside the dirty `•`), the dialog lands on the first failing page with its
  messages, and the report clears on the next clean Apply.
- `onValidityChange` gating was already in (it landed with phase 3); nothing more was needed.

With this, every phase of the plan is implemented. What remains around the framework is consumers and the
[Later](#later) list — the book Backups page first, then a plugin manager design note when it is wanted.
