// The register while reconciling: only the transactions a statement can include (not yet reconciled, not void), the
// ones dated after the statement set apart. Ticking one marks it as on the statement (cleared). An amount that
// differs from the statement can be corrected in place, and a transaction that never happened can be voided.
import { KeyboardEvent, ReactNode, useRef, useState } from 'react'
import {
  ACCOUNTS_CHANNELS, amountToInput, formatAmount,
  type Account, type AccountsResult, type Confirmation, type PatchTransactionRequest, type ReconcileCandidate,
  type ReconcileState, type Transaction, type TransactionsRequest
} from '@tessera/accounts-api'
import {
  Box, Checkbox, Icon, IconButton, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TextField, Tooltip, Typography
} from '@tessera/ui'
import { em, showDate } from '../display'
import { columnsFor, correctedAmount } from '../register/model'
import { reconcile } from './useReconcile'

/** Runs a request, asking the user when the plugin needs a confirmation. Undefined if the user said no. */
export type WithConfirmation = <T>(run: (confirm: Confirmation[]) => Promise<AccountsResult<T>>) => Promise<AccountsResult<T> | undefined>

interface AmountEdit { id: string, text: string, problem?: string }

interface Props {
  state: ReconcileState
  withConfirmation: WithConfirmation
  /** Shows why something couldn't be done. */
  onProblem(message: string): void
  /** The register's new-entry row, for what the statement shows that the register doesn't (a fee, say). */
  entry?: ReactNode
}

export function ReconcileList({ state, withConfirmation, onProblem, entry }: Props) {
  const { account, candidates, reconciliation } = state
  const columns = columnsFor(account)
  const onStatement = candidates.filter(c => !c.afterStatement)
  const later = candidates.filter(c => c.afterStatement)
  const order = [...onStatement, ...later].map(c => c.transaction.id)
  const [selected, setSelected] = useState<string | undefined>(order[0])
  const [editing, setEditing] = useState<AmountEdit>()
  const [busy, setBusy] = useState(false)
  const tableRef = useRef<HTMLDivElement>(null)
  // The amount field saves on Enter and on leaving it; these keep the two from saving twice, or after Escape
  const editingRef = useRef<AmountEdit>()
  const savingRef = useRef(false)
  const edit = (next: AmountEdit | undefined) => { editingRef.current = next; setEditing(next) }
  const startEdit = (t: Transaction) => { setSelected(t.id); edit({ id: t.id, text: amountToInput(Math.abs(t.amount), account.currency) }) }

  const run = async <T,>(work: () => Promise<AccountsResult<T> | undefined>): Promise<AccountsResult<T> | undefined> => {
    setBusy(true)
    try {
      const result = await work()
      if (result && !result.ok) onProblem(result.error.message)
      return result
    } catch (err) {
      onProblem(String((err as Error)?.message ?? err))
      return undefined
    } finally {
      setBusy(false)
    }
  }

  const toggle = (candidate: ReconcileCandidate) =>
    void run(() => reconcile.mark(account.id, [candidate.transaction.id], !candidate.marked))

  const markAll = (group: ReconcileCandidate[], marked: boolean) => {
    const ids = group.filter(c => c.marked !== marked).map(c => c.transaction.id)
    if (ids.length > 0) void run(() => reconcile.mark(account.id, ids, marked))
  }

  const voidIt = (transaction: Transaction) => void run(() => withConfirmation(confirm =>
    window.api.invoke<AccountsResult<void>>(ACCOUNTS_CHANNELS.setVoided,
      { accountId: account.id, ids: [transaction.id], voided: true, confirm } satisfies TransactionsRequest)))

  const saveAmount = async (transaction: Transaction) => {
    const current = editingRef.current
    if (!current || current.id !== transaction.id || savingRef.current) return
    const { amount, problem } = correctedAmount(transaction.amount, current.text, account.currency)
    if (amount === undefined) { edit({ ...current, problem }); return }
    if (amount === transaction.amount) { edit(undefined); return }
    savingRef.current = true
    let result: AccountsResult<Transaction> | undefined
    try {
      result = await run(() => withConfirmation(confirm =>
        window.api.invoke<AccountsResult<Transaction>>(ACCOUNTS_CHANNELS.patchTransaction,
          { accountId: account.id, id: transaction.id, patch: { amount }, expectedRev: transaction.rev, confirm } satisfies PatchTransactionRequest)))
    } finally {
      savingRef.current = false
    }
    if (result?.ok || result?.error.code === 'CONFLICT') {
      edit(undefined)
      tableRef.current?.focus()
    }
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (editing || event.target !== tableRef.current) return
    const index = selected === undefined ? -1 : order.indexOf(selected)
    const candidate = candidates.find(c => c.transaction.id === selected)
    const handled = (() => {
      switch (event.key) {
        case 'ArrowDown': if (index < order.length - 1) setSelected(order[index + 1]); return true
        case 'ArrowUp': if (index > 0) setSelected(order[index - 1]); return true
        case 'Home': setSelected(order[0]); return true
        case 'End': setSelected(order[order.length - 1]); return true
        case ' ': if (candidate) toggle(candidate); return true
        case 'F2': case 'Enter':
          if (candidate) startEdit(candidate.transaction)
          return true
        default: return false
      }
    })()
    if (handled) event.preventDefault()
  }

  const line = (candidate: ReconcileCandidate) => {
    const t = candidate.transaction
    const isEditing = editing?.id === t.id
    const amount = formatAmount(t.amount, account.currency, { sign: 'never', currency: false })
    const amountCell = (shows: boolean) => {
      if (!shows) return <TableCell />
      if (isEditing) {
        return (
          <TableCell align="right" sx={{ py: 0 }}>
            <TextField
              size="small" margin="none" autoFocus value={editing.text} disabled={busy}
              error={editing.problem !== undefined} title={editing.problem}
              onChange={event => edit({ id: t.id, text: event.target.value })}
              onKeyDown={event => {
                if (event.key === 'Enter') { event.preventDefault(); void saveAmount(t) }
                if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); edit(undefined); tableRef.current?.focus() }
              }}
              onBlur={() => void saveAmount(t)}
              slotProps={{ htmlInput: { inputMode: 'decimal', 'aria-label': `Amount of ${candidate.payeeName ?? 'the transaction'}`, style: { textAlign: 'right' } } }}
            />
          </TableCell>
        )
      }
      return (
        <TableCell align="right" sx={{ typography: 'numeric', cursor: 'text' }} title="Click to correct the amount"
          onClick={event => { event.stopPropagation(); startEdit(t) }}>
          {amount}
        </TableCell>
      )
    }
    return (
      <TableRow key={t.id} hover selected={selected === t.id} onClick={() => setSelected(t.id)} data-row={t.id}
        data-marked={candidate.marked || undefined}
        sx={{ cursor: 'default', '& td': { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }}>
        <TableCell padding="checkbox" align="center">
          <Checkbox size="small" checked={candidate.marked} disabled={busy}
            onClick={event => event.stopPropagation()}
            onChange={() => { setSelected(t.id); toggle(candidate) }}
            slotProps={{ input: { 'aria-label': `${candidate.payeeName ?? 'Transaction'} on ${showDate(t.date)} is on the statement` } }} />
        </TableCell>
        <TableCell>{t.number}</TableCell>
        <TableCell>{showDate(t.date)}</TableCell>
        <TableCell title={t.memo}>{candidate.payeeName}</TableCell>
        <TableCell sx={{ color: candidate.categoryLabel ? undefined : 'text.secondary' }}>{candidate.categoryLabel ?? ''}</TableCell>
        {amountCell(t.amount < 0)}
        {amountCell(t.amount >= 0)}
        <TableCell align="right" sx={{ py: 0 }}>
          <Tooltip title="Correct the amount">
            <span>
              <IconButton size="small" aria-label="Correct the amount" disabled={busy || isEditing}
                onClick={event => { event.stopPropagation(); startEdit(t) }}>
                <Icon name="Edit" fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
          <Tooltip title="Void: it never happened">
            <span>
              <IconButton size="small" aria-label="Void" disabled={busy} onClick={event => { event.stopPropagation(); voidIt(t) }}>
                <Icon name="Block" fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
        </TableCell>
      </TableRow>
    )
  }

  const heading = (label: string, group: ReconcileCandidate[], detail?: string) => (
    <TableRow data-group={label}>
      <TableCell padding="checkbox" align="center">
        {group.length > 0 && (
          <Checkbox size="small" disabled={busy}
            checked={group.every(c => c.marked)} indeterminate={group.some(c => c.marked) && !group.every(c => c.marked)}
            onChange={() => markAll(group, !group.every(c => c.marked))}
            slotProps={{ input: { 'aria-label': `Mark every transaction ${label.toLowerCase()}` } }} />
        )}
      </TableCell>
      <TableCell colSpan={7}>
        <Typography variant="subtitle2" component="span">{label}</Typography>
        {detail && <Typography variant="body2" component="span" color="text.secondary" sx={{ ml: 1 }}>{detail}</Typography>}
      </TableCell>
    </TableRow>
  )

  return (
    <TableContainer ref={tableRef} tabIndex={0} onKeyDown={onKeyDown} aria-label={`Transactions to reconcile in ${account.name}`}
      sx={{ flex: 1, minHeight: 0, overflow: 'auto', '&:focus-visible': { outline: 2, outlineColor: 'primary.main', outlineOffset: -2 } }}
      data-reconciling={account.id}>
      {/* Widths in em, so they grow with the Tables and registers font and never cut an amount short (see `em`) */}
      <Table size="small" stickyHeader aria-label={`Reconcile ${account.name}`} sx={{ tableLayout: 'fixed', minWidth: em(820) }}>
        <colgroup>
          <col style={{ width: em(48) }} /><col style={{ width: em(80) }} /><col style={{ width: em(150) }} /><col /><col />
          <col style={{ width: em(125) }} /><col style={{ width: em(125) }} /><col style={{ width: em(88) }} />
        </colgroup>
        <TableHead>
          <TableRow>
            <TableCell padding="checkbox"><Tooltip title="On the statement"><span>✓</span></Tooltip></TableCell>
            <TableCell>Num</TableCell>
            <TableCell>Date</TableCell>
            <TableCell>Payee</TableCell>
            <TableCell>Category</TableCell>
            <TableCell align="right">{columns.decrease}</TableCell>
            <TableCell align="right">{columns.increase}</TableCell>
            <TableCell />
          </TableRow>
        </TableHead>
        <TableBody>
          {heading('Up to the statement date', onStatement, showDate(reconciliation.statementDate))}
          {onStatement.map(line)}
          {onStatement.length === 0 && (
            <TableRow><TableCell /><TableCell colSpan={7} sx={{ color: 'text.secondary' }}>Every transaction up to the statement date is reconciled.</TableCell></TableRow>
          )}
          {later.length > 0 && heading('After the statement date', later, 'Usually on the next statement')}
          {later.map(line)}
          {entry}
        </TableBody>
      </Table>
      <Box sx={{ p: 2 }}>
        <Typography variant="body2" color="text.secondary">
          Space marks the selected transaction; Enter corrects its amount. Something on the statement that isn’t here, such as a fee? Enter it in the last row, then mark it.
        </Typography>
      </Box>
    </TableContainer>
  )
}
