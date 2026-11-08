import { describe, expect, it } from 'vitest'
import type { ThemeDescriptor } from '@tessera/types'
import { isThemeColor, resolveThemes } from '../../shared/theme/resolveThemes'
import {
  DEFAULT_SELECTION,
  followsSystem,
  modesOf,
  parseStoredSelection,
  resolveSelection,
  selectionFor,
  selectionProblem
} from '../../shared/theme/selection'
import { DEFAULT_THEME, DEFAULT_THEME_ID } from '../../shared/theme/types'
import { midnight, sunrise } from '../helpers/theme'

const resolve = (...impls: unknown[]) => resolveThemes(impls.map(impl => ({ contributor: 'p', impl })))

describe('isThemeColor', () => {
  it.each(['#fff', '#ffff', '#1976d2', '#1976d2cc', 'rgb(1, 2, 3)', 'rgba(0,0,0,0.5)', 'hsl(120 50% 50%)', 'hsla(120, 50%, 50%, 0.3)'])(
    'accepts %s', value => expect(isThemeColor(value)).toBe(true))

  it.each(['red', 'transparent', '#12', '#12345', '#gggggg', 'rgb(', 'var(--x)', '', 12, null, undefined])(
    'rejects %s', value => expect(isThemeColor(value)).toBe(false))
})

describe('resolveThemes', () => {
  it("lists the shell's own theme first, even with nothing contributed", () => {
    expect(resolve()).toEqual({ themes: [DEFAULT_THEME], diagnostics: [] })
  })

  it('accepts a theme with both variants, or with one', () => {
    const { themes, diagnostics } = resolve(sunrise(), midnight())

    expect(diagnostics).toEqual([])
    expect(themes.map(t => t.id)).toEqual([DEFAULT_THEME_ID, 'p.sunrise', 'p.midnight'])
    expect(themes[2]).toEqual(midnight())
  })

  it('keeps a description, for where themes are chosen', () => {
    const { themes, diagnostics } = resolve(sunrise({ description: 'Warm oranges for early starts.' }))

    expect(diagnostics).toEqual([])
    expect(themes[1].description).toBe('Warm oranges for early starts.')
    expect(resolve(sunrise()).themes[1]).not.toHaveProperty('description')
  })

  it('copies a theme, so later changes by the plugin do not reach the registry', () => {
    const source = sunrise()
    const { themes } = resolve(source)
    source.light!.primary = '#000000'

    expect(themes[1].light!.primary).toBe('#ff8800')
  })

  it('keeps the fonts a theme sets, copied, so later changes by the plugin do not reach the registry', () => {
    const fonts = { heading: { family: ['Georgia', 'serif'], weight: 600 as const }, ui: { size: 14 }, numeric: { family: ['Cascadia Mono'] } }
    const source = sunrise({ fonts })
    const { themes, diagnostics } = resolve(source)
    fonts.heading.family.push('Times')
    fonts.ui.size = 16

    expect(diagnostics).toEqual([])
    expect(themes[1].fonts).toEqual({ heading: { family: ['Georgia', 'serif'], weight: 600 }, ui: { size: 14 }, numeric: { family: ['Cascadia Mono'] } })
    expect(resolve(sunrise()).themes[1]).not.toHaveProperty('fonts')
  })

  it.each<[string, unknown, string]>([
    ['fonts that are not an object', ['Georgia'], 'has fonts that are not an object'],
    ['a role that does not exist', { register: { size: 14 } }, 'has fonts for an unknown role "register"'],
    ['a facet the role does not have', { heading: { size: 20 } }, "Headings: its size can't be set."],
    ['a size the user could choose but a theme may not', { ui: { size: 20 } }, 'Interface text: choose a size from 12 to 16 px.'],
    ['a weight not offered', { ui: { weight: 450 } }, 'Interface text: choose Regular, Medium, Semibold or Bold.'],
    ['a family that is not a list', { ui: { family: 'Georgia' } }, 'Interface text: the font must be a list of font names.'],
    ['a family that would break out of CSS', { table: { family: ['Arial; } body { display: none'] } }, 'isn\'t a font name'],
    ['something that is not a facet', { ui: { colour: '#ff0000' } }, '"colour" isn\'t something a font has']
  ])('skips a theme with %s', (_name, fonts, message) => {
    const { themes, diagnostics } = resolve(sunrise({ fonts } as never))

    expect(themes).toEqual([DEFAULT_THEME])
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]).toContain('Theme "p.sunrise" has')
    expect(diagnostics[0]).toContain(message)
  })

  it.each<[string, unknown, string]>([
    ['not an object', 'nope', 'not an object'],
    ['no id', { label: 'x', dark: {} }, 'missing an id'],
    ['an id the plugin does not own', { id: 'other.x', label: 'x', dark: {} }, 'must have an id prefixed by "p."'],
    ['a bare prefix as id', { id: 'p.', label: 'x', dark: {} }, 'must have an id prefixed by "p."'],
    ['no label', { id: 'p.x', dark: {} }, 'missing a label'],
    ['no variant', { id: 'p.x', label: 'x' }, 'needs a light or a dark variant'],
    ['a variant that is not an object', { id: 'p.x', label: 'x', dark: 'black' }, 'dark variant is not an object'],
    ['an unknown token', { id: 'p.x', label: 'x', dark: { accent: '#fff' } }, 'unknown token "accent"'],
    ['an unknown nested token', { id: 'p.x', label: 'x', dark: { text: { hint: '#fff' } } }, 'unknown token "text.hint"'],
    ['a colour that is not valid', { id: 'p.x', label: 'x', dark: { primary: 'red' } }, 'invalid colour for "primary"'],
    ['a nested colour that is not valid', { id: 'p.x', label: 'x', light: { background: { paper: 5 } } }, 'invalid colour for "background.paper"'],
    ['an unknown field', { id: 'p.x', label: 'x', dark: {}, extends: 'p.y' }, 'unknown field "extends"'],
    ['a description that is not text', { id: 'p.x', label: 'x', dark: {}, description: 7 }, 'invalid description'],
    ['an empty description', { id: 'p.x', label: 'x', dark: {}, description: ' ' }, 'invalid description']
  ])('skips a theme with %s', (_name, impl, message) => {
    const { themes, diagnostics } = resolve(impl)

    expect(themes).toEqual([DEFAULT_THEME])
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]).toContain(message)
  })

  it("does not let a plugin replace the shell's theme", () => {
    const { themes, diagnostics } = resolveThemes([{ contributor: 'tessera', impl: { id: DEFAULT_THEME_ID, label: 'Mine', dark: {} } }])

    expect(themes).toEqual([DEFAULT_THEME])
    expect(diagnostics[0]).toContain('reserved')
  })

  it('keeps the first of two themes with the same id', () => {
    const { themes, diagnostics } = resolve(midnight(), midnight({ label: 'Second' }))

    expect(themes.filter(t => t.id === 'p.midnight')).toEqual([midnight()])
    expect(diagnostics).toEqual(['Duplicate theme id "p.midnight" ignored'])
  })

  it('judges each contribution on its own', () => {
    const { themes, diagnostics } = resolve({ id: 'p.bad' }, sunrise())

    expect(themes.map(t => t.id)).toEqual([DEFAULT_THEME_ID, 'p.sunrise'])
    expect(diagnostics).toHaveLength(1)
  })
})

describe('the shell theme', () => {
  it('has both variants, with hex backgrounds a window can be painted with', () => {
    expect(followsSystem(DEFAULT_THEME)).toBe(true)
    expect(DEFAULT_THEME.light!.background!.default).toMatch(/^#[0-9a-f]{6}$/i)
    expect(DEFAULT_THEME.dark!.background!.default).toMatch(/^#[0-9a-f]{6}$/i)
  })

  it('is valid by the same rules plugins are held to', () => {
    const asPlugin = { ...DEFAULT_THEME, id: 'p.copy' }
    expect(resolve(asPlugin).diagnostics).toEqual([])
  })
})

describe('parseStoredSelection', () => {
  it('reads nothing saved as nothing', () => {
    expect(parseStoredSelection(undefined)).toEqual({})
    expect(parseStoredSelection(null)).toEqual({})
  })

  it("migrates the old hook's 'light' and 'dark' to explicit modes of the shell theme", () => {
    expect(parseStoredSelection('light')).toEqual({ selection: { theme: DEFAULT_THEME_ID, mode: 'light' } })
    expect(parseStoredSelection('dark')).toEqual({ selection: { theme: DEFAULT_THEME_ID, mode: 'dark' } })
  })

  it('reads a selection object', () => {
    expect(parseStoredSelection({ theme: 'p.sunrise', mode: 'system' })).toEqual({ selection: { theme: 'p.sunrise', mode: 'system' } })
  })

  it.each(['purple', 5, true, [], {}, { theme: 'p.x' }, { theme: '', mode: 'dark' }, { theme: 'p.x', mode: 'sepia' }])(
    'warns about %j and uses nothing', raw => {
      const result = parseStoredSelection(raw)
      expect(result.selection).toBeUndefined()
      expect(result.warning).toContain('unreadable saved theme')
    })
})

describe('selections', () => {
  const themes: ThemeDescriptor[] = [DEFAULT_THEME, sunrise(), midnight()]

  it('knows which modes a theme has', () => {
    expect(modesOf(sunrise())).toEqual(['light', 'dark'])
    expect(modesOf(midnight())).toEqual(['dark'])
    expect(followsSystem(midnight())).toBe(false)
  })

  describe('selectionProblem', () => {
    it.each<[unknown]>([
      [DEFAULT_SELECTION], [{ theme: 'p.sunrise', mode: 'light' }], [{ theme: 'p.midnight', mode: 'dark' }]
    ])('accepts %j', selection => expect(selectionProblem(selection, themes)).toBeUndefined())

    it.each<[unknown, string]>([
      [null, 'must be an object'],
      [{ mode: 'dark' }, 'needs a theme id'],
      [{ theme: 'p.sunrise', mode: 'sepia' }, 'Unknown theme mode "sepia"'],
      [{ theme: 'p.gone', mode: 'dark' }, 'Unknown theme "p.gone"'],
      [{ theme: 'p.midnight', mode: 'system' }, 'single variant and cannot follow the system'],
      [{ theme: 'p.midnight', mode: 'light' }, 'has no light variant']
    ])('rejects %j', (selection, message) => expect(selectionProblem(selection, themes)).toContain(message))
  })

  describe('selectionFor', () => {
    it('keeps the wanted mode when the theme has it', () => {
      expect(selectionFor(sunrise(), 'dark')).toEqual({ theme: 'p.sunrise', mode: 'dark' })
      expect(selectionFor(sunrise(), 'system')).toEqual({ theme: 'p.sunrise', mode: 'system' })
    })

    it("uses the theme's own mode when it lacks the wanted one", () => {
      expect(selectionFor(midnight(), 'system')).toEqual({ theme: 'p.midnight', mode: 'dark' })
      expect(selectionFor(midnight(), 'light')).toEqual({ theme: 'p.midnight', mode: 'dark' })
    })
  })

  describe('resolveSelection', () => {
    it('lets system take the OS mode', () => {
      expect(resolveSelection(DEFAULT_SELECTION, themes, true)).toEqual({ theme: DEFAULT_THEME_ID, mode: 'dark', fellBack: false })
      expect(resolveSelection(DEFAULT_SELECTION, themes, false)).toEqual({ theme: DEFAULT_THEME_ID, mode: 'light', fellBack: false })
    })

    it('ignores the OS for an explicit mode', () => {
      expect(resolveSelection({ theme: 'p.sunrise', mode: 'light' }, themes, true).mode).toBe('light')
    })

    it('shows a single-variant theme in its variant whatever the OS says', () => {
      expect(resolveSelection({ theme: 'p.midnight', mode: 'system' }, themes, false).mode).toBe('dark')
      expect(resolveSelection({ theme: 'p.midnight', mode: 'light' }, themes, false).mode).toBe('dark')
    })

    it("falls back to the shell's theme for one that is not registered, and says so", () => {
      expect(resolveSelection({ theme: 'p.gone', mode: 'dark' }, themes, false)).toEqual({ theme: DEFAULT_THEME_ID, mode: 'dark', fellBack: true })
    })
  })
})
