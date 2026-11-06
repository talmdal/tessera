// The review tests' starting point: a chequing account in which a user has typed some of October's transactions, into
// which the bank's October statement (samples/statements) is then imported; and helpers to read the import's lines,
// run the review commands with the Change Match dialog answered, and read the register's marks.
import type { LedgerSession } from '@tessera/ledger-api'
import { LEDGER_SESSION_SERVICE } from '@tessera/ledger-api'
import type { AccountInput, RegisterAnnotator, Transaction, TransactionDraft } from '@tessera/accounts-api'
import { IMPORT_ANNOTATOR_SERVICE, IMPORT_COMMANDS, IMPORT_DIALOGS, type ImportResult, type MatchDialogResult } from '@tessera/import-api'
import { collectionsOf, type StoredAlias } from '../../../plugins/import/src/privileged/store'
import { sample, setupImport, type ImportEnv } from './harness'

export const OCTOBER = sample('maple-trust-chequing-2026-10.ofx')

export const chequing = (over: Partial<AccountInput> = {}): AccountInput => ({
  name: 'Chequing', type: 'chequing', subLedgerId: null, currency: 'CAD', openingDate: '2026-09-01', openingBalance: 100000,
  accountNumber: '8812345678', ...over
})

/** The bank's ids (FITIDs) for the October lines the user typed. */
export const FIT = {
  rent: 'MT2026100201', keg: 'MT2026100301', costco: 'MT2026100601', hydro: 'MT2026100701', amazon: 'MT2026102701',
  coffee: 'MT2026102901', coffee2: 'MT2026102902', loblaws: 'MT2026101501', atm: 'MT2026100901'
}

/**
 * A chequing account with six of October's transactions typed in, as a user would: the rent cheque written days
 * before it cleared, the Keg before the tip, Costco a day early and 12 cents short, Hydro exact, Amazon two days early,
 * one of the two coffees. Then October's statement is imported.
 */
export async function typedThenImported(options: { beforeImport?: (env: ImportEnv, accountId: string) => Promise<void> } = {}) {
  const env = await setupImport()
  const account = await env.accounts.createAccount(chequing())
  const manager = env.accounts.transactions(account.id)
  const food = await env.accounts.categories.create('Food : Dining out', 'expense')
  const groceries = await env.accounts.categories.create('Food : Groceries', 'expense')
  const typed = (draft: TransactionDraft) => manager.create(draft)
  const entered = {
    rent: await typed({ date: '2026-09-28', number: '101', amount: -120000, payee: 'Landlord' }),
    keg: await typed({ date: '2026-10-03', amount: -5000, payee: 'The Keg', categoryId: food.id, memo: 'Dinner with Sam' }),
    costco: await typed({ date: '2026-10-05', amount: -8400, payee: 'Costco', categoryId: groceries.id }),
    hydro: await typed({ date: '2026-10-07', amount: -8000, payee: 'Hydro One' }),
    amazon: await typed({ date: '2026-10-25', amount: -2399, payee: 'Amazon' }),
    coffee: await typed({ date: '2026-10-29', amount: -475, payee: 'Tim Hortons' })
  }
  await options.beforeImport?.(env, account.id)
  const report = await env.manager.importFiles([OCTOBER])

  const session = env.runtime.services.get<LedgerSession>(LEDGER_SESSION_SERVICE)
  const c = () => collectionsOf(session.database('import'))
  const annotator = env.runtime.services.get<RegisterAnnotator>(IMPORT_ANNOTATOR_SERVICE)
  const line = async (importId: string) => (await c().lines.findOne({ accountId: account.id, importId }))!
  const run = (command: string, args: unknown) => env.runtime.commands.execute(command, args) as Promise<ImportResult<unknown>>
  const accept = async (importId: string) => run(IMPORT_COMMANDS.accept, { lineIds: [(await line(importId)).id] })
  /** Change… on the line's row, with the dialog answered. */
  const change = async (importId: string, answer: MatchDialogResult | undefined) => {
    env.answer(IMPORT_DIALOGS.match, answer)
    return run(IMPORT_COMMANDS.change, { lineId: (await line(importId)).id })
  }
  const get = (id: string) => manager.get(id) as Promise<Transaction>
  const marks = () => annotator.annotate(account.id)
  const mark = async (transactionId: string) => (await marks()).rows.find(r => r.transactionId === transactionId)
  const byBankId = async (importId: string) => (await manager.findByExternalIds([importId]))[0]
  const aliases = async () => (await c().aliases.find()).map(({ pattern, payeeName }: StoredAlias) => [pattern, payeeName])
  return { env, account, manager, entered, report, c, annotator, line, run, accept, change, get, marks, mark, byBankId, aliases }
}

export type Setup = Awaited<ReturnType<typeof typedThenImported>>

/** The fields Accept and Unmatch change, to compare before and after. */
export const shape = (t: Transaction | undefined) => t && { date: t.date, amount: t.amount, status: t.status, externalId: t.externalId }
