// @vitest-environment node
// The report view in headless Chromium (phase R3): what jsdom can't show. Income vs Expenses drawn with its chart and
// table in light and dark, in the theme's colours and font roles; a long report painted 500 rows at a time without
// holding the window; a wide one scrolling sideways rather than cutting a figure short; and a view hidden as the shell
// hides it (kept mounted, not displayed) running again only when shown, with a real IntersectionObserver. Skipped,
// saying why, where there's no Chromium (tests/browser/harness.ts).
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { REPORTS_EVENTS } from '@tessera/reports-api'
import { browserProblem, bundle, launch, open, repo, screenshot, type Page } from './harness'

/** A colour as computed styles give it. */
function rgb(color: string): string {
  if (!color.startsWith('#')) return color.replace(/\s*,\s*/g, ', ')
  const h = color.slice(1)
  const full = h.length === 3 ? [...h].map(c => c + c).join('') : h
  return `rgb(${[0, 2, 4].map(i => parseInt(full.slice(i, i + 2), 16)).join(', ')})`
}

describe.skipIf(browserProblem)('the report view in a browser', () => {
  let browser: Awaited<ReturnType<typeof launch>>
  let page: Page
  let problems: string[]

  beforeAll(async () => {
    browser = await launch()
    const url = await bundle(path.join(repo, 'tests/browser/pages/reportView.tsx'))
    ;({ page, problems } = await open(browser, url, { width: 1100, height: 800 }))
  }, 60_000)

  afterAll(async () => { await browser?.close() })

  for (const mode of ['light', 'dark'] as const) {
    it(`draws Income vs Expenses in ${mode}: bars in the theme’s income and expense colours, the net over them, figures in the figures’ font`, async () => {
      const { theme } = await page.evaluate(m => window.report.start({ mode: m }), mode)
      // The chart is loaded when first drawn (its own chunk in the app): wait for its bars
      await page.waitForSelector('[role="figure"] .MuiBarChart-element', { timeout: 10_000 })
      const drawn = await page.evaluate(() => ({
        barColors: [...new Set([...document.querySelectorAll('.MuiBarChart-element')].map(e => getComputedStyle(e).fill))],
        lineColors: [...new Set([...document.querySelectorAll('.MuiLineChart-line')].map(e => getComputedStyle(e).stroke))],
        label: document.querySelector('[role="figure"]')?.getAttribute('aria-label'),
        badColor: getComputedStyle(document.querySelector('[data-report-row="net:0"] [data-column="2"]')!).color,
        figureFont: getComputedStyle(document.querySelector('[data-report-row="salary"] [data-column="0"]')!).fontFamily,
        figureDigits: getComputedStyle(document.querySelector('[data-report-row="salary"] [data-column="0"]')!).fontVariantNumeric,
        figureAlign: getComputedStyle(document.querySelector('[data-report-row="salary"] [data-column="0"]')!).textAlign
      }))
      expect(drawn.barColors).toEqual([rgb(theme.success), rgb(theme.error)])
      expect(drawn.lineColors).toEqual([rgb(theme.text)])
      expect(drawn.label).toMatch(/^Income vs Expenses, bar chart: Income /)
      expect(drawn.badColor).toBe(rgb(theme.error))
      expect(drawn.figureFont).toBe(theme.numeric)
      expect(drawn.figureDigits).toBe('tabular-nums')
      expect(drawn.figureAlign).toBe('right')
      await screenshot(page, `report-incomeVsExpenses-${mode}`)
    })
  }

  it('paints a long report’s first rows at once and the rest 500 at a time, never holding the window long', async () => {
    const drawn = await page.evaluate(() => window.report.drawLong(5000))
    console.log(`[browser] 5,000 rows: first rows after ${drawn.firstRowsMs.toFixed(0)} ms, all after ${drawn.allRowsMs.toFixed(0)} ms, longest frame ${drawn.longestFrameMs.toFixed(0)} ms, ${drawn.frames} frames`)
    expect(drawn.rows).toBe(5000)
    // R0: all 5,000 at once held the window 0.7 s (2.8 s on a CPU 4× slower). Measured here in R3: the longest frame
    // 150 to 233 ms, all drawn in 1.5 to 2.1 s. Asserted as what holds under load too: over many frames, none of them
    // a large share of the whole (drawn at once, one frame would be all of it)
    expect(drawn.frames).toBeGreaterThan(10)
    expect(drawn.longestFrameMs).toBeLessThan(drawn.allRowsMs / 3)
    expect(drawn.longestFrameMs).toBeLessThan(2000)
    await screenshot(page, 'report-long')
  })

  it('scrolls a wide report sideways rather than cutting a figure short', async () => {
    await page.evaluate(() => window.report.start({ mode: 'light', report: 'wide', width: 700 }))
    await page.click('button:has-text("Table")')
    const fit = await page.evaluate(() => {
      const container = document.querySelector('[role="treegrid"]')!.parentElement!
      const cells = [...document.querySelectorAll('[data-report-row="salary"] [data-column]')] as HTMLElement[]
      return {
        scrolls: container.scrollWidth > container.clientWidth, overflowX: getComputedStyle(container).overflowX,
        cut: cells.filter(c => c.scrollWidth > c.clientWidth).length, columns: cells.length, text: cells[0].textContent
      }
    })
    expect(fit.columns).toBe(25)
    expect(fit.text).toBe('12,345,678.90')
    expect(fit.scrolls).toBe(true)
    expect(fit.overflowX).toBe('auto')
    expect(fit.cut).toBe(0)
    await screenshot(page, 'report-wide')
    await page.click('button:has-text("Both")')
  })

  it('runs again only while on screen: hidden as the shell hides it, once when shown again', async () => {
    await page.evaluate(() => window.report.start({ mode: 'light' }))
    const before = await page.evaluate(() => window.report.runs())
    await page.evaluate(() => window.report.hide(true))
    await page.waitForTimeout(100)
    for (let i = 0; i < 3; i++) await page.evaluate(([name]) => window.report.emit(name, { sources: ['reports.flows'] }), [REPORTS_EVENTS.stale])
    await page.waitForTimeout(100)
    expect(await page.evaluate(() => window.report.runs())).toBe(before)
    await page.evaluate(() => window.report.hide(false))
    await page.waitForFunction(b => window.report.runs() > b, before, { timeout: 5000 })
    await page.waitForTimeout(100)
    expect(await page.evaluate(() => window.report.runs())).toBe(before + 1)
    // On screen, each change runs it
    await page.evaluate(([name]) => window.report.emit(name, { sources: ['reports.flows'] }), [REPORTS_EVENTS.stale])
    await page.waitForFunction(b => window.report.runs() > b + 1, before, { timeout: 5000 })
  })

  for (const mode of ['light', 'dark'] as const) {
    it(`draws Budget vs Actual, the budget plugin's report, in ${mode}: a Budget to choose, no Accounts or Currency; red only under expenses`, async () => {
      const { theme } = await page.evaluate(m => window.report.start({ mode: m, report: 'budget' }), mode)
      await page.waitForSelector('[role="figure"] .MuiBarChart-element', { timeout: 10_000 })
      const drawn = await page.evaluate(() => {
        const cell = (row: string, column: number) => document.querySelector(`[data-report-row="${row}"] [data-column="${column}"]`) as HTMLElement
        // The fields' labels (an MUI select's is an element of its own, which its combobox names)
        const fields = [...document.querySelectorAll('[data-parameters] [role="combobox"]')]
          .map(c => [document.getElementById(c.getAttribute('aria-labelledby') ?? '')?.textContent, c.textContent])
        return {
          fields,
          bars: document.querySelectorAll('.MuiBarChart-element').length,
          categories: [...document.querySelectorAll('.MuiChartsAxis-tickLabel')].map(t => t.textContent),
          overColour: getComputedStyle(cell('own:c:food', 2)).color, incomeColour: getComputedStyle(cell('other:income', 2)).color,
          net: [...document.querySelectorAll('[data-report-row="net:0"] [data-column]')].map(c => c.textContent),
          used: cell('own:c:food', 3).textContent
        }
      })
      expect(drawn.fields).toEqual([['Period', 'This month'], ['Budget', 'Household']])
      expect(drawn.bars).toBe(10)
      expect(drawn.categories).toEqual(expect.arrayContaining(['Food', 'Housing', 'Transportation', 'Other expenses', 'Uncategorised']))
      expect(drawn.overColour).toBe(rgb(theme.error))
      expect(drawn.incomeColour).not.toBe(rgb(theme.error))
      expect(drawn.net).toEqual(['3,540.00', '3,546.05', '6.05', '—'])
      expect(drawn.used).toBe('175.9 %')
      await screenshot(page, `report-budgetVsActual-${mode}`)
    })
  }

  it('draws all of it without an error or a console error', () => {
    expect(problems).toEqual([])
  })
})
