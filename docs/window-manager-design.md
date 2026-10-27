# Design note: the window manager

| | |
|---|---|
| **Status** | Implemented (preferences persist in memory only until `JsonPersistence` lands) |
| **Date** | 2026-10-26 |
| **Scope** | How a window's content is laid out: a central content area with a collapsible, tabbed bar on each side, where plugins put their UI, and how the layout is driven over IPC |
| **Related** | [plugin-creation.md](plugin-creation.md), [settings-design.md](settings-design.md) (persistence), [todo.md](todo.md) ("Slot layouts", "Visibility", "Context menus and toolbars", "Push more shell state", "Events to one window", "Validate IPC senders") |

> **Implementation status.** Implemented: the plugin-facing interfaces live
> in [tessera-types/layout.ts](../tessera-types/layout.ts) and
> [tessera-types/views.ts](../tessera-types/views.ts), the channel names,
> slot ids and defaults in [shared/layout/types.ts](../shared/layout/types.ts),
> the state in
> [core/layout/LayoutService.ts](../core/layout/LayoutService.ts), the shell wiring in
> [shell/main/layout/](../shell/main/layout/) and the frame in
> [shell/renderer/layout/](../shell/renderer/layout/). Still open: the
> `JsonPersistence` adapter (preferences are in memory until then; the
> `LayoutPersistence` port is in place), removing `useSidebarState` from the
> `app-state` plugin, and growing the icon set (a small built-in set ships
> instead of Codicons for now). Where this note and the code disagreed during
> implementation, the note was updated; the deliberate changes are called out
> inline as **implementation notes**. The built-in
> [`plugins/layout.sample/`](../plugins/layout.sample/) exercises every part
> of this design: a view per slot, bar buttons handled in privileged code,
> pushed state, bar items on context keys, and `reveal` switching the page.

- [Summary](#summary)
- [Context](#context)
- [Goals and non-goals](#goals-and-non-goals)
- [Decisions](#decisions)
- [The layout](#the-layout)
- [Components](#components)
- [Extension points](#extension-points)
- [Commands, context keys and menus](#commands-context-keys-and-menus)
- [IPC](#ipc)
- [Persistence](#persistence)
- [Key flows](#key-flows)
- [Alternatives considered](#alternatives-considered)
- [Framework prerequisites](#framework-prerequisites)
- [Open questions](#open-questions)
- [Suggested phases](#suggested-phases)

## Summary

**The shell owns a fixed frame: a main content area with a bar on each of its
four sides. Plugins fill it; they never change its shape.**

- There are five **slots**: `shell.main` in the centre and `shell.top`,
  `shell.bottom`, `shell.left` and `shell.right` around it. Plugins target
  them with the existing `shell.views` extension point, and with a new,
  lighter `shell.bar.items` point for command buttons and status text that
  need no React component. Every bar contribution carries an **icon**.
- A bar is **hidden** (takes no space at all) when nothing targets its slot,
  **collapsed** to a rail of icons when the user has closed it, and
  **expanded** otherwise. An expanded bar shows its views as **tabs**, one
  active at a time, as VS Code's panel does.
- The main area shows **one active view** at a time. Navigation is by
  commands: an item in a bar, or a click in a navigation view, runs a command,
  and the command decides which main view to show.
- The **layout state** is **per window** and lives in the main process, like
  the application phase and the context keys. The main process decides
  everything that shapes the layout, including which contributions are
  present (their `when` expressions), so both sides always agree. The renderer
  mirrors the state: one request for the snapshot, then push events, and
  sends user gestures back as requests. Plugins can drive the same state from
  either side: commands and context keys in privileged code, `window.api` in
  views.
- Sizes, collapsed flags and active tabs are **persisted per window**,
  through the `JsonPersistence` port proposed in
  [settings-design.md](settings-design.md).

## Context

Tessera replaces Microsoft Money Plus, whose window is a navigation column on
the left, the current page in the middle, and bars for summaries and status
around it. Finance plugins will want the same places: an accounts list on the
left that chooses the page in the middle, a calendar or bill reminders on the
right, a toolbar on top, and a status line (open vault, dirty flag, last sync)
at the bottom.

The framework already has most of the pieces:

- `shell.views` contributions name a `slot`, and `<Slot>` renders a slot's
  views, each lazy-loaded and isolated by an error boundary.
- The shell publishes its state to the renderer as snapshot + events, and
  `createRemoteState` mirrors it without races.
- Commands with context-key enablement, and menu items bound to them.

What is missing is a layout that gives slots a place on screen, the rules for
showing and hiding them, and the IPC that lets both sides change the layout.
Because commands run in the main process, a *View › Toggle Left Bar* menu item
is only possible if the main process owns the layout state. That decides the
direction of the design: **main owns, renderer mirrors**.

## Goals and non-goals

**Goals**

- One frame for the whole application: centre plus four bars.
- A bar that has no content is completely hidden, with no rail, splitter or
  empty strip. The welcome text in the centre behaves the same way it does
  today.
- A bar with content can be collapsed and expanded by the user, with the
  mouse, the keyboard and the menu, and by plugins.
- Bars that hold views are tabbed and resizable; sizes, collapsed flags and
  the active tab survive a restart.
- Each window has its own layout.
- Plugins contribute without knowing about each other, through plain data.
- Contributions can be shown and hidden by `when` expressions over context
  keys, the same expressions commands use for enablement.
- Everything observable is also scriptable over IPC.

**Non-goals (for now)**

- A tab strip, split editors or history in the main area. The main area
  shows one view, chosen by commands; tabs can be layered on later without
  changing the contracts here.
- Floating or detachable panels, and dragging a view from one bar to another.
- Plugin-declared slots. The five slots are fixed (see Alternatives).
- Opening secondary windows. The design is per window so that a second
  window needs no change to the contracts, but no command opens one yet.
- Theming and the visual design of bars beyond what the layout needs.

## Decisions

Settled with the project owner after the first draft; recorded here so the
rest of the note can assume them.

| Topic | Decision |
|---|---|
| **Window state** | Each window has its own layout, identified at run time by its Electron window id and persisted under a stable key. Requests are attributed to the sending window by the main process, never by a value the renderer supplies |
| **Rail icons** | Every contribution to a bar names an icon. A collapsed bar shows one icon per view, as VS Code's activity bar does; clicking one expands the bar on that view |
| **Several views in a bar** | Tabbed, as VS Code's panel: one active view, a tab strip, inactive tabs stay mounted once shown |
| **Main-area navigation** | Items and navigation views issue **commands**. A command may show a main view through `shell.layout.reveal`; the shell keeps one active main view per window |
| **Trust** | Any view may execute any command and any layout request, under today's plugin trust model. Revisit with the "plugin trust" todo item |
| **Where `when` is evaluated** | Once, in the main process. The layout snapshot lists the present views and items, and the renderer renders exactly that list. The renderer evaluates nothing that changes the layout's shape |
| **Shortcuts** | VS Code's: `Ctrl+B`, `Ctrl+Alt+B`, `Ctrl+J`. Adjustable later |

## The layout

```
┌──────────────────────────────────────────────────────────────┐
│  File  View  Accounts  Tools  Help              (native menu) │
├──────────────────────────────────────────────────────────────┤
│  shell.top   [ items strip ]                                 │
│              [ ▣ Search  ▣ Filters          ][ collapse ▲ ]  │  tab strip
│              [ active view                                ]  │
├──────────┬───────────────────────────────────────┬───────────┤
│ [items]  │                                       │  ▣        │
│ ▣ Acc..  │              shell.main               │  ▣        │  right bar
│ ▣ Cat..  │           (active main view)          │  ▣        │  collapsed:
│ ────── ◄ │                                       │           │  a rail of
│ active   │                                       │           │  icons
│ view   ║ │                                       │           │  ║ = splitter
├──────────┴───────────────────────────────────────┴───────────┤
│  shell.bottom  [ ▣ Log   ▣ Problems           ][ collapse ▼ ]│
│                [ active view                                ]│
│                [ items strip: Home Vault ·  Unsaved changes ]│
└──────────────────────────────────────────────────────────────┘
```

- The **top and bottom bars span the full width**; the left and right bars
  sit between them. Top and bottom bars are usually toolbars and status
  lines, which read as full-width strips, and a left column that ran under
  the status line would look wrong.
- The **main area** always exists and takes whatever is left.

### Bar states

A bar is in exactly one of three states:

| State | When | What is rendered |
|---|---|---|
| **Hidden** | Nothing targets the slot, or every contribution's `when` is false | Nothing. The grid track is 0 and no element is in the DOM |
| **Collapsed** | The bar has content and the user (or a plugin) collapsed it | A 40 px **rail** along the window edge: one icon per present view, in tab order, the active one highlighted, each with its title as tooltip. Clicking an icon expands the bar on that view. A bar with items but no views shows a single expand icon instead |
| **Expanded** | The bar has content and is not collapsed | The bar's content, and a **splitter** on its inner edge if the bar holds any view |

`hasContent` is computed; `collapsed` is a preference. The preference is kept
while a bar is hidden, so a bar whose only plugin is deactivated and later
reactivated comes back in the state the user left it in.

Collapsing leaves a rail rather than hiding the bar completely so the user can
see that there is something to reopen. Hiding is reserved for "nothing is
there", and the two must look different.

### What a bar contains

Each bar has up to three parts, laid out from the window's edge inward:

| Bar | From the outer edge inward |
|---|---|
| Top | items strip, tab strip, active view |
| Bottom | items strip (on the window's bottom edge, so status text stays there), then above it the tab strip and the active view |
| Left, right | items strip, tab strip, active view, stacked top to bottom |

1. The **items strip**: a single row of buttons and text contributed through
   `shell.bar.items`, content-sized, never scrolling, with `align: 'start' |
   'end'`.
2. The **tab strip**: one tab per present view (icon and title; titles drop
   when the bar is too narrow), the active one marked, and the **collapse
   button** at the end. Present even with a single view, since it carries
   the title and the collapse button.
3. The **active view**: the view whose tab is selected, in its own
   `<section>` with the usual error boundary and loading placeholder.

A part is omitted when empty. A bar with only items is content-sized and has
no splitter (a status bar is as tall as its text). A bar with at least one
view uses its persisted `size` and is resizable.

**Tabs.** One view per bar is active, persisted per window. When the active
view becomes absent (its `when` turned false, or its plugin deactivated), the
first present view in `order` becomes active. A tab that has been shown once
stays mounted but hidden (`display: none`) when another tab is selected, so
its state survives switching; a tab that has never been shown is not loaded.
Collapsing a bar hides the active view the same way.

### The main area

The main area shows the **active main view**, one of the views contributed
to `shell.main`, and the welcome text when none is present. There is no tab
strip: the user navigates by running commands (from bar items, navigation
views, menus or accelerators), and the command chooses the view with
`shell.layout.reveal`. This is the Money model, where the left-hand
navigation picks the page. When no choice has been made, or the chosen view
becomes absent, the first present view in `order` is shown. Main views stay
mounted but hidden once shown, like tabs.

### Sizes and resizing

- `size` is the width (left, right) or height (top, bottom) in CSS pixels,
  used only when the bar is expanded and holds views.
- Defaults: left 260, right 300, top 120, bottom 200. Minimum 100. Maximum
  half of the window in that dimension; a persisted size larger than the
  current window is clamped when rendered, not rewritten.
- The splitter is a `role="separator"` element with `aria-orientation` and
  `aria-valuenow`. Dragging updates the bar locally (a CSS variable) and sends
  one `shell:layout.slot.set` with the final size on pointer-up, so the main
  process is not flooded during a drag. Arrow keys move it by 10 px and send
  each step. Double-click restores the default size.

### Focus and accessibility

- Bars are landmarks: `<header>` (top), `<footer>` (bottom), `<aside>` (left,
  right), each with an `aria-label` ("Left bar"), and the centre is `<main>`.
  Tab strips use `role="tablist"` / `role="tab"`; the active view is the
  `tabpanel`.
- `F6` / `Shift+F6` cycles focus through the visible regions in reading
  order: top, left, main, right, bottom.
- Revealing a view (below) moves focus to its section.

## Components

```
 plugin (privileged)                                   plugin (renderer remote)
 ───────────────────                                   ────────────────────────
 context.extensions.contribute(id, 'shell.views', …)   ./AccountsView  (React component)
 context.extensions.contribute(id, 'shell.bar.items', …)        ▲
 context.commands.execute('shell.layout.reveal', viewId)        │ loaded by the bar or the main area
 context.contextKeys.onDidChange  (shell.layout.* keys)         │
        │                                                       │
        ▼                                                       │
 ┌──────────────────────────────────┐    IPC     ┌──────────────┴─────────────────┐
 │ core: LayoutService              │◄──────────►│ renderer: <WindowManager>      │
 │  state per window, presence of   │ snapshot,  │  <Bar> ×4, <Rail>, <TabStrip>, │
 │  views and items, setSlot,       │ events,    │  <Splitter>, <ItemStrip>,      │
 │  reveal, onDidChange             │ requests   │  <MainArea>                    │
 └───────┬───────────────┬──────────┘            │  useLayout(), catalogues       │
         │ reads         │ persists              └────────────────────────────────┘
         ▼               ▼
  ExtensionRegistry   JsonPersistence (port)
  ContextKeyService   <userData>/state/shell.json
```

| Component | Lives in | Responsibility |
|---|---|---|
| `LayoutState`, `BarItemContribution`, `BarItemDescriptor`, request and event payloads, `LayoutPersistence` | `tessera-types/layout.ts`, `tessera-types/views.ts` | The plugin-facing interfaces, like every other contract in `@tessera/types` |
| Slot ids, channel names, defaults, icon names | `shared/layout/types.ts`, `shared/views/types.ts`, `shared/layout/icons.ts` | Values any process may import |
| `resolveBarItems` | `shared/layout/resolveBarItems.ts` | Validates and orders `shell.bar.items` contributions, like `resolveViews` |
| `LayoutService` | `core/layout/LayoutService.ts` | One `LayoutState` per attached window; computes which views and items are present from contributions and context keys; applies changes; fires `onDidChange` and `onDidReveal`; loads and saves through `JsonPersistence` |
| `IpcMessage.sender` | `tessera-types/ipc.ts`, `core/ipc/IpcRouter.ts`, `shell/main/ipc/bindRouter.ts` | The Electron adapter attributes each request to the window it came from; handlers read `msg.sender.windowId` |
| `registerLayout` | `shell/main/layout/` | Attaches windows to the service, IPC handlers, commands, context keys, the View menu, the push events, focus tracking |
| `<WindowManager>` | `shell/renderer/layout/WindowManager.tsx` | The CSS grid; renders a `<Bar>` per side and `<MainArea>` |
| `<Bar>`, `<Rail>`, `<TabStrip>`, `<Splitter>`, `<ItemStrip>`, `<MainArea>` | `shell/renderer/layout/` | One region: state-dependent rendering and gestures |
| `useLayout()` | `shell/renderer/state/ShellState.tsx` | Mirror of this window's layout, built with `createRemoteState` |
| View and item **catalogues** | `shell/renderer/views/ViewsProvider.tsx` and a sibling `BarItemsProvider` | Descriptors by id (module, remote entry, icon URL), fetched through `shell:views.list` and `shell:bar.items.list`; used to load what the layout lists |

`LayoutService` is platform-free and depends only on the registries and the
persistence port, so it belongs in `core/` and can be tested without Electron.

### Which side decides what

| Decided in the main process (in `LayoutState`) | Derived in the renderer (from mirrored context keys) |
|---|---|
| Which views and items are present in each slot (`when`), and their order | The text of `{key}` placeholders in text items |
| Whether a bar has content, is collapsed, and its size | Transient drag position while resizing |
| The active view of each slot | |
| Whether a button item is enabled (`commands.isEnabled`, carried in its descriptor) | |

The rule: anything that changes the **shape** of the layout is decided once,
in main, and pushed. Only presentation inside a region is derived in the
renderer, because a stale value there is harmless.

> **Implementation note.** The first draft derived button enablement in the
> renderer, but the renderer does not know a command's `enablement`
> expression (only the main process does). So `enabled` is computed in main,
> shipped in the item descriptor, and `shell:bar.items.changed` is
> re-published when a flag actually flips, which keeps this consistent with
> the "evaluate once, in main" decision. A stale flag is still harmless: a
> disabled command refuses to run.

## Extension points

### `shell.views` (existing, extended)

The view contribution gains new slot values, an `icon` and an optional `when`:

```ts
// shared/views/types.ts (values) and tessera-types/views.ts (interfaces)
export const MAIN_SLOT   = 'shell.main'    // unchanged
export const TOP_SLOT    = 'shell.top'
export const BOTTOM_SLOT = 'shell.bottom'
export const LEFT_SLOT   = 'shell.left'
export const RIGHT_SLOT  = 'shell.right'

interface ViewContribution {
  id: string
  title: string          // tab label, rail tooltip, error messages
  slot: string           // one of the five slots above
  module: string         // './AccountsView', exposed by the renderer remote
  icon?: string          // required for bar slots; optional for shell.main (see Icons)
  order?: number         // within the slot; lower first, ties keep registration order
  when?: string          // context-key expression; the view is absent while it is false
}

interface ViewDescriptor {      // what the renderer receives
  id, title, slot, module, pluginId, remoteEntry   // as today
  icon?: string                 // resolved by the main process (see Icons)
  when?: string                 // informational; presence is decided in main
}
```

```js
// An accounts list on the left, shown only while a vault is open
context.extensions.contribute('accounts', 'shell.views', 'accounts.list', {
  id: 'accounts.list', title: 'Accounts', slot: 'shell.left',
  module: './AccountsList', icon: './icons/accounts.svg', when: 'vault.isOpen'
})

// The register page in the main area, chosen by a command (see Navigation)
context.extensions.contribute('accounts', 'shell.views', 'accounts.register', {
  id: 'accounts.register', title: 'Register', slot: 'shell.main',
  module: './Register', when: 'vault.isOpen'
})
```

Rules, in addition to today's:

- **Unknown slots are skipped** with a `[views]` warning. Today an unknown
  slot is accepted and silently never rendered.
- A view in a bar slot **without an `icon`** is skipped with a warning, since
  the rail could not represent it.
- `when` uses the same syntax as command `enablement`
  ([shared/context/when.ts](../shared/context/when.ts)); an invalid
  expression is a validation failure and the view is skipped with a warning.
- An absent view (`when` false) is not loaded. Its plugin code is fetched the
  first time it is shown, as now.
- A bar is hidden when all of its views and items are absent.

### `shell.bar.items` (new)

For things a bar shows directly, without a React component from a remote: a
button that runs a command, or a piece of status text. These are the toolbar
and status-bar entries from the todo list, bound to the same commands and
context keys as menus.

```ts
// shared/layout/types.ts (the name) and tessera-types/layout.ts (the interfaces)
export const BAR_ITEMS_EXTENSION_POINT = 'shell.bar.items'

interface BarItemBase {
  id: string
  slot: 'shell.top' | 'shell.bottom' | 'shell.left' | 'shell.right'   // not shell.main
  icon?: string             // see Icons
  align?: 'start' | 'end'   // default 'start'
  order?: number            // within the slot and alignment; lower first
  when?: string             // absent while false
  tooltip?: string
}

/** A button. Enabled exactly when its command is enabled, like a menu item. */
interface BarButtonItem extends BarItemBase {
  kind: 'button'
  label: string             // hidden when `icon` is set and the bar is narrow; always the accessible name
  command: string
}

/** Text. `{key}` is replaced with the value of that context key ('' when unset). */
interface BarTextItem extends BarItemBase {
  kind: 'text'
  text: string
  command?: string          // optional: clicking the text runs it
}

type BarItemContribution = BarButtonItem | BarTextItem
```

```js
const B = 'shell.bar.items'
context.extensions.contribute('vault', B, 'vault.toolbar.save',
  { kind: 'button', id: 'vault.toolbar.save', slot: 'shell.top', label: 'Save', icon: 'save', command: 'vault.save', tooltip: 'Save the vault (Ctrl+S)' })

context.extensions.contribute('vault', B, 'vault.status.name',
  { kind: 'text', id: 'vault.status.name', slot: 'shell.bottom', text: '{vault.name}', when: 'vault.isOpen', align: 'start' })

context.extensions.contribute('vault', B, 'vault.status.dirty',
  { kind: 'text', id: 'vault.status.dirty', slot: 'shell.bottom', text: 'Unsaved changes', icon: 'circle-filled', when: 'vault.isDirty', align: 'end' })
```

- Items are **plain data** and need no `renderer.entry`, so a plugin with no
  renderer half can still put a button on the toolbar.
- A button's enabled state follows `commands.isEnabled`, computed in the main
  process and carried in the descriptor (see the implementation note above);
  the renderer never calls a disabled command. Clicking sends
  `shell:commands.execute` (see IPC).
- Text interpolation reads the mirrored context keys, so a status item updates
  live without any IPC of its own. Plugins publish the key; the shell renders
  it. This covers the "dynamic labels" need for bars without a template
  language.
- Validation mirrors views: missing fields, an unknown `kind`, `slot:
  'shell.main'`, a duplicate id, an invalid `when` or an invalid icon skip
  the item with a `[layout]` warning.

### Icons

An `icon` is a string in one of two forms:

| Form | Example | Resolved to |
|---|---|---|
| A file in the plugin's renderer folder, starting with `./` | `'./icons/accounts.svg'` | `tessera-plugin://<pluginId>/icons/accounts.svg`, by the main process, like `remoteEntry`. Requires `renderer.entry`; otherwise the contribution is skipped with a warning |
| A name from the shell's icon set | `'save'`, `'calendar'` | The shell's bundled glyph. An unknown name is a validation failure |

The shell ships a built-in set whose names live in
[shared/layout/icons.ts](../shared/layout/icons.ts) (so the main process can
validate contributions) and whose glyphs live in
[shell/renderer/layout/iconGlyphs.ts](../shell/renderer/layout/iconGlyphs.ts).
It starts small; swapping in [Codicons](https://github.com/microsoft/vscode-codicons)
wholesale (MIT, the icons VS Code uses) only means growing those two files and
is on the follow-up list. Plugin files should be monochrome SVGs; the renderer
paints them with CSS `mask-image` and `currentColor`, so icons follow the
theme. The same `icon` is used on the rail, the tab, and for button items; a
main-area view's icon is unused today and reserved for a future tab strip.

### Choosing between the two

| Want to show… | Use |
|---|---|
| A list, a form, a chart, anything interactive | A view (`shell.views`) in a bar slot |
| A button for a command you already have | A `button` item |
| A short status line driven by context keys | A `text` item |
| A page the user works in | A view in `shell.main`, shown by a command |

## Commands, context keys and menus

The shell registers these through its own plugin context, so they are
ordinary commands that plugins can execute and menus can reference. Every
layout command acts on the **focused window** (as `shell.toggleDevTools`
does), falling back to the primary window when none is focused, which is how
a command run from privileged code during startup behaves.

### Commands

| Command | Accelerator | Enablement | Effect |
|---|---|---|---|
| `shell.layout.toggle.left` | `CmdOrCtrl+B` | `shell.layout.left.hasContent` | Collapse or expand the left bar |
| `shell.layout.toggle.right` | `CmdOrCtrl+Alt+B` | `shell.layout.right.hasContent` | Same, right |
| `shell.layout.toggle.top` | — | `shell.layout.top.hasContent` | Same, top |
| `shell.layout.toggle.bottom` | `CmdOrCtrl+J` | `shell.layout.bottom.hasContent` | Same, bottom |
| `shell.layout.collapseAll` | — | — | Collapse every bar that has content |
| `shell.layout.expandAll` | — | — | Expand every bar that has content |
| `shell.layout.reset` | — | — | Default sizes, all bars expanded, first view active everywhere |
| `shell.layout.reveal` | — | — | Argument: a view id. Makes it the active view of its slot; if the slot is a bar, expands the bar; focuses it. No-op with a warning for an unknown or absent view |

The accelerators follow VS Code; they are the shell's to change later.

### Navigation

Menu items cannot pass arguments, and bar items name a command, so a plugin
that wants to open a page registers a command and delegates to `reveal`. The
command is the plugin's seam: it can load data, set context keys, or choose
between several views before revealing one.

```js
context.commands.register('accounts.show', async (accountId) => {
  if (accountId) await selectAccount(accountId)                 // plugin logic first
  await context.commands.execute('shell.layout.reveal', 'accounts.register')
}, { enablement: 'vault.isOpen' })

// A toolbar button, a View-menu item, and a navigation view can all run it
context.extensions.contribute('accounts', 'shell.bar.items', 'accounts.toolbar.show',
  { kind: 'button', id: 'accounts.toolbar.show', slot: 'shell.top', label: 'Accounts', icon: 'list-flat', command: 'accounts.show' })
context.extensions.contribute('accounts', 'shell.menus', 'accounts.show',
  { kind: 'item', id: 'accounts.show', label: '&Accounts', parent: 'shell.view', command: 'accounts.show' })
```

```tsx
// Inside the plugin's AccountsList view (left bar): clicking a row opens the register
onClick={() => window.api.invoke('shell:commands.execute', { id: 'accounts.show', args: [account.id] })}
```

### Context keys

Set by the shell whenever the layout changes, so plugin commands and `when`
expressions can depend on the layout:

| Key | Value | Scope |
|---|---|---|
| `shell.layout.<side>.hasContent` | `true` when the bar has at least one present contribution | Global: presence depends only on contributions and context keys |
| `shell.layout.<side>.collapsed` | The user's preference, even while hidden | The focused window |
| `shell.layout.<side>.visible` | `hasContent && !collapsed` | The focused window |
| `shell.layout.<side>.activeView` | Id of the bar's active view, or unset | The focused window |
| `shell.layout.main.activeView` | Id of the active main view, or unset | The focused window |

`<side>` is `top`, `bottom`, `left` or `right`. Context keys are
application-wide, and so is the native menu's enabled state, so the per-window
keys follow the focused window and are rewritten on `browser-window-focus`.
This lets a plugin write `when: "shell.layout.main.activeView == 'accounts.register'"`
to show a bar item only while a page is open. Privileged code that wants to
follow the layout uses `context.contextKeys.onDidChange`; nothing else is
needed on that side.

### The View menu

A new reserved top-level menu, **`shell.view`** (`&View`), placed after
`File` and before plugin menus, so the bar is `File | View | <plugins> | Tools
| Help`. This adds one id to `RESERVED_TOP_LEVEL_MENUS` in
[shared/menus/types.ts](../shared/menus/types.ts) and one fixed position in
`resolveMenus`. Plugins add their own entries to it, as to `File` and `Tools`;
page-opening commands like `accounts.show` belong here.

```
View
├── Toggle &Left Bar        Ctrl+B         group shell.layout.bars
├── Toggle &Right Bar       Ctrl+Alt+B
├── Toggle &Top Bar
├── Toggle &Bottom Bar      Ctrl+J
├── ────────────────
├── &Expand All Bars                       group shell.layout.all
├── &Collapse All Bars
└── Reset La&yout
```

The labels say *Toggle* because menu labels are static today. When checkbox
items and dynamic labels land (both on the todo list), these become checked
items named *Left Bar*, and this note needs no other change.

## IPC

All channels follow the existing conventions: requests are
`window.api.invoke('shell:…')`, answered with the IPC envelope; events are
`window.api.on('shell:…')`, fire and forget, carrying **absolute values** so
a replay is harmless. The snapshot-then-events pattern from
[plugin-creation.md](plugin-creation.md#events-from-the-backend-to-your-views)
applies: subscribe, request the snapshot, apply what arrived in between.

### Attributing requests to a window

Layout state is per window, and the renderer must not be able to act on
another window's state, so the **main process** identifies the sender:

```ts
// tessera-types/ipc.ts
interface IpcMessage<T = unknown> {
  channel: string
  data: T
  correlationId?: string
  sender?: { windowId: number }     // set by the Electron adapter; absent in tests that call dispatch directly
}

// core/ipc/IpcRouter.ts
dispatch(request: unknown, sender?: IpcMessage['sender']): Promise<IpcResponse>

// shell/main/ipc/bindRouter.ts
ipcMain.handle(INVOKE_CHANNEL, (event, request) =>
  router.dispatch(request, { windowId: BrowserWindow.fromWebContents(event.sender)?.id ?? -1 }))
```

Layout handlers read `msg.sender.windowId` and reject with `BAD_REQUEST` when
it names a window the service has not attached. This is also the first step
of the "validate IPC senders" todo item, and every other handler gets the
same information for free.

Push events are still delivered to every window
([forwardEvents.ts](../shell/main/events/forwardEvents.ts)), so per-window
events carry a `windowId` and the renderer ignores those that are not its
own. Targeted delivery (the "events to one window" todo item) would be an
optimisation with no contract change.

### Types

```ts
// tessera-types/layout.ts
type BarSide = 'top' | 'bottom' | 'left' | 'right'

/** A slot's present content, decided by the main process. */
interface SlotState {
  views: string[]         // ids of the present views, in order (when true, plugin active)
  items: string[]         // ids of the present bar items, in order; always [] for shell.main
  activeView?: string     // one of `views`; absent when `views` is empty
}

interface BarState extends SlotState {
  collapsed: boolean      // preference; persisted
  size: number            // px, width or height, used when expanded with views; persisted
}

interface LayoutState {
  windowId: number        // the window this state belongs to
  main: SlotState
  bars: Record<BarSide, BarState>
}
// A bar has content when views.length + items.length > 0. Not stored, to avoid a second source of truth.

type BarItemDescriptor = BarItemContribution & {
  pluginId: string        // the contributor; used for diagnostics and cleanup
  enabled: boolean        // commands.isEnabled of the item's command; true for plain text
}
// In both descriptors, "./…" icons arrive resolved to tessera-plugin:// URLs
// in the `icon` field itself; shell icon-set names pass through unchanged.
```

The layout state names views and items by id; the **catalogues**
(`shell:views.list`, `shell:bar.items.list`) say how to load and draw them.
The renderer renders the ids the layout lists, looking each up in its
catalogue, and shows the "Loading…" placeholder for an id whose descriptor
has not arrived yet (the catalogue event is in flight).

### Renderer → main (requests)

| Channel | Payload | Reply | Purpose |
|---|---|---|---|
| `shell:layout.get` | — | `LayoutState` | Snapshot for the sending window, at startup |
| `shell:layout.slot.set` | `{ slot: string, activeView?: string, collapsed?: boolean, size?: number }` | `LayoutState` | The user chose a tab, collapsed, expanded or resized. `collapsed` and `size` are rejected for `shell.main`; `size` is clamped to the minimum; `activeView` must be a present view of that slot; `collapsed` on a bar without content is stored as a preference |
| `shell:layout.reset` | — | `LayoutState` | Same as the `shell.layout.reset` command, for this window |
| `shell:layout.reveal` | `{ viewId: string }` | `LayoutState` | Same as the `shell.layout.reveal` command, for this window. The `shell:layout.revealed` event follows. Rejects with `HANDLER_ERROR` for an unknown or absent view |
| `shell:views.list` | — | `ViewDescriptor[]` | Existing. The catalogue of every valid view, present or not, now with `iconUrl` |
| `shell:bar.items.list` | — | `BarItemDescriptor[]` | The catalogue of every valid item. Resolved per request like `shell:views.list` |
| `shell:commands.execute` | `{ id: string, args?: unknown[] }` | the command's result | Runs a command from the renderer. Rejects with `HANDLER_ERROR: Command is disabled: <id>` when disabled |

A malformed payload (unknown `slot`, non-numeric `size`, unknown sender)
rejects with an error naming the problem (`HANDLER_ERROR`; the router reserves
`BAD_REQUEST` for a malformed envelope). Replies carry the whole new
`LayoutState` so the caller can apply it without waiting for the event.

`shell:commands.execute` is new and general: bar buttons and navigation
views need it, and it is the same gap that context menus would otherwise
fill. Any view may run any command, as decided above; the handler logs
`[commands] <windowId> executed <id>` so misuse is at least visible.

### Main → renderer (push events)

| Event | Payload | Sent when |
|---|---|---|
| `shell:layout.changed` | `LayoutState` (with `windowId`) | Anything in that window's state changes: a preference, a size, an active view, or a slot gaining or losing a present contribution because a contribution, a plugin or a context key changed. Other windows ignore it |
| `shell:layout.revealed` | `{ windowId, viewId, slot }` | After a reveal; the renderer scrolls the view's section into view and focuses it |
| `shell:views.changed` | — | Existing. The view catalogue changed; the renderer re-requests it |
| `shell:bar.items.changed` | — | The item catalogue changed; same |
| `shell:contextKeys.changed` | `{ [key]: value \| null }` | Existing. Drives button enablement and `{key}` text in the renderer |

Only changes are published: `LayoutService` compares the new state with the
old, per window, and stays silent when nothing differs, so a context-key
change that touches no `when` expression costs nothing on the wire.

### Who talks to whom

| Actor | Observes | Changes |
|---|---|---|
| The shell's renderer (`<WindowManager>`) | `shell:layout.changed`, the catalogue events, `shell:contextKeys.changed` | `shell:layout.slot.set` on gestures, `shell:commands.execute` on button clicks |
| A plugin view | The same events through `window.api.on`, e.g. to restyle when its bar is narrow | `shell:commands.execute` (navigation), `shell:layout.slot.set` (a "close panel" button in its own view), `shell:layout.reveal` |
| A plugin's privileged code | `shell.layout.*` context keys | `shell.layout.*` commands, e.g. reveal the register after opening a vault |
| A menu item or accelerator | — | `shell.layout.toggle.*` and plugin commands such as `accounts.show` |

The renderer is never the source of truth. If a gesture's request fails, the
bar snaps back to the last known state when the next event or reply arrives,
and the error is logged as `[layout] …` in the window's console.

### Renderer mirror

```ts
// shell/renderer/state/ShellState.tsx, alongside phase and contextKeys
layout: createRemoteState<LayoutState, LayoutState>(bridge, {
  initial: EMPTY_LAYOUT,            // every slot empty, so nothing flashes before the snapshot
  load: LAYOUT_GET,
  event: LAYOUT_CHANGED,
  apply: (current, next) => next.windowId === current.windowId || current.windowId === -1 ? next : current
})

export function useLayout(): LayoutState
export function useBar(side: BarSide): BarState
```

The snapshot reply tells the renderer its own `windowId`; until it arrives,
events are held by `createRemoteState` and applied on top of the reply, which
is where the mismatch filter drops other windows' events.

## Persistence

| | |
|---|---|
| Location | `<userData>/state/shell.json`, key `layout` |
| Shape | `{ "layout": { "windows": { "main": { "main": { "activeView": "accounts.register" }, "bars": { "left": { "collapsed": false, "size": 260, "activeView": "accounts.list" }, … } } } } }` |
| What's stored | Per window key: `collapsed`, `size` and `activeView` per bar, and `activeView` for the main area. Never the present `views` and `items` |
| Write | Through the `JsonPersistence` port: atomic, debounced, flushed from the shell's `onShutDown` and when a window closes |
| Read | When a window is attached, before it loads its page, so the first snapshot is already right. Missing or invalid values fall back to defaults per bar |

**Window keys.** Electron window ids are assigned per session, so they cannot
key persisted state. Each window is created with a stable **layout key**:
`main` for the primary window, and whatever a future "open window" command
chooses for others (say `window-2`). `registerLayout` keeps the
`windowId → key` map; the service and the IPC only ever see window ids. A
window whose key has no saved state starts from the defaults.

This is the state store described in
[settings-design.md](settings-design.md#persistence) under the `shell`
namespace. The `LayoutPersistence` port (load and save by window key) is in
place on `LayoutService`, with full failure handling; until the
`JsonPersistence` adapter exists the service runs in memory, and preferences
last for the session. The `useSidebarState` hook and its `sidebar` key in the
`app-state` plugin are superseded and should be removed.

## Key flows

### Startup

1. `bootstrap()` creates `LayoutService` with the extension registry, the
   context-key service and the persistence adapter.
2. `registerLayout` registers the IPC handlers, the commands, the View menu,
   and subscribes the service's `onDidChange` to publish
   `shell:layout.changed` and rewrite the `shell.layout.*` keys for the
   focused window.
3. Plugins activate and contribute views and items. Each contribution fires
   `extensions.onDidChange`; the service recomputes presence for every
   attached window (none yet).
4. `createWindow` attaches the window under key `main`; the service loads
   its preferences and computes its first state.
5. The window opens. `<WindowManager>` subscribes, requests
   `shell:layout.get`, `shell:views.list` and `shell:bar.items.list`, and
   renders. Bars without content are simply not in the DOM; each bar with
   views shows its persisted active tab.

### The user collapses the left bar

1. Click on the bar's collapse button, `Ctrl+B`, or *View › Toggle Left Bar*.
   The first sends `shell:layout.slot.set { slot: 'shell.left', collapsed: true }`;
   the others run `shell.layout.toggle.left` against the focused window.
2. `LayoutService` updates that window's state and fires `onDidChange`; the
   shell publishes `shell:layout.changed` and sets
   `shell.layout.left.collapsed` and `.visible`.
3. The renderer applies the new state: the left bar becomes a rail of icons.
   Its views stay mounted but hidden. A debounced write persists the
   preference under the window's key.

### The user switches tabs, or clicks a rail icon

1. Click on a tab: `shell:layout.slot.set { slot: 'shell.right', activeView: 'bills.upcoming' }`.
   Click on a rail icon: the same request with `collapsed: false` as well.
2. The state changes; the renderer shows the chosen view (loading it on
   first show) and hides the previous one. The choice is persisted.

### Navigate to a page

1. The user clicks an account in the `accounts.list` view (left bar). The
   view runs `shell:commands.execute { id: 'accounts.show', args: [id] }`.
2. The `accounts.show` handler selects the account in the plugin's own
   state, then executes `shell.layout.reveal` with `'accounts.register'`.
3. The service sets `main.activeView` for the focused window, publishes
   `shell:layout.changed` then `shell:layout.revealed`, and sets
   `shell.layout.main.activeView`. The renderer shows the register and
   focuses it. A toolbar button or a View-menu item bound to the same
   command does exactly the same.

### A plugin's view appears and disappears

1. A vault plugin sets `vault.isOpen = true`. `contextKeys.onDidChange`
   fires; `LayoutService` re-evaluates every `when`, finds the left bar now
   has a present view, and publishes the change to each window. The left bar
   appears, in its persisted collapsed or expanded state, on its persisted
   tab if that view is present, otherwise on the first one.
2. The user closes the vault; `vault.isOpen` is removed. The bar loses its
   last present contribution and is hidden again. If the active main view
   was `accounts.register`, the main area falls back to the first present
   main view, or the welcome text.
3. The plugin is deactivated. Its contributions are disposed,
   `extensions.onDidChange` fires, presence is recomputed the same way.

### Resize

1. Pointer down on the splitter; the bar follows the pointer through a CSS
   variable, with no IPC.
2. Pointer up: `shell:layout.slot.set { slot: 'shell.right', size: 340 }`.
   The reply and the event carry the clamped value, which the renderer
   adopts.

### Window close and quit

Closing a window detaches it: its state is written under its key and
dropped from the service. `onShutDown` flushes any pending write. Nothing in
the layout can veto a quit.

## Alternatives considered

| Alternative | Why not |
|---|---|
| **Renderer-owned layout state** (as `useSidebarState` does today, saved through `app.state`) | Commands run in the main process, so menu items and accelerators could not toggle bars, and plugins could not enable commands on the layout. The renderer would also have to report presence back, making two sources of truth |
| **Renderer evaluates `when`** (main pushes the catalogue, the renderer filters) | Main needs presence anyway for `hasContent` and command enablement; evaluating twice risks a frame where the two disagree. Evaluating once in main and pushing the present ids is the consistent option, chosen above |
| **One layout shared by all windows** | Simpler, but a second window would mirror the first's collapses and tabs, which is never what a user wants from a second window. Per-window costs one `windowId` on the wire and a sender on `IpcMessage`, both useful elsewhere |
| **The renderer supplies its window id** in each request | Any view could then act on another window's layout. The Electron adapter knows the sender; using it is both simpler for views and safer |
| **Plugin-declared slots** (`shell.layout.slots` point) | The frame's shape is the shell's business, and five fixed slots cover the Money-style layouts. Nested or custom regions belong to a view that hosts its own children |
| **Stacked views in a bar** (every view visible, each under a header) | Works for two short lists, collapses under three or more views, and gives the rail nothing to select. Tabs scale and match the rail's one-icon-per-view model |
| **A tab strip in the main area** | Money's model is navigation-driven: the left column picks the page. Tabs would add history and close buttons and their own design; `activeView` per slot already gives a later tab strip its state |
| **Items as views** (a plugin wraps every button in a remote component) | Every plugin with a toolbar button would need a renderer half and a federation build. Declarative items are cheaper, consistent with menus, and get enablement for free |
| **Icons as inline SVG strings** in the contribution | Bloats the contribution data that travels over IPC on every catalogue fetch, and tempts plugins to paste arbitrary markup. Files through the plugin protocol, or names from a set, keep contributions small and safe |
| **A `shell.layout` service** for privileged code | Commands and context keys already give privileged code everything it needs; a service would duplicate them. Revisit if a plugin needs to read sizes |
| **Fully hide a collapsed bar** (no rail) | Indistinguishable from "no content", so the user could not tell whether there is anything to reopen. The rail carries the icons and is the fastest way back |
| **Left and right bars full height**, top and bottom between them | Status and tool bars are conventionally full width; a status line that stops at a sidebar looks broken |

## Framework prerequisites

1. **`IpcMessage.sender`**: `dispatch(request, sender?)` on the router and
   the window id from `bindRouterToElectron`. Small, and the basis of
   per-window state.
2. **`JsonPersistence` port and adapter** ([settings-design.md](settings-design.md)),
   for saving preferences. Not blocking; the service runs in memory without it.
3. **Context keys in the renderer** are already mirrored by
   `ShellStateProvider`; the item strip needs a snapshot hook exported from
   `ShellState.tsx` for enablement and `{key}` text.
4. **`shell:commands.execute`**, a new shell request, for bar buttons and
   navigation views.
5. **A reserved `shell.view` menu**, one change in `shared/menus`.
6. **Icon resolution** in the main process (`iconUrl`, like `remoteEntry`)
   and the bundled Codicons set in the renderer.
7. **Declared extension points** (todo) would let the shell declare
   `shell.bar.items` with a schema. Helpful, not blocking; `resolveBarItems`
   validates in the meantime.

## Open questions

1. **Keys for secondary windows.** `main` is the primary window's key. When
   an "open window" command exists, should a new window copy the primary
   window's preferences as its starting point, or start from the defaults?
   And are keys positional (`window-2`) or named by what the window shows?
2. **Mounted-but-hidden tabs.** Keeping shown tabs mounted makes switching
   instant and preserves state, at the cost of memory and of views that keep
   polling while hidden. Should views be told they are hidden (a prop or a
   `shell:layout.changed` listener is enough) or should there be a cap after
   which the least-recently-used tab is unmounted?
3. **Icon set scope.** Codicons is proposed for consistency with VS Code.
   Should finance-specific glyphs (currency, bank, budget) be added to the
   shell's set so plugins don't each ship near-identical SVGs?
4. **Two plugins, one page.** If two plugins both want the main area on the
   same gesture (an importer finishing while the user navigates), the last
   `reveal` wins. Fine for now; a future tab strip would make this moot.

## Suggested phases

Phases 1–3 are **done**; phase 4 is done except the `JsonPersistence` adapter
and removing `useSidebarState`; phase 5 is open.

1. **Frame and slots:** `tessera-types/layout.ts` and `shared/layout/types.ts`, `IpcMessage.sender`,
   `LayoutService` in memory with one attached window, `registerLayout`
   with `shell:layout.get`, `shell:layout.slot.set`, `shell:layout.changed`,
   the four bars in `<WindowManager>` with hidden, collapsed and expanded
   states, tab strips and rails with icons, the main area's active view,
   presence from contributions only. Tests for the service (state
   transitions, per-window isolation, change detection, active-view
   fallback) and the renderer (a bar with no views renders nothing; a
   collapsed bar renders a rail with one icon per view; only the active tab
   is visible).
2. **Commands, keys and menu:** `shell.layout.*` commands against the
   focused window, context keys with focus tracking, the `shell.view` menu,
   `reveal` and `shell:layout.revealed`, the splitter with keyboard support,
   `F6` region cycling.
3. **`when` and items:** `when` on views evaluated in main, the
   `shell.bar.items` point, `resolveBarItems`, icon resolution,
   `shell:bar.items.list` and `.changed`, `shell:commands.execute`, button
   enablement and `{key}` text.
4. **Persistence and windows:** `JsonPersistence` wiring, window keys,
   attach and detach, load before the window opens, flush on close and
   shutdown, remove `useSidebarState` from `app-state`.
5. **Polish and follow-ups:** checkbox menu items once they exist, targeted
   event delivery, a tab strip for the main area (separate note).
