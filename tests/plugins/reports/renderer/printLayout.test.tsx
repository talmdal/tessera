// The report as printed (phase R6), in jsdom: everything the view shows is in the print layout (title, subtitle, what
// it is compared with, the chart, the table with its rows as folded on screen, the notes) and what a page needs besides
// (the ledger, when it was printed); the whole table at once, not in chunks; the figures the view's; in the shell's print
// area, beside the window's root, in the print theme, titled while it is there. How it prints (pages, light colours in
// a dark window, only the print area) is for the browser test.
import { render, screen, waitFor } from '@testing-library/react'
import { ThemeProvider, useTheme } from '@mui/material'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ReportResult } from '@tessera/reports-api'
import { PrintArea } from '@tessera/ui'
import { PrintThemeContext } from '../../../../tessera-ui/internal'
import { chartModel } from '../../../../plugins/reports/src/renderer/chartModel'
import { MIN_ZOOM, PrintLayout, pageFor, type PrintLayoutProps } from '../../../../plugins/reports/src/renderer/PrintLayout'
import { ResultTable } from '../../../../plugins/reports/src/renderer/ResultTable'
import { compareLines } from '../../../../plugins/reports/src/renderer/ReportView'
import { DEFAULT_FONT_SETTINGS, resolveFonts } from '../../../../shared/fonts/resolveFonts'
import { DEFAULT_THEME } from '../../../../shared/theme/types'
import { createShellTheme } from '../../../../shell/renderer/theme/createShellTheme'
import { incomeResult, openedOf, spendingResult } from './fixtures'

const fonts = resolveFonts(DEFAULT_FONT_SETTINGS)
const dark = createShellTheme(DEFAULT_THEME, 'dark', { fonts })
const light = createShellTheme(DEFAULT_THEME, 'light', { fonts, reducedMotion: true })

const hadPointerEvent = 'PointerEvent' in globalThis
beforeAll(() => { if (!hadPointerEvent) (globalThis as Record<string, unknown>).PointerEvent = class extends MouseEvent {} })
afterAll(() => { if (!hadPointerEvent) delete (globalThis as Record<string, unknown>).PointerEvent })

/** The print layout in a dark window, as the shell draws it: the window's theme, and the light one to print in. */
function printed(over: Partial<PrintLayoutProps> = {}) {
  const result = over.result ?? incomeResult()
  const onReady = vi.fn()
  const props: PrintLayoutProps = {
    title: 'Income vs Expenses', result, show: 'both', model: chartModel(result), collapsed: new Set(), lines: [], notes: [], ledgerName: 'Home',
    printedAt: 'Jan 15, 2027, 5:00 PM', onReady, ...over
  }
  const drawn = render(
    <PrintThemeContext.Provider value={() => light}>
      <ThemeProvider theme={dark}><PrintLayout {...props} /></ThemeProvider>
    </PrintThemeContext.Provider>
  )
  const area = () => document.querySelector('[data-print-area]') as HTMLElement
  return { ...drawn, onReady, area, props }
}

/** Waits until the layout says it is ready: the chart's module loads the first time, which takes a while in jsdom. */
const ready = (onReady: ReturnType<typeof vi.fn>) => waitFor(() => expect(onReady).toHaveBeenCalled(), { timeout: 10_000 })

const printRows = (area: HTMLElement) => [...area.querySelectorAll('[data-print-row]')].map(r => [
  (r.querySelector('th') as HTMLElement).textContent, ...[...r.querySelectorAll('td')].map(td => td.textContent)
])

describe('the print layout', () => {
  it('is in the print area, beside the window\'s root: the title, subtitle, what it is compared with, notes, the ledger and when', async () => {
    const result = incomeResult({ notes: [{ tone: 'warning', text: 'Accounts in USD are left out.' }] })
    const { area, onReady, container } = printed({ result, lines: ['Compared with the period before'], notes: ['“Detail” is no longer offered.'] })
    await ready(onReady)
    expect(container.querySelector('[data-print-area]')).toBeNull()
    expect(area().parentElement).toBe(document.body)
    expect(area().querySelector('h1')).toHaveTextContent('Income vs Expenses')
    expect(area().querySelector('[data-subtitle]')).toHaveTextContent(result.subtitle)
    expect([...area().querySelectorAll('[data-parameter]')].map(p => p.textContent)).toEqual(['Compared with the period before'])
    expect([...area().querySelectorAll('[data-note]')].map(p => p.textContent)).toEqual(['“Detail” is no longer offered.', 'Accounts in USD are left out.'])
    expect(area().querySelector('[data-printed]')).toHaveTextContent('Home · Printed Jan 15, 2027, 5:00 PM')
    // jsdom lays nothing out, so the table fits across a portrait page
    expect(onReady).toHaveBeenCalledWith(false)
    expect(area().querySelector('[data-print-layout]')).toHaveAttribute('data-orientation', 'portrait')
  })

  it('has every row the view\'s table shows, as folded there, with the view\'s figures and bad figures marked', async () => {
    const result = incomeResult()
    const { area, onReady } = printed({ result, collapsed: new Set(['expense']) })
    await ready(onReady)
    const onScreen = render(
      <ThemeProvider theme={light}>
        <ResultTable result={result} collapsed={new Set(['expense'])} label="x" onSelect={() => {}} onToggle={() => {}} onTransactions={() => {}} onMenu={() => {}} />
      </ThemeProvider>
    )
    const viewRows = [...onScreen.container.querySelectorAll('[data-report-row]')].map(r => [
      (r.querySelector('th') as HTMLElement).textContent, ...[...r.querySelectorAll('td')].map(td => td.textContent)
    ])
    expect(printRows(area())).toEqual(viewRows)
    expect(printRows(area()).map(r => r[0])).toEqual(['Income', 'Salary', 'Total income', 'Expenses', 'Total expenses', 'Net income'])
    expect([...area().querySelectorAll('thead th')].map(th => th.textContent)).toEqual(['', ...result.columns.map(c => c.label)])
    expect(area().querySelector('[data-print-row="net:0"] [data-column="2"]')).toHaveAttribute('data-bad')
  })

  it('draws the whole table at once, where the view draws 500 rows at a time', async () => {
    const many = incomeResult()
    const rows = Array.from({ length: 1200 }, (_, i) => ({ id: `r${i}`, label: `Payee ${i}`, depth: 1, kind: 'member' as const, values: many.columns.map(() => i) }))
    const { area, onReady } = printed({ result: { ...many, rows }, model: undefined, show: 'table' })
    await ready(onReady)
    expect(area().querySelectorAll('[data-print-row]')).toHaveLength(1200)
  })

  it('prints what the view shows: the chart and the table, either alone, or what it says when there is nothing', async () => {
    const spending = spendingResult()
    const both = printed({ result: spending, model: chartModel(spending), show: 'both' })
    await ready(both.onReady)
    expect(both.area().querySelector('[data-print-chart] [data-chart="donut"]')).not.toBeNull()
    expect(both.area().querySelector('[data-print-table]')).not.toBeNull()
    both.unmount()
    const chart = printed({ result: spending, model: chartModel(spending), show: 'chart' })
    await ready(chart.onReady)
    expect(chart.area().querySelector('[data-print-chart]')).not.toBeNull()
    expect(chart.area().querySelector('[data-print-table]')).toBeNull()
    chart.unmount()
    const table = printed({ result: spending, model: chartModel(spending), show: 'table' })
    await ready(table.onReady)
    expect(table.area().querySelector('[data-print-chart]')).toBeNull()
    table.unmount()
    const nothing: ReportResult = { ...spending, rows: spending.rows.map(r => ({ ...r, values: r.values.map(() => 0) })) }
    const empty = printed({ result: nothing, emptyText: 'Nothing was spent from these accounts in this period.' })
    await ready(empty.onReady)
    expect(empty.area().querySelector('[data-empty]')).toHaveTextContent('Nothing was spent from these accounts in this period.')
  })

  it('is the document\'s title while there (the print job\'s name, a PDF\'s title), off screen at a page\'s width, and gone once printed', async () => {
    const before = document.title
    const { area, onReady, unmount } = printed({ title: 'Spending in 2026' })
    await ready(onReady)
    expect(document.title).toBe('Spending in 2026')
    // Laid out, for the chart to measure itself, but not on screen: the print stylesheet puts it on the page
    expect(area().style.position).toBe('fixed')
    expect(area().style.width).toBe('680px')
    unmount()
    expect(document.querySelector('[data-print-area]')).toBeNull()
    expect(document.title).toBe(before)
  })

  it('draws its content in the light print theme, inside a dark window', () => {
    let mode: string | undefined
    function Probe() {
      mode = useTheme().palette.mode
      return null
    }
    render(
      <PrintThemeContext.Provider value={() => light}>
        <ThemeProvider theme={dark}><PrintArea><Probe /></PrintArea></ThemeProvider>
      </PrintThemeContext.Provider>
    )
    expect(mode).toBe('light')
  })
})

describe('what the printed report says it is compared with', () => {
  const view = openedOf('incomeVsExpenses', { today: '2027-01-15', yearStart: { month: 1, day: 1 } })
  it('names the earlier period, a date, or sub-ledgers side by side; nothing when compared with nothing', () => {
    expect(compareLines(view, { compare: 'none' })).toEqual([])
    expect(compareLines(view, {})).toEqual([])
    expect(compareLines(view, { compare: 'previousPeriod' })).toEqual(['Compared with the period before'])
    expect(compareLines(view, { compare: 'previousYear' })).toEqual(['Compared with the same period a year before'])
    expect(compareLines(view, { compare: 'subLedgers' })).toEqual(['Sub-ledgers side by side'])
    expect(compareLines(view, { compare: { asOf: { date: '2026-06-30' } } })).toEqual([expect.stringMatching(/^Compared with .*2026/)])
  })
})

describe('the page a table prints on', () => {
  const even = (label: number, n: number, each: number) => pageFor(label + n * each, label, Array.from({ length: n }, () => each))
  it('is portrait when the table fits across one, as drawn', () => {
    expect(even(200, 4, 100)).toEqual({ landscape: false, blocks: [{ columns: [0, 1, 2, 3], zoom: 1 }] })
  })
  it('is landscape when it doesn\'t, and scales a table down to fit one, to no less than MIN_ZOOM', () => {
    expect(even(200, 6, 100)).toEqual({ landscape: true, blocks: [{ columns: [0, 1, 2, 3, 4, 5], zoom: 1 }] })
    const scaled = even(200, 10, 100)
    expect(scaled.blocks).toEqual([{ columns: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], zoom: 960 / 1200 }])
    expect(scaled.blocks[0].zoom).toBeGreaterThanOrEqual(MIN_ZOOM)
  })
  it('prints columns in blocks, as even as fit, each as drawn, when scaling would leave the table too small to read', () => {
    // 25 columns of 120 px and labels of 150: 3,150 px, which would print at 0.30
    const page = even(150, 25, 120)
    expect(page.landscape).toBe(true)
    expect(page.blocks.map(b => b.columns.length)).toEqual([5, 5, 5, 5, 5])
    expect(page.blocks.flatMap(b => b.columns)).toEqual(Array.from({ length: 25 }, (_, i) => i))
    expect(page.blocks.every(b => b.zoom === 1 && 150 + b.columns.length * 120 <= 960)).toBe(true)
  })
  it('keeps the greedy blocks where even ones wouldn\'t fit, and scales a column wider than the page alone', () => {
    // Four and four would put the 700 px column with three more, past the page: two and six
    const page = pageFor(150 + 700 + 7 * 100, 150, [700, 100, 100, 100, 100, 100, 100, 100])
    expect(page.blocks.map(b => b.columns)).toEqual([[0, 1], [2, 3, 4, 5, 6, 7]])
    expect(page.blocks.every(b => b.zoom === 1)).toBe(true)
    const huge = pageFor(150 + 2000 + 2000, 150, [2000, 2000])
    expect(huge.blocks).toEqual([{ columns: [0], zoom: 960 / 2150 }, { columns: [1], zoom: 960 / 2150 }])
  })
  it('is one block as drawn where nothing is laid out (jsdom)', () => {
    expect(pageFor(0, 0, [0, 0, 0])).toEqual({ landscape: false, blocks: [{ columns: [0, 1, 2], zoom: 1 }] })
  })
})
