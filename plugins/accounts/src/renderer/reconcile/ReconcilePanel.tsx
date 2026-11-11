// The Reconcile panel, beside the navigator while the register's account is being reconciled: the statement's
// figures, what the marked transactions come to, and the difference still to find. Complete, Pause or Cancel end it.
import { useState } from 'react'
import {
  ACCOUNTS_CHANNELS, ACCOUNTS_EVENTS, formatAmount, isLiability,
  type Account, type AccountsResult, type ReconcileState
} from '@tessera/accounts-api'
import {
  Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Divider, Icon, Stack, Typography
} from '@tessera/ui'
import { useFollowed } from '../bridge'
import { showDate } from '../display'
import { reconcile, useReconcileState } from './useReconcile'

interface Question { title: string, message: string, confirmLabel: string, cancelLabel: string, destructive?: boolean, resolve(yes: boolean): void }

/** For a credit card or loan, figures read as the statement prints them: amounts owed, positive. */
export const asStatement = (account: Pick<Account, 'type'>, minor: number) => isLiability(account.type) ? -minor : minor

export default function ReconcilePanel() {
  const shown = useFollowed<{ accountId: string | null }>(ACCOUNTS_CHANNELS.registerAccount, ACCOUNTS_EVENTS.register)
  const state = useReconcileState(shown?.accountId)
  if (!state) {
    return (
      <Stack sx={{ p: 2 }} data-accounts-page="reconcile">
        <Typography color="text.secondary" variant="body2">
          {state === null ? 'This account isn’t being reconciled.' : 'Loading…'}
        </Typography>
      </Stack>
    )
  }
  return <Reconciling key={state.account.id} state={state} />
}

function Reconciling({ state }: { state: ReconcileState }) {
  const { account, reconciliation, summary } = state
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [question, setQuestion] = useState<Question>()
  const ask = (q: Omit<Question, 'resolve'>) => new Promise<boolean>(resolve => setQuestion({ ...q, resolve }))
  const money = (minor: number) => formatAmount(minor, account.currency)
  const liability = isLiability(account.type)

  /** Runs a request, showing why it failed. Resolves the result when it worked. */
  const attempt = async <T,>(work: () => Promise<AccountsResult<T>>): Promise<AccountsResult<T> | undefined> => {
    setBusy(true)
    setError(undefined)
    try {
      const result = await work()
      if (!result.ok && result.error.code !== 'CONFIRMATION_REQUIRED') setError(result.error.message)
      return result
    } catch (err) {
      setError(String((err as Error)?.message ?? err))
      return undefined
    } finally {
      setBusy(false)
    }
  }

  const complete = async () => {
    const result = await attempt(() => reconcile.finish(account.id))
    if (result && !result.ok && result.error.code === 'CONFIRMATION_REQUIRED') {
      const yes = await ask({
        title: 'Add a balance adjustment?', message: result.error.message,
        confirmLabel: 'Add Adjustment', cancelLabel: 'Go Back'
      })
      if (yes) await attempt(() => reconcile.finish(account.id, result.error.reasons ?? ['adjustBalance']))
    }
  }

  const cancel = async () => {
    const yes = await ask({
      title: 'Cancel this reconciliation?',
      message: [
        'The transactions you marked go back to how they were, and the statement’s figures are forgotten.',
        ...(reconciliation.addedIds.length > 0 ? ['The service charge and interest added from the statement are deleted.'] : [])
      ].join(' '),
      confirmLabel: 'Cancel Reconciliation', cancelLabel: 'Keep Reconciling', destructive: true
    })
    if (yes) await attempt(() => reconcile.cancel(account.id))
  }

  const balanced = summary.difference === 0
  const ending = reconciliation.statementBalance
  const startsElsewhere = summary.starting !== summary.lastReconciledBalance

  return (
    <Stack sx={{ p: 2, gap: 1.5, height: '100%', overflow: 'auto' }} data-accounts-page="reconcile" aria-label={`Reconciling ${account.name}`}>
      <Box>
        <Typography variant="subtitle1" component="h2">Reconciling {account.name}</Typography>
        <Typography variant="body2" color="text.secondary">Statement of {showDate(reconciliation.statementDate)}</Typography>
      </Box>
      <Typography variant="body2" color="text.secondary">
        In the register, mark each transaction the statement lists by clicking its status. When the difference is zero, complete.
      </Typography>

      <Box component="dl" sx={{ m: 0, display: 'grid', gridTemplateColumns: '1fr auto', rowGap: 0.5, columnGap: 2, '& dd': { m: 0, textAlign: 'right', typography: 'numeric' } }}>
        <Typography component="dt" variant="body2">{liability ? 'Starting amount owed' : 'Starting balance'}</Typography>
        <Typography component="dd" variant="body2" data-figure="starting">{money(asStatement(account, summary.starting))}</Typography>
        <Typography component="dt" variant="body2">Marked ({summary.markedCount})</Typography>
        <Typography component="dd" variant="body2" data-figure="marked">{money(asStatement(account, summary.marked))}</Typography>
        <Typography component="dt" variant="body2">{liability ? 'Ending amount owed' : 'Ending balance'}</Typography>
        <Typography component="dd" variant="body2" data-figure="ending">{money(asStatement(account, ending))}</Typography>
      </Box>
      <Divider />
      <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
        <Typography variant="subtitle2" component="span">Difference</Typography>
        <Typography variant="subtitle1" component="span" data-figure="difference"
          sx={{ typography: 'numeric', color: balanced ? 'success.main' : 'error.main', display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
          {balanced && <Icon name="Check" fontSize="small" />}
          {money(asStatement(account, summary.difference))}
        </Typography>
      </Stack>
      {startsElsewhere && (
        <Alert severity="info" data-note="starting">
          Your records were reconciled to {money(asStatement(account, summary.lastReconciledBalance))}, not the statement’s
          starting {money(asStatement(account, summary.starting))}.
          {summary.adjustment !== 0 && ` Completing now adds an adjustment of ${money(summary.adjustment)}.`}
        </Alert>
      )}
      {error && <Alert severity="error" onClose={() => setError(undefined)}>{error}</Alert>}

      <Stack spacing={1}>
        <Button variant="contained" disabled={busy} onClick={() => void complete()} startIcon={<Icon name="Check" />}>
          Complete
        </Button>
        <Stack direction="row" spacing={1}>
          <Button sx={{ flex: 1 }} variant="outlined" disabled={busy} onClick={() => void attempt(() => reconcile.pause(account.id))}
            title="Keep the marks, and finish later">Pause</Button>
          <Button sx={{ flex: 1 }} variant="outlined" color="error" disabled={busy} onClick={() => void cancel()}>Cancel</Button>
        </Stack>
      </Stack>

      <Dialog open={question !== undefined} onClose={() => { question?.resolve(false); setQuestion(undefined) }} aria-labelledby="reconcile-question">
        <DialogTitle id="reconcile-question">{question?.title}</DialogTitle>
        <DialogContent><Typography>{question?.message}</Typography></DialogContent>
        <DialogActions>
          <Button autoFocus onClick={() => { question?.resolve(false); setQuestion(undefined) }}>{question?.cancelLabel}</Button>
          <Button variant="contained" color={question?.destructive ? 'error' : 'primary'}
            onClick={() => { question?.resolve(true); setQuestion(undefined) }}>{question?.confirmLabel}</Button>
        </DialogActions>
      </Dialog>
    </Stack>
  )
}
