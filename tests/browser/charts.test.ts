// @vitest-environment node
// @tessera/ui/charts's Chart, drawn by MUI X Charts in headless Chromium: what jsdom can't show (it lays nothing out,
// so a chart library draws nothing in it). Each kind draws its series in the theme's chart palette, in light and dark,
// tones take the theme's success, error and text colours, a theme's own palette replaces the shell's colour by colour,
// and the text is in the theme's font roles. Skipped, saying why, where there's no Chromium (tests/browser/harness.ts).
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ChartProps } from '@tessera/ui/charts'
import type { ThemeDescriptor } from '@tessera/types'
import { browserProblem, bundle, launch, open, repo, screenshot, type Page } from './harness'
import { DEFAULT_THEME } from '../../shared/theme/types'

interface Drawn {
  ms: number, label: string | null, kind: string | null
  bars: number, barColors: string[], lines: number, lineColors: string[], areaColors: string[]
  slices: number, sliceColors: string[], ticks: string[], legendText: string[]
  tickFill?: string, tickFont?: string, legendFont?: string
  theme: { textSecondary: string, caption: string, chart: string[], success: string, error: string, text: string }
}

/** A colour as a browser's computed style says it: "#1565c0" as "rgb(21, 101, 192)"; "rgba(0,0,0,0.87)" spaced. */
function rgb(color: string): string {
  if (!color.startsWith('#')) return color.replace(/\s*,\s*/g, ', ')
  const h = color.slice(1)
  const full = h.length === 3 ? [...h].map(c => c + c).join('') : h
  const [r, g, b] = [0, 2, 4].map(i => parseInt(full.slice(i, i + 2), 16))
  return `rgb(${r}, ${g}, ${b})`
}

const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun']
/** Props as the page takes them: `format: 'money'` for the page's own formatter of cents. */
type Props = Omit<ChartProps, 'format'> & { format?: 'money' }

const three = (kind: ChartProps['kind']): Props => ({
  kind, categories: months, format: 'money', label: `Three series, ${kind} chart`,
  series: [
    { key: 'a', label: 'Groceries', values: [12000, 13000, 9000, 15000, 11000, 12500] },
    { key: 'b', label: 'Housing', values: [90000, 90000, 90000, 92000, 92000, 92000] },
    { key: 'c', label: 'Transport', values: [4000, null, 6000, 5500, 4800, 5100] }
  ]
})

describe.skipIf(browserProblem)('Chart in a browser', () => {
  let browser: Awaited<ReturnType<typeof launch>>
  let page: Page
  let problems: string[]

  beforeAll(async () => {
    browser = await launch()
    const url = await bundle(path.join(repo, 'tests/browser/pages/charts.tsx'))
    ;({ page, problems } = await open(browser, url))
  }, 60_000)

  afterAll(async () => { await browser?.close() })

  const draw = (props: Props, mode: 'light' | 'dark' = 'light', theme?: ThemeDescriptor) =>
    page.evaluate(([p, m, t]) => window.render(p as never, m as 'light' | 'dark', t as never), [props, mode, theme] as const) as Promise<Drawn>

  for (const mode of ['light', 'dark'] as const) {
    describe(`in ${mode}`, () => {
      it('draws grouped bars, one colour per series from the palette, in order', async () => {
        const drawn = await draw(three('groupedBar'), mode)
        expect(drawn.kind).toBe('groupedBar')
        // Six months of three series, less the one gap
        expect(drawn.bars).toBe(17)
        expect(drawn.barColors).toEqual(DEFAULT_THEME[mode]!.chart!.slice(0, 3).map(c => rgb(c as string)))
        expect(drawn.legendText).toEqual(['Groceries', 'Housing', 'Transport'])
        await screenshot(page, `chart-groupedBar-${mode}`)
      })

      it('draws stacked bars in the same colours', async () => {
        const drawn = await draw(three('stackedBar'), mode)
        expect(drawn.bars).toBe(17)
        expect(drawn.barColors).toEqual(drawn.theme.chart.slice(0, 3).map(rgb))
      })

      it('draws lines, one per series, straight from point to point', async () => {
        const drawn = await draw(three('line'), mode)
        expect(drawn.lines).toBe(3)
        expect(drawn.lineColors).toEqual(drawn.theme.chart.slice(0, 3).map(rgb))
        // Straight segments: no curve commands in the lines' paths
        const paths = await page.$$eval('.MuiLineChart-line', lines => lines.map(l => l.getAttribute('d') ?? ''))
        for (const d of paths) expect(d).not.toMatch(/[CQS]/)
        await screenshot(page, `chart-line-${mode}`)
      })

      it('draws stacked areas, filled in the palette', async () => {
        const drawn = await draw(three('area'), mode)
        expect(drawn.areaColors).toHaveLength(3)
        expect(drawn.lines).toBe(3)
      })

      it('draws a donut of the positive slices, in the palette', async () => {
        const drawn = await draw({
          kind: 'donut', categories: ['Housing', 'Groceries', 'Refunds', 'Transport'], label: 'Spending, donut chart', format: 'money',
          series: [{ key: 'total', label: 'Spending', values: [92000, 12000, -3000, 5000] }]
        }, mode)
        // Refunds, less than nothing, has no share
        expect(drawn.slices).toBe(3)
        const palette = drawn.theme.chart.map(rgb)
        expect(drawn.sliceColors).toEqual([palette[0], palette[1], palette[3]])
        await screenshot(page, `chart-donut-${mode}`)
      })

      it('draws tones in the theme’s success, error and text colours, and a line over bars', async () => {
        const drawn = await draw({
          kind: 'groupedBar', categories: months.slice(0, 3), format: 'money', label: 'Income and expenses',
          series: [
            { key: 'income', label: 'Income', values: [500000, 510000, 505000], tone: 'positive' },
            { key: 'expense', label: 'Expenses', values: [420000, 530000, 400000], tone: 'negative' },
            { key: 'net', label: 'Net', values: [80000, -20000, 105000], as: 'line', tone: 'emphasis' }
          ]
        }, mode)
        expect(drawn.bars).toBe(6)
        expect(drawn.barColors).toEqual([rgb(drawn.theme.success), rgb(drawn.theme.error)])
        expect(drawn.lines).toBe(1)
        expect(drawn.lineColors).toEqual([rgb(drawn.theme.text)])
        await screenshot(page, `chart-tones-${mode}`)
      })

      it('writes the axes in the theme’s Small text role and secondary text colour', async () => {
        const drawn = await draw(three('groupedBar'), mode)
        expect(drawn.tickFill).toBe(rgb(drawn.theme.textSecondary))
        expect(drawn.tickFont).toBe(drawn.theme.caption)
        expect(drawn.legendFont).toBe(drawn.theme.caption)
        // The category axis's labels, and the value axis's in the caller's format
        expect(drawn.ticks).toEqual(expect.arrayContaining(months))
        expect(drawn.ticks.some(t => /^\$\d/.test(t))).toBe(true)
      })
    })
  }

  it('draws horizontal bars with their labels down the side, the axis as wide as the longest', async () => {
    const drawn = await draw({
      kind: 'bar', horizontal: true, categories: ['Supermarket', 'The Corner Bakery and Café', 'Fuel'], format: 'money', label: 'By payee, bar chart',
      series: [{ key: 'total', label: 'Spending', values: [52000, 8000, 12000] }]
    })
    expect(drawn.bars).toBe(3)
    expect(drawn.ticks).toEqual(expect.arrayContaining(['The Corner Bakery and Café']))
    // The longest label isn't clipped by the plot: it starts inside the figure
    const left = await page.$$eval('.MuiChartsAxis-tickLabel', (labels, figure) => {
      const box = document.querySelector(figure)!.getBoundingClientRect()
      return Math.min(...labels.map(l => l.getBoundingClientRect().left)) - box.left
    }, '[role="figure"]')
    expect(left).toBeGreaterThanOrEqual(0)
  })

  it('takes a theme’s own palette colour by colour, and the shell’s for the rest', async () => {
    const own = ['#112233', '#445566', '#778899']
    const theme: ThemeDescriptor = { ...DEFAULT_THEME, light: { ...DEFAULT_THEME.light!, chart: own } }
    const drawn = await draw({
      ...three('groupedBar'),
      series: [...three('groupedBar').series, { key: 'd', label: 'Fourth', values: [1, 2, 3, 4, 5, 6] }]
    }, 'light', theme)
    expect(drawn.barColors).toEqual([...own, DEFAULT_THEME.light!.chart![3] as string].map(rgb))
  })

  it('labels the figure for screen readers, with no legend for a single series', async () => {
    const drawn = await draw({ kind: 'bar', categories: months, label: 'Net worth, bar chart: June $1,200.00', series: [{ key: 'n', label: 'Net worth', values: [1, 2, 3, 4, 5, 6] }] })
    expect(drawn.label).toBe('Net worth, bar chart: June $1,200.00')
    expect(drawn.legendText).toEqual([])
  })

  it('draws every kind without an error or a console error', () => {
    expect(problems).toEqual([])
  })
})
