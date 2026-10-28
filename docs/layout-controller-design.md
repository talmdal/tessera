# Design note: the layout controller

| | |
|---|---|
| **Status** | Phases 1–4 implemented (frame and slots, commands, context keys and the View menu, `when` and bar items, persistence through `app-state`); phase 5 is open |
| **Date** | 2026-10-27 |
| **Scope** | The layout controller: the component that owns how a window's content is arranged (a central content area with a collapsible, tabbed bar on each side), where plugins put their UI, and how the layout is driven over IPC |
| **Related** | [plugin-creation.md](plugin-creation.md), [storage-api-design.md](storage-api-design.md) (what backs `app.state`), [todo.md](todo.md) ("Slot layouts", "Visibility", "Context menus and toolbars", "Push more shell state", "Events to one window", "Validate IPC senders") |

> **Naming.** This note replaces the earlier "window manager" framing. The
> shell does not manage windows (creating, moving, stacking them is
> Electron's job); it **controls the layout inside a window**. The component
> that does so is the **layout controller**: `LayoutService` in the main
> process, which holds the state and applies every change, and
> `<LayoutController>` in the renderer, which mirrors the state and turns
> user gestures into requests. "Window" below always means an application
> window that *has* a layout.

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
four sides. The layout controller fills it from plugin contributions; plugins
never change its shape.**

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
  and the command asks the controller to show a main view.
- The **layout state** is **per window** and lives in the main process, like
  the application phase and the context keys. The controller decides
  everything that shapes the layout, including which contributions are
  present (their `when` expressions), so both sides always agree. The
  renderer mirrors the state: one request for the snapshot, then push events,
  and sends user gestures back as requests. Plugins can drive the controller
  from either side: commands and context keys in privileged code,
  `window.api` in views.
- Sizes, collapsed flags and active tabs are **persisted per window**,
  through the existing `app-state` plugin (its `app.state` service).

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

What is missing is a controller that gives slots a place on screen, decides
when they are shown and hidden, and exposes IPC so both sides can change the
layout. Because commands run in the main process, a *View › Toggle Left Bar*
menu item is only possible if the main process owns the layout state. That
decides the direction of the design: **the controller lives in main, the
renderer mirrors it**.

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

- A tab strip or split editors in the main area. The main area shows one
  view, chosen by commands; tabs can be layered on later without changing the
  contracts here.
- Back and next buttons for the main area. They are wanted, but not in the
  first cut. They need only a per-window history of revealed main views in the
  controller and two commands (`shell.layout.back`, `shell.layout.forward`)
  that re-activate an earlier entry; no contract in this note changes.
- Floating or detachable panels, and dragging a view from one bar to another.
- Plugin-declared slots. The five slots are fixed (see Alternatives).
- Creating, positioning or stacking application windows. That stays with
  Electron; the controller only manages what is inside a window. No command
  opens a second window yet, though the design is per window so that one
  needs no change to the contracts.
- Theming and the visual design of bars beyond what the layout needs.

## Decisions

Settled with the project owner after the first draft; recorded here so the
rest of the note can assume them.

| Topic | Decision |
|---|---|
| **Layout per window** | Each window has its own layout, identified at run time by its Electron window id and persisted under a stable key. Requests are attributed to the sending window by the main process, never by a value the renderer supplies |
| **Rail icons** | Every contribution to a bar names an icon. A collapsed bar shows one icon per view, as VS Code's activity bar does; clicking one expands the bar on that view |
| **Several views in a bar** | Tabbed, as VS Code's panel: one active view, a tab strip, inactive tabs stay mounted once shown |
| **Main-area navigation** | Items and navigation views issue **commands**. A command may show a main view through `shell.layout.reveal`; the controller keeps one active main view per window |
| **Trust** | Any view may execute any command and any layout request, under today's plugin trust model. Revisit with the "plugin trust" todo item |
| **Where `when` is evaluated** | Once, in the controller in the main process. The layout snapshot lists the present views and items, and the renderer renders exactly that list. The renderer evaluates nothing that changes the layout's shape |
| **Shortcuts** | VS Code's: `Ctrl+B`, `Ctrl+Alt+B`, `Ctrl+J`. Adjustable later |
| **Secondary windows** | A new window starts from the **current** layout state of the `main` window (collapsed flags, sizes, active views), not from the defaults. The accounting UI is not expected to need a second window, so this is flexibility, not a feature to build now |
| **Hidden views** | A view that is mounted but hidden (an inactive tab, a collapsed bar) must not poll. It keeps receiving push events, so it stays current and is correct the moment it is shown again |
| **Icon set** | The shell's icon names are [MUI](https://mui.com/material-ui/material-icons/) icons (`@mui/icons-material`), matching the long-range plan to use MUI for components |
| **Main-area contents** | Only the active view is shown. Back and next buttons to step through previously active main views are wanted later; the controller keeps a per-window history of revealed views to support them (see Non-goals) |

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

The controller puts each bar in exactly one of three states:

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
controller makes the first present view in `order` active. A tab that has been
shown once stays mounted but hidden (`display: none`) when another tab is
selected, so its state survives switching; a tab that has never been shown is
not loaded. Collapsing a bar hides the active view the same way.

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

The layout controller has two halves that share one contract:

- **`LayoutService`** (main process, platform-free) is the controller proper.
  It owns the state and is the only thing that changes it.
- **`<LayoutController>`** (renderer) is the controller's view. It holds no
  authority; it mirrors the state, draws it, and reports gestures.

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
 │ core: LayoutService (controller) │◄──────────►│ renderer: <LayoutController>   │
 │  state per window, presence of   │ snapshot,  │  <Bar> ×4, <Rail>, <TabStrip>, │
 │  views and items, setSlot,       │ events,    │  <Splitter>, <ItemStrip>,      │
 │  reveal, onDidChange             │ requests   │  <MainArea>                    │
 └───────┬───────────────┬──────────┘            │  useLayout(), catalogues       │
         │ reads         │ persists              └────────────────────────────────┘
         ▼               ▼
  ExtensionRegistry   LayoutPersistence (port)
  ContextKeyService     └─ adapter → app.state service (app-state plugin)
```

| Component | Lives in | Responsibility |
|---|---|---|
| `LayoutState`, `BarItemContribution`, `BarItemDescriptor`, request and event payloads, `LayoutPersistence` | `tessera-types/layout.ts`, `tessera-types/views.ts` | The plugin-facing interfaces, like every other contract in `@tessera/types` |
| Slot ids, channel names, defaults, icon names | `shared/layout/types.ts`, `shared/views/types.ts`, `shared/layout/icons.ts` | Values any process may import |
| `resolveBarItems` | `shared/layout/resolveBarItems.ts` | Validates and orders `shell.bar.items` contributions, like `resolveViews` |
| `LayoutService` | `core/layout/LayoutService.ts` | The controller. One `LayoutState` per attached window; computes which views and items are present from contributions and context keys; applies changes; fires `onDidChange` and `onDidReveal`; loads and saves through the `LayoutPersistence` port |
| `IpcMessage.sender` | `tessera-types/ipc.ts`, `core/ipc/IpcRouter.ts`, `shell/main/ipc/bindRouter.ts` | The Electron adapter attributes each request to the window it came from; handlers read `msg.sender.windowId` |
| `registerLayout` | `shell/main/layout/` | Connects the controller to the shell: attaches windows to the service, IPC handlers, commands, context keys, the View menu, the push events, focus tracking |
| `<LayoutController>` | `shell/renderer/layout/LayoutController.tsx` | The CSS grid; renders a `<Bar>` per side and `<MainArea>` |
| `<Bar>`, `<Rail>`, `<TabStrip>`, `<Splitter>`, `<ItemStrip>`, `<MainArea>` | `shell/renderer/layout/` | One region: state-dependent rendering and gestures |
| `useLayout()` | `shell/renderer/state/ShellState.tsx` | Mirror of this window's layout, built with `createRemoteState` |
| View and item **catalogues** | `shell/renderer/views/ViewsProvider.tsx` and a sibling `BarItemsProvider` | Descriptors by id (module, remote entry, icon URL), fetched through `shell:views.list` and `shell:bar.items.list`; used to load what the layout lists |

`LayoutService` is platform-free and depends only on the registries and the
persistence port, so it belongs in `core/` and can be tested without Electron.

### Which side decides what

| Decided by the controller in the main process (in `LayoutState`) | Derived in the renderer (from mirrored context keys) |
|---|---|
| Which views and items are present in each slot (`when`), and their order | The text of `{key}` placeholders in text items |
| Whether a bar has content, is collapsed, and its size | Transient drag position while resizing |
| The active view of each slot | |
| Whether a button item is enabled (`commands.isEnabled`, carried in its descriptor) | |

The rule: anything that changes the **shape** of the layout is decided once,
by the controller, and pushed. Only presentation inside a region is derived in
the renderer, because a stale value there is harmless.

> **Note on button enablement.** The renderer does not know a command's
> `enablement` expression (only the main process does), so `enabled` is
> computed by the controller, shipped in the item descriptor, and
> `shell:bar.items.changed` is re-published when a flag actually flips. This
> is consistent with "evaluate once, in main". A stale flag is harmless: a
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
  when?: string                 // informational; presence is decided by the controller
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
  { kind: 'button', id: 'vault.toolbar.save', slot: 'shell.top', label: 'Save', icon: 'Save', command: 'vault.save', tooltip: 'Save the vault (Ctrl+S)' })

context.extensions.contribute('vault', B, 'vault.status.name',
  { kind: 'text', id: 'vault.status.name', slot: 'shell.bottom', text: '{vault.name}', when: 'vault.isOpen', align: 'start' })

context.extensions.contribute('vault', B, 'vault.status.dirty',
  { kind: 'text', id: 'vault.status.dirty', slot: 'shell.bottom', text: 'Unsaved changes', icon: 'Circle', when: 'vault.isDirty', align: 'end' })
```

- Items are **plain data** and need no `renderer.entry`, so a plugin with no
  renderer half can still put a button on the toolbar.
- A button's enabled state follows `commands.isEnabled`, computed by the
  controller and carried in the descriptor (see the note above); the renderer
  never calls a disabled command. Clicking sends `shell:commands.execute` (see
  IPC).
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
| A name from the shell's icon set | `'Save'`, `'CalendarToday'` | The shell's bundled glyph. An unknown name is a validation failure |

The shell ships a built-in set whose names live in
[shared/layout/icons.ts](../shared/layout/icons.ts) (so the main process can
validate contributions) and whose glyphs live in
[shell/renderer/layout/iconGlyphs.ts](../shell/renderer/layout/iconGlyphs.ts).
The set is [MUI's Material icons](https://mui.com/material-ui/material-icons/)
(`@mui/icons-material`), chosen to match the planned move to MUI for
components. Names are Material icon names in PascalCase (`Save`,
`CalendarToday`, `AccountBalance`), so swapping in the package later is a
drop-in. It ships ten glyphs for now (`Add`, `AccountBalance`,
`CalendarToday`, `Circle`, `Close`, `Home`, `Info`, `List`, `Save`,
`Search`), and growing it only means growing those two files. Plugin files
should be monochrome SVGs; the renderer paints them with CSS `mask-image` and
`currentColor`, so icons follow the theme. The same `icon` is used on the rail, the tab, and for button items; a
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
  { kind: 'button', id: 'accounts.toolbar.show', slot: 'shell.top', label: 'Accounts', icon: 'List', command: 'accounts.show' })
context.extensions.contribute('accounts', 'shell.menus', 'accounts.show',
  { kind: 'item', id: 'accounts.show', label: '&Accounts', parent: 'shell.view', command: 'accounts.show' })
```

```tsx
// Inside the plugin's AccountsList view (left bar): clicking a row opens the register
onClick={() => window.api.invoke('shell:commands.execute', { id: 'accounts.show', args: [account.id] })}
```

### Context keys

Set by the controller whenever the layout changes, so plugin commands and
`when` expressions can depend on the layout:

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
it names a window the controller has not attached. This is also the first step
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

/** A slot's present content, decided by the controller. */
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

Only changes are published: the controller compares the new state with the
old, per window, and stays silent when nothing differs, so a context-key
change that touches no `when` expression costs nothing on the wire.

### Who talks to whom

| Actor | Observes | Changes |
|---|---|---|
| The shell's renderer (`<LayoutController>`) | `shell:layout.changed`, the catalogue events, `shell:contextKeys.changed` | `shell:layout.slot.set` on gestures, `shell:commands.execute` on button clicks |
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
| Store | The existing **`app-state` plugin**, through its `app.state` service (`AppState` in `@tessera/types`: `get`, `set`, `update`, `remove`), which is backed by the `storage.engine` Loki collection. No new store, file or port implementation is needed |
| Keys | One entry per window: `shell.layout.<windowKey>` (for example `shell.layout.main`) |
| Value | `{ "main": { "activeView": "accounts.register" }, "bars": { "left": { "collapsed": false, "size": 260, "activeView": "accounts.list" }, … } }`. Per bar: `collapsed`, `size`, `activeView`; for the main area: `activeView`. Never the present `views` and `items` |
| Write | `app.state.set(key, value)` after a change, debounced by the controller (a drag or arrow-key run is one write), flushed when a window closes and from `context.lifecycle.onShuttingDown`. Each `set` is already a storage transaction, so atomicity is the engine's |
| Read | `app.state.get(key)` when a window is attached, before it loads its page, so the first snapshot is already right. Missing or invalid values fall back to defaults per bar |

**Window keys.** Electron window ids are assigned per session, so they cannot
key persisted state. Each window is created with a stable **layout key**:
`main` for the primary window, and whatever a future "open window" command
chooses for others (say `window-2`). `registerLayout` keeps the
`windowId → key` map; the controller and the IPC only ever see window ids. A
window whose key has no saved state starts from `main`'s current state (see
Decisions), or from the defaults when `main` has none either. Because every
window is one key, that copy is a `get` of `shell.layout.main` and a `set`
under the new key.

**The port.** Core never loads or imports a plugin; plugins are loaded and
activated only by the `PluginManager`, and everything they offer reaches the
rest of the app as a published service. `LayoutService` therefore talks to a
`LayoutPersistence` port (load and save by window key), and the shell supplies
a small adapter that implements it with the `app.state` service. The adapter
gets it from the service registry, as plugins do through their
`PluginContext` (see
[plugins/app.state/src/privileged/index.ts](../plugins/app.state/src/privileged/index.ts),
which does so for `storage.engine`):

```ts
// shell/main/app.ts
const appState = () => runtime.services.has('app.state') ? runtime.services.get<AppState>('app.state') : undefined
```

The shell is not a manifest plugin (its id is reserved), so it cannot declare
`services.requires`, and the lookup happens on every use rather than once:
the service only exists after `PluginManager.activateAll()`. Until then, or if
`app-state` failed to activate, nothing is remembered and nothing fails.
Nothing in
`core/layout/` or the adapter imports from `plugins/app.state/`; the only
contract is the `AppState` interface in `@tessera/types`. Windows are
attached after plugins activate (see Startup), so the first read finds the
service. If a `get` or `set` call fails, the controller logs `[layout] …` and
keeps working in memory for the session; losing a preference must never break
the window.

`useSidebarState` and its `sidebar` key in the `app-state` plugin are
superseded by this and should be removed; the plugin itself stays, since the
layout depends on it. Because `app-state` requires `storage.engine`, the
layout's persistence is only as available as that service. Plugins' own `app.state` callers are
unaffected; the `shell.layout.` prefix keeps the layout's entries apart from
theirs.

## Key flows

### Startup

1. `bootstrap()` creates `LayoutService` with the extension registry, the
   context-key service and the persistence adapter.
2. `registerLayout` registers the IPC handlers, the commands, the View menu,
   and subscribes the controller's `onDidChange` to publish
   `shell:layout.changed` and rewrite the `shell.layout.*` keys for the
   focused window.
3. Plugins activate and contribute views and items. Each contribution fires
   `extensions.onDidChange`; the controller recomputes presence for every
   attached window (none yet).
4. `createWindow` attaches the window under key `main`; the controller loads
   its preferences and computes its first state.
5. The window opens. `<LayoutController>` subscribes, requests
   `shell:layout.get`, `shell:views.list` and `shell:bar.items.list`, and
   renders. Bars without content are simply not in the DOM; each bar with
   views shows its persisted active tab.

### The user collapses the left bar

1. Click on the bar's collapse button, `Ctrl+B`, or *View › Toggle Left Bar*.
   The first sends `shell:layout.slot.set { slot: 'shell.left', collapsed: true }`;
   the others run `shell.layout.toggle.left` against the focused window.
2. The controller updates that window's state and fires `onDidChange`; the
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
3. The controller sets `main.activeView` for the focused window, publishes
   `shell:layout.changed` then `shell:layout.revealed`, and sets
   `shell.layout.main.activeView`. The renderer shows the register and
   focuses it. A toolbar button or a View-menu item bound to the same
   command does exactly the same.

### A plugin's view appears and disappears

1. A vault plugin sets `vault.isOpen = true`. `contextKeys.onDidChange`
   fires; the controller re-evaluates every `when`, finds the left bar now
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

Closing a window detaches it from the controller: its state is written under
its key and dropped. `onShuttingDown` flushes any pending write. Nothing in the
layout can veto a quit.

## Alternatives considered

| Alternative | Why not |
|---|---|
| **Renderer-owned layout state** (as `useSidebarState` does today, saved through `app.state`) | Commands run in the main process, so menu items and accelerators could not toggle bars, and plugins could not enable commands on the layout. The renderer would also have to report presence back, making two sources of truth |
| **Renderer evaluates `when`** (main pushes the catalogue, the renderer filters) | The controller needs presence anyway for `hasContent` and command enablement; evaluating twice risks a frame where the two disagree. Evaluating once in main and pushing the present ids is the consistent option, chosen above |
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
2. **The `app-state` plugin** (and the `storage.engine` it requires), for
   saving preferences, plus a small `LayoutPersistence` adapter over its
   `app.state` service, looked up in the service registry on each use. Not
   blocking: the controller runs in memory while the service is absent.
3. **Context keys in the renderer** are already mirrored by
   `ShellStateProvider`; the item strip needs a snapshot hook exported from
   `ShellState.tsx` for enablement and `{key}` text.
4. **`shell:commands.execute`**, a new shell request, for bar buttons and
   navigation views.
5. **A reserved `shell.view` menu**, one change in `shared/menus`.
6. **Icon resolution** in the main process (`iconUrl`, like `remoteEntry`)
   and the MUI icon set in the renderer.
7. **Declared extension points** (todo) would let the shell declare
   `shell.bar.items` with a schema. Helpful, not blocking; `resolveBarItems`
   validates in the meantime.

## Implementation notes

Where the code settled differently from, or beyond, what the sections above
say:

- `LayoutService.attach(windowId, key?, initial?)` takes an optional layout
  key; a window without one is not saved, which keeps tests and throwaway
  windows simple. `attachPersisted(windowId, key, primaryKey)` is the version
  that loads, and that copies the primary window's current preferences for a
  key with nothing saved. `detach` and `flush` return promises that resolve
  once writes have landed, and writes never overlap.
- `CommandRegistry` gained `onDidChange`, which button enablement needs
  (`shell:bar.items.changed` is published when a flag flips).
- Layout context keys are rewritten on every layout change, focus change and
  contribution or context-key change, so `hasContent` is right even before a
  window exists.
- The splitter follows the mouse (`mousedown`, then `mousemove` and `mouseup` on
  the document), not pointer events. The dragged size stays on screen until
  the controller has answered the final one, so the bar does not jump back.
- A bar's tab strip and view sit between its items strip and its inner edge:
  the items strip leads in the top, left and right bars and trails in the
  bottom bar, so status text stays on the window's bottom edge.
- `BarItemsProvider` is required; without it a bar throws, like `<Slot>`
  without `<ViewsProvider>`.
- Entries that plugins add to `shell.view` sort above the shell's own groups, which
  carry a large `order`, so plugin pages come first in the menu.

## Open questions

Four earlier questions are now decisions (see [Decisions](#decisions)); what
each leaves behind is listed here.

1. **Secondary windows (decided: start from `main`'s current state).** Still
   to settle when an "open window" command exists: the key scheme (positional,
   `window-2`, or named by what the window shows) and whether the copy happens
   once at attach time (assumed) or the windows stay linked (not intended).
   No second window is planned for the accounting work, so nothing is built
   for this now beyond keeping the controller per window.
2. **Hidden views (decided: no polling, still listening).** To implement
   this, a view needs to know it is hidden. `shell:layout.changed` already
   carries the active view and collapsed flag per bar, so a view can derive
   "hidden" from it; whether the shell should also hand a ready-made
   `visible` flag to remote views (a prop) is open. The memory cost of
   keeping shown tabs mounted is accepted for now; a least-recently-used cap
   is deferred until it is a measured problem.
3. **Icons (decided: MUI).** The shell's names are MUI icon names and ship as
   inline glyphs. Open: when to swap the glyph file for `@mui/icons-material`
   itself (importing the whole package into the renderer bundle must be
   avoided; the shell should import only the icons it ships), and whether to
   add finance-specific glyphs (currency, bank, budget).
4. **Main-area contents (decided: one active view, history later).** Two
   plugins revealing at once still resolve to last-`reveal`-wins. Back and
   next buttons are planned: open questions are where they live (a control in
   the top bar contributed by the shell, or an item plugins can place) and
   whether history is persisted across restarts (assumed not).

## Suggested phases

Phases 1–4 are **done**; phase 5 is open.

1. **Frame and slots:** `tessera-types/layout.ts` and `shared/layout/types.ts`,
   `IpcMessage.sender`, `LayoutService` in memory with one attached window,
   `registerLayout` with `shell:layout.get`, `shell:layout.slot.set`,
   `shell:layout.changed`, the four bars in `<LayoutController>` with hidden,
   collapsed and expanded states, tab strips and rails with icons, the main
   area's active view, presence from contributions only. Tests for the
   controller (state transitions, per-window isolation, change detection,
   active-view fallback) and the renderer (a bar with no views renders
   nothing; a collapsed bar renders a rail with one icon per view; only the
   active tab is visible).
2. **Commands, keys and menu:** `shell.layout.*` commands against the
   focused window, context keys with focus tracking, the `shell.view` menu,
   `reveal` and `shell:layout.revealed`, the splitter with keyboard support,
   `F6` region cycling.
3. **`when` and items:** `when` on views evaluated by the controller, the
   `shell.bar.items` point, `resolveBarItems`, icon resolution,
   `shell:bar.items.list` and `.changed`, `shell:commands.execute`, button
   enablement and `{key}` text.
4. **Persistence and windows:** the `app.state` adapter, window keys,
   attach and detach, load before the window opens, flush on close and
   shutdown, remove `useSidebarState` from `app-state` (done: the hook is
   deleted; the plugin itself stays).
5. **Polish and follow-ups:** checkbox menu items once they exist, targeted
   event delivery, a tab strip for the main area (separate note).
