# Design and implementation: font roles

| | |
|---|---|
| **Status** | Reviewed 2026-11-08 (see [Decisions taken in review](#decisions-taken-in-review)). Phase 0 (spike) done ([results](#phase-0-results)). Phase 1 (roles as data) done ([results](#phase-1-results)); Phase 2 (roles in the code) done ([results](#phase-2-results)); Phase 3 (the setting, delivered to every window) done ([results](#phase-3-results)); Phase 4 (the Fonts page) done, most of it confirmed in Electron ([results](#phase-4-results)); Phase 5 (themes set fonts) done ([results](#phase-5-results)). Phase 6 (fonts shipped inside themes, plugin roles, text-size shortcuts) is optional, each scheduled separately |
| **Date** | 2026-11-08 |
| **Scope** | Replacing Tessera's hardcoded fonts with **font roles**: named kinds of text (interface, headings, tables, figures…) that every view uses. Users change a role's font on a new **Fonts** page of the Options dialog, and **themes** can set fonts too |
| **Builds on** | [theming-design.md](theming-design.md) (the theme manager, `ThemeDescriptor`, `createShellTheme`, the Appearance page), [settings-design.md](settings-design.md) (namespaces, pages, the draft lifecycle), [plugin-creation.md](plugin-creation.md#styling-and-theming) |
| **Amends** | Theming decisions 9 ("The OS font stack") and 18 (theme tokens are colours only), the rule "Typography, density and shape are the shell's" in [Themes](theming-design.md#themes), and its non-goal "Bundled fonts". See [Decisions](#decisions) |
| **Layout** | [Part 1](#part-1-design) is the design (*what and why*), and [Part 2](#part-2-implementation) is the phased implementation plan (*how and in what order*), in the style of [import-manager-design.md](import-manager-design.md) |

- [Summary](#summary)
- [Context](#context)
- [Goals and non-goals](#goals-and-non-goals)
- [Decisions](#decisions)
- **Part 1: Design**
  - [Font roles](#font-roles)
  - [Resolution: who wins](#resolution-who-wins)
  - [The `shell.fonts` setting](#the-shellfonts-setting)
  - [Themes set fonts](#themes-set-fonts)
  - [Getting fonts to every window](#getting-fonts-to-every-window)
  - [Renderer: roles in the MUI theme](#renderer-roles-in-the-mui-theme)
  - [Plugins and roles](#plugins-and-roles)
  - [The Fonts page](#the-fonts-page)
  - [The installed-font catalogue](#the-installed-font-catalogue)
  - [Security and robustness](#security-and-robustness)
  - [Testing](#testing)
  - [Alternatives considered](#alternatives-considered)
  - [Risks](#risks)
  - [Decisions taken in review](#decisions-taken-in-review)
- **Part 2: Implementation**
  - [Ground rules](#ground-rules)
  - [Dependency graph](#dependency-graph)
  - [Phase 0: spike](#phase-0-spike-s)
  - [Phase 1: roles as data, no visible change](#phase-1-roles-as-data-no-visible-change-m)
  - [Phase 2: roles in the shell's and plugins' code](#phase-2-roles-in-the-shells-and-plugins-code-l)
  - [Phase 3: the `shell.fonts` setting, delivered to every window](#phase-3-the-shellfonts-setting-delivered-to-every-window-m)
  - [Phase 4: the Fonts page](#phase-4-the-fonts-page-l)
  - [Phase 5: themes set fonts](#phase-5-themes-set-fonts-m)
  - [Phase 6: later, each scheduled separately](#phase-6-later-each-scheduled-separately)
  - [Documentation changes](#documentation-changes)

---

## Summary

**Text is styled by *role*, not by component or by literal. A role is a named kind of text (*Interface text*,
*Headings*, *Small text*, *Tables and registers*, *Amounts and figures*, *Fixed-width text*) with a font family, a size
and a weight. The shell owns the list of roles and their defaults. Themes may set a role's font. The user has the final
say on a new Options page, Tools ▸ Options… ▸ Appearance ▸ Fonts.**

- **Six roles, owned by the shell.** Every MUI typography variant and the components that draw text (table cells,
  tooltips, helper text) map onto a role. Amounts and fixed-width text get two new typography variants, because nothing
  in MUI covers them. Plugins use roles through `@tessera/ui` and never name a font or a pixel size.
- **Three layers, per role and per property:** the shell's defaults ← the theme's fonts ← the user's choices.
  A property nobody sets is *Automatic*. The shell's default applies, or for most roles the value is inherited from
  *Interface text*, so changing the interface font changes tables and small text too unless they were set separately.
- **The user's choices are a setting,** `shell.fonts`, edited on the **Fonts** page: one row per role, with a
  family picker listing installed fonts (each drawn in its own face), a size, a weight where it applies, where each
  value comes from ("Automatic", "From the theme", "Yours"), a Reset per role, and a live preview. OK, Apply, Cancel and
  Restore Defaults work as on every other page.
- **Themes may set fonts,** through a new optional `fonts` field of `ThemeDescriptor`. It is validated as strictly as
  colours, with narrower size limits than the user gets. A switch on the Fonts page lets the user ignore theme fonts
  altogether.
- **Fonts travel with the theme.** The window's `ThemeSnapshot` gains the font settings, so the first frame is already
  drawn in the right fonts (the same no-flash handshake), and a change re-fonts every window the way a theme change
  re-themes it.
- **Families are data, never CSS.** A family is a list of names, checked against a strict pattern and quoted by the
  shell. Nothing a theme or a settings file holds is pasted into a stylesheet.
- **Phased:** a spike; the roles as data with no visible change; roles adopted in the code; the setting; the page;
  theme fonts; and later, optional work (fonts shipped inside a theme, roles contributed by plugins, text-size
  shortcuts).

---

## Context

### Where fonts are set today

The shell sets one family stack and one size, and a handful of views set fonts of their own.

| Where | What | Kind |
|---|---|---|
| [createShellTheme.ts:8](../shell/renderer/theme/createShellTheme.ts) | `FONT_STACK = 'system-ui, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'` | The only family, for everything |
| [createShellTheme.ts:40](../shell/renderer/theme/createShellTheme.ts) | `typography: { fontFamily: FONT_STACK, fontSize: 13, … }` | The base size that MUI's whole scale is derived from |
| [InspectorDialog.tsx:99, 152](../plugins/settings-inspector/src/renderer/InspectorDialog.tsx) | `fontFamily: 'monospace'`, and `fontSize: 12` on the `<pre>` | Literal family and size |
| [SidePanel.tsx:22](../plugins/test-layout/src/renderer/SidePanel.tsx) | inline `style={{ fontSize: 13 }}` | Literal size, outside the theme |
| [ThemePreview.tsx:59](../shell/renderer/theme/ThemePreview.tsx) | `fontSize: '0.75rem'` | Literal size (a caption in all but name) |
| accounts [display.tsx:37](../plugins/accounts/src/renderer/display.tsx), [Register.tsx:541–542](../plugins/accounts/src/renderer/register/Register.tsx), [ReconcileList.tsx:138](../plugins/accounts/src/renderer/reconcile/ReconcileList.tsx), [ReconcilePanel.tsx:97, 109](../plugins/accounts/src/renderer/reconcile/ReconcilePanel.tsx); import [display.tsx:9](../plugins/import/src/renderer/display.tsx), [MatchDialog.tsx:172](../plugins/import/src/renderer/MatchDialog.tsx) | `fontVariantNumeric: 'tabular-nums'`, eight times | The same "this is an amount" rule, repeated |
| [Navigator.tsx:250](../plugins/accounts/src/renderer/Navigator.tsx), [LedgerTree.tsx:146](../plugins/ledger/src/renderer/LedgerTree.tsx), [SummaryDialog.tsx:63](../plugins/import/src/renderer/SummaryDialog.tsx), [AnnotationLine.tsx:35](../plugins/accounts/src/renderer/register/AnnotationLine.tsx), [ThemeGallery.tsx:110](../shell/renderer/theme/ThemeGallery.tsx), [ThemePreview.tsx:30](../shell/renderer/theme/ThemePreview.tsx) | `fontWeight: 600` | Emphasis within a role; fine as it is (see [Plugins and roles](#plugins-and-roles)) |
| [Navigator.tsx:254](../plugins/accounts/src/renderer/Navigator.tsx) | `fontSize: '0.75em'` | Relative to the surrounding text, so it already scales; fine as it is |

Everything else uses MUI typography variants, which are derived from the base size above. Across `shell/` and `plugins/`
there are 33 uses of `body2`, 8 of `caption`, 7 of `h6`, 6 of `subtitle2`, 3 of `subtitle1`, and one each of `h4`, `h5`
and `overline`. So **most of the application already follows a single setting**, and the work is mostly about that
setting's surroundings: naming the roles, letting the user and themes set them, and removing the literals above.

### What the current design says

- Theming decision 9 is "The OS font stack", and the non-goals say "Bundled fonts: the OS font stack is used".
- [Themes](theming-design.md#themes): "The token set is deliberately small (palette, background, text, divider).
  Typography, density and shape are the shell's, so plugin themes can't break layout. Widening it later is an open
  question." Decision 18 says the same thing.
- The plugin guide says "Compact density and the operating system's font are the shell's, so your views match
  without choosing them."

This note answers the "widening it later" question for typography. Themes may set fonts, within limits that keep
layouts intact. Density and shape stay the shell's.

---

## Goals and non-goals

**Goals**

- Name the kinds of text the application draws (**roles**), and make every view use them, the shell's and plugins'.
  No literal font families or absolute sizes remain in renderer code.
- Let the user change each role's **family, size and weight** (where meaningful) on an Options dialog page, with a
  live preview, OK/Apply/Cancel, per-role reset and Restore Defaults.
- Let **themes set fonts**, declaratively and validated, with the user's choices winning and a way to ignore theme
  fonts entirely.
- Changing the interface size scales the whole type scale (headings, captions, icons), so *one* change makes the
  application larger or smaller.
- **No flash and no reflow:** the first frame is drawn in the right fonts, and a change applies live to every window.
- Keep the shell's defaults **pixel-identical** until the user or a theme changes something.

**Non-goals (for now)**

- **Native chrome:** the menu bar, native message boxes and the title bar keep the operating system's font. Electron
  can't style them, as it can't colour them ([theming decision 8](theming-design.md#decisions)).
- **Per-window fonts.** A window shows its theme's fonts (including a window's own theme) with the application's font
  settings. No per-window font setting.
- **Per-ledger fonts.** Fonts are a preference of the person, not of the data.
- **Font files shipped inside themes or plugins** (web fonts). Only fonts installed on the computer are used in the
  first version. This is [Phase 6a](#6a-fonts-shipped-inside-a-theme-l), because a font file is effectively code for
  how digits look (see [Security](#security-and-robustness)).
- **Roles contributed by plugins.** The first version has the shell's six. This is [Phase 6b](#6b-roles-contributed-by-plugins-m).
- **Zoom.** Electron's page zoom scales everything, layout included; font roles scale text only. They are
  complementary, and zoom is not part of this work.
- **Density, spacing and shape** stay the shell's.

---

## Decisions

Proposed, for review. Each is explained in Part 1.

| # | Decision | Why |
|---|---|---|
| 1 | **Fonts are set by role**, from a small, fixed catalogue of six roles the shell owns | Users think in kinds of text ("the register is too small"), not components. A small catalogue keeps the page readable and lets themes and plugins agree on names |
| 2 | **A role sets only what is meaningful for it:** family, and size and weight where they apply (its *facets*) | A heading's size is a scale of levels, not one number. Figures sit inside other text and take its size. Offering a box that does nothing would confuse |
| 3 | **A property nobody sets is *Automatic*** (`null` in the setting), meaning the theme's value, else inherited, else the shell's | The settings store only differences from the defaults and can't express "remove this key" ([`diffFromDefaults`](../shared/settings/values.ts)), so "not set" has to be a value |
| 4 | **Layers, per role and per property:** user ← theme ← inherited from *Interface text* ← shell | The user's explicit choice always wins, a theme's explicit choice beats inheritance, and anything left alone follows the base role |
| 5 | **The interface size is MUI's `typography.fontSize`**, not the root `html` font size | MUI derives every variant, and its own icons, from it through `pxToRem`, so one number scales the type. Spacing (`theme.spacing`) stays in pixels, so the layout keeps its compact density |
| 6 | **Families are lists of names, never CSS strings.** The shell validates each name and writes the quoted `font-family` value, always ending in the role's fallbacks | Theme and settings data are untrusted. Emotion would write a raw string into a stylesheet. Appending fallbacks means a missing font or missing glyphs (CJK, currency signs) fall back to the interface font, then the system's |
| 7 | **The user's fonts are their own setting, `shell.fonts`**, separate from `shell.theme`, with their own page under Appearance | Changing theme must not lose font choices, and a settings page edits one namespace |
| 8 | **Themes may set fonts** (`ThemeDescriptor.fonts`), validated strictly, within narrower size limits than the user has; **the user can ignore theme fonts** with one switch | Answers theming's open "widen the tokens" question for typography. Narrow limits keep a theme from breaking layouts; the switch keeps the user in control. Amends theming decisions 9 and 18 |
| 9 | **Font settings travel in the `ThemeSnapshot`**, through the same synchronous initial request and `shell:theme.changed` event | The first frame must already use the right fonts, and that mechanism exists. A separate channel would need its own no-flash handshake |
| 10 | **No `FontService` in `core/`.** The setting is the one source of truth, resolution is a pure function in `shared/`, and `registerTheme` republishes snapshots when the setting changes | There is no per-window font state and no OS integration to own (unlike `ThemeService` and `nativeTheme`). Revisit with plugin roles ([Phase 6b](#6b-roles-contributed-by-plugins-m)) |
| 11 | **Plugins use roles, never fonts:** MUI variants and components as today, plus two new variants (`numeric`, `monospace`) and `useFontRoles()` for canvas-like drawing. **Plugins can't change fonts** | Consistency, and it mirrors theming decision 17 (plugins read the theme, never change it) |
| 12 | **Installed fonts are listed by the main process, for the Options dialog only**, and the page works without the list (free text) | Enumeration differs per platform and may be slow or unavailable. Keeping it out of the renderer means plugin views get no font-listing permission |
| 13 | **Sizes are whole CSS pixels** | What CSS and MUI use, and what the code already uses (`fontSize: 13`). Points were considered and turned down in review ([1](#decisions-taken-in-review)) |
| 14 | **Figures are always tabular** (`font-variant-numeric: tabular-nums`), whatever font is chosen for them | Columns of amounts must line up. This is a property of the role, not a user choice |

---

# Part 1: Design

## Font roles

### The catalogue

| Role id | Label (user-facing) | Covers | Facets | Default family | Default size at the shell's defaults |
|---|---|---|---|---|---|
| `ui` | **Interface text** | Body text, controls, buttons, tabs, menus, fields, lists, status text: every MUI variant not claimed below, and the base every other size is derived from | family, size, weight | `FONT_STACK` (today's) | **13 px**: MUI's `fontSize`, which is `body2`, tabs and table cells. Others keep MUI's ratios: body text, fields, menu items and list text are `body1` (14.86 px), small buttons 12.07 px |
| `heading` | **Headings** | `h1`–`h6`, `subtitle1`, `subtitle2`, dialog titles | family, weight | Inherits `ui` | Follows `ui`: each level keeps MUI's ratio (`h6` ≈18.6 px, `subtitle2` 13 px) |
| `small` | **Small text** | `caption`, `overline`, helper text under fields, tooltips | family, size | Inherits `ui` | Follows `ui` at MUI's ratios (`caption` ≈11.1 px, tooltip ≈10.2 px). Once set, all of them use that size |
| `table` | **Tables and registers** | Table cells and headers: the register, the reconciliation list, the Change Match dialog | family, size | Inherits `ui` | Follows `ui` (table cells are `body2`: 13 px) |
| `numeric` | **Amounts and figures** | Amounts, balances, totals, counts in columns; always tabular digits | family | Inherits the surrounding text | Inherits the surrounding text (an amount in a heading is heading-sized) |
| `monospace` | **Fixed-width text** | File paths, file contents, identifiers (the Settings Inspector today) | family, size | `MONO_STACK`: `ui-monospace, "Cascadia Mono", Consolas, "SF Mono", Menlo, "DejaVu Sans Mono", "Liberation Mono", monospace` | Follows `ui` (13 px) |

The px figures are what MUI's scale gives with `fontSize: 13`, measured in Chromium in [Phase 0](#phase-0-results); a
golden test in [Phase 1](#phase-1-roles-as-data-no-visible-change-m) pins them.

**Why these six.** They are the distinct kinds of text the code draws today (see [the inventory](#where-fonts-are-set-today)),
and each is something a user could reasonably want to change on its own. Examples: a bigger register without bigger
menus, amounts in a fixed-width face, headings in a serif. Finer roles (say, "buttons" apart from "interface")
were left out. They would be hard to explain and easy to make ugly. [Plugin roles](#6b-roles-contributed-by-plugins-m)
cover the cases where a plugin really needs a role of its own.

**Inheritance** is for the family (and the size, for derived roles): `heading`, `small` and `table` inherit from `ui`,
and `numeric` inherits from whatever it is inside. `monospace` has its own default family, because a proportional font
is never right for it, but its size follows `ui`.

### Types

```ts
// tessera-types/fonts.ts
/** The kinds of text Tessera styles separately. */
export type FontRoleId = 'ui' | 'heading' | 'small' | 'table' | 'numeric' | 'monospace'

/** The weights offered: Regular, Medium, Semibold, Bold. */
export type FontWeight = 400 | 500 | 600 | 700

/**
 * One role's font, as a theme sets it. Everything is optional: what is left out comes from the next layer.
 * `family` is family names, most wanted first (never CSS); the shell quotes them and adds the role's fallbacks.
 */
export interface FontSpec {
  family?: string[]
  /** Whole CSS pixels. Only for roles with a size facet. */
  size?: number
  /** Only for roles with a weight facet. */
  weight?: FontWeight
}

/** The fonts a theme sets, by role. */
export type ThemeFonts = Partial<Record<FontRoleId, FontSpec>>

/** The `shell.fonts` setting. Every `null` is Automatic: the theme's, else inherited, else the shell's. */
export interface FontSettings {
  /** When false, themes' fonts are ignored and only the user's and the shell's apply. */
  useThemeFonts: boolean
  roles: {
    ui:        { family: string[] | null, size: number | null, weight: FontWeight | null }
    heading:   { family: string[] | null, weight: FontWeight | null }
    small:     { family: string[] | null, size: number | null }
    table:     { family: string[] | null, size: number | null }
    numeric:   { family: string[] | null }
    monospace: { family: string[] | null, size: number | null }
  }
}

/** Where a resolved value came from, for the Fonts page. */
export type FontSource = 'user' | 'theme' | 'inherited' | 'shell'

/** A role as it is drawn. */
export interface ResolvedFontRole {
  id: FontRoleId
  /** The CSS `font-family` value, quoted, with fallbacks. Undefined for `numeric` when it inherits. */
  fontFamily?: string
  /** The family wanted first, for display ("Inter"). */
  primary?: string
  /** px. Undefined where the role has no size facet or the value is derived per level. */
  size?: number
  weight?: FontWeight
  sources: { family: FontSource, size?: FontSource, weight?: FontSource }
}

export type ResolvedFonts = Record<FontRoleId, ResolvedFontRole>
```

The role catalogue itself (ids, labels, descriptions, facets, default families, size limits, parents) is data in
`shared/fonts/roles.ts`, which both processes read. `FONT_STACK` moves there from `createShellTheme.ts`.

### Families are data

A family in a theme or in the setting is a **list of names**: `["Inter"]`, or `["Iosevka Term", "Cascadia Mono"]`
from a theme that wants a preference order. Each name:

- is 1 to 100 characters of letters (any script), digits, spaces and `- _ . + & '`. Quotes, backslashes, `; : , / ( ) { } < > @ *`
  and control characters are refused, so a name can't end the declaration, open a block, or reach `url(…)`;
- is matched case-insensitively against the **generic families** (`system-ui`, `ui-sans-serif`, `ui-serif`,
  `ui-monospace`, `ui-rounded`, `sans-serif`, `serif`, `monospace`, `cursive`, `fantasy`, `math`, `emoji`), which are
  written unquoted; every other name is written in double quotes.

A list holds at most 8 names. The shell writes the role's `font-family` as the chosen names followed by the
**role's fallback**:

- Interface text falls back to `FONT_STACK`.
- Fixed-width text falls back to `MONO_STACK`.
- Every other role falls back to the *resolved Interface text family*, which itself ends in `FONT_STACK`.

So a font that isn't installed, or lacks a glyph (a CJK character, a currency sign such as ₹), falls back to the user's
interface font, then the system's, and never to the browser's default serif.

```
user chooses ["Inter"] for Interface text
→ font-family: "Inter", system-ui, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif
```

This is `cssFontFamily(names, fallback)` in `shared/fonts/families.ts`, the only place a `font-family` string is built
from names. The shell's own stacks (`FONT_STACK`, `MONO_STACK`) are constant CSS the shell writes, so they are used as
they are (today's `FONT_STACK` leaves `Roboto` and `Arial` unquoted, and the defaults must not change by a character).
Only names from themes and settings go through the rule and the quoting. `cssFontFamily` throws for a name that
wasn't checked, rather than writing it.
With Inter as the interface font, a figures font of `["Cascadia Mono"]` gives
`"Cascadia Mono", "Inter", system-ui, …, sans-serif`.

### Sizes and their limits

| Role | User may choose | A theme may set |
|---|---|---|
| `ui` | 11 to 24 px | 12 to 16 px |
| `small` | 8 to 20 px | 10 to 14 px |
| `table` | 10 to 24 px | 12 to 16 px |
| `monospace` | 9 to 24 px | 11 to 16 px |

Whole pixels only. The user's range is wide for readability; a theme's is narrow, so that choosing a theme for its
colours can't produce a layout nobody tested. The two tiers were agreed in review ([2](#decisions-taken-in-review)).

[Phase 0](#5-the-layout-at-10-13-16-20-and-24-px) looked at the layout at the extremes:

- **No size above 13 px is safe until the register's column widths follow the text.** Today they truncate amounts
  from 16 px, the top of the theme range. That fix is in Phase 2, which comes before the setting exists, and was
  tried in the spike up to 24 px.
- **The minimum for Interface text is 11 px** ([decision 8](#decisions-taken-in-review)): at 10, tooltips would be
  7.9 px.

**Why the base size is MUI's `fontSize`.** MUI sizes each variant in rem as `size / 16 × fontSize / 14` (its
`pxToRem`, with `size` from its own design scale). So with
`fontSize: 13`, `body2` (14 in MUI's design) is 13 px, `caption` (12) is about 11.1 px, and `h6` (20) is about 18.6 px.
Changing `fontSize` scales them all in proportion. That is exactly "make the text bigger", and it is one line in
`createShellTheme`. The root `html` font size stays at the browser's 16 px, so rem-based spacing doesn't grow, and the
shell's compact density holds.

**Icons.** MUI 9 sizes its own icons through the same `pxToRem`, so standard icons grow with the interface size
(`small` is 18.57 px at 13). Registered icons ([Icon.tsx](../tessera-ui/Icon.tsx)) use fixed rem values
(`small: '1.25rem'`, 20 px) and set their own `width` and `height`. [Phase 0](#2-sizes-and-icons-computed-in-the-browser)
found they already differ at 13 px, and in a button a registered icon is 24 px where a standard one is 18. Phase 2 sizes
registered icons the way MUI does, so both kinds match at every size. MUI fixes button icons at 18 px; Phase 2 scales them
by the interface size over 13, which leaves them unchanged at the default.

---

## Resolution: who wins

For each role and each of its facets, the first of these that has a value is used:

1. **The user's choice** in `shell.fonts` (a non-`null` value).
2. **The theme's** `fonts[role]`, for the theme the window shows, unless `useThemeFonts` is off.
3. **Inherited**: for `heading`, `small` and `table`, the resolved `ui` value (the family; the size by MUI's ratio
   where the role has no size of its own); for `numeric`, the surrounding text.
4. **The shell's default** for the role.

This is `resolveFonts(settings, themeFonts): ResolvedFonts` in `shared/fonts/resolveFonts.ts`, given the theme's `fonts`
rather than the whole theme. It checks every value again and ignores one that fails, so whatever a settings file or a
theme holds, only a valid name reaches a stylesheet. It is pure and runs in the
renderer (for the window, the preview and the gallery) and in tests. It also records each value's `source`, which the
Fonts page shows.

**A worked example.** The *Sunrise* theme sets `{ heading: { family: ["Georgia", "serif"] }, ui: { size: 14 } }`. The
user has chosen Inter for Interface text, 15 px for Tables and registers, and Cascadia Mono for Amounts and figures.

| Role | Family (source) | Size (source) | Weight (source) |
|---|---|---|---|
| Interface text | Inter (**user**) | 14 px (**theme**) | 400 (shell) |
| Headings | Georgia (**theme**), although the user changed Interface text: the theme set headings explicitly | per level, from 14 | per level (shell) |
| Small text | Inter (inherited) | MUI's ratios from 14 (inherited) | |
| Tables and registers | Inter (inherited) | 15 px (**user**) | |
| Amounts and figures | Cascadia Mono (**user**), tabular | the surrounding text's | |
| Fixed-width text | `MONO_STACK` (shell) | 14 px (inherited) | |

With *Use the fonts themes choose* off, the interface size is 13 px and headings are Inter (inherited).

A window with its own theme ([theming decision 6](theming-design.md#decisions)) resolves against that theme, so a
window override brings that theme's fonts with it. The user's settings are the same in every window.

---

## The `shell.fonts` setting

The shell registers a second settings namespace beside `shell.theme`, in [app.ts](../shell/main/app.ts):

```ts
const fontSettings = runtime.settings.register(SHELL_CONTRIBUTOR_ID, FONT_SETTINGS)   // id 'shell.fonts'
```

**Defaults are all Automatic:**

```ts
export const FONT_SETTINGS: SettingsDefinition<FontSettings> = {
  id: 'shell.fonts',
  defaults: {
    useThemeFonts: true,
    roles: {
      ui: { family: null, size: null, weight: null },
      heading: { family: null, weight: null },
      small: { family: null, size: null },
      table: { family: null, size: null },
      numeric: { family: null },
      monospace: { family: null, size: null }
    }
  },
  validate: fontSettingsProblems
}
```

Why `null` and not absent: the settings store only what differs from the defaults, merging objects key by key. A key
the defaults have can't be removed by an edit (`diffFromDefaults` keeps it at its default). An explicit `null` default
makes "back to Automatic" an ordinary edit that deletes the override from the file. Only what the user changed is
saved:

```json
// <userData>/settings/shell.fonts.json
{ "version": 1, "values": { "roles": { "ui": { "family": ["Inter"] }, "table": { "size": 15 } } } }
```

**Validation.** A `null` default disables the generic shape check for that key ([`shapeProblems`](../shared/settings/values.ts):
"a default of `null` accepts anything"), so `fontSettingsProblems` checks everything itself. It returns messages for the
user:

- each family is `null` or a list of 1 to 8 valid names ("'Arial;}' isn't a font name.");
- each size is `null` or a whole number in the role's user range ("Interface text: choose a size from 11 to 24 px.");
- each weight is `null` or 400, 500, 600 or 700;
- a facet the role doesn't have is `null` (a hand-edited file with `numeric.size` is refused with a message);
- `useThemeFonts` is a boolean.

It does **not** check that a font is installed. Settings are read before the font list exists, a settings folder may
be copied from another computer, and a missing font falls back cleanly. The page warns instead.

Role keys the defaults don't have are kept by the merge and ignored by resolution, so a file written by a newer
version with more roles (or [plugin roles](#6b-roles-contributed-by-plugins-m)) doesn't fail. That is the settings
framework's rule for newer files (settings decision 7).

The Settings Inspector shows the namespace without change.

---

## Themes set fonts

`ThemeDescriptor` gains one optional field, at the top level rather than per variant:

```ts
export interface ThemeDescriptor {
  id: string
  label: string
  description?: string
  light?: ThemeTokens
  dark?: ThemeTokens
  /** Fonts by role. Anything left out is Automatic. Mode-independent. */
  fonts?: ThemeFonts
}
```

```ts
context.extensions.contribute(context.pluginId, 'shell.themes', 'budget.ledgerbook', {
  id: 'budget.ledgerbook',
  label: 'Ledger Book',
  description: 'Warm paper colours, with serif headings.',
  light: { primary: '#7c2d12', background: { default: '#fbf6ea', paper: '#fffdf7' } },
  fonts: {
    heading: { family: ['Georgia', 'Cambria', 'serif'], weight: 600 },
    numeric: { family: ['Cascadia Mono', 'Consolas'] }
  }
})
```

**Validation** joins the existing rules in [resolveThemes.ts](../shared/theme/resolveThemes.ts) and follows their
strictness. A theme is skipped with a `[theme]` warning when `fonts` is not an object, names an unknown role, sets a
facet the role doesn't have, has an invalid family name or list, has a size outside the *theme* range, or has a weight
that isn't one of the four. A bad font is treated like a bad colour, so authors see typos instead of having them
silently ignored. The descriptor's fonts are copied field by field, like its tokens.

**Why fonts are not per mode.** A typeface does not change between light and dark. (Some designers lighten weights in
dark mode; that is [later work](#later-not-scheduled), and the field can move into the variants without breaking
anything.)

**In the Appearance page:**

- The **gallery** card notes *"Sets fonts: Headings (Georgia), Amounts (Cascadia Mono)"* in its details line, and its
  miniature is drawn with the theme's fonts. The filter box also searches those family names.
- The **preview** ([ThemePreview.tsx](../shell/renderer/theme/ThemePreview.tsx)) is built with
  `createShellTheme(theme, mode, { fonts: resolveFonts(userFonts, theme.fonts) })`, so it shows what choosing the theme
  gives: the theme's fonts *under the user's own choices*.
- When the chosen theme sets fonts and the user has turned theme fonts off, the page says so and links to the Fonts
  page.

**The reference sample.** `test-layout`'s *Sunrise* gains `fonts: { heading: { family: ['Georgia', 'serif'] } }`, so a
sample in the repo exercises the path, as it does for contributed themes and icons.

### Fonts and colour

**A font role has no colour: colour is the theme's.** Text is drawn in the theme's colour tokens, per mode:
`text.primary` for ordinary text, `text.secondary` for quieter text (descriptions, captions), and the status colours
where they mean something (`error` for what is owed, `success` for a balanced reconciliation). MUI derives
`text.disabled` from the mode. A theme sets them in its `light` and `dark` variants, and the theme manager checks them
for contrast against the backgrounds ([theming-design.md](theming-design.md#phase-6-results)).

Colour stays out of roles on purpose:

- A colour chosen with a font would be one colour for light and dark, where a theme sets each.
- It would escape the contrast check.
- A user who chose a font and a theme that chose a colour could combine into text nobody can read.

If a role ever needs a colour of its own (headings in the primary colour, say), it would be a theme token, in the
variants, checked like the others.

---

## Getting fonts to every window

The renderer already receives its theme as a `ThemeSnapshot`: synchronously before the first render (`shell:theme.initial`,
through the preload), then on every `shell:theme.changed`. Fonts join it:

```ts
export interface ThemeSnapshot {
  state: ThemeState
  themes: ThemeDescriptor[]          // each may now carry `fonts`
  systemPrefersDark?: boolean
  /** The user's font settings (`shell.fonts`); the renderer resolves them against the window's theme. */
  fonts: FontSettings
}
```

The **settings**, not the resolved fonts, are sent. The renderer needs them to resolve against *other* themes (the
gallery and the preview), and the Fonts page needs each value's source. Resolution is cheap and pure.

In `registerTheme` ([registerTheme.ts](../shell/main/theme/registerTheme.ts)):

- `snapshot(state)` adds `fonts: fontSettings.get()`;
- `fontSettings.onDidChange` publishes a fresh snapshot for **every attached window**. The theme manager's
  "only when the state changed" rule is about `ThemeState`, which a font change doesn't touch, so this is published
  directly;
- nothing writes the setting back, as for the theme (one source of truth, one direction).

**No flash, no reflow.** The window is already hidden until its first themed frame ([theming: Startup without a
flash](theming-design.md#startup-without-a-flash)). Because the initial snapshot carries the fonts, that first frame
uses them. Installed fonts need no loading, so no frame is drawn in a fallback font. (Fonts shipped inside themes
would need a wait; see [Phase 6a](#6a-fonts-shipped-inside-a-theme-l).)

---

## Renderer: roles in the MUI theme

`ShellThemeProvider` resolves the fonts for the window's theme and passes them to `createShellTheme`, whose memo key
gains them:

```ts
createShellTheme(descriptor, mode, { reducedMotion, fonts: resolveFonts(snapshot.fonts, descriptor.fonts) })
```

The mapping from roles to MUI lives in one new file, `shell/renderer/theme/fontTheme.ts`, which `createShellTheme`
spreads into its options. **It emits an override only for a value whose source is `user` or `theme`.** Everything else
is left to MUI's own derivation from `fontFamily` and `fontSize`, which is what produces today's output. That is how
the defaults stay pixel-identical, and how inheritance from `ui` comes for free: MUI's variants already carry the base
family.

| Role | MUI theme options it sets (when set by the user or a theme) |
|---|---|
| `ui` | `typography.fontFamily`, `typography.fontSize` (always set: today's `FONT_STACK` and 13 by default), and `fontWeight` on `body1`, `body2`, `button`. When the size isn't 13, `MuiButton`'s start and end icons too, which MUI fixes at 18, 20 and 22 px: scaled by the size over 13 |
| `heading` | `fontFamily` and `fontWeight` on `h1`–`h6`, `subtitle1`, `subtitle2` (dialog titles are `h6`) |
| `small` | `fontFamily` and `fontSize` on `caption` and `overline` (helper text under fields is drawn from `caption`, so it follows); `MuiTooltip.styleOverrides.tooltip`, which MUI sizes on its own |
| `table` | `MuiTable` `styleOverrides.root`: **always** the role's size (its cells' size, `body2` while Automatic), so widths in `em` are measured against the cells' text; it holds no text of its own, so nothing looks different. `MuiTableCell` `styleOverrides.root`: `fontFamily` and `fontSize` when chosen. Table heads keep MUI's weight |
| `numeric` | New variant **`typography.numeric`**: `{ fontVariantNumeric: 'tabular-nums' }`, plus `fontFamily` when set. Always present |
| `monospace` | New variant **`typography.monospace`**: `{ fontFamily, fontSize }`, always present (`MONO_STACK` and the `ui` size by default) |

A size set in pixels is written as rem of the browser's 16 px root (`15` becomes `0.9375rem`), as MUI writes its own:
exact at the default root, and following it. The font components are merged into the shell's own component options
slot by slot (`mergeComponents`), so a role never undoes a property the shell sets on the same component.

The two new variants render as `<span>` in `Typography` (MUI's behaviour for a variant it has no element mapping for),
and they can also be used as `sx={{ typography: 'numeric' }}`. Phase 0 confirmed both through the federation boundary.

**The preview is the real thing.** `ThemePreview` already builds its own MUI theme in a provider of its own, so giving
it `fonts` makes it show both a theme and a set of fonts exactly as the application will. It also gains a short
register (two rows with amounts) and a line of fixed-width text, so every role appears in it.

---

## Plugins and roles

**Most plugin code needs no change.** `Typography` variants, `TableCell`, `Tooltip`, helper text and buttons already
follow roles through the theme.

**What `@tessera/ui` adds (1.2 → 1.3):**

| Export | Use |
|---|---|
| `variant="numeric"` / `sx={{ typography: 'numeric' }}` | Any amount, balance or figure that should line up. Inherits the surrounding size and colour |
| `variant="monospace"` / `sx={{ typography: 'monospace' }}` | Paths, file contents, identifiers |
| `useFontRoles(): ResolvedFonts` | Read-only resolved fonts (CSS family, px size, weight), for what the MUI theme can't style: a canvas, a chart library. Like `useThemeState()` for colours |
| The `FontRoleId` and `ResolvedFontRole` types | From `@tessera/types` |

The variant names reach plugin code through a module augmentation in `tessera-ui/` (`TypographyPropsVariantOverrides`
and `TypographyVariantsOptions`). Plugins take their types from `tessera-ui/index.ts`, so they see it too.

**What plugins must not do**, enforced by a test beside the hex-colour rule in
[boundaries.test.ts](../tests/architecture/boundaries.test.ts) for `shell/renderer` and every plugin's `src/renderer`:
no string `fontFamily`, no absolute `fontSize` (a number, `px`, `rem` or `pt`), and no `fontVariantNumeric` outside
`shell/renderer/theme/` and `tessera-ui/`. Relative sizes (`'0.75em'`, `'90%'`) and `fontWeight` for emphasis are
allowed. Emphasis is the author's choice within a role, and it scales with it.

**Plugins can't change fonts.** No request or command lets a plugin change `shell.fonts`, just as none lets it change
the theme. A plugin *can* contribute a theme with fonts, which the user chooses.

**Migrating the inventory** ([Phase 2](#phase-2-roles-in-the-shells-and-plugins-code-l)):

| Today | Becomes |
|---|---|
| Eight `fontVariantNumeric: 'tabular-nums'` (accounts, import) | `typography: 'numeric'` in the same `sx`, or `variant="numeric"` |
| Settings Inspector: `fontFamily: 'monospace'`, `fontSize: 12` | `typography: 'monospace'`. **A visible change:** the `<pre>` goes from 12 px in the browser's generic monospace to 13 px in `MONO_STACK` |
| test-layout `SidePanel`: inline `fontSize: 13` | Removed (the panel inherits `body2` through `Typography` or `sx={{ typography: 'body2' }}`) |
| `ThemePreview` status swatches: `fontSize: '0.75rem'` | `typography: 'caption'` |
| `fontWeight: 600` emphasis (six places) | Unchanged |
| Navigator's `fontSize: '0.75em'` | Unchanged (relative) |

---

## The Fonts page

### Where it is

**Tools ▸ Options… ▸ Appearance ▸ Fonts**: a sub-page of Appearance, since the tree
[nests any page under any other](../shared/settings/resolvePages.ts). It is a built-in page, like Appearance, drawn by the
shell's renderer ([builtIns.ts](../shell/renderer/settings/builtIns.ts)) over the `shell.fonts` namespace:

```ts
export const FONTS_PAGE: SettingsPageContribution = {
  id: 'shell.appearance.fonts',
  title: 'Fonts',
  parent: 'shell.appearance',
  description: 'The fonts and text sizes Tessera uses for each kind of text.',
  keywords: ['font', 'typeface', 'text size', 'larger text', 'smaller text', 'bigger', 'readability',
             'monospace', 'fixed-width', 'numbers', 'amounts', 'register', 'headings'],
  settings: 'shell.fonts',
  module: './Fonts'
}
```

A command, `shell.fonts.choose`, opens the dialog there (as `shell.theme.choose` opens Appearance).

### What it shows

```
┌ Fonts ─────────────────────────────────────────────────────────────────────────────────────────────┐
│ The fonts and text sizes Tessera uses for each kind of text.                                       │
│                                                                                                    │
│ [✓] Use the fonts themes choose      The Sunrise theme sets: Headings                              │
│                                                                                                    │
│ Interface text                 Menus, buttons, fields, panels and most text. Other sizes follow it. │
│   Font [ Inter                        ▾]  Size [ 14 ] px  Weight [ Automatic (Regular) ▾]   Reset    │
│   Font: yours · Size: from the theme · Weight: automatic                                           │
│                                                                                                    │
│ Headings                                                                                           │
│   Font [ Automatic: Georgia (from the theme) ▾]               Weight [ Automatic ▾]          Reset │
│                                                                                                    │
│ Small text                     Captions, hints under fields, tooltips.                             │
│   Font [ Automatic: Inter         ▾]  Size [      ] px  (automatic: 12 px)                    Reset │
│                                                                                                    │
│ Tables and registers           The register and other lists of transactions.                       │
│   Font [ Automatic: Inter         ▾]  Size [ 15 ] px                                          Reset │
│                                                                                                    │
│ Amounts and figures            Always with digits of equal width, so columns line up.              │
│   Font [ Cascadia Mono            ▾]  Size follows the text around it                         Reset │
│   ⚠ Cascadia Mono isn't installed on this computer; the interface font is used instead.           │
│                                                                                                    │
│ Fixed-width text               File paths and file contents.                                       │
│   Font [ Automatic: system fixed-width ▾]  Size [      ] px  (automatic: 14 px)                Reset │
│                                                                                                    │
│ Preview · Sunrise, light mode                                                                      │
│ ┌────────────────────────────────────────────────────────────────────────────────────────────────┐ │
│ │ (the theme preview, drawn with these fonts: toolbar, tabs, heading, text, caption,             │ │
│ │  a two-row register with amounts, a line of fixed-width text)                                  │ │
│ └────────────────────────────────────────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────────────────────────────────────┘
                                                         [Restore Defaults]   [OK] [Cancel] [Apply]
```

**Each role** is a `fieldset` whose `legend` is the role's label, with a one-line description. It has the controls for
its facets only:

- **Font:** a combobox (`Autocomplete`). Its first option is **Automatic**, which shows what Automatic resolves to and
  why ("Automatic: Georgia (from the theme)"). Next come the generic families ("System interface font", "System serif",
  "System sans-serif", "System fixed-width"), then every installed family, alphabetically, **each drawn in its own
  face once it scrolls into view** (drawing them all at once made opening 1,000 families take seconds; see
  [Phase 0](#phase-0-results)). Typing filters. A name that isn't listed can be typed (the list may be incomplete or unavailable) and is
  checked against the name rule as you type.
- **Size:** a whole-number box with the role's range, empty for Automatic, with the automatic value beside it. An
  out-of-range or half-typed value marks the field and disables OK and Apply through `onValidityChange`, as fields
  pages do.
- **Weight** (Interface text and Headings): Automatic, Regular, Medium, Semibold, Bold. A font without a given weight
  is drawn by the browser's synthesis; the preview shows the result honestly.
- **Where each value comes from**, in one line under the controls: *automatic*, *from the theme*, *yours*. It is linked
  to the controls with `aria-describedby`, so a screen reader hears it with the field.
- **Reset** returns every facet of the role to Automatic (in the draft). It is disabled when nothing is set.
- A **warning** when a chosen family isn't among the installed fonts, but only when the font list is known to be
  complete. Otherwise nothing is claimed.

**Use the fonts themes choose** is a switch (`useThemeFonts`). Beside it, the page names what the window's theme sets,
or says the theme sets no fonts.

**The preview** is `ThemePreview` for the window's current theme and mode, built with the **draft** fonts, so every
change shows immediately without applying anything. (Settings decision 15 defers *live apply*; a preview inside the
page is not live apply.) Like today's preview, it is one image to assistive technology (`role="img"` with a
description), `inert`, and out of the tab order.

**The draft lifecycle is the dialog's.** Choices change the draft only; OK or Apply commits `shell.fonts`, and
every window re-renders in the new fonts, the Options dialog included. Cancel forgets the draft. **Restore Defaults**
sets the page's namespace to its defaults: every role Automatic and theme fonts on. When the namespace is read-only
(saved by a newer version), the controls are disabled and the dialog says why, as for any page.

**Which theme the page previews.** The Fonts page edits only `shell.fonts`, so it sees the *applied* theme, not a theme
chosen on the Appearance page but not yet applied. The page says which theme it previews. Sharing drafts between the
shell's own pages is [later work](#later-not-scheduled), if it is needed.

### Behaviour worth testing

- Choosing a family, a size and a weight changes the draft, and only `shell.fonts`.
- Automatic shows the theme's value and source, or the inherited one, and follows the switch.
- Reset on a role clears only that role; Restore Defaults clears all and turns theme fonts back on.
- An invalid size disables OK and Apply, and a refused commit shows the main process's messages under the page
  (`errors`).
- The page works, with free text and no warnings, when the font list is unavailable.
- The preview uses the draft, not the applied fonts.

---

## The installed-font catalogue

The page lists installed families through a shell-only request:

| Channel | Direction | Payload |
|---|---|---|
| `shell:fonts.families` | renderer → main | none; returns `{ families: string[], complete: boolean }`. Sorted, de-duplicated, case-insensitively unique |

Behind it is a port, so the main-process code is testable with a fake:

```ts
// shell/main/fonts/fontCatalogue.ts
export interface FontCataloguePort {
  /** Installed font family names. Rejects when they can't be listed. */
  listFamilies(): Promise<string[]>
}
```

- **Listed lazily**, the first time the Fonts page asks, then **cached for the session**. Nothing is enumerated at
  start-up.
- **Failures are not errors for the user.** A rejection or a timeout (5 s) answers `{ families: [], complete: false }`
  and is logged once. The page falls back to free text and makes no "not installed" claims.
- **How: Local Font Access, in a dedicated hidden window** (chosen in [Phase 0](#1-listing-installed-fonts)).
  1. The adapter opens a small `BrowserWindow` with `show: false`, loading a `file://` page of the shell's (a secure
     context), with its own `webContents`.
  2. The session's permission handlers grant `local-fonts` **to that `webContents` only**.
  3. The adapter calls `queryLocalFonts()` there, keeps the distinct `family` names, and closes the window.

  Plugin views share the application window's page and origin, which a permission handler can't tell apart, so the
  application window itself is never granted the permission.
  - It takes about 20 ms in Chromium, with no user gesture once granted.
  - It lists the families Chromium can actually draw, by the names CSS takes.
  - The platforms' own listings were rejected: `fc-list` over-reports, PowerShell is slow and uses another font
    system, and the macOS route ships an executable.
- **An empty list means "not allowed", not "no fonts".** `queryLocalFonts()` answers `[]` without an error when the
  permission is missing, so the adapter treats an empty answer as a failure (`complete: false`).
- **"Installed" means "in the list"**, compared case-insensitively, and only when the list is complete. Measuring text
  can't tell: on Linux, fontconfig quietly substitutes unknown names.

---

## Security and robustness

| Concern | How it is handled |
|---|---|
| **CSS injection through a font name** (`Arial; } body { display: none`) from a theme or a hand-edited settings file | Names are data, checked against a strict character rule ([Families are data](#families-are-data)) in both validators, and only `cssFontFamily` turns them into CSS, quoting every non-generic name. Tests feed hostile names to both |
| **A font that misleads** | A finance application must not show an amount wrongly. In the first version only installed fonts can be used: the user's own computer is trusted for what it renders. Fonts shipped inside themes ([6a](#6a-fonts-shipped-inside-a-theme-l)) are never used for `numeric`, because a font file can draw any digit as any other |
| **A missing font** (settings copied from another computer, a theme naming a font the user lacks) | The role's fallbacks always follow, so the text falls back to the interface font, then the system's. The page warns when it knows the list is complete |
| **A theme making text unreadable or breaking layouts** | Theme sizes have narrow limits; the user's choices win; the switch ignores theme fonts altogether |
| **Very large text in a compact layout** | User sizes have limits; Phase 0 and Phase 4 check the layout at the extremes (tabs, rails, toolbar, register rows, the Options dialog itself) |
| **Slow or failing font enumeration** | Lazy, cached, with a timeout and a free-text fallback |
| **A newer settings file with roles this version doesn't know** | Kept by the merge, ignored by resolution (settings decision 7) |

---

## Testing

| What | Where | Checks |
|---|---|---|
| Family names and CSS | `tests/shared/fontFamilies.test.ts` | Valid and invalid names (quotes, `;`, braces, `url(`, control characters, over-long, too many); generic families unquoted, others quoted; fallbacks appended: `ui` to `FONT_STACK`, `monospace` to `MONO_STACK`, the rest to the resolved `ui` family |
| Resolution | `tests/shared/fontRoles.test.ts` | Every layer and source; the worked example above, row by row; inheritance from `ui`; `numeric` inherits the surrounding text; `useThemeFonts` off; unknown roles in settings ignored |
| The setting | `tests/shared/fontSettings.test.ts` | `fontSettingsProblems`: ranges per role, whole numbers, weights, facets a role lacks, non-boolean switch; defaults pass; the file keeps only what differs (`diffFromDefaults`) and Automatic removes it |
| Theme fonts | `tests/shared/themes.test.ts` (extended) | Each rejection rule, with a `[theme]` warning; the theme size ranges; copied, not referenced |
| The MUI theme | `tests/renderer/fontTheme.test.tsx` | **Golden:** at the defaults, the typography and component overrides are exactly today's (the Phase 0 figures); each role's override lands on the right variants and components; the new variants exist |
| Delivery | `tests/main/registerTheme.test.ts`, `tests/preload/initialTheme.test.ts`, `tests/main/app.test.ts` | Snapshots carry the font settings; a font change publishes to every attached window; the initial snapshot has them; a commit to `shell.fonts` re-fonts the window |
| The catalogue | `tests/main/fontCatalogue.test.ts` | Sorting and de-duplication; caching; a rejection and a timeout answer `complete: false` and log once |
| The page | `tests/renderer/fontsPage.test.tsx` | [Behaviour worth testing](#behaviour-worth-testing), in the real `SettingsDialog` with the fake bridge |
| `@tessera/ui` | `tests/shared/tesseraUi.test.ts`, `tests/renderer/tesseraUi.test.tsx` | The pinned export list gains `useFontRoles`; a federated plugin's `variant="numeric"` renders with the shell's role |
| Guard | `tests/architecture/boundaries.test.ts` | No literal families, absolute sizes or `fontVariantNumeric` in renderer code outside the theme |
| By hand | `npm run dev` | Windows, macOS and Linux: the list of fonts, a font change in two windows, a window with its own theme, light and dark, the extremes of every size, a missing font, a theme with fonts |

---

## Alternatives considered

| Alternative | Why not |
|---|---|
| **One "text size" setting and nothing else** | Cheap (it is MUI's `fontSize`) and solves the most common request, but not "a fixed-width font for amounts" or "serif headings", and nothing for themes. It is the `ui` size here, available from Phase 3 |
| **A font per component** (buttons, tabs, menus…) | Too many knobs to understand, easy to make ugly, and plugins would have to choose among them |
| **Fonts as part of `shell.theme`** | Changing theme would reset or carry font choices in confusing ways, and one page edits one namespace |
| **CSS custom properties** (`--tessera-font-table`) set on `:root` | Plain CSS could use them, but MUI's own components need theme values, so there would be two sources of truth. `cssVariables` was already dropped in [theming phase 2](theming-design.md#phase-2-results). `useFontRoles()` covers code outside MUI |
| **Electron's `webPreferences.defaultFontFamily` / `defaultFontSize`** | Fixed when the window is created, per window, not per role, and ignored wherever CSS sets a font (which MUI does everywhere) |
| **Page zoom** (`webContents.setZoomFactor`) | Scales the layout and images too, and isn't per role. Complementary, not a replacement |
| **Free-form CSS `font-family` strings in themes and settings** | Simpler to write, but injectable, and impossible to validate or show as "Inter" on the page |
| **Letting themes set any size** | A theme chosen for its colours could make the application unusable. Narrow limits keep the choice safe |
| **Resolving fonts in the main process and sending CSS** | The renderer needs the inputs anyway (the gallery and the preview resolve for other themes, and the page shows sources) |
| **A `FontService` in `core/`** | No per-window state and no platform integration to own; the setting is the state. Worth it with plugin roles, if then |

---

## Risks

| Risk | Mitigation |
|---|---|
| Large sizes clip fixed-height chrome (tabs 36 px, dense toolbars, rails) | Phase 0 found none: every fixed height is a minimum and grows |
| **Pixel widths truncate amounts at larger sizes** (the register did from 16 px) | Found in Phase 0; fixed in Phase 2 with widths in `em`, the table's minimum width too. Checked in Chromium to 24 px: no amount cut. The plugin guide tells authors to do the same |
| Plugin views get a font-listing permission | The permission is granted only to a dedicated hidden window's `webContents` (Phase 0), checked in Electron in Phase 4 |
| The defaults shift by a pixel when roles are introduced | The golden test in Phase 1; overrides are emitted only for values set by the user or a theme |
| MUI changes its scale in an upgrade | The golden test fails loudly; the figures are recorded in Phase 0 results |
| Font enumeration is slow, platform-specific or needs a permission | Local Font Access took 20 ms in Phase 0; lazy and cached; free text works without it |
| Rendering hundreds of families in their own faces makes the picker slow | Phase 0 measured it (seconds at 1,000); options take their face only once on screen, which kept opening near a plain list |
| Users set a font, then move to a computer without it | The role's fallbacks; the page warns |
| Theme fonts surprise users | Sources shown on the page, Reset per role, and the switch |

---

## Decisions taken in review

Decided on 2026-11-08 (1 to 7 on the design; 8 and 9 on Phase 0's findings). No open questions remain.

| # | Question | Decision | Where it lands |
|---|---|---|---|
| 1 | Pixels or points? | **Pixels**, stored and shown. Points would be more confusing | Decision 13 |
| 2 | Size limits | **Two tiers as proposed**: a wide range for the user, a narrow one for themes, so a theme can't break the layout. The figures are checked in Phase 0 | [Sizes and their limits](#sizes-and-their-limits) |
| 3 | Per-mode theme fonts | **Not in the first version;** flagged as future work. `fonts` can move into the variants later without breaking existing themes | [Later](#later-not-scheduled) |
| 4 | Sharing drafts between the shell's own pages | **Later, if required** | [Later](#later-not-scheduled) |
| 5 | A size for Headings | **Not now.** A "larger headings" percentage is a later feature, if required | [Later](#later-not-scheduled) |
| 6 | May a font shipped with a theme be used for figures? | **Never** | [Security](#security-and-robustness); [6a](#6a-fonts-shipped-inside-a-theme-l) |
| 7 | Text-size shortcuts | **Later** | [6c](#6c-text-size-commands-s) |
| 8 | The minimum for Interface text (Phase 0 found tooltips of 7.9 px at 10) | **11 px** | [Sizes and their limits](#sizes-and-their-limits) |
| 9 | The Navigator at large sizes (Phase 0 found names squeezed to a letter) | **It scales horizontally, as the register does:** names keep a readable minimum, and the tree scrolls sideways | [Phase 2 results](#phase-2-results) |

---

# Part 2: Implementation

## Ground rules

The [account manager's ground rules](account-manager-implementation.md#ground-rules) apply unchanged: every phase ends
with a working app and a green `npm test`; tests mirror the source folders; renderer components are tested with Testing
Library and the fake bridge; the architecture test keeps passing; `tsc --noEmit` adds no new errors; each phase ends
with a manual smoke test in `npm run dev`, in light and dark.

Sizes: **S** is about a day, **M** a few days, **L** about a week.

Two rules specific to this work:

- **The defaults don't move.** Until Phase 3 there is no visible change except the ones listed in Phase 2: the
  Settings Inspector's fixed-width text, and two fixes Phase 0 found (registered icons, the register's status column).
  The golden test from Phase 1 guards this.
- **Resolution is pure and shared.** Everything that decides what font a role gets is in `shared/fonts/`, with no DOM,
  MUI or Electron, so main and renderer agree and it can be tested exhaustively.

## Dependency graph

```
Phase 0 ──► Phase 1 ──┬──► Phase 2 (roles in code) ─────┐
 (spike)    (roles as │                                 ├──► Phase 4 (the Fonts page) ──► 6b, 6c
            data)     └──► Phase 3 (setting, delivery) ─┤
                                                        └──► Phase 5 (themes set fonts) ──► 6a
```

Phases 2 and 3 can run in parallel. Phase 4 needs both, because the page would be misleading while amounts and
fixed-width text still ignore their roles. Phase 5 needs Phase 3 (Phase 2 is recommended first, for the same reason as
Phase 4), and Phases 4 and 5 are independent of each other. The page shows "from the theme" from the start, because
resolution supports the theme layer from Phase 1; it just never happens before Phase 5.

---

## Phase 0: spike (S)

Answers the questions the design depends on, in throwaway code. The findings go into a *Phase 0 results* section of
this note.

| Question | How | Decides |
|---|---|---|
| How to list installed fonts in Electron 45, on Windows, macOS and Linux | Try Local Font Access (`queryLocalFonts`) through Electron's permission handlers, and a main-process platform listing; time each on a machine with many fonts; check it in a packaged build; check whether a plugin view could then list fonts too | The `FontCataloguePort` adapter (Phase 4), or free text only if nothing meets the criteria |
| MUI 9's figures at `fontSize: 13`: `body1`, `body2`, `caption`, `overline`, `h4`–`h6`, `subtitle1/2`, `button`, tooltip, table cell, and `SvgIcon` `small`/`medium` | Render each and read the computed styles | The golden test (Phase 1); whether `Icon` must change (Phase 2) |
| Custom variants across federation | Add `numeric` to a scratch theme; use `variant="numeric"` and `sx={{ typography: 'numeric' }}` from the `themed` fixture plugin ([tests/fixtures/ui-plugins/themed](../tests/fixtures/ui-plugins/themed)); type-check the plugin against the augmentation | The `@tessera/ui` API (Phase 2) |
| The picker with hundreds of families | `Autocomplete` with 500 options, each in its own face: time to open and to filter | Whether the picker needs a virtualised list (Phase 4) |
| The layout at the extremes | Temporarily set `fontSize` to 10 and 24; look at bars, tabs, rails, toolbars, the register, the Options dialog, dialogs | The size limits, and the fixed heights to fix in Phase 4 |

**Exit:** the results section is written, and the limits and the catalogue mechanism are settled.

### Phase 0 results

Done on 2026-11-08. The spike's code was throwaway and was deleted after review; what it found is recorded here.

**How it was run.** `npm install` needed no version changes, and the suite was green before the spike and after it
(125 files, 1,887 tests). Electron's binary couldn't be downloaded where the spike ran (only the npm registry was
reachable), so the browser measurements used **Chromium 153** from the `@sparticuz/chromium` npm package, against the
machine's own fonts. Electron 45.2 embeds Chromium 156. The pages were built by Vite from the repo's own sources: the
real `createShellTheme`, `ShellThemeProvider`, layout frame, `SettingsDialog`, and the accounts plugin's `Navigator`
and `Register`, over a stand-in main process. The one patch was `fontSize: 13`, made a parameter at build time. What
only Electron can answer is marked **not verified**.

| Question | Answer |
|---|---|
| 1. Listing installed fonts | **Local Font Access (`queryLocalFonts`), from a dedicated hidden page that alone is granted `local-fonts`.** 20 ms for 248 faces in 56 families (4 ms when asked again), with no user gesture once granted. A `file://` page is a secure context and works. Electron 45's permission handlers know `'local-fonts'` (`electron.d.ts`). The platform listings are worse. Details below |
| 2. MUI 9's figures at 13 px | **As the design assumed for variants:** `body2` 13, `body1` 14.86, `caption` 11.14, `h6` 18.57, tooltip 10.21. Every variant scales in proportion. **Two corrections:** small buttons are 12.07 px (`pxToRem(13)`), not 13, and fields, menu items and list text are `body1` (14.86), not 13. **The icon mismatch is real, and there is a second bug.** Details below |
| 3. Custom variants across federation | **They work.** A plugin built by `scripts/build-plugins.mts` and loaded through the shell's federation loader renders `variant="numeric"` as a `<span>` with `tabular-nums`, `sx={{ typography: 'numeric' }}` too, and reads `theme.typography.numeric`. Its build contains no MUI. The module augmentation type-checks plugin code. With it, only a misspelt variant fails, and TypeScript suggests `"numeric"`; without it, the three real uses fail. `sx={{ typography }}` accepts any string, so only `variant` is checked |
| 4. The picker with many families | **Draw an option in its own face only once it is on screen** (an `IntersectionObserver`, no new dependency). Opening 1,000 families each in its own face took 1.5 to 2.6 s; lazily, 0.29 s, against 0.19 s for a plain list |
| 5. The layout at the extremes | **Nothing overflows vertically:** bars, tabs, toolbars and rows grow with the text. **Horizontally, the register's pixel column widths truncate amounts from 16 px**, which is the top of the *theme* range. Fixed in the spike by putting the widths in `em`. **The Navigator squeezes account names** and needs a decision. Details below |

#### 1. Listing installed fonts

| Way | Result |
|---|---|
| `queryLocalFonts()`, permission granted | 248 faces, 56 families, 20 ms. The names are typographic families: "DejaVu Sans" covers its Light and Condensed faces, which CSS reaches through weight and stretch. 52 of the 56 render by name; the other 4 have no Latin glyphs (Greek-only, emoji, symbols) |
| `queryLocalFonts()`, permission not granted | **No error: an empty list.** So an empty answer means "not allowed", never "no fonts"; the adapter treats it as unavailable (`complete: false`) |
| `fc-list` (Linux) | 148 names in 34 ms, including 92 that Local Font Access doesn't list: Type 1 fonts Chromium can't draw (Courier, Bitstream Charter) and per-style aliases ("DejaVu Sans Light") |
| `font-list` (npm), the usual main-process package | Windows: starts PowerShell and asks WPF, slow to start and not the font system Chromium uses. macOS: runs a precompiled executable shipped in `node_modules`, a problem for signing and notarising. Linux: `fc-list`, as above |

**Why a dedicated page.** Plugin views run in the shell's page, with the same origin and frame. Electron's permission
handlers can only tell requests apart by `webContents` and origin. Granting `local-fonts` to the application's window
would therefore grant it to every plugin view. So the main process opens a small hidden `BrowserWindow` (its own
`webContents`, a `file://` page of the shell's), grants `local-fonts` to that `webContents` only, asks it for the
families, and closes it.

**Not verified:** this in Electron itself, on Windows, macOS and Linux; the first task of Phase 4.

**Is a font installed?** Check the family against the list, case-insensitively. Measuring text is no substitute:
fontconfig substitutes aliases on Linux, so 90 of those 92 extra names "render" as something, "Courier" included. And
a font without Latin glyphs measures as missing.

#### 2. Sizes and icons, computed in the browser

At the default 13 px (it was also measured at 10, 16 and 24 px, where everything that follows `pxToRem` scaled in proportion):

| Element | px | Follows |
|---|---|---|
| `body2`, `subtitle2`, tabs, table cells, dense menu items, alerts | 13 | `body2` / `button` |
| Body text (`CssBaseline`), plain `Typography`, `body1`, `subtitle1`, **text fields, menu items, list item text** | 14.86 | `body1` |
| **Buttons (small, the shell's default), toggle buttons** | **12.07** | `pxToRem(13)` |
| `caption`, `overline`, helper text | 11.14 | `caption` |
| Tooltip | 10.21 | `pxToRem(11)` |
| `h6`, dialog titles | 18.57 | `h6` |
| Standard icon, `small` / `medium` | 18.57 / 22.29 | `pxToRem(20 / 24)`, so **they scale** |
| **Registered icon, `small` / `medium`** | **20 / 24, at every size** | fixed `rem` in `Icon.tsx` |
| Standard icon as a button's start icon | 18, at every size | MUI's fixed `fontSize: 18` for small buttons |
| **Registered icon as a button's start icon** | **24, at every size** | its own `width`/`height`, which ignore that rule |

Two findings about icons, both in today's code at the default size:

- **Registered icons don't match standard ones:** 20 px against 18.57 for `small`. The gap grows with the text: at 24
  px it is 20 against 34.3.
- **A registered icon in a button is 24 px, a standard one 18.** `Icon` sizes registered icons with `width` and
  `height`, but MUI sizes button icons through `font-size`.

Sizing registered icons as MUI does (`font-size` from `pxToRem`, and `width`/`height: 1em`) fixes both (Phase 2).
**Button icons stay 18 px whatever the text size**, because MUI fixes them; Phase 2 scales them in the theme by the
interface size over 13, so they are unchanged at the default.

#### 5. The layout at 10, 13, 16, 20 and 24 px

- **Nothing overflows a fixed height** anywhere: the top bar grew from 33 to 49 px, the tab strip from 37 to 52, a register
  row from 32 to 47. The Options dialog holds up at 24 px; its page scrolls.
- **The register truncates amounts.** Its columns are pixel widths sized for 13 px text
  (`<col style={{ width: 115 }}>`, `minWidth: 820`), and its cells ellipsise. Amounts cut short:
  - at 13 px: none;
  - at 16 px: 3 (running balances: "CA$3,949…");
  - at 20 and 24 px: 8.

  In a finance application a truncated amount reads as a different number.
- **The fix, tried:** the same widths in `em` of the table's text, and the table's minimum width too. At 13 px it is
  identical. **At every size no amount is cut**, the other clipped cells stay today's five, and from 16 px the register
  scrolls sideways in a 1,280 px window. The columns alone were not enough: without the minimum in `em`, the fixed
  columns squeezed Payee and Category to nothing at 20 px.
- **The Navigator squeezes names.** Its bar is 260 px and the balances keep their width, so names shrink:
  - at 13 px: "Home Fin…";
  - at 20 px: a letter or two;
  - at 24 px: the balances overflow the bar and the toolbar's first button is pushed out of it.

  The user can widen the bar, and the width is kept, but the default should not break.
- **Tabs:** "Ledger" truncates at 20 px and shows only its icon at 24.
- **Already wrong at 13 px:** the register's status column is 36 px, 32 of them padding, so its letters show as "C…" and
  "V…".

#### What changes in this note

| Where | Change |
|---|---|
| [The catalogue](#the-catalogue) | The figures for Interface text: buttons 12.07 px, fields and menus 14.86 |
| [The installed-font catalogue](#the-installed-font-catalogue) | Local Font Access from a dedicated hidden window, chosen; an empty answer is unavailable; "installed" by membership |
| [Phase 2](#phase-2-roles-in-the-shells-and-plugins-code-l) | Registered icons sized like MUI's; button icons scaled; **the register's widths in `em`**; the status column; the Navigator and tab strip at large sizes. This is now where most of the phase's work is |
| [Phase 4](#phase-4-the-fonts-page-l) | The probe window first, verified in Electron; the lazy picker; the extremes re-checked with the Phase 2 fixes |
| [Risks](#risks) | Updated with what was found |

**Decided in review** (decisions [8 and 9](#decisions-taken-in-review)):

- **The interface minimum:** 11 px, where 10 gave 8.6 px captions and 7.9 px tooltips.
- **The Navigator:** it scales horizontally, as the register does. Names keep a readable minimum width and the tree
  scrolls sideways when the bar is too narrow ([Phase 2 results](#phase-2-results)).

---

## Phase 1: roles as data, no visible change (M)

| Task | Files |
|---|---|
| Types: `FontRoleId`, `FontWeight`, `FontSpec`, `ThemeFonts`, `FontSettings`, `FontSource`, `ResolvedFontRole`, `ResolvedFonts` | `tessera-types/fonts.ts`, exported from `tessera-types/index.ts` |
| The catalogue: ids, labels, descriptions, facets, parents, default families, user and theme size limits; `FONT_STACK` (moved from `createShellTheme.ts`) and `MONO_STACK`; `GENERIC_FAMILIES` | `shared/fonts/roles.ts` |
| Names and CSS: `isFontFamilyName`, `familyListProblem`, `cssFontFamily(names, fallback)` | `shared/fonts/families.ts` |
| Resolution: `resolveFonts(settings, themeFonts)` with sources; `DEFAULT_FONT_SETTINGS` (all Automatic) | `shared/fonts/resolveFonts.ts` |
| Roles into MUI: the mapping table in [Renderer](#renderer-roles-in-the-mui-theme), emitting only user or theme values; the `numeric` and `monospace` variants | `shell/renderer/theme/fontTheme.ts` |
| `createShellTheme` takes `fonts?: ResolvedFonts` (default: resolved from the defaults and the descriptor) and spreads the mapping in | `shell/renderer/theme/createShellTheme.ts` |
| Boundaries: `shared/fonts/` is platform-free (the existing rule for `shared/` covers it; check it does) | `tests/architecture/boundaries.test.ts` |

**Tests:** `fontFamilies.test.ts`, `fontRoles.test.ts` (see [Testing](#testing)); `fontTheme.test.tsx`, with the
golden tests at the defaults and one test per role's mapping.

**Exit:** no visible change; the golden test passes; `tsc --noEmit -p shared` adds no errors.

### Phase 1 results

Done on 2026-11-08. The roles exist as data, and the shell's MUI theme is built from them. **Nothing looks different**:
at the defaults, the theme's typography is the one the shell built before, variant by variant, and no component gains
a style.

| Piece | Where |
|---|---|
| Types: `FontRoleId`, `FontFacet`, `FontWeight`, `FontSpec`, `ThemeFonts`, `FontSettings`, `FontSource`, `ResolvedFontRole`, `ResolvedFonts` | [tessera-types/fonts.ts](../tessera-types/fonts.ts) |
| The catalogue (`FONT_ROLES`: labels, descriptions, facets, where the family comes from, size ratios and the two tiers' ranges), `FONT_STACK` (moved here from `createShellTheme.ts`), `MONO_STACK`, `BASE_FONT_SIZE`, `FONT_WEIGHTS`, and `fontSpecProblems` | [shared/fonts/roles.ts](../shared/fonts/roles.ts) |
| Names and CSS: `isFontFamilyName`, `familyListProblem`, `cssFontFamily`, `GENERIC_FAMILIES` | [shared/fonts/families.ts](../shared/fonts/families.ts) |
| Resolution: `resolveFonts(settings, themeFonts)`, `DEFAULT_FONT_SETTINGS`, `isChosen` | [shared/fonts/resolveFonts.ts](../shared/fonts/resolveFonts.ts) |
| Roles into MUI: `fontThemeOptions`, `rem` | [shell/renderer/theme/fontTheme.ts](../shell/renderer/theme/fontTheme.ts) |
| `createShellTheme` takes `fonts` (default: `resolveFonts()`); `mergeComponents` | [shell/renderer/theme/createShellTheme.ts](../shell/renderer/theme/createShellTheme.ts) |
| The `numeric` and `monospace` variants in MUI's types | [tessera-ui/typography.ts](../tessera-ui/typography.ts), imported by [tessera-ui/index.ts](../tessera-ui/index.ts) |

Departures from the plan, each small:

- **`resolveFonts` takes the theme's `fonts`, not the theme.** `ThemeDescriptor` doesn't gain `fonts` until Phase 5,
  and the two stay independent.
- **The shell's stacks stay constant CSS**, rather than name lists run through `cssFontFamily`. Quoting them would have
  changed today's `FONT_STACK` (it leaves `Roboto` and `Arial` unquoted), and the golden test compares the string.
- **`resolveFonts` checks every value again** and ignores what fails, as well as the validators Phases 3 and 5 will
  run on save and contribution: a second line of defence for what reaches a stylesheet.
- **`fontSpecProblems`** (one role's spec against its facets and a tier's range, with messages for people) was
  written now rather than in Phases 3 and 5, since both need it and it is defined by the catalogue.
- **The type augmentation moved here from Phase 2**, so the variants the theme defines are known to the types from the
  start. It adds no export (the pinned export list is unchanged); `@tessera/ui`'s version goes to 1.3.0 in Phase 2 with
  `useFontRoles`.
- **Tables style `MuiTable` as well as its cells**, as Phase 0 recommended, so Phase 2's `em` widths follow the role.
- **Helper text needs no override:** MUI draws it from `caption`, so it follows Small text.
- **`mergeComponents` merges slot by slot.** No component is styled by both the shell and a role yet, but a shallow
  merge would have let a role's `root` replace the shell's (Tabs set `minHeight` there).
- **A new architecture rule:** `shared/` imports no React, MUI or Emotion, since the main process will import
  `shared/fonts/` to check settings and themes.

Verification:

- **Tests.** The full suite passes: 128 files, 1,965 tests, up from 125 and 1,887.
  - `tests/shared/fontFamilies.test.ts` (39): accepted and refused names, every forbidden character on its own,
    injection attempts, lists, quoting, generic families.
  - `tests/shared/fontRoles.test.ts` (21): the catalogue, `fontSpecProblems` for both tiers, and resolution: the
    defaults, the [worked example](#resolution-who-wins) row by row, the switch, user over theme facet by facet,
    scaling, fallbacks, and hostile or malformed values ignored.
  - `tests/renderer/fontTheme.test.tsx` (17): the golden tests, one test per role's mapping, `mergeComponents`, and a
    numeric `Typography` and a table cell drawn in jsdom.
  - `tests/architecture/boundaries.test.ts`: the new rule, which fails on a planted React import.
- **The golden tests compare two ways.**
  1. Every standard variant, the base sizes and weights, and `pxToRem` equal a theme built the way `createShellTheme`
     built it before.
  2. The pixel figures Phase 0 measured in Chromium are pinned (`body2` 13, `body1` 14.86, `caption` 11.14, `h6`
     18.57, tooltip 10.21, small button 12.07, small icon 18.57), so an MUI upgrade that changes its scale fails
     loudly.

  The component list is pinned too.
- **The tests can fail.** Six deliberate bugs were planted, one at a time: the theme-fonts switch ignored, the default
  size moved, an inherited heading family emitted, the component merge made shallow, buttons losing their case, and
  `;` allowed in a name. Each failed at least one test. The last one at first failed nothing (every injection example
  also held another forbidden character), which is why every forbidden character is now tested on its own.
- **Types.** `tsc --noEmit` reports exactly the errors it reported before for `shell`, `tests`, `core`, and the
  accounts, import, ledger, settings-inspector and test-layout plugins, and none for `shared`.
- **A production build** of the renderer bundles the variants.

---

## Phase 2: roles in the shell's and plugins' code (L)

| Task | Files |
|---|---|
| `useFontRoles()` and a `FontRolesContext` the shell provides (in `internal.ts`, like `ThemeStateContext`) | `tessera-ui/fontRoles.tsx`, `tessera-ui/index.ts`, `tessera-ui/internal.ts` |
| `ShellThemeProvider` resolves the fonts once and provides them (for now from the defaults and the window's theme) | `shell/renderer/theme/ShellThemeProvider.tsx` |
| `@tessera/ui` 1.3.0: `useFontRoles`, and the `numeric` and `monospace` variants whose types Phase 1 added | `tessera-ui/package.json`, `tessera-ui/version.ts`, the pinned list in `tests/shared/tesseraUi.test.ts` |
| Registered icons sized as MUI sizes its own: `font-size` from `pxToRem(20/24/35)`, `width`/`height: 1em`, so they match standard icons at every size and obey a button's icon size. **Visible:** a registered `small` icon goes from 20 to 18.57 px, and one in a button from 24 to 18 | `tessera-ui/Icon.tsx`, `tests/renderer/icon.test.tsx` |
| Button start and end icons scaled by the interface size over 13 (MUI fixes them at 18, 20 and 22 px), emitted only when the size isn't 13 | `shell/renderer/theme/fontTheme.ts` |
| **The register's widths in `em`:** each `<col>` width and the table's `minWidth` as `em` of the table's text, each pixel width divided by 13 (the table always has its cells' size), rounded up so it is never a fraction of a pixel short at 13 px (`width: 115` becomes `8.8462em`, `minWidth: 820` becomes `63.077em`). The columns grow with the text, so no amount is cut because the text got bigger; the table scrolls sideways | `plugins/accounts/src/renderer/display.tsx` (`em`), `plugins/accounts/src/renderer/register/Register.tsx`, `shell/renderer/theme/fontTheme.ts` |
| The same review for the other tables (the reconciliation list, the Change Match dialog): widths in `em`, amounts never truncated | `plugins/accounts/src/renderer/reconcile/ReconcileList.tsx`, `plugins/import/src/renderer/MatchDialog.tsx` |
| The register's status column: 4 px of padding a side instead of MUI's 16, so its letter fits in the same 36 px (today "C…" at 13 px); the heading centred over it. **Visible** at the default | `plugins/accounts/src/renderer/register/Register.tsx` |
| The Navigator scales horizontally ([decision 9](#decisions-taken-in-review)): names keep at least 5 `em`, the rows share a box as wide as the widest needs, and the tree scrolls sideways; the toolbar wraps rather than pushing its first button out of the bar | `plugins/accounts/src/renderer/Navigator.tsx` |
| Bar tab strips: tabs narrow, labels cut with an ellipsis and shown as a tooltip while cut, so no tab slides out of view | `shell/renderer/layout/Bar.tsx` |
| Migrate the inventory, per the [migration table](#plugins-and-roles) | accounts, import, settings-inspector, test-layout renderers; `ThemePreview.tsx` |
| The guard test (no literal families, absolute sizes or `fontVariantNumeric` in renderer code outside the theme) | `tests/architecture/boundaries.test.ts` |
| A "Fonts" subsection in "Styling and theming": the roles, the two variants, `useFontRoles`, what not to do. Replace "the operating system's font is the shell's" | `docs/plugin-creation.md` |

**Tests:** the federation test renders `variant="numeric"` from the fixture plugin; the plugins' existing renderer tests
keep passing (their assertions are about text and roles, not fonts); the guard test fails on a planted `fontFamily`
literal, then passes; `icon.test.tsx` checks registered icons by `font-size` and `1em`; the register's test checks that
its widths are in `em` and that amount cells don't ellipsise. jsdom doesn't lay out, so the layout itself is checked by
hand in `npm run dev`, at 13, 16, 20 and 24 px, with the interface size forced in `createShellTheme` for the check: no
amount cut at any size, and no column squeezed to nothing.

**Exit:** at the default size, the visible changes are:

- the Settings Inspector's fixed-width text: 13 px, in `MONO_STACK`;
- registered icons: the same size as standard ones;
- the register's status letters: no longer cut.

Each is checked in light and dark; everything else is unchanged. The frame, at sizes up to 24 px (forced for the check),
truncates no amount.

### Phase 2 results

Done on 2026-11-08. The shell and the bundled plugins draw their text through the roles, and the layout holds from
13 to 24 px: no amount is cut, no name is squeezed to a letter, and no tab or button slides out of reach.

| Piece | Where |
|---|---|
| `useFontRoles` and `FontRolesContext`; `@tessera/ui` 1.3.0 | [tessera-ui/fontRoles.tsx](../tessera-ui/fontRoles.tsx), [index.ts](../tessera-ui/index.ts), [internal.ts](../tessera-ui/internal.ts) |
| `ShellThemeProvider` resolves the fonts once and provides them (the shell's own until Phase 3) | [ShellThemeProvider.tsx](../shell/renderer/theme/ShellThemeProvider.tsx) |
| Registered icons sized as MUI sizes its own | [tessera-ui/Icon.tsx](../tessera-ui/Icon.tsx) |
| Tables always sized like their cells; button icons scaled | [fontTheme.ts](../shell/renderer/theme/fontTheme.ts) |
| The register and the reconciliation list in `em` (the `em` helper); the status column | [display.tsx](../plugins/accounts/src/renderer/display.tsx), [Register.tsx](../plugins/accounts/src/renderer/register/Register.tsx), [ReconcileList.tsx](../plugins/accounts/src/renderer/reconcile/ReconcileList.tsx) |
| The Navigator scales horizontally; its toolbar wraps | [Navigator.tsx](../plugins/accounts/src/renderer/Navigator.tsx) |
| Bar tab strips narrow their tabs | [Bar.tsx](../shell/renderer/layout/Bar.tsx) |
| The inventory migrated: eight amounts to `numeric`, the Settings Inspector to `monospace`, test-layout's panel to `body2`, the theme preview's swatches to `caption` | accounts, import, settings-inspector and test-layout renderers; [ThemePreview.tsx](../shell/renderer/theme/ThemePreview.tsx) |
| The guard test | [boundaries.test.ts](../tests/architecture/boundaries.test.ts) |
| The "Fonts" section of the plugin guide | [plugin-creation.md](plugin-creation.md#styling-and-theming) |

Decisions and departures:

- **Tables always have their cells' size** (`MuiTable`'s root takes the Tables role's size, `body2` while Automatic).
  A `<col>`'s `em` is measured against the table, not its cells. Before, the table inherited body text (14.86 px) while
  its cells were 13, so setting a size for Tables would have changed that ratio, and columns would have narrowed about
  12% against their text, cutting the very amounts they were widened for. A table holds no text of its own, so nothing
  looks different. The Phase 1 golden test now lists `MuiTable` among the styled components, on purpose.
- **`em` widths are rounded up.** Rounded to the nearest, `80 / 13` is `6.1538em`, 79.9994 px at 13 px, and layout
  rounded it down. Every later column moved by a fraction of a pixel, and the comparison below showed the text's
  anti-aliasing change. Rounded up (`6.1539em`), the widths at 13 px are exact.
- **No separate "no ellipsis on amounts" rule.** Amounts were cut because pixel columns didn't grow with the text;
  with `em` columns they grow with it, and none is cut at any size. An amount too large for its column at any size (tens
  of millions) is still cut, as before; that is a separate question about column widths, not fonts.
- **The Navigator** ([decision 9](#decisions-taken-in-review)):
  - Names keep at least **5 `em`**: 65 px at 13 px, 120 px at 24. The first try was 6 `em`, but at 13 px the Mortgage
    row, with a balance in the hundreds of thousands, had 75 px for its name, and the tree scrolled by 3 px at the
    default size. At 5 `em` nothing changes at 13 px.
  - A name's minimum is what the row needs at the least, not its full length (it is `flex: 1 1 0`, `width: 0`,
    `min-width: 5em`), so names still shorten with an ellipsis when there is room for the minimum.
  - The rows share a box at least as wide as the widest row needs, so every row and its highlight is the same width
    when the tree scrolls. The box has `role="none"`, so the tree and tree-item structure is unchanged.
  - The toolbar wraps, as at 24 px its first button (New account) was pushed out of the bar, where scrolling couldn't
    reach it.
- **Bar tabs narrow, rather than showing scroll arrows.** `scrollButtons="auto"` was tried first, and made the default
  worse. The two tabs fit (205 of 222 px), but MUI showed arrows on an overflow of a pixel during layout, and the
  hidden start arrow's 40 px then made the overflow real, so the arrows stayed and "Ledger" slid out of view. Tabs now
  narrow instead (`min-width: 0`, `flex-shrink: 1`). A label cut short gets an ellipsis, and its full text as the
  tooltip while it is cut.
- **The type augmentation** landed in Phase 1; `@tessera/ui` became 1.3.0 here, with `useFontRoles`.
- **Also in this change** (a request in review, not font roles): the Options dialog's title has half MUI's vertical
  padding, 8 px instead of 16, so its row is 46 px instead of 62. After review it became the theme's default for every
  dialog title (`MuiDialogTitle` in `createShellTheme`), so the frame the shell draws for plugins' dialogs (the Settings
  Inspector's, the account and import dialogs) and plugins' own have it too.

**Visible at the default size**, and nothing else:

- the Settings Inspector's fixed-width text: 13 px in `MONO_STACK`, where it was 12 px in the browser's `monospace`;
- registered icons: the size of standard ones (a `small` one 18.57 px, was 20; one in a button 18, was 24);
- the register's status letters: whole ("C", was "C…"), with the heading centred over them;
- the theme preview's status swatches: `caption` (11.14 px), were `0.75rem` (12 px);
- the Options dialog's title row: 46 px, was 62.

Verification:

- **Tests.** The full suite passes: 131 files, 1,987 tests (Phase 1 ended at 128 and 1,965).
  - `tests/plugins/accounts/renderer/fontRoles.test.tsx` (6). The register, the reconciliation list and panel, and
    the Navigator are rendered in the shell's theme with amounts set to "Cascadia Mono" and tables to 15 px. Every
    amount and balance is drawn in that face, widths are in `em`, the table has its cells' size, the status cell has
    its padding, names keep 5 `em`, the tree scrolls, and the toolbar wraps.
  - `tests/plugins/import/renderer/fontRoles.test.tsx` (2) and `tests/plugins/settings-inspector/renderer/fontRoles.test.tsx`
    (1): the import's amounts and the inspector's fixed-width text.
  - `tests/renderer/icon.test.tsx` (+5): registered icons have the standard ones' size at each size and interface size,
    grow with it, match in a button, and follow `inherit`.
  - `tests/renderer/fontTheme.test.tsx` (+2): tables sized like their cells, button icons scaled.
  - `tests/renderer/shellComponents.test.tsx` (+2): tabs narrow, and show a tooltip only while cut.
  - `tests/renderer/settingsDialog.test.tsx` (+1): the title's padding.
  - `tests/renderer/shellTheme.test.tsx` (+2): `useFontRoles`.
  - `tests/architecture/boundaries.test.ts` (+1): the guard, which reported exactly the five literal lines planted to
    try it and none of the four allowed ones.
- **The tests fail on the code before this phase.** The accounts, import, inspector, icon, tab and title tests were run
  against the files as they were before (from git), and every one of them failed.
- **In a browser.** jsdom doesn't lay out, so a throwaway page was built twice, from the code before this phase and from
  the code after it. It held the real shell frame, the accounts navigator and register and the Options dialog, over a
  stand-in main process. It was drawn in Chromium 153.
  - **At 13 px, before and after, pixel by pixel,** only the intended changes differed: the registered icon on a bar
    button, the status column and its heading, and the Options title (which moved the rest of the dialog). Four
    further pixels differ, in the edges of the tab icons, and can't be seen.
  - **At 13, 16, 20 and 24 px:**

    | Size | Amounts cut | Narrowest register column | Register scrolls | Narrowest name | Tree scrolls | Tabs | Toolbar buttons out of the bar | Icons in buttons (registered / standard) |
    |---|---|---|---|---|---|---|---|---|
    | 13 | 0 | 36 px | no | 75 px | no | whole | 0 | 18 / 18 |
    | 16 | 0 | 44 px | yes | 80 px | yes | shortened | 0 | 22.1 / 22.1 |
    | 20 | 0 | 55 px | yes | 100 px | yes | shortened | 0 | 27.7 / 27.7 |
    | 24 | 0 | 66 px | yes | 120 px | yes | shortened | 0 | 33.2 / 33.2 |

    Phase 0 had 3 amounts cut at 16 px and 8 at 20 and 24, names of a letter or two at 20 and 24, the Ledger tab out of
    view at 24, and the toolbar's first button out of the bar.
  - That Chromium hides scrollbars (`--hide-scrollbars`), so its screenshots show the register and the tree cut off at
    the right. The app shows scrollbars there.
- **Types.** `tsc --noEmit` reports exactly the errors it reported before, for every project.
- **`npm run build:plugins`** builds all nine bundled plugins.
- **Not checked in Electron** (still not available where this ran), nor in dark mode in a browser; the theme tests cover
  both modes.

---

## Phase 3: the `shell.fonts` setting, delivered to every window (M)

| Task | Files |
|---|---|
| `FONT_SETTINGS_ID`, `FONT_SETTINGS` (null defaults), `fontSettingsProblems` with user-readable messages | `shared/fonts/settings.ts` |
| Register the namespace beside `shell.theme`; pass the handle to `registerTheme` | `shell/main/app.ts` |
| `ThemeSnapshot.fonts` | `tessera-types/theme.ts` |
| `registerTheme`: include `fonts` in every snapshot; on `fontSettings.onDidChange`, publish to every attached window | `shell/main/theme/registerTheme.ts` |
| The initial synchronous snapshot carries it (through `snapshotFor`; check the preload needs no change) | `shell/main/theme/initialTheme.ts`, `shell/preload/preload.ts` |
| `ShellThemeProvider` resolves `snapshot.fonts` against the window's theme; the memo key includes the resolved fonts | `shell/renderer/theme/ShellThemeProvider.tsx` |
| `useThemeCatalogue()` also exposes the font settings, for the Appearance and Fonts pages | `shell/renderer/theme/ShellThemeProvider.tsx` |

**Tests:** `fontSettings.test.ts`; `registerTheme.test.ts` (snapshots carry fonts, a change publishes once per window,
including a window with its own theme); `initialTheme.test.ts`; `app.test.ts` (committing `shell.fonts` through
`shell:settings.commit` re-fonts the window, and `settings/shell.fonts.json` holds only the difference);
`shellTheme.test.tsx` (the provider re-renders with new fonts, and ignores another window's snapshot).

**Exit:** editing `settings/shell.fonts.json` by hand and restarting changes the fonts with no flash. The Settings
Inspector shows the namespace and "Matches its file". No UI yet.

### Phase 3 results

Done on 2026-11-08. The user's fonts are a setting, `shell.fonts`, sent to every window with its theme. **At the
defaults, nothing looks different**: every role is Automatic and there is no file, and the windows are drawn pixel for
pixel as before (see Verification).

| Piece | Where |
|---|---|
| `FONT_SETTINGS_ID`, `FONT_SETTINGS`, `fontSettingsProblems` | [shared/fonts/settings.ts](../shared/fonts/settings.ts) |
| `ThemeSnapshot.fonts` | [tessera-types/theme.ts](../tessera-types/theme.ts) |
| The namespace registered beside `shell.theme`, handed to `registerTheme` | [shell/main/app.ts](../shell/main/app.ts) |
| Every snapshot carries the fonts; a change is published to every attached window | [shell/main/theme/registerTheme.ts](../shell/main/theme/registerTheme.ts) |
| The window resolves the fonts in its snapshot; the catalogue carries them | [ShellThemeProvider.tsx](../shell/renderer/theme/ShellThemeProvider.tsx) |
| The Appearance page's preview draws a theme in the user's fonts | [AppearancePage.tsx](../shell/renderer/settings/pages/AppearancePage.tsx), [ThemePreview.tsx](../shell/renderer/theme/ThemePreview.tsx) |

Decisions and departures:

- **Nothing in the delivery path needed changing.** `shell:theme.initial` (the preload's synchronous request) and
  `shell:theme.get` both answer with `snapshotFor`, so the fonts reach a window's first render without a change to
  `initialTheme.ts` or the preload.
- **`ThemeSnapshot.fonts` is required**, since the main process always sends it. The renderer still falls back to the
  defaults for a snapshot without it. Seven test fixtures that build snapshots by hand gained
  `fonts: DEFAULT_FONT_SETTINGS`.
- **A change of fonts is published directly.** The theme manager announces changes of `ThemeState`, which a change of
  fonts doesn't touch, so `registerTheme` publishes each attached window's snapshot itself, once per window. An update
  that changes nothing, and a change to another setting, publish nothing.
- **The window resolves again only when the fonts change.** Every snapshot from the main process holds a new fonts
  object, so the provider compares them by value. A snapshot with the same fonts keeps the same MUI theme object,
  which a test checks.
- **The Appearance preview uses the user's fonts now,** rather than in Phase 5: it is the same `ThemePreview`, and it
  would otherwise have shown the shell's fonts while the application showed the user's. Phase 5 adds the previewed
  theme's own fonts.
- **A hand-edited file that doesn't pass is set aside**, as the settings framework does for every namespace: its
  defaults are used, and the log says why ("Interface text: choose a size from 11 to 24 px").

Verification:

- **Tests.** The full suite passes: 132 files, 2,009 tests (Phase 2 ended at 131 and 1,987; the dialog-title change
  added one).
  - `tests/shared/fontSettings.test.ts` (9): the definition, what is accepted and refused with its message, roles a
    newer version wrote. And through the real settings service: only what differs is saved, setting a value back to
    Automatic removes it and then the file, a hand-edited file is read, and a bad one gives the defaults and a warning.
  - `tests/main/registerTheme.test.ts` (+5): snapshots carry the fonts, including the preload's. A change is published
    once per window, each with its own state (one with a theme of its own included). Nothing is published for no
    change, for another setting, or while there is no window, and what the user couldn't have chosen is refused.
  - `tests/main/app.test.ts` (+1, and two extended). The composition root, through the real IPC: the Options dialog's
    catalogue lists `shell.fonts`, and a commit re-fonts the window. `settings/shell.fonts.json` holds
    `{ "version": 1, "values": { "roles": { "ui": { "family": ["Inter"], "size": 16 } } } }`. A size of 99 is refused with
    its reason and changes nothing, and back at the defaults the file goes. `shell:theme.get` and the synchronous
    initial snapshot carry the defaults.
  - `tests/renderer/shellTheme.test.tsx` (+5). The first render is already in the user's fonts, with no frame in the
    shell's. At the defaults the MUI theme equals the one built before, so nothing moves. A change re-fonts the window,
    another window's is ignored, and the same fonts keep the same theme object.
  - `tests/renderer/appearancePage.test.tsx` (+1): the preview in the user's family and size.
- **The tests fail on the code before this phase:** `registerTheme.ts`, `app.ts`, `ShellThemeProvider.tsx` and the
  Appearance page, each swapped back, failed the tests written for them.
- **In a browser, before and after, pixel by pixel.** A throwaway page was built twice in Chromium 153: once from a
  copy of the code before this phase and once from after it. It held the real shell frame, navigator and register, and
  the Options dialog with the Appearance page and its preview, over a stand-in main process that sends snapshots as
  the real one does. At the defaults, **0 pixels differ**, in light and in dark, for the window and the dialog. As a
  control, a snapshot with Interface text at 16 px drew the register's cells at 16 px after (13 before, which ignored
  it).
- **Types.** `tsc --noEmit` reports the same errors as before for every project (one in the tests moved line).
- **Not checked in Electron** (still not available here): the Exit's check, editing the file by hand and restarting, is
  covered by the app test (the file read at start-up) and the preload's synchronous snapshot, not by running the app.

---

## Phase 4: the Fonts page (L)

| Task | Files |
|---|---|
| **First, in Electron on Windows, macOS and Linux:** the probe window lists fonts, and the application window (so a plugin view) still gets an empty list. Phase 0 could check this in Chromium only | a throwaway branch, then the adapter below |
| `FontCataloguePort` and its Electron adapter: the hidden probe window, `local-fonts` granted to its `webContents` only, an empty answer treated as unavailable, cache and timeout; `shell:fonts.families` | `shell/main/fonts/fontCatalogue.ts`, `shell/main/fonts/fontProbe.html`, `shell/main/fonts/registerFonts.ts`, `shared/fonts/types.ts` (ids, channel) |
| The page contribution `shell.appearance.fonts` under Appearance; the `shell.fonts.choose` command | `shell/main/fonts/registerFonts.ts` |
| The page: the switch and theme note, a row per role with its facets, sources, Reset, the missing-font warning, validity | `shell/renderer/settings/pages/FontsPage.tsx`, `shell/renderer/fonts/FontRoleRow.tsx` |
| The family picker: Automatic, generic families, installed families each drawn in its own face once on screen (an `IntersectionObserver`, as in the spike), free text, the name rule as you type | `shell/renderer/fonts/FamilyPicker.tsx` |
| `ThemePreview` gains `fonts`, a two-row register with amounts and a fixed-width line; the Fonts page uses it with the draft | `shell/renderer/theme/ThemePreview.tsx` |
| Register the built-in page | `shell/renderer/settings/builtIns.ts` |
| Re-check the extremes with the Phase 2 fixes in, through the real setting this time (Phase 0 found no fixed height that clips; the horizontal problems are Phase 2's) | by hand in Electron |

**Tests:** `fontCatalogue.test.ts` with a fake port; `fontsPage.test.tsx` ([Behaviour worth testing](#behaviour-worth-testing)),
in the real `SettingsDialog` with the fake bridge; `settingsDialog.test.tsx` (the page is under Appearance in the tree,
and search finds it by "larger text"); `app.test.ts` (the page is listed; the command opens the dialog there).

**Manual:** on Windows, macOS and Linux: the list of fonts; choosing Inter, Apply, and watching two windows change;
Cancel; a size of 24 and of 11 everywhere, including the Options dialog itself; a missing font; keyboard only; a screen
reader on one row.

**Exit:** a user can change every role's font from Tools ▸ Options… ▸ Appearance ▸ Fonts. The README's "What works
today" mentions it.

### Phase 4 results

Done on 2026-11-08, except the checks that need Electron (listed at the end). Tools ▸ Options… ▸ Appearance ▸ Fonts
sets every role's font, size and weight, with what Automatic gives, where each value comes from, a Reset per role, the
theme-fonts switch and a live preview. OK or Apply saves `shell.fonts`, and every window is drawn in it (Phase 3).

**In Electron, before this phase.** A screenshot of the running app (Windows, dark mode) showed the Settings
Inspector with `shell.fonts` registered by the shell, at its defaults, with no file: Phase 3 as intended. It also
showed its paths and settings in the Fixed-width text role from Phase 2.

| Piece | Where |
|---|---|
| `FONTS_FAMILIES`, `InstalledFonts`, `FONT_COMMANDS`; the page's id and module | [shared/fonts/types.ts](../shared/fonts/types.ts), [shared/fonts/settings.ts](../shared/fonts/settings.ts) |
| The catalogue: listed once, sorted, each name once, only names the shell accepts, a 5 s limit, failures as "not available" | [shell/main/fonts/fontCatalogue.ts](../shell/main/fonts/fontCatalogue.ts) |
| The probe: a hidden window on a session of its own, loading a page built next to `app.js` | [electronFontProbe.ts](../shell/main/fonts/electronFontProbe.ts), [fontProbe.html](../shell/main/fonts/fontProbe.html), [shell/main/vite.config.ts](../shell/main/vite.config.ts) |
| The page, `shell.fonts.choose`, `shell:fonts.families` | [registerFonts.ts](../shell/main/fonts/registerFonts.ts), [app.ts](../shell/main/app.ts) |
| The installed fonts in a window, asked for once, lazily | [shell/renderer/fonts/InstalledFonts.tsx](../shell/renderer/fonts/InstalledFonts.tsx), [main.tsx](../shell/renderer/main.tsx) |
| The family picker | [FamilyPicker.tsx](../shell/renderer/fonts/FamilyPicker.tsx) |
| The page | [FontsPage.tsx](../shell/renderer/settings/pages/FontsPage.tsx), [builtIns.ts](../shell/renderer/settings/builtIns.ts) |
| The preview's samples of every role | [ThemePreview.tsx](../shell/renderer/theme/ThemePreview.tsx) (`fontSamples`) |

Decisions and departures:

- **The probe has a session of its own** (an in-memory partition), and its permission handlers grant `local-fonts`
  to the probe's `webContents` only. **The application's session is untouched.** Electron's documentation doesn't
  say what its default handlers grant, and replacing them for every window could change other permissions. Whether
  plugin views can already list fonts under those defaults is one of the Electron checks below; if they can, it
  belongs with the [security](todo.md#security) work, not here.
- **Each installed face is reduced to its family names,** and the catalogue keeps only names the shell accepts (a
  name it would refuse can't be chosen, so it isn't offered).
- **Typing takes a preference list:** names separated by commas (`Georgia, serif`), each checked against the name
  rule as it is typed. A comma can't be part of a name, so the reading is unambiguous.
- **Automatic says what it gives, briefly, in the box** ("Automatic: Inter"); why it gives that is the row's
  sources line ("Font: follows Interface text · Size: yours · Weight: automatic (Regular)"). The first layout put the
  reason in the box and "Automatic (Regular)" in the weight box, and the browser check found both cut off.
- **The system's generic families are drawn in themselves in the list,** at once (they cost nothing). Installed
  fonts are drawn in themselves once on screen, as Phase 0 recommended.
- **Each role is a group named by a heading** (`role="group"`, `h3`), not a `fieldset`: the heading isn't the
  fieldset's first child in this layout, which a `legend` has to be. Screen-reader users can move between roles by
  heading.
- **The preview's samples of every role** (a caption, two register rows with figures, fixed-width text) appear on the
  Fonts page only (`fontSamples`). The Appearance page's preview is unchanged.
- **The theme-fonts switch is there now,** though no theme sets fonts until Phase 5; the note beside it says that the
  window's theme sets none.
- **The guard test allows the picker** (`FamilyPicker.tsx`), which draws each installed font in its own face: choosing
  a font is the one place a family is named in a view, and the names come from the catalogue.
- **A flaky test fixed.** Phase 2's test of a registered icon in a button compared the two icons' computed sizes.
  Run with other files in a shared jsdom document, the result depended on the order earlier tests had added their
  styles, and it failed once in a full run. It now checks what decides the size in a browser: the icon is the first
  child of the button's icon slot, and is `1em` square. The sizes themselves were measured in Chromium in Phase 2.

**Visible changes:** the Fonts page, under Appearance in the Options dialog's tree. Nothing else changes until a font
is chosen.

Verification:

- **Tests.** The full suite passes, three runs in a row: 137 files, 2,039 tests (Phase 3 ended at 132 and 2,009).
  - `tests/main/fontCatalogue.test.ts` (6): sorting, once per name whatever its case, refused names dropped, listed
    once and lazily, a failure, an empty list and a non-list as "not available", logged once, the time limit.
  - `tests/main/electronFontProbe.test.ts` (3), with Electron's pieces faked:
    - a hidden window on the probe's own partition, loading the probe page, asked, and closed;
    - `local-fonts` granted to that page only, and nothing else to it;
    - closed, too, when the page or the question fails.
  - `tests/main/registerFonts.test.ts` (3): the page under Appearance, the command, the IPC.
  - `tests/main/app.test.ts` (+1): through the composition root, the page in the catalogue, the command opening the
    dialog there, and a font-list request that, under the mocked Electron, answers "not available" rather than failing.
  - `tests/renderer/fontsPage.test.tsx` (13), in the real Options dialog:
    - the tree and search;
    - the rows and their controls;
    - what Automatic gives, and the sources;
    - choosing an installed font (in its own face) and OK;
    - typing, with the name rule and OK disabled;
    - sizes, with their range and Automatic;
    - weights;
    - Reset and Restore Defaults;
    - the missing-font warning, only with a complete list;
    - working without the list;
    - the switch;
    - the preview following the draft;
    - read-only.
  - `tests/renderer/installedFonts.test.tsx` (4): asked once and lazily, a failure, no provider, the channel.
- **The main process builds** with the probe page next to `app.js` (`font-probe.html`).
- **In a browser.** A throwaway page drew the Options dialog at the Fonts page in Chromium 153 over a stand-in main
  process, with this machine's fonts. The cases: light and dark, with choices made, with the picker open, scrolled to
  the preview, and with Interface text applied at 24 px. After the two fixes above, no text on the page is cut off in
  any of them. At 24 px the size and weight boxes wrap under the font box.
- **Types.** `tsc --noEmit` reports the same errors as before for every project.

**In Electron, after this phase** (screenshots of the running app, Windows, dark mode): the page works; choices saved
from it (Interface text 11, Small text 10, Tables and registers 11, Fixed-width text 11) were written as exactly those
four differences, which the Settings Inspector reported as "Matches its file"; and the main window was drawn at 11 px.

**A misalignment found there, and fixed.** On the page, the Font box sat about 10 px below the Size and Weight boxes
of its row. Each row's controls were in a MUI `Stack`, which spaces its children with margins, and first sets the
margin of each direct child to 0. That took the theme's top margin (`margin: 'dense'`) from the size and weight boxes,
which are direct children, but not from the font box, which is wrapped in a `Box`. The row now spaces with `gap`
(`useFlexGap`), so every box keeps the same margin. Measured in Chromium: before, the size and weight boxes were 8 px
above the font box in every row; after, all three are level in every row. jsdom doesn't apply the reset the way a
browser does, so a test there passed with and without the fix and was not kept; the browser measurement is the check.

**To check in Electron** (not available here), on Windows, macOS and Linux:

1. The Fonts page lists the installed fonts. If it only offers typing, the log says why (`[fonts] …`).
2. In the main window's developer tools, `(await queryLocalFonts()).length` is `0` (or an error): the application's
   window, and so plugin views, can't list fonts. If it isn't, see the first decision above.
3. Choosing a font and a size, then OK, re-fonts every window, and `settings/shell.fonts.json` holds only them.
   Restarting keeps them, with no flash.
4. Keyboard only, and a screen reader on one row.

---

## Phase 5: themes set fonts (M)

| Task | Files |
|---|---|
| `ThemeDescriptor.fonts` | `tessera-types/theme.ts` |
| Validation and copying, with the theme size limits | `shared/theme/resolveThemes.ts` |
| The gallery: "Sets fonts: …" in the details, the miniature in the theme's fonts, the filter searching family names | `shell/renderer/theme/ThemeGallery.tsx` |
| The Appearance preview resolves the user's fonts against the previewed theme's fonts (it has used the user's since Phase 3); a note when theme fonts are switched off | `shell/renderer/settings/pages/AppearancePage.tsx` |
| The Fonts page names what the window's theme sets (already supported by resolution; check the sources show) | `shell/renderer/settings/pages/FontsPage.tsx` |
| The reference sample: *Sunrise* sets serif headings | `plugins/test-layout/src/privileged/index.ts` |
| "Contributing a theme" documents `fonts`; the theming note's decisions 9 and 18 and "Tokens, not code" are amended, linking here | `docs/plugin-creation.md`, `docs/theming-design.md` |

**Tests:** `themes.test.ts` (every rejection rule, the theme limits, copying); `fontRoles.test.ts` (the worked
example now end to end with a real descriptor); `testLayoutSample.test.ts` (Sunrise's fonts pass the shell's own
validator); `appearancePage.test.tsx` (the gallery's details and filter; the preview uses theme fonts under the user's);
`registerTheme.test.ts` (a window with its own theme gets that theme's fonts).

**Manual:** choose Sunrise: headings turn serif everywhere, the Fonts page says "from the theme", and turning the switch
off reverts them.

**Exit:** themes can set fonts; the user's choices still win; the switch works.

### Phase 5 results

Done on 2026-11-08. A theme may set fonts by role (`ThemeDescriptor.fonts`), checked like its colours. Each window
draws its theme's fonts for the roles the user left on Automatic, and the user's own choices win. The user can turn
themes' fonts off, and the Appearance and Fonts pages say what a theme sets. The test-layout sample's Sunrise sets
serif headings.

| Piece | Where |
|---|---|
| `ThemeDescriptor.fonts` | [tessera-types/theme.ts](../tessera-types/theme.ts) |
| Checking and copying a theme's fonts | [shared/theme/resolveThemes.ts](../shared/theme/resolveThemes.ts) |
| `describeThemeFonts`: what a theme sets, in words | [shared/fonts/roles.ts](../shared/fonts/roles.ts) |
| Each window resolves the user's fonts over its theme's | [ShellThemeProvider.tsx](../shell/renderer/theme/ShellThemeProvider.tsx) |
| The gallery: what a card's theme sets, its name in its font, the filter | [ThemeGallery.tsx](../shell/renderer/theme/ThemeGallery.tsx) |
| The Appearance preview under the previewed theme's fonts; the note when they are off | [AppearancePage.tsx](../shell/renderer/settings/pages/AppearancePage.tsx) |
| The Fonts page over the window's theme's fonts; its note | [FontsPage.tsx](../shell/renderer/settings/pages/FontsPage.tsx) |
| Sunrise's serif headings | [plugins/test-layout/src/privileged/index.ts](../plugins/test-layout/src/privileged/index.ts) |
| The plugin guide; the theming note's decisions 9 and 18 and its "Tokens, not code" | [plugin-creation.md](plugin-creation.md#styling-and-theming), [theming-design.md](theming-design.md#decisions) |

Decisions and departures:

- **A bad font skips the whole theme,** with a `[theme]` warning naming the role and the reason ("Theme "p.midnight"
  has a font that can't be used (Interface text: choose a size from 12 to 16 px.)"). That is how a bad colour is
  treated, so a typo shows instead of being quietly ignored.
- **Nothing in the main process changed beyond validation.** Snapshots already carry every theme's descriptor, so a
  theme's fonts reach each window with it. A window with its own theme resolves against that theme.
- **A theme's card shows its name in the theme's font** (its heading font, else its interface font), resolved, so the
  name is checked and quoted as everywhere else. The miniature has no text to draw.
- **The Appearance page's preview,** which has used the user's fonts since Phase 3, now resolves them over the
  previewed theme's, so it shows what choosing the theme gives. When that theme sets fonts and the user has turned
  themes' fonts off, the page says they aren't used and where to turn them on.
- **The Fonts page reads the window's theme,** not a theme chosen on Appearance but not yet applied (drafts aren't
  shared between pages: [later](#later-not-scheduled)).
- **Colour is not part of this:** see [Fonts and colour](#fonts-and-colour).

Verification:

- **Tests.** The full suite passes: 137 files, 2,060 tests (Phase 4 ended at 2,039).
  - `tests/shared/themes.test.ts` (+9): a theme's fonts kept and copied. Skipped, each with its reason, for: fonts
    that aren't an object, an unknown role, a facet the role lacks, a size the user could choose but a theme may not,
    a weight not offered, a family that isn't a list, a name that would break out of CSS, and a field that isn't a
    facet.
  - `tests/shared/fontRoles.test.ts` (+2): a contributed theme checked and then resolved under the user's fonts;
    `describeThemeFonts`.
  - `tests/plugins/testLayoutSample.test.ts` (+1): Sunrise's fonts pass the shell's own check.
  - `tests/main/registerTheme.test.ts` (+1): a theme's fonts reach the snapshot, and one with a bad font is refused
    with its reason in the log.
  - `tests/renderer/shellTheme.test.tsx` (+4): the window in its theme's fonts, the user's choice first, theme fonts
    off, and a window's own theme (and a change of theme) bringing its fonts.
  - `tests/renderer/appearancePage.test.tsx` (+3): the card's description, its name in the theme's font, the filter
    by font name; the preview under the user's fonts; the note when theme fonts are off.
  - `tests/renderer/fontsPage.test.tsx` (+1): what the window's theme sets, "from the theme", and the switch turning
    it off.
- **The tests fail without each change.** Each part was undone in turn, and each time the tests for it failed:
  - the window ignoring its theme's fonts: 2;
  - the Fonts page ignoring them: 1;
  - the preview ignoring them: 1;
  - the gallery not saying what a theme sets: 1;
  - themes with fonts refused as before: 6.
- **In a browser,** with the sample's Sunrise as the window's theme (Chromium 153, a throwaway page):
  - The dialog's and the page's headings are drawn in Georgia, and Sunrise's card says "Sets fonts: Headings
    (Georgia)" with its name in Georgia.
  - The Fonts page says what Sunrise sets, Headings' Automatic is Georgia "from the theme", and every row's boxes
    are level. Nothing on either page is cut off, in light or dark.
- **Types** are as before for every project, and `npm run build:plugins` builds all nine plugins.

---

## Phase 6: later, each scheduled separately

### 6a. Fonts shipped inside a theme (L)

For themes that want a typeface the user may not have. It needs the
[Content-Security-Policy](todo.md#security) work first, or alongside it.

- A theme's `fonts` may name a face from the plugin's `public/` folder:
  `{ id: 'ledgerbook.serif', file: './fonts/serif.woff2', weight: 400 }`. The file is resolved and served over
  `tessera-plugin://`, as icons are.
- **WOFF2 only, 1 MB at most per file, 4 files per theme.** Each face is registered with `@font-face` under a
  namespaced family (`tessera:<themeId>/<name>`), so it can never shadow an installed font such as "Segoe UI".
- **Never used for `numeric`** (see [Security](#security-and-robustness)); validation refuses it there.
- The window's ready signal waits for `document.fonts.ready` (bounded, as the reveal already is) so the first frame
  isn't drawn in a fallback; the CSP gains `font-src tessera-plugin:`.

### 6b. Roles contributed by plugins (M)

For plugins that need a role of their own, such as `accounts.register` apart from other tables.

- A `shell.fonts.roles` extension point: `{ id: 'accounts.register', label, description, parent: 'table', facets }`.
  The id is prefixed by the plugin's id, and **the parent must be a shell role**. Unset, the role *is* its parent, so
  themes (which know only the shell's roles) still style it.
- The Fonts page lists plugin roles under their parent, with the plugin's name. The setting keeps their values under
  `roles` (allowed by the merge rule), and `validate` checks them against the registered roles.
- Plugins use them through `useFontRoles()` and an `sx` helper; this is where a small registry in `core/` may become
  worthwhile (decision 10).

### 6c. Text-size commands (S)

`shell.fonts.increaseSize`, `decreaseSize` and `resetSize` change `roles.ui.size` through the setting, as the theme
commands change `shell.theme`, with Ctrl+=, Ctrl+- and Ctrl+0 and a View menu group. They step through the user range
and warn at its ends.

---

### Later (not scheduled)

Agreed in review as future work, each only if it is needed:

- **Per-mode theme fonts:** `fonts` inside a theme's `light` and `dark` variants, for example a lighter weight in dark
  mode.
- **Sharing drafts between the shell's own pages,** so the Fonts page previews a theme chosen on Appearance but not
  yet applied (a shell-only context in `SettingsDialog`).
- **A "larger headings" percentage** on the Headings role.

---

## Documentation changes

| Document | Change | When |
|---|---|---|
| This note | Phase results sections, as the other notes have; the status line | Each phase |
| [plugin-creation.md](plugin-creation.md#styling-and-theming) | A "Fonts" subsection; `fonts` in "Contributing a theme"; remove "the operating system's font is the shell's" | Phases 2 and 5 |
| [theming-design.md](theming-design.md) | Decisions 9 and 18, the "Tokens, not code" rule and the "Bundled fonts" non-goal point here | Phase 5 (6a for bundled fonts) |
| [todo.md](todo.md) | A "Fonts" group with the phases; "Settle the open questions… token breadth" updated | With review |
| [README.md](../README.md) | The design note in "Documentation"; the Fonts page in "What works today" | Review; Phase 4 |
