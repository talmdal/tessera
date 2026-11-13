// The export plugin as the app runs it: the ledger, accounts, import and the file-type plugins (OFX and CSV, which
// writes) with export, on a memory engine, with a ledger open (tests/plugins/import/harness.ts). Files are saved to a
// memory disk that can be told to fail. `household` fills the ledger with what the design worries about.
import { vi } from 'vitest'
import type { StorageEngine } from '@tessera/types'
import { LEDGER_BACKUP_META, LEDGER_SESSION_SERVICE, type LedgerSession } from '@tessera/ledger-api'
import type { AccountInput, TransactionDraft } from '@tessera/accounts-api'
import { EXPORT_CHANNELS, EXPORT_COMMANDS, EXPORT_DIALOGS, type ExportResult } from '@tessera/export-api'
import { createPluginContext } from '../../../core/plugins/PluginContext'
import { activate as activateExport, type ActivateOptions } from '../../../plugins/export/src/privileged/index'
import type { ExportDisk } from '../../../plugins/export/src/privileged/files'
import { decode } from '../../../plugins/import/src/privileged/files'
import { NOW, setupImport } from '../import/harness'
import { errno, file } from '../ledger/harness'

export { NOW }

/** A disk in memory. `fail` queues an error code for the next write or rename. */
export function memoryExportDisk() {
  const files = new Map<string, Uint8Array>()
  const fail: { write: string[], rename: string[] } = { write: [], rename: [] }
  const disk = {
    writeFile: vi.fn(async (at: string, bytes: Uint8Array) => {
      const code = fail.write.shift()
      if (code) throw errno(code)
      files.set(at, bytes)
    }),
    rename: vi.fn(async (from: string, to: string) => {
      const code = fail.rename.shift()
      if (code) throw errno(code)
      const bytes = files.get(from)
      if (!bytes) throw errno('ENOENT')
      files.delete(from)
      files.set(to, bytes)
    }),
    remove: vi.fn(async (at: string) => { files.delete(at) })
  } satisfies ExportDisk
  /** A saved file's text, decoded as Tessera's import decodes it. */
  const text = (at: string) => decode(files.get(at)!, 'auto')
  return { disk, files, fail, text }
}

/**
 * The export plugin beside the import harness's plugins, with the CSV, QIF and OFX file-type plugins (which read and
 * write); `csv: false`, `qif: false` and `ofx: false` leave them out.
 */
export async function setupExport(options: ActivateOptions & { csv?: boolean, qif?: boolean, ofx?: boolean } = {}) {
  const env = await setupImport({ csv: options.csv !== false, qif: options.qif !== false, ofx: options.ofx !== false })
  const store = memoryExportDisk()
  const exportLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  // Waits between tries to save take no time: each moves a clock on, so a retry budget runs out at once
  let clock = 0
  const save = { sleep: async (ms: number) => { clock += ms }, now: () => clock }
  await activateExport({ ...createPluginContext('export', env.runtime).context, logger: exportLog },
    { disk: store.disk, now: NOW, save, ...options })
  const session = env.runtime.services.get<LedgerSession>(LEDGER_SESSION_SERVICE)
  // The Save dialog made the ledger: from here on, its calls are the exports'
  env.files.showSaveDialog.mockClear()

  /** The Export dialog's answer: a function of its input, or the answer itself. */
  const answerExport = (answer: unknown) => env.answer(EXPORT_DIALOGS.export, answer)
  /** Where the Save dialog saves, for the next export; undefined cancels it. */
  const saveAs = (name: string | undefined) => env.files.showSaveDialog.mockResolvedValueOnce(name === undefined ? undefined : file(name))
  /** File › Export…. */
  const run = () => env.runtime.commands.execute(EXPORT_COMMANDS.file)
  const enabled = () => env.runtime.commands.isEnabled(EXPORT_COMMANDS.file)
  /** The Export dialog's preview, as the dialog asks for it. */
  const check = async <T>(request: unknown): Promise<ExportResult<T>> => {
    const reply = await env.runtime.ipc.dispatch({ channel: EXPORT_CHANNELS.check, data: request })
    if (!reply.ok) throw new Error(`IPC failed: ${JSON.stringify(reply)}`)
    return reply.data as ExportResult<T>
  }
  /** The messages shown, newest last. */
  const messages = () => env.prompts.message.mock.calls.map(([m]) => m)

  /**
   * File › Archive Ledger… as it runs: the archive file made first (a snapshot of the open ledger, with an archive's
   * meta), then what occurred before `before` archived. Resolves the archive file's path.
   */
  const archiveWithFile = async (before: string) => {
    const ledger = session.current!
    const at = file(`Tessera Backups/Archives/${ledger.name} (archive before ${before}).tesserabkp`)
    const takenAt = NOW().toISOString()
    const db = await env.runtime.services.get<StorageEngine>('storage.engine').open({ path: ledger.path })
    await db.snapshot({ path: at }, {
      meta: {
        [LEDGER_BACKUP_META.takenAt]: takenAt, [LEDGER_BACKUP_META.kind]: 'archive', [LEDGER_BACKUP_META.ledgerName]: ledger.name,
        [LEDGER_BACKUP_META.ledgerPath]: ledger.path, [LEDGER_BACKUP_META.takenWith]: 'export test', [LEDGER_BACKUP_META.archiveBefore]: before
      }
    })
    await env.ledger.runArchive({ before, copy: { path: at, takenAt } })
    return at
  }

  // (The memory disk's map is `saved`: `files` stays the shell's file service)
  return {
    ...env, disk: store.disk, saved: store.files, fail: store.fail, text: store.text,
    exportLog, session, answerExport, saveAs, run, enabled, check, messages, archiveWithFile
  }
}

export type ExportEnv = Awaited<ReturnType<typeof setupExport>>

/**
 * A household in 2026: Chequing (with a cheque, a transfer, a voided line, every status, a bank id and a fingerprint),
 * Savings in the sub-ledger "Family", a Visa card, a yen account, and a closed account.
 */
export async function household(env: ExportEnv) {
  const { accounts } = env
  const family = await env.session.createSubLedger({ name: 'Family', parentId: null })
  const open = (input: Partial<AccountInput> & Pick<AccountInput, 'name'>) => accounts.createAccount({
    type: 'chequing', subLedgerId: null, currency: 'CAD', openingDate: '2026-01-01', openingBalance: 0, ...input
  } as AccountInput)
  const chequing = await open({ name: 'Chequing', institution: 'Maple Trust', accountNumber: '12-345678', openingBalance: 500000 })
  const savings = await open({ name: 'Savings', type: 'savings', subLedgerId: family.id, openingBalance: 1000000 })
  const visa = await open({ name: 'Visa', type: 'creditCard', openingBalance: -25000 })
  const yen = await open({ name: 'Tokyo', currency: 'JPY', openingBalance: 100000 })
  const old = await open({ name: 'Old Account', openingDate: '2025-01-01' })
  const groceries = await accounts.categories.create('Food : Groceries', 'expense')
  const rent = await accounts.categories.create('Housing : Rent', 'expense')
  const salary = await accounts.categories.create('Income : Salary', 'income')

  const add = (accountId: string, draft: TransactionDraft) => accounts.transactions(accountId).create(draft)
  const t = {
    rent: await add(chequing.id, { date: '2026-10-01', amount: -120000, payee: 'Landlord', categoryId: rent.id, status: 'cleared' }),
    hydro: await add(chequing.id, { date: '2026-10-03', amount: -8412, payee: 'Hydro One', number: '101', memo: 'Sept, 2026 "final"' }),
    pay: await add(chequing.id, { date: '2026-10-05', amount: 250000, payee: 'Employer Inc', categoryId: salary.id, status: 'electronic', externalId: 'MT20261005-0417' }),
    transfer: await add(chequing.id, { date: '2026-10-07', amount: -50000, payee: 'Transfer', transferAccountId: savings.id }),
    cancelled: await add(chequing.id, { date: '2026-10-08', amount: -7500, payee: 'Cancelled Order', categoryId: groceries.id }),
    costco: await add(chequing.id, { date: '2026-10-14', amount: -2345, payee: '=SUM(A1:A9)', categoryId: groceries.id, externalId: 'fp:0123456789abcdef' }),
    september: await add(chequing.id, { date: '2026-09-20', amount: -1000, payee: 'Earlier', categoryId: groceries.id }),
    card: await add(visa.id, { date: '2026-10-02', amount: -14567, payee: 'Costco', categoryId: groceries.id }),
    ramen: await add(yen.id, { date: '2026-10-15', amount: -1200, payee: 'Ramen' })
  }
  await accounts.transactions(chequing.id).setStatus([t.rent.id], 'reconciled', { confirm: ['reconciled'] })
  await accounts.transactions(chequing.id).setVoided([t.cancelled.id], true)
  await accounts.closeAccount(old.id)
  return { chequing, savings, visa, yen, old, family, categories: { groceries, rent, salary }, t }
}
