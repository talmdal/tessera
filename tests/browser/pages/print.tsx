// The printing page (phase R6): `ReportView` as the shell draws it (the window's theme, light or dark; the print theme,
// the window theme's light variant; the shell's print stylesheet), inside a stand-in of the shell's layout (a left bar
// and the main area, which scrolls), with a bridge answering the reports' channels. The test asks the view to print, as
// the plugin does, and sees what prints while the view holds its print area; and, with no print area, what the
// stylesheet prints of a plain view.
import { createRoot, type Root } from 'react-dom/client'
import { CssBaseline, ThemeProvider } from '@mui/material'
import { REPORTS_CHANNELS, REPORTS_EVENTS, type PrintReady, type ReportResult } from '@tessera/reports-api'
import { PrintThemeContext } from '../../../tessera-ui/internal'
import ReportView from '../../../plugins/reports/src/renderer/ReportView'
import { DEFINITIONS } from '../../../plugins/reports/src/privileged/definitions'
import { DEFAULT_FONT_SETTINGS, resolveFonts } from '../../../shared/fonts/resolveFonts'
import { DEFAULT_THEME } from '../../../shared/theme/types'
import { createShellTheme } from '../../../shell/renderer/theme/createShellTheme'
import { PrintStyles } from '../../../shell/renderer/print/printStyles'
import { INCOME_MEMBERS, catalogOf, incomeResult, openedOf, resultOf, spendingResult } from '../../plugins/reports/renderer/reports'

type Listener = (data: unknown) => void
const listeners = new Map<string, Set<Listener>>()
let result: () => ReportResult = () => incomeResult()
let definition = 'incomeVsExpenses'
const readies: PrintReady[] = []
let printed: (() => void) | undefined

;(window as unknown as { api: unknown }).api = {
  invoke: async (channel: string, data?: unknown) => {
    switch (channel) {
      case REPORTS_CHANNELS.catalog: return catalogOf({ shown: { ref: { definitionId: `reports.${definition}` }, request: 1 } })
      case REPORTS_CHANNELS.open: return { ok: true, value: openedOf(definition) }
      case REPORTS_CHANNELS.run: return { ok: true, value: result() }
      case REPORTS_CHANNELS.members: return { ok: true, value: [] }
      // The plugin prints while the view holds its print area; the test says when it has
      case REPORTS_CHANNELS.printReady:
        readies.push(data as PrintReady)
        return new Promise(resolve => { printed = () => resolve({ ok: true, value: true }) })
      default: return undefined
    }
  },
  on: (name: string, listener: Listener) => {
    if (!listeners.has(name)) listeners.set(name, new Set())
    listeners.get(name)!.add(listener)
    return () => { listeners.get(name)!.delete(listener) }
  }
}

/** `count` payees, one figure each: a long report. */
function long(count: number): ReportResult {
  return {
    title: 'Spending by Payee', subtitle: '2026 · Whole ledger · CAD', currency: 'CAD', period: { from: '2026-01-01', to: '2026-12-31' }, notes: [], at: '2027-01-15T17:00:00.000Z',
    columns: [{ key: 'c0', label: 'Amount', unit: 'money' }],
    rows: Array.from({ length: count }, (_, i) => ({ id: `p${i}`, label: `Payee ${i}`, depth: 1, kind: 'member' as const, values: [(i + 1) * 12345] }))
  }
}

/** Income vs Expenses over two years: 24 months and a total across, wider than a landscape page. */
function wide(): ReportResult {
  const months = Array.from({ length: 24 }, (_, i) => `${2025 + Math.floor(i / 12)}-${String(i % 12 + 1).padStart(2, '0')}`)
  const rows = months.flatMap(m => [{ keys: ['salary', m], values: [1234567890] }, { keys: ['rent', m], values: [150000] }, { keys: ['groceries', m], values: [61145] }])
  return resultOf(DEFINITIONS.find(d => d.id === 'reports.incomeVsExpenses')!.spec, 'Income vs Expenses', rows, INCOME_MEMBERS, { from: '2025-01-01', to: '2026-12-31' })
}

// As the shell's page: the layout fills the window exactly and scrolls its own regions (shell/renderer/index.html)
const pageStyle = document.createElement('style')
pageStyle.textContent = 'html, body, #root { margin: 0; height: 100%; overflow: hidden; }'
document.head.appendChild(pageStyle)

let root: Root | undefined
const host = () => document.getElementById('root')!
const fonts = resolveFonts(DEFAULT_FONT_SETTINGS)

/** The shell's layout, in short: a grid the height of the window, a left bar, and the main area, which scrolls. */
function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div data-layout style={{ display: 'grid', height: '100vh', gridTemplateColumns: '220px minmax(0, 1fr)' }}>
      <nav data-region="left" style={{ borderRight: '1px solid #888' }}>Accounts · Budgets · Reports</nav>
      <main data-region="main" style={{ minWidth: 0, minHeight: 0, overflow: 'auto', padding: 20 }}>{children}</main>
    </div>
  )
}

declare global {
  interface Window {
    printing: {
      start(options: { mode: 'light' | 'dark', report?: 'income' | 'spending' | 'long' | 'wide', rows?: number }): Promise<{ light: { text: string, error: string }, dark: { text: string } }>
      /** Asks the view to print, as the plugin does; resolves with what the view answered once ready. */
      print(output: 'print' | 'pdf'): Promise<PrintReady>
      /** The plugin has printed: the view lets its print area go. */
      done(): Promise<boolean>
      /** A plain view of `rows` lines in the main area, with no print area. */
      plain(rows: number): Promise<void>
    }
  }
}

window.printing = {
  async start({ mode, report = 'income', rows = 300 }) {
    root?.unmount()
    readies.length = 0
    definition = report === 'spending' ? 'spendingByCategory' : report === 'long' ? 'spendingByPayee' : 'incomeVsExpenses'
    result = report === 'long' ? () => long(rows) : report === 'wide' ? wide : report === 'spending' ? () => spendingResult() : () => incomeResult()
    const windowTheme = createShellTheme(DEFAULT_THEME, mode, { fonts })
    const printTheme = createShellTheme(DEFAULT_THEME, 'light', { fonts, reducedMotion: true })
    root = createRoot(host())
    root.render(
      <PrintThemeContext.Provider value={() => printTheme}>
        <ThemeProvider theme={windowTheme}>
          <CssBaseline enableColorScheme />
          <PrintStyles />
          <Frame><ReportView /></Frame>
        </ThemeProvider>
      </PrintThemeContext.Provider>
    )
    for (let i = 0; i < 500 && !host().querySelector('[data-report-row]'); i++) await new Promise(resolve => setTimeout(resolve, 10))
    return {
      light: { text: printTheme.palette.text.primary, error: printTheme.palette.error.main },
      dark: { text: createShellTheme(DEFAULT_THEME, 'dark', { fonts }).palette.text.primary }
    }
  },
  async print(output) {
    const before = readies.length
    listeners.get(REPORTS_EVENTS.print)?.forEach(listener => listener({ request: before + 1, output }))
    for (let i = 0; i < 3000 && readies.length === before; i++) await new Promise(resolve => setTimeout(resolve, 10))
    return readies[readies.length - 1]
  },
  async done() {
    printed?.()
    for (let i = 0; i < 500 && document.querySelector('[data-print-area]'); i++) await new Promise(resolve => setTimeout(resolve, 10))
    return document.querySelector('[data-print-area]') === null
  },
  async plain(rows) {
    root?.unmount()
    const theme = createShellTheme(DEFAULT_THEME, 'dark', { fonts })
    root = createRoot(host())
    root.render(
      <ThemeProvider theme={theme}>
        <CssBaseline enableColorScheme />
        <PrintStyles />
        <Frame>
          <div data-print="hide">A toolbar that doesn’t print</div>
          <table><tbody>{Array.from({ length: rows }, (_, i) => <tr key={i} data-line><td>{`Line ${i}`}</td><td>{i * 3}</td></tr>)}</tbody></table>
        </Frame>
      </ThemeProvider>
    )
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  }
}
