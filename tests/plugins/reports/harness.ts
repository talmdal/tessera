// The reports service on a real ledger session and accounts service (memory engine), with the reports plugin's schema,
// sources, groups and definitions contributed through the extension points, as the plugin does. And the ledgers the
// tests report on, among them the household of docs/reporting-design.md's worked examples.
import type { AccountInput, Category } from '@tessera/accounts-api'
import { LEDGER_BACKUP_META, LEDGER_SCHEMA_POINT } from '@tessera/ledger-api'
import type { Disposable } from '@tessera/types'
import {
  BALANCES_SOURCE, FLOWS_SOURCE, REPORT_DEFINITIONS_POINT, REPORT_GROUPS_POINT, REPORT_SOURCES_POINT, REPORTS_MIGRATOR_SERVICE,
  type ReportParameters, type ReportResult, type ReportsChange, type ResultRow
} from '@tessera/reports-api'
import { BALANCES_CONTRIBUTION } from '../../../plugins/reports/src/privileged/balances'
import { BalancesSource } from '../../../plugins/reports/src/privileged/BalancesSource'
import { DEFINITIONS, GROUPS } from '../../../plugins/reports/src/privileged/definitions'
import { FLOWS_CONTRIBUTION } from '../../../plugins/reports/src/privileged/flows'
import { FlowsSource } from '../../../plugins/reports/src/privileged/FlowsSource'
import { ReportsServiceImpl } from '../../../plugins/reports/src/privileged/ReportsServiceImpl'
import { REPORTS_SCHEMA, reportsMigrator } from '../../../plugins/reports/src/privileged/schema'
import { setupAccounts } from '../accounts/harness'
import { file, logger } from '../ledger/harness'

export const TODAY = '2027-01-15'
export const NOW = () => new Date(2027, 0, 15, 12)

export interface ReportsSetup {
  /** Default true: a ledger is created and open. */
  open?: boolean
  today?: () => string
  /** Default true: the reports plugin's own sources, groups and definitions are contributed. */
  contribute?: boolean
  timeoutMs?: number
}

export async function setupReports(options: ReportsSetup = {}) {
  const env = await setupAccounts({ open: false, now: NOW })
  env.extensions.contribute('reports', LEDGER_SCHEMA_POINT, 'reports', REPORTS_SCHEMA)
  env.services.provide('reports', REPORTS_MIGRATOR_SERVICE, reportsMigrator)
  const log = logger()
  const today = options.today ?? (() => TODAY)
  const deps = { session: env.session, accounts: env.service, log, today }
  const flows = new FlowsSource(deps)
  const balances = new BalancesSource(deps)
  const reports = new ReportsServiceImpl({
    session: env.session, accounts: env.service, extensions: env.extensions, services: env.services, log, today,
    now: () => '2027-01-15T17:00:00.000Z', ...(options.timeoutMs !== undefined && { timeoutMs: options.timeoutMs })
  })
  env.session.participate('reports', reports.subLedgerParticipant)
  /** The plugin's own contributions, by id, to withdraw one as a plugin update would. */
  const contributions = new Map<string, Disposable>()
  if (options.contribute !== false) {
    env.services.provide('reports', FLOWS_SOURCE, flows)
    env.services.provide('reports', BALANCES_SOURCE, balances)
    contributions.set(FLOWS_CONTRIBUTION.id, env.extensions.contribute('reports', REPORT_SOURCES_POINT, FLOWS_CONTRIBUTION.id, FLOWS_CONTRIBUTION))
    contributions.set(BALANCES_CONTRIBUTION.id, env.extensions.contribute('reports', REPORT_SOURCES_POINT, BALANCES_CONTRIBUTION.id, BALANCES_CONTRIBUTION))
    for (const group of GROUPS) contributions.set(group.id, env.extensions.contribute('reports', REPORT_GROUPS_POINT, group.id, group))
    for (const definition of DEFINITIONS) contributions.set(definition.id, env.extensions.contribute('reports', REPORT_DEFINITIONS_POINT, definition.id, definition))
  }
  const changes: ReportsChange[] = []
  reports.onDidChange(c => changes.push(c))
  if (options.open !== false) await env.created()
  changes.length = 0
  const archive = (before: string) => env.session.runArchive({
    before, copy: { path: file(`Tessera Backups/Archives/Home (archive before ${before}).tesserabkp`), takenAt: NOW().toISOString() }
  })
  /** An archive file of the open ledger, as File › Archive Ledger… makes it (a snapshot with its meta), to open read-only. */
  const archiveFile = async () => {
    const ledger = env.session.current!
    const at = file('Tessera Backups/Archives/Home (archive before 2026-01-01).tesserabkp')
    const db = await env.engine.open({ path: ledger.path })
    await db.snapshot({ path: at }, {
      meta: {
        [LEDGER_BACKUP_META.takenAt]: NOW().toISOString(), [LEDGER_BACKUP_META.kind]: 'archive', [LEDGER_BACKUP_META.ledgerName]: ledger.name,
        [LEDGER_BACKUP_META.ledgerPath]: ledger.path, [LEDGER_BACKUP_META.takenWith]: 'ledger test', [LEDGER_BACKUP_META.archiveBefore]: '2026-01-01'
      }
    })
    return at
  }
  return { ...env, accounts: env.service, reports, flows, balances, log, changes, archive, archiveFile, contributions }
}

export type ReportsEnv = Awaited<ReturnType<typeof setupReports>>

export const account = (name: string, subLedgerId: string | null, over: Partial<AccountInput> = {}): AccountInput =>
  ({ name, type: 'chequing', subLedgerId, currency: 'CAD', openingDate: '2025-12-01', openingBalance: 0, ...over })

/** A category by name, created (as `kind`) when the ledger hasn't one. "Parent : Child" for a child. */
export async function category(env: ReportsEnv, path: string, kind: Category['kind'] = 'expense'): Promise<string> {
  return (await env.accounts.categories.create(path, kind)).id
}

// ---- Reading results, as the design's examples are written

const money = (v: number | null) => v === null ? '—' : (v / 100).toFixed(2)
/** Basis points as the view shows them: one decimal, rounded down, as the budget's percentages are. */
const percent = (v: number | null) => v === null ? '—' : `${(Math.floor(v / 10) / 10).toFixed(1)} %`

/** A result's rows as `[label, ...figures]`, figures as the examples write them ("4,212.40" without the comma: "4212.40"). */
export function table(result: ReportResult, options: { kinds?: ResultRow['kind'][] } = {}): (string)[][] {
  return result.rows
    .filter(r => !options.kinds || options.kinds.includes(r.kind))
    .map(r => [`${'  '.repeat(r.depth - 1)}${r.label}`, ...r.values.map((v, i) => result.columns[i].unit === 'percent' ? percent(v) : result.columns[i].unit === 'count' ? (v === null ? '—' : String(v)) : money(v))])
}

/** The column headings. */
export const headings = (result: ReportResult) => result.columns.map(c => c.group ? `${c.group} ${c.label}` : c.label)

/** A run of a shipped definition. */
export const run = (env: ReportsEnv, id: string, parameters?: ReportParameters, options?: Record<string, string | boolean>) =>
  env.reports.run({ definitionId: `reports.${id}` }, parameters, options)

/** Minor units from "4,212.40". */
export const cents = (text: string) => Math.round(Number(text.replace(/,/g, '')) * 100)
