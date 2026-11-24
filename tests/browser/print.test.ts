// @vitest-environment node
// Printing in headless Chromium (phase R6), the engine behind Electron's print and `printToPDF`: what jsdom can't show.
// A report printed from a dark window prints only its print area, in the light theme's colours, every row on as many
// pages as it takes, the table's heading on each, the pages numbered, the chart drawn at the page's width; a table too
// wide for a landscape page scaled down to fit rather than cut off; and, with no print area, a view printed whole
// without the bars. Skipped, saying why, where there's no Chromium (tests/browser/harness.ts).
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { browserProblem, bundle, launch, open, repo, type Page } from './harness'

function rgb(color: string): string {
  if (!color.startsWith('#')) return color.replace(/\s*,\s*/g, ', ')
  const h = color.slice(1)
  const full = h.length === 3 ? [...h].map(c => c + c).join('') : h
  return `rgb(${[0, 2, 4].map(i => parseInt(full.slice(i, i + 2), 16)).join(', ')})`
}

/** Pages in a PDF Chromium wrote: its page objects. */
const pages = (pdf: Buffer) => (pdf.toString('latin1').match(/\/Type\s*\/Page\b(?!s)/g) ?? []).length

/** A PDF of the page, as `printToPDF` writes it: Letter, about 1 cm margins (Electron's default), no backgrounds. */
const pdf = (page: Page, landscape: boolean) => page.pdf({ format: 'Letter', landscape, margin: { top: '0.4in', bottom: '0.4in', left: '0.4in', right: '0.4in' } })

/** Keeps a PDF for a person to look at, beside the screenshots, when TESSERA_SCREENSHOTS names a folder. */
async function keep(file: Buffer, name: string) {
  const folder = process.env.TESSERA_SCREENSHOTS
  if (!folder) return
  fs.mkdirSync(folder, { recursive: true })
  fs.writeFileSync(path.join(folder, `${name}.pdf`), file)
}

describe.skipIf(browserProblem)('printing a report in a browser', () => {
  let browser: Awaited<ReturnType<typeof launch>>
  let page: Page
  let problems: string[]

  beforeAll(async () => {
    browser = await launch()
    const url = await bundle(path.join(repo, 'tests/browser/pages/print.tsx'))
    ;({ page, problems } = await open(browser, url, { width: 1100, height: 800 }))
  }, 60_000)

  afterAll(async () => { await browser?.close() })

  it('prints only the report, from a dark window in the light theme\'s colours, its chart at the page\'s width, on a portrait page', async () => {
    const theme = await page.evaluate(() => window.printing.start({ mode: 'dark', report: 'income' }))
    const ready = await page.evaluate(() => window.printing.print('print'))
    expect(ready).toEqual({ request: 1, landscape: false })
    await page.emulateMedia({ media: 'print' })
    const printed = await page.evaluate(() => {
      const area = document.querySelector('[data-print-area]') as HTMLElement
      const shown = (e: Element | null) => e !== null && getComputedStyle(e).display !== 'none' && getComputedStyle(e).visibility !== 'hidden'
      // The chart's surface: its widest drawing, not the legend's marks
      const widest = (within: Element) => Math.max(0, ...[...within.querySelectorAll('svg')].map(s => s.getBoundingClientRect().width))
      return {
        root: shown(document.getElementById('root')), area: shown(area), position: getComputedStyle(area).position,
        title: getComputedStyle(area.querySelector('h1')!).color, bad: getComputedStyle(area.querySelector('[data-print-row="net:0"] [data-column="2"]')!).color,
        rows: area.querySelectorAll('[data-print-row]').length, onScreen: document.querySelectorAll('#root [data-report-row]').length,
        chartWidth: widest(area.querySelector('[data-print-chart]')!), bars: area.querySelectorAll('.MuiBarChart-element').length,
        documentTitle: document.title
      }
    })
    expect(printed).toMatchObject({ root: false, area: true, position: 'static', title: rgb(theme.light.text), bad: rgb(theme.light.error), documentTitle: 'Income vs Expenses' })
    expect(printed.title).not.toBe(rgb(theme.dark.text))
    expect(printed.rows).toBe(printed.onScreen)
    expect(printed.bars).toBeGreaterThan(0)
    expect(printed.chartWidth).toBeGreaterThan(600)
    expect(printed.chartWidth).toBeLessThanOrEqual(680)
    const file = await pdf(page, false)
    expect(pages(file)).toBe(1)
    await keep(file, 'print-income-dark')
    await page.emulateMedia({ media: 'screen' })
    expect(await page.evaluate(() => window.printing.done())).toBe(true)
    expect(problems).toEqual([])
  })

  it('prints every row of a long report, on as many pages as it takes, rows never split', async () => {
    await page.evaluate(() => window.printing.start({ mode: 'light', report: 'long', rows: 300 }))
    const ready = await page.evaluate(() => window.printing.print('pdf'))
    expect(ready).toMatchObject({ landscape: false })
    await page.emulateMedia({ media: 'print' })
    // On screen the view draws 500 rows at a time; printed, all of them at once
    expect(await page.evaluate(() => document.querySelectorAll('[data-print-area] [data-print-row]').length)).toBe(300)
    const file = await pdf(page, false)
    console.log(`[browser] 300 rows: ${pages(file)} Letter pages`)
    // R0: without the stylesheet, one page of 22 rows; with it, 300 rows on 7 A4 pages. Here, with the title, Letter
    expect(pages(file)).toBeGreaterThanOrEqual(6)
    expect(pages(file)).toBeLessThanOrEqual(9)
    await keep(file, 'print-long')
    await page.emulateMedia({ media: 'screen' })
    expect(await page.evaluate(() => window.printing.done())).toBe(true)
  })

  it('prints a report too wide for a portrait page landscape; too wide to read scaled, in blocks of columns, nothing cut off', async () => {
    await page.evaluate(() => window.printing.start({ mode: 'light', report: 'wide' }))
    const ready = await page.evaluate(() => window.printing.print('pdf'))
    expect(ready).toMatchObject({ landscape: true })
    await page.emulateMedia({ media: 'print' })
    await page.setViewportSize({ width: 960, height: 800 })
    const fit = await page.evaluate(() => [...document.querySelectorAll('[data-print-area] [data-print-block]')].map(block => {
      const table = block.querySelector('[data-print-table]') as HTMLElement
      return {
        right: table.getBoundingClientRect().right, zoom: Number(getComputedStyle(block).zoom),
        headings: [...table.querySelectorAll('thead tr:last-child th[data-column]')].map(th => th.textContent),
        labels: table.querySelectorAll('[data-print-row] th').length
      }
    }))
    console.log(`[browser] 24 months and a total: landscape, in ${fit.length} blocks of ${fit.map(b => b.headings.length).join(', ')} columns`)
    expect(fit.length).toBeGreaterThan(1)
    // Every column once, in order, across the blocks; each block with every row's label, as drawn, within the page
    expect(fit.flatMap(b => b.headings)).toHaveLength(25)
    expect(fit.at(-1)!.headings.at(-1)).toBe('Total')
    for (const block of fit) {
      expect(block.zoom).toBe(1)
      expect(block.labels).toBe(fit[0].labels)
      expect(block.right).toBeLessThanOrEqual(962)
    }
    const file = await pdf(page, true)
    expect(pages(file)).toBeGreaterThanOrEqual(1)
    await keep(file, 'print-wide')
    await page.setViewportSize({ width: 1100, height: 800 })
    await page.emulateMedia({ media: 'screen' })
    expect(await page.evaluate(() => window.printing.done())).toBe(true)
  })

  it('prints a donut and its table, chart not split from its page', async () => {
    await page.evaluate(() => window.printing.start({ mode: 'dark', report: 'spending' }))
    await page.evaluate(() => window.printing.print('print'))
    await page.emulateMedia({ media: 'print' })
    const donut = await page.evaluate(() => {
      const chart = document.querySelector('[data-print-area] [data-chart="donut"]')
      const width = chart ? Math.max(0, ...[...chart.querySelectorAll('svg')].map(s => s.getBoundingClientRect().width)) : 0
      const box = document.querySelector('[data-print-area] [data-print-chart]')!.getBoundingClientRect().width
      return { width, box, slices: document.querySelectorAll('[data-print-area] .MuiPieChart-arc').length }
    })
    expect(donut.slices).toBe(5)
    // The page's width, the legend beside the donut
    expect(donut.box).toBe(680)
    expect(donut.width).toBeGreaterThan(400)
    await keep(await pdf(page, false), 'print-spending-dark')
    await page.emulateMedia({ media: 'screen' })
    expect(await page.evaluate(() => window.printing.done())).toBe(true)
  })

  it('prints a view with no print area whole, without the bars or what it marks not to print', async () => {
    await page.evaluate(() => window.printing.plain(300))
    // On screen, the main area scrolls: what it doesn't show wouldn't print without the stylesheet
    await page.emulateMedia({ media: 'print' })
    const printed = await page.evaluate(() => {
      const main = document.querySelector('[data-region="main"]') as HTMLElement
      return {
        bar: getComputedStyle(document.querySelector('[data-region="left"]')!).display, overflow: getComputedStyle(main).overflowY,
        hidden: getComputedStyle(document.querySelector('[data-print="hide"]')!).display, height: main.getBoundingClientRect().height,
        ink: getComputedStyle(document.querySelector('[data-line] td')!).color
      }
    })
    // A dark window's view, in dark ink
    expect(printed).toMatchObject({ bar: 'none', overflow: 'visible', hidden: 'none', ink: 'rgb(0, 0, 0)' })
    expect(printed.height).toBeGreaterThan(3000)
    const file = await pdf(page, false)
    expect(pages(file)).toBeGreaterThanOrEqual(5)
    await keep(file, 'print-plain')
    await page.emulateMedia({ media: 'screen' })
  })
})
