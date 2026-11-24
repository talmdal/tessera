// The result table (phase R3): a long report draws its first 500 rows at once and 500 more after each painted frame (a
// frame's callback, then a timeout: R0 found a bare timeout lands in the same frame), so the window never waits on all
// of them. Then its headings, folding, figures and keys on a small one.
import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ThemeProvider } from '@mui/material'
import type { ReportResult } from '@tessera/reports-api'
import { ResultTable, type Cell } from '../../../../plugins/reports/src/renderer/ResultTable'
import { ROWS_PER_CHUNK } from '../../../../plugins/reports/src/renderer/tableModel'
import { createShellTheme } from '../../../../shell/renderer/theme/createShellTheme'
import { DEFAULT_THEME } from '../../../../shared/theme/types'
import { Q1, incomeResult } from './fixtures'

const drawnRows = () => document.querySelectorAll('[data-report-row]').length

/** Frames are held until the test lets one be painted. */
function holdFrames() {
  const frames: FrameRequestCallback[] = []
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { frames.push(callback); return frames.length })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})
  return {
    waiting: () => frames.length,
    /** Runs the frame's callback (before its paint), then lets the timeout after it run (once painted). */
    paint: async () => {
      const frame = frames.shift()!
      await act(async () => { frame(performance.now()) })
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    },
    frameOnly: async () => { const frame = frames.shift()!; await act(async () => { frame(performance.now()) }) }
  }
}

function draw(result: ReportResult, props: Partial<Parameters<typeof ResultTable>[0]> = {}) {
  const theme = createShellTheme(DEFAULT_THEME, 'light')
  const handlers = { onSelect: vi.fn(), onToggle: vi.fn(), onTransactions: vi.fn(), onMenu: vi.fn() }
  const view = render(<ThemeProvider theme={theme}><ResultTable result={result} collapsed={new Set()} label="A report" {...handlers} {...props} /></ThemeProvider>)
  return { ...view, ...handlers }
}

/** A result of `count` payees, one figure each, as a plain list. */
function payees(count: number): ReportResult {
  return {
    title: 'Payees', subtitle: '', currency: 'CAD', period: Q1, notes: [], at: '2027-01-15T17:00:00.000Z',
    columns: [{ key: 'c0', label: 'Spending', unit: 'money' }],
    rows: Array.from({ length: count }, (_, i) => ({ id: `p${i}`, label: `Payee ${i}`, depth: 1, kind: 'member' as const, values: [i * 100] }))
  }
}

afterEach(() => { vi.restoreAllMocks() })

describe('a long report', () => {
  // 1,200 rows, three chunks: jsdom takes seconds to mount MUI's rows, and can't paint. The browser test
  // (tests/browser/reportView.test.ts) draws 5,000 in Chromium and measures the frames
  it('draws its rows 500 at a time, each chunk only once the frame before it is painted', async () => {
    const frames = holdFrames()
    draw(payees(1200))
    expect(drawnRows()).toBe(ROWS_PER_CHUNK)
    expect(screen.getByText('Drawing 700 more rows…')).toBeInTheDocument()
    // The frame's callback alone draws nothing: the next chunk waits for the paint
    await frames.frameOnly()
    expect(drawnRows()).toBe(500)
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    expect(drawnRows()).toBe(1000)
    await frames.paint()
    expect(drawnRows()).toBe(1200)
    expect(frames.waiting()).toBe(0)
    expect(document.querySelector('[data-drawing]')).not.toBeInTheDocument()
  })
})

describe('the table', () => {
  // How figures look (right-aligned, the figures' font role, tabular digits) is the table's style for `data-column`,
  // checked in Chromium (tests/browser/reportView.test.ts): jsdom's computed styles ignore specificity
  it('heads each column, marks each figure as one, and leaves a heading row’s figures blank', () => {
    draw(incomeResult())
    const headers = screen.getAllByRole('columnheader').map(h => h.textContent)
    expect(headers).toEqual(['', 'Jan 2026', 'Feb 2026', 'Mar 2026', 'Total'])
    const salary = document.querySelector('[data-report-row="salary"] [data-column="0"]') as HTMLElement
    expect(salary).toHaveTextContent('4,200.00')
    expect(document.querySelector('[data-report-row="salary"] [data-column="3"]')).toHaveAttribute('data-total')
    expect(document.querySelector('[data-report-row="income"] [data-column="0"]')).toHaveTextContent(/^$/)
    // A figure that can be listed says so, and a heading's can't
    expect(salary).toHaveAttribute('data-drill')
    expect(document.querySelector('[data-report-row="income"] [data-column="0"]')).not.toHaveAttribute('data-drill')
  })

  it('hides what is under a folded row, and says which rows fold', () => {
    draw(incomeResult(), { collapsed: new Set(['expense']) })
    const labels = [...document.querySelectorAll('[data-report-row]')].map(r => r.getAttribute('data-report-row'))
    expect(labels).toEqual(['income', 'salary', 'total:income', 'expense', 'total:expense', 'net:0'])
    expect(document.querySelector('[data-report-row="income"]')).toHaveAttribute('aria-expanded', 'true')
    expect(document.querySelector('[data-report-row="expense"]')).toHaveAttribute('aria-expanded', 'false')
    expect(document.querySelector('[data-report-row="salary"]')).not.toHaveAttribute('aria-expanded')
  })

  it('moves with the arrow keys, row by row and figure by figure, and asks for the transactions with Ctrl+Enter', async () => {
    let selected: Cell | undefined = { row: 'salary', column: -1 }
    const { rerender, onSelect, onTransactions, onToggle } = draw(incomeResult(), { selected })
    onSelect.mockImplementation((cell: Cell) => { selected = cell })
    const again = () => rerender(<ThemeProvider theme={createShellTheme(DEFAULT_THEME, 'light')}><ResultTable result={incomeResult()} collapsed={new Set()} label="A report" selected={selected} onSelect={onSelect} onToggle={onToggle} onTransactions={onTransactions} onMenu={vi.fn()} /></ThemeProvider>)
    const grid = screen.getByRole('treegrid')
    fireEvent.keyDown(grid, { key: 'ArrowDown' })
    expect(selected).toEqual({ row: 'total:income', column: -1 })
    again()
    fireEvent.keyDown(grid, { key: 'ArrowRight' })
    again()
    fireEvent.keyDown(grid, { key: 'ArrowRight' })
    expect(selected).toEqual({ row: 'total:income', column: 1 })
    again()
    fireEvent.keyDown(grid, { key: 'Enter', ctrlKey: true })
    expect(onTransactions).toHaveBeenCalledWith({ row: 'total:income', column: 1 })
    // On a heading, ← folds it
    selected = { row: 'expense', column: -1 }
    again()
    fireEvent.keyDown(grid, { key: 'ArrowLeft' })
    expect(onToggle).toHaveBeenCalledWith('expense', false)
    await userEvent.dblClick(document.querySelector('[data-report-row="rent"] [data-column="2"]')!)
    expect(onTransactions).toHaveBeenLastCalledWith({ row: 'rent', column: 2 })
  })
})
