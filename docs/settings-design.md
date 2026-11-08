# Design note: settings

| | |
|---|---|
| **Status** | Implemented: the settings core, JSON-file persistence, the `shell.settings.pages` extension point (pages the shell draws from `fields`, and pages of a plugin's own), and the Options dialog. The `ledger` plugin is the first user. Per-ledger settings are proposed, not built (see [Proposal: scopes](#proposal-scopes-per-ledger-settings)). Application state, which is not a setting, has its own store, `context.state` ([plugin-creation.md](plugin-creation.md#remembering-application-state)) |
| **Date** | 2026-11-07 (proposed 2026-10-17) |
| **Scope** | Application-wide settings (user preferences): how plugins define, store, edit and read them |
| **Related** | [plugin-creation.md](plugin-creation.md#settings) (how to use it), [storage-engine-redesign.md](storage-engine-redesign.md#configuration-tiers), [todo.md](todo.md) |

- [Summary](#summary)
- [Decisions](#decisions)
- [Context](#context)
- [Components](#components)
- [Plugin-facing API](#plugin-facing-api)
- [Validation](#validation)
- [Persistence](#persistence)
- [The Options dialog](#the-options-dialog)
- [Wire contract](#wire-contract)
- [Key flows](#key-flows)
- [Testing](#testing)
- [Alternatives considered](#alternatives-considered)
- [Open questions](#open-questions)
- [Proposal: scopes (per-ledger settings)](#proposal-scopes-per-ledger-settings)
- [What's next](#whats-next)

## Summary

**Plugins own the shape of their settings, and optionally the UI that edits them. The framework owns persistence,
the Options dialog, and the edit lifecycle.** This is the Eclipse preference model: a preference store per plugin,
and preference pages contributed through an extension point.

- A plugin **registers** a settings namespace with its defaults (`context.settings.register`), and reads the
  current value and hears of changes (with the settings that changed) through the handle it gets back. Any plugin
  may **read** another's settings (`context.settings.read`); changes always go through the settings manager.
- It **contributes pages** to `shell.settings.pages`. A page is either a list of **fields** the shell draws
  (checkbox, number, text, choice), or a **component** from the plugin's renderer remote, loaded like a view or a
  dialog.
- The shell's **Options dialog** (Tools ▸ Options…, `Ctrl+,`) hosts every page in a tree with search. It holds
  the draft, and handles OK, Apply, Cancel and Restore Defaults the same way for every plugin.
- The **core** (`SettingsService`) checks every change, keeps only what differs from the defaults, and writes one
  plain JSON file per namespace under `<userData>/settings/`.

## Decisions

What changed from the proposal, and why.

| # | Decision | Why |
|---|---|---|
| 1 | Settings live in **JSON files the shell keeps**, `<userData>/settings/<namespace>.json`, read before any plugin activates | The later [storage design](storage-engine-redesign.md#configuration-tiers) suggested the `app` database. But `app.state` and `storage.engine` are plugins, and storage plugins may have settings of their own. By the rule "configuration never lives behind what it configures", settings can't sit in that database. Files also make every namespace readable synchronously from `activate`, and a corrupt file costs one namespace only |
| 2 | The service is in **`core/`** behind a `SettingsPersistence` port; the file adapter is in `shell/main` | Settings are framework functionality, not a plugin's: every plugin, the storage plugins included, can use them. Tests run the core against memory persistence |
| 3 | A plugin may register **several namespaces**: its plugin id, and `<pluginId>.<name>` | Answers the proposal's open question 2 (one draft per plugin). Ownership follows the command rule, and is enforced |
| 4 | Pages may be **declarative** (`fields`) as well as components (`module`) | Most settings are a checkbox or a number, and a plugin shouldn't need a renderer for them. Fields also make search and Restore Defaults per page exact. The proposal listed this as "later"; it cost little and the ledger uses it |
| 5 | **Three checks** on every change: the defaults' shape, the pages' fields, and the owner's `validate` | The shape check stops type confusion for every plugin at no cost. Fields give the dialog and the main process the same rules. `validate` is the authority (see [Validation](#validation)) |
| 6 | A commit from the dialog applies **every namespace or none** | Pressing OK once should never leave half the changes saved |
| 7 | Values saved by a **newer version** of a plugin are used but **read-only** | Writing them back in the older shape would lose data. The dialog shows why it can't change them |
| 8 | The **owner may change its own settings** from code (`update`, `reset` on its handle) | Confirmed in review. For example a "Don't ask again" box in one of the plugin's own prompts, or a setting its own view edits. Only the owner has the handle; other plugins can only read (decision 13). It is not a way around the settings manager: it goes through the same `SettingsService.commit` as the dialog, so the same checks (shape, fields, `validate`), the same change event with `changed`, and the same write |
| 9 | Changes are **pushed to every window** (`shell:settings.changed`) | An open dialog stays current when another window or a plugin changes a value. Settings are not secrets (see non-goals), so broadcasting them is fine |
| 10 | Values and defaults are **deep-frozen** | Several readers share one object, and a plugin mutating `get()` would change it for everyone without a change event |
| 11 | The dialog is a **shell component**, opened by an event (as the theme chooser it replaced was), not a `shell.dialogs` contribution | It needs its own Escape and backdrop behaviour (ask before discarding), and it owns no result to hand back |
| 12 | The menu item is **Tools ▸ Options…** with `CmdOrCtrl+,`, below plugins' Tools items and above the developer tools | Microsoft Money's (and Windows') convention. "Preferences…" on a macOS application menu waits for that menu (todo) |
| 13 | **Any plugin may read any namespace, read-only** (`context.settings.read(id)`); **every change goes through the settings manager** | Decided in review (it answered the first proposal's questions on trust and on reading another plugin's settings together). A reader has `get` and `onDidChange` and nothing to write with. The only ways to change a namespace are the Options dialog's commit and the owner's own handle (decision 8), and both go through `SettingsService.commit`, with the owner's checks |
| 14 | **A change event names the settings that changed** (`changed`: keys, dotted paths for nested ones) | Decided in review: the owner acts on what changed without comparing values itself. Sent to the owner, to readers, and to the windows (`shell:settings.changed`) after every OK, Apply, `update` and `reset`; never for a commit that changed nothing |
| 15 | **Live apply is deferred** | Decided in review: not needed now. Changes take effect on OK or Apply; a preview hook can come later (see [What's next](#whats-next)) |
| 16 | **Localisation is not a settings concern** | Decided in review: page titles, field labels and messages will be localised with the rest of the application (todo) |

## Context

The shell knows nothing about any business function, so it can't know which settings exist. Plugins have very
different needs: a currency picker, a category tree editor, a "test connection" button on a bank importer. A
purely declarative form can't express the richer ones; pages of a plugin's own can, with the view loading and
error isolation that already exist. Most settings, though, are a checkbox or a number, and for those a
declarative form is far less work, so both are offered.

The cost of plugin-drawn pages is consistency. The framework keeps the *lifecycle* (draft, validation, apply,
reset, search metadata) so every page behaves the same.

### State versus settings

| | Application state | Settings |
|---|---|---|
| Written by | The plugin, silently | The user, on a settings page (defaults from the plugin), or the plugin for the user |
| Shape | Opaque key/value | Plugin-defined JSON with registered defaults |
| Examples | Recent ledgers, window bounds, layout, theme choice | Reopen the last ledger at start-up, how many recent ledgers to list |
| Shown in UI | No | Yes, in the Options dialog |
| Kept by | `app.state` (the `app-state` plugin, in the `app` database); plugins use their own keys through `context.state` | The shell, as JSON files |

Per-ledger data (accounts, categories) belongs in the ledger, not in either.

### Goals and non-goals

**Goals:** plugins define their own settings and pages; one edit experience (draft, validate, apply, cancel,
restore defaults); settings survive plugin upgrades through versioned migration; a corrupt or invalid file never
prevents startup; plain, human-readable files.

**Non-goals (for now):** per-ledger scope (application scope only; proposed in
[Proposal: scopes](#proposal-scopes-per-ledger-settings)); syncing settings between machines; storing
secrets (passwords and keys never go in settings, which are plain files, and pushed to every window).

## Components

```
 plugin (privileged)                                      plugin (renderer remote, optional)
 ───────────────────                                      ──────────────────────────────────
 context.settings.register({ defaults, validate, … })      ./DisplaySettingsPage (a React component)
 context.extensions.contribute(id,                                  ▲ SettingsPageProps: value, defaults,
   'shell.settings.pages', pageId, { fields | module })            │ onChange, onValidityChange, disabled, errors
        │                                                          │
        ▼                                                          │
 ┌────────────────────────────────────┐   IPC    ┌─────────────────┴───────────────────────────┐
 │ core: SettingsService              │◄────────►│ renderer: SettingsDialog (shell)            │
 │  register / load / commit / pages  │ shell:   │  tree, search, drafts, OK / Apply / Cancel, │
 │  shape, fields, validate, migrate  │ settings.│  Restore Defaults, FieldsPage for `fields`  │
 │  change events, queued writes      │ *        └─────────────────────────────────────────────┘
 └────────────────┬───────────────────┘
                  │ SettingsPersistence (port, core/ports.ts)
                  ▼
 ┌────────────────────────────────────┐
 │ shell/main: JSON files             │  <userData>/settings/<namespace>.json
 │  atomic writes, unreadable → .bad  │
 └────────────────────────────────────┘
```

| Component | Lives in | Responsibility |
|---|---|---|
| Types | [tessera-types/settings.ts](../tessera-types/settings.ts) | `SettingsApi`, `SettingsHandle`, `SettingsReader`, `SettingsDefinition`, `SettingsPageContribution`, `SettingsField`, `SettingsPageProps`, `SettingsRegistry` |
| `SettingsService` | [core/settings/SettingsService.ts](../core/settings/SettingsService.ts) | Namespaces and ownership, load and migration, the three checks, all-or-nothing commits, change events, one write at a time |
| `SettingsPersistence` | port in [core/ports.ts](../core/ports.ts); adapter [shell/main/settings/jsonSettingsPersistence.ts](../shell/main/settings/jsonSettingsPersistence.ts) | One JSON document per namespace; atomic replace; unreadable files set aside |
| `context.settings` | [core/plugins/PluginContext.ts](../core/plugins/PluginContext.ts) | The plugin's scoped view: ids it owns only, disposed on deactivation |
| Values, fields, pages, search | [shared/settings/](../shared/settings/) | Pure functions both processes use: merging over defaults, differences, the shape check, paths; field rules and messages; page resolution; search |
| Shell wiring | [shell/main/settings/registerSettings.ts](../shell/main/settings/registerSettings.ts) | `shell:settings.*` IPC, the `shell.settings.open` command, Tools ▸ Options…, change events, the final flush |
| Options dialog | [shell/renderer/settings/](../shell/renderer/settings/) | `SettingsDialog` (tree, search, drafts, buttons) and `FieldsPage` (the form for `fields`) |

## Plugin-facing API

The guide, with complete examples, is [plugin-creation.md › Settings](plugin-creation.md#settings). In short:

```ts
const settings = context.settings.register<LedgerSettings>({
  defaults: { reopenLast: true, recentLimit: 10 },
  version: 1,                                    // raise it when stored values need migrate
  migrate: (stored, fromVersion) => stored,      // the stored overrides, from an older version
  validate: v => v.recentLimit >= 1 ? [] : ['List at least one recent ledger.']
})

settings.get()                                   // merged over the defaults, never partial, frozen
settings.onDidChange(({ value, previous, changed }) => …)   // changed: ['recentLimit'], dotted paths for nested keys
await settings.update({ reopenLast: false })     // as if the user had; rejects with `problems` when invalid
await settings.reset()
```

- `id` defaults to the plugin id; a plugin may register more namespaces as `<pluginId>.<name>`. Ids are
  lower-case dotted words (`SETTINGS_ID_PATTERN`), because they are file names.
- `register` throws for an id the plugin doesn't own, one already registered, defaults that aren't a JSON object,
  or defaults that fail their own `validate`. Inside `activate`, that rolls the plugin back, like a bad command id.
- Any plugin may **read** any namespace, its own or another's, with `context.settings.read(id)`: `get()` (frozen,
  undefined while the owner hasn't registered it) and `onDidChange`, and nothing to change it with. Changes are the
  user's, in the Options dialog, or the owner's, through its handle; both go through the settings manager.

### Pages

```ts
context.extensions.contribute('ledger', SETTINGS_PAGES_EXTENSION_POINT, 'ledger.settings', {
  id: 'ledger.settings', title: 'Ledger', description: '…', keywords: ['start-up'],
  fields: [
    { kind: 'boolean', key: 'reopenLast', label: 'Reopen the last ledger when Tessera starts' },
    { kind: 'number', key: 'recentLimit', label: 'Recent ledgers to list', min: 1, max: 30, integer: true }
  ]
})
```

| Property | |
|---|---|
| `id`, `title` | Required. The id starts with the contributor's plugin id and a dot |
| `fields` **or** `module` | The shell draws `fields`; `module` names a component the plugin's renderer remote exposes. Neither: a **category**, which lists the pages under it |
| `settings` | The namespace the page edits: one the contributor registered. Default: the plugin id |
| `parent` | Any page's id, the plugin's own or another's; omitted for the top level |
| `description`, `keywords`, `order` | Shown under the title; more search terms; order among siblings |

A field names a `key` in the namespace: a top-level key, or a dotted path into nested objects. Its default must
exist and suit the field (a boolean for a checkbox, a number for a number box, a string for text, one of the
options for a choice). A field that doesn't fit is left out with a warning, and a page left with no fields is
skipped. Kinds and their rules:

| Kind | Options | Rule checked |
|---|---|---|
| `boolean` | | on or off |
| `number` | `min`, `max`, `integer`, `unit` | a finite number in range, whole if `integer` |
| `text` | `placeholder`, `maxLength`, `required` | a string, not blank if `required`, at most `maxLength` |
| `choice` | `options: { value, label, description? }[]` (string or number values; `description` is a line under the option, read out with it) | one of the options |

Pages are resolved by [resolvePages.ts](../shared/settings/resolvePages.ts). Problems are warnings, never
failures: an invalid page is skipped, a page whose parent is unknown (or part of a cycle) is shown at the top
level, and the first of two pages with one id wins.

### A page of the plugin's own

The component gets `SettingsPageProps<T>`: `value` (the draft), `defaults`, `onChange(next)` (replaces the draft),
`onValidityChange(valid)` (disables OK and Apply while false), `disabled` (while applying, or read-only), and
`errors` (what the main process refused last). Pages never call the settings IPC: the dialog does, with the
draft. A page may still call its own plugin's IPC, for a "Test connection" button say. This is the first place
the shell passes props to a plugin component loaded through federation (the todo's "View props and context").

### When settings depend on each other: presets

When numbers only make sense together, offer **presets**, not a field per number: a `choice` whose options each name
a whole, consistent set, with a `description` saying what choosing it means. The import plugin does this for its
matching tolerances (Strict, Balanced, Lenient; see
[import-manager-design.md › Matching tolerances](import-manager-design.md#matching-tolerances)): the setting holds the
preset's name, the plugin maps it to the numbers, and tests hold every preset to the rules that make a set consistent.

### The shell's own pages

The shell contributes pages too, as `pluginId: 'shell'` with a `module` that names a component built into the
renderer ([shell/renderer/settings/builtIns.ts](../shell/renderer/settings/builtIns.ts)), since the shell has no
remote. The first is **Appearance** (`shell.appearance`), which edits the application's theme, the `shell.theme`
setting; the theme manager follows that setting and re-themes every window on OK or Apply. See
[theming-design.md › The Appearance page](theming-design.md#the-appearance-page).

### Opening the dialog

`shell.settings.open` (Tools ▸ Options…, `CmdOrCtrl+,`) opens the dialog in the focused window. With a page id as
its argument it opens at that page, so a plugin's view can offer "Settings…" for its own page
(`LEDGER_SETTINGS_PAGE` is published for that). Asked again while open, it moves to the page and keeps the
user's unapplied changes.

## Validation

Every change, from the dialog or from `update`/`reset`, goes through three checks in the main process, after the
value is merged over the defaults (so keys a change leaves out keep their defaults):

1. **Shape** against the defaults: a key whose default is a number must stay a number, and so on. A default of
   `null` accepts anything; objects are checked key by key; keys the defaults lack are not checked.
2. **Fields** of the pages that edit the namespace: the same rules, and messages, the dialog shows.
3. The owner's **`validate`**: the authority. A `validate` that throws is reported as a problem, not thrown.

What is **loaded** goes through the shape check (a key of the wrong type falls back to its default alone) and
`validate` (a failure means defaults for the session). Fields are not applied on load: pages may be contributed
after `register`, so put rules that matter in `validate`. The ledger does both: its field stops the user typing
31, and its `validate` stops a hand-edited file saying 500.

## Persistence

| | |
|---|---|
| Location | `<userData>/settings/<namespace>.json` |
| Format | `{ "version": 2, "values": { … } }`, pretty-printed |
| What's stored | Only what **differs from the defaults** (objects compared key by key; arrays and scalars whole) |
| Read | Once, before plugins activate (`settings.load()` in `app.ts`); each namespace is checked as it registers |
| Write | After each change, through a temporary file flushed to disk and renamed over the old one. One write at a time; a namespace changed again before its write starts is written once, as it is then. Pending writes finish after the last plugin deactivates |
| Everything at its default | The file is deleted |

Storing overrides means a default changed in a plugin update reaches users who never changed that setting. The
cost (the proposal's open question 5): a key of the defaults can't be *removed* by the user, only changed, so a
list or map the user edits should be an array, or default to `null`.

**Failure handling.** None of these prevents startup, and each is logged with `[settings]`:

| What | Then |
|---|---|
| The file isn't JSON | Renamed to `<id>.json.bad` (so it can be repaired by hand), and the namespace starts at its defaults |
| The document isn't `{ version, values }` | Defaults for the session; the file is left until the user changes something |
| A key has the wrong type | That key falls back to its default; the rest are used |
| The values fail `validate` | Defaults for the session; the file is left until the user changes something |
| Saved by an **older** version | `migrate` runs on load (without one, the values are used as far as they fit); the new version is written with the next change |
| `migrate` throws or returns something that isn't a JSON object | Defaults for the session; the file is left |
| Saved by a **newer** version (a downgrade) | The values are used, **read-only**: the dialog says why, and `update` rejects |
| A write fails | The value stays in effect for the session; the dialog says it couldn't be saved for next time |
| The plugin is no longer installed | Its file is kept and ignored |

## The Options dialog

- **Layout:** the page tree on the left (indented by parent, in `order`), with a search box above it, and the
  selected page on the right: its title, description, any messages, then its fields or component.
- **Search** matches every word of the query against titles, descriptions, keywords, and field labels and help.
  The pages above a match are listed too, greyed, so it is shown where it belongs. Enter goes to the first match.
- **Drafts:** one per namespace, starting from the value in effect. Pages of one namespace share it. A page
  stays mounted once shown, so what a component keeps to itself survives moving between pages.
- **Buttons:**
  - **Apply** commits every namespace whose draft differs, all or none, and keeps the dialog open.
  - **OK** applies, then closes. With nothing changed, it just closes.
  - **Cancel**, Escape, or clicking outside close the dialog, first asking "Discard your changes?" when something
    hasn't been applied.
  - **Restore Defaults** (for the page shown) sets the draft of the page's fields to their defaults, leaving the
    rest of the namespace. On a page of a plugin's own, it restores the whole namespace.
- **Validity:** a field with a problem shows it under the field; a component calls `onValidityChange(false)`.
  Either disables OK and Apply, marks the page in the tree, and, when the page isn't the one shown, puts
  "Correct “Page” to apply" in the footer, which goes there.
- **Refused changes** (the main process found a problem) are shown on every page of the namespace, and the
  dialog moves to the first of them. Editing the namespace clears them.
- **Changes from elsewhere** (another window, a plugin's `update`) replace the draft of a namespace the user
  hasn't touched; one with unapplied changes keeps them.
- **Failures are contained:** a page that fails to load or throws shows "This page could not be displayed." and
  the rest of the dialog works. A read-only namespace shows why, and its controls are disabled.

## Wire contract

In [shared/settings/types.ts](../shared/settings/types.ts):

| Name | Kind | Payload |
|---|---|---|
| `shell:settings.get` | request | → `SettingsCatalogue`: every page (a component page with its plugin's `remoteEntry`), every namespace's value, defaults and `readOnly` |
| `shell:settings.commit` | request | `{ changes: { id, value }[] }` → `SettingsCommitResult`: `{ ok: true, namespaces, saveError? }` or `{ ok: false, errors: { [id]: string[] } }` |
| `shell:settings.open` | push | `{ windowId, page? }`: the window named opens the dialog |
| `shell:settings.changed` | push | `SettingsChanged`: the namespace's snapshot, and `changed`, the settings that changed |

**Who can change settings.** In the plugin API, only the owner (its handle) and the Options dialog can, both
through the settings manager; every other plugin can only read. The commit request itself, like
`shell:commands.execute`, is reachable by any code running in a window, because the main process can't yet tell
the shell's dialog from a plugin's view in the same page (nor stop privileged code, which runs with full Node
access, from calling the IPC router). Each namespace's checks still decide what is saved, and every commit is
logged with the window it came from. Closing that gap is the todo's "Validate IPC senders" and "Plugin trust".

## Key flows

**Startup.** `app.ts` creates the runtime with the JSON persistence, registers the shell's settings wiring,
and calls `runtime.settings.load()` before activating plugins. Each plugin's `register` then finds what was
saved, checks (and migrates) it, and `get()` is right from the first line of `activate`. The ledger reads
`reopenLast` when the app has started.

**Changing a setting.** The user opens Options, goes to Ledger and lowers "Recent ledgers to list". The field
checks it as it is typed. On OK the dialog sends the ledger namespace's draft to `shell:settings.commit`; the
service checks shape, fields and `validate`, applies it, writes `ledger.json`, and fires the change. The ledger's
listener sees `recentLimit` in the event's `changed` and republishes the recent list, so the start view shows
fewer at once, and `shell:settings.changed` tells every window.

**A plugin deactivates.** Its registrations are disposed with its context; the values it saved stay on disk, and
registering again later reads them.

## Testing

| Suite | Covers |
|---|---|
| [tests/shared/settingsValues.test.ts](../tests/shared/settingsValues.test.ts) | JSON checks, merging, differences, the shape check, paths (and prototype keys), freezing |
| [tests/shared/settingsPages.test.ts](../tests/shared/settingsPages.test.ts) | Field definitions and value rules, page resolution (ownership, malformed pages, parents, cycles, order), search |
| [tests/core/settingsService.test.ts](../tests/core/settingsService.test.ts) | Registration rules, every load failure above, migration, read-only, commits all or none, events and what they say changed, reading another namespace, queued and coalesced writes, failed writes |
| [tests/core/pluginContext.test.ts](../tests/core/pluginContext.test.ts) | `context.settings` ownership and disposal; reading another plugin's settings, with nothing to write with |
| [tests/main/settingsPersistence.test.ts](../tests/main/settingsPersistence.test.ts) | The JSON files on a real folder: format, atomic replace, `.bad`, ignored names, from one run to the next |
| [tests/main/registerSettings.test.ts](../tests/main/registerSettings.test.ts) | The IPC, the command and its menu item, change events, the flush on shutdown |
| [tests/main/app.test.ts](../tests/main/app.test.ts) | The composition root: a plugin's page and file, Tools ▸ Options…, opening in the window |
| [tests/renderer/appearancePage.test.tsx](../tests/renderer/appearancePage.test.tsx) | The shell's Appearance page in the dialog, and the theme gallery |
| [tests/renderer/settingsDialog.test.tsx](../tests/renderer/settingsDialog.test.tsx) | The dialog: opening, tree, fields, validity, Restore Defaults, read-only, OK/Apply/Cancel and discarding, refused and unsaved changes, changes from elsewhere, plugin pages (including a real federation remote), search |
| [tests/plugins/ledger/activation.test.ts](../tests/plugins/ledger/activation.test.ts) | The ledger's page, starting without reopening, the recent limit |
| [tests/plugins/settings-inspector/](../tests/plugins/settings-inspector/) | The Settings Inspector against the real service and files: at defaults, matching, edited on disk, missing, unreadable, other files; its dialog |
| [tests/plugins/import/settings.test.ts](../tests/plugins/import/settings.test.ts) | The import's page: a matching preset, never a number; importing under each preset; proposals re-scored when it changes |

### Checking it by hand

**Tools › Settings Inspector…**, from the bundled `settings-inspector` plugin, is the way to see the settings
working in the running app. For every registered namespace it shows what plugins read, its defaults, and its file
in `<userData>/settings` exactly as on disk (Windows: `%APPDATA%\tessera\settings`), and checks that the file merged
over the defaults is what is in effect. It re-implements the merge rule on purpose, as a second witness. It also lists
files no namespace reads (a plugin that isn't installed, and files set aside as `.bad`). It only reads, through
`context.settings.snapshots()` and the disk.

A namespace at its defaults has **no file**, by design, so an empty folder after a fresh start is expected. To see a
file appear: Tools › Options… › Ledger, untick *Reopen the last ledger*, OK; `ledger.json` holds
`{ "version": 1, "values": { "reopenLast": false } }`, and the inspector says *Matches its file*. Tick it again and the
file goes.

## Alternatives considered

| Alternative | Why not (as the only mechanism) |
|---|---|
| **Declarative fields only** | Uniform and searchable, but can't express a category editor or a "test connection" action. Kept, alongside pages of a plugin's own |
| **Pages edit settings directly through IPC** | Every plugin would re-implement apply and cancel, and a cancelled dialog could leave half-saved changes |
| **One shared `settings.json`** | A corrupt entry could take down every plugin's settings, and writes would contend. One file per namespace isolates failures |
| **Storing full values, not overrides** | New defaults in plugin updates would never reach existing users |
| **Settings in the `app` database (`app.state`)** | See decision 1: storage is a plugin, so settings there couldn't configure storage, and couldn't be read before it activates |
| **The dialog as a `shell.dialogs` contribution** | See decision 11 |
| **Debounced writes** | Changes come from OK and Apply, or a plugin's deliberate `update`, not from every keystroke. Writing at once, one at a time, is simpler, and a crash can lose only the write under way (the rename leaves the old file or the new one) |

## Open questions

Trust, reading another plugin's settings, live apply and localisation were decided in review (decisions 13 to 16).

1. **Import and export** of settings (moving machines): the folder can be copied, but should plugins be able to
   opt keys out (machine-specific paths)?
2. **Enforcing "writes only through the dialog" in the renderer**, once IPC senders can be told apart (see
   [Who can change settings](#wire-contract)).

## Proposal: scopes (per-ledger settings)

| | |
|---|---|
| **Status** | Proposed, not built. For review |
| **Date** | 2026-11-08 |
| **Builds on** | Everything above; the `ledger` plugin ([account-manager-design.md](account-manager-design.md#the-ledger)) |

### The problem

Some settings should differ by **context**: a business ledger whose bank posts late wants Lenient matching, the
household ledger Balanced. Today every setting is application-wide. The question is how a plugin's settings can vary
by context, generally, without the framework knowing what a ledger is.

Two different needs hide behind "sub-groups of settings", and this proposal is about the first:

| | Example | What it is | Where it belongs |
|---|---|---|---|
| **The same settings, varying by context** | Matching is Strict in this ledger, Balanced elsewhere | One shape, and which value applies depends on what is open | **Scopes**, this proposal |
| **A collection the user manages** | Import rules per account; named CSV layouts | Entries the user adds, renames and removes | Usually the ledger's own data (a plugin's collections, `ledger.schema`); a settings field kind for lists later, if settings need one |

### The idea: layers of overrides

A setting's **effective value** is resolved through a chain of layers, most specific last, as Eclipse resolves
preferences through its scopes and VS Code resolves user, workspace and folder settings:

```
defaults  ←  application  ←  ledger        (←  later: more layers)
(register)   (settings/*.json) (inside the open ledger file)
```

Each layer stores only what it overrides, as the application layer already does (`diffFromDefaults`), and the
merge is the one the application layer uses today (`mergeOverDefaults`): objects key by key, everything else whole.

### Why not sub-groups in the application's files

Storing `{ byLedger: { "<ledger id>": { … } } }` in `settings/import.json` would be quick, but wrong for ledgers:

- **The settings wouldn't travel with the ledger.** Copy it to another computer, or restore it from a backup, and
  they're gone. A ledger's settings belong inside the ledger.
- **Entries for ledgers that were deleted or moved would accumulate** in the application's files for ever.
- **The framework would have to know what a ledger is.** The core is business-agnostic; a plugin has to tell it.

### Scopes are provided by plugins

A **scope** is a layer some plugin owns: it says when the layer exists (a ledger is open), stores its overrides, and
names it for the user. The `ledger` plugin provides the `ledger` scope; the core knows only that some scope is active.
A scope is behaviour, not data, so it is provided through `context.settings` rather than an extension point:

```ts
// The ledger plugin (sketch)
const scope = context.settings.provideScope({
  id: 'ledger',                                   // owned, like a namespace: the plugin id or <pluginId>.<name>
  label: 'This ledger',
  save: (namespace, document) => writeToLedger(namespace, document)   // document undefined: remove the overrides
})
session.onDidChange(async change => {
  if (change.type === 'opened') scope.open({
    detail: change.ledger.name,                   // "This ledger: Home Finances"
    readOnly: change.ledger.readOnly ? 'The ledger is open read-only.' : undefined,
    documents: await readAllFromLedger()          // { [namespace]: { version, values } }
  })
  else scope.close()
})
context.subscriptions.push(scope)
```

- **Opening reads everything at once**, so `get()` stays synchronous: the provider hands the core every stored
  document when the scope opens; the core checks and migrates each as it does for the application's files (the same
  failure rules: see [Persistence](#persistence)).
- **Saving goes back to the provider.** The ledger keeps one document per namespace in a collection of its own
  format (`ledger.settings`, beside `ledger.subledgers`), written in the ledger's own transaction.
- **Closing drops the layer.** Values fall back to the application layer, and listeners hear of it.
- One ledger is open at a time, so there is one active `ledger` scope at a time; the design doesn't need more.

### Namespaces opt in

Not every setting makes sense per ledger: "reopen the last ledger" is needed before any ledger is open. A namespace
says which scopes may override it:

```ts
const settings = context.settings.register({
  id: 'import.matching',                          // a namespace of its own, so only it is per ledger
  defaults: { preset: 'balanced' },
  scopes: ['ledger']                              // may be overridden in the ledger scope; default: none
})
```

The opt-in is **per namespace**, not per key: a plugin that wants some keys per ledger and others not already splits
them into namespaces (`import`, `import.matching`). Per key can come later if it is needed.

### What plugins see

| | Today | With scopes |
|---|---|---|
| `get()` | Defaults ← application | The effective value: defaults ← application ← every active scope the namespace allows |
| `onDidChange` | After a change | Also when a scope opens, closes or changes, whenever the **effective** value changes; `changed` says which settings moved (switching to a ledger that overrides nothing fires nothing) |
| `update(patch)`, `reset()` | Write the application layer | The same by default; `update(patch, { scope: 'ledger' })` writes that layer while it is open |
| `inspect()` (new) | | Each layer's overrides and the effective value, for a plugin that wants to say where a value comes from |
| `context.settings.read(id)` | Effective value | Effective value |

Plugins that don't opt in see no difference.

### Validation

The three checks (shape, fields, `validate`) run on **effective values**. A change to a layer is checked as the
effective value it would give, with the layers below as they are. Two cases need rules:

- **A ledger whose overrides no longer fit** (an older version of the plugin saved them, or the application layer
  changed under them): that namespace's ledger layer is ignored for the session, with a warning, and the dialog says
  so. As for the application's files, nothing stops anything opening.
- **An application change that would make an open ledger's effective value invalid**: refused, with the ledger's
  name in the message. (Ledgers that aren't open are checked when they open, by the rule above.)

### The Options dialog

- A page whose namespace allows a scope that is **active** gains a switcher at the top: **All ledgers** (the
  application layer) | **This ledger: Home Finances**. Pages that don't opt in look as they do today.
- In a scope's view, each field shows its effective value; an **overridden** field is marked, with **Use the
  application value** beside it (removing that key from the layer). In the application's view, a field the open ledger
  overrides says so, so a change that seems not to take effect is explained.
- **Restore Defaults** in a scope's view removes the page's keys from that layer.
- Drafts are kept **per namespace and layer**; Apply commits every changed layer of every namespace, all or none.
- A read-only scope (a ledger open read-only) is shown, with the reason, and can't be edited.
- A plugin's own page (`module`) receives the selected layer and what it inherits (`SettingsPageProps` gains `scope`
  and `inherited`); it edits the layer's effective value, and the dialog stores only what differs from `inherited`.

The wire contract grows accordingly: the catalogue lists the active scopes and each namespace's layers, and a
commit's changes name their layer (`{ id, scope?, value }`).

### Trust

A ledger file may come from someone else. What its `ledger.settings` collection holds is **untrusted input**: it is
checked like any stored value, but a namespace that opts into the ledger scope must also be **safe to take from a
stranger's file**. A matching preset is; a folder to run an importer from, or anything that reaches beyond how this
ledger's own data is treated, is not. VS Code has the same rule for workspace settings. The framework can't judge
this for a plugin; the plugin guide would say it plainly, and `scopes` is opt-in per namespace for that reason.

### Alternatives considered

| Alternative | Why not |
|---|---|
| Sub-groups keyed by ledger in the application's files | Doesn't travel with the ledger, accumulates orphans, and the core would need to know about ledgers (see above) |
| Each plugin keeps its own per-ledger options as ledger data | Works today with no framework change, but every plugin would redo inheritance, validation and the dialog, differently |
| Scopes as an extension point of plain data | A scope has behaviour (storage, opening and closing), which in Tessera is a service or an API, not a contribution |
| Per-key scope opt-in from the start | More flexible, more to build and show; per namespace covers the first uses, and splitting a namespace is cheap |

### Open questions

1. **Per namespace or per key?** Per namespace is proposed. Revisit if a plugin ends up with many tiny namespaces.
2. **Trust, enforced or explained?** Proposed: explained, with opt-in per namespace. Should the user also be told when
   a ledger from elsewhere opens with settings in it ("This ledger changes 2 settings")?
3. **Resource scopes.** Settings per sub-ledger or per account would not be an *active* layer (many sub-ledgers are
   "open" at once); they need a lookup for a given resource, `get({ for: subLedgerId })`, like VS Code's resource
   scope. Proposed: not in the first version; the chain allows a layer to be added later.
4. **Which layer the owner's `update` writes by default** when a scope is active: the application (proposed, so code
   written today keeps its meaning), or the most specific active layer?
5. **Moving a value between layers** ("make this the default for all ledgers") in the dialog: useful, or confusing?

### Phases

1. **Core:** `provideScope`, `scopes` on `register`, the resolution chain, opening and closing with change events,
   checking and migrating a scope's documents, `update(…, { scope })`, `inspect()`. Tested with a fake scope, as the
   application layer is tested with memory persistence.
2. **The ledger provides the `ledger` scope:** the `ledger.settings` collection, read-only ledgers, opening and
   closing with the session.
3. **The Options dialog:** the switcher, override marks and "Use the application value", drafts per layer, the wire
   contract, and the new props for a plugin's own page.
4. **First user:** the import's matching preset per ledger (moved to an `import.matching` namespace, keeping what
   users chose), safe from a stranger's file since it names a preset.
5. **Later, if needed:** resource scopes (sub-ledger, account), per-key opt-in, and a settings field kind for lists.

## What's next

- **Per-ledger settings**, as layers of overrides that plugins provide: see
  [Proposal: scopes](#proposal-scopes-per-ledger-settings).
- **Live apply** (deferred): settings that take effect as the user edits (the theme, say), with Cancel reverting.
  It needs a preview hook beyond the draft model.
- **More field kinds** as plugins need them: a folder with Browse…, a list of strings.
- **A macOS application menu** with "Preferences…" running `shell.settings.open`.
