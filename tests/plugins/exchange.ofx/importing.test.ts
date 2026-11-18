// @vitest-environment node
// The OFX reader through the whole pipeline: a real statement file, read by the real format plugin, filed
// against a book holding the same household's money, and accepted into the register row by row.
//
// This is the first test in which an actual bank file turns into transactions in a register.
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { FORMATS_POINT } from '@tessera/exchange-api'
import type { AccountInput, AccountsService } from '@tessera/accounts-api'
import { ACCOUNTS_MIGRATOR_SERVICE } from '@tessera/accounts-api'
import { BOOK_SCHEMA_POINT } from '@tessera/book-api'
import {
  EXCHANGE_MIGRATOR_SERVICE, EXCHANGE_OPTIONS_DEFAULTS,
  type ExchangeOptions, type ExchangeStatement, type ReadResult
} from '@tessera/exchange-api'
import { AccountsServiceImpl } from '../../../plugins/accounts/src/privileged/AccountsServiceImpl'
import { ACCOUNTS_SCHEMA, accountsMigrator } from '../../../plugins/accounts/src/privileged/schema'
import { publicService as accountsPublicService } from '../../../plugins/accounts/src/privileged/index'
import { ExchangeServiceImpl } from '../../../plugins/exchange/src/privileged/ExchangeServiceImpl'
import { FormatRegistry } from '../../../plugins/exchange/src/privileged/formats'
import { accountFromStatement, resolveAccount } from '../../../plugins/exchange/src/privileged/planning'
import { EXCHANGE_SCHEMA, exchangeMigrator } from '../../../plugins/exchange/src/privileged/schema'
import { DESCRIPTORS, OFX_FORMAT_SERVICE, OFX_PLUGIN_ID, ofxFormat } from '../../../plugins/exchange.ofx/src/privileged/index'
import type { ExchangeDisk } from '../../../plugins/exchange/src/privileged/disk'
import { logger, setupSession } from '../book/harness'

const FIXTURES = path.resolve(__dirname, '../../fixtures/exchange')
const TODAY = '2026-11-17'

/** The fixtures on a disk the pipeline can read, under the paths a user would have downloaded them to. */
function fixtureDisk(): ExchangeDisk {
  return {
    read: async file => new Uint8Array(fs.readFileSync(path.join(FIXTURES, file.replace(/^\/downloads\//, '')))),
    write: async () => {}
  }
}

const account = (over: Partial<AccountInput>): AccountInput => ({
  name: 'Chequing', type: 'chequing', subBookId: null, currency: 'CAD',
  openingDate: '2026-09-01', openingBalance: 0, ...over
})

async function setup(options: Partial<ExchangeOptions['import']> = {}) {
  const env = setupSession()
  const log = logger()

  env.extensions.contribute('accounts', BOOK_SCHEMA_POINT, 'accounts', ACCOUNTS_SCHEMA)
  env.services.provide('accounts', ACCOUNTS_MIGRATOR_SERVICE, accountsMigrator)
  env.extensions.contribute('exchange', BOOK_SCHEMA_POINT, 'exchange', EXCHANGE_SCHEMA)
  env.services.provide('exchange', EXCHANGE_MIGRATOR_SERVICE, exchangeMigrator)

  // The OFX plugin, activated the way the shell does: its service, then its three descriptors
  env.services.provide(OFX_PLUGIN_ID, OFX_FORMAT_SERVICE, ofxFormat)
  for (const descriptor of DESCRIPTORS) {
    env.extensions.contribute(OFX_PLUGIN_ID, FORMATS_POINT, descriptor.id, descriptor)
  }

  let tick = 0
  const now = () => `${TODAY}T09:00:00.${String(tick++).padStart(3, '0')}Z`
  const accountsImpl = new AccountsServiceImpl({ session: env.session, log, today: () => TODAY, now })
  env.session.participate('accounts', accountsImpl.participant)
  const accounts: AccountsService = accountsPublicService(accountsImpl)

  const service = new ExchangeServiceImpl({
    session: env.session,
    accounts,
    prompts: env.prompts,
    files: env.files,
    formats: new FormatRegistry({ extensions: env.extensions, services: env.services, log }),
    disk: fixtureDisk(),
    log,
    options: () => ({
      import: { ...EXCHANGE_OPTIONS_DEFAULTS.import, ...options },
      history: EXCHANGE_OPTIONS_DEFAULTS.history
    }),
    today: () => TODAY,
    now
  })

  await env.created()

  /** Reads a fixture, keeping the file's name and hash the way File ▸ Import does. */
  const readFixture = (file: string) => service.read(`/downloads/${file}`)

  /** The import command's account resolution, over the book's current accounts and links. */
  const resolve = async (statement: ExchangeStatement, formatId: string) =>
    (await resolveAccount(statement, formatId, { accounts, links: await service.links() })).target

  /** Files one of a read fixture's statements against an account, as the import command does once resolved. */
  const fileStatement = (
    read: ReadResult, accountId: string,
    over: { index?: number, remember?: boolean, force?: boolean } = {}
  ) =>
    service.file(read.document.statements[over.index ?? 0], accountId, {
      source: {
        fileName: read.fileName, fileHash: read.fileHash, formatId: read.document.formatId,
        ...(read.document.dialect !== undefined && { dialect: read.document.dialect })
      },
      ...(over.remember !== undefined && { remember: over.remember }),
      ...(over.force !== undefined && { force: over.force })
    })

  /** Reads a fixture and files its first statement, for the tests that pick the account themselves. */
  const fileFixture = async (file: string, accountId: string, over: { remember?: boolean, force?: boolean } = {}) =>
    fileStatement(await readFixture(file), accountId, over)

  /** Accepts every row waiting in an account, oldest statement first, as a user pressing Accept down the list. */
  const acceptAll = async (accountId: string) => {
    for (;;) {
      const waiting = await service.pendingFor(accountId)
      const statement = waiting[0]
      const row = statement?.rows[0]
      if (statement === undefined || row === undefined) return
      await service.accept(accountId, statement.id, row.key)
    }
  }

  return { ...env, accounts, service, readFixture, resolve, fileStatement, fileFixture, acceptAll, log }
}

/** The error a promise rejects with. */
const rejection = (work: Promise<unknown>) =>
  work.then(() => { throw new Error('expected a rejection') }, err => err as { code: string, message: string })

describe('reading a bank file into a book', () => {
  it('chooses the format by extension and finds the account by its number', async () => {
    const { accounts, readFixture, resolve } = await setup()
    const chequing = await accounts.createAccount(account({ accountNumber: '00412-1234567' }))

    const read = await readFixture('ofx/personal-chequing-2026-10.ofx')
    expect(read.document.formatId).toBe('exchange-ofx.ofx')
    expect(read.document.dialect).toBe('OFX 102 (SGML)')
    expect(await resolve(read.document.statements[0], read.document.formatId))
      .toEqual({ kind: 'existing', accountId: chequing.id, matchedBy: 'number' })
  })

  it('finds the account from the last four digits the statement shows', async () => {
    const { accounts, readFixture, resolve } = await setup()
    // The book records the number the way the user typed it, which is not how the bank prints it
    const chequing = await accounts.createAccount(account({ accountNumber: '1234567' }))
    const read = await readFixture('ofx/personal-chequing-2026-10.ofx')
    expect(await resolve(read.document.statements[0], read.document.formatId))
      .toMatchObject({ accountId: chequing.id, matchedBy: 'number' })
  })

  it('writes every row of a statement into an empty account, and the balance then matches the bank', async () => {
    const { accounts, service, readFixture, fileStatement, acceptAll } = await setup()
    const chequing = await accounts.createAccount(account({
      accountNumber: '00412-1234567',
      // The statement opens where September closed, which is the household's float
      openingBalance: 800_000
    }))

    const read = await readFixture('ofx/personal-chequing-2026-10.ofx')
    const statement = read.document.statements[0]
    const result = await fileStatement(read, chequing.id)
    expect(result.filed).toBe(statement.transactions.length)
    expect(result.duplicates).toBe(0)

    // Nothing reaches the register until the rows are accepted
    expect((await accounts.transactions(chequing.id).register()).rows).toEqual([])

    await acceptAll(chequing.id)
    const register = await accounts.transactions(chequing.id).register()

    expect(register.rows).toHaveLength(statement.transactions.length)
    // Every imported row says the bank reported it
    expect(register.rows.every(r => r.transaction.status === 'electronic')).toBe(true)
    // And the account now holds what the statement says it does
    expect(register.balances.current).toBe(statement.balances!.ledger!.amount)
    expect(await service.pendingFor(chequing.id)).toHaveLength(0)
  })

  it('refuses the identical file whole while its statement is still waiting', async () => {
    const { accounts, fileFixture } = await setup()
    const chequing = await accounts.createAccount(account({ accountNumber: '00412-1234567' }))

    await fileFixture('ofx/personal-chequing-2026-10.ofx', chequing.id)
    // The identical file again: caught by its hash before any row is looked at
    const again = await rejection(fileFixture('ofx/personal-chequing-2026-10.ofx', chequing.id))
    expect(again.code).toBe('INVALID')
  })

  it('finds the rows it already wrote when the same file is read again', async () => {
    const { accounts, fileFixture, acceptAll } = await setup()
    const chequing = await accounts.createAccount(account({ accountNumber: '00412-1234567' }))

    const first = await fileFixture('ofx/personal-chequing-2026-10.ofx', chequing.id)
    await acceptAll(chequing.id)
    const written = (await accounts.transactions(chequing.id).register()).rows.length
    expect(written).toBe(first.filed)

    // Reading the identical file again is a question the caller answers — here, yes — and then every bank
    // reference is already in the register, so nothing is filed and it is not an error.
    const again = await fileFixture('ofx/personal-chequing-2026-10.ofx', chequing.id, { force: true })
    expect(again.filed).toBe(0)
    expect(again.duplicates).toBe(first.filed)
    expect(again.statement).toBeUndefined()
    expect((await accounts.transactions(chequing.id).register()).rows).toHaveLength(written)
  })

  it('merges the bank’s rows into the ones the household typed, including those posted days later', async () => {
    const { accounts, service, readFixture, fileStatement, acceptAll } = await setup()
    const chequing = await accounts.createAccount(account({ accountNumber: '00412-1234567' }))

    // What the household entered on the day it paid: the rent on the 1st and the daycare on the 2nd. The bank
    // posted the rent on the 3rd and the daycare the same day, which is the gap the matcher's window is for.
    const rent = await accounts.transactions(chequing.id).create({
      date: '2026-10-01', amount: -205_000, payee: 'Maple Ridge Properties'
    })
    const daycare = await accounts.transactions(chequing.id).create({
      date: '2026-10-02', amount: -90_000, payee: 'Brightpath Early Learning'
    })

    const read = await readFixture('ofx/personal-chequing-2026-10.ofx')
    await fileStatement(read, chequing.id)

    // The register's provisional rows show both matches before anything is accepted
    const overlay = await service.overlayRows(chequing.id)
    const matched = overlay.filter(r => r.matchedId !== undefined)
    expect(matched.map(r => r.matchedId).sort()).toEqual([rent.id, daycare.id].sort())
    // The rent is the one the bank posted late, and the matcher bridged the gap
    expect(matched.find(r => r.matchedId === rent.id)!.date).toBe('2026-10-03')

    await acceptAll(chequing.id)
    const register = await accounts.transactions(chequing.id).register()

    // Two rows updated rather than doubled: the register has the file's rows and no more
    expect(register.rows).toHaveLength(read.document.statements[0].transactions.length)
    const merged = register.rows.find(r => r.transaction.id === rent.id)!
    expect(merged.transaction.status).toBe('electronic')
    expect(merged.transaction.externalId).toBeTypeOf('string')
    // The statement is the source of truth: the transaction now carries the date the bank posted it
    expect(merged.transaction.date).toBe('2026-10-03')
  })

  it('treats a month already reconciled as rows to look at, not rows to write', async () => {
    const { accounts, service, fileFixture } = await setup()
    const chequing = await accounts.createAccount(account({ accountNumber: '00412-1234567' }))
    const rent = await accounts.transactions(chequing.id).create({
      date: '2026-09-01', amount: -205_000, payee: 'Maple Ridge Properties'
    })
    await accounts.transactions(chequing.id).setStatus([rent.id], 'reconciled', { confirm: ['reconciled'] })

    await fileFixture('ofx/personal-chequing-2026-09.ofx', chequing.id)
    const overlay = await service.overlayRows(chequing.id)
    const matched = overlay.find(r => r.matchedId === rent.id)!
    expect(matched).toBeDefined()

    // A reconciled row is never merged into without confirmation (design, "Risks"): the first accept asks…
    const [waiting] = await service.pendingFor(chequing.id)
    const row = waiting.rows.find(r => matched.key.endsWith(`:${r.key}`))!
    await expect(service.accept(chequing.id, waiting.id, row.key)).rejects.toMatchObject({
      code: 'CONFIRMATION_REQUIRED', reasons: ['reconciled']
    })
    // …and once confirmed it updates the reconciled row rather than adding a second one
    await service.accept(chequing.id, waiting.id, row.key, { confirm: ['reconciled'] })
    const register = await accounts.transactions(chequing.id).register()
    expect(register.rows.filter(r => r.transaction.date === '2026-09-01')).toHaveLength(1)
  })

  it('reads a credit-card statement into a credit-card account, signs and all', async () => {
    const { accounts, readFixture, fileStatement, acceptAll } = await setup()
    const visa = await accounts.createAccount(account({
      name: 'Visa', type: 'creditCard', accountNumber: '4510220011889043', openingBalance: -100_000
    }))

    const read = await readFixture('qfx/personal-visa-2026-10.qfx')
    expect(read.document.formatId).toBe('exchange-ofx.qfx')

    await fileStatement(read, visa.id)
    await acceptAll(visa.id)
    const register = await accounts.transactions(visa.id).register()
    // Spending lowers the balance and the payment raises it, as on a card
    expect(register.rows.some(r => r.transaction.amount < 0)).toBe(true)
    expect(register.rows.some(r => r.transaction.amount > 0)).toBe(true)
    expect(register.rows.find(r => r.payeeName === 'Boulangerie Côté')).toBeDefined()
  })

  it('reads a QBO into the business account', async () => {
    const { accounts, readFixture, fileStatement, acceptAll } = await setup()
    const business = await accounts.createAccount(account({
      name: 'Business Chequing', accountNumber: '00819-2003344', openingBalance: 1_000_000
    }))

    const read = await readFixture('qbo/business-chequing-2026-10.qbo')
    expect(read.document.formatId).toBe('exchange-ofx.qbo')
    const result = await fileStatement(read, business.id)
    expect(result.filed).toBeGreaterThan(0)
    await acceptAll(business.id)
    expect((await accounts.transactions(business.id).register()).rows.length).toBe(result.filed)
  })

  it('leaves the statement unresolved when nothing in the book matches it', async () => {
    const { accounts, readFixture, resolve } = await setup()
    await accounts.createAccount(account({ name: 'Somewhere else', accountNumber: '99999999' }))

    const read = await readFixture('ofx/personal-chequing-2026-10.ofx')
    const statement = read.document.statements[0]
    expect(await resolve(statement, read.document.formatId)).toEqual({ kind: 'unresolved' })

    // And the account dialog is prefilled with the opening balance that leaves the closing figure right
    expect(accountFromStatement(statement, TODAY)).toMatchObject({
      currency: 'CAD', type: 'chequing', accountNumber: '00412-1234567'
    })
  })

  it('refuses a statement in a currency the account does not use', async () => {
    const { accounts, fileFixture } = await setup()
    const chequing = await accounts.createAccount(account({ accountNumber: '00412-1234567', currency: 'EUR' }))
    const failure = await rejection(fileFixture('ofx/personal-chequing-2026-10.ofx', chequing.id))
    expect(failure.code).toBe('CURRENCY_MISMATCH')
  })

  it('leaves the register alone while the user accepts nothing', async () => {
    const { accounts, service, fileFixture } = await setup()
    const chequing = await accounts.createAccount(account({ accountNumber: '00412-1234567' }))
    const result = await fileFixture('ofx/personal-chequing-2026-10.ofx', chequing.id)

    // The rows wait in the pending statement; nothing has touched the register
    const [waiting] = await service.pendingFor(chequing.id)
    expect(waiting.rows).toHaveLength(result.filed)
    expect((await accounts.transactions(chequing.id).register()).rows).toEqual([])
  })

  it('takes a whole imported statement back out again', async () => {
    const { accounts, service, fileFixture, acceptAll } = await setup()
    const chequing = await accounts.createAccount(account({ accountNumber: '00412-1234567' }))

    const result = await fileFixture('ofx/personal-chequing-2026-10.ofx', chequing.id)
    await acceptAll(chequing.id)
    expect((await accounts.transactions(chequing.id).register()).rows.length).toBeGreaterThan(0)

    const [batch] = await service.history()
    const undone = await service.undo(batch.id)
    expect(undone.removed).toBe(result.filed)
    expect((await accounts.transactions(chequing.id).register()).rows).toEqual([])
  })

  it('remembers the account, so the next month’s file needs no answer', async () => {
    const { accounts, service, readFixture, fileFixture, resolve } = await setup()
    // No account number on record, so only the remembered link can resolve the next file
    const chequing = await accounts.createAccount(account({ name: 'Chequing' }))

    await fileFixture('ofx/personal-chequing-2026-09.ofx', chequing.id, { remember: true })
    expect(await service.links()).toHaveLength(1)

    const second = await readFixture('ofx/personal-chequing-2026-10.ofx')
    expect(await resolve(second.document.statements[0], second.document.formatId))
      .toEqual({ kind: 'existing', accountId: chequing.id, matchedBy: 'link' })
  })
})
