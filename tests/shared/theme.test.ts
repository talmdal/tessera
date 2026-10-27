import type { ColorDefinition, ThemeDefinition } from '@tessera/types'
import { describe, it, expect } from 'vitest'
import { builtinThemeState, shellColorCatalogue, shellThemeDefinitions } from '../../shared/theme/builtin'
import { resolveColorMap } from '../../shared/theme/resolveColorMap'
import { resolveColors } from '../../shared/theme/resolveColors'
import { resolveThemes } from '../../shared/theme/resolveThemes'
import { SHELL_THEMES } from '../../shared/theme/themes'
import { SHELL_COLOR_TOKENS } from '../../shared/theme/tokens'
import { cssVariableFor, isColorValue, isHexColor, isTokenId } from '../../shared/theme/types'

const color = (id: string, defaults: unknown = '#123456', contributor = 'alpha', extra: Record<string, unknown> = {}) =>
  ({ contributor, impl: { id, description: `About ${id}`, defaults, ...extra } })

const theme = (id: string, extra: Record<string, unknown> = {}, contributor = 'alpha') =>
  ({ contributor, impl: { id, label: id, kind: 'light', ...extra } })

const shellThemes = SHELL_THEMES.map(impl => ({ contributor: 'shell', impl }))

describe('theme values', () => {
  it('maps token ids to CSS variables, keeping camelCase', () => {
    expect(cssVariableFor('shell.bar.hoverBackground')).toBe('--shell-bar-hoverBackground')
    expect(cssVariableFor('layout-sample.highlight')).toBe('--layout-sample-highlight')
  })

  it('recognises hex colours and token ids, and nothing else', () => {
    expect(['#abc', '#ABCD', '#a1b2c3', '#a1b2c3d4'].every(isHexColor)).toBe(true)
    expect(['abc', '#ab', '#abcde', '#ggg', 'rgb(1,2,3)', 'red'].some(isHexColor)).toBe(false)
    expect(['shell.accent', 'money-classic.sepia', 'a.b.c9'].every(isTokenId)).toBe(true)
    expect(['shell', 'Shell.accent', 'shell..x', 'shell.', '.x', 'shell.-x'].some(isTokenId)).toBe(false)
    expect(isColorValue('#fff') && isColorValue('shell.accent') && !isColorValue('blue')).toBe(true)
  })
})

describe('resolveColors', () => {
  it('accepts a single default for both kinds or one per kind, and records the contributor', () => {
    const { colors, diagnostics } = resolveColors([
      color('alpha.one', '#fff'),
      color('alpha.two', { light: '#000', dark: 'shell.accent' })
    ])

    expect(diagnostics).toEqual([])
    expect(colors).toEqual([
      { id: 'alpha.one', description: 'About alpha.one', defaults: { light: '#fff', dark: '#fff' }, pluginId: 'alpha' },
      { id: 'alpha.two', description: 'About alpha.two', defaults: { light: '#000', dark: 'shell.accent' }, pluginId: 'alpha' }
    ])
  })

  it('skips invalid contributions with a reason, keeping the valid ones', () => {
    const { colors, diagnostics } = resolveColors([
      { contributor: 'alpha', impl: null },
      color('Alpha.bad'),
      color('beta.notMine'),
      { contributor: 'alpha', impl: { id: 'alpha.noDescription', defaults: '#fff' } },
      color('alpha.badDefault', 'blue'),
      color('alpha.badDark', { light: '#fff', dark: 'nope' }),
      color('alpha.self', 'alpha.self'),
      color('alpha.ok'),
      color('alpha.ok'),
      color('alpha-ok.x', '#123456', 'alpha-ok'),
      color('alpha.ok.x')                          // same CSS variable as alpha-ok.x
    ])

    expect(colors.map(c => c.id)).toEqual(['alpha.ok', 'alpha-ok.x'])
    expect(diagnostics).toEqual([
      'Colour token contribution is not an object',
      'Colour token id "Alpha.bad" is invalid: use "<pluginId>.<name>"',
      'Colour token "beta.notMine" ignored: "alpha" may only contribute tokens starting with "alpha."',
      'Colour token "alpha.noDescription" is missing a description',
      'Colour token "alpha.badDefault" has an invalid default "blue": use a hex colour or a token id',
      'Colour token "alpha.badDark" has an invalid default "nope": use a hex colour or a token id',
      'Colour token "alpha.self" cannot default to itself',
      'Duplicate colour token "alpha.ok" ignored',
      'Colour token "alpha.ok.x" ignored: it maps to the same CSS variable as "alpha-ok.x"'
    ])
  })

  it('lets the shell own the shell. prefix', () => {
    expect(resolveColors([color('shell.x', '#fff', 'shell')]).diagnostics).toEqual([])
    expect(resolveColors([color('shell.x', '#fff', 'alpha')]).diagnostics).toHaveLength(1)
  })
})

describe('resolveThemes', () => {
  it('settles extends to the declared parent, else the shell theme of the kind, and orders by order then registration', () => {
    const { themes, diagnostics } = resolveThemes([
      ...shellThemes,
      theme('alpha.b'),
      theme('alpha.a', { order: -5 }),
      theme('alpha.night', { kind: 'dark', extends: 'shell.dark', colors: { 'shell.accent': '#f00' } }),
      theme('alpha.child', { extends: 'alpha.b' })
    ])

    expect(diagnostics).toEqual([])
    expect(themes.map(t => [t.id, t.extends])).toEqual([
      ['alpha.a', 'shell.light'],
      ['shell.light', undefined],
      ['shell.dark', undefined],
      ['alpha.b', 'shell.light'],
      ['alpha.night', 'shell.dark'],
      ['alpha.child', 'alpha.b']
    ])
    expect(themes.find(t => t.id === 'alpha.night')).toMatchObject({ colors: { 'shell.accent': '#f00' }, pluginId: 'alpha', kind: 'dark' })
  })

  it('skips invalid themes with a reason', () => {
    const { themes, diagnostics } = resolveThemes([
      { contributor: 'alpha', impl: 'nope' },
      theme('bad id'),
      theme('beta.notMine'),
      theme('alpha.noLabel', { label: '' }),
      theme('alpha.badKind', { kind: 'sepia' }),
      theme('alpha.badExtends', { extends: 'x' }),
      theme('alpha.badOrder', { order: 'first' }),
      theme('alpha.badColors', { colors: [] }),
      theme('alpha.badKey', { colors: { 'not valid': '#fff' } }),
      theme('alpha.badValue', { colors: { 'shell.accent': 'red' } }),
      theme('alpha.ok'),
      theme('alpha.ok')
    ])

    expect(themes.map(t => t.id)).toEqual(['alpha.ok'])
    expect(diagnostics).toEqual([
      'Theme contribution is not an object',
      'Theme id "bad id" is invalid: use "<pluginId>.<name>"',
      'Theme "beta.notMine" ignored: "alpha" may only contribute themes starting with "alpha."',
      'Theme "alpha.noLabel" is missing a label',
      'Theme "alpha.badKind" has an invalid kind "sepia": use "light" or "dark"',
      'Theme "alpha.badExtends" has an invalid extends "x"',
      'Theme "alpha.badOrder" has an invalid order',
      'Theme "alpha.badColors" has an invalid colors map',
      'Theme "alpha.badKey" colours an invalid token id "not valid"',
      'Theme "alpha.badValue" has an invalid colour "red" for "shell.accent": use a hex colour or a token id',
      'Duplicate theme "alpha.ok" ignored'
    ])
  })

  it('falls back to the shell theme for an unknown parent, and skips a parent of the other kind or a cycle', () => {
    const { themes, diagnostics } = resolveThemes([
      ...shellThemes,
      theme('alpha.orphan', { extends: 'alpha.missing' }),
      theme('alpha.mixed', { kind: 'dark', extends: 'shell.light' }),
      theme('alpha.x', { extends: 'alpha.y' }),
      theme('alpha.y', { extends: 'alpha.x' })
    ])

    expect(themes.map(t => t.id)).toEqual(['shell.light', 'shell.dark', 'alpha.orphan'])
    expect(themes.find(t => t.id === 'alpha.orphan')?.extends).toBe('shell.light')
    expect(diagnostics).toEqual([
      'Theme "alpha.orphan" extends unknown theme "alpha.missing"; using "shell.light"',
      'Theme "alpha.mixed" (dark) cannot extend "shell.light" (light)',
      'Theme "alpha.x" is part of an extends cycle',
      'Theme "alpha.y" is part of an extends cycle'
    ])
  })
})

describe('resolveColorMap', () => {
  const catalogue: ColorDefinition[] = [
    { id: 'shell.accent', description: '', defaults: { light: '#0063b1', dark: '#3794ff' }, pluginId: 'shell' },
    { id: 'shell.link', description: '', defaults: { light: 'shell.accent', dark: 'shell.accent' }, pluginId: 'shell' },
    { id: 'shell.background', description: '', defaults: { light: '#ffffff', dark: '#1e1e1e' }, pluginId: 'shell' },
    { id: 'acc.positive', description: '', defaults: { light: '#107c10', dark: '#89d185' }, pluginId: 'acc' },
    { id: 'acc.reconciled', description: '', defaults: { light: 'shell.link', dark: 'shell.link' }, pluginId: 'acc' }
  ]
  const light: ThemeDefinition = { id: 'shell.light', label: 'L', kind: 'light', colors: {}, pluginId: 'shell' }
  const dark: ThemeDefinition = { id: 'shell.dark', label: 'D', kind: 'dark', colors: {}, pluginId: 'shell' }
  const sepia: ThemeDefinition = {
    id: 'm.sepia', label: 'S', kind: 'light', extends: 'shell.light', pluginId: 'm',
    colors: { 'shell.accent': '#7a5c1e', 'shell.background': '#fbf6ea', 'other.unknown': '#000' }
  }
  const child: ThemeDefinition = { id: 'm.child', label: 'C', kind: 'light', extends: 'm.sepia', pluginId: 'm', colors: { 'shell.background': '#eee' } }
  const themes = [light, dark, sepia, child]

  it('uses the defaults of the theme kind and follows references', () => {
    expect(resolveColorMap(catalogue, themes, light)).toEqual({
      colors: { 'shell.accent': '#0063b1', 'shell.link': '#0063b1', 'shell.background': '#ffffff', 'acc.positive': '#107c10', 'acc.reconciled': '#0063b1' },
      diagnostics: []
    })
    expect(resolveColorMap(catalogue, themes, dark).colors).toMatchObject({ 'shell.accent': '#3794ff', 'acc.reconciled': '#3794ff', 'acc.positive': '#89d185' })
  })

  it('walks the extends chain, nearest theme first, and references see the theme values', () => {
    const { colors, diagnostics } = resolveColorMap(catalogue, themes, child)

    expect(diagnostics).toEqual([])
    expect(colors).toEqual({
      'shell.background': '#eee',      // the child
      'shell.accent': '#7a5c1e',       // the parent
      'shell.link': '#7a5c1e',         // a default that references the parent's value
      'acc.positive': '#107c10',       // the catalogue's light default
      'acc.reconciled': '#7a5c1e'
    })
    expect(colors).not.toHaveProperty('other.unknown')
  })

  it('layers customisations: per theme over global over the theme chain', () => {
    const customizations = {
      global: { 'shell.accent': '#111111', 'shell.background': '#222222' },
      byTheme: { 'm.sepia': { 'shell.accent': '#333333' }, 'shell.light': { 'shell.accent': '#444444' } }
    }

    expect(resolveColorMap(catalogue, themes, sepia, customizations).colors).toMatchObject({
      'shell.accent': '#333333', 'shell.link': '#333333', 'shell.background': '#222222'
    })
    expect(resolveColorMap(catalogue, themes, dark, customizations).colors).toMatchObject({
      'shell.accent': '#111111', 'shell.background': '#222222', 'acc.positive': '#89d185'
    })
  })

  it('ignores malformed customisation values rather than applying them', () => {
    const { colors } = resolveColorMap(catalogue, themes, light, { global: { 'shell.accent': 'red' as string } })
    expect(colors['shell.accent']).toBe('#0063b1')
  })

  it('leaves a token unresolved, with a diagnostic, for an unknown reference or a cycle', () => {
    const broken: ColorDefinition[] = [
      ...catalogue,
      { id: 'x.dangling', description: '', defaults: { light: 'x.missing', dark: 'x.missing' }, pluginId: 'x' },
      { id: 'x.a', description: '', defaults: { light: 'x.b', dark: 'x.b' }, pluginId: 'x' },
      { id: 'x.b', description: '', defaults: { light: 'x.a', dark: 'x.a' }, pluginId: 'x' }
    ]
    const { colors, diagnostics } = resolveColorMap(broken, themes, light)

    expect(Object.keys(colors).sort()).toEqual(['acc.positive', 'acc.reconciled', 'shell.accent', 'shell.background', 'shell.link'])
    expect(diagnostics).toEqual([
      'Colour token "x.dangling" references unknown token "x.missing"',
      'Colour token "x.a" is part of a reference cycle (x.a → x.b → x.a)'
    ])
  })
})

describe("the shell's catalogue and themes", () => {
  it('validate without diagnostics', () => {
    expect(resolveColors(SHELL_COLOR_TOKENS.map(impl => ({ contributor: 'shell', impl }))).diagnostics).toEqual([])
    expect(resolveThemes(shellThemes).diagnostics).toEqual([])
    expect(shellThemeDefinitions().map(t => [t.id, t.kind, t.extends])).toEqual([['shell.light', 'light', undefined], ['shell.dark', 'dark', undefined]])
  })

  it('resolve every token to a hex colour in both kinds', () => {
    for (const kind of ['light', 'dark'] as const) {
      const state = builtinThemeState(kind)
      expect(state.kind).toBe(kind)
      expect(state.activeTheme).toBe(`shell.${kind}`)
      expect(Object.keys(state.colors)).toEqual(shellColorCatalogue().map(t => t.id))
      expect(Object.values(state.colors).every(isHexColor)).toBe(true)
      expect(state.themes.map(t => t.id)).toEqual(['shell.light', 'shell.dark'])
    }
    // The light defaults are the literals windowManager.css used to carry
    expect(builtinThemeState('light').colors).toMatchObject({
      'shell.bar.background': '#f3f3f3', 'shell.bar.border': '#d0d0d0', 'shell.bar.hoverBackground': '#e0e0e0',
      'shell.tab.activeBorder': '#0063b1', 'shell.bar.activeIndicator': '#0063b1', 'shell.accent': '#0063b1'
    })
  })
})
