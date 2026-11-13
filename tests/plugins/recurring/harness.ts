// `recurring.service` on a real book session and a real accounts service (memory engine), with both schemas
// contributed as the plugins do. Nothing is faked below the service: an entry really is written to a register.
import { ACCOUNTS_MIGRATOR_SERVICE, type AccountInput, type AccountsService } from '@tessera/accounts-api'
import { BOOK_SCHEMA_POINT } from '@tessera/book-api'
import {
  DEFAULT_REMIND_DAYS, RECURRING_MIGRATOR_SERVICE,
  type RecurringChange, type Schedule, type SeriesInput, type SeriesTemplate
} from '@tessera/recurring-api'
import { AccountsServiceImpl } from '../../../plugins/accounts/src/privileged/AccountsServiceImpl'
import { ACCOUNTS_SCHEMA, accountsMigrator } from '../../../plugins/accounts/src/privileged/schema'
import { publicService } from '../../../plugins/accounts/src/privileged/index'
import { RecurringServiceImpl } from '../../../plugins/recurring/src/privileged/RecurringServiceImpl'
import { RECURRING_SCHEMA, recurringMigrator } from '../../../plugins/recurring/src/privileged/schema'
import { logger, setupSession } from '../book/harness'

/** The day every test runs on, so "overdue" and "due soon" are fixed. A Friday. */
export const TODAY = '2026-11-13'

export function chequing(over: Partial<AccountInput> = {}): AccountInput {
  return { name: 'Chequing', type: 'chequing', subBookId: null, currency: 'CAD', openingDate: '2026-01-01', openingBalance: 500000, ...over }
}

/** Monthly on the given day, starting there. */
export const monthly = (startDate: string, over: Partial<Schedule> = {}): Schedule =>
  ({ frequency: 'monthly', interval: 1, startDate, ...over })

export const template = (over: Partial<SeriesTemplate> = {}): SeriesTemplate =>
  ({ amount: -14200, payee: 'Hydro', autoNumber: false, estimated: false, ...over })

export function seriesInput(over: Partial<SeriesInput> = {}): SeriesInput {
  return { accountId: '', template: template(), schedule: monthly('2026-11-15'), ...over }
}

export async function setupRecurring(options: { today?: string } = {}) {
  const env = setupSession()
  const today = options.today ?? TODAY
  env.extensions.contribute('accounts', BOOK_SCHEMA_POINT, 'accounts', ACCOUNTS_SCHEMA)
  env.services.provide('accounts', ACCOUNTS_MIGRATOR_SERVICE, accountsMigrator)
  env.extensions.contribute('recurring', BOOK_SCHEMA_POINT, 'recurring', RECURRING_SCHEMA)
  env.services.provide('recurring', RECURRING_MIGRATOR_SERVICE, recurringMigrator)

  const log = logger()
  const accountsImpl = new AccountsServiceImpl({ session: env.session, log, today: () => today })
  env.session.participate('accounts', accountsImpl.participant)
  const accounts: AccountsService = publicService(accountsImpl)

  const service = new RecurringServiceImpl({ session: env.session, accounts, log, today: () => today, now: () => `${today}T09:00:00.000Z` })
  const changes: RecurringChange[] = []
  service.onDidChange(change => changes.push(change))

  await env.created()
  const chq = await accounts.createAccount(chequing())
  const savings = await accounts.createAccount(chequing({ name: 'Savings', type: 'savings', openingBalance: 100000 }))
  changes.length = 0

  /** A series in Chequing, monthly, due two days from today unless told otherwise. */
  const create = (over: Partial<SeriesInput> = {}) =>
    service.create({ ...seriesInput({ accountId: chq.id }), ...over })

  return { ...env, today, accounts, accountsImpl, service, changes, chq, savings, log, create, DEFAULT_REMIND_DAYS }
}

/** The error a promise rejects with. */
export const rejection = (work: Promise<unknown>) =>
  work.then(() => { throw new Error('expected a rejection') }, err => err as { code: string, message: string, field?: string, reasons?: string[] })
