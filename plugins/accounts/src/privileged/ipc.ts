// The accounts views talk to the plugin here.
import type { Disposable, IpcMessage, PluginContext } from '@tessera/types'
import type { LedgerSession } from '@tessera/ledger-api'
import { isLedgerError } from '@tessera/ledger-api'
import {
  ACCOUNTS_CHANNELS, ACCOUNTS_EVENTS, AccountsError, CLEARING_STATUSES, isAccountsError, toAccountsResult,
  type AccountPatch, type Category, type Chart, type ClearingStatus, type MoveRequest, type RegisterView,
  type AccountsChange, type PatchTransactionRequest, type ReconcileRequest, type ReconcileState, type ResolvedReconcileAction,
  type SaveAccountRequest, type SaveTransactionRequest, type Selection, type TransactionPatch, type TransactionsRequest
} from '@tessera/accounts-api'
import type { RegisterAnnotationsReader } from './annotations'
import type { ReconcileActions } from './reconcileActions'
import type { AccountsServiceImpl } from './AccountsServiceImpl'
import type { RegisterState } from './register'
import { isSelection, local, type SelectionState } from './selection'

/** What `work` reads, or `none` when no ledger is open, including one that closed while it was reading. */
async function unlessClosed<T, N>(session: LedgerSession, work: () => Promise<T>, none: N): Promise<T | N> {
  if (!session.current) return none
  try {
    return await work()
  } catch (err) {
    if (isAccountsError(err) && err.code === 'NO_LEDGER') return none
    throw err
  }
}

/** The chart, or null when no ledger is open. */
export function chartOrNull(service: AccountsServiceImpl, session: LedgerSession): Promise<Chart | null> {
  return unlessClosed(session, () => service.chart(), null)
}

/** An account's reconciliation in progress, or null when it has none (or the ledger closed). */
export function reconcileStateOrNull(service: AccountsServiceImpl, session: LedgerSession, accountId: string): Promise<ReconcileState | null> {
  return unlessClosed(session, async () => (await service.reconciliation.get(accountId).catch(err => {
    if (isAccountsError(err) && err.code === 'NOT_FOUND') return undefined
    throw err
  })) ?? null, null)
}

/**
 * Pushes what a change touched to the views: the chart (whole), the accounts whose transactions changed, categories,
 * and the reconciliation of every account whose reconciliation or transactions changed (an edited amount changes it).
 */
export async function publishChange(
  context: Pick<PluginContext, 'events' | 'logger'>, service: AccountsServiceImpl, session: LedgerSession,
  change: Pick<AccountsChange, 'chart' | 'transactions' | 'categories'> & Partial<Pick<AccountsChange, 'reconciliations'>>
) {
  try {
    if (change.chart) context.events.emit(local(ACCOUNTS_EVENTS.chart), await chartOrNull(service, session))
    if (change.transactions.length > 0) context.events.emit(local(ACCOUNTS_EVENTS.transactions), { accounts: change.transactions })
    if (change.categories) context.events.emit(local(ACCOUNTS_EVENTS.categories), await unlessClosed(session, () => service.categories.list(), []))
    for (const accountId of new Set([...(change.reconciliations ?? []), ...change.transactions])) {
      context.events.emit(local(ACCOUNTS_EVENTS.reconcile), { accountId, state: await reconcileStateOrNull(service, session, accountId) })
    }
  } catch (err) {
    context.logger.error('[accounts] Could not publish a change', err)
  }
}

const accountIdOf = (request: { accountId?: unknown } | undefined) => {
  if (typeof request?.accountId !== 'string' || request.accountId === '') throw new AccountsError('NOT_FOUND', 'That account no longer exists.')
  return request.accountId
}

const idsOf = (request: { ids?: unknown } | undefined) => {
  if (!Array.isArray(request?.ids) || request.ids.some(id => typeof id !== 'string')) throw new AccountsError('INVALID', 'Choose the transactions.', 'ids')
  return request.ids as string[]
}

export function registerIpc(
  context: PluginContext,
  service: AccountsServiceImpl,
  session: LedgerSession,
  selection: SelectionState,
  register: RegisterState,
  actions: ReconcileActions,
  annotations: RegisterAnnotationsReader
): Disposable[] {
  return [
    context.ipc.register(ACCOUNTS_CHANNELS.chart, () => chartOrNull(service, session)),

    context.ipc.register(ACCOUNTS_CHANNELS.selection, () => selection.get()),

    context.ipc.register(ACCOUNTS_CHANNELS.select, async (msg: IpcMessage<Selection>) => {
      if (!isSelection(msg.data)) throw new Error('A selection is { kind: "ledger" } or { kind, id }')
      await selection.set(msg.data)
    }),

    context.ipc.register(ACCOUNTS_CHANNELS.saveAccount, async (msg: IpcMessage<SaveAccountRequest>) => {
      const { id, input, expectedRev } = msg.data ?? {} as Partial<SaveAccountRequest>
      return toAccountsResult(() => {
        if (input === undefined) throw new AccountsError('INVALID', 'Enter the account’s details.', 'name')
        if (typeof id !== 'string') return service.createAccount(input)
        // The whole form: an optional field it leaves out was emptied, so it is cleared
        const patch: AccountPatch = {
          ...input,
          institution: input.institution ?? null, accountNumber: input.accountNumber ?? null,
          notes: input.notes ?? null, creditLimit: input.creditLimit ?? null,
          minimumBalance: input.minimumBalance ?? null, showAvailableBalance: input.showAvailableBalance ?? null
        }
        return service.updateAccount(id, patch, typeof expectedRev === 'number' ? { expectedRev } : {})
      })
    }),

    context.ipc.register(ACCOUNTS_CHANNELS.move, async (msg: IpcMessage<MoveRequest>) => {
      const { kind, id, to } = msg.data ?? {} as Partial<MoveRequest>
      return toAccountsResult(async () => {
        if (typeof id !== 'string' || (to !== null && typeof to !== 'string')) throw new AccountsError('INVALID', 'Choose where to move it.', 'to')
        if (kind === 'account') return service.moveAccount(id, to)
        try {
          return await session.moveSubLedger(id, to)
        } catch (err) {
          // The ledger's reasons (a cycle, a name taken) are the user's to see, in the dialog
          if (isLedgerError(err)) throw new AccountsError(err.code === 'NOT_FOUND' ? 'NOT_FOUND' : 'INVALID', err.message, 'to')
          throw err
        }
      })
    }),

    // ---- The register

    context.ipc.register(ACCOUNTS_CHANNELS.registerAccount, () => ({ accountId: register.get() ?? null })),

    context.ipc.register(ACCOUNTS_CHANNELS.loadRegister, async (msg: IpcMessage<{ accountId?: string }>): Promise<RegisterView | null> => {
      const accountId = msg.data?.accountId
      if (!session.current || typeof accountId !== 'string' || !(await service.get(accountId))) return null
      const snapshot = await service.transactions(accountId).register()
      // Other plugins' marks, for the rows it shows; reports asking the service for a register never see them
      return { ...snapshot, annotations: await annotations.load(accountId, snapshot.rows.map(row => row.transaction.id)) }
    }),

    context.ipc.register(ACCOUNTS_CHANNELS.saveTransaction, async (msg: IpcMessage<SaveTransactionRequest>) => {
      const request = msg.data
      return toAccountsResult(async () => {
        const manager = service.transactions(accountIdOf(request))
        if (typeof request.draft !== 'object' || request.draft === null) throw new AccountsError('INVALID', 'Enter the transaction.', 'date')
        // A bank line's id is the importer's, through the service: a view can neither set it nor clear it
        const { externalId: _bankLine, ...draft } = request.draft
        if (typeof request.id !== 'string') return manager.create(draft)
        // The whole row: an optional field it leaves out was emptied, so it is cleared
        const patch: TransactionPatch = {
          ...draft,
          number: draft.number ?? null, payee: draft.payee ?? null, memo: draft.memo ?? null,
          categoryId: draft.categoryId ?? null, transferAccountId: draft.transferAccountId ?? null
        }
        return manager.update(request.id, patch, {
          ...(typeof request.expectedRev === 'number' && { expectedRev: request.expectedRev }),
          ...(Array.isArray(request.confirm) && { confirm: request.confirm })
        })
      })
    }),

    context.ipc.register(ACCOUNTS_CHANNELS.deleteTransactions, async (msg: IpcMessage<TransactionsRequest>) =>
      toAccountsResult(() => service.transactions(accountIdOf(msg.data)).delete(idsOf(msg.data), { confirm: msg.data?.confirm ?? [] }))),

    context.ipc.register(ACCOUNTS_CHANNELS.setStatus, async (msg: IpcMessage<TransactionsRequest>) =>
      toAccountsResult(() => {
        const status = msg.data?.status
        if (!(CLEARING_STATUSES as readonly unknown[]).includes(status)) throw new AccountsError('INVALID', 'Choose a status.', 'status')
        return service.transactions(accountIdOf(msg.data)).setStatus(idsOf(msg.data), status as ClearingStatus, { confirm: msg.data?.confirm ?? [] })
      })),

    context.ipc.register(ACCOUNTS_CHANNELS.setVoided, async (msg: IpcMessage<TransactionsRequest>) =>
      toAccountsResult(() => service.transactions(accountIdOf(msg.data)).setVoided(idsOf(msg.data), msg.data?.voided === true, { confirm: msg.data?.confirm ?? [] }))),

    context.ipc.register(ACCOUNTS_CHANNELS.patchTransaction, async (msg: IpcMessage<PatchTransactionRequest>) =>
      toAccountsResult(() => {
        const request = msg.data
        if (typeof request?.id !== 'string' || typeof request.patch !== 'object' || request.patch === null) {
          throw new AccountsError('INVALID', 'Choose the transaction and what to change.', 'id')
        }
        const { externalId: _bankLine, ...patch } = request.patch   // the importer's, as for transaction.save
        return service.transactions(accountIdOf(request)).update(request.id, patch, {
          ...(typeof request.expectedRev === 'number' && { expectedRev: request.expectedRev }),
          ...(Array.isArray(request.confirm) && { confirm: request.confirm })
        })
      })),

    // ---- Reconciling

    context.ipc.register(ACCOUNTS_CHANNELS.reconcileActions, async (msg: IpcMessage<{ accountId?: string, scope?: string }>): Promise<ResolvedReconcileAction[]> => {
      const accountId = msg.data?.accountId
      const scope = msg.data?.scope === 'transaction' ? 'transaction' : 'account'
      if (typeof accountId !== 'string') return []
      const account = await unlessClosed(session, () => service.get(accountId), undefined)
      return account ? actions.for(account.type, scope) : []
    }),

    context.ipc.register(ACCOUNTS_CHANNELS.reconcileState, async (msg: IpcMessage<{ accountId?: string }>) => {
      const accountId = msg.data?.accountId
      return typeof accountId === 'string' ? reconcileStateOrNull(service, session, accountId) : null
    }),

    context.ipc.register(ACCOUNTS_CHANNELS.reconcileMark, async (msg: IpcMessage<ReconcileRequest>) =>
      toAccountsResult(() => service.reconciliation.mark(accountIdOf(msg.data), idsOf(msg.data), msg.data?.marked !== false))),

    context.ipc.register(ACCOUNTS_CHANNELS.reconcileFinish, async (msg: IpcMessage<ReconcileRequest>) =>
      toAccountsResult(() => service.reconciliation.finish(accountIdOf(msg.data), { confirm: Array.isArray(msg.data?.confirm) ? msg.data.confirm : [] }))),

    context.ipc.register(ACCOUNTS_CHANNELS.reconcilePause, async (msg: IpcMessage<ReconcileRequest>) =>
      toAccountsResult(() => service.reconciliation.pause(accountIdOf(msg.data)))),

    context.ipc.register(ACCOUNTS_CHANNELS.reconcileCancel, async (msg: IpcMessage<ReconcileRequest>) =>
      toAccountsResult(() => service.reconciliation.cancel(accountIdOf(msg.data)))),

    context.ipc.register(ACCOUNTS_CHANNELS.searchPayees, async (msg: IpcMessage<{ prefix?: string }>) =>
      session.current ? service.payees.search(typeof msg.data?.prefix === 'string' ? msg.data.prefix : '') : []),

    context.ipc.register(ACCOUNTS_CHANNELS.categories, async (): Promise<Category[]> =>
      unlessClosed(session, () => service.categories.list(), [])),

    context.ipc.register(ACCOUNTS_CHANNELS.createCategory, async (msg: IpcMessage<{ path?: string, kind?: Category['kind'] }>) =>
      toAccountsResult(() => service.categories.create(String(msg.data?.path ?? ''), msg.data?.kind as Category['kind'])))
  ]
}
