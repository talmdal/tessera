// The accounts service on a real book session (memory engine), with its schema contributed as the plugin does.
import type { AccountInput, AccountsChange } from '@tessera/accounts-api'
import { ACCOUNTS_MIGRATOR_SERVICE } from '@tessera/accounts-api'
import { BOOK_SCHEMA_POINT } from '@tessera/book-api'
import { AccountsServiceImpl } from '../../../plugins/accounts/src/privileged/AccountsServiceImpl'
import { ACCOUNTS_SCHEMA, accountsMigrator } from '../../../plugins/accounts/src/privileged/schema'
import { logger, setupSession } from '../book/harness'

export function chequing(over: Partial<AccountInput> = {}): AccountInput {
  return { name: 'Chequing', type: 'chequing', subBookId: null, currency: 'CAD', openingDate: '2026-01-01', openingBalance: 100000, ...over }
}

export async function setupAccounts(options: { open?: boolean } = { open: true }) {
  const env = setupSession()
  env.extensions.contribute('accounts', BOOK_SCHEMA_POINT, 'accounts', ACCOUNTS_SCHEMA)
  env.services.provide('accounts', ACCOUNTS_MIGRATOR_SERVICE, accountsMigrator)
  const log = logger()
  const service = new AccountsServiceImpl({ session: env.session, log, today: () => '2026-11-04' })
  env.session.participate('accounts', service.participant)
  const changes: AccountsChange[] = []
  service.onDidChange(change => changes.push(change))
  if (options.open !== false) await env.created()
  changes.length = 0
  return { ...env, service, changes, serviceLog: log }
}

/** The error a promise rejects with. */
export const rejection = (work: Promise<unknown>) => work.then(() => { throw new Error('expected a rejection') }, err => err as { code: string, message: string, field?: string, reasons?: string[] })
