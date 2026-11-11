// The plugin API packages are contracts other plugins build against. These tests hold them to the framework's naming
// rules (commands and context keys prefixed by the plugin id, channels named `<pluginId>:<event>`), and check the
// tables that must cover every case.
import { describe, expect, it } from 'vitest'
import * as ledger from '@tessera/ledger-api'
import * as accounts from '@tessera/accounts-api'
import * as imports from '@tessera/import-api'
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
    expect(ledger.LEDGER_COLLECTIONS.subLedgers.startsWith('ledger.')).toBe(true)
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
