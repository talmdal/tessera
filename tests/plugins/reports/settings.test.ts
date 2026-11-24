// @vitest-environment node
// The Reports page (Tools › Options… › Reports, phase R4): its two fields, their defaults and ranges, with the page's
// words for a value out of range; *Rows before "Other"* followed at once (the report shown runs again with it) where a
// report takes its top from the user, never over a report's own *Show the top*; *Open reports on* for the next report
// opened, never over the user's last choice for a report, nor a report's own choice of the table.
import { describe, expect, it } from 'vitest'
import {
  REPORTS_CHANNELS, REPORTS_COMMANDS as C, REPORTS_EVENTS, REPORTS_SETTINGS_DEFAULTS, REPORTS_SETTINGS_ID, REPORTS_SETTINGS_PAGE,
  type OpenedView, type ReportResult, type ReportsSettings
} from '@tessera/reports-api'
import { REPORTS_SETTINGS } from '../../../plugins/reports/src/privileged/settings'
import { household } from './examples'
import { setupApp, type App } from './app'

const YEAR = { period: { from: '2026-01-01', to: '2026-12-31' } }
const change = (app: App, patch: Partial<ReportsSettings>) =>
  app.runtime.settings.commit([{ id: REPORTS_SETTINGS_ID, value: { ...app.runtime.settings.snapshot(REPORTS_SETTINGS_ID)!.value, ...patch } }])
const payees = async (app: App, options: object = {}) => {
  const result: ReportResult = (await app.ask(REPORTS_CHANNELS.run, { ref: { definitionId: 'reports.spendingByPayee' }, parameters: YEAR, options })).value
  return result.rows.filter(r => r.kind === 'member').length
}
const opened = async (app: App, id: string): Promise<OpenedView> => (await app.ask(REPORTS_CHANNELS.open, { ref: { definitionId: `reports.${id}` } })).value

describe('the Reports page', () => {
  it('is a page the shell draws, with its two settings at their defaults', async () => {
    const app = await setupApp()
    const page = app.runtime.settings.pages().find(p => p.id === REPORTS_SETTINGS_PAGE)!
    expect(page).toMatchObject({ title: 'Reports', settings: REPORTS_SETTINGS_ID })
    expect(page.fields!.map(f => [f.key, f.kind])).toEqual([['openOn', 'choice'], ['topRows', 'number']])
    expect(page.fields![0]).toMatchObject({ label: 'Open reports on', description: 'A report you have opened before opens as you left it.' })
    expect(page.fields![0].kind === 'choice' && page.fields![0].options).toEqual([{ value: 'both', label: 'Chart and table' }, { value: 'table', label: 'Table only' }])
    expect(page.fields![1]).toMatchObject({ label: 'Rows before “Other”', min: 5, max: 500, integer: true })
    expect(app.runtime.settings.snapshot(REPORTS_SETTINGS_ID)?.value).toEqual(REPORTS_SETTINGS_DEFAULTS)
    expect(app.log.warn.mock.calls.filter(c => String(c[0]).includes('[settings]'))).toEqual([])
  })

  it('takes only values within their ranges, saying so in the page’s words', async () => {
    const app = await setupApp()
    const refused = async (patch: Partial<ReportsSettings>) => {
      const result = await change(app, patch)
      return result.ok ? [] : result.errors[REPORTS_SETTINGS_ID]
    }
    expect(await refused({ topRows: 4 })).toContain('Show 5 to 500 rows before Other.')
    expect(await refused({ topRows: 501 })).toContain('Show 5 to 500 rows before Other.')
    expect(await refused({ topRows: 12.5 })).toContain('Show 5 to 500 rows before Other.')
    expect(REPORTS_SETTINGS.validate!({ ...REPORTS_SETTINGS_DEFAULTS, openOn: 'chart' as never })).toEqual(['Open reports on the chart and table, or the table only.'])
    expect(await refused({ topRows: 5, openOn: 'table' })).toEqual([])
  })
})

describe('Rows before “Other”', () => {
  it('is the top of a report that takes it from the user, followed at once: the report shown runs again', async () => {
    const app = await setupApp()
    await app.open()
    await household(app.env)
    await app.idle()
    expect(await payees(app)).toBe(25)
    app.events.length = 0
    await change(app, { topRows: 8 })
    await app.idle()
    expect(app.named(REPORTS_EVENTS.stale).map(e => e.data)).toEqual([{ sources: null }])
    expect(await payees(app)).toBe(8)
  })

  it('never overrides a report’s own Show the top, nor a report that keeps a top of its own', async () => {
    const app = await setupApp()
    await app.open()
    await household(app.env)
    await change(app, { topRows: 8 })
    expect(await payees(app, { '@top': '3' })).toBe(3)
    expect(await payees(app, { '@top': 'all' })).toBe(148)
    // Category Trends keeps its six lines, whatever the page says
    const trends: ReportResult = (await app.ask(REPORTS_CHANNELS.run, { ref: { definitionId: 'reports.categoryTrends' }, parameters: YEAR })).value
    expect(trends.rows.filter(r => r.kind === 'member')).toHaveLength(6)
  })
})

describe('Open reports on', () => {
  it('opens a report on its table alone, where it would show both, from the next one opened', async () => {
    const app = await setupApp()
    await app.open()
    expect((await opened(app, 'incomeVsExpenses')).show).toBe('both')
    await change(app, { openOn: 'table' })
    expect((await opened(app, 'incomeVsExpenses')).show).toBe('table')
    // A report that opens on its table does so either way
    expect((await opened(app, 'accountBalances')).show).toBe('table')
  })

  it('never over the user’s last choice for a report', async () => {
    const app = await setupApp()
    await app.open()
    const ref = { definitionId: 'reports.netWorth' }
    await app.run(C.show, ref)
    await app.ask(REPORTS_CHANNELS.select, { ref, parameters: {}, options: {}, view: { show: 'both', collapsed: [] } })
    await change(app, { openOn: 'table' })
    expect((await opened(app, 'netWorth')).show).toBe('both')
    expect((await opened(app, 'cashFlow')).show).toBe('table')
  })
})
