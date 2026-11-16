// The plugin API packages are contracts other plugins build against. These tests hold them to the framework's naming
// rules (commands and context keys prefixed by the plugin id, channels named `<pluginId>:<event>`), and check the
// tables that must cover every case.
import { describe, expect, it } from 'vitest'
import * as ledger from '@tessera/ledger-api'
import * as accounts from '@tessera/accounts-api'
import * as imports from '@tessera/import-api'
import * as exports from '@tessera/export-api'
import * as budget from '@tessera/budget-api'
import { parseManifest, SERVICE_ID_PATTERN } from '../../shared/plugins/manifest'
import { parseWhen } from '../../shared/context/when'

const values = (table: object) => Object.values(table).filter((v): v is string => typeof v === 'string')

function namedAfter(pluginId: string, api: { commands: object, keys: object, channels: object, events: object, views: object, dialogs: object }) {
  for (const id of [...values(api.commands), ...values(api.keys), ...values(api.views), ...values(api.dialogs)]) {
    expect(id.startsWith(`${pluginId}.`), id).toBe(true)
  }
  for (const name of [...values(api.channels), ...values(api.events)]) {
    expect(name.startsWith(`${pluginId}:`), name).toBe(true)
    expect(name.indexOf(':'), name).toBe(name.lastIndexOf(':'))
  }
  // A request channel and a push event never share a name, so a view can't confuse them
  const channels = new Set(values(api.channels))
  expect(values(api.events).filter(name => channels.has(name))).toEqual([])
  // Context keys must be usable in enablement expressions
  for (const key of values(api.keys)) expect(() => parseWhen(key)).not.toThrow()
}

describe('@tessera/ledger-api', () => {
  it('names everything after the ledger plugin, which is a valid plugin id', () => {
    expect(() => parseManifest({ id: ledger.LEDGER_PLUGIN_ID, name: 'x', version: '1', privileged: { entry: 'x' } })).not.toThrow()
    namedAfter(ledger.LEDGER_PLUGIN_ID, {
      commands: ledger.LEDGER_COMMANDS, keys: ledger.LEDGER_CONTEXT_KEYS, channels: ledger.LEDGER_CHANNELS,
      events: ledger.LEDGER_EVENTS, views: ledger.LEDGER_VIEWS, dialogs: ledger.LEDGER_DIALOGS
    })
    expect(ledger.LEDGER_SESSION_SERVICE).toMatch(SERVICE_ID_PATTERN)
  })

  it('keeps its own collection and meta keys in its namespace', () => {
    for (const name of Object.values(ledger.LEDGER_COLLECTIONS)) expect(name.startsWith('ledger.'), name).toBe(true)
    expect(ledger.LEDGER_META.schemaVersion('accounts')).toBe('ledger.schema.accounts')
    expect(ledger.LEDGER_META.format.startsWith('ledger.')).toBe(true)
  })

  it('describes the .tessera file for open and save dialogs', () => {
    expect(ledger.LEDGER_FILE_EXTENSION).toBe('.tessera')
    expect(ledger.LEDGER_FILE_FILTER).toEqual({ name: 'Tessera ledger', extensions: ['tessera'] })
  })

  it('builds results with ok and fail', () => {
    expect(ledger.ok(3)).toEqual({ ok: true, value: 3 })
    expect(ledger.fail('DUPLICATE_NAME', 'Taken', 'name')).toEqual({ ok: false, error: { code: 'DUPLICATE_NAME', message: 'Taken', field: 'name' } })
    expect(ledger.fail('NO_LEDGER', 'No ledger')).toEqual({ ok: false, error: { code: 'NO_LEDGER', message: 'No ledger' } })
  })
})

describe('@tessera/accounts-api', () => {
  it('names everything after the accounts plugin', () => {
    namedAfter(accounts.ACCOUNTS_PLUGIN_ID, {
      commands: accounts.ACCOUNTS_COMMANDS, keys: accounts.ACCOUNTS_CONTEXT_KEYS, channels: accounts.ACCOUNTS_CHANNELS,
      events: accounts.ACCOUNTS_EVENTS, views: accounts.ACCOUNTS_VIEWS, dialogs: accounts.ACCOUNTS_DIALOGS
    })
    for (const id of [accounts.ACCOUNTS_SERVICE, accounts.ACCOUNTS_MIGRATOR_SERVICE]) expect(id).toMatch(SERVICE_ID_PATTERN)
    for (const name of Object.values(accounts.ACCOUNTS_COLLECTIONS)) expect(name.startsWith('accounts.')).toBe(true)
    expect(accounts.RECONCILE_ACTIONS_POINT.startsWith('accounts.')).toBe(true)
    // Archive options are contribution ids, named after the plugin
    for (const id of Object.values(accounts.ACCOUNTS_ARCHIVE_OPTIONS)) expect(id.startsWith('accounts.'), id).toBe(true)
  })

  it('is at 1.14, with transaction totals for reports and budgets, the totals an archive removed, and the usual currency', () => {
    expect(accounts.ACCOUNTS_API_VERSION).toBe('1.14.0')
    // 1.14: the rule a new account, a statement with no currency and a new budget start from, shared
    expect(accounts.mostUsedCurrency([{ currency: 'USD' }, { currency: 'CAD' }, { currency: 'USD' }], 'EUR')).toBe('USD')
    expect(accounts.mostUsedCurrency([{ currency: 'USD' }, { currency: 'CAD' }], 'EUR')).toBe('CAD')      // a tie: the first by code
    expect(accounts.mostUsedCurrency([], 'EUR')).toBe('EUR')
    // The shapes, held to the contract by the type checker (npx tsc --noEmit -p tests)
    const query: accounts.TotalsQuery = { from: '2026-01-01', to: '2026-12-31', accountIds: ['a'], includeTransfers: true }
    const total: accounts.TransactionTotal = { accountId: 'a', month: '2026-01', categoryId: null, transferAccountId: 'b', inflow: 0, outflow: 100, count: 1 }
    const archived: accounts.ArchivedTotal = { ...total, currency: 'CAD', subLedgerId: null, transferSubLedgerId: 'sub' }
    const shared: accounts.AccountsArchived = { transactionIds: [], accounts: [], removedAccountIds: [], removedTotals: [archived] }
    const method: keyof accounts.AccountsService = 'transactionTotals'
    expect([query, total, archived, shared, method]).toHaveLength(5)
  })

  it('classifies every account type, and labels its two amount columns', () => {
    expect(Object.keys(accounts.ACCOUNT_CLASS).sort()).toEqual([...accounts.ACCOUNT_TYPES].sort())
    expect(Object.keys(accounts.AMOUNT_COLUMNS).sort()).toEqual([...accounts.ACCOUNT_TYPES].sort())
    expect(accounts.ACCOUNT_CLASS.creditCard).toBe('liability')
    expect(accounts.ACCOUNT_CLASS.chequing).toBe('asset')
    expect(accounts.AMOUNT_COLUMNS.chequing).toEqual({ decrease: 'Payment', increase: 'Deposit' })
  })

  it('gives every clearing status a letter, and V to voided', () => {
    expect(Object.keys(accounts.STATUS_LETTERS).sort()).toEqual([...accounts.CLEARING_STATUSES, 'voided'].sort())
    expect(accounts.STATUS_LETTERS).toMatchObject({ uncleared: '', electronic: 'E', cleared: 'C', reconciled: 'R', voided: 'V' })
    expect(accounts.CLEARED_STATUSES).toEqual(['electronic', 'cleared', 'reconciled'])
  })

  it('delegates new sub-ledgers to the ledger plugin, whose commands it names', () => {
    // The accounts command is a thin wrapper; the ledger command it runs must exist in the ledger contract
    expect(accounts.ACCOUNTS_COMMANDS.newSubLedger).toBe('accounts.subLedger.new')
    expect(values(ledger.LEDGER_COMMANDS)).toEqual(expect.arrayContaining(['ledger.new', 'ledger.subLedger.rename', 'ledger.subLedger.delete']))
  })
})

describe('@tessera/import-api', () => {
  it('names everything after the import plugin, which is a valid plugin id', () => {
    expect(() => parseManifest({ id: imports.IMPORT_PLUGIN_ID, name: 'x', version: '1', privileged: { entry: 'x' } })).not.toThrow()
    namedAfter(imports.IMPORT_PLUGIN_ID, {
      commands: imports.IMPORT_COMMANDS, keys: imports.IMPORT_CONTEXT_KEYS, channels: imports.IMPORT_CHANNELS,
      events: imports.IMPORT_EVENTS, views: imports.IMPORT_VIEWS, dialogs: imports.IMPORT_DIALOGS
    })
    for (const id of [imports.IMPORT_MANAGER_SERVICE, imports.IMPORT_ANNOTATOR_SERVICE, imports.IMPORT_MIGRATOR_SERVICE]) {
      expect(id).toMatch(SERVICE_ID_PATTERN)
      expect(id.startsWith('import.'), id).toBe(true)
    }
    for (const name of Object.values(imports.IMPORT_COLLECTIONS)) expect(name.startsWith('import.'), name).toBe(true)
    // State keys are the plugin's own, in context.state, which adds the prefix when it stores them
    for (const name of Object.values(imports.IMPORT_STATE_KEYS)) expect(name.includes('.'), name).toBe(false)
    expect(imports.IMPORT_FORMATS_POINT).toBe('import.formats')
  })

  it('has the commands the design names, and no account argument on File › Import… (review decision 14)', () => {
    expect(imports.IMPORT_COMMANDS).toEqual({
      file: 'import.file',
      accept: 'import.review.accept',
      acceptAll: 'import.review.acceptAll',
      change: 'import.review.change',
      showHistory: 'import.history.show',
      manageLinks: 'import.links.manage',
      undoImport: 'import.batch.undo'
    })
    // Unmatch is an option of the Change Match dialog, not a command of its own (review decision 15)
    expect(values(imports.IMPORT_COMMANDS).some(id => /unmatch/i.test(id))).toBe(false)
    expect(imports.IMPORT_CONTEXT_KEYS).toEqual({ hasFormats: 'import.hasFormats', isRunning: 'import.isRunning' })
  })

  it("doesn't collide with the accounts plugin's names", () => {
    const ours = [imports.IMPORT_COMMANDS, imports.IMPORT_CONTEXT_KEYS, imports.IMPORT_CHANNELS, imports.IMPORT_EVENTS,
      imports.IMPORT_VIEWS, imports.IMPORT_DIALOGS].flatMap(values)
    const theirs = new Set([accounts.ACCOUNTS_COMMANDS, accounts.ACCOUNTS_CONTEXT_KEYS, accounts.ACCOUNTS_CHANNELS,
      accounts.ACCOUNTS_EVENTS, accounts.ACCOUNTS_VIEWS, accounts.ACCOUNTS_DIALOGS].flatMap(values))
    expect(ours.filter(name => theirs.has(name))).toEqual([])
    expect(new Set(ours).size).toBe(ours.length)
  })

  it('sets the limits the design states', () => {
    expect(imports.IMPORT_LIMITS).toEqual({ maxFileSize: 25 * 1024 * 1024, sniffBytes: 4096, parseTimeoutMs: 30_000 })
    expect(imports.FINGERPRINT_PREFIX).toBe('fp:')
    expect(new Set(imports.STATEMENT_LINE_KINDS).size).toBe(imports.STATEMENT_LINE_KINDS.length)
  })
})

describe('@tessera/export-api', () => {
  it('names everything after the export plugin, which is a valid plugin id', () => {
    expect(() => parseManifest({ id: exports.EXPORT_PLUGIN_ID, name: 'x', version: '1', privileged: { entry: 'x' } })).not.toThrow()
    namedAfter(exports.EXPORT_PLUGIN_ID, {
      commands: exports.EXPORT_COMMANDS, keys: exports.EXPORT_CONTEXT_KEYS, channels: exports.EXPORT_CHANNELS,
      events: {}, views: {}, dialogs: exports.EXPORT_DIALOGS
    })
    expect(exports.EXPORT_MANAGER_SERVICE).toMatch(SERVICE_ID_PATTERN)
    expect(exports.EXPORT_FORMATS_POINT).toBe('export.formats')
    // State keys are the plugin's own, in context.state, which adds the prefix when it stores them
    for (const name of Object.values(exports.EXPORT_STATE_KEYS)) expect(name.includes('.'), name).toBe(false)
  })

  it("doesn't collide with the import or accounts plugins' names", () => {
    const ours = [exports.EXPORT_COMMANDS, exports.EXPORT_CONTEXT_KEYS, exports.EXPORT_CHANNELS, exports.EXPORT_DIALOGS].flatMap(values)
    const theirs = new Set([imports.IMPORT_COMMANDS, imports.IMPORT_CONTEXT_KEYS, imports.IMPORT_CHANNELS, imports.IMPORT_EVENTS,
      imports.IMPORT_DIALOGS, accounts.ACCOUNTS_COMMANDS, accounts.ACCOUNTS_CONTEXT_KEYS, accounts.ACCOUNTS_CHANNELS,
      accounts.ACCOUNTS_DIALOGS].flatMap(values))
    expect(ours.filter(name => theirs.has(name))).toEqual([])
    expect(new Set(ours).size).toBe(ours.length)
  })
})

describe('@tessera/budget-api', () => {
  it('names everything after the budget plugin, which is a valid plugin id', () => {
    expect(() => parseManifest({ id: budget.BUDGET_PLUGIN_ID, name: 'x', version: '1', privileged: { entry: 'x' } })).not.toThrow()
    for (const id of [budget.BUDGET_SERVICE, budget.BUDGET_MIGRATOR_SERVICE]) {
      expect(id).toMatch(SERVICE_ID_PATTERN)
      expect(id.startsWith(`${budget.BUDGET_PLUGIN_ID}.`)).toBe(true)
    }
    for (const name of Object.values(budget.BUDGET_COLLECTIONS)) expect(name.startsWith('budget.'), name).toBe(true)
    namedAfter(budget.BUDGET_PLUGIN_ID, {
      commands: budget.BUDGET_COMMANDS, keys: budget.BUDGET_CONTEXT_KEYS, channels: budget.BUDGET_CHANNELS,
      events: budget.BUDGET_EVENTS, views: budget.BUDGET_VIEWS, dialogs: budget.BUDGET_DIALOGS
    })
    expect(budget.BUDGET_ICON.startsWith(`${budget.BUDGET_PLUGIN_ID}.`)).toBe(true)
  })

  it('is at 1.4, with the names and payloads of the budget\'s views (B3), the year, history and copies (B4), its settings (B5), and the review\'s additions', () => {
    expect(budget.BUDGET_API_VERSION).toBe('1.4.0')
    // 1.4: the change the service and the dialogs both apply; what Budget Properties needs to say what a change would do
    expect(typeof budget.applyPlanChange).toBe('function')
    const properties: Pick<budget.BudgetDialogInput, 'lineCount' | 'transferLines'> = { lineCount: 2, transferLines: [{ accountId: 'a', label: 'Transfers from A' }] }
    expect(properties.lineCount).toBe(2)
    // The shapes, held to the contract by the type checker (npx tsc --noEmit -p tests)
    const row: budget.RowRef = { kind: 'line', group: 'expense', lineId: 'l' }
    const args: budget.TransactionsArgs = { budgetId: 'b', row, months: { from: '2027-01', to: '2027-03' }, label: 'Groceries', period: 'Year to date' }
    const report: budget.ViewReport = { budgetId: 'b', month: '2027-03', period: 'yearToDate', lineId: 'l' }
    const change: budget.ChangeLineRequest = { lineId: 'l', change: { apply: 'only', month: '2027-03', amount: null }, notes: null, expectedRev: 2 }
    expect([row, args, report, change]).toHaveLength(4)
    expect(budget.STATUS_DEBOUNCE_MS).toBe(250)
    // B4
    const suggest: budget.SuggestRequest = { budgetId: 'b', months: budget.DEFAULT_HISTORY_MONTHS, start: '2027-03', step: 1000 }
    const fill: budget.FillRequest = { budgetId: 'b', lines: [] }
    const copy: budget.DuplicateRequest = { id: 'b', name: 'Household (2)' }
    const own: Partial<budget.StatusRow> = { ownMonths: ['2027-03'] }
    const totals: budget.BudgetStatus['monthlyTotals'] = []
    expect([suggest, fill, copy, own, totals]).toHaveLength(5)
    expect(budget.ROUND_TO_CHOICES).toContain(budget.DEFAULT_ROUND_TO)
    // B5: the settings other plugins may read, whose defaults are the constants they replace
    const settings: budget.BudgetSettings = { ...budget.BUDGET_SETTINGS_DEFAULTS }
    expect(settings).toEqual({ warnAtPercent: 90, showBars: true, showEmptyLines: false, historyMonths: 12, roundTo: 10, statusBar: true })
    expect(budget.BUDGET_SETTINGS_PAGE.startsWith(`${budget.BUDGET_SETTINGS_ID}.`)).toBe(true)
  })

  it('labels every frequency, and keeps every total exact within its limits', () => {
    expect(Object.keys(budget.FREQUENCY_LABELS).sort()).toEqual([...budget.FREQUENCIES].sort())
    // 500 lines, each due at most 106 times in 24 months (weekly), at the largest amount, still a safe integer
    expect(budget.BUDGET_LINES_MAX * 106 * budget.BUDGET_AMOUNT_MAX).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER)
    expect(budget.STATUS_MONTHS_MAX).toBe(24)
  })

  it('turns a BudgetError from any copy of the package into a result, and rethrows anything else', async () => {
    const copy = Object.assign(new Error('Taken'), { name: 'BudgetError', code: 'DUPLICATE_NAME', field: 'name' })
    expect(budget.isBudgetError(copy)).toBe(true)
    expect(await budget.toBudgetResult(async () => { throw copy })).toEqual({ ok: false, error: { code: 'DUPLICATE_NAME', message: 'Taken', field: 'name' } })
    expect(await budget.toBudgetResult(async () => 3)).toEqual({ ok: true, value: 3 })
    await expect(budget.toBudgetResult(async () => { throw new Error('a bug') })).rejects.toThrow('a bug')
  })
})
