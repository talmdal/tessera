// Builds the seeded book and the bank files that go with it.
//
// The book is written through the real plugins — the SQLite engine, `book.session`, `accounts.service` — so
// what comes out is a book the app opens, not a fixture shaped like one. Everything the shell normally supplies
// (dialogs, prompts, application state) is stubbed here, because a script has no window to put them in.
import fs from 'node:fs'
import path from 'node:path'
import { KitStorageEngine } from '@tessera/storage-kit'
import type { AppState, Logger, ShellFiles, ShellPrompts } from '@tessera/types'
import {
  STATEMENT_RECONCILER, type Account, type AccountsService, type TransactionDraft
} from '@tessera/accounts-api'
import { ACCOUNTS_SCHEMA, accountsMigrator } from '../../plugins/accounts/src/privileged/schema'
import { AccountsServiceImpl } from '../../plugins/accounts/src/privileged/AccountsServiceImpl'
import { publicService } from '../../plugins/accounts/src/privileged/index'
import { EXCHANGE_SCHEMA, exchangeMigrator } from '../../plugins/exchange/src/privileged/schema'
import { BookSessionImpl } from '../../plugins/book/src/privileged/BookSessionImpl'
import { RecentBooks } from '../../plugins/book/src/privileged/RecentBooks'
import { SchemaRegistry } from '../../plugins/book/src/privileged/SchemaRegistry'
import { nodeDisk } from '../../plugins/book/src/privileged/disk'
import { sqliteDriver } from '../../plugins/storage.sqlite/src/privileged/SqliteDriver'
import { ExtensionRegistryImpl } from '../../core/extensions/ExtensionRegistry'
import { ServiceRegistryImpl } from '../../core/services/ServiceRegistry'
import { BOOK_SCHEMA_POINT } from '@tessera/book-api'
import { ACCOUNTS_MIGRATOR_SERVICE } from '@tessera/accounts-api'
import { EXCHANGE_MIGRATOR_SERVICE } from '@tessera/exchange-api'
import {
  ACCOUNTS, BOOK_NAME, EXTRA_CATEGORIES, PERIOD, RECONCILED_THROUGH,
  generate, monthlyBalances, statementRows, type AccountKey, type Entry, type SeedAccount
} from './household'
import { monthsBetween } from './random'
import { manifestEntry, render, type ManifestEntry, type StatementSpec } from './statements'

interface Options {
  bookPath: string
  fixturesDir: string
  seed: number
  openMonth: string
  quiet: boolean
  statementsOnly: boolean
}

const log = (options: Options, message: string) => { if (!options.quiet) console.log(message) }

/** Everything the shell would normally provide, reduced to what building a book actually touches. */
function stubShell() {
  const files: ShellFiles = {
    showOpenDialog: async () => undefined,
    showSaveDialog: async () => undefined,
    exists: async file => fs.existsSync(file),
    trash: async file => { await fs.promises.rm(file, { force: true }) },
    documentsPath: () => process.cwd()
  }
  const prompts: ShellPrompts = {
    // A script answers yes to everything: there is no one at the keyboard to ask
    confirm: async () => true,
    message: async () => {},
    prompt: async () => undefined,
    show: async () => undefined
  }
  const values = new Map<string, unknown>()
  const state: AppState = {
    get: async <T>(key: string, fallback?: () => T) => (values.has(key) ? values.get(key) : fallback?.()) as T | undefined,
    set: async (key, value) => { values.set(key, value) },
    update: async (key, patch) => { values.set(key, { ...(values.get(key) as object), ...(patch as object) }) },
    remove: async key => { values.delete(key) }
  }
  return { files, prompts, state }
}

const quietLogger = (verbose: boolean): Logger => ({
  info: message => { if (verbose) console.log(`  ${message}`) },
  warn: message => console.warn(`  ! ${message}`),
  error: (message, err) => console.error(`  !! ${message}`, err ?? '')
})

async function openSession(options: Options) {
  const { files, prompts, state } = stubShell()
  const extensions = new ExtensionRegistryImpl()
  const services = new ServiceRegistryImpl()
  const logger = quietLogger(false)

  extensions.contribute('accounts', BOOK_SCHEMA_POINT, 'accounts', ACCOUNTS_SCHEMA)
  services.provide('accounts', ACCOUNTS_MIGRATOR_SERVICE, accountsMigrator)
  extensions.contribute('exchange', BOOK_SCHEMA_POINT, 'exchange', EXCHANGE_SCHEMA)
  services.provide('exchange', EXCHANGE_MIGRATOR_SERVICE, exchangeMigrator)

  const engine = new KitStorageEngine(sqliteDriver({ directory: path.dirname(options.bookPath) }))
  const session = new BookSessionImpl({
    engine,
    files,
    prompts,
    recent: new RecentBooks(state),
    schema: new SchemaRegistry(extensions, services, logger),
    disk: nodeDisk(),
    log: logger
  })

  const accountsImpl = new AccountsServiceImpl({ session, log: logger, today: () => PERIOD.to })
  session.participate('accounts', accountsImpl.participant)
  return { session, accounts: publicService(accountsImpl), engine }
}

/** Builds the book from nothing: the file, the sub-books, the accounts and four years of transactions. */
async function buildBook(options: Options) {
  const ledger = generate(options.seed, options.openMonth)

  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    await fs.promises.rm(options.bookPath + suffix, { force: true })
  }
  await fs.promises.mkdir(path.dirname(options.bookPath), { recursive: true })

  const { session, accounts } = await openSession(options)
  const book = await session.create(options.bookPath, { name: BOOK_NAME })
  if (book === undefined) throw new Error(`could not create ${options.bookPath}`)
  log(options, `Book     ${options.bookPath}`)

  const subBooks = new Map<string, string>()
  for (const name of ['Personal', 'Business']) {
    subBooks.set(name, (await session.createSubBook({ name, parentId: null })).id)
  }

  for (const { path: categoryPath, kind } of EXTRA_CATEGORIES) {
    await accounts.categories.create(categoryPath, kind)
  }
  const categoryIds = await categoryIndex(accounts)

  const created = new Map<AccountKey, Account>()
  for (const spec of ACCOUNTS) {
    created.set(spec.key, await accounts.createAccount({
      name: spec.name,
      type: spec.type,
      subBookId: subBooks.get(spec.subBook) ?? null,
      currency: 'CAD',
      institution: spec.institution,
      accountNumber: spec.accountNumber,
      openingDate: PERIOD.from,
      openingBalance: spec.openingBalance,
      ...(spec.creditLimit !== undefined && { creditLimit: spec.creditLimit }),
      ...(spec.minimumBalance !== undefined && { minimumBalance: spec.minimumBalance, showAvailableBalance: false })
    }))
  }
  log(options, `Accounts ${[...created.values()].map(a => a.name).join(', ')}`)

  // Written one account at a time, in date order, through the bulk path an import uses. A transfer is written
  // once, by the side the money leaves; `accounts.service` writes the other side itself.
  let written = 0
  for (const spec of ACCOUNTS) {
    const account = created.get(spec.key)!
    const drafts: TransactionDraft[] = ledger.entries
      .filter(entry => entry.account === spec.key && entry.inBook)
      .map(entry => draftOf(entry, created, categoryIds))
    if (drafts.length === 0) continue
    await accounts.transactions(account.id).createMany(drafts)
    written += drafts.length
  }
  log(options, `Entries  ${written} written, ${ledger.entries.length - written} held back for the statements`)

  await reconcile(options, accounts, created, ledger)
  await checkBalances(accounts, created, ledger)

  await session.close()
  return { ledger, accounts: created }
}

function draftOf(entry: Entry, accounts: Map<AccountKey, Account>, categories: Map<string, string>): TransactionDraft {
  const categoryId = entry.category === undefined ? undefined : categories.get(entry.category.toLowerCase())
  if (entry.category !== undefined && categoryId === undefined) {
    throw new Error(`the seed uses a category the book does not have: ${entry.category}`)
  }
  return {
    date: entry.date,
    amount: entry.amount,
    ...(entry.payee !== undefined && { payee: entry.payee }),
    ...(entry.memo !== undefined && { memo: entry.memo }),
    ...(entry.number !== undefined && { number: entry.number }),
    ...(categoryId !== undefined && { categoryId }),
    ...(entry.transferTo !== undefined && { transferAccountId: accounts.get(entry.transferTo)!.id })
  }
}

/** `Parent : Child` → id, lower case, so the generator can name categories as a person would. */
async function categoryIndex(accounts: AccountsService): Promise<Map<string, string>> {
  const all = await accounts.categories.list()
  const byId = new Map(all.map(category => [category.id, category]))
  const index = new Map<string, string>()
  for (const category of all) {
    const names: string[] = []
    for (let at = byId.get(category.id); at !== undefined; at = at.parentId === null ? undefined : byId.get(at.parentId)) {
      names.unshift(at.name)
      if (names.length > all.length) break
    }
    index.set(names.join(' : ').toLowerCase(), category.id)
  }
  return index
}

/**
 * Reconciles every account month by month, through to `RECONCILED_THROUGH`. Nothing is missing from the book
 * in those months, so every statement balances exactly and no adjustment is ever needed — which is the point:
 * an importer tested against a book that was never reconciled is not tested against a real one.
 */
async function reconcile(options: Options, accounts: AccountsService, created: Map<AccountKey, Account>, ledger: ReturnType<typeof generate>) {
  const byMonth = monthlyBalances(ledger)
  const months = monthsBetween(PERIOD.from.slice(0, 7), RECONCILED_THROUGH.slice(0, 7))
  let done = 0

  for (const spec of ACCOUNTS) {
    const account = created.get(spec.key)!
    let starting = spec.openingBalance

    for (const month of months) {
      const closing = byMonth.get(month)![spec.key]
      const lastDay = monthEnd(month)

      const state = await accounts.reconciliation.begin(account.id, {
        reconcilerId: STATEMENT_RECONCILER,
        statementDate: lastDay,
        startingBalance: starting,
        statementBalance: closing
      })

      const onStatement = state.candidates
        .filter(candidate => candidate.transaction.date <= lastDay && !candidate.marked)
        .map(candidate => candidate.transaction.id)
      if (onStatement.length > 0) await accounts.reconciliation.mark(account.id, onStatement, true)

      const current = await accounts.reconciliation.get(account.id)
      if (current !== undefined && current.summary.difference !== 0) {
        throw new Error(
          `${spec.name} does not balance for ${month}: the statement is out by ${current.summary.difference} ` +
          'minor units. The generator and the reconciliation disagree, which is a bug in the seed.')
      }
      await accounts.reconciliation.finish(account.id)

      starting = closing
      done += 1
    }
  }
  log(options, `Reconciled ${done} statements, through ${RECONCILED_THROUGH}`)
}

const monthEnd = (month: string) =>
  new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10)

/** The book's own balances against the generator's, so a seed that drifts is caught here and not in a test. */
async function checkBalances(accounts: AccountsService, created: Map<AccountKey, Account>, ledger: ReturnType<typeof generate>) {
  for (const spec of ACCOUNTS) {
    const account = created.get(spec.key)!
    const balances = await accounts.balances(account.id)
    // The open month's held-back rows are in the generator's closing figure but not in the book
    const heldBack = ledger.entries
      .filter(entry => !entry.inBook && (entry.account === spec.key || entry.transferTo === spec.key))
      .reduce((total, entry) => total + (entry.account === spec.key ? entry.amount : -entry.amount), 0)

    const expected = ledger.closing[spec.key] - heldBack
    if (balances.current !== expected) {
      throw new Error(`${spec.name} closed at ${balances.current}, but the generator says ${expected}`)
    }
  }
}

// ---- The bank files -----------------------------------------------------------------------------

function specsFor(ledger: ReturnType<typeof generate>, openMonth: string): StatementSpec[] {
  const byMonth = monthlyBalances(ledger)
  const account = (key: AccountKey): SeedAccount => ACCOUNTS.find(a => a.key === key)!
  const previousMonth = monthsBetween(PERIOD.from.slice(0, 7), openMonth).slice(-2)[0]

  const spec = (
    key: AccountKey, month: string, format: StatementSpec['format'], file: string, note: string
  ): StatementSpec => ({
    file,
    format,
    account: account(key),
    month,
    rows: statementRows(ledger, key, month),
    closingBalance: byMonth.get(month)![key],
    note
  })

  return [
    spec('personal.chequing', openMonth, 'ofx-sgml', `ofx/personal-chequing-${openMonth}.ofx`,
      'OFX 1.0.2 (SGML, Windows-1252): the open month, with rows the household has not entered yet'),
    spec('personal.chequing', previousMonth, 'ofx-xml', `ofx/personal-chequing-${previousMonth}.ofx`,
      'OFX 2.1.1 (XML): a month already reconciled, so every row should be found and none written'),
    spec('personal.visa', openMonth, 'qfx', `qfx/personal-visa-${openMonth}.qfx`,
      'QFX (Quicken Web Connect): a credit card, with Intuit’s extension tags'),
    spec('business.chequing', openMonth, 'qbo', `qbo/business-chequing-${openMonth}.qbo`,
      'QBO (QuickBooks Web Connect): the business account, transfers included'),
    spec('personal.savings', openMonth, 'csv-debit-credit', `csv/personal-savings-${openMonth}.csv`,
      'CSV with separate debit and credit columns, a title line above the header and a total below'),
    spec('business.tax', openMonth, 'csv-signed', `csv/business-tax-${openMonth}.csv`,
      'CSV with one signed amount column, ISO dates and a UTF-8 BOM'),
    spec('personal.chequing', openMonth, 'qif-microsoft', `qif/personal-chequing-${openMonth}.qif`,
      'QIF, Microsoft dialect: full names, M/D/YYYY dates, an !Account block, cleared marks, Windows-1252 — the migration path off Money'),
    spec('personal.visa', openMonth, 'qif-standard', `qif/personal-visa-${openMonth}.qif`,
      'QIF, standard dialect: a credit card, names truncated to fifteen characters, M/D\'YY dates')
  ]
}

async function writeStatements(options: Options, ledger: ReturnType<typeof generate>) {
  const specs = specsFor(ledger, options.openMonth)
  const manifest: ManifestEntry[] = []

  for (const spec of specs) {
    const file = path.join(options.fixturesDir, spec.file)
    await fs.promises.mkdir(path.dirname(file), { recursive: true })
    await fs.promises.writeFile(file, render(spec))
    manifest.push(manifestEntry(spec))
    log(options, `  ${spec.file.padEnd(44)} ${String(spec.rows.length).padStart(3)} rows`)
  }

  const file = path.join(options.fixturesDir, 'manifest.json')
  await fs.promises.writeFile(file, JSON.stringify({
    generatedBy: 'npm run seed:book',
    book: BOOK_NAME,
    period: PERIOD,
    reconciledThrough: RECONCILED_THROUGH,
    openMonth: options.openMonth,
    seed: options.seed,
    note:
      'Generated, not anonymised: no real person’s money is in here. Rebuild with `npm run seed:book`. ' +
      'The counts below are what a reader should find; `inBook` rows should match something in the seeded ' +
      'book, and `notInBook` rows should import as new.',
    statements: manifest
  }, null, 2) + '\n')
  log(options, `  manifest.json`)
  return manifest
}

// ---- Entry point ---------------------------------------------------------------------------------

function parseArgs(argv: string[]): Options {
  const options: Options = {
    bookPath: path.resolve('private/Household.tessera'),
    fixturesDir: path.resolve('tests/fixtures/exchange'),
    seed: 20_260_101,
    openMonth: PERIOD.to.slice(0, 7),
    quiet: false,
    statementsOnly: false
  }
  for (let at = 0; at < argv.length; at += 1) {
    const arg = argv[at]
    const value = () => argv[++at]
    if (arg === '--book') options.bookPath = path.resolve(value())
    else if (arg === '--fixtures') options.fixturesDir = path.resolve(value())
    else if (arg === '--seed') options.seed = Number(value())
    else if (arg === '--quiet') options.quiet = true
    else if (arg === '--statements-only') options.statementsOnly = true
    else if (arg === '--help' || arg === '-h') { usage(); process.exit(0) }
    else throw new Error(`unknown option: ${arg}`)
  }
  return options
}

function usage() {
  console.log(`
Builds the “Household” test book and the bank files that go with it.

  npm run seed:book                        the book in private/, the statements in tests/fixtures/exchange/
  npm run seed:book -- --book path.tessera write the book somewhere else
  npm run seed:book -- --statements-only   rewrite only the statement fixtures
  npm run seed:book -- --seed 12345        a different, but still repeatable, household

The book covers ${PERIOD.from} to ${PERIOD.to} and is reconciled through ${RECONCILED_THROUGH}.
It is written through the real plugins, so it opens in the app as any other book does.
`.trim())
}

export async function main(argv: string[]) {
  const options = parseArgs(argv)
  const started = Date.now()

  if (options.statementsOnly) {
    log(options, 'Statements')
    await writeStatements(options, generate(options.seed, options.openMonth))
    log(options, `Done in ${((Date.now() - started) / 1000).toFixed(1)}s`)
    return
  }

  const { ledger } = await buildBook(options)
  log(options, 'Statements')
  await writeStatements(options, ledger)
  log(options, `Done in ${((Date.now() - started) / 1000).toFixed(1)}s`)
}
