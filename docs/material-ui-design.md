# Design note: Material UI, icons and pluggable themes

| | |
|---|---|
| **Status** | Phases 1–4 implemented (MUI foundations and `@tessera/ui`; the shell and `test-layout` converted; the theme service, `shell.themes`, persistence, `nativeTheme`, the View › Theme menu and the `theme-halloween` plugin; the chooser with sample and whole-window preview); phases 5–6 proposed |
| **Date** | 2026-11-01 |
| **Scope** | Converting the renderer to Material UI (MUI) for components, icons and theming; a `shell.themes` extension point so plugins can add themes; a theme chooser that previews a theme before it is applied |
| **Related** | [layout-controller-design.md](layout-controller-design.md) (the components being converted, and the icon decision this note completes), [settings-design.md](settings-design.md) (where the chooser will eventually be hosted; answers its "live apply" open question), [plugin-creation.md](plugin-creation.md) (the renderer remote and shared dependencies) |

- [Summary](#summary)
- [Context: the UI today](#context-the-ui-today)
- [Goals and non-goals](#goals-and-non-goals)
- [Decisions](#decisions)
- [Part 1: adopting Material UI](#part-1-adopting-material-ui)
  - [Packages](#packages)
  - [Sharing MUI with plugin views](#sharing-mui-with-plugin-views)
  - [The `@tessera/ui` package](#the-tesseraui-package)
  - [Icons](#icons)
  - [Styling rules](#styling-rules)
  - [Converting the shell's components](#converting-the-shells-components)
  - [Converting the sample plugin](#converting-the-sample-plugin)
- [Part 2: themes](#part-2-themes)
  - [The theme model](#the-theme-model)
  - [Tessera tokens](#tessera-tokens)
  - [The `shell.themes` extension point](#the-shellthemes-extension-point)
  - [A theme plugin](#a-theme-plugin)
  - [Components](#components)
  - [IPC, commands and menus](#ipc-commands-and-menus)
  - [Persistence](#persistence)
  - [Resolving a theme in the renderer](#resolving-a-theme-in-the-renderer)
  - [The native side](#the-native-side)
- [Part 3: choosing and previewing a theme](#part-3-choosing-and-previewing-a-theme)
  - [The chooser](#the-chooser)
  - [How preview works](#how-preview-works)
  - [Relationship to the settings dialog](#relationship-to-the-settings-dialog)
- [Key flows](#key-flows)
- [Testing](#testing)
- [Alternatives considered](#alternatives-considered)
- [Framework prerequisites](#framework-prerequisites)
- [Open questions](#open-questions)
- [Suggested phases](#suggested-phases)

## Summary

**The renderer adopts Material UI as its one component library, icon set and
theming system. The shell owns the `ThemeProvider`; plugin views inherit it
through Module Federation and never carry their own. A theme is plain data
contributed through a new `shell.themes` extension point, so a theme plugin
is a manifest and a JSON file. A chooser lets the user preview any theme,
either in a sample pane or on the whole window, before applying it.**

- **Components and icons.** Every hand-styled element in `shell/renderer`
  (buttons, tabs, rails, strips, the welcome text) becomes an MUI component
  styled through the theme, with the ARIA roles and `data-*` hooks the tests
  use kept as they are. The hand-copied glyphs in `iconGlyphs.ts` are
  replaced by `@mui/icons-material`, which they were already named after.
- **One theme for the whole application.** The shell resolves the user's
  choice (a theme id and a light, dark or system mode) into one MUI `Theme`
  and provides it at the root of the window. MUI's `CssBaseline` replaces the
  ad-hoc CSS in `index.html`. The main process sets Electron's `nativeTheme`
  to match, so menus, dialogs and the title bar follow.
- **Themes are contributions.** A plugin contributes a `ThemeContribution`:
  an id, a label, and MUI theme options as JSON for a light scheme, a dark
  scheme, or both. The main process validates and lists them, exactly as it
  does for views and bar items. Two built-in schemes, the shell's own light
  and dark, are contributed the same way, so a theme plugin has no special
  status.
- **Small extension surface for plugins.** A new `@tessera/ui` package,
  shared with remotes like React is today, gives plugin views the shell's
  named `Icon`, its `tessera` design tokens (bar, splitter, and credit and
  debit colours for finance), and nothing else. Everything else they need is
  `@mui/material`, shared as a singleton.
- **Preview before apply.** The chooser (`View › Theme…`) shows a sample of
  the UI rendered under the highlighted theme, and can temporarily restyle
  the whole window. Preview is local to the renderer of one window and is
  never persisted; Apply sends the choice to the main process, which
  persists it and pushes it to every window.

## Context: the UI today

> Written before phase 1; the files it names were replaced by the work below
> and are kept here as the record of what the conversion started from.

The renderer worked, was accessible, and was well tested, but it had no visual
system. A review of `shell/renderer` and the bundled plugins found:

| Area | What exists | Problem |
|---|---|---|
| **Styling** | Inline `style={{ … }}` objects on every element in [Bar.tsx](../shell/renderer/layout/Bar.tsx), [ItemStrip.tsx](../shell/renderer/layout/ItemStrip.tsx), [Splitter.tsx](../shell/renderer/layout/Splitter.tsx), [MainArea.tsx](../shell/renderer/layout/MainArea.tsx) and [LayoutController.tsx](../shell/renderer/layout/LayoutController.tsx); three lines of global CSS in [index.html](../shell/renderer/index.html) | Nothing reads a theme. Sizes, gaps and padding are literals repeated per component. No global reset, font or colour scheme |
| **Components** | Native `<button>`, `<h1>`, `<p>`, `<div role="tablist">` | Browser default look. Tabs, rails and strips are hand-built. No tooltips beyond `title`; no loading or error styling |
| **Icons** | Fourteen Material icon paths copied by hand into `iconGlyphs.ts`, validated by name in [shared/layout/icons.ts](../shared/layout/icons.ts), drawn by `BarIcon.tsx` | Adding an icon means copying a path. The layout design note already records the intent to swap in `@mui/icons-material` |
| **Theme** | `app-state` keeps a `theme` key (`'light'` or `'dark'`); its `useThemeState` hook writes `document.body.dataset.theme` | Nothing uses the hook and nothing reads the attribute. It is a stub |
| **Plugin views** | [SidePanel.tsx](../plugins/test-layout/src/renderer/SidePanel.tsx) and [Dashboard.tsx](../plugins/test-layout/src/renderer/Dashboard.tsx) use hard-coded colours (`#fff3c4`, `#e8e8e8`, `#ccc`) and native tables and buttons | They can't follow a dark theme, and each plugin would invent its own look |
| **Dark mode** | None. The window is white and Electron's `nativeTheme` is untouched | — |

What is already right, and which this design builds on rather than replaces:

- **Icon names are MUI's.** `ICON_NAMES` are `@mui/icons-material` export
  names, validated in the main process; `BarIcon` is the single place that
  draws them, painting plugin SVG files with `currentColor` through a mask.
- **Accessibility is in place.** Landmarks, `role="tab"`, `aria-selected`,
  `aria-current`, labelled separators and `F6` region cycling all exist and
  are what the tests query. The conversion keeps every one of them.
- **State patterns exist.** A shell-owned piece of state is a snapshot
  request plus a push event, mirrored by `createRemoteState`; contributions
  are plain data validated in `shared/` and resolved in `core/`. A theme is
  exactly such a piece of state and such a contribution.
- **Remotes share the shell's React.** The federation host and the plugin
  build already agree on a list of singleton modules. MUI joins that list.

## Goals and non-goals

**Goals**

- One component library, one icon set and one theme, used by the shell and
  by every plugin view. A plugin view written with `@mui/material` looks like
  part of the application with no styling of its own.
- No hard-coded colours, fonts or sizes anywhere in the renderer; every
  visual value comes from the theme.
- Light and dark modes, and "follow the system".
- Themes as plugins: a new theme is data, validated like any contribution,
  and a broken theme can never leave the application unusable.
- Preview a theme, in a sample and on the whole window, before applying it.
- The main process, `core/` and `shared/` stay free of MUI. It is a renderer
  concern.
- Every existing renderer test keeps passing with at most query changes
  (for instance tooltips no longer set `title`).

**Non-goals (for now)**

- Per-window themes. The theme is application-wide, like the application
  phase. (Layout is per window because users arrange windows differently;
  nobody wants one light and one dark window of the same application.)
- Themes that ship code. A contribution is JSON; component overrides are
  static objects. A `module` escape hatch for themes that need functions is
  sketched under Open questions and can be added without changing the
  contracts here.
- Theming the native menu bar beyond light and dark. Electron draws it.
- Plugin-supplied icon *sets* (replacing the shell's icons wholesale). A
  theme may adjust icon size and colour through the theme; it cannot swap
  glyphs.
- A CSS-file workflow for plugins. Plugin views style with `sx` and
  `styled`; stylesheets served over `tessera-plugin://` remain untested, as
  the plugin guide says.
- High-contrast and reduced-motion themes. They fit the model (a theme with
  a different palette and `transitions` durations) and are listed as a later
  phase.

## Decisions

| Topic | Decision |
|---|---|
| **Library** | `@mui/material` v9 (the current major; it supports React 18) with its default Emotion styling engine. One library for everything; no second UI kit, no utility-class framework |
| **Who provides the theme** | The shell, once, at the root of each window. Plugin views must not render `ThemeProvider` or `CssBaseline`. A nested `ThemeProvider` is used only by the chooser's preview pane |
| **Theme is resolved in the renderer** | The main process stores and validates *contributions* and the *selection*; the renderer turns them into an MUI `Theme` with `createTheme`. MUI never runs in the main process, so `core/` and `shared/` stay platform- and library-free |
| **One concrete theme per mode** | A contribution carries separate `light` and `dark` options over a `common` base; the shell builds one `Theme` for the resolved mode. MUI's own `colorSchemes` + `cssVariables` machinery is not used in v1 (see Alternatives): a single concrete theme is simpler to merge, to nest for preview, and to reason about in tests |
| **Themes are JSON** | A contribution is structured-cloneable, so it crosses IPC, is validated without running code, and can be previewed without loading a plugin's remote. Functions in `styleOverrides` are not supported in v1 |
| **Icons** | `@mui/icons-material`, imported by path (`@mui/icons-material/Save`) into a registry keyed by the names in `shared/layout/icons.ts`. The registry is the shell's and is exposed to plugins as `<Icon name>` through `@tessera/ui`. Plugins never depend on `@mui/icons-material` themselves |
| **Shared modules** | `@mui/material`, `@emotion/react`, `@emotion/styled` and `@tessera/ui` join `react`, `react/jsx-runtime` and `react-dom` as federation singletons, listed once in [shared/federation.ts](../shared/federation.ts). Plugins import MUI from the package root only, never from subpaths |
| **Density** | Desktop density: small controls by default, 4 px spacing unit, 13 px base font, a system font stack (no web fonts; the application must work offline) |
| **Mode** | The selection is `{ themeId, mode }` with `mode` one of `light`, `dark`, `system`. `system` is resolved in the main process from Electron's `nativeTheme`, the only place that knows it |
| **Fallback** | If the selected theme is missing (its plugin was removed) or fails to build, the shell's built-in theme for the same mode is used, the preference is kept, and the problem is logged and shown once. Like a collapsed bar whose plugin is gone, the choice comes back when the theme does |
| **Preview is renderer-local** | Preview never reaches the main process, persistence, other windows or `nativeTheme`. Apply does. Cancel, Escape or closing the chooser discards the preview |
| **Tests keep their hooks** | `data-bar`, `data-region`, `data-state`, `data-item`, `data-icon`, `data-view-id`, `data-layout` and every ARIA role and label survive the conversion unchanged |

## Part 1: adopting Material UI

### Packages

| Package | Where | Why |
|---|---|---|
| `@mui/material` | shell, shared with plugins | Components, `createTheme`, `ThemeProvider`, `CssBaseline`, `styled`, `useTheme`, `SvgIcon` |
| `@emotion/react`, `@emotion/styled` | shell, shared with plugins | MUI's styling engine. Must be singletons: Emotion's theme context is how `useTheme` and `styled` see the theme |
| `@mui/icons-material` | shell only | The icon set. Tree-shaken through path imports |
| `@tessera/ui` | repository package (`tessera-ui/`), shared with plugins | The shell's small UI surface for plugins: `Icon`, tokens, types. See below |

Vite's `optimizeDeps` should include `@mui/material` and `@mui/icons-material`
so the dev server does not re-optimise on every icon import; the renderer
config gains an alias `@tessera/ui` → `tessera-ui/index.ts`, next to the
existing `@tessera/types` alias.

### Sharing MUI with plugin views

A plugin view that imports `@mui/material` must get the **shell's copy**.
Two things break otherwise: components would read a different Emotion theme
context and render in MUI's default theme, and `useDefaultProps`
(`theme.components.*.defaultProps`) would see no overrides. Both sides of
the federation contract therefore grow:

| | Today | After |
|---|---|---|
| Shell host, [federationViewLoader.ts](../shell/renderer/views/federationViewLoader.ts) | `react`, `react/jsx-runtime`, `react-dom` | Every entry of `SHARED_MODULES`, providing the installed version (read from each package's `package.json`; `@tessera/ui` exports its own) |
| Plugin build, [build-plugins.mts](../scripts/build-plugins.mts) | same three, `import: false` | every entry of `SHARED_MODULES`, `import: false`, with its `requiredVersion` |

Both read [shared/federation.ts](../shared/federation.ts), so the two sides
cannot drift; `tests/shared/federation.test.ts` checks that the installed
packages satisfy the ranges it declares, and `tests/renderer/builtinView.test.tsx`
builds a real remote that imports `@mui/material` and `@tessera/ui` and
asserts it renders with the shell's theme.

Federation shares are keyed by the exact import specifier, so **plugins
import from the package root only**: `import { Button, useTheme } from
'@mui/material'`, never `@mui/material/Button`. A subpath import would be
bundled into the plugin as a second copy. The architecture test (see
Testing) enforces this for bundled plugins, and the plugin guide states it.
`@tessera/ui` is a repository folder, not an installed package, which the
federation plugin notices in two ways. It warns if a shared module is also
*aliased*, so the plugin build does not alias it. And for an `import: false`
share it reads the package's export names from `node_modules` to generate
static re-exports; unable to, it falls back to resolving names from the share
scope at run time (`exportModule.Icon` in the built output), which works, as
`tests/renderer/builtinView.test.tsx` proves against a real build, and warns
that it did. That warning is suppressed for `@tessera/ui` alone with the
plugin's `suppressMissingImportWarning`, since what the fallback loses, a
build-time check that an imported name exists, `tsc` provides. (Whether the
plugin honours prefix shares such as `'@mui/material/'` remains to be
checked; if it does, subpath imports can be allowed later.)

`@mui/icons-material` is deliberately **not** shared. Each icon is a tiny
wrapper around `SvgIcon`, but sharing the package root would oblige the shell
to bundle all two thousand of them. Plugins get icons through `@tessera/ui`
instead (below), or wrap their own `<path>` in `SvgIcon` from `@mui/material`.

### The `@tessera/ui` package

`tessera-types/` holds the interfaces every layer shares. `tessera-ui/` is
its renderer counterpart: React components and tokens the shell implements
and plugin views may use. It is small on purpose; it is the part of the
shell's look that plugins are allowed to depend on.

```
tessera-ui/
├── package.json          "@tessera/ui"; index.ts exports the same `version` for the federation host
├── index.ts
├── Icon.tsx              <Icon name="Save" /> from the registry; <ContributionIcon icon title /> for contributions
├── icons.ts              the registry: IconName → @mui/icons-material component
├── tokens.ts             TesseraTokens, MUI module augmentation, deriveTokens(palette)
└── mergeThemeOptions.ts  prototype-safe deep merge of theme option layers
```

```tsx
import { Icon } from '@tessera/ui'
import { Button, useTheme } from '@mui/material'

export default function RegisterToolbar() {
  const theme = useTheme()             // the shell's theme; the same object the shell renders with
  return (
    <Button size="small" startIcon={<Icon name="Add" />} sx={{ color: theme.tessera.finance.credit }}>
      New transaction
    </Button>
  )
}
```

`@tessera/ui` depends on `@mui/material` and `@mui/icons-material` and is
built into the shell bundle. It is shared with remotes as a singleton like
React, so a plugin importing it gets the shell's registry, not a copy.

### Icons

The three places icons live today become two:

| | Today | After |
|---|---|---|
| Names (main process validates against these) | `ICON_NAMES` in [shared/layout/icons.ts](../shared/layout/icons.ts) | Unchanged, and still the single list |
| Glyphs | SVG paths in `shell/renderer/layout/iconGlyphs.ts` | `tessera-ui/icons.ts`: one path import per name, `Record<IconName, ComponentType<SvgIconProps>>`. A test asserts the two lists agree |
| Drawing | `BarIcon` | `Icon` and `ContributionIcon` in `@tessera/ui`; `BarIcon` is deleted |

```ts
// tessera-ui/icons.ts
import AccountBalance from '@mui/icons-material/AccountBalance'
import Add from '@mui/icons-material/Add'
// …one import per ICON_NAMES entry
export const ICONS: Record<IconName, ComponentType<SvgIconProps>> = { AccountBalance, Add, /* … */ }
```

Two components share the registry. `Icon` takes a typed `name`, for plugins
and the shell when they know which icon they want. `ContributionIcon` takes
the `icon` string of a view or bar item as the main process resolved it and
keeps `BarIcon`'s three cases, sized on `SvgIcon`'s scale (`fontSize`
`small`, `medium`, `large` or `inherit`) so a file or an initial lines up
with the named icons beside it:

| `icon` | Rendered as |
|---|---|
| A shell icon name | `<Icon name>`: `ICONS[name]`, with `data-icon={name}` |
| A `tessera-plugin://` URL | A `Box component="span"` sized like an `SvgIcon` (`fontSize` from the theme, `1.25rem` for `small`) and painted through `mask-image` with `currentColor`, as today; `data-icon={url}` |
| Absent or unresolved | The initial of `title` in a `SvgIcon`-sized box, as today |

Growing the set means adding a name to `ICON_NAMES` and an import to
`ICONS`. Contributions with unknown names are still rejected in the main
process, so the renderer never receives a name it cannot draw.

### Styling rules

These are the conventions the conversion establishes, and the architecture
test guards the ones it can:

1. **No `style={{ … }}` for anything visual.** Use `sx` for one-offs and
   `styled()` for components with variants. The only inline styles left are
   values computed at run time that are not theme values: grid track sizes
   while a splitter is dragged, and a bar's `display: none` while collapsed.
2. **No colour, font, radius or shadow literals.** Read `theme.palette`,
   `theme.typography`, `theme.shape`, `theme.shadows`, or `theme.tessera`.
   A hex or `rgb(` literal in a `.tsx` file under `shell/renderer`,
   `tessera-ui` or `plugins/*/src/renderer` fails the architecture test.
3. **Spacing through `theme.spacing`** (`sx={{ p: 1, gap: 2 }}`), never
   pixel literals, except the layout constants the controller already owns
   (`RAIL_SIZE`, bar sizes), which are layout state, not style.
4. **Components over elements.** A clickable thing is a `Button`,
   `IconButton` or `Tab`; text is `Typography`; a surface is `Paper` or
   `Box`. Raw elements are used only for landmarks (`<main>`, `<aside>`) and
   are rendered through `Box component="aside"`, so they still take `sx`.
5. **Tooltips are `Tooltip`**, not `title`. MUI moves the text into an
   accessible description rather than a `title` attribute.
6. **Plugins don't theme.** No `ThemeProvider`, no `CssBaseline`, no global
   styles from a view. A view that needs a different look asks the theme for
   a token, and if the token does not exist, the token is added here.
7. **Numbers are tabular.** Anything showing an amount uses
   `fontVariantNumeric: 'tabular-nums'` through the `amount` typography
   variant the base theme adds (see Tessera tokens).

### Converting the shell's components

Each component keeps its props, roles, labels and `data-*` attributes, and
swaps its elements and inline styles for MUI:

| Component | Today | After | Notes |
|---|---|---|---|
| [main.tsx](../shell/renderer/main.tsx) | Providers, then `<App>` | `<ShellThemeProvider bridge={window.api}>` outermost, then the existing providers | The theme provider is first so every provider's children, including error fallbacks, are themed |
| [index.html](../shell/renderer/index.html) | `html, body, #root { margin:0; height:100%; overflow:hidden }` | `<CssBaseline enableColorScheme />` plus one `GlobalStyles` for `#root { height: 100% }` and `overflow: hidden` | `enableColorScheme` makes scrollbars and form controls follow dark mode |
| [LayoutController.tsx](../shell/renderer/layout/LayoutController.tsx) | `<div data-layout style={{ display:'grid', … }}>` | `<Box data-layout sx={{ display:'grid', height:'100vh', bgcolor:'background.default' }} style={{ gridTemplateColumns, gridTemplateRows }}>` | The computed tracks stay inline; they are state, not style |
| [Bar.tsx](../shell/renderer/layout/Bar.tsx) landmark | `<Landmark style={{ gridArea, display:'flex', … }}>` | `<Box component={Landmark} sx={{ gridArea: side, bgcolor: theme.tessera.bar.background, borderColor:'divider', … }}>` | Border on the inner edge from `divider`; keeps `data-bar`, `data-region`, `data-state`, `tabIndex={-1}` |
| Tab strip in `Bar` | `<div role="tablist">` of `<button role="tab">` | `<Tabs value={activeView} variant="scrollable" scrollButtons="auto" aria-label=…>` with `<Tab value={id} id={`tab-${id}`} aria-controls={`panel-${id}`} icon={<Icon…/>} iconPosition="start" label={title} />` | MUI `Tab` renders `role="tab"` and `aria-selected`, so the tests' queries hold. `onChange` calls `setSlot` |
| Collapse button | `<button aria-label="Collapse left bar">×</button>` | `<Tooltip title="Collapse"><IconButton size="small" aria-label="Collapse left bar"><Icon name="Close" /></IconButton></Tooltip>` | Keeps the accessible name the tests use |
| `Rail` | `<div role="toolbar">` of `<button>`s | `<Stack role="toolbar" direction={…}>` of `<Tooltip><IconButton aria-current=… sx={selected indicator}>` | Active icon gets `color="primary"` and a 2 px edge indicator from `tessera.bar.railIndicator`; the empty-bar expand button uses `ChevronRight` / `ChevronLeft` / `ExpandMore` / `ExpandLess` by side instead of `»` |
| Tab panels | `<div role="tabpanel" hidden>` | Unchanged element, `sx` for padding | `ViewPane` inside is themed through `Typography` for its placeholders |
| [ItemStrip.tsx](../shell/renderer/layout/ItemStrip.tsx) | `<div role="group">` of `<button>` / `<span>` | `<Toolbar variant="dense" disableGutters role="group" aria-label=…>`; buttons are `<Button size="small" startIcon={<Icon/>}>`; text is `<Typography variant="body2">`; clickable text is `<Button variant="text">`; `tooltip` becomes `<Tooltip>` | `data-item` stays on the button or text; `disabled` stays |
| [Splitter.tsx](../shell/renderer/layout/Splitter.tsx) | `<div role="separator" style={{ position:'absolute', … }}>` | `styled('div')` with `theme.tessera.splitter` colours on idle, hover, focus-visible and active, and a `transition` from `theme.transitions` | No MUI component models a splitter; the behaviour code is untouched |
| [MainArea.tsx](../shell/renderer/layout/MainArea.tsx) | `<main style={{ padding:20 }}>` | `<Box component="main" sx={{ p: 2.5, bgcolor:'background.default' }}>` | |
| `Welcome` in [App.tsx](../shell/renderer/App.tsx) | `<h1>`, `<p>` | `<Typography variant="h4">`, `<Typography>` | |
| `ViewPane` loading and failure in [ViewsProvider.tsx](../shell/renderer/views/ViewsProvider.tsx) | `<p>Loading…</p>`, `<p role="alert">` | `<Skeleton>` or `<CircularProgress size={16}>` with the same text, and `<Alert severity="error" role="alert">` | Text kept so `findByText('Loading …')` queries hold |
| `BarIcon.tsx`, `iconGlyphs.ts` | Hand-drawn | Deleted; `Bar` and `ItemStrip` import `ContributionIcon` from `@tessera/ui` | Done in phase 1 |

Every row of this table is implemented (phase 2). Bars also gained a
surface tint (`tessera.bar.background`, from the palette's grey ramp), since
MUI's default `paper` and `default` backgrounds are the same colour and a
bar would otherwise be told from the main area only by its divider.

### Converting the sample plugin

`test-layout` is the reference for plugin authors, so it is converted too:
`SidePanel`'s coloured box becomes a `Paper` with `bgcolor: 'action.selected'`
when it is the most recent and `Chip` for the count; `Dashboard`'s table
becomes `Table` with `size="small"`; buttons become `Button`. Its tests query
by role and text and need no change. The plugin guide's "Writing a view"
section gains a short "Styling a view" subsection pointing at `@mui/material`,
`@tessera/ui` and the rules above.

## Part 2: themes

### The theme model

A **theme** is a named look that may define a light scheme, a dark scheme, or
both. The user's **selection** is a theme id plus a mode. The shell
**resolves** the pair into one MUI `Theme`:

```
 selection { themeId: 'solarized.main', mode: 'system' }
        │                                      │
        │             nativeTheme.shouldUseDarkColors  (main process)
        ▼                                      ▼
 contribution 'solarized.main'      resolvedMode = 'dark'
   { common, light, dark }                     │
        └──────────────┬───────────────────────┘
                       ▼   (renderer)
   createTheme(deepmerge(SHELL_BASE, common, dark, { palette: { mode: 'dark' } }))
                       │
                       ▼
   + tessera tokens, defaulted from the palette where the theme gave none
                       │
                       ▼
   <ThemeProvider theme>  →  the window
```

`SHELL_BASE` (`shellBaseOptions(mode)` in `createShellTheme.ts`) is the
shell's own `ThemeOptions`: density, typography scale, the `amount` variant
and component default props (`size: 'small'`, `disableElevation`); the
`tessera` tokens are derived from the resulting palette by `deriveTokens`.
Every theme is layered on it with `mergeThemeOptions`, so a contribution only
says what differs. The shell's built-in theme is an *empty* contribution
over the base: `shell.default`, with `light: {}` and `dark: {}`.

Options a contribution may set are the JSON subset of MUI's `ThemeOptions`:

| Key | Allowed | Not allowed |
|---|---|---|
| `palette` | Any palette colour, `contrastThreshold`, `tonalOffset`. `mode` is set by the shell from the scheme and is ignored if present | — |
| `typography` | Font families, sizes, weights, per-variant objects, `amount` | Functions (`pxToRem`) |
| `shape`, `spacing` | `borderRadius`; `spacing` as a number | `spacing` as an array or function |
| `shadows`, `zIndex`, `transitions.duration`, `transitions.easing` | Plain values | `transitions.create` |
| `components` | `defaultProps` and `styleOverrides` as plain objects, `variants` with object `props` and `style` | `styleOverrides` as functions. Use theme-independent values, or a `tessera` token the shell substitutes (see below) |
| `tessera` | Any token in `TesseraTokens` | — |

Because `styleOverrides` cannot be functions, a JSON theme cannot write
`({ theme }) => ({ color: theme.palette.primary.main })`. In practice a theme
sets its palette and lets MUI derive component colours; when an override does
need a palette colour the same theme defined, it writes the literal. This is
the trade-off for themes that are pure data; the `module` escape hatch in
Open questions lifts it if it proves too tight.

### Tessera tokens

MUI's theme covers MUI's components. The shell's own surfaces and the
finance domain need a few more values, declared once and merged into every
theme through MUI's module augmentation:

```ts
// tessera-ui/tokens.ts
export interface TesseraTokens {
  bar: {
    background: string        // a bar's surface
    railBackground: string    // the collapsed rail
    railIndicator: string     // edge mark on the active rail icon
    tabStripBorder: string
  }
  splitter: { idle: string, hover: string, active: string }
  finance: {
    credit: string            // money in
    debit: string             // money out
    transfer: string
    reconciled: string
    uncleared: string
  }
}

declare module '@mui/material/styles' {
  interface Theme { tessera: TesseraTokens }
  interface ThemeOptions { tessera?: DeepPartial<TesseraTokens> }
  interface TypographyVariants { amount: React.CSSProperties }
  interface TypographyVariantsOptions { amount?: React.CSSProperties }
}
declare module '@mui/material/Typography' {
  interface TypographyPropsVariantOverrides { amount: true }
}
```

A theme may set any of them; the ones it leaves out are **derived from its
palette** when the theme is resolved (`bar.background` from
`background.paper`, `splitter.hover` from `primary.main`, `credit` from
`success.main`, `debit` from `error.main`, and so on). So a theme that only
sets a palette still gets coherent bars and amounts, and a theme that cares
can tune them.

Tokens are added here, in one place, when a shell surface or a finance
plugin needs one. A plugin must not invent colours; it asks for a token.

### The `shell.themes` extension point

Contributed from a plugin's privileged `activate`, as views and bar items
are, and validated in `shared/themes/resolveThemes.ts` the same way
`resolveViews` validates views:

```ts
// shared/themes/types.ts
export const THEMES_EXTENSION_POINT = 'shell.themes'

export interface ThemeContribution {
  /** Plugin-prefixed, like every contribution: 'solarized.main'. */
  id: string
  label: string
  description?: string
  /** Options both schemes share: typography, shape, component defaults. */
  common?: ThemeOptionsJson
  /** At least one of these. A theme with only one is still offered in the other mode, using the one it has. */
  light?: ThemeOptionsJson
  dark?: ThemeOptionsJson
  /**
   * Colours the chooser shows as the theme's swatch, per scheme. Derived from
   * the palette (background, paper, primary, text) when absent.
   */
  swatch?: { light?: string[], dark?: string[] }
  /** Lower sorts first in the chooser. Ties keep registration order. */
  order?: number
}

/** What the renderer receives: the contribution, who made it, and which schemes it has. */
export interface ThemeDescriptor extends ThemeContribution {
  pluginId: string
  /** Which schemes are present, so the chooser can say "light only". */
  schemes: ('light' | 'dark')[]
}
```

Validation in the main process is structural; it does not build the theme:

- `id` and `label` are non-empty strings; `id` is unique. Duplicates are
  ignored with a `[themes]` warning, like duplicate views.
- At least one of `light` and `dark` is present, and each present one is a
  plain object.
- `common`, `light` and `dark` are **structured-cloneable plain data**: no
  functions, no class instances, no `__proto__` / `constructor` /
  `prototype` keys anywhere (the options are deep-merged), and the whole
  contribution serialises to under 256 KB. A contribution failing any of
  these is skipped and logged.
- `swatch` entries and `order` have the right types.

Whether the options *build* a sensible MUI theme is decided in the renderer,
where `createTheme` runs, with the fallback described below. The main
process's job is to make sure nothing dangerous or unserialisable crosses
IPC.

### A theme plugin

A theme plugin needs only a manifest, a privileged entry and a JSON file. It
has no renderer remote unless it ships fonts.

```
solarized/
├── manifest.json
├── themes/
│   └── solarized.json
└── src/privileged/index.js
```

```json
{ "id": "solarized", "name": "Solarized", "version": "0.1.0",
  "privileged": { "entry": "privileged/index.js" } }
```

```js
// src/privileged/index.js
const theme = require('../../themes/solarized.json')   // bundled into the entry by the plugin build

exports.activate = (context) => {
  context.subscriptions.push(
    context.extensions.contribute('solarized', 'shell.themes', theme.id, theme))
}
```

```json
// themes/solarized.json
{
  "id": "solarized.main",
  "label": "Solarized",
  "description": "Ethan Schoonover's palette, both variants.",
  "common": {
    "shape": { "borderRadius": 2 },
    "typography": { "fontFamily": "\"Source Sans 3\", system-ui, sans-serif" }
  },
  "light": {
    "palette": {
      "primary": { "main": "#268bd2" }, "secondary": { "main": "#2aa198" },
      "background": { "default": "#fdf6e3", "paper": "#eee8d5" },
      "text": { "primary": "#586e75", "secondary": "#93a1a1" }
    },
    "tessera": { "finance": { "credit": "#859900", "debit": "#dc322f" } }
  },
  "dark": {
    "palette": {
      "primary": { "main": "#268bd2" }, "secondary": { "main": "#2aa198" },
      "background": { "default": "#002b36", "paper": "#073642" },
      "text": { "primary": "#93a1a1", "secondary": "#657b83" }
    }
  }
}
```

Contributing and disposing through `context.subscriptions` means a theme
disappears when its plugin deactivates, and the shell falls back as
described under Persistence. Nothing about a theme plugin is special: the
shell's own `shell.default` is registered through the shell's plugin
context in `registerTheme`, just as its menus are.

**Fonts.** A theme that wants its own typeface ships the files in a renderer
folder (`"renderer": { "entry": "renderer/fonts.js" }` with a trivial entry
so the folder is served at `tessera-plugin://solarized/`) and declares them
through `MuiCssBaseline`:

```json
"common": {
  "components": { "MuiCssBaseline": { "styleOverrides":
    "@font-face { font-family: 'Source Sans 3'; src: url('tessera-plugin://solarized/fonts/SourceSans3.woff2') format('woff2'); }" } }
}
```

`styleOverrides` for `MuiCssBaseline` accepts a string, so this stays JSON.

### Components

```
 plugin (privileged)                             shell (renderer)
 ───────────────────                             ────────────────
 context.extensions.contribute(                  <ShellThemeProvider>
   id, 'shell.themes', themeId, { … })             list + selection (remote state)
        │                                          resolveTheme(descriptor, mode) → Theme
        ▼                                          preview override
 ┌──────────────────────────────────┐   IPC        <ThemeProvider><CssBaseline/>…
 │ core: ThemeService               │◄──────────►        ▲
 │  contributions (validated)       │                    │ useShellTheme(): { applied, preview(), … }
 │  selection, resolved mode        │             ┌──────┴────────────┐
 │  fallback when theme is missing  │             │ ThemePicker       │  View › Theme…
 │  events: themes.changed,         │             │  list, mode, sample pane, window preview,
 │          theme.changed           │             │  Apply / Cancel    │
 └───────┬──────────────┬───────────┘             └───────────────────┘
         │ ports        │
         ▼              ▼
 ThemePersistence   SystemModeSource        adapters in shell/main:
  (app.state        (nativeTheme:            registerTheme.ts — IPC, commands, View menu,
   'shell.theme')    isDark, onDidChange)    nativeTheme.themeSource, window backgroundColor
```

| Component | Lives in | Responsibility |
|---|---|---|
| `ThemeContribution`, `ThemeDescriptor`, `ThemeSelection`, channel names | `shared/themes/types.ts` | Contracts both processes use |
| `resolveThemes` | `shared/themes/resolveThemes.ts` | Validates and orders contributions; returns descriptors and diagnostics, like `resolveViews` |
| `ThemeService` | `core/theme/ThemeService.ts` | Reads `shell.themes` from the extension registry, holds the selection, resolves `system` through a `SystemModeSource` port, falls back when the selected theme is absent, loads and saves through a `ThemePersistence` port, publishes change events. Platform-free, like `LayoutService` |
| `registerTheme` | `shell/main/theme/registerTheme.ts` | Answers the IPC requests, publishes the push events, registers the `shell.theme.*` commands and the View-menu items, contributes `shell.default`, and mirrors the resolved mode into `nativeTheme.themeSource` |
| `nativeThemeSource` | `shell/main/theme/nativeThemeSource.ts` | `SystemModeSource` adapter over Electron's `nativeTheme` |
| `createAppStateThemePersistence` | `shell/main/theme/appStatePersistence.ts` | `ThemePersistence` over the `app.state` service, like the layout's |
| `ShellThemeProvider`, `useShellTheme` | `shell/renderer/theme/ShellThemeProvider.tsx` | Mirrors the list and the selection, builds and memoises the applied theme, holds the preview override, renders `ThemeProvider` and `CssBaseline` |
| `createShellTheme`, `shellBaseOptions` | [shell/renderer/theme/createShellTheme.ts](../shell/renderer/theme/createShellTheme.ts) | Pure: mode + option layers → MUI `Theme`, with token defaulting; the only caller of `createTheme`. `resolveTheme` (phase 3) adds the descriptor handling and the fallback on top |
| `ThemePicker`, `ThemeSample`, `ThemePickerHost` | `shell/renderer/theme/` | The chooser, its preview pane, and the host that opens it on the push event |
| `Icon`, `ContributionIcon`, `ICONS`, `TesseraTokens`, `deriveTokens`, `mergeThemeOptions` | `tessera-ui/` | The surface plugins import |

### IPC, commands and menus

Names follow the shell's convention (`shell:<event>`), and the state follows
the snapshot-plus-events pattern:

| Channel | Direction | Payload |
|---|---|---|
| `shell:themes.list` | request | → `ThemeDescriptor[]`, in chooser order |
| `shell:themes.changed` | push | none; re-request the list (a plugin's theme arrived or left) |
| `shell:theme.get` | request | → `ThemeSelection` `{ themeId, mode, resolvedMode, effectiveThemeId }` |
| `shell:theme.set` | request | `{ themeId?, mode? }` → `ThemeSelection`. Rejects an unknown theme id or mode with `BAD_REQUEST`; applying a theme that lacks the resolved scheme is allowed (it is shown in the scheme it has) |
| `shell:theme.changed` | push | `ThemeSelection`, to every window |
| `shell:theme.picker.open` | push | `{ windowId }`; the named window opens the chooser, the others ignore it, as `shell:layout.revealed` works |

`effectiveThemeId` is the theme actually in use: the selected one, or
`shell.default` while the selected one is missing. The chooser highlights
the *selected* id and marks the fallback, so a user whose theme plugin is
disabled sees why.

| Command | Accelerator | Effect |
|---|---|---|
| `shell.theme.choose` | — | Opens the chooser in the focused window (View › Theme › &Choose Theme…) |
| `shell.theme.set` | — | Arguments: a `ThemeSet`, or (`themeId`, `mode`). For plugins and scripts |
| `shell.theme.toggleMode` | `CmdOrCtrl+Shift+D` | Light ↔ dark. From `system`, goes to the opposite of the resolved mode (View › Toggle &Dark Mode) |
| `shell.theme.mode.<light\|dark\|system>` | — | One per mode, for the menu |
| `shell.theme.use.<themeId>` | — | One per theme, registered and withdrawn as themes come and go, for the menu |

The **View › Theme** submenu (a `shell.theme` group of the View menu with
`SHELL_GROUP_ORDER + 2`, under the layout groups) lists the three modes, then
every theme by label, then *Choose Theme…*. It is built once after plugins
activate, so it holds every theme they contributed; until the chooser exists
(phase 4) it is how a theme is picked. Context keys `shell.theme.id`,
`shell.theme.mode` and `shell.theme.resolvedMode` are published so plugins
can react (a chart plugin choosing a dark colour ramp) without a renderer
subscription.

### Persistence

| | |
|---|---|
| Key | `shell.theme` in `app.state` |
| Value | `{ themeId: string, mode: 'light' \| 'dark' \| 'system' }` |
| Default | `{ themeId: 'shell.default', mode: 'system' }` |
| Written | On every successful `shell:theme.set`, through `ThemePersistence`; never by preview |
| Read | At startup by `ThemeService`, before the first window is created, so the window's background and `nativeTheme` are right before the page loads |
| Migration | The old `theme` key, a bare `'light'` or `'dark'`, is read once if `shell.theme` is absent, becomes `{ themeId: 'shell.default', mode }`, and the old key is removed. The unused `useThemeState` hook and its `document.body.dataset.theme` go |
| Damaged value | Fields fall back individually to the defaults, as `restoreWindowState` does |
| Missing theme | The selection is **kept** and `effectiveThemeId` falls back to `shell.default`. When a contribution with the selected id appears (the plugin was re-enabled), `theme.changed` is published and the theme comes back, with no user action |

### Resolving a theme in the renderer

`resolveTheme(descriptor, resolvedMode)` is pure and is the only code that
calls `createTheme`:

1. Pick `scheme = descriptor[resolvedMode] ?? descriptor[otherMode]`.
2. `options = deepmerge(SHELL_BASE(resolvedMode), descriptor.common, scheme)`,
   then force `palette.mode = resolvedMode`. `deepmerge` is MUI's own
   (`@mui/utils`), which `createTheme` uses for the same job; it merges
   objects and replaces arrays and scalars.
3. `theme = createTheme(options)`; then fill every `tessera` token the
   options did not set from the resulting palette.
4. Sanity checks that `createTheme` does not make: `palette.background.default`
   and `text.primary` are parseable colours with readable contrast
   (`getContrastRatio` ≥ 3), `typography.fontSize` is a finite number in
   8–32. A theme failing these is treated like one that threw.
5. On any throw, return `{ theme: resolveTheme(SHELL_DEFAULT, resolvedMode), problem }`.
   The provider logs `[themes] …`, shows one `Snackbar` naming the theme and
   its plugin, and uses the fallback until the list or selection changes.

Built themes are memoised by `(descriptor.id, descriptor.pluginId, resolvedMode,
JSON.stringify(descriptor))`, so switching back and forth in the chooser does
not rebuild, and a plugin re-contributing identical options does not
re-render the window.

### The native side

MUI does not draw the menu bar, native dialogs, context menus, the title bar
or the window frame. Two small things keep them consistent:

- **`nativeTheme.themeSource`** is set to the resolved mode whenever the
  selection changes (and to `'system'` when the mode is `system`), so the
  menu bar, `dialog.showMessageBox` and the title bar go dark with the
  application.
- **`BrowserWindow({ backgroundColor, show: false })` with `ready-to-show`**,
  where `backgroundColor` is the effective theme's
  `palette.background.default` for the resolved mode, read from the
  contribution JSON (or the shell's default for the mode). This is why the
  service loads the selection before the first window is created: without it
  a dark theme flashes white while the renderer boots.

## Part 3: choosing and previewing a theme

### The chooser

`View › Theme…` runs `shell.theme.choose`, which publishes
`shell:theme.picker.open` for the focused window. `ThemePickerHost`,
mounted once in `App`, opens an MUI `Dialog`:

```
┌─ Theme ───────────────────────────────────────────────────────────────┐
│ Mode:  ( ) Light   (•) Dark   ( ) System  — currently dark            │
│                                                                       │
│ ┌─ Themes ───────────────┐ ┌─ Preview ─────────────────────────────┐  │
│ │ Built in               │ │ ┌───────────────────────────────────┐ │  │
│ │  ■■■■ Tessera        ✓ │ │ │ ≡ Accounts   [Save] [Add] … 🔍    │ │  │
│ │ Solarized              │ │ ├───────────────────────────────────┤ │  │
│ │  ■■■■ Solarized      ● │ │ │ Register  Budget  Reports         │ │  │
│ │ Nord                   │ │ │ Date     Payee        Amount      │ │  │
│ │  ■■■■ Nord  light only │ │ │ 03 Nov   Grocer       −42.17      │ │  │
│ │                        │ │ │ 04 Nov   Salary     2 100.00      │ │  │
│ │                        │ │ │ [ Payee ________ ] [Primary][Text]│ │  │
│ │                        │ │ │ ⓘ An information message.         │ │  │
│ └────────────────────────┘ │ └───────────────────────────────────┘ │  │
│                            │ [ ] Preview in the whole window       │  │
│                            └───────────────────────────────────────┘  │
│                                                    [ Cancel ] [ Apply ]│
└───────────────────────────────────────────────────────────────────────┘
```

- **Themes list**: a `List` grouped by contributor (`Built in`, then each
  plugin's `name`), each entry a row of four swatch colours for the chosen
  mode, the label, and a badge when the theme has only one scheme. The
  applied theme is ticked; the highlighted one (the **candidate**) is
  selected. Arrow keys move the highlight, which updates the preview, so
  the whole chooser works from the keyboard.
- **Mode**: a `ToggleButtonGroup` (Light / Dark / System, with the resolved
  system mode shown), part of the candidate.
- **Preview pane**: `ThemeSample`, a fixed set of components that together
  show what a theme changes: an app-bar-like strip with icons, a tab strip,
  a small register table using the `amount` variant and the `credit` and
  `debit` tokens, a text field, the button variants, a chip and an alert. It
  is static content; nothing in it is wired to the application.
- **Preview in the whole window**: a `Switch`. While on, the window renders
  under the candidate, including the chooser itself, so the user sees bars,
  tabs and their real views in the theme.
- **Apply**: `invoke('shell:theme.set', candidate)`. The dialog closes when
  the main process has answered; the `shell:theme.changed` it pushes then
  restyles every window, this one included, and since the candidate was
  already previewed or sampled nothing jumps. If the main process refuses
  (an unknown theme), the dialog stays open and shows the error. **Cancel**,
  Escape and the backdrop discard the candidate.
- **Fallback notice**: when `effectiveThemeId !== themeId`, an `Alert` above
  the list says the selected theme is not available and what is being used.

### How preview works

The theme provider has two inputs and one output:

```ts
interface ShellThemeContext {
  themes: ThemeDescriptor[]
  selection: ThemeSelection                     // mirrored from main
  applied: Theme                                // built from selection
  preview(candidate?: ThemeSelectionCandidate): void   // undefined clears
  previewing: boolean
}
// rendered theme = preview candidate's theme, if any, else applied
```

Two kinds of preview use it:

| Preview | Mechanism | Scope |
|---|---|---|
| **Sample pane** | `<ThemeProvider theme={resolveTheme(candidate, mode)}>` nested around `ThemeSample`. MUI's `ThemeProvider` supports nesting; with one concrete theme per mode and no CSS variables the inner theme is fully self-contained | The pane only |
| **Whole window** | `preview(candidate)`: the provider renders the root `ThemeProvider` with the candidate's theme instead of `applied` | This window, including the chooser |

Both build the candidate through the same memoised `resolveTheme`, so the
sample and the window cannot disagree, and a theme that fails to build shows
its fallback in the preview too, with the problem text under the pane rather
than a `Snackbar`. A candidate in `system` mode uses `selection.resolvedMode`
from the main process, which is the only place that knows the system setting.

The preview is **discarded** whenever the chooser unmounts (an effect
cleanup calls `preview(undefined)`), so there is no way to leave the window
in a previewed state. If `themes.changed` removes the candidate while it is
highlighted, the candidate resets to the selection.

Nothing about preview touches the main process: no IPC, no persistence, no
`nativeTheme`, no other window. This is what makes Cancel trivially correct
and is the answer to the settings design's open question about live apply:
**preview is a renderer-local override of a value the renderer already
computes, and apply is the ordinary request.** The same shape serves any
future setting with a visible effect.

### Relationship to the settings dialog

The settings framework in [settings-design.md](settings-design.md) is not
built. The chooser is therefore a self-contained dialog now. When settings
arrive, `ThemePicker` becomes the content of a shell-contributed
`shell.settings.appearance` page with no change to its data flow: the
settings draft holds the candidate, the page's `onChange` feeds
`preview()`, and OK or Apply commits through `shell:theme.set` rather than
the page's namespace (the theme is framework state, not a plugin setting).
The `View › Theme…` item then opens the settings dialog on that page.

## Key flows

### Startup

1. `bootstrap` creates `ThemeService` with the `app.state`-backed
   persistence and the `nativeTheme` source. It loads `shell.theme`
   (migrating the old `theme` key if needed) and resolves the mode.
2. `registerTheme` contributes `shell.default`, registers the IPC handlers,
   commands and menu items, and sets `nativeTheme.themeSource`.
3. Plugins activate and contribute their themes. `ThemeService` re-resolves
   on every `shell.themes` change; if the persisted id has now appeared,
   `effectiveThemeId` switches to it.
4. `createWindow` asks the service for the effective background colour and
   opens the window hidden with it.
5. The renderer mounts `ShellThemeProvider`, which requests the list and the
   selection. Until both arrive it renders the built-in theme in the mode
   `prefers-color-scheme` reports. Electron derives that media query from
   `nativeTheme.themeSource`, which step 2 already set, so the first frame
   has the right mode and only the built-in palette; with a non-default
   theme selected, that frame is hidden behind `ready-to-show`.
6. The snapshot arrives; the provider builds and applies the theme.

### Change the theme

1. The user opens `View › Theme…`. The command publishes
   `shell:theme.picker.open { windowId }`; the window opens the chooser with
   the candidate equal to the selection.
2. The user arrows through the list: each highlight builds the candidate's
   theme (memoised) and the sample pane re-renders. They turn on whole-window
   preview: `preview(candidate)`, the window restyles.
3. Apply: `invoke('shell:theme.set', { themeId, mode })`. The service
   validates, saves, sets `nativeTheme`, and publishes `shell:theme.changed`
   to every window.
4. Each window's provider applies the new selection. The originating window's
   chooser sees `selection` now equal to the candidate, clears the preview
   and closes.

### A theme plugin is removed while selected

1. The plugin deactivates; its `contribute` disposable runs; the registry
   fires `onDidChange` for `shell.themes`.
2. `ThemeService` re-resolves: the selected id is gone, so
   `effectiveThemeId = 'shell.default'`. It publishes `themes.changed` and
   `theme.changed`, and sets the window background for future windows.
3. Every window re-lists, rebuilds with the built-in theme, and shows one
   `Snackbar`: "Theme *Solarized* is no longer available; using Tessera."
4. The persisted selection is unchanged. Reinstalling the plugin brings the
   theme back on the next start, with no user action.

### The system switches to dark

1. `nativeTheme` fires `updated`; the adapter calls the service's listener.
2. If the mode is `system`, `resolvedMode` changes; the service sets
   `nativeTheme.themeSource` (a no-op for `system`), and publishes
   `theme.changed` with the new `resolvedMode`.
3. Windows rebuild with the dark scheme. Any open chooser keeps its
   candidate and re-renders its preview.

## Testing

The existing suites, and what the conversion adds:

| Area | Tests |
|---|---|
| Renderer layout (`tests/renderer/*`) | Unchanged queries by role, label and `data-*`. Changes are limited to: tooltip assertions use `findByRole('tooltip')` after hover or `aria-describedby` instead of `findByTitle`; the rail's expand button is found by its label, not `»`. `renderFrame` in [tests/helpers/layoutFrame.tsx](../tests/helpers/layoutFrame.tsx) wraps the tree in `ShellThemeProvider` with a fake bridge answering the theme requests |
| `tests/shared/themes.test.ts` | `resolveThemes`: valid contribution, missing schemes, functions rejected, prototype keys rejected, size limit, duplicate id, ordering |
| `tests/core/themeService.test.ts` | Selection and persistence, migration of the old `theme` key, `system` resolution through a fake source, fallback when the theme is absent and return when it reappears, events published once per change |
| `tests/renderer/resolveTheme.test.ts` | Base merge order, `palette.mode` forced, token defaulting, memoisation, fallback on throw and on the contrast check |
| `tests/renderer/shellThemeProvider.test.tsx` | Applies the snapshot, follows `theme.changed`, preview overrides and is cleared, `Snackbar` on fallback |
| `tests/renderer/themePicker.test.tsx` | Opens on the push event for its window only; arrowing changes the sample; whole-window preview restyles outside the dialog; Cancel restores; Apply invokes `shell:theme.set` and closes on the event; nothing is invoked before Apply |
| `tests/ui/icons.test.tsx`, `tests/ui/mergeThemeOptions.test.ts` | Every `ICON_NAMES` entry has a component in `ICONS`, and vice versa; `ContributionIcon` renders each case with the right `data-icon`; merging is prototype-safe and leaves inputs alone |
| `tests/shared/federation.test.ts`, `tests/renderer/builtinView.test.tsx` | The installed packages satisfy `SHARED_MODULES`; a remote built by the real plugin build imports `@mui/material` and `@tessera/ui` and renders with the shell's theme |
| `tests/architecture/boundaries.test.ts` | Plugins import only `@tessera/types`, `@tessera/ui` and the shared UI packages (renderer side), Node (privileged side), their own files and their own npm dependencies: never `core/`, `shared/`, `shell/`, Electron or another plugin. New UI rules: `core/`, `shared/`, `shell/main`, `shell/preload` and `tessera-types` import nothing from `@mui/*`, `@emotion/*` or `@tessera/ui`; `tessera-ui` depends only on `shared/`; renderer code imports the shared packages from the root only (`package.json` reads and the icon registry excepted) and plugins never import `@mui/icons-material`; no hex, `rgb(` or `hsl(` literal in `shell/renderer` or `tessera-ui` outside `shell/renderer/theme/` and `tokens.ts` (extended to `plugins/*/src/renderer` in phase 2, when `test-layout` is converted) |
| Main adapters | `registerTheme` sets `nativeTheme.themeSource` on every change, against the existing Electron mock |

MUI renders under jsdom without special setup. Emotion inserts `<style>`
elements into `document.head`, which jsdom accepts; tests that assert on
computed colours should read `theme.palette` from `useTheme` in a probe
component rather than `getComputedStyle`, which jsdom does not fully
implement.

## Alternatives considered

| Alternative | Why not |
|---|---|
| **Plain CSS with custom properties, no component library** | Would need a hand-built tab, tooltip, menu, dialog, list and table with accessibility done by hand, which is the work MUI has already done. The icon names and the layout note already committed to MUI |
| **Another library (Fluent, Radix + Tailwind, Chakra)** | Each is viable, but none changes the design here. MUI has the largest icon set, theme-as-data support, and a desktop-dense configuration, and the project had already chosen it |
| **MUI's `colorSchemes` + `cssVariables`** | Attractive (mode switch without re-render, `var(--mui-…)` usable from plain CSS), but the CSS variables are attached to `:root`, so a nested `ThemeProvider` for the preview pane needs a distinct `cssVarPrefix` and scheme selector, and the merge of a contribution's `light` and `dark` into one `colorSchemes` theme has more edge cases. One concrete theme per mode is simpler and the upgrade path is open: a later phase can build `colorSchemes` from the same contribution |
| **Themes as code (a federation module exporting `ThemeOptions`)** | Full power, including functional `styleOverrides`, but a theme then needs a renderer build, cannot be validated without executing it, and cannot be previewed before its remote is loaded. Kept as an escape hatch (Open questions), not the default |
| **A static `contributes.themes` section in the manifest** | Would let the shell list themes without activating the plugin. The manifest has no `contributes` section today and every other contribution comes from `activate`; adding one just for themes would be inconsistent. Revisit if "declared extension points" lands |
| **Sharing `@mui/icons-material` with remotes** | The shell would have to bundle the whole package. Plugins use the named registry or `SvgIcon` |
| **Per-window theme** | No use case, and `nativeTheme` is process-wide anyway |
| **Preview by rendering the sample in an `<iframe>`** | Perfect isolation, but a second document, a second React root and a second copy of the bundle for a preview pane. Nested `ThemeProvider` is enough once themes are concrete |
| **Preview through the main process (apply, then revert on Cancel)** | Every window would flicker, persistence would see intermediate states, and a crash mid-preview would leave the wrong theme saved. Renderer-local preview has none of these |
| **`title` attributes kept alongside `Tooltip`** | Double tooltips (native and MUI). The tests change instead |

## Framework prerequisites

None of these block phase 1; the later phases depend on them as noted.

1. **Push events to one window.** `shell:theme.picker.open` carries a
   `windowId`, as `shell:layout.revealed` does, and the others ignore it.
   Good enough; the todo item "events to one window" would let the service
   target the window directly.
2. **Plugin build bundles JSON.** `require('../../themes/solarized.json')` in a
   privileged entry works with esbuild's default JSON loader; confirm the
   bundled-plugin build passes it through.
3. **`@tessera/ui` as a repository package.** Alias in the renderer Vite
   config, the plugin build, `vitest.config.ts` and the tsconfigs, mirroring
   `@tessera/types`.
4. **Federation shares.** Both lists grow (see Sharing MUI). A mismatch shows
   up as "Invalid hook call" or an unthemed view; the plugin guide's
   troubleshooting table gains those rows.

## Open questions

1. **A `module` escape hatch for themes.** `{ module: './theme' }` loaded
   from the plugin's remote and default-exporting `ThemeOptions` (functions
   allowed), merged after the JSON. Cheap to add; the question is whether a
   theme that needs it should rather ask for a token.
2. **Version skew between a plugin's MUI and the shell's.** `requiredVersion`
   on the share catches a plugin built against a different major, and the
   loader logs it. Should the view then render unthemed, or not at all?
   Leaning: not at all, with the usual "could not be displayed" boundary.
3. **Emotion and a content security policy.** When the renderer gets a CSP
   (the "plugin trust" work), Emotion's injected styles need a nonce through
   a `CacheProvider`. The provider is the natural place; nothing here
   prevents it.
4. **Swatches for the chooser** are derived from the palette unless given.
   Is four colours enough to tell themes apart, or should the list show a
   miniature of the sample?
5. **Should `mode` be per theme?** Today the mode is global and a theme
   lacking that scheme shows the one it has. The alternative, remembering a
   mode per theme, is more state for little gain.
6. **Accent colour from the OS.** Electron exposes `systemPreferences
   .getAccentColor()` on Windows and macOS. A theme could opt in to use it
   as `primary.main`. Fits the `SystemModeSource` port; not in v1.
7. **Reduced motion.** `transitions.duration` can be zeroed by a theme, but
   respecting the OS setting should be the shell's job, through
   `useMediaQuery('(prefers-reduced-motion)')` in the provider.
8. **Plugin-specific icons beyond the registry.** `SvgIcon` with a path is
   the answer today. If plugins keep asking for registry additions, the
   registry could accept a plugin-contributed `shell.icons` point. Not
   needed yet.

## Suggested phases

1. **Foundations** — *done*. The packages; `tessera-ui/` with `ICONS`,
   `Icon`, `ContributionIcon`, `TesseraTokens`, `deriveTokens` and
   `mergeThemeOptions`; `iconGlyphs.ts` and `BarIcon` replaced;
   `createShellTheme` with the built-in light and dark; `ShellThemeProvider`
   rendering the built-in theme from `prefers-color-scheme` with
   `CssBaseline` and the page styles that were in `index.html`;
   `shared/federation.ts` feeding both federation share lists, verified by a
   fixture remote that renders with the shell's theme; the architecture
   rules. Visible change: only the default font, size and baseline.
2. **Convert the shell** — *done*. `LayoutController`, `Bar`, `Rail`,
   `ItemStrip`, `Splitter`, `MainArea`, `Welcome` and the `ViewPane`
   placeholders follow the component table; the only inline styles left are
   the computed grid tracks. Two renderer tests changed as predicted (the
   rail's and the items strip's tooltips are now `Tooltip`s, found by
   hovering), the rest passed unchanged. `test-layout` is converted and the
   colour-literal rule now covers plugin views. Two MUI 9 rules learned on
   the way, recorded in the plugin guide: system props (`alignItems`,
   `fontWeight`, …) go in `sx`, not as props, and `Typography`'s `paragraph`
   is gone.
3. **Theme service and extension point** — *done*. `tessera-types/theme.ts`
   and `shared/themes` (contracts, `resolveThemes`), `core/theme/ThemeService`
   with its `SystemModeSource` and `ThemePersistence` ports, the adapters in
   `shell/main/theme` (`nativeTheme`, `app.state` persistence with migration
   of the old `theme` key, `registerTheme`), `shell.default` as a
   contribution, IPC, commands, the View › Theme submenu, context keys,
   `nativeTheme.themeSource`, the window's `backgroundColor` with
   `ready-to-show`, `resolveTheme` with its sanity checks and fallback, the
   provider following the main process with a `preview()` override ready
   for the chooser, and the `Snackbar` on fallback. The
   `plugins/theme-halloween/` plugin (phase 5's sample, brought forward) is
   the first theme plugin: a manifest, a privileged entry and a JSON file.
4. **Chooser and preview** — *done*. `ThemePicker`, `ThemeSample` and
   `ThemePickerHost` in `shell/renderer/theme/`, opened by
   `shell:theme.picker.open` for the named window only; themes grouped by
   plugin with swatches (given or derived from the built palette) and a
   "dark only" chip; the mode toggle with the resolved system mode shown; the
   sample under a nested `ThemeProvider`; the whole-window switch through
   the provider's `preview()`, ended by Cancel, Escape, the backdrop or
   unmounting; Apply through `shell:theme.set`, closing once answered, or
   staying open with the error; the fallback notice; arrow keys in the list.
   `apply()` and `onChooserRequested()` joined the provider's context so the
   chooser needs no bridge of its own. Tests: `tests/renderer/themePicker.test.tsx`.
5. **The guide.** The sample theme plugin exists (`theme-halloween`, both
   schemes; a bundled font is still to be tried). Remaining: the
   "Contributing a theme" section's fonts subsection and the troubleshooting
   rows for themes in [plugin-creation.md](plugin-creation.md).
6. **Later.** Host the chooser as a settings page when the settings dialog
   exists; high-contrast and reduced-motion; the `module` escape hatch if a
   theme needs it; `colorSchemes` + `cssVariables` if mode switching or
   plugin CSS files make it worthwhile; OS accent colour.
