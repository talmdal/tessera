// @vitest-environment node
// The reports as another plugin uses them (docs/plugin-creation.md, "Using reports from another plugin"): opening a
// report in the view with parameters, running one through reports.service, reading saved reports, and the Reports
// page's settings, to read. Through a plugin context of its own, as the guide's example.
import { describe, expect, it } from 'vitest'
import {
  FLOWS_SOURCE, REPORT_DEFINITIONS_POINT, REPORT_GROUPS, REPORTS_CHANNELS, REPORTS_COMMANDS, REPORTS_SERVICE, REPORTS_SETTINGS_ID, isReportsError,
  type ReportDefinitionContribution, type ReportsCatalog, type ReportsService, type ReportsSettings
} from '@tessera/reports-api'
import { createPluginContext } from '../../../core/plugins/PluginContext'
import { household } from './examples'
import { setupApp } from './app'

describe('reports, from another plugin', () => {
  it('opens a report in the view, runs one, reads saved reports and the Reports page, as the guide shows', async () => {
    const app = await setupApp()
    await app.open()
    await household(app.env)
    const context = createPluginContext('budget', app.runtime, { requires: [REPORTS_SERVICE] }).context

    await context.commands.execute(REPORTS_COMMANDS.show, { definitionId: 'reports.spendingByCategory', parameters: { period: { preset: 'lastMonth' } } })
    const catalog: ReportsCatalog = await app.ask(REPORTS_CHANNELS.catalog)
    expect(catalog.shown).toMatchObject({ ref: { definitionId: 'reports.spendingByCategory' }, parameters: { period: { preset: 'lastMonth' } } })

    const reports = context.services.get<ReportsService>(REPORTS_SERVICE)
    const result = await reports.run({ definitionId: 'reports.netWorth' })
    expect(result.rows.at(-1)).toMatchObject({ kind: 'total', label: 'Net worth' })
    expect(await reports.saved()).toEqual([])
    const failure = await reports.saveReport({ name: '', basis: { kind: 'definition', definitionId: 'reports.netWorth' }, parameters: {} }).catch(err => err)
    expect(isReportsError(failure) && failure.field).toBe('name')

    const settings = context.settings.read<ReportsSettings>(REPORTS_SETTINGS_ID)
    expect(settings.get()?.topRows).toBe(25)
    await app.runtime.settings.commit([{ id: REPORTS_SETTINGS_ID, value: { ...settings.get(), topRows: 40 } }])
    expect(settings.get()?.topRows).toBe(40)
  })

  it('takes a report another plugin adds on the flows source, as the guide’s first example (Adding a report)', async () => {
    const app = await setupApp()
    await app.open()
    await household(app.env)
    const context = createPluginContext('card-tools', app.runtime).context
    const BY_ACCOUNT: ReportDefinitionContribution = {
      id: 'card-tools.spendingByAccount', label: 'Spending by Account', description: 'Which card or account the spending went through.',
      group: REPORT_GROUPS.spending, version: 1,
      spec: {
        specVersion: 1, source: FLOWS_SOURCE,
        parameters: { period: { preset: 'thisYear' }, scope: { kind: 'ledger' }, currency: 'mostUsed' },
        query: {
          filters: [{ dimension: 'group', in: ['expense'] }], rows: { dimension: 'account', sort: 'valueDesc' },
          measures: [{ measure: 'amount', label: 'Spending' }, { measure: 'count', label: 'Transactions' }]
        },
        presentation: { show: 'both', table: { totals: { row: true } }, chart: { kind: 'bar', measure: 0, horizontal: true } }
      }
    }
    context.subscriptions.push(context.extensions.contribute('card-tools', REPORT_DEFINITIONS_POINT, BY_ACCOUNT.id, BY_ACCOUNT))
    expect(app.log.warn).not.toHaveBeenCalled()
    const reports = app.runtime.services.get<ReportsService>(REPORTS_SERVICE)
    expect(reports.definitions().find(d => d.id === BY_ACCOUNT.id)).toMatchObject({ contributor: 'card-tools', available: true, group: { label: 'Income and Spending' } })
    const result = await reports.run({ definitionId: BY_ACCOUNT.id }, { period: { from: '2026-01-01', to: '2026-12-31' } })
    expect(result.rows.map(r => r.label)).toEqual(['Visa', 'Chequing', 'Total'])
    expect(result.rows.at(-1)!.values[0]).toBe(4074790)
  })
})
