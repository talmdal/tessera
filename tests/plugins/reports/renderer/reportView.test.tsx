// The report view (phase R3): Income vs Expenses for January to March 2026, shaped by the engine from the shipped
// definition. Its heading's parameters run it again; trees fold, by click and key; negative figures where they are bad
// are in the theme's error colour; empty, failing and stale states; a slow reply overtaken by a newer one; Accounts and
// Compare with; Show Transactions; the chart, the table or both; and what it shows with no ledger or no report.
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { REPORTS_CHANNELS, REPORTS_COMMANDS as C, REPORTS_EVENTS, type ReportResult, type RunArgs } from '@tessera/reports-api'
import ReportView from '../../../../plugins/reports/src/renderer/ReportView'
import { settle } from '../../../helpers/settle'
import { catalogOf, incomeResult, openedOf, renderInTheme, reportsBridge, spendingResult } from './fixtures'

const table = () => screen.findByRole('treegrid', { name: /^Income vs Expenses, / }, { timeout: 5000 })
const row = (id: string) => document.querySelector(`[data-report-row="${id}"]`) as HTMLElement
const cell = (id: string, column: number) => row(id).querySelector(`[data-column="${column}"]`) as HTMLElement
const labels = () => [...document.querySelectorAll('[data-report-row]')].map(r => (r.querySelector('th') as HTMLElement).textContent)
const runs = (bridge: ReturnType<typeof reportsBridge>) => bridge.calls(REPORTS_CHANNELS.run) as RunArgs[]

/** Draws the view, and waits for what it shows: by default, Income vs Expenses' table. */
async function show(answers: Parameters<typeof reportsBridge>[0] = {}, mode: 'light' | 'dark' = 'light', shown: () => Promise<unknown> = table) {
  const bridge = reportsBridge(answers)
  const drawn = renderInTheme(<ReportView />, mode)
  await shown()
  await settle()
  return { ...bridge, ...drawn }
}
const spendingShown = { [REPORTS_CHANNELS.catalog]: () => catalogOf({ shown: { ref: { definitionId: 'reports.spendingByCategory' }, request: 1 } }) }
const spendingTable = () => screen.findByRole('button', { name: 'Both' }, { timeout: 5000 })

/** Picks `option` in the select labelled `label`. */
async function choose(label: string, option: string | RegExp) {
  await userEvent.click(screen.getByRole('combobox', { name: label }))
  await userEvent.click(await screen.findByRole('option', { name: option }))
}

afterEach(() => { vi.useRealTimers() })

// jsdom has no PointerEvent, which the chart's pointer handling (MUI X) reads as the test clicks about the page
const hadPointerEvent = 'PointerEvent' in globalThis
beforeAll(() => { if (!hadPointerEvent) (globalThis as Record<string, unknown>).PointerEvent = class extends MouseEvent {} })
afterAll(() => { if (!hadPointerEvent) delete (globalThis as Record<string, unknown>).PointerEvent })

describe('the report view', () => {
  it('draws the report: its title, what it covers, its parameters, and every row in order', async () => {
    const { calls } = await show()
    expect(screen.getByRole('heading', { name: 'Income vs Expenses' })).toBeInTheDocument()
    expect(document.querySelector('[data-subtitle]')).toHaveTextContent('2026 · Whole ledger · CAD')
    expect(screen.getByRole('combobox', { name: 'Period' })).toHaveTextContent('This year')
    expect(document.querySelector('[data-period-label]')).toHaveTextContent('2027')
    expect(screen.getByRole('combobox', { name: 'Accounts' })).toHaveTextContent('Whole ledger (Home)')
    expect(screen.getByRole('combobox', { name: 'Currency' })).toHaveTextContent('Most used (CAD)')
    expect(screen.getByRole('combobox', { name: 'Compare with' })).toHaveTextContent('Nothing')
    expect(labels()).toEqual(['Income', 'Salary', 'Total income', 'Expenses', 'Housing', 'Food', 'Total expenses', 'Net income'])
    expect(cell('net:0', 2)).toHaveTextContent('-950.10')
    expect(cell('net:0', 3)).toHaveTextContent('3,240.15')
    expect(cell('income', 0)).toHaveTextContent(/^$/)
    // What it shows, reported for the commands, to save or remember: the parameters, options, chart or table, rows folded
    expect(calls(REPORTS_CHANNELS.select)).toEqual([{
      ref: { definitionId: 'reports.incomeVsExpenses' }, parameters: expect.objectContaining({ period: { preset: 'thisYear' } }), options: {},
      view: { show: 'both', collapsed: [] }
    }])
  })

  // The colour itself is the table's style for `data-bad`, checked in Chromium (tests/browser/reportView.test.ts), light
  // and dark: jsdom's computed styles ignore specificity, so MUI's own cell rule, inserted later, wins there
  it('marks a net below zero as bad, and nothing else', async () => {
    await show()
    expect(cell('net:0', 2)).toHaveAttribute('data-bad')
    for (const [id, c] of [['net:0', 0], ['total:expense', 2], ['rent', 2], ['salary', 1]] as const) expect(cell(id, c)).not.toHaveAttribute('data-bad')
  })

  it('runs again when a parameter changes: a preset period, then a custom one, typed date by date', async () => {
    const bridge = await show()
    await choose('Period', 'Last year')
    await waitFor(() => expect(runs(bridge).at(-1)!.parameters.period).toEqual({ preset: 'lastYear' }))
    await choose('Period', 'Custom…')
    await waitFor(() => expect(runs(bridge).at(-1)!.parameters.period).toEqual({ from: '2026-01-01', to: '2026-12-31' }))
    const from = screen.getByLabelText('From')
    fireEvent.change(from, { target: { value: '2026-04-01' } })
    await waitFor(() => expect(runs(bridge).at(-1)!.parameters.period).toEqual({ from: '2026-04-01', to: '2026-12-31' }))
  })

  it('steps the period with Page Up and Page Down: a year by a year', async () => {
    const bridge = await show()
    fireEvent.keyDown(await table(), { key: 'PageUp' })
    await waitFor(() => expect(runs(bridge).at(-1)!.parameters.period).toEqual({ from: '2026-01-01', to: '2026-12-31' }))
    fireEvent.keyDown(await table(), { key: 'PageDown' })
    fireEvent.keyDown(await table(), { key: 'PageDown' })
    await waitFor(() => expect(runs(bridge).at(-1)!.parameters.period).toEqual({ from: '2028-01-01', to: '2028-12-31' }))
  })

  it('runs over a sub-ledger, the everyday accounts in it, and sub-ledgers side by side, as chosen', async () => {
    const bridge = await show()
    await choose('Accounts', 'Personal')
    await waitFor(() => expect(runs(bridge).at(-1)!.parameters.scope).toEqual({ kind: 'subLedger', subLedgerId: 'personal' }))
    await userEvent.click(screen.getByRole('checkbox', { name: 'Everyday accounts only' }))
    await waitFor(() => expect(runs(bridge).at(-1)!.parameters.scope).toEqual({ kind: 'types', types: ['chequing', 'savings', 'creditCard', 'lineOfCredit'], subLedgerId: 'personal' }))
    await choose('Compare with', 'Sub-ledgers side by side')
    await waitFor(() => expect(runs(bridge).at(-1)!.parameters.compare).toBe('subLedgers'))
    await choose('Currency', 'USD')
    await waitFor(() => expect(runs(bridge).at(-1)!.parameters.currency).toBe('USD'))
  })

  it('folds a block by its toggle and by the keys, reports what is folded, and opens with what it is told is folded', async () => {
    const bridge = await show()
    await userEvent.click(screen.getByRole('button', { name: 'Collapse Expenses' }))
    expect(labels()).toEqual(['Income', 'Salary', 'Total income', 'Expenses', 'Total expenses', 'Net income'])
    expect(row('expense')).toHaveAttribute('aria-expanded', 'false')
    // The keys: to the Income heading, then ← folds it and → opens it again
    await userEvent.click(row('income').querySelector('th')!)
    await userEvent.keyboard('{ArrowLeft}')
    expect(labels()).toEqual(['Income', 'Total income', 'Expenses', 'Total expenses', 'Net income'])
    await userEvent.keyboard('{ArrowRight}')
    expect(labels()).toContain('Salary')
    await waitFor(() => expect(bridge.calls(REPORTS_CHANNELS.select).at(-1).view).toEqual({ show: 'both', collapsed: ['expense'] }))
    bridge.unmount()
    // Opened with rows folded (a saved report's, or the user's last): folded from the start
    await show({ [REPORTS_CHANNELS.open]: () => ({ ok: true, value: openedOf('incomeVsExpenses', { collapsed: ['expense'], show: 'table' }) }) })
    expect(labels()).toEqual(['Income', 'Salary', 'Total income', 'Expenses', 'Total expenses', 'Net income'])
    expect(screen.getByRole('button', { name: 'Table' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('shows the transactions behind a figure: double-click, Ctrl+Enter, or the context menu', async () => {
    const bridge = await show()
    await userEvent.dblClick(cell('rent', 2))
    const [first] = bridge.executed()
    expect(first.id).toBe(C.transactions)
    expect(first.args[0]).toMatchObject({
      ref: { definitionId: 'reports.incomeVsExpenses' }, row: { keys: ['rent'] }, column: { measure: 'amount', months: ['2026-03'] },
      currency: 'CAD', label: 'Housing', columnLabel: 'Mar 2026', figure: 450000
    })
    // Selected with a click, listed with Ctrl+Enter
    await userEvent.click(cell('net:0', 3))
    await userEvent.keyboard('{Control>}{Enter}{/Control}')
    expect(bridge.executed()[1].args[0]).toMatchObject({ row: { keys: ['income', 'expense'], signed: true }, column: { measure: 'amount' }, label: 'Net income', figure: 324015 })
    fireEvent.contextMenu(cell('groceries', 0))
    await userEvent.click(await screen.findByRole('menuitem', { name: /Show Transactions/ }))
    expect(bridge.executed()[2].args[0]).toMatchObject({ row: { keys: ['groceries'] }, column: { months: ['2026-01'] } })
    // A heading has nothing behind it
    fireEvent.contextMenu(row('income').querySelector('th')!)
    expect(await screen.findByRole('menuitem', { name: /Show Transactions/ })).toHaveAttribute('aria-disabled', 'true')
  })

  it('says when there is nothing to show, in the report’s own words', async () => {
    await show({ [REPORTS_CHANNELS.run]: () => ({ ok: true, value: incomeResult({}, []) }) }, 'light',
      () => screen.findByText('Nothing came in or went out of these accounts in this period.', {}, { timeout: 5000 }))
    expect(screen.queryByRole('treegrid')).not.toBeInTheDocument()
  })

  it('says why a run failed, with Try Again; never leaving old figures as if current', async () => {
    let fail = false
    const bridge = await show({
      [REPORTS_CHANNELS.run]: () => fail ? { ok: false, error: { code: 'TIMEOUT', message: 'The report took too long.' } } : { ok: true, value: incomeResult() }
    })
    fail = true
    await choose('Period', 'Last year')
    const problem = await screen.findByText(/The report took too long\./)
    expect(problem).toHaveTextContent(/Showing the figures from /)
    fail = false
    await userEvent.click(screen.getByRole('button', { name: 'Try Again' }))
    await waitFor(() => expect(document.querySelector('[data-problem]')).not.toBeInTheDocument())
    expect(runs(bridge).length).toBeGreaterThanOrEqual(3)
  })

  it('drops a slow reply overtaken by a newer one', async () => {
    const replies: ((value: unknown) => void)[] = []
    const bridge = await show({
      [REPORTS_CHANNELS.run]: () => replies.length === 0 ? Promise.resolve({ ok: true, value: incomeResult() }) : new Promise(resolve => replies.push(resolve))
    })
    replies.push(() => {})           // the first run was answered at once
    await choose('Period', 'Last year')
    await choose('Period', 'This quarter')
    await waitFor(() => expect(runs(bridge)).toHaveLength(3))
    const newer = incomeResult({ subtitle: 'This quarter' })
    const older = incomeResult({ subtitle: 'Last year' })
    await act(async () => { replies[2]({ ok: true, value: newer }) })
    await act(async () => { replies[1]({ ok: true, value: older }) })
    expect(document.querySelector('[data-subtitle]')).toHaveTextContent('This quarter')
  })

  it('runs again when its source’s figures may have changed, and not for another source’s', async () => {
    const bridge = await show()
    const before = runs(bridge).length
    act(() => bridge.emit(REPORTS_EVENTS.stale, { sources: ['budget.status'] }))
    await settle()
    expect(runs(bridge)).toHaveLength(before)
    act(() => bridge.emit(REPORTS_EVENTS.stale, { sources: ['reports.flows'] }))
    await waitFor(() => expect(runs(bridge)).toHaveLength(before + 1))
    act(() => bridge.emit(REPORTS_EVENTS.stale, { sources: null }))
    await waitFor(() => expect(runs(bridge)).toHaveLength(before + 2))
    await userEvent.keyboard('{F5}')
  })

  it('runs once, when shown again, however many changes came while hidden', async () => {
    const observers: { callback: IntersectionObserverCallback, element?: Element }[] = []
    vi.stubGlobal('IntersectionObserver', class {
      constructor(private readonly callback: IntersectionObserverCallback) { observers.push({ callback }) }
      observe(element: Element) { observers.find(o => o.callback === this.callback)!.element = element }
      disconnect() {}
    })
    try {
      const bridge = await show()
      const report = observers.find(o => (o.element as HTMLElement)?.dataset.reportsPage === 'report')!
      const visible = (on: boolean) => act(() => report.callback([{ isIntersecting: on } as IntersectionObserverEntry], {} as IntersectionObserver))
      visible(false)
      const before = runs(bridge).length
      for (let i = 0; i < 3; i++) act(() => bridge.emit(REPORTS_EVENTS.stale, { sources: ['reports.flows'] }))
      await settle()
      expect(runs(bridge)).toHaveLength(before)
      visible(true)
      await waitFor(() => expect(runs(bridge)).toHaveLength(before + 1))
      await settle()
      expect(runs(bridge)).toHaveLength(before + 1)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('shows the chart, the table or both, as chosen', async () => {
    await show(spendingShown, 'light', spendingTable)
    await userEvent.click(screen.getByRole('button', { name: 'Both' }))
    await screen.findByRole('treegrid', { name: /^Spending by Category/ })
    expect(await screen.findByRole('figure', {}, { timeout: 5000 })).toHaveAttribute('aria-label', expect.stringMatching(/^Spending by Category, donut chart: Housing 51\.1 %, Food 27\.4 %/))
    await userEvent.click(screen.getByRole('button', { name: 'Table' }))
    expect(document.querySelector('[data-chart-area]')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Chart' }))
    expect(screen.queryByRole('treegrid')).not.toBeInTheDocument()
    expect(screen.getByRole('figure')).toBeInTheDocument()
  })

  it('shows the notes under the figures, warnings as warnings', async () => {
    await show({
      [REPORTS_CHANNELS.run]: () => ({
        ok: true, value: incomeResult({ notes: [{ tone: 'info', text: 'Transfers between these sub-ledgers cancel out over the whole.' }, { tone: 'warning', text: 'Transactions archived before Apr 1, 2026 are left out.' }] })
      })
    })
    expect(screen.getByText('Transfers between these sub-ledgers cancel out over the whole.')).toHaveAttribute('data-note', 'info')
    expect(screen.getByText('Transactions archived before Apr 1, 2026 are left out.')).toHaveAttribute('data-note', 'warning')
  })

  it('takes the parameters a command showed it with, and those of a later request for the same report', async () => {
    const bridge = reportsBridge({
      [REPORTS_CHANNELS.catalog]: () => catalogOf({ shown: { ref: { definitionId: 'reports.incomeVsExpenses' }, parameters: { period: { preset: 'lastQuarter' } }, request: 4 } })
    })
    renderInTheme(<ReportView />)
    await table()
    expect(runs(bridge)[0].parameters.period).toEqual({ preset: 'lastQuarter' })
    act(() => bridge.emit(REPORTS_EVENTS.catalog, catalogOf({ shown: { ref: { definitionId: 'reports.incomeVsExpenses' }, parameters: { period: { preset: 'lastMonth' } }, request: 5 } })))
    await waitFor(() => expect(runs(bridge).at(-1)!.parameters.period).toEqual({ preset: 'lastMonth' }))
  })
})

describe('customising and saving (R4)', () => {
  it('shows the report as Customise Report… applied it: its options, and the table alone', async () => {
    const bridge = await show()
    act(() => bridge.emit(REPORTS_EVENTS.catalog, catalogOf({ shown: { ref: { definitionId: 'reports.incomeVsExpenses' }, options: { detail: 'all', '@top': '10' }, show: 'table', request: 2 } })))
    await waitFor(() => expect(runs(bridge).at(-1)!.options).toEqual({ detail: 'all', '@top': '10' }))
    expect(document.querySelector('[data-chart-area]')).not.toBeInTheDocument()
    await waitFor(() => expect(bridge.calls(REPORTS_CHANNELS.select).at(-1)).toMatchObject({ options: { detail: 'all', '@top': '10' }, view: { show: 'table' } }))
  })

  it('offers Customise and Save As for a report not saved; and, for a saved one, Save only once it has changed, Rename, Duplicate and Delete', async () => {
    const bridge = await show()
    await userEvent.click(screen.getByRole('button', { name: 'More actions' }))
    expect(screen.getAllByRole('menuitem').map(m => m.textContent)).toEqual(['Customise Report…', 'Save Report As…', 'Export Report…', 'Print Report…Ctrl+P', 'Save Report as PDF…'])
    await userEvent.click(screen.getByRole('menuitem', { name: 'Save Report As…' }))
    await waitFor(() => expect(bridge.executed()).toEqual([{ id: C.saveAs, args: [] }]))
    bridge.unmount()

    const savedShown = catalogOf({ shown: { ref: { savedId: 's1' }, request: 1 }, saved: [{ id: 's1', name: 'Mine', basis: 'Income vs Expenses', available: true }] })
    const saved = await show({
      [REPORTS_CHANNELS.catalog]: () => savedShown,
      [REPORTS_CHANNELS.open]: () => ({ ok: true, value: { ...openedOf('incomeVsExpenses'), ref: { savedId: 's1' }, title: 'Mine' } })
    }, 'light', () => screen.findByRole('treegrid', { name: /^Mine, / }, { timeout: 5000 }))
    await userEvent.click(screen.getByRole('button', { name: 'More actions' }))
    expect(screen.getAllByRole('menuitem').map(m => m.textContent)).toEqual(['Customise Report…', 'Save Report', 'Save Report As…', 'Rename…', 'Duplicate…', 'Delete…', 'Export Report…', 'Print Report…Ctrl+P', 'Save Report as PDF…'])
    expect(screen.getByRole('menuitem', { name: 'Save Report' })).toHaveAttribute('aria-disabled', 'true')
    await userEvent.keyboard('{Escape}')
    act(() => saved.emit(REPORTS_EVENTS.catalog, { ...savedShown, changed: true }))
    await userEvent.click(screen.getByRole('button', { name: 'More actions' }))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Save Report' }))
    await waitFor(() => expect(saved.executed()).toEqual([{ id: C.save, args: [] }]))
  })

  it('runs a command only once the view has said what it shows, so it acts on what the user sees', async () => {
    let answer: (value: unknown) => void = () => {}
    const bridge = await show()
    bridge.bridge.invoke.mockImplementation(async (channel: string, data?: any) => {
      if (channel === REPORTS_CHANNELS.select) return new Promise(resolve => { answer = resolve })
      if (channel === REPORTS_CHANNELS.run) return { ok: true, value: incomeResult() }
      if (channel === 'shell:commands.execute') return undefined
      throw new Error(`No answer for ${channel}: ${JSON.stringify(data)}`)
    })
    await choose('Period', 'Last year')
    await userEvent.click(screen.getByRole('button', { name: 'Customise…' }))
    expect(bridge.executed()).toEqual([])
    await act(async () => { answer(undefined) })
    await waitFor(() => expect(bridge.executed()).toEqual([{ id: C.customise, args: [] }]))
  })

  it('offers nothing that writes in a ledger open read-only', async () => {
    await show({ [REPORTS_CHANNELS.catalog]: () => catalogOf({ readOnly: true }) })
    expect(screen.getByRole('button', { name: 'Save As…' })).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: 'More actions' }))
    expect(screen.getByRole('menuitem', { name: 'Save Report As…' })).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByRole('menuitem', { name: 'Customise Report…' })).not.toHaveAttribute('aria-disabled')
  })
})

describe('with no report to show', () => {
  it('asks for a ledger when none is open', async () => {
    reportsBridge({ [REPORTS_CHANNELS.catalog]: () => null })
    renderInTheme(<ReportView />)
    expect(await screen.findByText('Open a ledger to see its reports.')).toBeInTheDocument()
  })

  it('offers the reports when none is chosen yet, and shows one through the command', async () => {
    const bridge = reportsBridge({ [REPORTS_CHANNELS.catalog]: () => catalogOf({ shown: null }) })
    renderInTheme(<ReportView />)
    const page = await screen.findByText('Choose a report, here or in the Reports tab.')
    expect(page).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Net Worth' }))
    expect(bridge.executed()).toEqual([{ id: C.show, args: [{ definitionId: 'reports.netWorth' }] }])
  })

  it('says why a report can’t be opened, with Try Again', async () => {
    let fail = true
    reportsBridge({
      [REPORTS_CHANNELS.open]: () => fail ? { ok: false, error: { code: 'NO_SOURCE', message: 'That report can’t run now.' } } : { ok: true, value: openedOf('incomeVsExpenses') }
    })
    renderInTheme(<ReportView />)
    expect(await screen.findByText('That report can’t run now.')).toBeInTheDocument()
    fail = false
    await userEvent.click(screen.getByRole('button', { name: 'Try Again' }))
    expect(await table()).toBeInTheDocument()
  })
})

describe('a report with its result', () => {
  it('shows shares to one decimal, rounded down, as the engine gives them: of everything, Uncategorised included', async () => {
    await show(spendingShown, 'light', spendingTable)
    // Chart, table or both is remembered per report while the app runs: an earlier test may have left it on the chart
    await userEvent.click(screen.getByRole('button', { name: 'Both' }))
    const grid = await screen.findByRole('treegrid', { name: /^Spending by Category/ })
    const housing = within(grid).getByText('Housing').closest('tr')!
    expect(within(housing).getAllByRole('cell').map(c => c.textContent)).toEqual(['18,420.00', '51.1 %'])
    const result: ReportResult = spendingResult()
    expect(result.rows.find(r => r.label === 'Housing')!.values[1]).toBe(5118)
  })
})

describe('printing (R6)', () => {
  it('draws the report in its print layout when asked, tells the plugin it is ready, and keeps it until printed', async () => {
    let printed: (value: unknown) => void = () => {}
    const bridge = await show({ [REPORTS_CHANNELS.printReady]: () => new Promise(resolve => { printed = resolve }) })
    act(() => bridge.emit(REPORTS_EVENTS.print, { request: 3, output: 'print' }))
    await waitFor(() => expect(document.querySelector('[data-printing]')).toHaveTextContent('Printing the report…'))
    await waitFor(() => expect(bridge.calls(REPORTS_CHANNELS.printReady)).toEqual([{ request: 3, landscape: false }]), { timeout: 10_000 })
    const area = document.querySelector('[data-print-area]')!
    expect(area.querySelector('h1')).toHaveTextContent('Income vs Expenses')
    expect([...area.querySelectorAll('[data-print-row]')].map(r => r.querySelector('th')!.textContent)).toEqual(labels())
    expect(area.querySelector('[data-printed]')).toHaveTextContent(/^Home · Printed /)
    // The figures run again while the print dialog is open: what is being printed stays as it was drawn
    const before = runs(bridge).length
    act(() => bridge.emit(REPORTS_EVENTS.stale, { sources: null }))
    await waitFor(() => expect(runs(bridge).length).toBeGreaterThan(before))
    await settle()
    expect(document.querySelector('[data-print-area]')).toBe(area)
    expect(area.querySelectorAll('[data-print-row]')).toHaveLength(labels().length)
    // Printed: the layout and the status go
    await act(async () => { printed({ ok: true, value: true }) })
    await waitFor(() => expect(document.querySelector('[data-print-area]')).toBeNull())
    expect(document.querySelector('[data-printing]')).toBeNull()
  })

  it('prints the rows as folded, and says Saving as PDF for a PDF', async () => {
    const bridge = await show({ [REPORTS_CHANNELS.printReady]: () => ({ ok: true, value: true }) })
    await userEvent.click(screen.getByRole('button', { name: 'Collapse Expenses' }))
    act(() => bridge.emit(REPORTS_EVENTS.print, { request: 4, output: 'pdf' }))
    await waitFor(() => expect(document.querySelector('[data-printing]')).toHaveTextContent('Saving the report as PDF…'))
    await waitFor(() => expect(bridge.calls(REPORTS_CHANNELS.printReady)).toHaveLength(1), { timeout: 10_000 })
    await waitFor(() => expect(document.querySelector('[data-print-area]')).toBeNull())
    expect(labels()).toEqual(['Income', 'Salary', 'Total income', 'Expenses', 'Total expenses', 'Net income'])
  })

  it('says why it can\'t print, when the report couldn\'t be worked out', async () => {
    const bridge = await show({
      [REPORTS_CHANNELS.run]: () => ({ ok: false, error: { code: 'TIMEOUT', message: 'The report took too long.' } }),
      [REPORTS_CHANNELS.printReady]: () => ({ ok: true, value: false })
    }, 'light', () => screen.findByText(/The report took too long\./))
    act(() => bridge.emit(REPORTS_EVENTS.print, { request: 5, output: 'print' }))
    await waitFor(() => expect(bridge.calls(REPORTS_CHANNELS.printReady)).toEqual([{ request: 5, problem: 'The report took too long.' }]))
    expect(document.querySelector('[data-print-area]')).toBeNull()
  })

  it('offers Export Report…, Print Report… and Save Report as PDF… in its ⋯ menu', async () => {
    const bridge = await show()
    for (const [item, command] of [['Export Report…', C.exportCsv], ['Print Report…', C.print], ['Save Report as PDF…', C.savePdf]] as const) {
      await userEvent.click(screen.getByRole('button', { name: 'More actions' }))
      await userEvent.click(screen.getByRole('menuitem', { name: new RegExp(`^${item}`) }))
      await waitFor(() => expect(bridge.executed().at(-1)).toEqual({ id: command, args: [] }))
    }
  })
})
