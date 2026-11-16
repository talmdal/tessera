// The budget service on a real ledger session and accounts service (memory engine), with its schema contributed and
// both participants joined, as the plugin does.
import type { AccountInput, Category } from '@tessera/accounts-api'
import { LEDGER_SCHEMA_POINT } from '@tessera/ledger-api'
import { BUDGET_MIGRATOR_SERVICE, type BudgetChange, type BudgetInput, type LinePlan } from '@tessera/budget-api'
import { BudgetServiceImpl } from '../../../plugins/budget/src/privileged/BudgetServiceImpl'
import { BUDGET_SCHEMA, budgetMigrator } from '../../../plugins/budget/src/privileged/schema'
import { logger } from '../ledger/harness'
import { setupAccounts } from '../accounts/harness'

export interface BudgetSetup {
  /** Default true: a ledger is created and open. */
  open?: boolean
  /** The session's clock (an archive can't be dated after its today). */
  now?: () => Date
  turn?: () => Promise<void>
}

export async function setupBudget(options: BudgetSetup = {}) {
  const env = await setupAccounts({ open: false, ...(options.now && { now: options.now }) })
  env.extensions.contribute('budget', LEDGER_SCHEMA_POINT, 'budget', BUDGET_SCHEMA)
  env.services.provide('budget', BUDGET_MIGRATOR_SERVICE, budgetMigrator)
  const budgetLog = logger()
  const budgets = new BudgetServiceImpl({ session: env.session, accounts: env.service, log: budgetLog, now: () => '2026-11-15T12:00:00.000Z', ...(options.turn && { turn: options.turn }) })
  env.session.participate('budget', budgets.subLedgerParticipant)
  env.session.participateInArchive('budget', budgets.archiver)
  const budgetChanges: BudgetChange[] = []
  budgets.onDidChange(c => budgetChanges.push(c))
  if (options.open !== false) await env.created()
  budgetChanges.length = 0
  return { ...env, accounts: env.service, budgets, budgetChanges, budgetLog }
}

export type BudgetEnv = Awaited<ReturnType<typeof setupBudget>>

export const account = (name: string, subLedgerId: string | null, over: Partial<AccountInput> = {}): AccountInput =>
  ({ name, type: 'chequing', subLedgerId, currency: 'CAD', openingDate: '2020-01-01', openingBalance: 0, ...over })

export const monthly = (amount: number, from = '2027-01', over: Partial<LinePlan> = {}): LinePlan => ({ from, amount, frequency: 'monthly', due: from, ...over })

export const budgetInput = (over: Partial<BudgetInput> = {}): BudgetInput => ({ name: 'Household', subLedgerId: null, currency: 'CAD', yearStartMonth: 1, ...over })

/** A category by its name (unique among the starter categories). */
export const categoryNamed = (categories: Category[], name: string) => {
  const found = categories.find(c => c.name === name)
  if (!found) throw new Error(`no category ${name}`)
  return found.id
}

/**
 * The design's worked cases (docs/budget-design.md, "Actuals"): sub-ledgers Personal, Business and Rentals; Personal
 * Chequing, Savings, a Visa and a US-dollar Visa in Personal; Business Chequing; Rental Chequing.
 */
export async function household(env: BudgetEnv) {
  const { session, accounts } = env
  const personal = await session.createSubLedger({ name: 'Personal', parentId: null })
  const business = await session.createSubLedger({ name: 'Business', parentId: null })
  const rentals = await session.createSubLedger({ name: 'Rentals', parentId: null })
  const pchq = await accounts.createAccount(account('Personal Chequing', personal.id))
  const sav = await accounts.createAccount(account('Savings', personal.id, { type: 'savings' }))
  const visa = await accounts.createAccount(account('Visa', personal.id, { type: 'creditCard' }))
  const usVisa = await accounts.createAccount(account('US Visa', personal.id, { type: 'creditCard', currency: 'USD' }))
  const bchq = await accounts.createAccount(account('Business Chequing', business.id))
  const rchq = await accounts.createAccount(account('Rental Chequing', rentals.id))
  const categories = await accounts.categories.list()
  const category = (name: string) => categoryNamed(categories, name)
  const t = (id: string) => accounts.transactions(id)
  return { personal, business, rentals, pchq, sav, visa, usVisa, bchq, rchq, category, t }
}
