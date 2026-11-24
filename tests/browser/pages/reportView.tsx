// The report view's page: `ReportView` in the shell's theme (light or dark, the user's font roles), with a bridge in
// the page answering the reports' channels, so the test can show a report, push events, hide the view as the shell
// does (display: none), and watch the frames while a long table is drawn.
import { createRoot, type Root } from 'react-dom/client'
import { CssBaseline, ThemeProvider } from '@mui/material'
import { REPORTS_CHANNELS, type ReportResult } from '@tessera/reports-api'
import ReportView from '../../../plugins/reports/src/renderer/ReportView'
import { DEFAULT_FONT_SETTINGS, resolveFonts } from '../../../shared/fonts/resolveFonts'
import { DEFAULT_THEME } from '../../../shared/theme/types'
import { createShellTheme } from '../../../shell/renderer/theme/createShellTheme'
import { INCOME_MEMBERS, budgetOpened, budgetResult, catalogOf, incomeResult, openedOf, resultOf } from '../../plugins/reports/renderer/reports'
import { DEFINITIONS } from '../../../plugins/reports/src/privileged/definitions'

type Listener = (data: unknown) => void
const listeners = new Map<string, Set<Listener>>()
const calls: { channel: string, data: unknown }[] = []
let result: () => ReportResult = () => incomeResult()
/** Budget vs Actual, the budget plugin's report, is shown rather than Income vs Expenses. */
let budget = false

;(window as unknown as { api: unknown }).api = {
  invoke: async (channel: string, data?: { ref: { definitionId: string } }) => {
    calls.push({ channel, data })
    switch (channel) {
      case REPORTS_CHANNELS.catalog: return catalogOf(budget ? { shown: { ref: { definitionId: 'budget.vsActual' }, request: 1 } } : {})
      case REPORTS_CHANNELS.open: return { ok: true, value: budget ? budgetOpened() : openedOf(data!.ref.definitionId.replace('reports.', '')) }
      case REPORTS_CHANNELS.run: return { ok: true, value: result() }
      case REPORTS_CHANNELS.members: return { ok: true, value: budget ? [{ id: 'household', label: 'Household', isDefault: true }] : [] }
      default: return undefined
    }
  },
  on: (name: string, listener: Listener) => {
    if (!listeners.has(name)) listeners.set(name, new Set())
    listeners.get(name)!.add(listener)
    return () => { listeners.get(name)!.delete(listener) }
  }
}

/** A plain list of `count` payees with `columns` figures each: a long report. */
function long(count: number, columns = 1): ReportResult {
  return {
    title: 'Spending by Payee', subtitle: '2026 · Whole ledger · CAD', currency: 'CAD', period: { from: '2026-01-01', to: '2026-12-31' }, notes: [], at: '2027-01-15T17:00:00.000Z',
    columns: Array.from({ length: columns }, (_, c) => ({ key: `c${c}`, label: `Figure ${c + 1}`, unit: 'money' as const })),
    rows: Array.from({ length: count }, (_, i) => ({ id: `p${i}`, label: `Payee ${i}`, depth: 1, kind: 'member' as const, values: Array.from({ length: columns }, (_, c) => (i + 1) * 1234567 + c) }))
  }
}

/** Income vs Expenses over two years: 24 months and a total across, wider than the page. */
function wide(): ReportResult {
  const months = Array.from({ length: 24 }, (_, i) => `${2025 + Math.floor(i / 12)}-${String(i % 12 + 1).padStart(2, '0')}`)
  const rows = months.flatMap(m => [{ keys: ['salary', m], values: [1234567890] }, { keys: ['rent', m], values: [150000] }, { keys: ['groceries', m], values: [61145] }])
  return resultOf(DEFINITIONS.find(d => d.id === 'reports.incomeVsExpenses')!.spec, 'Income vs Expenses', rows, INCOME_MEMBERS, { from: '2025-01-01', to: '2026-12-31' })
}

let root: Root | undefined
const host = () => document.getElementById('root')!

declare global {
  interface Window {
    report: {
      start(options: { mode: 'light' | 'dark', report?: 'income' | 'long' | 'wide' | 'budget', rows?: number, width?: number }): Promise<{ ms: number, theme: { error: string, success: string, text: string, numeric: string } }>
      emit(name: string, data: unknown): void
      runs(): number
      hide(hidden: boolean): void
      /** Draws the long report, watching every frame until the last row is drawn: when rows first showed, and the longest frame. */
      drawLong(rows: number): Promise<{ firstRowsMs: number, allRowsMs: number, longestFrameMs: number, frames: number, rows: number }>
    }
  }
}

window.report = {
  async start({ mode, report = 'income', rows = 5000, width = 1000 }) {
    root?.unmount()
    result = report === 'long' ? () => long(rows) : report === 'wide' ? wide : report === 'budget' ? () => budgetResult() : () => incomeResult()
    budget = report === 'budget'
    calls.length = 0
    const theme = createShellTheme(DEFAULT_THEME, mode, { fonts: resolveFonts(DEFAULT_FONT_SETTINGS) })
    document.body.style.background = theme.palette.background.default
    host().style.width = `${width}px`
    host().style.height = '700px'
    const started = performance.now()
    root = createRoot(host())
    root.render(<ThemeProvider theme={theme}><CssBaseline /><ReportView /></ThemeProvider>)
    for (let i = 0; i < 500 && !host().querySelector('[data-report-row]'); i++) await new Promise(resolve => setTimeout(resolve, 10))
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    return {
      ms: performance.now() - started,
      // The figures' role: its own family when the user set one, else the interface font's, with tabular figures
      theme: {
        error: theme.palette.error.main, success: theme.palette.success.main, text: theme.palette.text.primary,
        numeric: theme.typography.numeric.fontFamily ?? theme.typography.fontFamily!
      }
    }
  },
  emit(name, data) {
    listeners.get(name)?.forEach(listener => listener(data))
  },
  runs() {
    return calls.filter(c => c.channel === REPORTS_CHANNELS.run).length
  },
  hide(hidden) {
    // As the shell hides a main view that another is in front of: kept mounted, not displayed
    host().style.display = hidden ? 'none' : ''
  },
  async drawLong(rows) {
    root?.unmount()
    budget = false
    result = () => long(rows)
    const theme = createShellTheme(DEFAULT_THEME, 'light', { fonts: resolveFonts(DEFAULT_FONT_SETTINGS) })
    host().style.display = ''
    const frameTimes: number[] = []
    let watching = true
    const watch = (t: number) => { frameTimes.push(t); if (watching) requestAnimationFrame(watch) }
    requestAnimationFrame(watch)
    const started = performance.now()
    root = createRoot(host())
    root.render(<ThemeProvider theme={theme}><CssBaseline /><ReportView /></ThemeProvider>)
    let firstRowsMs = 0
    for (;;) {
      await new Promise(resolve => setTimeout(resolve, 5))
      const drawn = host().querySelectorAll('[data-report-row]').length
      if (drawn > 0 && firstRowsMs === 0) firstRowsMs = performance.now() - started
      if (drawn >= rows && !host().querySelector('[data-drawing]')) break
      if (performance.now() - started > 60_000) break
    }
    const allRowsMs = performance.now() - started
    await new Promise(resolve => requestAnimationFrame(resolve))
    watching = false
    // The longest the window went without painting, once the first rows were there
    const gaps = frameTimes.slice(1).map((t, i) => t - frameTimes[i]).filter((_, i) => frameTimes[i + 1] - started > firstRowsMs)
    return { firstRowsMs, allRowsMs, longestFrameMs: Math.max(0, ...gaps), frames: frameTimes.length, rows: host().querySelectorAll('[data-report-row]').length }
  }
}
