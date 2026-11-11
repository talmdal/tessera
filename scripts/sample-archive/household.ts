// A sample ledger and its archive file, for trying archives by hand: "Household", with nearly four years of a made-up
// household's money (January 2023 to October 2026) in a chequing account, a savings account and a Visa card, reconciled
// month by month to September 2026, then archived before 1 January 2026 as File › Archive Ledger… will archive it.
//
// Built through the real ledger session, accounts service and SQLite engine, so the files are always in step with the
// code: an archive can't be migrated (it opens read-only), so a file kept in the repository would stop opening as soon
// as a plugin's data changed. `npm run sample:archive` runs it (scripts/sample-archive.mts), and a test runs it too
// (tests/plugins/ledger/sampleArchive.test.ts), so it can't quietly stop working.
//
// What the archive leaves behind, to see in the app: an old cheque never cashed, a Visa charge cleared but not yet
// reconciled, and a transfer to savings whose savings side isn't reconciled, all from before the archive date; a closed
// account with nothing left (removed); and a closed store card written off with a balance (kept, with a note).
import fs from 'node:fs'
import path from 'node:path'
import { KitStorageEngine } from '@tessera/storage-kit'
import type { AppState, ShellFiles, ShellPrompts } from '@tessera/types'
import { LEDGER_ARCHIVES_FOLDER, LEDGER_FILE_EXTENSION, LEDGER_SCHEMA_POINT, type ArchiveOutcome } from '@tessera/ledger-api'
import { ACCOUNTS_MIGRATOR_SERVICE, categoryLabel, type AccountInput, type TransactionDraft } from '@tessera/accounts-api'
import { IMPORT_MIGRATOR_SERVICE } from '@tessera/import-api'
import { ExtensionRegistryImpl } from '../../core/extensions/ExtensionRegistry'
import { ServiceRegistryImpl } from '../../core/services/ServiceRegistry'
import { createPluginState } from '../../core/state/PluginState'
import { AccountsServiceImpl } from '../../plugins/accounts/src/privileged/AccountsServiceImpl'
import { ACCOUNTS_SCHEMA, accountsMigrator } from '../../plugins/accounts/src/privileged/schema'
import { importArchiver } from '../../plugins/import/src/privileged/archive'
import { IMPORT_SCHEMA, importMigrator } from '../../plugins/import/src/privileged/schema'
import { ArchiveService } from '../../plugins/ledger/src/privileged/archive/ArchiveService'
import { ARCHIVE_SETTINGS } from '../../plugins/ledger/src/privileged/archive/settings'
import { BackupService } from '../../plugins/ledger/src/privileged/backup/BackupService'
import { BACKUP_SETTINGS } from '../../plugins/ledger/src/privileged/backup/settings'
import { nodeDisk } from '../../plugins/ledger/src/privileged/disk'
import { LedgerSessionImpl } from '../../plugins/ledger/src/privileged/LedgerSessionImpl'
import { RecentLedgers } from '../../plugins/ledger/src/privileged/RecentLedgers'
import { SchemaRegistry } from '../../plugins/ledger/src/privileged/SchemaRegistry'
import { sqliteDriver } from '../../plugins/storage.sqlite/src/privileged/SqliteDriver'

export const SAMPLE_LEDGER = 'Household'
export const ARCHIVE_BEFORE = '2026-01-01'
/** "Today" for the sample: the archive date must not be after it, and the sample's history ends just before. */
const TODAY = new Date(2026, 10, 10, 12)

export interface SampleFiles {
  ledger: string
  archive: string
}

/** Where the sample's two files go in `folder`. */
export function sampleFiles(folder: string): SampleFiles {
  return {
    ledger: path.join(folder, SAMPLE_LEDGER + LEDGER_FILE_EXTENSION),
    archive: path.join(folder, LEDGER_ARCHIVES_FOLDER, `${SAMPLE_LEDGER} (archive before ${ARCHIVE_BEFORE}).tesserabkp`)
  }
}

export interface SampleArchive extends SampleFiles {
  /** What the archive removed, as the ledger recorded it. */
  outcome: ArchiveOutcome
  /** What the Archive dialog would have said before archiving: its warnings and notes, in order. */
  said: string[]
}

const dollars = (amount: number) => Math.round(amount * 100)
const pad = (n: number) => String(n).padStart(2, '0')
const iso = (year: number, month: number, day: number) => `${year}-${pad(month)}-${pad(day)}`
const lastDay = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate()
/** A steady, made-up wobble, so amounts vary from month to month without being random. */
const wobble = (i: number, spread: number) => (i * 7919) % spread

/** The months from January 2023 to October 2026, each with its index from 0. */
function months(): { year: number, month: number, i: number }[] {
  const all: { year: number, month: number, i: number }[] = []
  for (let year = 2023, month = 1, i = 0; year < 2026 || month <= 10; i++) {
    all.push({ year, month, i })
    if (++month > 12) { month = 1; year++ }
  }
  return all
}

const SIDE_SUFFIXES = ['-wal', '-shm', '-journal']

/**
 * Makes the sample in `folder`: `Household.tessera` (archived), and `Archives/Household (archive before 2026-01-01)
 * .tesserabkp`. Refuses to overwrite either unless `replace`; with it, removes only those two files (and the ledger's
 * side files). If anything fails, what it made is removed again. Takes a few seconds.
 */
export async function makeSampleArchive(folder: string, options: { replace?: boolean, log?: (line: string) => void } = {}): Promise<SampleArchive> {
  const files = sampleFiles(path.resolve(folder))
  const say = options.log ?? (() => {})
  const remove = (file: string) => { for (const f of [file, ...SIDE_SUFFIXES.map(s => file + s)]) fs.rmSync(f, { force: true }) }
  for (const file of [files.ledger, files.archive]) {
    if (!fs.existsSync(file)) continue
    if (!options.replace) throw new Error(`${file} is already there. Delete it, or run again with --replace.`)
    remove(file)
  }
  fs.mkdirSync(path.dirname(files.archive), { recursive: true })

  // The ledger and accounts plugins' own code, wired as the app wires it, on the real SQLite engine and disk
  const quiet = { info() {}, warn: (...a: unknown[]) => say(`warning: ${a.join(' ')}`), error: (...a: unknown[]) => say(`error: ${a.join(' ')}`) }
  const extensions = new ExtensionRegistryImpl()
  const services = new ServiceRegistryImpl()
  extensions.contribute('accounts', LEDGER_SCHEMA_POINT, 'accounts', ACCOUNTS_SCHEMA)
  extensions.contribute('import', LEDGER_SCHEMA_POINT, 'import', IMPORT_SCHEMA)
  services.provide('accounts', ACCOUNTS_MIGRATOR_SERVICE, accountsMigrator)
  services.provide('import', IMPORT_MIGRATOR_SERVICE, importMigrator)
  const state = new Map<string, unknown>()
  const appState: AppState = {
    get: async <T>(key: string, defaultFn?: () => T) => (state.has(key) ? state.get(key) : defaultFn?.()) as T | undefined,
    set: async (key, value) => { state.set(key, value) },
    update: async () => {},
    remove: async key => { state.delete(key) }
  }
  const engine = new KitStorageEngine(sqliteDriver({ directory: path.join(path.resolve(folder), '.storage') }))
  const shellFiles = { trash: async () => {}, documentsPath: () => folder } as unknown as ShellFiles
  const disk = nodeDisk()
  const ledgerState = createPluginState('ledger', () => appState)
  const session = new LedgerSessionImpl({
    engine, files: shellFiles,
    prompts: { confirm: async () => true } as unknown as ShellPrompts,
    recent: new RecentLedgers(ledgerState),
    schema: new SchemaRegistry(extensions, services, quiet),
    disk, log: quiet, now: () => TODAY
  })
  // File › Archive Ledger…'s own service, with the sample's folder as the backup folder: the archive file goes in its
  // Archives folder
  const backups = new BackupService({
    session, engine, files: shellFiles, disk, state: ledgerState, log: quiet, now: () => TODAY,
    settings: () => ({ ...BACKUP_SETTINGS.defaults, folder: path.resolve(folder) })
  })
  const archives = new ArchiveService({ session, backups, disk, settings: () => ARCHIVE_SETTINGS.defaults, log: quiet, now: () => TODAY })
  const accounts = new AccountsServiceImpl({ session, log: quiet, today: () => '2026-11-10', now: () => TODAY.toISOString() })
  session.participate('accounts', accounts.participant)
  session.participateInArchive('accounts', accounts.archiver)
  session.participateInArchive('import', importArchiver({ changed: () => {} }))

  try {
    await session.create(files.ledger)
    say(`Making ${files.ledger}…`)
    const categories = await accounts.categories.list()
    const category = (label: string) => {
      const found = categories.find(c => categoryLabel(categories, c.id) === label)
      if (!found) throw new Error(`No category “${label}”`)
      return found.id
    }
    const open = (input: Partial<AccountInput> & Pick<AccountInput, 'name' | 'type'>) => accounts.createAccount({
      subLedgerId: null, currency: 'CAD', openingDate: '2023-01-01', openingBalance: 0, ...input
    })
    const chequing = await open({ name: 'Chequing', type: 'chequing', institution: 'Maple Trust Bank', accountNumber: '8812340187', openingBalance: dollars(2500) })
    const savings = await open({ name: 'Savings', type: 'savings', institution: 'Maple Trust Bank', openingBalance: dollars(8000), minimumBalance: dollars(5000), showAvailableBalance: true })
    const visa = await open({ name: 'Visa', type: 'creditCard', institution: 'Northwind Card Services', creditLimit: dollars(5000) })
    const oldSavings = await open({ name: 'Old Savings', type: 'savings', institution: 'Harbour Bank', openingBalance: dollars(1200) })
    const storeCard = await open({ name: 'Store Card', type: 'creditCard', institution: 'Lakeside Department Store' })
    const t = (id: string) => accounts.transactions(id)

    // ---- Every month's money, oldest first
    let cheque = 101
    for (const { year, month, i } of months()) {
      const day = (d: number) => iso(year, month, d)
      const end = day(lastDay(year, month))
      const groceries = [3, 10, 17, 24].map((d, w) => ({
        date: day(d), amount: -(dollars(80) + wobble(i * 4 + w, 6000)), payee: w % 2 === 0 ? 'Metro' : 'Loblaws', categoryId: category('Food : Groceries')
      }))
      await t(chequing.id).createMany([
        { date: day(1), amount: dollars(2450), payee: 'Northern Lights Payroll', categoryId: category('Salary') },
        { date: day(1), amount: -dollars(1450), payee: 'Landlord', number: String(cheque++), categoryId: category('Housing : Rent') },
        { date: day(15), amount: dollars(2450), payee: 'Northern Lights Payroll', categoryId: category('Salary') },
        { date: day(20), amount: -(dollars(60) + wobble(i, 6000)), payee: 'Hydro One', categoryId: category('Utilities : Electricity') },
        { date: day(16), amount: -dollars(300), payee: 'Savings', transferAccountId: savings.id },
        ...groceries
      ] as TransactionDraft[])
      const purchases: TransactionDraft[] = [
        { date: day(6), amount: -(dollars(35) + wobble(i, 4000)), payee: 'The Keg', categoryId: category('Food : Dining out') },
        { date: day(12), amount: -(dollars(55) + wobble(i + 1, 3000)), payee: 'Petro-Canada', categoryId: category('Transportation : Fuel') },
        { date: day(18), amount: -(dollars(25) + wobble(i + 2, 5000)), payee: 'Amazon', categoryId: category('Personal : Clothing') },
        { date: day(25), amount: -(dollars(55) + wobble(i + 3, 3000)), payee: 'Petro-Canada', categoryId: category('Transportation : Fuel') }
      ]
      await t(visa.id).createMany(purchases)
      // Paid in full every month, from chequing
      await t(chequing.id).create({ date: day(27), amount: purchases.reduce((sum, p) => sum + p.amount, 0), payee: 'Northwind Card Services', transferAccountId: visa.id })
      await t(savings.id).create({ date: end, amount: dollars(5) + (i * 7) % 400, payee: 'Interest', categoryId: category('Interest') })
      if (year === 2023 || (year === 2024 && month <= 2)) await t(oldSavings.id).create({ date: end, amount: dollars(3), payee: 'Interest', categoryId: category('Interest') })
      if (year === 2023 && month >= 2 && month <= 6) {
        const owed = [12000, 8000, 15000, 6000, 9000][month - 2]
        const paid = [10000, 8000, 12000, 6000, 9783][month - 2]     // 42.17 short in all, written off when it closed
        await t(storeCard.id).create({ date: day(10), amount: -owed, payee: 'Lakeside Department Store', categoryId: category('Personal : Clothing') })
        await t(chequing.id).create({ date: day(21), amount: -paid, payee: 'Lakeside Department Store', transferAccountId: storeCard.id })
      }
    }
    // Old Savings is emptied into Savings, and closed
    const oldBalance = (await accounts.balances(oldSavings.id)).current
    await t(oldSavings.id).create({ date: '2024-03-15', amount: -oldBalance, payee: 'Savings', transferAccountId: savings.id })

    // ---- What stays unsettled before the archive date
    const uncashed = await t(chequing.id).create({ date: '2025-11-20', amount: -dollars(185), payee: 'Plumber', number: '900', memo: 'Never cashed' })
    const spoiled = await t(chequing.id).create({ date: '2024-08-10', amount: -dollars(75), payee: 'Cheque spoiled', number: '899' })
    await t(chequing.id).setVoided([spoiled.id], true)
    // Cleared once the statements were reconciled (a cleared transaction counts as ticked on a statement)
    const bookstore = await t(visa.id).create({ date: '2025-12-22', amount: -dollars(45), payee: 'Bookstore', categoryId: category('Education') })
    const topUp = await t(chequing.id).create({ date: '2025-12-30', amount: -dollars(500), payee: 'Savings', transferAccountId: savings.id, memo: 'Year-end top-up' })
    const topUpSavingsSide = (await t(savings.id).list({ from: '2025-12-30', to: '2025-12-30' })).find(x => x.transferId === topUp.transferId)!
    const unsettled = new Set([uncashed.id, bookstore.id, topUpSavingsSide.id])

    // ---- Reconciled against each month's statement, to September 2026
    say('Reconciling each month’s statements…')
    for (const account of [chequing, savings, visa, oldSavings, storeCard]) {
      for (const { year, month } of months()) {
        if (year === 2026 && month > 9) break
        const from = iso(year, month, 1), to = iso(year, month, lastDay(year, month))
        const marked = (await t(account.id).list({ from, to })).filter(x => !x.voided && x.status !== 'reconciled' && !unsettled.has(x.id))
        if (marked.length === 0) continue
        const starting = (await accounts.balances(account.id)).reconciled
        await accounts.reconciliation.begin(account.id, {
          statementDate: to, startingBalance: starting, statementBalance: starting + marked.reduce((sum, x) => sum + x.amount, 0),
          reconcilerId: 'accounts.reconcile.statement'
        })
        await accounts.reconciliation.mark(account.id, marked.map(x => x.id), true)
        await accounts.reconciliation.finish(account.id)
      }
    }
    await t(visa.id).setStatus([bookstore.id], 'cleared')
    await accounts.closeAccount(oldSavings.id, { closedOn: '2024-03-31' })
    await accounts.closeAccount(storeCard.id, { closedOn: '2024-06-30', confirm: ['closeWithBalance'] })

    // ---- Archived by File › Archive Ledger…'s service: the archive file first, made and checked as a backup, then the
    // removal
    const said = (await session.describeArchive(ARCHIVE_BEFORE)).flatMap(part => [
      ...(part.warnings ?? []).flatMap(w => [w.message, ...(w.details ?? [])]), ...(part.notes ?? [])
    ])
    say(`Archiving before ${ARCHIVE_BEFORE}…`)
    const outcome = await archives.run(ARCHIVE_BEFORE, {})
    if (outcome.copy.path !== files.archive) throw new Error(`The archive file is ${outcome.copy.path}, not ${files.archive}`)
    return { ...files, outcome, said }
  } catch (err) {
    await session.close().catch(() => {})
    remove(files.ledger)
    remove(files.archive)
    throw err
  } finally {
    await session.close().catch(() => {})
    accounts.dispose()
    fs.rmSync(path.join(path.resolve(folder), '.storage'), { recursive: true, force: true })
  }
}
