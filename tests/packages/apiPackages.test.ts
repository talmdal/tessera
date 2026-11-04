// The plugin API packages are contracts other plugins build against. These tests hold them to the framework's naming
// rules (commands and context keys prefixed by the plugin id, channels named `<pluginId>:<event>`), and check the
// tables that must cover every case.
import { describe, expect, it } from 'vitest'
import * as book from '@tessera/book-api'
import * as accounts from '@tessera/accounts-api'
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

describe('@tessera/book-api', () => {
  it('names everything after the book plugin, which is a valid plugin id', () => {
    expect(() => parseManifest({ id: book.BOOK_PLUGIN_ID, name: 'x', version: '1', privileged: { entry: 'x' } })).not.toThrow()
    namedAfter(book.BOOK_PLUGIN_ID, {
      commands: book.BOOK_COMMANDS, keys: book.BOOK_CONTEXT_KEYS, channels: book.BOOK_CHANNELS,
      events: book.BOOK_EVENTS, views: {}, dialogs: book.BOOK_DIALOGS
    })
    expect(book.BOOK_VIEWS).toEqual({ start: 'ledger.start', tree: 'ledger.tree' })
    expect(book.BOOK_SESSION_SERVICE).toMatch(SERVICE_ID_PATTERN)
  })

  it('preserves the existing book-file format keys', () => {
    expect(book.BOOK_COLLECTIONS.subBooks).toBe('ledger.subledgers')
    expect(book.BOOK_META.schemaVersion('accounts')).toBe('ledger.schema.accounts')
    expect(book.BOOK_META.format).toBe('ledger.format')
  })

  it('describes the .tessera file for open and save dialogs', () => {
    expect(book.BOOK_FILE_EXTENSION).toBe('.tessera')
    expect(book.BOOK_FILE_FILTER).toEqual({ name: 'Tessera book', extensions: ['tessera'] })
  })

  it('builds results with ok and fail', () => {
    expect(book.ok(3)).toEqual({ ok: true, value: 3 })
    expect(book.fail('DUPLICATE_NAME', 'Taken', 'name')).toEqual({ ok: false, error: { code: 'DUPLICATE_NAME', message: 'Taken', field: 'name' } })
    expect(book.fail('NO_BOOK', 'No book')).toEqual({ ok: false, error: { code: 'NO_BOOK', message: 'No book' } })
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

  it('delegates new sub-books to the book plugin, whose commands it names', () => {
    // The accounts command is a thin wrapper; the book command it runs must exist in the book contract
    expect(accounts.ACCOUNTS_COMMANDS.newSubBook).toBe('accounts.subBook.new')
    expect(values(book.BOOK_COMMANDS)).toEqual(expect.arrayContaining(['book.new', 'book.subBook.rename', 'book.subBook.delete']))
  })
})
