// shared/theme/contrast.ts — WCAG contrast of a theme's colours, so a theme that is hard to read can be flagged.
import type { ThemeDescriptor, ThemeMode } from '@tessera/types'
import { tokensFor } from './tokens'

interface Rgba { r: number, g: number, b: number, a: number }

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n))

/** A number or a percentage of `scale`: `50%` of 255 is 127.5. */
const component = (value: string, scale: number) => value.endsWith('%') ? parseFloat(value) / 100 * scale : parseFloat(value)

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const f = (n: number) => {
    const k = (n + h / 30) % 12
    return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1))
  }
  return [f(0) * 255, f(8) * 255, f(4) * 255]
}

/** Reads a CSS colour in hex, `rgb()`/`rgba()` or `hsl()`/`hsla()` notation (as theme tokens allow). Undefined if it is none of them. */
export function parseColor(input: string): Rgba | undefined {
  const text = input.trim().toLowerCase()

  const hex = /^#([0-9a-f]{3,8})$/.exec(text)?.[1]
  if (hex) {
    const full = hex.length <= 4 ? [...hex].map(c => c + c).join('') : hex
    if (full.length !== 6 && full.length !== 8) return undefined
    const byte = (i: number) => parseInt(full.slice(i, i + 2), 16)
    return { r: byte(0), g: byte(2), b: byte(4), a: full.length === 8 ? byte(6) / 255 : 1 }
  }

  const fn = /^(rgba?|hsla?)\(([^)]*)\)$/.exec(text)
  if (!fn) return undefined
  const parts = fn[2].split(/[\s,/]+/).filter(Boolean)
  if (parts.length < 3 || parts.length > 4) return undefined

  const alpha = parts[3] === undefined ? 1 : clamp(component(parts[3], 1), 0, 1)
  if ([...parts.slice(0, 3), String(alpha)].some(p => Number.isNaN(parseFloat(p)))) return undefined

  if (fn[1].startsWith('rgb')) {
    const [r, g, b] = parts.slice(0, 3).map(p => clamp(component(p, 255), 0, 255))
    return { r, g, b, a: alpha }
  }
  const [r, g, b] = hslToRgb(((parseFloat(parts[0]) % 360) + 360) % 360, clamp(component(parts[1], 1), 0, 1), clamp(component(parts[2], 1), 0, 1))
  return { r, g, b, a: alpha }
}

/** `fg` laid over an opaque `bg`. */
function over(fg: Rgba, bg: Rgba): Rgba {
  return {
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1
  }
}

function luminance({ r, g, b }: Rgba) {
  const channel = (v: number) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

/**
 * The WCAG contrast ratio, 1 to 21, of `foreground` on `background`. A
 * translucent foreground is blended over the background first, as it is drawn
 * (the shell's text colours are translucent); the background is taken as opaque.
 * Undefined if either colour can't be read.
 */
export function contrastRatio(foreground: string, background: string): number | undefined {
  const fg = parseColor(foreground)
  const bg = parseColor(background)
  if (!fg || !bg) return undefined

  const solidBackground = { ...bg, a: 1 }
  const a = luminance(over(fg, solidBackground))
  const b = luminance(solidBackground)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

/** WCAG AA: 4.5 for text, 3 for the parts of the interface that aren't text. */
export const MIN_TEXT_CONTRAST = 4.5
export const MIN_UI_CONTRAST = 3

export interface ContrastFinding {
  mode: ThemeMode
  /** What was measured, such as `text.primary on background.paper`. */
  pair: string
  ratio: number
  minimum: number
}

/**
 * The colour pairs in a theme that fall below WCAG AA, in each mode it has:
 * text on both backgrounds, and the primary colour (which draws links, tabs and
 * buttons) on the paper. Empty means they all pass. A theme only sets some
 * tokens; the rest are the shell's, so what is measured is what is shown.
 */
export function contrastFindings(theme: ThemeDescriptor): ContrastFinding[] {
  const findings: ContrastFinding[] = []

  for (const mode of ['light', 'dark'] as const) {
    if (!theme[mode]) continue
    const t = tokensFor(theme, mode)
    const checks: [string, string, string, number][] = [
      ['text.primary on background.default', t.text.primary, t.background.default, MIN_TEXT_CONTRAST],
      ['text.primary on background.paper', t.text.primary, t.background.paper, MIN_TEXT_CONTRAST],
      ['text.secondary on background.default', t.text.secondary, t.background.default, MIN_TEXT_CONTRAST],
      ['text.secondary on background.paper', t.text.secondary, t.background.paper, MIN_TEXT_CONTRAST],
      ['primary on background.paper', t.primary, t.background.paper, MIN_UI_CONTRAST]
    ]
    for (const [pair, fg, bg, minimum] of checks) {
      const ratio = contrastRatio(fg, bg)
      if (ratio !== undefined && ratio < minimum) findings.push({ mode, pair, ratio, minimum })
    }
  }

  return findings
}
