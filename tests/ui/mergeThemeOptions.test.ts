import { describe, it, expect } from 'vitest'
import { mergeThemeOptions } from '../../tessera-ui'

describe('mergeThemeOptions', () => {
  it('merges plain objects key by key, later layers winning', () => {
    const merged = mergeThemeOptions<any>(
      { palette: { primary: { main: '#111', light: '#222' }, mode: 'light' }, spacing: 4 },
      { palette: { primary: { main: '#333' } } },
      undefined,
      { spacing: 8 })
    expect(merged).toEqual({ palette: { primary: { main: '#333', light: '#222' }, mode: 'light' }, spacing: 8 })
  })

  it('replaces arrays, scalars and functions rather than merging into them', () => {
    const fn = () => 1
    const merged = mergeThemeOptions<any>({ shadows: ['a', 'b'], f: fn, n: 1 }, { shadows: ['c'], n: { nested: true } })
    expect(merged.shadows).toEqual(['c'])
    expect(merged.f).toBe(fn)
    expect(merged.n).toEqual({ nested: true })
  })

  it('does not change its inputs', () => {
    const base = { palette: { primary: { main: '#111' } } }
    const over = { palette: { primary: { light: '#222' } } }
    mergeThemeOptions<any>(base, over)
    expect(base).toEqual({ palette: { primary: { main: '#111' } } })
    expect(over).toEqual({ palette: { primary: { light: '#222' } } })
  })

  it('never copies keys that could alter a prototype', () => {
    const hostile = JSON.parse('{"__proto__": {"polluted": true}, "constructor": {"x": 1}, "ok": 1}')
    const merged = mergeThemeOptions<any>({}, hostile)
    expect(merged).toEqual({ ok: 1 })
    expect(({} as any).polluted).toBeUndefined()
    expect(Object.prototype.hasOwnProperty.call(merged, 'constructor')).toBe(false)
  })

  it('leaves React elements (and other non-plain objects) as values', () => {
    const element = { $$typeof: Symbol.for('react.element'), type: 'span', props: {} }
    const merged = mergeThemeOptions<any>({ components: { MuiAlert: { defaultProps: { icon: { old: true } } } } },
      { components: { MuiAlert: { defaultProps: { icon: element } } } })
    expect(merged.components.MuiAlert.defaultProps.icon).toBe(element)
  })
})
