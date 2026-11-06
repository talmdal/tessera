// The register: one account's transactions, one line each, with a running balance. Enter edits the selected row in
// place; the new-entry row at the bottom adds one. Space clears, Delete deletes, Ctrl+Shift+V voids; the toolbar and
// a row's context menu do the same. While the account is being reconciled, the register lists only what the
// statement can include (see ../reconcile/ReconcileList).
// Other plugins can mark rows (accounts.register.annotations): a second line under the row, up to two buttons in a
// Review column, more actions in the row's menu, and a bar above the table while rows need review. F8 and Shift+F8 go
// through those rows; Ctrl+Enter and Ctrl+Shift+Enter run the selected row's first and second buttons.
import { KeyboardEvent, MouseEvent, useEffect, useMemo, useRef, useState } from 'react'
import {
  ACCOUNTS_CHANNELS, ACCOUNTS_COMMANDS, ACCOUNTS_EVENTS, ACCOUNTS_VIEWS, ACCOUNT_TYPE_LABELS, STATUS_LETTERS, formatAmount,
  maskAccountNumber, shownRunningBalance, showsAvailable, todayIso,
  type Account, type AccountsResult, type AnnotationAction, type Category, type Chart, type Confirmation, type ReconcileActionArgs,
  type RegisterRow, type RegisterView, type ResolvedReconcileAction, type ResolvedRowAnnotation, type SaveTransactionRequest,
  type Transaction, type TransactionsRequest
} from '@tessera/accounts-api'
import {
  Alert, Box, Button, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, Divider, Icon, ListItemIcon,
  ListItemText, Menu, MenuItem, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Toolbar, Tooltip, Typography
} from '@tessera/ui'
import { runCommand } from '../bridge'
import { Balance, showDate } from '../display'
import { ReconcileList } from '../reconcile/ReconcileList'
import { useReconcileState } from '../reconcile/useReconcile'
import {
  categoryChoices, columnsFor, draftFrom, emptyDraft, isDirty, nextAfter, toTransactionDraft, toggledStatus,
  type Draft, type DraftField
} from './model'
import { AnnotationLine, annotationId, reviewBar } from './AnnotationLine'
import { ReviewBar } from './ReviewBar'
import { TransactionEditor } from './TransactionEditor'
import { useRegisterData } from './useRegister'

const NEW = 'new'
const NO_ANNOTATIONS: RegisterView['annotations'] = { rows: [], summaries: [] }
const OPENING = 'opening'

export default function Register() {
  const { snapshot, chart, categories, reload } = useRegisterData()

  if (snapshot === undefined) {
    return <Stack sx={{ p: 3, alignItems: 'center' }}><CircularProgress size={20} aria-label="Loading the register" /></Stack>
  }
  if (snapshot === null) {
    return (
      <Stack sx={{ p: 3 }} data-accounts-page="register">
        <Typography variant="h6" component="h1">Register</Typography>
        <Typography color="text.secondary">Choose an account in the Accounts panel to see its transactions.</Typography>
      </Stack>
    )
  }
  return <AccountRegister key={snapshot.account.id} snapshot={snapshot} chart={chart ?? null} categories={categories} reload={reload} />
}

interface Question { title: string, message: string, confirmLabel: string, destructive?: boolean, resolve(yes: boolean): void }

function AccountRegister({ snapshot, chart, categories, reload }: { snapshot: RegisterView, chart: Chart | null, categories: Category[], reload(): void }) {
  const { account, rows, balances } = snapshot
  const columns = columnsFor(account)
  const editable = !account.closed
  // With "show the balance above the minimum" on, the running balance is shown above the minimum too
  const available = showsAvailable(account)
  const accounts: Account[] = useMemo(() => chart?.accounts.map(s => s.account) ?? [], [chart])
  const choices = useMemo(() => categoryChoices(categories, accounts, account), [categories, accounts, account])

  // Other plugins' marks on the rows. Their buttons need an account that can change: a closed one shows marks only
  // (A reply without any is a register nobody marks: marks decorate it, and must never stop it showing)
  const annotations = snapshot.annotations ?? NO_ANNOTATIONS
  const marks = useMemo(() => new Map(annotations.rows.map(mark => [mark.transactionId, mark])), [annotations])
  const toReview = rows.filter(row => marks.get(row.transaction.id)?.review).map(row => row.transaction.id)
  const reviewColumn = editable && annotations.rows.some(mark => mark.buttons.length > 0)
  const columnCount = reviewColumn ? 9 : 8

  const lastRow = rows[rows.length - 1]
  const defaults = () => ({ date: lastRow?.transaction.date ?? todayIso(), number: '' })
  const [selected, setSelected] = useState<string>(editable ? NEW : rows[rows.length - 1]?.transaction.id ?? OPENING)
  const [editing, setEditing] = useState<{ draft: Draft, original: Draft } | null>(null)
  const [entry, setEntry] = useState<Draft>(() => emptyDraft(defaults()))
  const [entryKey, setEntryKey] = useState(0)
  const [focus, setFocus] = useState<DraftField | undefined>()
  const [problems, setProblems] = useState<{ target: string, fields: Partial<Record<DraftField, string>>, error?: string }>()
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string>()
  const [question, setQuestion] = useState<Question>()
  const [menu, setMenu] = useState<{ top: number, left: number }>()
  const [reconcileMenu, setReconcileMenu] = useState<HTMLElement>()
  const tableRef = useRef<HTMLDivElement>(null)

  // Reconciling: the statement's list replaces the register until it is completed, paused or cancelled
  const reconciliation = useReconcileState(account.id)
  const reconciling = reconciliation && !reconciliation.reconciliation.paused ? reconciliation : undefined
  const paused = reconciliation && reconciliation.reconciliation.paused ? reconciliation.reconciliation : undefined

  // The reconciliation options other plugins add (and the built-in statement one), for this account
  const [actions, setActions] = useState<{ account: ResolvedReconcileAction[], transaction: ResolvedReconcileAction[] }>({ account: [], transaction: [] })
  useEffect(() => {
    let live = true
    const load = (scope: 'account' | 'transaction') =>
      window.api.invoke<ResolvedReconcileAction[]>(ACCOUNTS_CHANNELS.reconcileActions, { accountId: account.id, scope }).catch(() => [])
    void Promise.all([load('account'), load('transaction')]).then(([forAccount, forTransaction]) => {
      if (live) setActions({ account: forAccount ?? [], transaction: forTransaction ?? [] })
    })
    return () => { live = false }
  }, [account.id, account.closed, chart, reconciliation?.reconciliation.paused])

  const runAction = (action: ResolvedReconcileAction, transactionIds?: string[]) => {
    setMenu(undefined)
    setReconcileMenu(undefined)
    const args: ReconcileActionArgs = { accountId: account.id, ...(transactionIds && { transactionIds }) }
    runCommand(action.command, args).catch(err => setNotice(String((err as Error)?.message ?? err)))
  }

  /** Runs a plugin's action on a row; a failure it reports (a result that isn't ok, or an error) shows as a notice. */
  const runAnnotation = (action: AnnotationAction) => {
    setMenu(undefined)
    runCommand<unknown>(action.command, action.args).then(result => {
      const failed = result as { ok?: unknown, error?: { message?: unknown } } | null | undefined
      if (failed?.ok === false) setNotice(String(failed.error?.message ?? 'That didn’t work.'))
    }, err => setNotice(String((err as Error)?.message ?? err)))
  }

  /** Selects the next row to review after the selection (or the previous one), going round, and shows it. */
  const goToReview = (step: 1 | -1) => {
    if (toReview.length === 0) return
    const at = order.indexOf(selected)
    const positions = toReview.map(id => order.indexOf(id))
    const next = step === 1
      ? toReview[positions.findIndex(p => p > at)] ?? toReview[0]
      : toReview[positions.map((p, i) => [p, i] as const).filter(([p]) => p < at).pop()?.[1] ?? toReview.length - 1]
    void select(next)
    document.querySelector(`[data-row="${next}"]`)?.scrollIntoView?.({ block: 'nearest' })
    tableRef.current?.focus()
  }

  // New Transaction from the menu: to the entry row
  useEffect(() => window.api.on(ACCOUNTS_EVENTS.newTransaction, () => {
    if (!editable) return
    setEditing(null)
    setSelected(NEW)
    setFocus('date')
    setEntryKey(k => k + 1)
  }), [editable])

  const ask = (q: Omit<Question, 'resolve'>) => new Promise<boolean>(resolve => setQuestion({ ...q, resolve }))

  /**
   * Runs a request; when the plugin asks for a confirmation (a reconciled transaction), asks the user and runs it again
   * with it. Resolves the result, or undefined if the user said no.
   */
  const withConfirmation = async <T,>(run: (confirm: Confirmation[]) => Promise<AccountsResult<T>>, confirm: Confirmation[] = []): Promise<AccountsResult<T> | undefined> => {
    const result = await run(confirm)
    if (!result.ok && result.error.code === 'CONFIRMATION_REQUIRED' && result.error.reasons) {
      const yes = await ask({ title: 'Change a reconciled transaction?', message: result.error.message, confirmLabel: 'Change It' })
      return yes ? withConfirmation(run, [...confirm, ...result.error.reasons]) : undefined
    }
    return result
  }

  const save = async (target: string, draft: Draft) => {
    const { transaction, problems: fields } = toTransactionDraft(draft, account.currency)
    if (!transaction) { setProblems({ target, fields }); return false }
    setBusy(true)
    try {
      const result = await withConfirmation(confirm => window.api.invoke<AccountsResult<Transaction>>(ACCOUNTS_CHANNELS.saveTransaction, {
        accountId: account.id, draft: transaction, confirm,
        ...(draft.id !== undefined && { id: draft.id, expectedRev: draft.rev })
      } satisfies SaveTransactionRequest))
      if (!result) return false
      if (!result.ok) {
        if (result.error.code === 'CONFLICT') { setEditing(null); setNotice(result.error.message); reload(); return false }
        const field = result.error.field === 'category' || result.error.field === 'amount' || result.error.field === 'date' ||
          result.error.field === 'payee' || result.error.field === 'number' || result.error.field === 'memo' ? result.error.field : undefined
        setProblems({ target, fields: field ? { [field]: result.error.message } : {}, ...(field ? {} : { error: result.error.message }) })
        return false
      }
      setProblems(undefined)
      setNotice(undefined)
      if (target === NEW) {
        // Ready for the next one: the same date, and the next cheque number when this one had a number
        setEntry(emptyDraft({ date: draft.date, number: nextAfter(draft.number) }))
        setEntryKey(k => k + 1)
        setFocus('date')
      } else {
        setEditing(null)
        setSelected(result.value.id)
        tableRef.current?.focus()
      }
      return true
    } catch (err) {
      setProblems({ target, fields: {}, error: String((err as Error)?.message ?? err) })
      return false
    } finally {
      setBusy(false)
    }
  }

  const startEditing = (row: RegisterRow) => {
    if (!editable) { setNotice(`“${account.name}” is closed. Reopen it to change its transactions.`); return }
    const draft = draftFrom(row, account, choices)
    setEditing({ draft, original: draft })
    setProblems(undefined)
    setFocus('date')
    setSelected(row.transaction.id)
  }

  /** Leaving an edited row saves it, as Money does; a row that can't be saved stays open. */
  const select = async (id: string) => {
    if (editing && id !== editing.draft.id) {
      if (isDirty(editing.draft, editing.original) && !(await save(editing.draft.id!, editing.draft))) return
      setEditing(null)
    }
    setSelected(id)
  }

  const request = (path: string, body: Omit<TransactionsRequest, 'accountId' | 'confirm'>) =>
    withConfirmation(confirm => window.api.invoke<AccountsResult<void>>(path, { accountId: account.id, confirm, ...body } satisfies TransactionsRequest))
      .then(result => { if (result && !result.ok) setNotice(result.error.message) })

  const selectedRow = rows.find(r => r.transaction.id === selected)
  const toggleCleared = (row = selectedRow) => {
    if (row && editable) void request(ACCOUNTS_CHANNELS.setStatus, { ids: [row.transaction.id], status: toggledStatus(row.transaction.status) })
  }
  const toggleVoid = (row = selectedRow) => {
    if (row && editable) void request(ACCOUNTS_CHANNELS.setVoided, { ids: [row.transaction.id], voided: !row.transaction.voided })
  }
  const remove = async (row = selectedRow) => {
    if (!row || !editable) return
    const other = row.transaction.transferAccountId !== undefined ? accounts.find(a => a.id === row.transaction.transferAccountId)?.name : undefined
    const yes = await ask({
      title: 'Delete this transaction?',
      message: other ? `It is a transfer: its other side, in “${other}”, is deleted too.` : 'This can’t be undone.',
      confirmLabel: 'Delete', destructive: true
    })
    if (!yes) return
    const index = rows.indexOf(row)
    await request(ACCOUNTS_CHANNELS.deleteTransactions, { ids: [row.transaction.id] })
    setSelected(rows[index + 1]?.transaction.id ?? rows[index - 1]?.transaction.id ?? (editable ? NEW : OPENING))
  }

  // Keys on the table when no row is being edited
  const order = [OPENING, ...rows.map(r => r.transaction.id), ...(editable ? [NEW] : [])]
  const onKeyDown = (event: KeyboardEvent) => {
    if (editing || event.target !== tableRef.current) return
    const index = order.indexOf(selected)
    const handled = (() => {
      if (event.key === 'F8') { goToReview(event.shiftKey ? -1 : 1); return true }
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        // The selected row's first button, or with Shift its second
        const action = editable ? marks.get(selected)?.buttons[event.shiftKey ? 1 : 0] : undefined
        if (action) runAnnotation(action)
        return true
      }
      switch (event.key) {
        case 'ArrowDown': if (index < order.length - 1) void select(order[index + 1]); return true
        case 'ArrowUp': if (index > 0) void select(order[index - 1]); return true
        case 'Home': void select(order[0]); return true
        case 'End': void select(order[order.length - 1]); return true
        case 'Enter':
          if (selectedRow) startEditing(selectedRow)
          else if (selected === NEW) { setFocus('date'); setEntryKey(k => k + 1) }
          return true
        case ' ': toggleCleared(); return true
        case 'Delete': void remove(); return true
        case 'Insert': void select(NEW); setFocus('date'); setEntryKey(k => k + 1); return true
        default:
          if ((event.key === 'v' || event.key === 'V') && event.ctrlKey && event.shiftKey) { toggleVoid(); return true }
          return false
      }
    })()
    if (handled) event.preventDefault()
  }

  const onContextMenu = (event: MouseEvent, row: RegisterRow) => {
    event.preventDefault()
    void select(row.transaction.id)
    setMenu({ top: event.clientY, left: event.clientX })
  }

  const problemsFor = (target: string) => problems?.target === target ? problems : undefined
  const newEntry = () => { void select(NEW); setFocus('date'); setEntryKey(k => k + 1) }

  const entryRow = editable && (
    <TransactionEditor
      key={`new-${entryKey}`}
      draft={entry}
      onChange={update => { setEntry(update); if (selected !== NEW) void select(NEW) }}
      account={account} choices={choices}
      problems={problemsFor(NEW)?.fields ?? {}} error={problemsFor(NEW)?.error}
      busy={busy} focus={selected === NEW ? focus : undefined} isNew
      onSave={() => void save(NEW, entry)}
      onCancel={() => { setEntry(emptyDraft(defaults())); setEntryKey(k => k + 1); setProblems(undefined) }}
    />
  )

  // The toolbar's row actions act on the selected transaction
  const actionable = editable && selectedRow !== undefined && !editing
  const isCleared = selectedRow !== undefined && (selectedRow.transaction.status === 'cleared' || selectedRow.transaction.status === 'reconciled')
  const reconcileActions = actions.account

  return (
    <Stack sx={{ height: '100%', minHeight: 0 }} data-accounts-page="register">
      <Stack direction="row" spacing={2} sx={{ px: 2, pt: 1.5, pb: 1, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <Box sx={{ flex: 1, minWidth: 200 }}>
          <Typography variant="h6" component="h1">{account.name}</Typography>
          <Typography variant="body2" color="text.secondary">
            {[ACCOUNT_TYPE_LABELS[account.type], account.institution, maskAccountNumber(account.accountNumber), account.closed ? 'closed' : undefined].filter(Boolean).join(' · ')}
          </Typography>
        </Box>
        <Figure label="Current" minor={balances.current} currency={account.currency} />
        <Figure label="Cleared" minor={balances.cleared} currency={account.currency} />
        {account.minimumBalance !== undefined && (
          <Figure label={`Available (above ${formatAmount(account.minimumBalance, account.currency)})`} minor={balances.available} currency={account.currency} />
        )}
      </Stack>

      <Toolbar variant="dense" disableGutters role="toolbar" aria-label="Register actions"
        sx={{ px: 2, gap: 0.5, minHeight: 40, flexWrap: 'wrap', borderBottom: 1, borderColor: 'divider' }}>
        <Button size="small" startIcon={<Icon name="Add" />} disabled={!editable} onClick={newEntry}>New</Button>
        {!reconciling && <>
          <Tooltip title="Edit the selected transaction (Enter)">
            <span><Button size="small" startIcon={<Icon name="Edit" />} disabled={!actionable} onClick={() => selectedRow && startEditing(selectedRow)}>Edit</Button></span>
          </Tooltip>
          <Tooltip title="Space">
            <span><Button size="small" startIcon={<Icon name="Check" />} disabled={!actionable} onClick={() => toggleCleared()}>{isCleared ? 'Mark Uncleared' : 'Mark Cleared'}</Button></span>
          </Tooltip>
          <Tooltip title="Ctrl+Shift+V">
            <span><Button size="small" startIcon={<Icon name="Block" />} disabled={!actionable} onClick={() => toggleVoid()}>{selectedRow?.transaction.voided ? 'Unvoid' : 'Void'}</Button></span>
          </Tooltip>
          <Tooltip title="Delete">
            <span><Button size="small" startIcon={<Icon name="Delete" />} disabled={!actionable} onClick={() => void remove()}>Delete</Button></span>
          </Tooltip>
        </>}
        <Box sx={{ flex: 1 }} />
        {reconciling
          ? <Button size="small" variant="outlined" startIcon={<Icon name="Check" />}
              onClick={() => void runCommand('shell.layout.reveal', ACCOUNTS_VIEWS.reconcile).catch(() => undefined)}>Reconcile Panel</Button>
          : reconcileActions.length === 1
            ? <Tooltip title={reconcileActions[0].description ?? ''}>
                <span><Button size="small" variant="outlined" startIcon={<Icon name="Check" />} disabled={!reconcileActions[0].enabled || !editable}
                  onClick={() => runAction(reconcileActions[0])}>{paused ? 'Resume Reconciling…' : 'Reconcile…'}</Button></span>
              </Tooltip>
            : reconcileActions.length > 1 && (
                <Button size="small" variant="outlined" startIcon={<Icon name="Check" />} endIcon={<Icon name="ExpandMore" />} disabled={!editable}
                  aria-haspopup="menu" onClick={event => setReconcileMenu(event.currentTarget)}>Reconcile</Button>
              )}
      </Toolbar>

      {!editable && <Alert severity="info" sx={{ mx: 2, my: 1 }}>This account is closed, so its transactions can’t be changed. Reopen it to change them.</Alert>}
      {paused && !reconciling && (
        <Alert severity="info" sx={{ mx: 2, my: 1 }} data-note="paused"
          action={editable && <Button color="inherit" size="small" onClick={() => void runCommand(ACCOUNTS_COMMANDS.reconcileStatement, { accountId: account.id } satisfies ReconcileActionArgs).catch(err => setNotice(String(err?.message ?? err)))}>Resume</Button>}>
          Reconciling with the statement of {showDate(paused.statementDate)} is paused. The transactions you marked stay marked.
        </Alert>
      )}
      {notice && <Alert severity="warning" sx={{ mx: 2, my: 1 }} onClose={() => setNotice(undefined)}>{notice}</Alert>}
      {!reconciling && (toReview.length > 0 || annotations.summaries.length > 0) && (
        <ReviewBar count={toReview.length} summaries={annotations.summaries} editable={editable}
          onNext={() => goToReview(1)} onRun={runAnnotation} />
      )}

      {reconciling
        ? <ReconcileList state={reconciling} withConfirmation={withConfirmation} onProblem={setNotice} entry={entryRow} />
        : <TableContainer ref={tableRef} tabIndex={0} onKeyDown={onKeyDown} aria-label={`Transactions in ${account.name}`}
        sx={{ flex: 1, minHeight: 0, overflow: 'auto', '&:focus-visible': { outline: 2, outlineColor: 'primary.main', outlineOffset: -2 } }}>
        <Table size="small" stickyHeader aria-label={`Register of ${account.name}`} sx={{ tableLayout: 'fixed', minWidth: 820 }}>
          <colgroup>
            <col style={{ width: 36 }} /><col style={{ width: 80 }} /><col style={{ width: 150 }} /><col /><col />
            <col style={{ width: 115 }} /><col style={{ width: 115 }} /><col style={{ width: 130 }} />
            {reviewColumn && <col style={{ width: 210 }} />}
          </colgroup>
          <TableHead>
            <TableRow>
              <TableCell><Tooltip title="Status: C cleared, E electronically cleared, R reconciled, V void"><span>St</span></Tooltip></TableCell>
              <TableCell>Num</TableCell>
              <TableCell>Date</TableCell>
              <TableCell>Payee</TableCell>
              <TableCell>Category</TableCell>
              <TableCell align="right">{columns.decrease}</TableCell>
              <TableCell align="right">{columns.increase}</TableCell>
              <TableCell align="right">
                {available
                  ? <Tooltip title={`The balance above the minimum of ${formatAmount(account.minimumBalance!, account.currency)}`}><span>Available</span></Tooltip>
                  : 'Balance'}
              </TableCell>
              {reviewColumn && <TableCell>Review</TableCell>}
            </TableRow>
          </TableHead>
          <TableBody>
            <TableRow selected={selected === OPENING} onClick={() => void select(OPENING)} data-row="opening">
              <TableCell /><TableCell />
              <TableCell>{showDate(account.openingDate)}</TableCell>
              <TableCell colSpan={4} sx={{ color: 'text.secondary' }}>Opening balance</TableCell>
              <TableCell align="right">
                <Balance minor={available ? account.openingBalance - account.minimumBalance! : account.openingBalance} currency={account.currency} />
              </TableCell>
            </TableRow>

            {rows.map(row => row.transaction.id === editing?.draft.id
              ? (
                <TransactionEditor
                  key={row.transaction.id}
                  draft={editing.draft}
                  onChange={update => setEditing(current => current && { ...current, draft: update(current.draft) })}
                  account={account} choices={choices}
                  problems={problemsFor(row.transaction.id)?.fields ?? {}} error={problemsFor(row.transaction.id)?.error}
                  busy={busy} focus={focus} isNew={false}
                  onSave={() => void save(row.transaction.id, editing.draft)}
                  onCancel={() => { setEditing(null); setProblems(undefined); tableRef.current?.focus() }}
                />
              )
              : (() => {
                const mark = marks.get(row.transaction.id)
                const described = mark !== undefined && mark.detail.parts.length > 0
                return [
                  <TransactionLine
                    key={row.transaction.id} row={row} account={account} selected={selected === row.transaction.id}
                    mark={mark} described={described} reviewColumn={reviewColumn}
                    onSelect={() => void select(row.transaction.id)}
                    onEdit={() => startEditing(row)}
                    onToggle={() => toggleCleared(row)}
                    onContextMenu={event => onContextMenu(event, row)}
                    onRun={runAnnotation}
                  />,
                  described && (
                    <AnnotationLine
                      key={`${row.transaction.id}-annotation`} mark={mark} columns={columnCount} selected={selected === row.transaction.id}
                      onSelect={() => void select(row.transaction.id)} onContextMenu={event => onContextMenu(event, row)}
                    />
                  )
                ]
              })())}

            {entryRow}
          </TableBody>
        </Table>
      </TableContainer>}

      <Menu open={menu !== undefined} onClose={() => setMenu(undefined)} anchorReference="anchorPosition" anchorPosition={menu}>
        {selectedRow && editable && [
          <MenuItem key="edit" onClick={() => { setMenu(undefined); startEditing(selectedRow) }}>
            <ListItemIcon><Icon name="Edit" fontSize="small" /></ListItemIcon><ListItemText>Edit</ListItemText>
          </MenuItem>,
          <MenuItem key="clear" onClick={() => { setMenu(undefined); toggleCleared() }}>
            <ListItemIcon><Icon name="Check" fontSize="small" /></ListItemIcon>
            <ListItemText>{selectedRow.transaction.status === 'cleared' || selectedRow.transaction.status === 'reconciled' ? 'Mark Uncleared' : 'Mark Cleared'}</ListItemText>
          </MenuItem>,
          <MenuItem key="void" onClick={() => { setMenu(undefined); toggleVoid() }}>
            <ListItemIcon><Icon name="Block" fontSize="small" /></ListItemIcon><ListItemText>{selectedRow.transaction.voided ? 'Unvoid' : 'Void'}</ListItemText>
          </MenuItem>,
          <MenuItem key="delete" onClick={() => { setMenu(undefined); void remove() }}>
            <ListItemIcon><Icon name="Delete" fontSize="small" /></ListItemIcon><ListItemText>Delete…</ListItemText>
          </MenuItem>,
          ...actions.transaction.map(action => (
            <MenuItem key={action.id} disabled={!action.enabled} title={action.description} onClick={() => runAction(action, [selectedRow.transaction.id])}>
              <ListItemIcon>{action.icon && !action.icon.startsWith('./') && <Icon name={action.icon} fontSize="small" />}</ListItemIcon>
              <ListItemText>{action.label}</ListItemText>
            </MenuItem>
          )),
          // What plugins offer for this row: its buttons too, so they can be reached from the keyboard menu
          ...annotationMenu(marks.get(selectedRow.transaction.id)).map(action => action === 'divider'
            ? <Divider key="annotations" />
            : (
              <MenuItem key={`annotation-${action.id}`} title={action.tooltip} onClick={() => runAnnotation(action)}>
                <ListItemIcon>{action.icon && <Icon name={action.icon} fontSize="small" />}</ListItemIcon>
                <ListItemText>{action.label}</ListItemText>
              </MenuItem>
            ))
        ]}
      </Menu>

      <Menu open={reconcileMenu !== undefined} anchorEl={reconcileMenu} onClose={() => setReconcileMenu(undefined)}>
        {reconcileActions.map(action => (
          <MenuItem key={action.id} disabled={!action.enabled} title={action.description} onClick={() => runAction(action)}>
            <ListItemIcon>{action.icon && !action.icon.startsWith('./') && <Icon name={action.icon} fontSize="small" />}</ListItemIcon>
            <ListItemText>{action.label}</ListItemText>
          </MenuItem>
        ))}
      </Menu>

      <Dialog open={question !== undefined} onClose={() => { question?.resolve(false); setQuestion(undefined) }} aria-labelledby="register-question">
        <DialogTitle id="register-question">{question?.title}</DialogTitle>
        <DialogContent><Typography>{question?.message}</Typography></DialogContent>
        <DialogActions>
          <Button autoFocus={question?.destructive} onClick={() => { question?.resolve(false); setQuestion(undefined) }}>Cancel</Button>
          <Button autoFocus={!question?.destructive} variant="contained" color={question?.destructive ? 'error' : 'primary'}
            onClick={() => { question?.resolve(true); setQuestion(undefined) }}>{question?.confirmLabel}</Button>
        </DialogActions>
      </Dialog>
    </Stack>
  )
}

function Figure({ label, minor, currency }: { label: string, minor: number, currency: string }) {
  return (
    <Box sx={{ textAlign: 'right' }}>
      <Typography variant="caption" color="text.secondary" component="div">{label}</Typography>
      <Typography variant="subtitle1" component="div"><Balance minor={minor} currency={currency} /></Typography>
    </Box>
  )
}

/** A row's annotation actions for its context menu, set apart from the register's own. */
function annotationMenu(mark: ResolvedRowAnnotation | undefined): (AnnotationAction | 'divider')[] {
  const all = mark ? [...mark.buttons, ...mark.menu] : []
  return all.length > 0 ? ['divider', ...all] : []
}

/** One transaction, on one line; a plugin's mark adds a bar at its edge and buttons in the Review column. */
function TransactionLine({ row, account, selected, mark, described, reviewColumn, onSelect, onEdit, onToggle, onContextMenu, onRun }: {
  row: RegisterRow, account: Account, selected: boolean
  mark?: ResolvedRowAnnotation
  /** A second line follows, which describes this row. */
  described: boolean
  reviewColumn: boolean
  onSelect(): void, onEdit(): void, onToggle(): void, onContextMenu(event: MouseEvent): void
  onRun(action: AnnotationAction): void
}) {
  const t = row.transaction
  const amount = formatAmount(t.amount, account.currency, { sign: 'never', currency: false })
  const struck = t.voided ? { textDecoration: 'line-through', color: 'text.disabled' } : {}
  const letter = t.voided ? STATUS_LETTERS.voided : STATUS_LETTERS[t.status]
  return (
    <TableRow
      hover selected={selected} onClick={onSelect} onDoubleClick={onEdit} onContextMenu={onContextMenu}
      data-row={t.id} data-voided={t.voided || undefined} data-review={mark?.review || undefined}
      aria-describedby={described ? annotationId(t.id) : undefined}
      sx={{
        cursor: 'default', '& td': { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
        // Joined to its second line: no rule between them
        ...(described && { '& > td': { borderBottom: 0 } }),
        ...(mark?.review && reviewBar(mark.tone))
      }}
    >
      <TableCell align="center" onClick={event => { if (selected) { event.stopPropagation(); onToggle() } }}
        title={t.voided ? 'Void' : t.status === 'uncleared' ? 'Uncleared' : `${t.status[0].toUpperCase()}${t.status.slice(1)}`}>
        {letter}
      </TableCell>
      <TableCell>{t.number}</TableCell>
      <TableCell>{showDate(t.date)}</TableCell>
      <TableCell title={t.memo}>{row.payeeName}</TableCell>
      <TableCell sx={{ color: row.categoryLabel ? undefined : 'text.secondary' }}>{row.categoryLabel ?? ''}</TableCell>
      <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums', ...struck }}>{t.amount < 0 ? amount : ''}</TableCell>
      <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums', ...struck }}>{t.amount > 0 ? amount : ''}</TableCell>
      <TableCell align="right"><Balance minor={shownRunningBalance(account, row)} currency={account.currency} /></TableCell>
      {reviewColumn && (
        <TableCell sx={{ py: 0.25 }}>
          {mark && mark.buttons.length > 0 && (
            <Box sx={{ display: 'flex', gap: 0.5 }}>
              {mark.buttons.map(action => (
                <Tooltip key={action.id} describeChild title={action.tooltip ?? ''}>
                  <Button size="small" variant="outlined" {...(action.icon && { startIcon: <Icon name={action.icon} /> })}
                    onClick={event => { event.stopPropagation(); onSelect(); onRun(action) }}
                    onDoubleClick={event => event.stopPropagation()}>
                    {action.label}
                  </Button>
                </Tooltip>
              ))}
            </Box>
          )}
        </TableCell>
      )}
    </TableRow>
  )
}
