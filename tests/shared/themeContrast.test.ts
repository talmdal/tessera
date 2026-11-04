import { describe, expect, it } from 'vitest'
import type { ThemeDescriptor } from '@tessera/types'
import { MIN_TEXT_CONTRAST, MIN_UI_CONTRAST, contrastFindings, contrastRatio, parseColor } from '../../shared/theme/contrast'
import { tokensFor } from '../../shared/theme/tokens'
import { DEFAULT_THEME } from '../../shared/theme/types'
import { midnight, sunrise } from '../helpers/theme'

describe('parseColor', () => {
  it.each<[string, object]>([
    ['#fff', { r: 255, g: 255, b: 255, a: 1 }],
    ['#f00f', { r: 255, g: 0, b: 0, a: 1 }],
    ['#1976d2', { r: 25, g: 118, b: 210, a: 1 }],
    ['#1976d280', { r: 25, g: 118, b: 210, a: 128 / 255 }],
    ['rgb(10, 20, 30)', { r: 10, g: 20, b: 30, a: 1 }],
    ['rgba(0, 0, 0, 0.87)', { r: 0, g: 0, b: 0, a: 0.87 }],
    ['rgb(10 20 30 / 50%)', { r: 10, g: 20, b: 30, a: 0.5 }],
    ['rgb(100%, 0%, 0%)', { r: 255, g: 0, b: 0, a: 1 }],
    ['hsl(0, 100%, 50%)', { r: 255, g: 0, b: 0, a: 1 }],
    ['hsl(120 100% 25%)', { r: 0, g: 127.5, b: 0, a: 1 }],
    ['hsla(240, 100%, 50%, 0.5)', { r: 0, g: 0, b: 255, a: 0.5 }],
    ['  #ABC  ', { r: 170, g: 187, b: 204, a: 1 }]
  ])('reads %s', (text, expected) => {
    const color = parseColor(text)!
    for (const [channel, value] of Object.entries(expected)) expect(color[channel as 'r'], channel).toBeCloseTo(value as number, 5)
  })

  it.each(['red', '', '#12', '#12345', '#gggggg', 'rgb(1, 2)', 'rgb(1, 2, 3, 4, 5)', 'rgb(a, b, c)', 'var(--x)', 'hsl(', 'transparent'])(
    'cannot read %j', text => expect(parseColor(text)).toBeUndefined())

  it('clamps out-of-range values rather than producing nonsense', () => {
    expect(parseColor('rgb(300, -5, 0)')).toMatchObject({ r: 255, g: 0, b: 0 })
    expect(parseColor('rgba(0,0,0,2)')!.a).toBe(1)
  })
})

describe('contrastRatio', () => {
  it('is 21 for black on white and 1 for a colour on itself', () => {
    expect(contrastRatio('#000', '#fff')).toBeCloseTo(21, 5)
    expect(contrastRatio('#fff', '#000')).toBeCloseTo(21, 5)
    expect(contrastRatio('#777', '#777')).toBeCloseTo(1, 5)
  })

  it('matches the published WCAG figures', () => {
    // #767676 on white is the well-known lightest grey that passes AA for text
    expect(contrastRatio('#767676', '#ffffff')).toBeCloseTo(4.54, 2)
    expect(contrastRatio('#777777', '#ffffff')).toBeCloseTo(4.48, 2)
  })

  it('blends a translucent foreground over the background, as it is drawn', () => {
    // 87% black on white is a dark grey (#212121), not black
    expect(contrastRatio('rgba(0, 0, 0, 0.87)', '#ffffff')).toBeCloseTo(contrastRatio('#212121', '#ffffff')!, 1)
    expect(contrastRatio('rgba(0, 0, 0, 0.87)', '#ffffff')!).toBeLessThan(21)
  })

  it('is unaffected by which way round the colours are', () => {
    expect(contrastRatio('#1976d2', '#fff')).toBeCloseTo(contrastRatio('#fff', '#1976d2')!, 10)
  })

  it('is undefined when a colour cannot be read', () => {
    expect(contrastRatio('red', '#fff')).toBeUndefined()
    expect(contrastRatio('#fff', 'nope')).toBeUndefined()
  })
})

describe('contrastFindings', () => {
  it("finds nothing wrong with the shell's own theme in either mode (a review of its colours)", () => {
    expect(contrastFindings(DEFAULT_THEME)).toEqual([])
  })

  it("records the shell theme's actual figures, so a change to its colours shows up here", () => {
    const ratio = (mode: 'light' | 'dark', fg: (t: ReturnType<typeof tokensFor>) => string, bg: (t: ReturnType<typeof tokensFor>) => string) => {
      const t = tokensFor(DEFAULT_THEME, mode)
      return contrastRatio(fg(t), bg(t))!
    }

    expect(ratio('light', t => t.text.primary, t => t.background.paper)).toBeGreaterThan(15)
    expect(ratio('dark', t => t.text.primary, t => t.background.paper)).toBeGreaterThan(12)
    expect(ratio('light', t => t.text.secondary, t => t.background.default)).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST)
    expect(ratio('dark', t => t.text.secondary, t => t.background.paper)).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST)
    expect(ratio('light', t => t.primary, t => t.background.paper)).toBeGreaterThanOrEqual(MIN_UI_CONTRAST)
    expect(ratio('dark', t => t.primary, t => t.background.paper)).toBeGreaterThanOrEqual(MIN_UI_CONTRAST)
  })

  it('finds nothing wrong with the bundled sample themes', () => {
    expect(contrastFindings(sunrise({ light: { primary: '#c2410c', background: { default: '#fff7ed', paper: '#ffffff' } }, dark: { primary: '#fb923c', background: { default: '#1c1410', paper: '#271c15' } } }))).toEqual([])
    expect(contrastFindings(midnight())).toEqual([])
  })

  it('reports a theme whose text is hard to read, naming the pair, the mode and the ratio', () => {
    const grey: ThemeDescriptor = { id: 'p.grey', label: 'Grey', light: { background: { default: '#cccccc', paper: '#cccccc' }, text: { primary: '#bbbbbb', secondary: '#bbbbbb' } } }

    const findings = contrastFindings(grey)

    // The shell's blue primary, which this theme leaves alone, is also too faint on that grey paper
    expect(findings.map(f => f.pair)).toEqual([
      'text.primary on background.default', 'text.primary on background.paper',
      'text.secondary on background.default', 'text.secondary on background.paper',
      'primary on background.paper'
    ])
    expect(findings.every(f => f.mode === 'light' && f.ratio < f.minimum)).toBe(true)
    expect(findings.filter(f => f.minimum === MIN_TEXT_CONTRAST)).toHaveLength(4)
  })

  it('reports a primary colour that cannot be seen against the paper, against the lower bar for interface parts', () => {
    const faint: ThemeDescriptor = { id: 'p.faint', label: 'Faint', light: { primary: '#f0f0f0' } }

    const findings = contrastFindings(faint)

    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ mode: 'light', pair: 'primary on background.paper', minimum: MIN_UI_CONTRAST })
  })

  it('judges only the modes a theme has, measuring what it shows: its tokens over the shell\'s', () => {
    // Only a dark variant that sets nothing: all the shell's dark colours, which pass
    expect(contrastFindings({ id: 'p.d', label: 'D', dark: {} })).toEqual([])
    // A light-on-light theme with only the text changed is judged against the shell's light background
    const findings = contrastFindings({ id: 'p.l', label: 'L', light: { text: { primary: '#fafafa' } } })
    expect(findings.map(f => f.pair)).toEqual(['text.primary on background.default', 'text.primary on background.paper'])
  })

  it('skips a colour it cannot read rather than guessing (validation rejects those elsewhere)', () => {
    expect(contrastFindings({ id: 'p.x', label: 'X', light: { text: { primary: 'plum' } } })).toEqual([])
  })
})
