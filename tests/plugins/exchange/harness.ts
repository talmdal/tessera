// `exchange.service` on a real book session and a real accounts service (memory engine), with all three
// schemas contributed as the plugins do. Nothing is faked below the service: an imported row really is written
// to a register, and undo really takes it back out.
//
// The formats are faked, because phase 1 has none: a fake format plugin returns hand-built documents, which is
// exactly how the design says this layer should be driven.
import { vi } from 'vitest'
import type { Json } from '@tessera/types'
import { ACCOUNTS_MIGRATOR_SERVICE, type AccountInput, type AccountsService } from '@tessera/accounts-api'
import { BOOK_SCHEMA_POINT } from '@tessera/book-api'
import {
  EXCHANGE_MIGRATOR_SERVICE, EXCHANGE_OPTIONS_DEFAULTS, FORMATS_POINT,
  type ExchangeDocument, type ExchangeFormat, type ExchangeFormatContribution, type ExchangeOptions,
  type ExchangeStatement, type ExchangeTransaction, type FileResult
} from '@tessera/exchange-api'
import { AccountsServiceImpl } from '../../../plugins/accounts/src/privileged/AccountsServiceImpl'
import { ACCOUNTS_SCHEMA, accountsMigrator } from '../../../plugins/accounts/src/privileged/schema'
import { publicService as accountsPublicService } from '../../../plugins/accounts/src/privileged/index'
import { ExchangeServiceImpl } from '../../../plugins/exchange/src/privileged/ExchangeServiceImpl'
import { FormatRegistry } from '../../../plugins/exchange/src/privileged/formats'
import { EXCHANGE_SCHEMA, exchangeMigrator } from '../../../plugins/exchange/src/privileged/schema'
import type { ExchangeDisk } from '../../../plugins/exchange/src/privileged/disk'
import { logger, setupSession } from '../book/harness'

/** The day every test runs on. A Friday. */
export const TODAY = '2026-11-13'

export function chequing(over: Partial<AccountInput> = {}): AccountInput {
  return {
    name: 'Chequing', type: 'chequing', subBookId: null, currency: 'CAD',
    openingDate: '2026-01-01', openingBalance: 500000, accountNumber: '1234567890', ...over
  }
}

/** One incoming row. Negative amounts are money leaving the account, as everywhere else. */
export function row(over: Partial<ExchangeTransaction> = {}): ExchangeTransaction {
  return { date: '2026-11-03', amount: -14200, payee: 'Hydro Ottawa', ...over }
}

export function statement(over: Partial<ExchangeStatement> = {}): ExchangeStatement {
  return {
    account: { number: '1234567890', name: 'Chequing', currency: 'CAD' },
    transactions: [row()],
    ...over
  }
}

export function document(over: Partial<ExchangeDocument> = {}): ExchangeDocument {
  return {
    formatId: 'fake.statements',
    statements: [statement()],
    unsupported: [],
    warnings: [],
    ...over
  }
}

/** A format plugin that returns whatever document the test gives it. */
export interface FakeFormat {
  contribution: ExchangeFormatContribution
  format: ExchangeFormat & { read: NonNullable<ExchangeFormat['read']> }
  /** What the next `read` returns. */
  next: (doc: ExchangeDocument) => void
  /** Questions the reader raises before returning, in order. */
  asks: (...questions: Parameters<Parameters<ExchangeFormat['read'] & object>[1]['request']>[0][]) => void
  /** The answers the reader was given, in the order it asked. */
  answers: Json[]
}

export function fakeFormat(id = 'fake.statements', over: Partial<ExchangeFormatContribution> = {}): FakeFormat {
  let pending = document()
  let questions: Parameters<NonNullable<ExchangeFormat['read']>>[1]['request'] extends (q: infer Q) => unknown ? Q[] : never[] = []
  const answers: Json[] = []

  return {
    contribution: {
      id,
      label: 'Fake statement',
      extensions: ['fake'],
      service: `${id.split('.')[0]}.format`,
      capabilities: { read: true, transactionIds: true },
      ...over
    },
    format: {
      sniff: head => (new TextDecoder().decode(head.subarray(0, 4)) === 'FAKE' ? 1 : 0),
      read: async (_data, context) => {
        for (const question of questions) answers.push(await context.request(question))
        return pending
      }
    },
    next: doc => { pending = doc },
    asks: (...qs) => { questions = qs as typeof questions },
    answers
  }
}

/** A disk holding named files, so nothing touches a real one. */
export function fakeDisk(files: Record<string, string> = {}) {
  const written = new Map<string, Uint8Array>()
  const contents = new Map(Object.entries(files).map(([path, text]) => [path, new TextEncoder().encode(text)]))
  const disk: ExchangeDisk = {
    read: async path => {
      const found = contents.get(path)
      if (found === undefined) throw new Error(`no such file: ${path}`)
      return found
    },
    write: async (path, data) => { written.set(path, data) }
  }
  return { disk, contents, written }
}

export interface SetupOptions {
  today?: string
  options?: Partial<ExchangeOptions['import']> & { keep?: number }
  /** Install no format at all, to test what happens when none is. */
  withoutFormat?: boolean
}

export async function setupExchange(setup: SetupOptions = {}) {
  const env = setupSession()
  const today = setup.today ?? TODAY
  const log = logger()

  env.extensions.contribute('accounts', BOOK_SCHEMA_POINT, 'accounts', ACCOUNTS_SCHEMA)
  env.services.provide('accounts', ACCOUNTS_MIGRATOR_SERVICE, accountsMigrator)
  env.extensions.contribute('exchange', BOOK_SCHEMA_POINT, 'exchange', EXCHANGE_SCHEMA)
  env.services.provide('exchange', EXCHANGE_MIGRATOR_SERVICE, exchangeMigrator)

  // One clock for both plugins. A batch's `importedAt` is compared against each transaction's `updatedAt` to
  // spot a row edited since the import, so the two must come from the same increasing source or every row
  // looks edited.
  let tick = 0
  const now = () => `${today}T09:00:00.${String(tick++).padStart(3, '0')}Z`

  const accountsImpl = new AccountsServiceImpl({ session: env.session, log, today: () => today, now })
  env.session.participate('accounts', accountsImpl.participant)
  const accounts: AccountsService = accountsPublicService(accountsImpl)

  const format = fakeFormat()
  if (!setup.withoutFormat) {
    env.services.provide('fake', format.contribution.service, format.format)
    env.extensions.contribute('fake', FORMATS_POINT, format.contribution.id, format.contribution)
  }

  const formats = new FormatRegistry({ extensions: env.extensions, services: env.services, log })
  // Several distinct files, because a re-read of identical bytes is refused by its hash
  const { disk, written } = fakeDisk({
    '/in/statement.fake': 'FAKE file',
    '/in/december.fake': 'FAKE file, the next month',
    '/in/january.fake': 'FAKE file, the month after'
  })

  const { keep, ...importOverrides } = setup.options ?? {}
  const options: ExchangeOptions = {
    import: { ...EXCHANGE_OPTIONS_DEFAULTS.import, ...importOverrides },
    history: { keep: keep ?? EXCHANGE_OPTIONS_DEFAULTS.history.keep },
    qif: { ...EXCHANGE_OPTIONS_DEFAULTS.qif }
  }

  const service = new ExchangeServiceImpl({
    session: env.session,
    accounts,
    prompts: env.prompts,
    files: env.files,
    formats,
    disk,
    log,
    options: () => options,
    today: () => today,
    now
  })

  await env.created()
  const chq = await accounts.createAccount(chequing())
  const savings = await accounts.createAccount(chequing({ name: 'Savings', type: 'savings', accountNumber: '9999000011', openingBalance: 100000 }))

  /** Reads the fake file after pointing the format at `doc`, as File ▸ Import does before filing. */
  const readOf = async (doc: ExchangeDocument = document(), path = '/in/statement.fake') => {
    format.next(doc)
    return service.read(path)
  }

  /** Reads `doc` and files its first statement against an account (the chequing account by default). */
  const fileOf = async (
    doc: ExchangeDocument = document(),
    over: { accountId?: string, index?: number, remember?: boolean, path?: string } = {}
  ): Promise<FileResult> => {
    const read = await readOf(doc, over.path)
    const statement = read.document.statements[over.index ?? 0]
    return service.file(statement, over.accountId ?? chq.id, {
      source: {
        fileName: read.fileName, fileHash: read.fileHash, formatId: read.document.formatId,
        ...(read.document.dialect !== undefined && { dialect: read.document.dialect })
      },
      ...(read.document.truncatedAt !== undefined && { truncatedAt: read.document.truncatedAt }),
      ...(over.remember !== undefined && { remember: over.remember })
    })
  }

  /** Accepts every row waiting in an account, oldest statement first, as a user pressing Accept down the list. */
  const acceptAll = async (accountId = chq.id) => {
    for (;;) {
      const waiting = await service.pendingFor(accountId)
      const statement = waiting[0]
      const row = statement?.rows[0]
      if (statement === undefined || row === undefined) return
      await service.accept(accountId, statement.id, row.key)
    }
  }

  return {
    ...env, today, log, accounts, accountsImpl, service, formats, format, disk, written, options,
    chq, savings, readOf, fileOf, acceptAll
  }
}

/** The error a promise rejects with. */
export const rejection = (work: Promise<unknown>) =>
  work.then(() => { throw new Error('expected a rejection') },
    err => err as { code: string, message: string, field?: string, reasons?: string[] })

/** A register's rows, newest fields only, for readable assertions. */
export async function registerOf(accounts: AccountsService, accountId: string) {
  const snapshot = await accounts.transactions(accountId).register()
  return snapshot.rows.map(r => ({
    date: r.transaction.date,
    amount: r.transaction.amount,
    payee: r.payeeName,
    status: r.transaction.status,
    externalId: r.transaction.externalId,
    memo: r.transaction.memo,
    number: r.transaction.number,
    id: r.transaction.id
  }))
}

export const spyLogger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })
