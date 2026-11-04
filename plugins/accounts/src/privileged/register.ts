// Which account the register shows. Published as context keys, so New Transaction is enabled only for an account
// that can take one, and as an event, so the register view follows.
import type { PluginContext } from '@tessera/types'
import type { BookSession } from '@tessera/book-api'
import { ACCOUNTS_CONTEXT_KEYS, ACCOUNTS_EVENTS } from '@tessera/accounts-api'
import type { AccountsServiceImpl } from './AccountsServiceImpl'
import { local } from './selection'

export class RegisterState {
  private accountId: string | undefined

  constructor(
    private readonly context: Pick<PluginContext, 'contextKeys' | 'events'>,
    private readonly accounts: AccountsServiceImpl,
    private readonly session: BookSession
  ) {}

  get(): string | undefined {
    return this.accountId
  }

  async show(accountId: string | undefined): Promise<void> {
    const before = this.accountId
    this.accountId = accountId
    await this.refresh()
    if (this.accountId !== before) this.context.events.emit(local(ACCOUNTS_EVENTS.register), { accountId: this.accountId ?? null })
  }

  /** After a change: the account may be gone (then the register shows none), or closed or reopened. */
  async refresh(): Promise<void> {
    const account = this.accountId === undefined || !this.session.current
      ? undefined
      : await this.accounts.get(this.accountId).catch(() => undefined)
    if (!account && this.accountId !== undefined) {
      this.accountId = undefined
      this.context.events.emit(local(ACCOUNTS_EVENTS.register), { accountId: null })
    }
    const keys = this.context.contextKeys
    keys.set(ACCOUNTS_CONTEXT_KEYS.registerAccount, account?.id)
    keys.set(ACCOUNTS_CONTEXT_KEYS.registerEditable, account !== undefined && !account.closed && this.session.current?.readOnly === false)
    // Reconciling: the register's account has a reconciliation under way (a paused one doesn't count)
    const reconciliation = account ? (await this.accounts.reconciliation.get(account.id).catch(() => undefined))?.reconciliation : undefined
    const active = reconciliation !== undefined && !reconciliation.paused
    keys.set(ACCOUNTS_CONTEXT_KEYS.reconciling, active ? account!.id : undefined)
    keys.set(ACCOUNTS_CONTEXT_KEYS.reconciler, active ? reconciliation!.reconcilerId : undefined)
  }
}
