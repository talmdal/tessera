// An account's reconciliation in progress, followed from the plugin, and the requests that change it.
import { useEffect, useState } from 'react'
import {
  ACCOUNTS_CHANNELS, ACCOUNTS_EVENTS,
  type AccountsResult, type Confirmation, type ReconcileRequest, type ReconcileResult, type ReconcileState
} from '@tessera/accounts-api'

/** undefined while loading (or with no account); null when the account has no reconciliation in progress. */
export function useReconcileState(accountId: string | null | undefined): ReconcileState | null | undefined {
  const [state, setState] = useState<{ accountId: string, value: ReconcileState | null }>()

  useEffect(() => {
    if (!accountId) return
    let live = true
    let pushed = false
    // Subscribe first, then ask: a change that arrives before the reply wins, since it is newer
    const stop = window.api.on<{ accountId: string, state: ReconcileState | null }>(ACCOUNTS_EVENTS.reconcile, event => {
      if (!live || event.accountId !== accountId) return
      pushed = true
      setState({ accountId, value: event.state })
    })
    // The book closed: nothing is being reconciled
    const stopChart = window.api.on<unknown>(ACCOUNTS_EVENTS.chart, chart => {
      if (live && chart === null) setState({ accountId, value: null })
    })
    window.api.invoke<ReconcileState | null>(ACCOUNTS_CHANNELS.reconcileState, { accountId }).then(
      value => { if (live && !pushed) setState({ accountId, value }) },
      err => console.error('[accounts] Could not load the reconciliation', err))
    return () => { live = false; stop(); stopChart() }
  }, [accountId])

  return accountId && state?.accountId === accountId ? state.value : undefined
}

const call = <T,>(channel: string, request: ReconcileRequest) => window.api.invoke<AccountsResult<T>>(channel, request)

export const reconcile = {
  mark: (accountId: string, ids: string[], marked: boolean) => call<ReconcileState>(ACCOUNTS_CHANNELS.reconcileMark, { accountId, ids, marked }),
  finish: (accountId: string, confirm: Confirmation[] = []) => call<ReconcileResult>(ACCOUNTS_CHANNELS.reconcileFinish, { accountId, confirm }),
  pause: (accountId: string) => call<void>(ACCOUNTS_CHANNELS.reconcilePause, { accountId }),
  cancel: (accountId: string) => call<void>(ACCOUNTS_CHANNELS.reconcileCancel, { accountId })
}
