// @vitest-environment node
// The reports plugin activated as the app runs it, after the ledger and accounts plugins, on the memory engine: what it
// provides (exactly the ReportsService contract, the migrator and its two sources), what it contributes (its schema,
// sources, groups and seven definitions, through the public points), and a report run once a ledger is open.
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { KitStorageEngine, memoryDriver } from '@tessera/storage-kit'
import { SHELL_FILES_SERVICE, SHELL_PROMPTS_SERVICE } from '@tessera/types'
import { LEDGER_COMMANDS, LEDGER_SCHEMA_POINT } from '@tessera/ledger-api'
import {
  BALANCES_SOURCE, FLOWS_SOURCE, REPORT_DEFINITIONS_POINT, REPORT_GROUPS_POINT, REPORT_SOURCES_POINT, REPORTS_MIGRATOR_SERVICE,
  REPORTS_SERVICE, type ReportsService
} from '@tessera/reports-api'
import { createPluginContext, createPluginRuntime } from '../../../core/plugins/PluginContext'
import { activate as activateAccounts } from '../../../plugins/accounts/src/privileged/index'
import { activate as activateLedger } from '../../../plugins/ledger/src/privileged/index'
import { activate as activateReports } from '../../../plugins/reports/src/privileged/index'
import { fakeFiles, fakePrompts, file, logger, memoryAppState, memoryDisk } from '../ledger/harness'

async function setup() {
  const log = logger()
  const runtime = createPluginRuntime(undefined, log)
  const driver = memoryDriver()
  const engine = new KitStorageEngine(driver)
  const disk = memoryDisk(driver)
  const { files } = fakeFiles(driver, disk)
  const { prompts } = fakePrompts()
  runtime.services.provide('storage-memory', 'storage.engine', engine)
  runtime.services.provide('app-state', 'app.state', memoryAppState())
  runtime.services.provide('shell', SHELL_FILES_SERVICE, files)
  runtime.services.provide('shell', SHELL_PROMPTS_SERVICE, prompts)
  await activateLedger(createPluginContext('ledger', runtime).context, { disk: disk.disk })
  await activateAccounts(createPluginContext('accounts', runtime).context)
  const context = createPluginContext('reports', runtime).context
  await activateReports({ ...context, logger: log }, { today: () => '2027-01-15', now: () => '2027-01-15T17:00:00.000Z' })
  const open = async () => {
    files.showSaveDialog.mockResolvedValueOnce(file('Home.tessera'))
    await runtime.commands.execute(LEDGER_COMMANDS.new)
  }
  return { runtime, log, context, open, reports: runtime.services.get<ReportsService>(REPORTS_SERVICE) }
}

describe('the reports plugin', () => {
  it('needs the accounts, the ledger, the shell\'s prompts, files and printing, and app state, and provides its service, migrator and two sources', () => {
    const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../plugins/reports/manifest.json'), 'utf8'))
    expect(manifest.services).toEqual({
      requires: ['accounts.service', 'ledger.session', 'shell.prompts', 'shell.files', 'shell.print', 'app.state'],
      provides: [REPORTS_SERVICE, REPORTS_MIGRATOR_SERVICE, FLOWS_SOURCE, BALANCES_SOURCE]
    })
  })

  it('provides exactly the ReportsService contract, not the implementation', async () => {
    const { reports, runtime } = await setup()
    expect(Object.keys(reports).sort()).toEqual([
      'definitions', 'deleteReport', 'duplicateReport', 'groups', 'onDidChange', 'open', 'run', 'runSpec', 'saveReport', 'saved', 'updateReport'
    ])
    for (const service of [REPORTS_MIGRATOR_SERVICE, FLOWS_SOURCE, BALANCES_SOURCE]) expect(runtime.services.providerOf(service)).toBe('reports')
  })

  it('contributes its schema, sources, groups and definitions through the public points, with no warning', async () => {
    const { runtime, log, reports } = await setup()
    const ids = (point: string) => runtime.extensions.getContributions(point).filter(c => c.contributor === 'reports').map(c => c.id)
    expect(ids(LEDGER_SCHEMA_POINT)).toEqual(['reports'])
    expect(ids(REPORT_SOURCES_POINT)).toEqual([FLOWS_SOURCE, BALANCES_SOURCE])
    expect(ids(REPORT_GROUPS_POINT)).toEqual(['reports.group.spending', 'reports.group.balances'])
    expect(ids(REPORT_DEFINITIONS_POINT)).toHaveLength(7)
    expect(reports.definitions().every(d => d.available)).toBe(true)
    expect(reports.groups().map(g => g.label)).toEqual(['Income and Spending', 'Net Worth and Balances'])
    expect(log.warn).not.toHaveBeenCalled()
  })

  it('runs a report once a ledger is open, and saves one in it', async () => {
    const { reports, open } = await setup()
    await expect(reports.run({ definitionId: 'reports.netWorth' })).rejects.toMatchObject({ code: 'NO_LEDGER' })
    await open()
    const result = await reports.run({ definitionId: 'reports.netWorth' })
    expect(result).toMatchObject({ title: 'Net Worth', currency: 'CAD', rows: [{ kind: 'total', label: 'Net worth' }] })
    const saved = await reports.saveReport({ name: 'Mine', basis: { kind: 'definition', definitionId: 'reports.netWorth' }, parameters: {} })
    expect((await reports.saved()).map(s => s.id)).toEqual([saved.id])
  })

  it('says the figures of every source changed when the ledger\'s year start does', async () => {
    const { reports, open, runtime } = await setup()
    await open()
    const changes: unknown[] = []
    reports.onDidChange(c => changes.push(c))
    await runtime.services.get<{ setYearStart(y: { month: number, day: number }): Promise<unknown> }>('ledger.session').setYearStart({ month: 4, day: 6 })
    expect(changes).toContainEqual({ catalog: false, figures: true })
    expect((await reports.run({ definitionId: 'reports.incomeVsExpenses' })).period).toEqual({ from: '2026-04-06', to: '2027-04-05' })
  })
})
