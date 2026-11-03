import { describe, it, expect } from 'vitest'
import { resolveThemes, validateTheme } from '../../shared/themes/resolveThemes'
import { MAX_THEME_BYTES, SHELL_THEME } from '../../shared/themes/types'

const theme = (extra: Record<string, unknown> = {}) => ({ id: 'p.main', label: 'Main', dark: { palette: { mode: 'dark' } }, ...extra })

describe('resolveThemes', () => {
  it('accepts a theme with one or both schemes, records which, and tags it with its plugin', () => {
    const { themes, diagnostics } = resolveThemes([
      { contributor: 'p', impl: theme() },
      { contributor: 'q', impl: { id: 'q.both', label: 'Both', light: {}, dark: {}, common: { shape: { borderRadius: 2 } } } }
    ])
    expect(diagnostics).toEqual([])
    expect(themes.map(t => [t.id, t.pluginId, t.schemes])).toEqual([['p.main', 'p', ['dark']], ['q.both', 'q', ['light', 'dark']]])
  })

  it('orders by `order`, then registration, and the shell\'s theme sorts first', () => {
    const { themes } = resolveThemes([
      { contributor: 'p', impl: theme({ id: 'p.b', order: 5 }) },
      { contributor: 'p', impl: theme({ id: 'p.a', order: 5 }) },
      { contributor: 'p', impl: theme({ id: 'p.c' }) },
      { contributor: 'shell', impl: SHELL_THEME }
    ])
    expect(themes.map(t => t.id)).toEqual(['shell.default', 'p.c', 'p.b', 'p.a'])
  })

  it('ignores a duplicate id with a diagnostic', () => {
    const { themes, diagnostics } = resolveThemes([{ contributor: 'p', impl: theme() }, { contributor: 'q', impl: theme() }])
    expect(themes).toHaveLength(1)
    expect(diagnostics).toEqual(['Duplicate theme id "p.main" ignored'])
  })

  it.each([
    [null, /not an object/],
    [{ label: 'x', dark: {} }, /missing an id/],
    [{ id: 'p.x', dark: {} }, /missing a label/],
    [{ id: 'p.x', label: 'x' }, /neither a light nor a dark scheme/],
    [{ id: 'p.x', label: 'x', dark: 'black' }, /dark is not an object/],
    [{ id: 'p.x', label: 'x', dark: {}, common: [] }, /common is not an object/],
    [{ id: 'p.x', label: 'x', dark: {}, order: 'first' }, /invalid order/],
    [{ id: 'p.x', label: 'x', dark: {}, swatch: { dark: ['#000', 3] } }, /invalid dark swatch/],
    [{ id: 'p.x', label: 'x', dark: { components: { MuiButton: { styleOverrides: { root: () => ({}) } } } } }, /is a function/],
    [{ id: 'p.x', label: 'x', dark: { palette: new Map() } }, /not a plain object/],
    [{ id: 'p.x', label: 'x', dark: JSON.parse('{"__proto__": {"polluted": true}}') }, /forbidden key "__proto__"/],
    [{ id: 'p.x', label: 'x', dark: { shadows: ['a', { constructor: {} }] } }, /shadows\[1\] has a forbidden key/]
  ])('rejects %j', (impl, problem) => {
    expect(validateTheme(impl)).toMatch(problem)
    const { themes, diagnostics } = resolveThemes([{ contributor: 'p', impl }])
    expect(themes).toEqual([])
    expect(diagnostics).toHaveLength(1)
  })

  it('rejects a theme larger than the limit', () => {
    const big = theme({ common: { typography: { fontFamily: 'x'.repeat(MAX_THEME_BYTES) } } })
    expect(validateTheme(big)).toMatch(/too large/)
  })

  it('accepts the shell\'s own theme', () => {
    expect(validateTheme(SHELL_THEME)).toBeUndefined()
  })
})
