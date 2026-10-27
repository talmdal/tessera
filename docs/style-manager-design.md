# Design note: the style manager

| | |
|---|---|
| **Status** | Phases 1–3 implemented, plus a theme chooser dialog: tokens, themes, the `shell.colors` and `shell.themes` extension points, the service, the mirror, the CSS variables, the sample plugin, selection (commands, context keys, View › Theme, the chooser), follow-system over `nativeTheme`, and persistence through `app.state`. Open: the Appearance settings page for customisations (phase 4) and the follow-ups |
| **Date** | 2026-10-28 |
| **Scope** | How the application is styled: a catalogue of named colour tokens, themes that give them values, the extension points through which plugins add both, the shell's typography variables, how the active theme is chosen, customised and persisted, and how the shell and plugin views consume all of it |
| **Related** | [plugin-creation.md](plugin-creation.md), [window-manager-design.md](window-manager-design.md) (the frame this styles), [settings-design.md](settings-design.md) (the future Appearance page), [todo.md](todo.md) ("Federation build: CSS", "Checkbox and radio items", "Menu structure changes at runtime", "Hooks and typings for plugin views", "Push more shell state") |

> **Implementation status.** Phases 1 and 2 are implemented: the contracts
> in [tessera-types/theme.ts](../tessera-types/theme.ts); the names,
> patterns, catalogue, built-in themes and resolvers in
> [shared/theme/](../shared/theme/);
> [core/theme/ThemeService.ts](../core/theme/ThemeService.ts); the wiring in
> [shell/main/theme/](../shell/main/theme/) (the two extension points
> resolved over the registry, `shell:theme.get` and `shell:theme.changed`);
> the renderer's [StyleManager.tsx](../shell/renderer/theme/StyleManager.tsx),
> `useTheme`, `useThemeColor`, [base.css](../shell/renderer/theme/base.css)
> and a `windowManager.css` with no literals, guarded by
> [tests/architecture/styles.test.ts](../tests/architecture/styles.test.ts);
> the worked example, [plugins/theme.sample/](../plugins/theme.sample/);
> and selection: `shell:theme.set`, the `shell.theme.*` commands and
> context keys, the View › Theme menu, the **theme chooser** dialog
> ([ThemeChooser.tsx](../shell/renderer/theme/ThemeChooser.tsx)),
> [nativeAppearance.ts](../shell/main/theme/nativeAppearance.ts) over
> `nativeTheme`, and
> [appStatePersistence.ts](../shell/main/theme/appStatePersistence.ts).
> Still open: the Appearance settings page for editing customisations
> (phase 4) and the follow-ups. Where this note and the code disagreed during
> implementation, the note was updated; the deliberate changes are called
> out inline as **implementation notes**.

- [Summary](#summary)
- [Context](#context)
- [Goals and non-goals](#goals-and-non-goals)
- [Decisions](#decisions)
- [The model](#the-model)
- [Components](#components)
- [Extension points](#extension-points)
- [Using the theme](#using-the-theme)
- [Commands, context keys and menus](#commands-context-keys-and-menus)
- [IPC](#ipc)
- [Persistence](#persistence)
- [Key flows](#key-flows)
- [Alternatives considered](#alternatives-considered)
- [Framework prerequisites](#framework-prerequisites)
- [Resolved questions](#resolved-questions)
- [Suggested phases](#suggested-phases)

## Summary

**Colours are named, not written. The shell and every plugin refer to colour
*tokens*; a *theme* gives the tokens values; plugins may contribute both.**

- A **colour token** is a named, described colour with a default for light
  and for dark themes, such as `shell.bar.background` or
  `accounts.positiveAmount`. The shell ships a small catalogue; plugins add
  their own through the **`shell.colors`** extension point.
- A **theme** is plain data: an id, a label, a kind (`light` or `dark`), and
  a map of token → colour. It may `extends` another theme and override a
  few entries. The shell ships `shell.light` and `shell.dark`; plugins
  contribute more through the **`shell.themes`** extension point. A theme
  from one plugin may colour the tokens of another.
- The **main process owns** the active theme, as it owns the layout: it
  resolves every token to a final colour once, publishes the result, and
  the renderer mirrors it into **CSS custom properties** on the document
  root (`--shell-bar-background`, `--accounts-positiveAmount`). Shell CSS
  and plugin views use `var(--…)` and need no code to follow a theme
  switch; code that needs a value (a chart) reads it from a hook or the
  IPC snapshot.
- The user picks a theme, or **follows the system** (light or dark), from
  the View › Theme menu, a command, or later a settings page, and can
  **customise** individual tokens globally or per theme, as in VS Code.
  Choice and customisations are persisted through the existing
  **`app.state`** service, under the `theme` key the `app-state` plugin
  already owns.
- The shell's **font family and sizes** are exposed as variables too
  (`--shell-font-family`, `--shell-font-size`), so plugins stop hard-coding
  them. They are not themeable in this version.
- Everything is validated: token ids are plugin-prefixed, colours are hex
  strings, references between tokens are cycle-checked, and a theme whose
  plugin disappears falls back cleanly. **No contribution ever injects
  CSS text**; only validated values reach the document.

## Context

Tessera replaces Microsoft Money Plus, whose pages were coloured by a
handful of built-in schemes. Users will expect at least light and dark, and
following the operating system. Finance plugins will want colours with
meaning (positive and negative amounts, overdue bills, reconciled rows,
chart series) that look right in every theme, and a theme author will want
to restyle the whole application, including those plugin colours, without
touching any plugin.

What exists today:

- The frame's colours are literals in
  [shell/renderer/layout/windowManager.css](../shell/renderer/layout/windowManager.css)
  (`#f3f3f3` bars, `#d0d0d0` borders, `#0063b1` for the active tab, rail
  indicator and splitter).
- The `app-state` plugin has a `useThemeState` hook that stores `'light'`
  or `'dark'` under the `theme` key and sets `document.body.dataset.theme`.
  Nothing reads that attribute, and no shell component uses the hook. It is
  renderer-owned, so no command or menu item could switch it, and a second
  window would not follow.
- Icons are monochrome and painted with `currentColor`
  ([Icon.tsx](../shell/renderer/layout/Icon.tsx)), so they already follow
  whatever text colour surrounds them.
- Sample views use inline literals (`border: '1px solid #ccc'` in
  [Dashboard.tsx](../plugins/layout.sample/src/renderer/Dashboard.tsx)).
- Plugin views are Module Federation remotes that share only React with the
  shell. A styling mechanism has to cross that boundary **without shared
  code**; CSS custom properties on the document do, and nothing else does
  as cheaply.

The design follows the window manager's shape on purpose: contributions as
plain data through `context.extensions`, validation in `shared/`, a
platform-free service in `core/`, a `register…` wiring in `shell/main`,
and a mirror in the renderer through `createRemoteState`.

## Goals and non-goals

**Goals**

- One vocabulary of colours for the shell and all plugins, with a default
  for each kind so that a plugin's colours look right in any theme its
  author never saw.
- Plugins can contribute themes, and a theme can colour any token,
  including those of other plugins.
- Plugins can contribute tokens, and can reference shell tokens as
  defaults (`accounts.reconciled` defaults to `shell.success`).
- Users can override any token, for every theme or for one theme, without
  a plugin's help.
- One source for the shell's typography, so a plugin view's text matches
  the frame around it.
- Light, dark and follow-system, switchable at run time from menus,
  commands, bar items and views, with no flash of the wrong colours at
  startup.
- Native parts follow: Chromium's `prefers-color-scheme`, scrollbars and
  form controls (`color-scheme`), and the window's background colour.
- Safe: every value is validated before it reaches the document; a broken
  or missing theme never breaks the shell.
- Testable without Electron, like the rest of the core.

**Non-goals (for now)**

- A component library or shared CSS classes for plugin views. Plugins bring
  their own markup and styles; the style manager gives them colours.
- **Themeable typography.** The shell exposes its font family and sizes
  as variables, but a theme cannot change them. Themes are colour
  palettes. The token model leaves room for a `type` other than colour
  later.
- **Plugin stylesheets.** A plugin cannot add to or replace the shell's
  CSS in this version; it styles its own views as it does today and uses
  the variables. See Decisions.
- A theme editor. Users pick from contributed themes and edit
  customisations as JSON through the settings framework when it lands.
- High contrast as a third kind. Not until a user asks for it; nothing in
  the contracts prevents adding one.
- A transition animation when the theme switches.
- Per-window themes. The theme is application-wide.
- Syntax-highlighting-style token scopes or semantic colouring of text.

## Decisions

Settled with the project owner after the first draft; recorded here so the
rest of the note can assume them. The trade-offs are under Alternatives
considered.

| Topic | Decision |
|---|---|
| **Where the theme lives** | The main process owns the active theme and the resolved colours; the renderer mirrors them. Commands and menus run in main, `nativeTheme` is main-only, and every window must agree |
| **Scope** | Application-wide, not per window |
| **Unit of contribution** | Tokens and themes are **data**, never CSS text. A theme maps token ids to colour strings. Resolution happens once, in main, and the renderer writes the result into CSS custom properties |
| **Colour format** | Hex only: `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`. Or a **reference** to another token id, resolved by the service. Nothing else |
| **Variable naming** | `--<token with '.' replaced by '-'>`, camelCase kept: `shell.bar.hoverBackground` → `--shell-bar-hoverBackground` (VS Code's convention) |
| **Ownership** | A token or theme id must be the contributor's plugin id or start with `<pluginId>.`; the shell uses `shell.`. Enforced by the resolvers, unlike views today |
| **Unknown tokens in a theme** | Kept silently and re-evaluated on every change: a theme may legitimately colour tokens of a plugin that is not installed or not yet active |
| **A theme disappears** | The preference is kept, the shell's default for the current kind is used, and the theme comes back if its plugin does (as a collapsed bar keeps its flag while hidden) |
| **Follow system** | `preference.theme = 'system'` picks `preference.light` or `preference.dark` by the OS setting, through a `SystemAppearance` port adapted over Electron's `nativeTheme`. *Implementation note:* `nativeTheme.shouldUseDarkColors` reports the OS only while `themeSource` is `'system'`, so the adapter pins `themeSource` to a fixed theme's kind, keeps the last OS reading meanwhile, and re-reads (announcing a change) the moment the preference returns to `'system'` |
| **Persistence** | The `app.state` service provided by the built-in `app-state` plugin, under its existing `theme` key, behind a `ThemePersistence` port in the core. Available today, so the choice survives a restart from phase 3 on; no new persistence layer |
| **User customisations** | Both levels, as VS Code's `colorCustomizations`: a global map applied over every theme, and a per-theme map applied over that. Same `ColorValue` rules as a theme |
| **Typography** | The shell's font family and sizes are CSS variables named like tokens (`--shell-font-family`, `--shell-font-size`, `--shell-font-sizeSmall`, `--shell-font-monoFamily`) set by the shell's stylesheet, not by the theme. Plugins use them; themes cannot change them in this version |
| **Plugin CSS** | Themes are colour palettes only. No mechanism loads a plugin's stylesheet into the shell; a plugin's views keep styling themselves as now (inline styles, or CSS their own build emits), with the variables. Revisit when the federation CSS question on the todo list is settled |
| **High contrast** | Not in this version; add a kind when requested |
| **Token ids** | Shell tokens keep the `shell.` prefix (`--shell-bar-hoverBackground`), so one ownership rule covers every id in the framework |
| **Native chrome** | `nativeAppearance` is where title-bar and window-frame colours will be set once a custom title bar exists; no tokens for them yet |
| **Transition** | None on switch |

## The model

### Tokens

```
 token id                   description                          light     dark
 ─────────────────────────  ───────────────────────────────────  ────────  ────────
 shell.background           Main area background                 #ffffff   #1e1e1e
 shell.accent               Active tab, rail indicator, links    #0063b1   #3794ff
 shell.bar.hoverBackground  Hovered tab, rail or item button     #e0e0e0   #2a2d2e
 shell.bar.activeIndicator  Mark on the active rail icon         → shell.accent
 accounts.positiveAmount    Credits in registers (plugin)        #107c10   #89d185
 accounts.reconciled        Reconciled rows (plugin)             → shell.success
```

A token has an id, a human description (for a later picker or editor), and
a **default per kind**. A default is a hex colour or a reference to another
token. References make plugin tokens follow the theme by construction: a
theme that changes `shell.success` changes `accounts.reconciled` with it,
unless it colours that token explicitly.

The shell's catalogue (v1) lives in `shared/theme/tokens.ts` so the main
process can validate against it and the renderer can paint first-frame
defaults from it:

| Token | Light | Dark | Used for |
|---|---|---|---|
| `shell.background` | `#ffffff` | `#1e1e1e` | Main area and page background |
| `shell.foreground` | `#1f1f1f` | `#d4d4d4` | Text |
| `shell.foregroundMuted` | `#6b6b6b` | `#9d9d9d` | Secondary text, disabled items (with opacity) |
| `shell.border` | `#d0d0d0` | `#3c3c3c` | Borders between regions |
| `shell.accent` | `#0063b1` | `#3794ff` | Active tab underline, splitter hover, rail indicator |
| `shell.accentForeground` | `#ffffff` | `#ffffff` | Text on accent |
| `shell.focusBorder` | → `shell.accent` | → `shell.accent` | `:focus-visible` outlines |
| `shell.link` | → `shell.accent` | → `shell.accent` | Anchors |
| `shell.selectionBackground` | `#cce4f7` | `#264f78` | Selected rows and text |
| `shell.bar.background` | `#f3f3f3` | `#252526` | Bars and rails |
| `shell.bar.border` | → `shell.border` | → `shell.border` | The bar's inner edge |
| `shell.bar.hoverBackground` | `#e0e0e0` | `#2a2d2e` | Hovered tab, rail and item buttons |
| `shell.bar.activeBackground` | → `shell.bar.hoverBackground` | → `shell.bar.hoverBackground` | The active rail icon |
| `shell.bar.activeIndicator` | → `shell.accent` | → `shell.accent` | Inset mark on the active rail icon |
| `shell.tab.border` | `#e0e0e0` | `#3c3c3c` | Below the tab strip |
| `shell.tab.activeBorder` | → `shell.accent` | → `shell.accent` | Under the active tab |
| `shell.button.background` | → `shell.accent` | → `shell.accent` | Primary buttons |
| `shell.button.foreground` | → `shell.accentForeground` | → `shell.accentForeground` | |
| `shell.button.hoverBackground` | `#005a9e` | `#2b7cd3` | |
| `shell.input.background` | `#ffffff` | `#313131` | Text fields |
| `shell.input.foreground` | → `shell.foreground` | → `shell.foreground` | |
| `shell.input.border` | `#8e8e8e` | `#3c3c3c` | |
| `shell.success` | `#107c10` | `#89d185` | Positive status |
| `shell.warning` | `#9d5d00` | `#cca700` | |
| `shell.error` | `#c50f1f` | `#f14c4c` | |
| `shell.info` | → `shell.accent` | → `shell.accent` | |

The light column is today's literal colours, so phase 1 changes nothing
visible. The catalogue is deliberately small; it grows when the shell grows
a control that needs a colour, never ahead of one.

### Themes

```ts
{ id: 'shell.dark', label: 'Tessera Dark', kind: 'dark', colors: {} }          // the catalogue's dark defaults
{ id: 'money-classic.sepia', label: 'Money Classic', kind: 'light',
  extends: 'shell.light',
  colors: { 'shell.background': '#fbf6ea', 'shell.bar.background': '#efe6cf',
            'shell.accent': '#7a5c1e', 'accounts.positiveAmount': '#3f6b1c' } }
```

A theme supplies values for any subset of tokens. What it leaves out comes
from the theme it `extends`, and finally from each token's default for the
theme's `kind`. So the two built-in themes have empty `colors`: they *are*
the catalogue's defaults, and a plugin theme usually extends one of them
and changes a handful of entries.

### Resolution

Done once per change, producing a flat `Record<tokenId, '#rrggbb…'>` with
every reference resolved. The rule is a pure function,
[shared/theme/resolveColorMap.ts](../shared/theme/resolveColorMap.ts), that
`ThemeService` runs in the main process and the renderer runs once, over the
shell's own catalogue, for its first frame, so both start from the same
colours by construction:

```
for each token in the catalogue (shell + every active plugin):
  value = customizations.byTheme[activeTheme][token]     // the user, for this theme
        ?? customizations.global[token]                  // the user, for every theme
        ?? first explicit entry walking theme → extends → extends …
        ?? token.defaults[theme.kind]
  while value is a token reference:
    value = resolve(referenced token)        // same rule; cycles are diagnostics
  colors[token.id] = value
```

The two customisation layers are the user's, held in the preference (see
Persistence); they are empty until the Appearance page exists, and the
resolver treats them like a theme's `colors`.

- Tokens named by the theme but absent from the catalogue are ignored for
  now and picked up if the token appears later.
- A reference to an unknown token, or a reference cycle, is logged once
  and the token gets **no value**, so the renderer's `var(--x, fallback)`
  fallback, if any, applies. This is the one case where a colour can be
  missing, and it is always a contribution bug.
- `extends` is followed through any depth; a cycle or an `extends` naming
  a theme of the other kind is a validation failure for that theme.

### Choosing the active theme

```ts
interface ThemePreference {
  theme: string | 'system'   // a theme id, or follow the OS
  light: string              // used when theme === 'system' and the OS is light; default 'shell.light'
  dark: string               // likewise for dark; default 'shell.dark'
  customizations?: {
    global?: Record<string, ColorValue>                  // token → colour, over every theme
    byTheme?: Record<string, Record<string, ColorValue>> // theme id → token → colour
  }
}
```

The active theme is `preference.theme`, or `preference.light` /
`preference.dark` by the `SystemAppearance` port when it is `'system'`. If
the id names no present theme, the shell's default of the same kind as the
missing theme's last-known kind (or the system kind when unknown) is used,
with a warning, and the preference is left alone.

### Typography variables

Not tokens and not part of a theme: four variables set on `<html>` beside
the colours, named as if they were tokens so that making them themeable
later needs no rename.

> **Implementation note.** The values live in
> [shared/theme/typography.ts](../shared/theme/typography.ts) and
> `<StyleManager>` writes them with the colours, rather than `base.css`
> declaring them. One TypeScript source keeps them testable, keeps every
> shell stylesheet literal-free (so the guard test has no exception for
> `base.css`), and means the later themeable version changes one map.

| Variable | Value | Used for |
|---|---|---|
| `--shell-font-family` | `system-ui, sans-serif` | Everything, unless a view says otherwise |
| `--shell-font-size` | `13px` | Body text in views |
| `--shell-font-sizeSmall` | `12px` | Tabs, bar items, status text |
| `--shell-font-monoFamily` | `ui-monospace, Consolas, monospace` | Amounts in registers, code |

`<html>` gets `font-family`, `font-size`, `color` and `background` from the
variables in `base.css`, and `body` inherits them, so a plugin view inherits
the right text without doing anything. The main area today inherits the browser's 16 px;
13 px is the one visible change in phase 1, and deliberate: it is the size
of a desktop application, not a web page.

## Components

```
 plugin (privileged)                                        plugin (renderer remote)
 ───────────────────                                        ────────────────────────
 context.extensions.contribute(id, 'shell.colors', …)       .register { color: var(--accounts-positiveAmount) }
 context.extensions.contribute(id, 'shell.themes', …)       window.api.invoke('shell:theme.get')   (charts)
 context.commands.execute('shell.theme.select', id)         window.api.on('shell:theme.changed', …)
 context.contextKeys  (shell.theme.* keys)                           ▲
        │                                                            │ reads CSS variables set on <html>
        ▼                                                            │
 ┌───────────────────────────────────┐      IPC      ┌───────────────┴────────────────────┐
 │ core: ThemeService                │◄─────────────►│ renderer: <StyleManager>           │
 │  catalogue + themes → resolved    │ snapshot,     │  mirrors ThemeState, writes         │
 │  colours; preference; fallbacks;  │ changed,      │  --vars, data-theme-*, color-scheme │
 │  onDidChange                      │ set           │  useTheme(), useThemeColor()        │
 └───────┬───────────────┬───────────┘               └────────────────────────────────────┘
         │ reads         │ persists, observes
         ▼               ▼
  ExtensionRegistry   ThemePersistence (port)    SystemAppearance (port)
  (themeContent)      shell/main: the app.state    shell/main: Electron nativeTheme
                      service, key 'theme'
```

| Component | Lives in | Responsibility |
|---|---|---|
| `ColorContribution`, `ThemeContribution`, `ThemeDescriptor`, `ThemePreference`, `ThemeState`, request payloads, `ThemePersistence`, `SystemAppearance` | `tessera-types/theme.ts` | The plugin-facing interfaces, like every other contract in `@tessera/types` |
| Extension point names, channel names, id and colour patterns, `cssVariableFor` | `shared/theme/types.ts` | Values any process may import |
| The shell's token catalogue | `shared/theme/tokens.ts` | Ids, descriptions and light/dark defaults; read by main for validation and by the renderer for first-paint defaults |
| `shell.light`, `shell.dark` | `shared/theme/themes.ts` | The built-in themes (empty `colors`) |
| The typography variables | `shared/theme/typography.ts` | Font family and sizes, applied beside the colours |
| `resolveColors`, `resolveThemes` | `shared/theme/resolveColors.ts`, `resolveThemes.ts` | Validate and order contributions, like `resolveViews`; return diagnostics |
| `resolveColorMap` | `shared/theme/resolveColorMap.ts` | The resolution rule (customisations → theme chain → kind defaults → references), pure |
| `builtinThemeState` | `shared/theme/builtin.ts` | The shell's catalogue and themes in resolved form; what both processes start from |
| `ThemeService` | `core/theme/ThemeService.ts` | Holds the preference; picks the active theme; resolves every token; falls back; fires `onDidChange`; loads and saves through `ThemePersistence`; listens to `SystemAppearance` |
| `themeContent` | `shell/main/theme/themeContent.ts` | Feeds the service from the extension registry (the `LayoutContent` pattern): resolves per change, logs each diagnostic once |
| `appStatePersistence` | `shell/main/theme/appStatePersistence.ts` | `ThemePersistence` over the `app.state` service: looks the service up once plugins are active, reads the `theme` key before the window opens, writes it on change |
| `nativeAppearance` | `shell/main/theme/nativeAppearance.ts` | `SystemAppearance` over `nativeTheme`; also sets `nativeTheme.themeSource` and the window background colour. **Phase 1:** `fixedAppearance('light')` |
| `registerTheme` | `shell/main/theme/registerTheme.ts` | Contributes the shell's own catalogue and themes through the shell's plugin context (as `registerCoreMenus` does its menus), so one path serves built-ins and plugins alike; creates the service; IPC, commands, context keys, the View › Theme menu, push events |
| `<StyleManager>`, `useTheme`, `useThemeColor` | `shell/renderer/theme/StyleManager.tsx`, hooks in `ShellState.tsx` | Mirrors `ThemeState`; writes variables and attributes on `<html>` |
| `base.css` | `shell/renderer/theme/base.css` | The typography variables; body text, background, focus ring and form controls from variables; `windowManager.css` is rewritten to variables |
| `plugins/theme.sample/` | built-in plugin | The worked example: one theme and one token, and a view that shows both |

The service is platform-free and tested without Electron: the extension
registry, persistence and the system appearance all come in through
interfaces.

## Extension points

Both are contributed from a plugin's privileged `activate`, as data, and
disposed with the plugin when the returned `Disposable` is pushed onto
`context.subscriptions`.

### `shell.colors`

A token the plugin's views use, with a default for each kind so it looks
right in every theme.

```ts
// tessera-types/theme.ts
export type ThemeKind = 'light' | 'dark'

/** "#rgb", "#rgba", "#rrggbb", "#rrggbbaa", or the id of another token. */
export type ColorValue = string

export interface ColorContribution {
  /** Plugin-prefixed, dotted: "accounts.positiveAmount". */
  id: string
  /** Shown by a future picker or editor; required. */
  description: string
  /** One value for both kinds, or one per kind. */
  defaults: ColorValue | { light: ColorValue, dark: ColorValue }
}
```

```js
const C = 'shell.colors'
context.subscriptions.push(
  context.extensions.contribute('accounts', C, 'accounts.positiveAmount', {
    id: 'accounts.positiveAmount', description: 'Credits in a register',
    defaults: { light: '#107c10', dark: '#89d185' }
  }),
  context.extensions.contribute('accounts', C, 'accounts.negativeAmount', {
    id: 'accounts.negativeAmount', description: 'Debits in a register',
    defaults: 'shell.error'                       // follows whatever the theme says
  }),
  context.extensions.contribute('accounts', C, 'accounts.reconciled', {
    id: 'accounts.reconciled', description: 'Background of a reconciled row',
    defaults: { light: '#e6f4e6', dark: '#1f3320' }
  })
)
```

Rules (`resolveColors`):

- `id` must match `^[a-z][a-z0-9-]*(\.[a-zA-Z][a-zA-Z0-9]*)+$` and start
  with the contributor's plugin id (`shell.` for the shell). A token that
  claims another plugin's prefix is skipped with a `[theme]` warning.
- `description` is required and non-empty.
- Each default is a hex colour or a token id. A token may not reference
  itself. References to tokens that do not exist yet are allowed at
  validation and reported at resolution if still unknown.
- Two tokens mapping to the same CSS variable name (possible, since both
  `.` and `-` become `-`) is a duplicate; the second is skipped.
- A duplicate `id` is skipped, as for views.

### `shell.themes`

```ts
export interface ThemeContribution {
  /** Plugin-prefixed, dotted: "money-classic.sepia". */
  id: string
  /** Shown in the View › Theme menu and pickers. */
  label: string
  kind: ThemeKind
  /** A theme of the same kind whose colours fill in what this one omits. Default: the shell's theme of `kind`. */
  extends?: string
  /** Token id → colour (hex or a token reference). Any token, from any plugin. */
  colors?: Record<string, ColorValue>
  /** Sort order in menus; lower first. Ties keep registration order. Defaults to 0. */
  order?: number
}

/** A theme as the renderer and pickers see it. */
export interface ThemeDescriptor {
  id: string
  label: string
  kind: ThemeKind
  pluginId: string
}
```

```js
context.subscriptions.push(
  context.extensions.contribute('money-classic', 'shell.themes', 'money-classic.sepia', {
    id: 'money-classic.sepia', label: 'Money Classic', kind: 'light', extends: 'shell.light',
    colors: {
      'shell.background': '#fbf6ea',
      'shell.bar.background': '#efe6cf',
      'shell.border': '#d9cba6',
      'shell.accent': '#7a5c1e',
      'accounts.positiveAmount': '#3f6b1c'      // another plugin's token; fine
    }
  })
)
```

Rules (`resolveThemes`):

- `id` is plugin-prefixed like tokens; `label` and `kind` are required;
  `kind` is `light` or `dark`.
- `extends`, when given, must name a theme; an unknown parent is a warning
  and the theme falls back to the shell's theme of its kind. A parent of
  the other kind, or a cycle through `extends`, skips the theme.
- Every value in `colors` must be a hex colour or a token id; one bad value
  skips the theme (a half-applied theme is worse than none), with a
  message naming the key.
- Keys of `colors` are not checked against the catalogue (see Decisions).

A plugin that ships several themes contributes several entries. A plugin
that only wants to *tint* the shell contributes one theme extending
`shell.light` or `shell.dark` with a few colours.

## Using the theme

### In CSS (the normal case)

The renderer keeps `<html>` up to date:

```html
<html data-theme-id="money-classic.sepia" data-theme-kind="light"
      style="color-scheme: light;
             --shell-background: #fbf6ea; --shell-foreground: #1f1f1f; …
             --accounts-positiveAmount: #3f6b1c; …">
```

So a stylesheet or an inline style anywhere in the document, shell or
plugin, reads a token with `var()`:

```css
.register-amount.credit { color: var(--accounts-positiveAmount); }
.register-row.reconciled { background: var(--accounts-reconciled); }
.wm-tab-active { border-bottom-color: var(--shell-tab-activeBorder); }
```

```tsx
<td style={{ borderColor: 'var(--shell-border)', fontFamily: 'var(--shell-font-monoFamily)' }}>…</td>
```

Nothing else is needed: when the theme changes, the variables change, and
the browser repaints. `color-scheme` makes scrollbars and native form
controls match, and `data-theme-kind` lets a stylesheet do something
kind-specific without naming a theme (`[data-theme-kind="dark"] img.logo {
filter: invert(1) }`).

**Shell CSS rule:** no colour literal outside `shared/theme/tokens.ts`, and
no font literal outside `shared/theme/typography.ts`.
[tests/architecture/styles.test.ts](../tests/architecture/styles.test.ts)
greps `shell/renderer/**/*.css` for hex, `rgb()`/`hsl()` and named colours,
and for `font`, `font-family` and `font-size` values that are not `var()` or
`inherit`, and fails on any hit, so the two files stay the single sources.

### In code

Shell components:

```ts
const { kind, activeTheme } = useTheme()              // re-renders on change
const accent = useThemeColor('shell.accent')          // '#0063b1'; undefined while loading or unresolved
```

Plugin views have no shell hooks yet (todo: "Hooks and typings for plugin
views"), so until the SDK exists they read the same state over IPC, which is
only needed for things that cannot use `var()`, such as a canvas chart:

```ts
const state = await window.api.invoke<ThemeState>('shell:theme.get')
const series = state.colors['accounts.positiveAmount']
const off = window.api.on<ThemeState>('shell:theme.changed', next => redraw(next.colors))
```

A view may also read the variable from the document:
`getComputedStyle(document.documentElement).getPropertyValue('--shell-accent')`.

### Plugin stylesheets

Unchanged by this design. A plugin styles its views as it does today, with
inline styles or CSS its own build emits beside the remote (the latter is
untested; see "Federation build: CSS" in the todo), and the style manager
asks only that the colours and fonts in that CSS be the variables above. A
theme cannot ship CSS, and there is no extension point for a stylesheet:
themes are colour palettes.

### The worked example

`plugins/theme.sample/` contributes:

- one token, `theme-sample.highlight`, defaulting to `shell.warning`;
- one theme, `theme-sample.sepia`, extending `shell.light` and overriding
  a handful of shell tokens and its own;
- a main view, *Theme Swatches* on the View menu, that shows the active
  theme, the themes on offer and every resolved token as a swatch, using
  both routes: `var()` for the swatches, the snapshot and event for the
  values. A button that runs `shell.theme.toggleDark` joins it in phase 3,
  with the command.

`layout.sample`'s inline literals became variables (`var(--shell-border)`,
`var(--shell-selectionBackground)`), so the existing worked example looks
right in both kinds, and
[tests/architecture/styles.test.ts](../tests/architecture/styles.test.ts)
holds every built-in plugin's renderer to the same rule for colours.

## Commands, context keys and menus

Registered by the shell through its own plugin context, so plugins can
execute them and menus can reference them.

### Commands

| Command | Argument | Enablement | Effect |
|---|---|---|---|
| `shell.theme.select` | a theme id, or `'system'` | — | Sets `preference.theme`. Unknown id: warning, no change |
| `shell.theme.useSystem` | — | `!shell.theme.system` | Same as `select('system')`, for menus |
| `shell.theme.toggleDark` | — | — | Switches between `preference.light` and `preference.dark`, leaving follow-system. The one-button theme switch for a bar item |
| `shell.theme.choose` | — | — | Opens the theme chooser in the focused window (every window when none is focused), through the `shell:theme.chooseRequested` event |
| `shell.theme.use.<themeId>` | — | — | Generated per present theme, because menu items cannot pass arguments. Registered and disposed as themes come and go, with a View › Theme item each |

### Context keys

| Key | Value |
|---|---|
| `shell.theme.active` | The active theme's id |
| `shell.theme.kind` | `light` or `dark` |
| `shell.theme.system` | `true` while following the system, else unset |

Views and bar items can use them in `when`, and plugins in `enablement`.

### Menu

View › **Theme** submenu: *Choose Theme…*, *Follow System*, *Toggle
Light/Dark*, a separator, then one item per present theme in `order`, with
the built-in pair first. Two limitations inherited from the menu system,
both on the todo list: the active theme cannot be ticked until checkbox
items exist, and the menu is built once after activation, so a theme
contributed by a plugin activated later is reachable by command and in the
chooser, but not listed in the menu until restart. The chooser has neither
limitation, which is why it exists.

### The theme chooser

A modal the shell owns, in the renderer
([ThemeChooser.tsx](../shell/renderer/theme/ThemeChooser.tsx)), opened by
`shell.theme.choose` from the menu, a bar item or a view:

- It lists *Follow the system* (with the kind the system currently asks
  for, and, while selected, a pick for the light theme and the dark theme to
  follow it with), then every present theme grouped by kind, each with the
  plugin it came from.
- Every choice **previews at once**: the dialog sends `shell:theme.set` and
  the whole window, dialog included, repaints from the push event. **OK**
  keeps the last choice; **Cancel**, Escape or a click outside send back the
  preference the dialog opened with. This is the "live apply" the settings
  note asked about, answered without a draft: the service is the draft.
- It is a `role="dialog"` with `aria-modal`, focuses the checked option on
  open and returns focus on close. Opening is per window: the event names
  the focused window and other windows ignore it.

> **Implementation note.** The note had put the picker in the Appearance
> settings page (phase 4). A shell-owned dialog ships earlier, needs no
> settings framework, and stays the right home for choosing a theme even
> once that page exists; the page will edit customisations.

## IPC

Channel names in `shared/theme/types.ts`; payloads in `tessera-types/theme.ts`.

| Channel | Direction | Payload | Reply |
|---|---|---|---|
| `shell:theme.get` | request | — | `ThemeState` |
| `shell:theme.set` | request | `ThemeSetRequest` (any subset of `ThemePreference`) | `ThemeState`; throws for an unknown theme id |
| `shell:theme.changed` | push | `ThemeState` | — |
| `shell:theme.chooseRequested` | push | `ThemeChooseRequestedEvent` (`windowId?`) | — |

```ts
export interface ThemeState {
  preference: ThemePreference
  /** The theme in use: the preference, or the fallback when it is absent. */
  activeTheme: string
  kind: ThemeKind
  /** Every catalogue token with a resolved hex value; tokens that failed to resolve are absent. */
  colors: Record<string, string>
  /** The present themes, for pickers. */
  themes: ThemeDescriptor[]
}

export type ThemeSetRequest = Partial<ThemePreference>
```

The state is small (tens of entries) and absolute, so every change pushes
the whole thing and replaying an event is harmless, which is what
`createRemoteState` expects. `shell:theme.set` exists so a settings page
can preview a theme live and restore it on Cancel (the "Live apply" question
in settings-design resolves itself for themes).

## Persistence

| | |
|---|---|
| What | `ThemePreference` only, which includes the user's customisations. Resolved colours are never stored |
| Where | The `app.state` service (built-in `app-state` plugin, on `storage.engine`), key `theme`, through a `ThemePersistence` port in the core, as `LayoutPersistence` is for the layout |
| When | `load` once after plugins have activated and before the window is created; `save` on every change (`app.state` writes through LokiJS, which autosaves; `flush` on shutdown already exists) |
| Before the service is available | The service starts on `system` with the catalogue defaults, which is also what a first run shows |
| Failure | A missing, malformed or unknown-theme entry means `system`; nothing prevents startup. If no plugin provides `app.state`, the adapter logs once and the preference lasts the session |

```ts
export interface ThemePersistence {
  load(): Promise<ThemePreference | undefined>
  save(preference: ThemePreference): Promise<void>
}
```

The `AppState` interface is asynchronous, so the port is too. The adapter
is the only place that names the service: `ThemeService` knows only the
port, and the core stays free of any plugin. Timing is the one subtlety: the
service is created in `bootstrap` before plugins run, and `app.state` is
provided during activation, so the adapter resolves `runtime.services.get('app.state')`
after `activateAll` and the preference is applied **before `createWindow`**
(the Startup flow below). The value stored under `theme` today is the string
`'light'` or `'dark'` written by `useThemeState`; the adapter reads a string
as `{ theme: 'shell.<value>' }` once, and writes the full `ThemePreference`
object from then on, so the key changes shape without a separate migration.

```ts
export interface SystemAppearance {
  kind(): ThemeKind
  onDidChange: Event<ThemeKind>
}
```

**User colour customisations** live in `preference.customizations`, in two
layers as VS Code's `workbench.colorCustomizations` has them: `global`
applies over every theme, `byTheme[themeId]` over one, and the per-theme
entry wins. Values follow the same rules as a theme's `colors` (hex or a
token reference); an invalid entry is skipped with a warning, never the
whole map. The resolver has the layering from phase 1; the entries stay
empty until phase 4 adds the Appearance settings page, which edits them
through `shell:theme.set` (live preview, restored on Cancel).

```json
{ "theme": "system", "light": "shell.light", "dark": "money-classic.sepia",
  "customizations": {
    "global":  { "shell.accent": "#c2410c" },
    "byTheme": { "shell.dark": { "shell.bar.background": "#202020" } } } }
```

**`useThemeState`** in the `app-state` plugin is superseded and removed in
phase 3, as `useSidebarState` is by the window manager. Its `theme` key
stays, and becomes the shell's.

## Key flows

### Startup

1. `bootstrap` creates `ThemeService` with `themeContent`, the
   `appStatePersistence` adapter and `nativeAppearance`, and calls
   `registerTheme`. The service starts on `system`, resolved against the
   shell's catalogue and built-in themes, so the state is valid before any
   plugin runs.
2. Plugins activate; `app-state` provides `app.state`. After `activateAll`
   the adapter reads the `theme` key and the service applies the stored
   preference. Still no window, so nothing flashes.
3. `nativeAppearance` sets `nativeTheme.themeSource` to the active kind, so
   Chromium's `prefers-color-scheme` is right before the window exists.
4. `createWindow` passes `backgroundColor: colors['shell.background']` and
   `show: false`, showing on `ready-to-show`, so there is no white flash.
5. The renderer's `<StyleManager>` applies the catalogue defaults for
   `matchMedia('(prefers-color-scheme: dark)')` synchronously on first
   render, then requests `shell:theme.get` and replaces them. The two
   agree unless the user chose a non-default theme, in which case the
   swap happens before the window is shown.
6. The tokens and themes plugins contributed during activation are already
   in; any later contribution fires `extensions.onDidChange`, the service
   re-resolves and publishes `shell:theme.changed` only when the result
   differs (compared by value, as the layout service does).
7. `applyApplicationMenu` builds the View › Theme submenu from the present
   themes.

### Switch theme

1. The user picks *Money Classic*; the menu runs
   `shell.theme.use.money-classic.sepia`, which calls
   `service.setPreference({ theme: 'money-classic.sepia' })`.
2. The service resolves, fires `onDidChange`, and hands the preference to
   the adapter, which writes the `theme` key through `app.state`.
3. `registerTheme` publishes `shell:theme.changed`, rewrites the
   `shell.theme.*` keys; `nativeAppearance` updates `themeSource` and each
   window's background colour.
4. Every window's `<StyleManager>` writes the new variables; everything
   using `var()` repaints. Views listening to the event redraw.

### The system switches to dark

1. `nativeTheme` fires `updated`; `nativeAppearance` emits `dark`.
2. If `preference.theme === 'system'`, the service re-resolves with
   `preference.dark` and the rest follows as above. Otherwise nothing
   changes (the user chose a fixed theme), except that `themeSource` stays
   pinned to that theme's kind, so native controls do not drift.

### A theme's plugin is deactivated

1. The contribution is disposed; `extensions.onDidChange` fires.
2. The active theme is gone. The service warns once, resolves with the
   shell's theme of the same kind, and publishes. The preference still
   names the missing theme.
3. The plugin is reactivated (a future install-without-restart); the theme
   reappears, the service resolves with it again, and the user sees their
   choice return.

### A plugin contributes a token after a theme that colours it

1. The `money-classic` theme lists `accounts.positiveAmount`; `accounts`
   activates later and contributes the token.
2. The token was ignored while unknown. Now the catalogue has it, the
   theme's value applies, `--accounts-positiveAmount` appears on `<html>`.
   Order of activation never matters.

### The user customises a colour

1. On the Appearance page the user sets `shell.accent` to `#c2410c` for
   all themes; the page calls `shell:theme.set` with the new
   `customizations`, so the change shows at once.
2. The service re-resolves: the global entry wins over every theme's
   value, but a per-theme entry for the active theme, if one exists, still
   wins over it. The preference is saved.
3. Cancel on the page sends the previous `customizations` back; OK leaves
   the new ones in place.

## Alternatives considered

| Alternative | Why not |
|---|---|
| **Renderer-owned theme** (what `useThemeState` does today) | No menu item or command could switch it, `nativeTheme` is main-only, and a second window would not follow. Same reasoning as the layout: main owns, renderer mirrors |
| **Themes as CSS files** shipped by plugins | Cannot be validated, cannot be merged per token, fight on specificity, and cannot feed non-CSS consumers (charts, the window background, native controls). Data in, CSS variables out, gives all of that |
| **Free-form variable maps** (a theme is any `Record<string, string>` with no catalogue) | Plugins could not discover which names exist, there would be no per-kind defaults, no descriptions for a picker, and no way to tell a typo from a new token. The catalogue is the contract |
| **`data-theme` attribute and per-theme selectors** (`[data-theme=dark] .x {}`) | Every plugin stylesheet would have to know every theme. It does not scale past two, which is why `data-theme-kind` is kept only as a convenience for kind-specific tweaks |
| **A CSS-in-JS or utility framework shared with plugins** | Needs shared runtime code across the federation boundary, and a rebuild to change colours. Custom properties cross the boundary with nothing shared |
| **Any CSS colour syntax** (`rgb()`, `hsl()`, names) | More parsing for no expressive gain; hex with alpha covers everything, is trivially validated, and keeps the door open to deriving colours (transparent variants) later |
| **Computed colour transforms in defaults** (VS Code's `transparent(x, 0.5)`, `lighten`) | Useful, but references cover the common "follow that token" case. Transforms can be added as a second `ColorValue` form without changing the contracts |
| **Per-window theme** | Nobody asks a second window to be dark while the first is light; one fewer id on the wire |
| **A `JsonPersistence` port and file adapter** for the preference, as the layout note proposes | It does not exist yet, and the `app.state` service does: a working store with a `theme` key already in it. Using it means persistence ships with the feature instead of waiting. The cost, the shell reading a plugin's service, is confined to one adapter in `shell/main` behind a core port, and the layout can do the same if `JsonPersistence` stays unbuilt |
| **A `shell.theme` service for privileged code** | Privileged code rarely needs a colour; context keys give it the kind and id for enablement. Revisit if a plugin needs resolved values in main (an export to PDF might) |
| **Global-only customisations** | Simpler, but a user who tunes one theme does not want the tweak to follow them into a theme of the other kind. Two layers cost one more key in the preference and nothing in the resolver |
| **Typography in the theme** | Asked for eventually, but it doubles the contract for every contributor now. Variables named like tokens make it a contained change later |
| **`styles` on `ViewContribution`** (plugin CSS files attached as `<link>` elements) | Would give plugins scoped stylesheets without depending on the federation build, but it is a trust and cascade question of its own. Deferred with the "Federation build: CSS" todo; themes stay data |
| **Silently accept unknown tokens in a theme with a warning** | Warnings on every resolution would be noise, since colouring a not-installed plugin's token is legitimate. They are kept and re-checked instead |

## Framework prerequisites

1. **The `app.state` service**, which exists: the adapter reads it after
   activation. Nothing to build; the one ordering rule (load before
   `createWindow`) is in `app.ts`.
2. **Checkbox menu items** (todo), to tick the active theme in View › Theme.
3. **Menu structure changes at runtime** (todo), so themes from plugins
   activated later appear in the menu. Not blocking; commands work regardless.
4. **Hooks and typings for plugin views** (todo), so plugin code can use
   `useTheme` instead of raw IPC. Not blocking; `var()` needs nothing.
5. **Declared extension points** (todo) would let the shell declare
   `shell.colors` and `shell.themes` with schemas. Helpful, not blocking;
   the resolvers validate in the meantime.
6. **Main → renderer events** already exist (`EventHub`,
   `forwardEventsToWindows`); `shell:theme.changed` uses them as the layout
   does.

## Resolved questions

The first draft raised seven questions; they were answered by the project
owner and are recorded in the Decisions table. For traceability:

| Question | Answer |
|---|---|
| High contrast as a third kind? | Leave it until a user asks |
| Typography: expose the shell's font family and base size as non-themeable variables? | Yes |
| User customisations global, per theme, or both? | Both, the VS Code way |
| Plugin stylesheets through `styles` on the view, or the federation build? | Neither in this version. A theme plugin provides a colour palette; plugins cannot extend the CSS |
| Keep the `shell.` prefix on shell tokens? | Yes |
| Theme-aware native chrome through `nativeAppearance`? | Yes, when a custom title bar exists |
| Transition animation on switch? | Not in this release |

## Suggested phases

Phases 1–3 are **done**, and the theme chooser with them; phases 4–5 are open.

1. **Tokens and variables:** `tessera-types/theme.ts`, `shared/theme/*`
   (catalogue, built-in themes, resolvers), `ThemeService` in memory with
   a fixed `SystemAppearance`, `shell:theme.get` and `.changed`,
   `<StyleManager>` writing variables and attributes, `useTheme` and
   `useThemeColor`, `base.css` with the typography variables,
   `windowManager.css` rewritten to variables, the no-literals test. Light
   defaults match today's colours, so the app looks the same apart from
   the 13 px body text. The resolver already layers `customizations`, fed
   with empty maps. Tests: resolver validation, resolution with
   references, kind defaults and both customisation layers, renderer
   applies variables, `color-scheme` and the font variables.
   *Implementation note:* `ThemeService` already takes the `ThemePersistence`
   port and has `load()`, tested with a fake, so phase 3 only adds the
   adapter; and `setPreference` exists for the tests, without its IPC.
2. **Extension points:** `shell.colors` and `shell.themes`, `themeContent`,
   ownership checks, `extends` chains, unknown-token behaviour, change
   detection, fallback when the active theme disappears,
   `plugins/theme.sample/`, `layout.sample` without literals. Tests: late
   contribution in either order, deactivation fallback, cycle diagnostics,
   end-to-end through the extension registry like the layout sample's.
3. **Selection and persistence:** `shell:theme.set`, the commands and
   context keys, the View › Theme menu, `nativeAppearance` (follow system,
   `themeSource`, window background, `show: false` until ready),
   `appStatePersistence` reading the legacy string and writing the
   preference, loaded before `createWindow`; removal of `useThemeState`;
   the theme chooser dialog and `shell.theme.choose`; the buttons on the
   sample's page. Tests: the service with a fake async persistence, the
   adapters with fakes, the chooser's preview and cancel, and the sample
   end to end through the command path.
4. **Settings:** the Appearance page under `shell.settings.pages` once the
   settings framework exists, editing the global and per-theme
   customisation maps (stored in the same `theme` key; nothing new to
   persist). The theme picker itself shipped with phase 3 as the chooser
   dialog.
5. **Follow-ups:** ticked menu items once checkbox items exist, `useTheme`
   in the plugin SDK, theme-aware native chrome once a custom title bar
   exists. Out of this release by decision: plugin stylesheets, themeable
   typography, high contrast, transitions.
