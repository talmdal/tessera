// The accounts service on a real ledger session (memory engine), with its schema contributed as the plugin does.
import type { AccountInput, AccountsChange } from '@tessera/accounts-api'
import { ACCOUNTS_MIGRATOR_SERVICE } from '@tessera/accounts-api'
import { LEDGER_SCHEMA_POINT } from '@tessera/ledger-api'
import { AccountsServiceImpl } from '../../../plugins/accounts/src/privileged/AccountsServiceImpl'
import { ACCOUNTS_SCHEMA, accountsMigrator } from '../../../plugins/accounts/src/privileged/schema'
import { logger, setupSession } from '../ledger/harness'

export function chequing(over: Partial<AccountInput> = {}): AccountInput {
  return { name: 'Chequing', type: 'chequing', subLedgerId: null, currency: 'CAD', openingDate: '2026-01-01', openingBalance: 100000, ...over }
}

export interface AccountsSetup {
  /** Default true: a ledger is created and open. */
  open?: boolean
  /** The session's clock (an archive can't be dated after its today). */
  now?: () => Date
  /** How the service lets the event loop turn during an archive. */
  turn?: () => Promise<void>
}

export async function setupAccounts(options: AccountsSetup = {}) {
  const env = setupSession(options.now ? { now: options.now } : {})
  env.extensions.contribute('accounts', LEDGER_SCHEMA_POINT, 'accounts', ACCOUNTS_SCHEMA)
  env.services.provide('accounts', ACCOUNTS_MIGRATOR_SERVICE, accountsMigrator)
  const log = logger()
  const service = new AccountsServiceImpl({ session: env.session, log, today: () => '2026-11-04', ...(options.turn && { turn: options.turn }) })
  env.session.participate('accounts', service.participant)
  env.session.participateInArchive('accounts', service.archiver)
  const changes: AccountsChange[] = []
  service.onDidChange(change => changes.push(change))
  if (options.open !== false) await env.created()
  changes.length = 0
  return { ...env, service, changes, serviceLog: log }
}

/** The error a promise rejects with. */
export const rejection = (work: Promise<unknown>) => work.then(() => { throw new Error('expected a rejection') }, err => err as { code: string, message: string, field?: string, reasons?: string[] })
