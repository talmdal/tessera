// The Recurring view: every series' first unentered occurrence, one row each, in ascending date order — which
// puts what is overdue at the top without a sort of its own. Tick one row or many and Enter in Register writes
// them into their accounts; a row's context menu does the same and more for the row under the pointer.
//
// Everything it does runs a command, so the Accounts menu, this view and its context menu share one set of rules
// and confirmations. See docs/recurring-transactions-design.md, "The Recurring view".
import { KeyboardEvent, MouseEvent, useEffect, useMemo, useRef, useState } from 'react'
import {
  LATE_STATES, RECURRING_CHANNELS, RECURRING_COMMANDS as C, RECURRING_EVENTS,
  type EnterResult, type RecurringRow, type RecurringSnapshot
} from '@tessera/recurring-api'
import {
  Alert, Box, Button, Checkbox, Chip, CircularProgress, Divider, FormControlLabel, Icon, ListItemIcon, ListItemText,
  Menu, MenuItem, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Toolbar, Tooltip, Typography
} from '@tessera/ui'
import { runCommand, useFollowed } from './bridge'
import { Amount, DUE_STATES, showDate, showShortDate, Totals } from './display'

/** The series that can be acted on now: not blocked, and with an occurrence to act on. */
const enterable = (row: RecurringRow) => row.blockedReason === undefined && row.occurrence !== undefined &&
  row.state !== 'paused' && row.state !== 'ended'

/** What *Enter Due Transactions…* acts on: everything overdue or due today that can actually be entered. */
export const dueNow = (rows: readonly RecurringRow[]) =>
  rows.filter(row => enterable(row) && (LATE_STATES as readonly string[]).includes(row.state)).map(row => row.series.id)

export default function RecurringView() {
  const [showPaused, setShowPaused] = useState(false)
  const [showEnded, setShowEnded] = useState(false)
  const snapshot = useFollowed<RecurringSnapshot | null>(RECURRING_CHANNELS.snapshot, RECURRING_EVENTS.snapshot)
  // The pushed snapshot carries the default view; ticking a box asks for a wider one
  const [extra, setExtra] = useState<RecurringSnapshot | null>()

  useEffect(() => {
    if (!showPaused && !showEnded) { setExtra(undefined); return }
    let live = true
    window.api.invoke<RecurringSnapshot | null>(RECURRING_CHANNELS.snapshot, { includePaused: showPaused, includeEnded: showEnded })
      .then(loaded => { if (live) setExtra(loaded) }, () => { if (live) setExtra(undefined) })
    return () => { live = false }
  }, [showPaused, showEnded, snapshot])

  const shown = (showPaused || showEnded ? extra : snapshot) ?? snapshot

  if (shown === undefined) {
    return <Stack sx={{ p: 3, alignItems: 'center' }}><CircularProgress size={20} aria-label="Loading the recurring transactions" /></Stack>
  }
  if (shown === null) {
    return (
      <Stack sx={{ p: 3 }} data-recurring-page="list">
        <Typography variant="h6" component="h1">Recurring Transactions</Typography>
        <Typography color="text.secondary">Open a book to see what repeats.</Typography>
      </Stack>
    )
  }
  return (
    <List
      snapshot={shown}
      showPaused={showPaused} showEnded={showEnded}
      onShowPaused={setShowPaused} onShowEnded={setShowEnded}
    />
  )
}

function List({ snapshot, showPaused, showEnded, onShowPaused, onShowEnded }: {
  snapshot: RecurringSnapshot
  showPaused: boolean, showEnded: boolean
  onShowPaused(value: boolean): void, onShowEnded(value: boolean): void
}) {
  const { rows, summary } = snapshot
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set())
  const [selected, setSelected] = useState<string>()
  const [menu, setMenu] = useState<{ top: number, left: number }>()
  const [notice, setNotice] = useState<{ severity: 'success' | 'warning', text: string }>()
  const [busy, setBusy] = useState(false)
  const tableRef = useRef<HTMLDivElement>(null)

  const ids = useMemo(() => rows.map(row => row.series.id), [rows])
  const current = rows.find(row => row.series.id === selected) ?? rows[0]
  // A row that has gone (deleted, or hidden again) must not keep the selection or a tick
  useEffect(() => {
    const present = new Set(ids)
    setTicked(was => (([...was].every(id => present.has(id))) ? was : new Set([...was].filter(id => present.has(id)))))
    if (selected !== undefined && !present.has(selected)) setSelected(undefined)
  }, [ids, selected])

  /** What an action acts on: the ticked rows, or the one under the pointer when nothing is ticked. */
  const target = (row?: RecurringRow): string[] => {
    if (ticked.size > 0) return [...ticked]
    const one = row ?? current
    return one ? [one.series.id] : []
  }

  const run = async (command: string, args?: unknown) => {
    setMenu(undefined)
    setNotice(undefined)
    setBusy(true)
    try {
      return await runCommand(command, ...(args === undefined ? [] : [args]))
    } catch (err) {
      setNotice({ severity: 'warning', text: String((err as Error)?.message ?? err) })
      return undefined
    } finally {
      setBusy(false)
    }
  }

  const enter = async (seriesIds: string[]) => {
    if (seriesIds.length === 0) return
    const result = await run(C.enter, { ids: seriesIds }) as EnterResult | undefined
    if (!result) return                       // cancelled: say nothing
    setTicked(new Set())
    const { entered, failed } = result
    if (failed.length === 0 && entered.length > 0) {
      setNotice({ severity: 'success', text: entered.length === 1 ? '1 transaction entered.' : `${entered.length} transactions entered.` })
    } else if (failed.length > 0) {
      const reasons = failed.map(f => f.message)
      setNotice({
        severity: 'warning',
        text: `${entered.length} of ${entered.length + failed.length} entered. ${[...new Set(reasons)].join(' ')}`
      })
    }
  }

  // Enter Due Transactions… from the Accounts menu: the view does it, so the result lands where the user is looking
  useEffect(() => window.api.on(RECURRING_EVENTS.enterDue, () => { void enter(dueNow(rows)) }), [rows])

  const toggle = (id: string) => setTicked(was => {
    const next = new Set(was)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  })

  const enterableIds = rows.filter(enterable).map(row => row.series.id)
  const allTicked = enterableIds.length > 0 && enterableIds.every(id => ticked.has(id))
  const toggleAll = () => setTicked(allTicked ? new Set() : new Set(enterableIds))

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.target !== tableRef.current || !current) return
    const index = ids.indexOf(current.series.id)
    const handled = (() => {
      switch (event.key) {
        case 'ArrowDown': if (index < ids.length - 1) setSelected(ids[index + 1]); return true
        case 'ArrowUp': if (index > 0) setSelected(ids[index - 1]); return true
        case 'Home': setSelected(ids[0]); return true
        case 'End': setSelected(ids[ids.length - 1]); return true
        case ' ': if (enterable(current)) toggle(current.series.id); return true
        case 'Enter': void enter(target()); return true
        case 'Insert': void run(C.new); return true
        case 'Delete': void run(C.delete, { ids: target() }); return true
        case 'F2': void run(C.edit, { ids: [current.series.id] }); return true
        default:
          if ((event.key === 'a' || event.key === 'A') && event.ctrlKey) { toggleAll(); return true }
          return false
      }
    })()
    if (handled) event.preventDefault()
  }

  const onContextMenu = (event: MouseEvent, row: RecurringRow) => {
    event.preventDefault()
    setSelected(row.series.id)
    setMenu({ top: event.clientY, left: event.clientX })
  }

  const acting = ticked.size > 0 ? ticked.size : current ? 1 : 0
  const canEnter = ticked.size > 0 ? rows.some(r => ticked.has(r.series.id) && enterable(r)) : current !== undefined && enterable(current)
  const oldest = rows.find(row => row.state === 'overdue')

  return (
    <Stack sx={{ height: '100%', minHeight: 0 }} data-recurring-page="list">
      <Stack direction="row" spacing={2} sx={{ px: 2, pt: 1.5, pb: 1, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <Box sx={{ flex: 1, minWidth: 200 }}>
          <Typography variant="h6" component="h1">Recurring Transactions</Typography>
          <Typography variant="body2" color="text.secondary">
            {rows.length === 0 ? 'Nothing scheduled' : rows.length === 1 ? '1 scheduled' : `${rows.length} scheduled`}
          </Typography>
        </Box>
        <Figure label="Overdue" totals={summary.overdueTotals} count={summary.overdueCount} />
        <Figure label="Due soon" totals={summary.dueSoonTotals} count={summary.dueSoonCount} />
      </Stack>

      <Toolbar variant="dense" disableGutters role="toolbar" aria-label="Recurring actions"
        sx={{ px: 2, gap: 0.5, minHeight: 40, flexWrap: 'wrap', borderBottom: 1, borderColor: 'divider' }}>
        <Button size="small" startIcon={<Icon name="Add" />} onClick={() => void run(C.new)}>New</Button>
        <Tooltip title="Write the ticked transactions into their registers (Enter)">
          <span>
            <Button size="small" variant="contained" startIcon={<Icon name="Check" />} disabled={!canEnter || busy}
              onClick={() => void enter(target())}>
              Enter in Register{ticked.size > 1 ? ` (${ticked.size})` : ''}
            </Button>
          </span>
        </Tooltip>
        <Tooltip title="Edit the selected one (F2)">
          <span><Button size="small" startIcon={<Icon name="Edit" />} disabled={!current || busy}
            onClick={() => void run(C.edit, { ids: [current!.series.id] })}>Edit</Button></span>
        </Tooltip>
        <Tooltip title="Move past the next time it falls due, without entering it">
          <span><Button size="small" startIcon={<Icon name="SkipNext" />} disabled={!canEnter || busy}
            onClick={() => void run(C.skip, { ids: target() })}>Skip</Button></span>
        </Tooltip>
        <Tooltip title="Delete (Delete)">
          <span><Button size="small" startIcon={<Icon name="Delete" />} disabled={acting === 0 || busy}
            onClick={() => void run(C.delete, { ids: target() })}>Delete</Button></span>
        </Tooltip>
        <Tooltip title="The days a business-day rule steps over, besides weekends">
          <span><Button size="small" startIcon={<Icon name="CalendarToday" />} disabled={busy}
            onClick={() => void run(C.holidays)}>Holidays…</Button></span>
        </Tooltip>
        <Box sx={{ flex: 1 }} />
        <FormControlLabel
          control={<Checkbox size="small" checked={showPaused} onChange={e => onShowPaused(e.target.checked)} />}
          label={<Typography variant="body2">Show paused</Typography>} />
        <FormControlLabel
          control={<Checkbox size="small" checked={showEnded} onChange={e => onShowEnded(e.target.checked)} />}
          label={<Typography variant="body2">Show finished</Typography>} />
      </Toolbar>

      {summary.overdueCount > 0 && (
        <Alert severity="warning" sx={{ mx: 2, my: 1 }} data-note="overdue"
          action={<Button color="inherit" size="small" disabled={busy} onClick={() => void enter(dueNow(rows))}>Enter All Overdue</Button>}>
          {summary.overdueCount === 1 ? '1 transaction is overdue' : `${summary.overdueCount} transactions are overdue`}
          {oldest?.occurrence ? `, the oldest due ${showDate(oldest.occurrence.date)}.` : '.'}
        </Alert>
      )}
      {summary.overdueCount === 0 && summary.dueSoonCount > 0 && (
        <Alert severity="info" sx={{ mx: 2, my: 1 }} data-note="dueSoon">
          {summary.dueSoonCount === 1 ? '1 transaction is due soon' : `${summary.dueSoonCount} transactions are due soon`}.
        </Alert>
      )}
      {summary.blockedCount > 0 && (
        <Alert severity="warning" sx={{ mx: 2, my: 1 }} data-note="blocked">
          {summary.blockedCount === 1 ? '1 transaction can’t be entered' : `${summary.blockedCount} transactions can’t be entered`}:
          {' '}its account is closed or gone. Reopen the account, or change where it goes.
        </Alert>
      )}
      {notice && <Alert severity={notice.severity} sx={{ mx: 2, my: 1 }} data-note="result" onClose={() => setNotice(undefined)}>{notice.text}</Alert>}

      {rows.length === 0
        ? <Empty onNew={() => void run(C.new)} />
        : (
          <TableContainer ref={tableRef} tabIndex={0} onKeyDown={onKeyDown} aria-label="Recurring transactions"
            sx={{ flex: 1, minHeight: 0, overflow: 'auto', '&:focus-visible': { outline: 2, outlineColor: 'primary.main', outlineOffset: -2 } }}>
            <Table size="small" stickyHeader sx={{ tableLayout: 'fixed', minWidth: 880 }}>
              <colgroup>
                <col style={{ width: 44 }} /><col style={{ width: 128 }} /><col /><col style={{ width: 150 }} />
                <col /><col style={{ width: 130 }} />
              </colgroup>
              <TableHead>
                <TableRow>
                  <TableCell padding="checkbox">
                    <Checkbox size="small" checked={allTicked} disabled={enterableIds.length === 0}
                      indeterminate={ticked.size > 0 && !allTicked}
                      onChange={toggleAll} slotProps={{ input: { 'aria-label': 'Tick every transaction that can be entered' } }} />
                  </TableCell>
                  <TableCell>Due</TableCell>
                  <TableCell>Name</TableCell>
                  <TableCell>Account</TableCell>
                  <TableCell>Category</TableCell>
                  <TableCell align="right">Amount</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.map(row => (
                  <Line
                    key={row.series.id} row={row}
                    selected={current?.series.id === row.series.id}
                    ticked={ticked.has(row.series.id)}
                    onSelect={() => setSelected(row.series.id)}
                    onToggle={() => toggle(row.series.id)}
                    onOpen={() => void run(C.edit, { ids: [row.series.id] })}
                    onContextMenu={event => onContextMenu(event, row)}
                  />
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )}

      {current && <Detail row={current} />}

      <Menu open={menu !== undefined} onClose={() => setMenu(undefined)} anchorReference="anchorPosition" anchorPosition={menu}>
        {current && [
          <MenuItem key="enter" disabled={!enterable(current)} onClick={() => { setMenu(undefined); void enter(target()) }}>
            <ListItemIcon><Icon name="Check" fontSize="small" /></ListItemIcon>
            <ListItemText>Enter in Register…</ListItemText>
          </MenuItem>,
          <MenuItem key="skip" disabled={!enterable(current)} onClick={() => void run(C.skip, { ids: target() })}>
            <ListItemIcon><Icon name="SkipNext" fontSize="small" /></ListItemIcon>
            <ListItemText>Skip This One…</ListItemText>
          </MenuItem>,
          ...(current.dueCount > 1 ? [
            <MenuItem key="skipAll" onClick={() => void run(C.skip, { ids: [current.series.id], count: current.dueCount })}>
              <ListItemIcon><Icon name="SkipNext" fontSize="small" /></ListItemIcon>
              <ListItemText>{`Skip All ${current.dueCount} Due…`}</ListItemText>
            </MenuItem>
          ] : []),
          <Divider key="divider" />,
          <MenuItem key="edit" onClick={() => void run(C.edit, { ids: [current.series.id] })}>
            <ListItemIcon><Icon name="Edit" fontSize="small" /></ListItemIcon>
            <ListItemText>Edit…</ListItemText>
          </MenuItem>,
          <MenuItem key="pause" onClick={() => void run(current.series.paused ? C.resume : C.pause, { ids: target() })}>
            <ListItemIcon><Icon name={current.series.paused ? 'PlayArrow' : 'Pause'} fontSize="small" /></ListItemIcon>
            <ListItemText>{current.series.paused ? 'Resume' : 'Pause'}</ListItemText>
          </MenuItem>,
          <MenuItem key="delete" onClick={() => void run(C.delete, { ids: target() })}>
            <ListItemIcon><Icon name="Delete" fontSize="small" /></ListItemIcon>
            <ListItemText>Delete…</ListItemText>
          </MenuItem>
        ]}
      </Menu>
    </Stack>
  )
}

/** One figure above the list, per currency, since a book can hold accounts in several. */
function Figure({ label, totals, count }: { label: string, totals: Record<string, number>, count: number }) {
  return (
    <Box sx={{ textAlign: 'right' }}>
      <Typography variant="caption" color="text.secondary" component="div">{label}</Typography>
      <Typography variant="subtitle1" component="div"><Totals totals={totals} muted={count === 0} /></Typography>
      <Typography variant="caption" color="text.secondary" component="div">
        {count === 1 ? '1 item' : `${count} items`}
      </Typography>
    </Box>
  )
}

/** One series, on one line: its first unentered occurrence. */
function Line({ row, selected, ticked, onSelect, onToggle, onOpen, onContextMenu }: {
  row: RecurringRow, selected: boolean, ticked: boolean
  onSelect(): void, onToggle(): void, onOpen(): void, onContextMenu(event: MouseEvent): void
}) {
  const state = DUE_STATES[row.state]
  const quiet = row.state === 'paused' || row.state === 'ended' || row.blockedReason !== undefined
  const canTick = enterable(row)

  return (
    <TableRow
      hover selected={selected} onClick={onSelect} onDoubleClick={onOpen} onContextMenu={onContextMenu}
      data-row={row.series.id} data-state={row.state} data-blocked={row.blockedReason !== undefined || undefined}
      sx={{ cursor: 'default', '& td': { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }}
    >
      <TableCell padding="checkbox">
        <Checkbox size="small" checked={ticked} disabled={!canTick}
          onClick={event => event.stopPropagation()} onChange={onToggle}
          slotProps={{ input: { 'aria-label': `Enter ${row.series.name}` } }} />
      </TableCell>
      <TableCell>
        <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center', color: quiet ? 'text.disabled' : state.colour }}>
          {state.icon && <Icon name={state.icon} fontSize="small" titleAccess={state.label} />}
          <span>{row.occurrence ? showShortDate(row.occurrence.date) : '—'}</span>
          {row.dueCount > 1 && (
            <Tooltip title={`${row.dueCount} are due: this one and ${row.dueCount - 1} more`}>
              <Chip size="small" color="error" label={row.dueCount} sx={{ height: 18, '& .MuiChip-label': { px: 0.75, fontSize: '0.7rem' } }} />
            </Tooltip>
          )}
        </Stack>
      </TableCell>
      <TableCell sx={{ color: quiet ? 'text.disabled' : undefined }} title={row.blockedReason ?? row.scheduleLabel}>
        {row.series.name}
        {row.series.template.estimated && <Box component="span" sx={{ color: 'text.secondary', ml: 0.5, fontSize: '0.75em' }}>est.</Box>}
      </TableCell>
      <TableCell sx={{ color: quiet ? 'text.disabled' : undefined }}>{row.account.name}</TableCell>
      <TableCell sx={{ color: row.categoryLabel ? quiet ? 'text.disabled' : undefined : 'text.secondary' }}>
        {row.categoryLabel ?? ''}
      </TableCell>
      <TableCell align="right"><Amount minor={row.series.template.amount} currency={row.account.currency} muted={quiet} /></TableCell>
    </TableRow>
  )
}

/**
 * What the selected series does, in words, under the list. Most of the time this answers the question the user
 * opened the screen with, so the dialog never has to be opened at all.
 */
function Detail({ row }: { row: RecurringRow }) {
  const { series } = row
  const parts = [
    row.scheduleLabel,
    series.lastEnteredDate !== undefined ? `last entered ${showDate(series.lastEnteredDate)}` : 'never entered',
    series.enteredCount > 0 || series.skippedCount > 0
      ? `${series.enteredCount} entered, ${series.skippedCount} skipped`
      : undefined,
    series.schedule.end?.kind === 'afterCount' ? `${series.schedule.end.count} times in all` : undefined,
    series.schedule.end?.kind === 'onDate' ? `until ${showDate(series.schedule.end.date)}` : undefined,
    series.paused ? (series.pausedReason === 'user' ? 'paused' : 'paused automatically') : undefined
  ].filter(Boolean)

  return (
    <Box sx={{ px: 2, py: 1, borderTop: 1, borderColor: 'divider' }} data-recurring-detail={series.id}>
      <Typography variant="body2" color="text.secondary" noWrap>{parts.join(' · ')}</Typography>
      {row.blockedReason && (
        <Typography variant="body2" color="error.main" noWrap data-detail="blocked">{row.blockedReason}</Typography>
      )}
      {series.notes && <Typography variant="body2" color="text.secondary" noWrap>{series.notes}</Typography>}
    </Box>
  )
}

function Empty({ onNew }: { onNew(): void }) {
  return (
    <Stack sx={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 1.5, p: 4 }}>
      <Icon name="CalendarToday" fontSize="large" />
      <Typography variant="subtitle1">Nothing repeats yet</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ textAlign: 'center', maxWidth: 420 }}>
        Add the payments and deposits that come round every month — rent, hydro, a pay cheque — and they will be
        listed here as they fall due. You can also right-click a transaction in a register and make it recurring.
      </Typography>
      <Button variant="contained" startIcon={<Icon name="Add" />} onClick={onNew}>New Recurring Transaction</Button>
    </Stack>
  )
}
