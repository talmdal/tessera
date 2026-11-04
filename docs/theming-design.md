# Design note: theming and Material UI

| | |
|---|---|
| **Status** | Phases 0 (spike), 1 (theme manager), 2 (MUI foundation, no flash), 3 (`@tessera/ui` and icons) and 4 (shell components) done; phase 5 (plugins) done; phase 6 (polish) done except the items that wait on other work (listed in its results). The earlier open questions are answered (see [Decisions](#decisions)); a few new ones are at the end |
| **Date** | 2026-11-04 (first draft 2026-11-03) |
| **Scope** | One component library and icon set (Material UI) for the shell and plugin views, exposed to plugins through `@tessera/ui`; a theme manager that follows the OS light or dark setting, lets plugins contribute themes, and lets a window override the theme |
| **Related** | [layout-controller-design.md](layout-controller-design.md) ([Icons](layout-controller-design.md#icons)), [plugin-creation.md](plugin-creation.md) ([Shared dependencies](plugin-creation.md#shared-dependencies)), [settings-design.md](settings-design.md), [todo.md](todo.md) |

- [Summary](#summary)
- [Context](#context)
- [Goals and non-goals](#goals-and-non-goals)
- [Decisions](#decisions)
- [`@tessera/ui`: what plugins import](#tesseraui-what-plugins-import)
- [Themes](#themes)
- [Theme manager](#theme-manager)
- [Renderer](#renderer)
- [Icons](#icons)
- [Plugins and Module Federation](#plugins-and-module-federation)
- [Component migration](#component-migration)
- [Testing](#testing)
- [Alternatives considered](#alternatives-considered)
- [Phases](#phases)
- [Phase 0 results](#phase-0-results)
- [Phase 1 results](#phase-1-results)
- [Phase 2 results](#phase-2-results)
- [Phase 3 results](#phase-3-results)
- [Phase 4 results](#phase-4-results)
- [Phase 5 results](#phase-5-results)
- [Phase 6 results](#phase-6-results)
- [The theme chooser](#the-theme-chooser)
- [Open questions](#open-questions)

## Summary

**The shell adopts [MUI](https://mui.com/) (`@mui/material`, Emotion) and
`@mui/icons-material` for components and icons. Plugins never import MUI
directly: they import from `@tessera/ui`, the way they import contracts from
`@tessera/types`. A theme manager in the main process decides what every
window looks like.**

- **Plugin boundary.** A plugin may reference only `@tessera/types` and
  `@tessera/ui`. `@tessera/ui` is a facade over MUI that the shell provides
  at runtime as a Module Federation singleton. The shell can upgrade or
  reshape MUI behind it, and the sharing problem reduces to one specifier.
- **Themes are data.** A *theme* (colour scheme) is a named set of palette
  tokens for light, dark or both. The shell ships one (`tessera`); plugins
  contribute more through a `shell.themes` extension point.
- **Global setting plus window override.** The application has one theme
  selection, `system` by default (follow the OS between the theme's light and
  dark variants). A window may override it with any theme, including one
  with a single variant that cannot follow the system.
- **No flash.** A window stays hidden until its theme is applied and its first
  frame is ready. A splash screen is a later enhancement.
- **Native chrome follows the OS** for now (title bar, window controls).

## Context

Today the renderer has no styling beyond layout:

- Components are bare HTML (`<button>`, `<div role="tablist">`) with inline
  `style` for geometry only. Colours are browser defaults, so there is no
  dark mode and nothing for a plugin to match.
- Icons are hand-copied SVG path strings in
  [iconGlyphs.ts](../shell/renderer/layout/iconGlyphs.ts), drawn by
  [BarIcon.tsx](../shell/renderer/layout/BarIcon.tsx). Their names already
  follow `@mui/icons-material` on purpose.
- The `app-state` plugin has a `useThemeState` hook that stores `light` or
  `dark` under the `theme` key and sets `document.body.dataset.theme`. No
  stylesheet reads that attribute and nothing imports the hook, so it is dead
  code and is removed by this work. The stored value is read and migrated
  (see [Persistence](#persistence)).
- The bundled `test-layout` plugin hardcodes light colours (`#fff3c4`,
  `#e8e8e8`), unreadable on a dark theme.
- Plugins can reference only `@tessera/types` (and, with this work,
  `@tessera/ui`). A plugin that wants a button today has no sanctioned
  library to get one from.

## Goals and non-goals

**Goals**

- One component library and icon set for the shell and plugin views, reached
  by plugins only through `@tessera/ui`.
- Light and dark following the OS by default, with a persisted override.
- Plugins can contribute themes, and a window can use a different theme from
  the rest of the application.
- Live switching (OS change, preference change) with no restart.
- No visible flash of an unthemed or wrongly themed window.
- Plugins can add icons beyond the shell's set, loaded lazily and cached.
- Keep the layout controller's accessibility contract (roles, labels,
  keyboard handling); tests change only where markup legitimately differs.

**Non-goals (for now)**

- Themed title bar or window controls (follow the OS; revisit later).
- A splash screen (a later enhancement).
- Executable theme code from plugins: themes are declarative data.
- A settings page for the choice; that waits for the
  [settings framework](settings-design.md). Commands and the View menu cover
  it until then.
- Replacing the splitter or the layout model; only their appearance changes.
- Bundled fonts: the OS font stack is used.

## Decisions

Answers to the first draft's questions, followed by the design decisions.

| # | Decision | Notes |
|---|---|---|
| 1 | Latest stable MUI at build time, **open-source tier only** | `@mui/material`, `@mui/icons-material`, and `@mui/x-*` community (MIT) packages only. No Pro or Premium components, so a data grid is limited to the community features |
| 2 | Plugins **register their own icons** beyond the shell's set; they are **retrieved lazily and cached** | See [Icons](#icons) |
| 3 | A plugin **bundles the icons it needs** beyond the standard set; `@mui/icons-material` is not shared with plugins | Because plugins can't import it anyway (see 4) |
| 4 | Plugins import only `@tessera/types` and `@tessera/ui` | New package `tessera-ui/`; see [below](#tesseraui-what-plugins-import) |
| 5 | **Plugins can register a theme / colour scheme** | `shell.themes` extension point; `ThemeState` carries a theme id |
| 6 | The theme is **global, with a per-window override**; an override may use a theme that doesn't follow the system | See [Themes](#themes) |
| 7 | Plugins **get the theme state** as data | `useThemeState()` in `@tessera/ui` |
| 8 | Windows chrome follows the OS | Revisit later |
| 9 | The OS font stack | |
| 10 | Compact density for the whole shell | A todo item re-evaluates it later |
| 11 | No bundle budget | |
| 12 | Nothing is shown until the window is ready (no flash) | Splash screen later |
| 13 | The main process owns theme state, backed by Electron `nativeTheme` | Mirrors the layout controller; keeps native menus and dialogs in step with the global setting |
| 14 | One plain MUI theme is built per theme and mode, and the mode is driven by the manager, not by MUI's browser storage | One owner of the preference. (`cssVariables` was dropped in phase 2: the window is hidden until themed and a change re-renders cheaply, so it bought nothing yet) |
| 15 | `@tessera/ui` is **curated**: an export is added when a view needs it, never `export *` from MUI | A test pins the list. The shell's own components import from `@tessera/ui` too, so there is one import style |
| 16 | Prefer MUI equivalents to native UI (dialogs, menus) where possible | Native menus and dialogs follow only the global setting and can't follow a window override, so the less native UI the fewer mismatches |
| 17 | **Plugins cannot change the theme.** They read it (`useTheme`, `useThemeState`); the commands and IPC requests that change it are for the user's own gestures | A plugin switching the theme under the user would be hostile |
| 18 | Theme tokens start at palette, background, text and divider | Widen later if needed |
| 19 | A window override is persisted with that window's state | |

## `@tessera/ui`: what plugins import

A new package, `tessera-ui/`, sits beside `tessera-types/` and is aliased as
`@tessera/ui` the same way. Plugin renderer code imports from it and from
`@tessera/types`, and from nothing else in the framework or MUI.

```tsx
import { Button, Stack, Typography, Icon, useThemeState } from '@tessera/ui'
```

It exports:

| Export | What |
|---|---|
| Components | A curated set re-exported from `@mui/material` (`Button`, `TextField`, `Stack`, `Typography`, `Dialog`, `Table*`, …). Grows on demand |
| Styling | `sx` prop support, `styled`, `useTheme`, and the theme type |
| Icons | `Icon` (looks an icon up by name), `createSvgIcon` (build a component from path data, for icons a plugin bundles) |
| Theme | `useThemeState()` returning `{ theme, mode }`, and the theme and token types |

**Runtime.** `@tessera/ui` has real code, unlike `@tessera/types`, which is
interfaces only. At runtime the shell supplies the one implementation, as a
federation singleton; plugin builds treat it as `import: false` like React.
The plugin gets types from `tessera-ui/index.ts` at build time, and the
shell's instance at run time. MUI, Emotion and the icon package are the
shell's private dependencies and may change behind the facade.

**Boundaries.** `tessera-ui/` may import React, MUI and `@tessera/types`; it
must not import `core/`, `shell/` or Electron. `core/`, `shared/` and
`shell/main` must not import it (no React in the main process). The
[boundary test](../tests/architecture/boundaries.test.ts) gains these rules,
and a new rule that plugin source imports nothing from `@mui/*` or `@emotion/*`.

## Themes

A **theme** is declarative data, so the main process can validate and persist
it and a plugin can contribute one without running code in the renderer.

```ts
// tessera-types/theme.ts
export type ThemeMode = 'light' | 'dark'
export type ThemeModePreference = ThemeMode | 'system'

/** The tokens one variant of a theme sets. Anything omitted falls back to the base theme. */
export interface ThemeTokens {
  primary?: string
  secondary?: string
  error?: string
  warning?: string
  info?: string
  success?: string
  background?: { default?: string, paper?: string }
  text?: { primary?: string, secondary?: string }
  divider?: string
}

export interface ThemeDescriptor {
  /** Unique, prefixed by the contributing plugin's id (`tessera.default` for the shell's own). */
  id: string
  label: string
  /** At least one variant. A theme with both can follow the system; one with a single variant cannot. */
  light?: ThemeTokens
  dark?: ThemeTokens
}

/** A choice of theme and mode. Used for the global setting and for a window override. */
export interface ThemeSelection { theme: string, mode: ThemeModePreference }

export interface ThemeState {
  /** The application-wide setting. */
  global: ThemeSelection
  /** This window's override, if it has one. */
  override?: ThemeSelection
  /** What is applied now: the override if present, else the global setting, after fallbacks. */
  theme: string
  mode: ThemeMode
}
```

Rules:

- **`system`** is a mode preference, not a theme. It means: use the OS's
  light or dark, picking that variant of the chosen theme. It is only valid
  for a theme that has both variants. Choosing a single-variant theme forces
  its mode and `system` is not offered for it.
- **A window override** is a full `ThemeSelection` for one window, so it can
  pin a theme that doesn't follow the system (for example a dark-only
  "Midnight" in a window while the rest of the application follows the OS).
  Clearing it returns the window to the global setting.
- **Contributing** (`shell.themes`) goes through the extension registry,
  like views and bar items, and is validated the same way. A theme is skipped
  with a `[theme]` warning for: a missing `id`, `label` or variant; an id not
  prefixed by the plugin; an id of the shell's own theme; an unknown field or
  token (strict, so typos are caught); or a colour that isn't hex or
  `rgb()`/`rgba()`/`hsl()`/`hsla()`. Colour *names* such as `red` are
  rejected so every colour can be parsed and adjusted by the UI library. The
  first of two themes with the same id wins.
- **Fallbacks.** If the selected theme is no longer registered (its plugin
  was removed or failed), the manager falls back to `tessera.default` with
  a `[theme]` warning, and keeps the stored selection so the theme returns
  if the plugin does.
- **Tokens, not code.** The token set is deliberately small (palette,
  background, text, divider). Typography, density and shape are the shell's,
  so plugin themes can't break layout. Widening it later is an open question.
- **Contrast** is not enforced by the framework in the first version (open
  question).

The shell's own theme is `tessera.default`, with light and dark variants.

## Theme manager

Same shape as the layout controller: a platform-free service in `core/`, a
port the shell adapts to Electron, and IPC to the renderer.

```
core/theme/ThemeService.ts          registry, global selection, per-window overrides, resolution
core/ports.ts                       + ThemePort
shell/main/theme/electronTheme.ts   ThemePort over Electron nativeTheme
shell/main/theme/registerTheme.ts   shell.themes point, commands, context keys, menu, IPC, persistence
tessera-types/theme.ts              the types above
```

```ts
// core/ports.ts
export interface ThemePort {
  /** True while the OS wants dark colours. */
  readonly systemPrefersDark: boolean
  /** Sets Electron's source for app-wide chrome (menus, dialogs): 'system', 'light' or 'dark'. */
  setSource(mode: ThemeModePreference): void
  /** Fires when the OS preference may have changed. Returns an unsubscribe. */
  onSystemChange(listener: () => void): () => void
}
```

`ThemeService`:

- **Registry:** `list()`. The shell's theme first, then the valid contributions
  to `shell.themes`, which the service follows as they come and go (there is no
  `register`; a plugin contributes through the extension registry, and the
  returned disposable removes the theme).
- **Selection:** `getGlobal()`, `setGlobal(selection)`; per window
  `setOverride(windowId, selection | undefined)`. Selections are validated
  against the registry (unknown theme, or `system` on a single-variant theme,
  is rejected).
- **Resolution:** `getState(windowId)` gives the window's `ThemeState`: the
  override, else the global selection; `system` resolved from
  `port.systemPrefersDark`; single-variant themes forced to their variant;
  unknown themes fall back. `resolveGlobal()` is what a window with no
  override shows, and is what the context keys report while there is no
  window.
- **Events:** `onDidChange(listener)` fires with a window's new state when it
  differs from the last one announced, and for every window when the set of
  themes changes. An OS change affects every window using `system` and none
  that pinned a mode. `ThemeState` carries its `windowId`, as `LayoutState`
  does, so a window ignores another's.
- **Persistence:** through a `ThemePersistence` port (`tessera-types/theme.ts`);
  writes are queued, and a failed one is logged, not thrown. `flush()` waits
  for them.

The Electron adapter maps the **global** mode preference to
`nativeTheme.themeSource`, so native menus and dialogs follow the global
setting. A window override changes only that window's content and
background colour; the native menu bar is app-wide on Windows and Linux and
cannot differ per window (see open questions).

### Commands, context keys and menu

| Command | Effect |
|---|---|
| `shell.theme.useSystem` / `useLight` / `useDark` | global mode (current theme) |
| `shell.theme.toggle` | flip to the opposite explicit mode |
| `shell.theme.select` | choose the global theme (a quick pick when the quick-pick UI exists; the argument form works now) |
| `shell.theme.setForWindow` | override this window's selection (focused window, as the layout commands do) |
| `shell.theme.clearWindowOverride` | return this window to the global setting |

Context keys: `shell.theme.mode`, `shell.theme.id`, `shell.theme.overridden`
(true while the focused window has an override).

The `View` menu gains a **Theme** submenu with the commands. Radio items
don't exist yet ([todo.md](todo.md#menus-commands-and-context-keys)), so the
current choice isn't ticked until they do.

### IPC

Following the layout channels, attributed to the window by `IpcMessage.sender`:

| Channel | Direction | Payload |
|---|---|---|
| `shell:theme.get` | renderer → main | none; returns a `ThemeSnapshot`: the sending window's `ThemeState` and every registered `ThemeDescriptor` |
| `shell:theme.changed` | main → renderer (event) | a `ThemeSnapshot`, for each window whose state changed |

Events go to every window and carry the window id, as the layout's do;
targeted delivery is the open todo "Events to one window".

**There is no request that changes the theme.** The renderer has nothing to
change it with until phase 6's settings page, and until IPC senders are
validated ([todo.md](todo.md#security)) any plugin view could send one. The
decision that plugins can't change the theme is enforced as far as the platform
allows: no such request exists, and the commands below are, like every
command, runnable by any privileged code. Revisit with sender validation and a
plugin trust model.

### Persistence

The global selection is stored in `app-state` under the existing `theme`
key; a window's override is stored with that window's state, keyed like its
layout (`PRIMARY_WINDOW_KEY` for the first window), so it survives a restart.

| Stored `theme` | Meaning |
|---|---|
| absent | `{ theme: 'tessera.default', mode: 'system' }` |
| `'light'`, `'dark'` (the old hook's values) | `{ theme: 'tessera.default', mode }` |
| a `ThemeSelection` object | itself |
| anything else | ignored with a `[theme]` warning, treated as absent |

It is read **before the first window is created**, and the manager runs with
defaults, unpersisted, if `app-state` is unavailable, as the layout
controller does.

### Startup without a flash

Windows are created after `activateAll()` ([app.ts](../shell/main/app.ts)),
so contributed themes are already registered. For each window:

1. The window is created with `show: false`.
2. It is attached to the theme manager (which loads its saved override), and
   its `backgroundColor` is set from the resolved theme's `background.default`
   (plain hex only, as a window takes nothing else; otherwise the shell's).
   The manager needs the window's id, which exists only after construction,
   which is why the colour is set with `setBackgroundColor` rather than passed
   to the constructor.
3. The preload asks the main process for the window's `ThemeSnapshot`
   **synchronously** (`sendSync`, channel `shell:theme.initial`) and exposes it as
   `window.api.initialTheme`, so the first React render already has it: no round
   trip, no "light first". (Not `additionalArguments`: they are fixed at
   construction, before the window's id is known.)
4. The renderer draws nothing without a theme. Once its layout has arrived and a
   frame is painted it sends `shell:window.ready`. Main shows the window when
   both that and `ready-to-show` have arrived, or after 5 s with a warning, so a
   broken renderer doesn't leave an invisible window. A window that was
   maximized is maximized at that point: `maximize()` shows a hidden window.

A splash screen could later fill the hidden interval.

## Renderer

A `ShellThemeProvider` wraps the tree in [main.tsx](../shell/renderer/main.tsx):

```tsx
<ShellStateProvider bridge={window.api}>
  <ShellThemeProvider>            {/* ThemeState + MUI ThemeProvider + CssBaseline */}
    <ViewsProvider …>
```

- It starts from the synchronous initial state, then follows
  `shell:theme.changed`, and exposes `useThemeState()` and
  `useThemeActions()` to shell components (the former is re-exported from
  `@tessera/ui` for plugins).
- `createShellTheme(descriptor, mode)` builds the MUI theme: base palette
  from `tessera.default`, overridden by the selected theme's tokens for that
  mode, with the shell's typography (OS font stack), compact density and
  component defaults. Themes are memoised per `(id, mode)`.
- MUI's own mode persistence is disabled; the manager is the only owner.
- `CssBaseline` (`enableColorScheme`) sets the page background, text colour
  and the `color-scheme` property, so native controls and scrollbars match
  the window's mode, including under an override.
- Shell chrome reads theme tokens (`divider`, `background.paper`,
  `action.selected`), never literals. A test rejects hex colours in
  `shell/renderer`.

## Icons

Three kinds of icon, one `icon` string everywhere:

| `icon` value | Source | When loaded |
|---|---|---|
| `'Save'` | The shell's standard set, from `@mui/icons-material` | In the shell bundle |
| `'./icons/x.svg'` | A file in the plugin's renderer folder (existing behaviour) | Lazily, on first use |
| `'<pluginId>.<name>'` | An icon the plugin **registered** (new) | Lazily, on first use |

**Standard set.** [iconGlyphs.ts](../shell/renderer/layout/iconGlyphs.ts)
becomes a registry of per-icon imports
(`import Save from '@mui/icons-material/Save'`), never the package's root
barrel. The names stay in [shared/layout/icons.ts](../shared/layout/icons.ts)
because the main process validates against them and can't import components.
A test asserts every name has a registry entry and exists in the installed
package. The set stays small and grows when the shell needs an icon.

**Plugin icons (`shell.icons`).** A plugin registers the icons it needs beyond
the standard set:

```json
"contributes": { "shell.icons": [ { "id": "accounts.bank", "file": "./icons/bank.svg" } ] }
```

- Ids must be prefixed by the plugin id, like other contributions; main
  resolves `file` to a `tessera-plugin://` URL (as it does for `./` icons) and
  validates it (inside the renderer folder, `.svg`).
- Registration publishes only the id and URL. The renderer fetches the file
  **the first time the icon is drawn** and caches it in memory for the session;
  the protocol response is also HTTP-cacheable. An icon never drawn is never
  fetched.
- Once registered, the id works anywhere an `icon` does, and in plugin views
  as `<Icon name="accounts.bank" />` from `@tessera/ui`. Components use the
  same lookup, so a view and a bar item share one cache entry.
- Rendering stays **mask-based and monochrome**, as for today's `./` icons.
  This follows `currentColor`, so icons obey every theme and mode, and a plugin's
  SVG is never inserted into the DOM as markup, so it can't carry script.
  Multi-colour icons are out of scope.
- Until an icon loads, `Icon` shows the existing initial-letter placeholder at
  the same size, so nothing shifts.
- **Bundled icons.** A plugin that prefers to ship an icon *inside* its view
  code builds it with `createSvgIcon(path, name)` from `@tessera/ui`. It
  can't import `@mui/icons-material`; the package is the shell's private
  dependency.

## Plugins and Module Federation

Today the shell shares `react`, `react/jsx-runtime` and `react-dom`
([federationViewLoader.ts](../shell/renderer/views/federationViewLoader.ts),
`SHARED_MODULES` in [build-plugins.mts](../scripts/build-plugins.mts)). One
specifier is added:

| Package | Why it must be a singleton |
|---|---|
| `@tessera/ui` | The shell's instance of MUI and Emotion is the one with the `ThemeProvider` and the style cache. A second copy would render unthemed |

MUI, Emotion and the icon package are not shared individually; they are
*inside* the shell's `@tessera/ui`. That removes the earlier worry about
sub-path imports (`@mui/material/Button`) resolving to the shell's copy.

Consequences:

- **The plugin build** gets an alias for `@tessera/ui` (types, from
  `tessera-ui/index.ts`) and a shared entry with `import: false`; it fails if a
  plugin source file imports `@mui/*` or `@emotion/*` directly.
- **Version range.** The shared range is a manual constant today (a todo
  item). Derive it from `package.json` in the same change.
- **A plugin that doesn't use `@tessera/ui` still works,** but is unthemed.
- **Content-Security-Policy.** Emotion injects `<style>` tags at runtime.
  The CSP the [todo](todo.md#security) calls for must allow that, preferably
  with a nonce passed to Emotion's cache rather than `style-src
  'unsafe-inline'`. Plan the two together; plugins inherit the nonce because
  they share the cache.
- **Isolation.** Views are error-bounded. A plugin reads the theme
  (`useTheme`, `useThemeState`) but can't change it: changes go through the
  commands and IPC above.

The plugin guide gains a "Styling and theming" section: import from
`@tessera/ui`, use `sx` and theme tokens never literal colours, register icons
or bundle them, and how to contribute a theme.

## Component migration

The layout components keep their structure, roles, labels and `data-*`
attributes, which the tests and keyboard handling rely on. Only the elements
change.

| Today | Becomes |
|---|---|
| `Bar`: `<aside>`/`<header>` with inline flex | same landmark element via `Box component=…` with `sx`, theme borders |
| `Bar` tab strip: `div[role=tablist]` + `button[role=tab]` | MUI `Tabs`/`Tab` (supplies `role`, `aria-selected`, arrow keys; keep ids and `aria-controls`) |
| Collapse `×` and rail buttons | `IconButton` with the chevron pointing away from the main area to collapse and towards it to expand (`ChevronLeft`/`ChevronRight`/`ExpandLess`/`ExpandMore`), keeping `aria-label` and adding a `title` |
| `ItemStrip` buttons and text | `Button`/`IconButton` and `Typography` in a dense `Toolbar` |
| `Splitter` | stays custom (MUI has none); grip uses `divider` and `primary`, focus ring from the theme |
| `Welcome` in `App.tsx` | `Typography` |
| "Loading…" paragraph | a small spinner and message (`Loading`) |
| `test-layout` plugin panels | `@tessera/ui` components and theme tokens; no hex colours |

The shell's components import from `@tessera/ui` like plugins do, so there is one
import style and the curated list is exercised by the shell itself. What only
the shell needs and plugins must not have stays out of that list and is imported
from MUI directly: `createTheme`, `ThemeProvider` and `CssBaseline` (in
`shell/renderer/theme/`) and the provider plumbing in `tessera-ui/internal.ts`.

## Testing

- **`ThemeService`** (unit, platform-free, fake `ThemePort`): default
  `tessera.default` + `system`; registering and disposing themes; selection
  validation (unknown theme, `system` on a single-variant theme); `system`
  follows OS changes; a pinned mode doesn't; a window override beats the global
  setting and is isolated per window; a window pinned to a dark-only theme
  ignores OS changes; fallback for a removed theme; no event when nothing
  changed.
- **`shell.themes` validation:** missing fields, unprefixed or duplicate ids,
  bad colours, a theme with no variant.
- **`registerTheme`** (main): stored values (absent, legacy `light`/`dark`,
  object, garbage), persistence on change, override stored with window state,
  commands, context keys, IPC validation and per-window delivery, window created
  hidden with the right `backgroundColor`, shown only after both signals (and on
  timeout).
- **Renderer:** `ShellThemeProvider` renders the initial state with no async
  gap; follows `shell:theme.changed`; two providers with different overrides
  coexist. (`jsdom` needed no `matchMedia` stub: MUI doesn't call it for a
  fixed-mode theme.) Layout suites keep their assertions, with selector changes only where the
  markup changed.
- **Icons:** registry and name list agree and exist in the package; a registered
  icon fetches once, on first draw, shows the placeholder meanwhile, and is
  cached.
- **`@tessera/ui`:** a plugin-style test renders a component from the shared
  singleton and sees the shell's theme; the plugin build fails on a direct MUI
  import.
- **Architecture:** `core/theme` has no Electron or React; `tessera-ui/` and
  `shell/main` rules as above; no literal colours in `shell/renderer`.
- **Manual:** flip the OS light and dark with the app open under each mode, with
  a window override on a dark-only theme, and watch for any flash on launch.

## Alternatives considered

- **Plugins import `@mui/*` directly and the shell shares it.** What the first
  draft assumed. Rejected: it exposes MUI's whole API and version to plugin
  authors, needs every MUI sub-path shared, and contradicts the rule that plugins
  see only `@tessera/*`.
- **Renderer-only theming from `matchMedia`.** Simplest, but the preference then
  has no main-process owner: native menus wouldn't follow the setting and the
  window couldn't be coloured before paint. The renderer still sees
  `prefers-color-scheme` because `nativeTheme.themeSource` drives it.
- **Themes as executable code (a MUI `createTheme` call in the plugin).** Most
  flexible, but the main process couldn't validate or persist it and a plugin
  could break layout. Declarative tokens first; revisit if they prove too
  limited.
- **Inlining plugin SVGs as DOM.** Allows colour, but injects plugin-controlled
  markup; the mask approach is safe and already in use.
- **Plain CSS variables and our own components.** No dependency, but the finance
  screens ahead (tables, pickers, dialogs) are where a library saves the most.
- **Other libraries** (Fluent UI, Ant Design). Fluent is the closest to a
  Windows look, but the decision to use MUI is already made and recorded here so
  the trade is visible.
- **MUI's own mode switching** (`useColorScheme`, browser storage). A second
  owner of the preference, so we keep its CSS-variable machinery and feed it
  from the manager.

## Phases

Each phase leaves the app working and the tests green.

0. **Spike (done).** `tessera-ui/` with a first curated set of exports
   (`Box`, `Button`, `Divider`, `IconButton`, `Paper`, `Stack`, `Typography`,
   `useTheme`), served to plugins as a federation singleton. See
   [Phase 0 results](#phase-0-results).
1. **Theme manager, no UI change (done).** `tessera-types/theme.ts`, `ThemePort`,
   `ThemeService` (registry, selection, overrides, resolution), the Electron
   adapter, `shell.themes` validation, `registerTheme` (persistence and legacy
   migration, commands, context keys, per-window IPC and events), the **Theme**
   submenu. Delete the dead `useThemeState`.
2. **MUI foundation and no flash (done).** `createShellTheme`, `ShellThemeProvider`,
   `CssBaseline`, `tessera.default` light and dark; hidden
   window, `backgroundColor`, synchronous initial state, ready handshake.
3. **`@tessera/ui` and icons (done).** The curated component exports, `Icon`,
   `createSvgIcon`, `useThemeState`; the standard-set registry over
   `@mui/icons-material`; the `shell.icons` point with lazy fetch and cache;
   delete the glyph paths; name/registry/package test; update the
   [layout note](layout-controller-design.md#icons).
4. **Shell components (done).** Migrate `Bar`, `ItemStrip`, rail, splitter styling and
   welcome per the table; update layout test selectors.
5. **Plugins (done).** Federation sharing of `@tessera/ui` and the derived version
   range; the build rejects direct MUI imports; migrate `test-layout`; a sample
   plugin contributing a theme and an icon; the "Styling and theming" guide
   section; boundary tests.
6. **Polish (done, with the exceptions in its results).** Contrast review of both built-in variants, a contrast check on
   contributed themes (if wanted), reduced motion, forced-colours, a settings
   page for the choice (when the settings framework lands), ticking the current
   choice in the menu (when radio items exist), re-evaluating density, a splash
   screen, a themed title bar.

Phase 2 needs 1 (it reads the state the manager publishes); 3 and 4 need 2;
5 needs 0 and 3.

## Phase 0 results

The spike answered the questions it was set. The tests named here keep the answers true.

| Question | Answer |
|---|---|
| Does a plugin's component see the shell's `ThemeProvider`? | **Yes.** A fixture plugin ([tests/fixtures/ui-plugins/themed](../tests/fixtures/ui-plugins/themed)), built with the real plugin build and loaded through the shell's federation loader, reads the palette of a `ThemeProvider` the test puts around it, and follows a change of theme without reloading ([tests/renderer/tesseraUi.test.tsx](../tests/renderer/tesseraUi.test.tsx)) |
| Is MUI bundled into the plugin? | **No** (once the alias is removed, below). The view's chunk is under 1 KB; it reads `Button`, `useTheme` and the rest as properties of the shared module ([tests/main/buildUiPlugins.test.ts](../tests/main/buildUiPlugins.test.ts)) |
| Does the build refuse a direct MUI or Emotion import? | **Yes**, for `@mui/*` and `@emotion/*`, with an error that points at `@tessera/ui`. The boundary test also checks plugin source ([tests/architecture/boundaries.test.ts](../tests/architecture/boundaries.test.ts)) |
| Do MUI sub-path imports matter? | **No.** Only `@tessera/ui` is shared, so there are no MUI specifiers to share |
| What does the shell bundle weigh? | Not measured: the renderer has no production build yet ([todo.md](todo.md#build-and-packaging)), and there is no budget. Measure when it does |

Findings that shaped the code:

- **No Vite alias for `@tessera/ui` in the plugin build.** With an alias, the
  specifier is resolved to a file before the federation plugin sees it, and the
  facade, with all of MUI (about 280 KB), is bundled into the plugin instead of
  shared. Types still resolve through the `tsconfig.base.json` paths. The build
  has a comment saying so, and the bundle test fails if it regresses.
- **A federation warning is expected.** The build prints `Shared dependency
  "@tessera/ui" has import: false but is not installed locally`, and says named
  imports won't work in production builds. They do: the built code reads members
  of the shared module (`__moduleExports.Button`), and the test above renders
  it. The warning is about static export detection, which we don't use.
- **esbuild can't run in the jsdom test environment**, so the fixture is built
  once in a Vitest global setup
  ([tests/setup/buildUiFixture.ts](../tests/setup/buildUiFixture.ts)) and the test
  gets the entry URL with `inject()`.
- **The shared range comes from `tessera-ui/package.json`,** so for this package
  the todo "keep the shared range in sync" is already solved. React's range is
  not.

## Phase 1 results

The theme manager is built and tested without any change to the renderer. What
changes today: Electron's `nativeTheme` follows the application's mode, so
native menus and dialogs switch with it, and View ▸ Theme works.

| Piece | Where |
|---|---|
| Types: `ThemeDescriptor`, `ThemeSelection`, `ThemeState`, `ThemeSnapshot`, `ThemePersistence` | [tessera-types/theme.ts](../tessera-types/theme.ts) |
| Ids, channels, commands, context keys, the shell's theme | [shared/theme/types.ts](../shared/theme/types.ts) |
| Validation of contributions | [shared/theme/resolveThemes.ts](../shared/theme/resolveThemes.ts) |
| Reading saved choices, checking and resolving selections | [shared/theme/selection.ts](../shared/theme/selection.ts) |
| `ThemeService` and `ThemePort` | [core/theme/ThemeService.ts](../core/theme/ThemeService.ts), [core/ports.ts](../core/ports.ts) |
| Electron adapter, persistence adapter, menu, wiring | [shell/main/theme/](../shell/main/theme/) |

Findings and departures from the first design:

- **Electron hides the OS setting while a mode is forced.**
  `nativeTheme.shouldUseDarkColors` reports the forced value once
  `themeSource` is `light` or `dark`. The adapter remembers the OS value from the
  last time it could be read. If the OS changes while the application's mode is
  forced, that isn't seen until it returns to `system`. It only matters to a
  window that follows the system while the application's own mode is forced
  (see the tests in [tests/main/electronTheme.test.ts](../tests/main/electronTheme.test.ts)).
- **`shell:theme.set` was dropped** (see [IPC](#ipc)).
- **`register()` was dropped**: themes come from the extension registry.
- **Colour names are rejected** in theme tokens (see [Themes](#themes)).
- **Choosing a theme adapts the mode.** `shell.theme.select` keeps the current
  mode when the new theme has it and otherwise uses the theme's own, so a
  selection can never be invalid by construction. `useLight`, `useDark` and
  `useSystem` warn and do nothing when the theme has no such variant.
- **View ▸ Theme** has the three modes, a toggle and "Use the Application Theme
  in This Window" (enabled while the window has an override). Choosing a
  *theme* or giving a window its own are commands with an argument
  (`shell.theme.select`, `shell.theme.setForWindow`), reachable from the
  command registry until a picker exists.
- **The saved `theme` key keeps its meaning.** Absent is `system`; the old
  hook's `'light'`/`'dark'` become explicit modes of `tessera.default`;
  anything unreadable is warned about and ignored. A window's override is saved
  under `shell.theme.<windowKey>`.
- **The app wiring is covered** in [tests/main/app.test.ts](../tests/main/app.test.ts):
  a window gets its theme over IPC, and running `shell.theme.useDark` switches
  `nativeTheme` and publishes the change. (That test's Electron mock gained
  `nativeTheme`.)

## Phase 2 results

The renderer is themed and the window no longer shows before it is ready.

| Piece | Where |
|---|---|
| MUI theme from a theme descriptor and a mode (palette, OS font stack, compact defaults) | [shell/renderer/theme/createShellTheme.ts](../shell/renderer/theme/createShellTheme.ts) |
| `<ShellThemeProvider>`, `useThemeState()` | [shell/renderer/theme/ShellThemeProvider.tsx](../shell/renderer/theme/ShellThemeProvider.tsx) |
| Tells main the first frame is ready | [shell/renderer/WindowReady.tsx](../shell/renderer/WindowReady.tsx) |
| Tokens merged over the shell's, window background | [shared/theme/tokens.ts](../shared/theme/tokens.ts) |
| Hidden window until ready | [shell/main/window/windowReveal.ts](../shell/main/window/windowReveal.ts) |
| Synchronous initial theme | [shell/main/theme/initialTheme.ts](../shell/main/theme/initialTheme.ts), [shell/preload/preload.ts](../shell/preload/preload.ts) |

**Verified in the real app,** not just in tests: Electron was launched with the
renderer dev server and driven over the DevTools protocol.

- With the OS in dark mode the window was visible, with body background
  `rgb(18, 18, 18)`, `color-scheme: dark`, the OS font stack, and
  `window.api.initialTheme` present on the first run of the page script.
- `shell.theme.useLight` switched the live page to `rgb(250, 250, 250)` and
  `color-scheme: light`; `useSystem` switched it back.
- After choosing Light and **restarting**, the first synchronous theme was
  already light, with the OS still dark.
- No "not ready after 5000 ms" warning was logged.

What that did not check: that no frame is ever painted in the wrong colours
(a screenshot or video would), and the OS switching while the app runs (the OS
setting was not changed).

Findings and departures:

- **`cssVariables` was dropped** (decision 14). Nothing needs them yet.
- **The first synchronous request is not `additionalArguments`** (see
  [Startup without a flash](#startup-without-a-flash)).
- **"Ready" means the layout has arrived and a frame is painted,** not that
  views have loaded: a plugin view still shows "Loading…" after the window
  appears. It's the frame's shape and colours that must not jump.
- **The renderer bundle is 369 KB (120 KB gzipped)** for a production build,
  including MUI and the `@tessera/ui` it shares with plugins. This answers the
  "what does the shell weigh" question left open in phase 0; there is no budget.
- **The preload bundle needed a `@tessera/types` alias.** It now imports a
  value through `shared/theme/types.ts`; without the alias the bundle left it
  external and would have failed at run time. The preload was built and its
  output checked.
- **`shared/ipc.ts` re-exports `TesseraBridge`,** which fixes three renderer
  type imports that named it there and failed `tsc --noEmit -p shell` (the same
  kind of stale import as the one in [todo.md](todo.md#build-and-packaging)).
- **The dev run created a profile.** `%APPDATA%\tessera` did not exist, so
  running the app created its storage there; the saved theme was left at `system`.

## Phase 6 results

| Piece | Where |
|---|---|
| WCAG contrast of a theme's colours | [shared/theme/contrast.ts](../shared/theme/contrast.ts) |
| Warning for contributed themes, `onDidChangeThemes` | [core/theme/ThemeService.ts](../core/theme/ThemeService.ts) |
| Theme picker (View ▸ Theme) | [shell/main/theme/themeMenus.ts](../shell/main/theme/themeMenus.ts), [shell/main/theme/registerTheme.ts](../shell/main/theme/registerTheme.ts) |
| Reduced motion, forced colours | [shell/renderer/theme/createShellTheme.ts](../shell/renderer/theme/createShellTheme.ts), [ShellThemeProvider.tsx](../shell/renderer/theme/ShellThemeProvider.tsx), [Splitter.tsx](../shell/renderer/layout/Splitter.tsx) |

**Contrast.** The shell's own colours were reviewed with real figures (WCAG AA asks
for 4.5:1 for text and 3:1 for interface parts), and a test now holds them there:

| | text on background | text on paper | secondary text | primary on paper |
|---|---|---|---|---|
| light | 15.5 | 16.1 | 5.7 | 4.6 |
| dark | 14.2 | 12.8 | 6.8 to 7.2 | 9.5 |

The open question "reject or warn" is answered **warn**: a contributed theme below
those figures is registered and can be chosen, and the log says which pair, in which
mode, and the ratio (`Theme "p.grey" may be hard to read: text.primary on
background.paper is 1.4:1 in light mode (WCAG AA asks for 4.5:1)`), once per theme.
A tool or a user may want exactly that theme, and a plugin can be fixed; refusing would
hide a theme instead of explaining it. Translucent text is blended over its background
as it is drawn, which is how the shell's own text colours are written.

**The theme picker.** View ▸ Theme now lists every registered theme, and has a
**This Window** submenu with the same list plus "Use the Application Theme" (enabled
only while the window has its own). Choosing a theme keeps the current mode when the
theme has it and uses the theme's own when it doesn't; the window variant keeps the
window's own mode. Each theme gets a pair of commands (`shell.theme.use.<id>`,
`shell.theme.window.use.<id>`) and a pair of menu items, added and removed as themes
come and go, and a plugin's `&` in a label is shown as an ampersand, not a mnemonic.
**Verified in the real app:** the native menu read from the main process lists
*Theme ▸ [Follow System, Light, Dark, Toggle | Tessera, Sunrise, Midnight | This Window ▸
Tessera, Sunrise, Midnight, Use the Application Theme]*. Clicking Sunrise applied that
theme (warm dark background, orange accents; screenshot checked); clicking
*This Window ▸ Midnight* gave only the window Midnight while the application stayed on
Sunrise; clearing returned it; everything was restored to the defaults.

**Reduced motion.** The shell follows the system's "show animations" setting, live
(`prefers-reduced-motion`): transitions become `none` and buttons lose their ripple.
Everything built on the theme follows, including the splitter's hover fade.

**Forced colours (high contrast).** In that mode the system replaces background
colours, which would hide the selected tab's underline and the splitter's handle. Both
are given the system's `Highlight` colour there.

**Not verified:** reduced motion and forced colours are covered by tests of the theme and
the generated CSS, but I did not run the app under Windows' "show animations off" or
high-contrast themes, so how they *look* is unchecked.

**Not done, because each waits on something else:**

- **A settings page for the choice** needs the settings framework
  ([settings-design.md](settings-design.md)). The menu is the way to choose until then.
- **Ticking the current choice** in the menu needs radio or checkbox items
  ([todo.md](todo.md#menus-commands-and-context-keys)).
- **The menu lists themes registered at startup.** It is built once after the plugins
  activate, so a theme that appears later is available as a command but not in the menu
  until a restart (the existing "menu structure changes at runtime" todo).
- **Density** stays compact for everything; re-evaluate with real finance screens.
- **A splash screen and a themed title bar** were explicitly left for later.

A small bug in the sample was found on the way: its bottom status text read
`{layout-sample.pings}` but the context key is `test-layout.pings`, so it never showed a
count. A test now checks that every `{key}` in the sample's status text is a key the
plugin publishes.

## The theme chooser

**View ▸ Theme ▸ Choose Theme…** opens a dialog that shows a preview of a theme before
it is chosen. It was added after phase 6 as polish, and uses a MUI dialog rather than a
native one, as decision 16 prefers.

| Piece | Where |
|---|---|
| The dialog, and the host that opens it | [shell/renderer/theme/ThemeChooser.tsx](../shell/renderer/theme/ThemeChooser.tsx) |
| The preview | [shell/renderer/theme/ThemePreview.tsx](../shell/renderer/theme/ThemePreview.tsx) |
| `shell.theme.choose`, `shell.theme.set`, the open event | [shell/main/theme/registerTheme.ts](../shell/main/theme/registerTheme.ts), [shared/theme/types.ts](../shared/theme/types.ts) |

**What it does.**

- The command `shell.theme.choose` publishes `shell:theme.chooser.open` to the focused
  window (the event carries the window id, like the other theme events), whose
  renderer fetches the current themes and shows the dialog. Fetching on open keeps the
  list and the system's setting fresh.
- **Theme:** every registered theme as a radio group (so the arrow keys work), each with
  three colour dots (background, paper, primary) in the mode it would show, and a note
  for a theme that shows one mode only.
- **Mode:** System, Light or Dark, with the ones a theme lacks switched off. The mode you
  *wanted* is remembered: picking a dark-only theme shows Dark, and going back to a
  theme that has Light gives Light back.
- **Use it:** everywhere, or in this window only. A window that has a theme of its own
  opens on "this window only" with that theme selected; choosing Everywhere then replaces
  its own theme (the dialog says so), since leaving it would defeat the choice.
- **Preview:** a miniature of the application (a toolbar with a button and icon, a tab
  strip, text and secondary text, a plain and a highlighted panel, primary, outlined and
  disabled buttons, and the four status colours), drawn with the same components and the
  same MUI theme the application builds for that theme and mode, inside a provider of its
  own. So it shows what choosing the theme gives, while the dialog and the application
  stay in the current theme. It is for looking at: it is one image to assistive
  technology (`role="img"` with a description), is `inert`, and its buttons are out of
  the tab order.
- **"Follow the system"** is previewed as whatever the system shows now (the snapshot now
  carries `systemPrefersDark`), and labelled as following the system. What is applied is
  the `system` setting, not the mode the preview happened to show.
- A theme that is **hard to read** in the previewed mode shows the same contrast warning
  the log gives, in the dialog, before it is chosen. Switching to a mode where it is
  readable removes it.
- **Apply** is off while nothing would change. It runs commands (`shell.theme.set` with a
  full selection for the application, `shell.theme.setForWindow` for the window), so
  there is still no request that changes the theme: a refusal comes back as a message in
  the dialog, which stays open to try again. Cancel and Escape change nothing.

**Verified in the real app,** opened from the native menu item: the dialog listed the
three themes with their dots; choosing Sunrise and Light previewed cream and orange while
the application stayed dark (screenshot checked); Apply made the whole application Sunrise
light and closed the dialog; choosing the dark-only Midnight showed Dark with System and
Light off, and applying it "in this window only" left the application on Sunrise; reopening
started on "this window only" with Midnight and Apply off; Cancel closed it.

**A note on the verification itself.** My first pass force-killed the app within the
2-second autosave of the store, so the last theme writes of that session were not on disk
and a Midnight window override reappeared on the next launch. A normal quit flushes the
store; the kill did not. The profile was restored, the autosave waited out, and a
relaunch confirmed the saved theme and no override.

**Limits.** The preview is a fixed miniature, not the user's own screens, so it shows a
theme's colours rather than how a given layout would look in them. "Follow the system" is
previewed with the last operating-system value Electron could read (see
[Phase 1 results](#phase-1-results)).

## Phase 5 results

Most of phase 5 had already landed as a by-product of phases 0 to 4: the shared
`@tessera/ui` singleton (phase 0), the build rejecting `@mui/*` and `@emotion/*`
imports (phase 0), the guide's "Styling and theming" section and the boundary tests
(phase 3), and `test-layout` on `@tessera/ui` (phase 4). What this phase added:

- **React's shared range comes from `package.json`.** `SHARED_REACT_RANGE` in the
  plugin build was a constant that had to be kept equal to the shell's; it is now
  read from `dependencies.react`, like `@tessera/ui`'s range is from
  `tessera-ui/package.json`. A build test reads the ranges out of a built plugin and
  checks they equal both declarations, so neither can drift. (This closes the todo
  "Keep the shared React range in sync".)
- **`test-layout` contributes themes** as the reference sample: `Sunrise` (light and
  dark, so it can follow the system) and `Midnight` (dark only, so it can't). A test
  runs the sample's real `activate` and checks its themes and its icon through the
  shell's own validators, and that the theme manager accepts them (and refuses
  `system` for the dark-only one).

## Phase 4 results

The shell's own components are on MUI through `@tessera/ui`. **No existing layout
test needed a selector change:** roles, accessible names, `data-*` attributes,
inline grid tracks and gestures all held, which is the contract the design asked
to keep.

| Was | Now |
|---|---|
| `Bar`: landmark with inline styles | the same landmark via `Box component`, paper background and a divider on its inner edge |
| tab strip of `button[role=tab]` | MUI `Tabs`/`Tab` with the view's icon; arrow keys move focus |
| `×` and `»` | `IconButton` with chevrons that point away from the main area to collapse, towards it to expand |
| rail buttons | `IconButton`s; the active view in the primary colour |
| `ItemStrip` | a dense `Toolbar` of `Button`s (icon at the start) and `Typography` for plain text |
| `Splitter` | still custom; invisible until hovered, dragged or keyboard-focused, then the primary colour |
| `Welcome`, "Loading…", the failure message | `Typography`; a spinner with the message; `Typography` as an alert in the error colour |
| `test-layout` | no bare buttons or tables left |

**Looked at, not just tested:** screenshots of the running app in dark and light
mode, and with a bar collapsed, a ping pressed (the "most recent" highlight) and the
detail page open. They showed the tabs and rails, the dividers, the outlined and
enabled/disabled buttons, the registered icon on "Reset sample", and (in the first
pass) one bare `<button>` left in the sample plugin, which was migrated.

Findings and departures:

- **A real bug: plugin files were served from the HTTP cache.** While checking the
  last bare button the app kept loading an old build. `tessera-plugin://` responses
  carried no cache header, so Electron's cache kept the previous launch's
  `remoteEntry.js` and chunks, and a rebuilt or *updated* plugin could keep running
  old code. They now send `cache-control: no-cache` (a test checks). Checked in the
  app: after the caches were cleared once, a plugin rebuilt with new chunk hashes
  loaded correctly on the next launch with no clearing. (Under the old behaviour the
  cached entry would have pointed at chunks that no longer exist.)
- **MUI 9 has no system props on `Stack`** (`alignItems` and the like go in `sx`);
  one was passed through to the DOM and is fixed.
- **Buttons keep their case.** MUI upper-cases buttons by default; the theme sets
  `textTransform: 'none'`.
- **The theme change did not need `cssVariables`** for any of this (see
  [Phase 2 results](#phase-2-results)).
- **Not done:** the main area has no tab strip (a separate note), and plugin
  panels' own markup (`<h1>`, `<p>`) is still the plugin's: only controls and
  colours are themed.

## Phase 3 results

`@tessera/ui` is now the plugin-facing API for components, icons and theme
data, and the shell's glyph paths are gone.

| Piece | Where |
|---|---|
| Standard names, `RegisteredIcon` | [tessera-types/icons.ts](../tessera-types/icons.ts) |
| Standard icon components (per-icon imports) | [tessera-ui/standardIcons.ts](../tessera-ui/standardIcons.ts) |
| `Icon` (standard, registered, file URL) | [tessera-ui/Icon.tsx](../tessera-ui/Icon.tsx) |
| Lazy fetch, cache, size and type checks | [tessera-ui/iconSource.ts](../tessera-ui/iconSource.ts) |
| `useThemeState` and the registry context | [tessera-ui/themeState.tsx](../tessera-ui/themeState.tsx), [tessera-ui/iconRegistry.tsx](../tessera-ui/iconRegistry.tsx) |
| Shell-only providers | [tessera-ui/internal.ts](../tessera-ui/internal.ts) |
| Validating `shell.icons` | [shared/layout/resolveIcons.ts](../shared/layout/resolveIcons.ts) |
| `shell:icons.list` / `.changed` | [shell/main/layout/iconsIpc.ts](../shell/main/layout/iconsIpc.ts) |
| Mirrors the list in the renderer | [shell/renderer/icons/IconsProvider.tsx](../shell/renderer/icons/IconsProvider.tsx) |

**Verified in the real app:** the `test-layout` sample registers an icon
(`test-layout.ping`, a file in its `public/` folder) and uses it on the "Reset
sample" bar button. The page showed it as a `<span>` with a `blob:` mask at 20 px,
fetched over `tessera-plugin://` (so CORS works), no placeholder left, next to the
standard icons drawn as SVG components.

Findings and departures:

- **Plugin-facing and shell-only code are split.** `index.ts` is what plugins get,
  pinned by a test. `internal.ts` (the providers) is reached by the shell by path;
  both are the same module instances inside the shell, so a plugin's `Icon` sees
  the registry the shell's provider fills. A federation test proves it with a real plugin
  build.
- **The names moved to `@tessera/types`.** `tessera-ui/` may not import `shared/`,
  and both it and the main process need the list.
- **A registered id is valid for any view or bar item,** whichever plugin
  registered it, and is re-validated when icons come and go. Views and bar items
  that name an icon not (yet) registered are left out until it is, and the renderer
  is told to re-list.
- **Icon files come from the plugin's `public/` folder.** The plugin build copies
  it next to the remote entry (a test checks), and `tessera-plugin://` serves from
  there.
- **Icons are painted from an object URL, never inserted into the page.** A test
  feeds one with a `<script>`; nothing runs. This is what makes plugin SVGs safe.
- **Limits chosen for the open question:** an icon over 100 KB, a non-SVG, a
  missing file or a network error shows the placeholder, is reported once, and is
  not requested again that session.
- **`useThemeState()` is narrow:** `{ theme, mode }`, without window ids or the
  global setting. The shell's full state hook is now `useWindowTheme`.
- **Vitest needs `jsx: 'automatic'` set explicitly,** as the plugin build does:
  files outside a folder with its own tsconfig (such as `tessera-ui/`) otherwise got
  the classic runtime.

## Open questions

The earlier questions are answered and recorded in [Decisions](#decisions).
Still open, none blocking phase 1:

1. **Contrast.** Answered: warn, not reject (see [Phase 6 results](#phase-6-results)).
   Whether to *also* show the warning somewhere the plugin author sees it, such as a
   badge in the picker, is open.
2. **Plugin icon limits.** Settled for now (monochrome SVG, 100 KB, placeholder on
   failure; see [Phase 3 results](#phase-3-results)). Revisit if multi-colour icons are wanted.
3. **Contributed themes and uninstalled plugins.** Assumed: fall back to
   `tessera.default` but keep the stored selection, so it returns with the
   plugin. Or reset the selection?
4. **`@mui/x-*` community packages.** Which, if any, are exposed through
   `@tessera/ui` at launch (for example the community data grid), or does that
   wait for the first finance screen?
5. **Packaging `tessera-ui/`.** It will eventually be published alongside the
   plugin SDK (see [todo.md](todo.md#plugin-runtime)). Does it share that
   package, or version separately from `@tessera/types`?
6. **The federation warning.** Silence it (install `@tessera/ui` locally, for
   example as a workspace link) or live with it?
