// The budget view (main area): one budget, a month, the year to date or the year month by month, beside what the
// transactions show. Everything
// that changes a budget runs a command, so the Budget menu, the toolbar, the keys and the context menu share one set of
// rules and confirmations. The view reports what it shows and has selected, which the commands act on.
import { KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  BUDGET_CHANNELS, BUDGET_COMMANDS as C, BUDGET_EVENTS, BUDGET_SETTINGS_PAGE, addMonths,
  type BudgetLine, type BudgetPeriod, type BudgetResult, type BudgetStatus, type BudgetSummary, type BudgetsView, type ChangeLineRequest,
  type NewLineArgs, type StatusRequest, type TransactionsArgs, type ViewOptions, type ViewReport
} from '@tessera/budget-api'
import { SETTINGS_OPEN_COMMAND } from '@tessera/types'
import {
  Alert, Box, Button, Checkbox, CircularProgress, Divider, Icon, IconButton, ListItemIcon, ListItemText, Menu, MenuItem, Stack,
  ToggleButton, ToggleButtonGroup, Toolbar, Tooltip, Typography
} from '@tessera/ui'
import { runCommand, useEvent, useFollowed, useShown } from './bridge'
import { monthName, periodMonths, periodName } from './display'
import { gridRows, rowRef, type GridRow } from './gridModel'
import { PeriodChooser, stepOf } from './PeriodChooser'
import { StatusGrid } from './StatusGrid'
import { YearGrid, type YearFigure } from './YearGrid'

/** Subtotals closed and Other rows open, per budget, while the app runs. */
const remembered = new Map<string, { collapsed: Set<string>, expanded: Set<string> }>()
const memoryOf = (budgetId: string) => {
  let memory = remembered.get(budgetId)
  if (!memory) remembered.set(budgetId, memory = { collapsed: new Set(), expanded: new Set() })
  return memory
}

export default function BudgetView() {
  const view = useFollowed<BudgetsView | null>(BUDGET_CHANNELS.budgets, BUDGET_EVENTS.budgets)
  if (view === undefined) return <Stack sx={{ p: 3, alignItems: 'center' }}><CircularProgress size={20} aria-label="Loading the budget" /></Stack>
  if (view === null) return null
  const budget = view.budgets.find(b => b.id === view.shown)
  if (!budget) return <NoBudget view={view} />
  return <BudgetPage key={budget.id} budget={budget} view={view} />
}

function NoBudget({ view }: { view: BudgetsView }) {
  const [error, setError] = useState<string>()
  return (
    <Stack sx={{ p: 3, gap: 1.5, alignItems: 'flex-start' }} data-budget-page="empty">
      <Typography variant="h6" component="h1">Budget</Typography>
      {view.readOnly
        ? <Typography color="text.secondary">{view.archive ? 'No budgets in this archive.' : 'No budgets in this ledger.'}</Typography>
        : <>
            <Typography color="text.secondary">Plan what you expect to earn and spend, and see how each month is going.</Typography>
            <Button variant="contained" startIcon={<Icon name="Add" />} onClick={() => { runCommand(C.newBudget).catch(err => setError(String(err?.message ?? err))) }}>New Budget…</Button>
          </>}
      {error && <Alert severity="error">{error}</Alert>}
    </Stack>
  )
}

interface MenuState { key?: string, month?: string, at?: { top: number, left: number }, anchor?: HTMLElement }

function BudgetPage({ budget, view }: { budget: BudgetSummary, view: BudgetsView }) {
  const readOnly = view.readOnly
  const [month, setMonth] = useState(view.month)
  const [period, setPeriod] = useState<BudgetPeriod>(view.period)
  // The Year: the figure its cells show, and the column of the cell selected (-1 the row's name, 12 its total)
  const [figure, setFigure] = useState<YearFigure>('budget')
  const [column, setColumn] = useState<number>()
  const [status, setStatus] = useState<BudgetStatus>()
  const [problem, setProblem] = useState<string>()
  const [error, setError] = useState<string>()
  const [selected, setSelected] = useState<string>()
  const [wanted, setWanted] = useState<string>()
  const memory = memoryOf(budget.id)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set(memory.collapsed))
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(memory.expanded))
  // How the view draws: the Budget page's settings, which the More menu changes too
  const { showBars, showEmptyLines: showEmpty } = view.options
  const [menu, setMenu] = useState<MenuState>()
  const [reloads, setReloads] = useState(0)

  const months = periodMonths(period, month, budget.yearStartMonth)
  const periodLabel = periodName(period, month, budget.yearStartMonth)
  const year = period === 'year'

  // The status, again whenever the months change or the plugin says it changed. A late reply to an earlier request is
  // dropped, so a quick ◀ ◀ ◀ ends on the month shown
  const latestRequest = useRef(0)
  useEffect(() => {
    const request = ++latestRequest.current
    const ask: StatusRequest = { budgetId: budget.id, months, ...(year && { byMonth: true }) }
    window.api.invoke<BudgetResult<BudgetStatus>>(BUDGET_CHANNELS.status, ask).then(result => {
      if (request !== latestRequest.current) return
      if (result.ok) { setStatus(result.value); setProblem(undefined) } else setProblem(result.error.message)
    }, err => { if (request === latestRequest.current) setProblem(String(err?.message ?? err)) })
  }, [budget.id, months.from, months.to, year, reloads])
  // Reloaded only while on screen: hidden behind another view (which the shell keeps mounted), the status is marked stale
  // and read once when the view is shown again, however many changes came meanwhile (docs/budget-design.md, "Keeping
  // the view current")
  const root = useRef<HTMLDivElement>(null)
  const onScreen = useShown(root)
  const [stale, setStale] = useState(false)
  useEvent<{ budgetId: string | null }>(BUDGET_EVENTS.status, change => {
    if (change?.budgetId !== null && change?.budgetId !== budget.id) return
    if (onScreen) setReloads(n => n + 1); else setStale(true)
  })
  useEffect(() => {
    if (onScreen && stale) { setStale(false); setReloads(n => n + 1) }
  }, [onScreen, stale])
  useEvent<{ budgetId: string, lineId: string }>(BUDGET_EVENTS.line, change => {
    if (change?.budgetId === budget.id) setWanted(`line:${change.lineId}`)
  })

  // The year grid draws a status month by month; until one arrives after switching to it, the last one isn't drawn as a year
  const shownStatus = status && (!year || status.monthlyTotals !== undefined) ? status : undefined
  const rows = useMemo(() => shownStatus ? gridRows(shownStatus, { collapsed, expanded, showEmpty, breakdowns: !year }) : [],
    [shownStatus, collapsed, expanded, showEmpty, year])
  const row = rows.find(r => r.key === selected)
  const selectable = rows.filter(r => r.selectable)

  // A line a command just added or changed is selected once the status has it; a selection that went is replaced
  useEffect(() => {
    if (wanted && rows.some(r => r.key === wanted)) { setSelected(wanted); setWanted(undefined); return }
    if (shownStatus && !rows.some(r => r.key === selected && r.selectable)) setSelected(selectable[0]?.key)
  }, [rows, wanted])
  // In the Year, the month shown is the column selected to begin with
  useEffect(() => {
    if (year && shownStatus && column === undefined) setColumn(Math.max(0, shownStatus.months.indexOf(month)))
  }, [year, shownStatus, column])

  // What the view shows, for the commands (and the menu's greying): reported on every change. Commands run after the
  // report has arrived, so they act on what the user sees
  const lineId = row?.kind === 'row' ? row.row?.lineId : undefined
  const reported = useRef<Promise<unknown>>(Promise.resolve())
  useEffect(() => {
    const report: ViewReport = { budgetId: budget.id, month, period, ...(lineId !== undefined && { lineId }) }
    reported.current = window.api.invoke(BUDGET_CHANNELS.select, report).catch(() => undefined)
  }, [budget.id, month, period, lineId])

  /** The Budget page's view settings, from the More menu: kept as the user's preference, and sent back with the view. */
  const setOption = (patch: Partial<ViewOptions>) => {
    setMenu(undefined)
    window.api.invoke(BUDGET_CHANNELS.viewOptions, patch).catch(err => setError(String(err?.message ?? err)))
  }

  const run = useCallback((command: string, args?: unknown) => {
    setMenu(undefined)
    setError(undefined)
    void reported.current.then(() => runCommand(command, ...(args === undefined ? [] : [args])))
      .catch(err => setError(String(err?.message ?? err)))
  }, [])

  /** The first month of the budget year a month is in. */
  const budgetYearOf = (m: string) => periodMonths('year', m, budget.yearStartMonth).from
  /** Another month or period. In the Year, the cell chosen is kept while the year stays the same. */
  const changePeriod = (nextMonth: string, nextPeriod: BudgetPeriod) => {
    if (nextPeriod !== period || budgetYearOf(nextMonth) !== budgetYearOf(month)) setColumn(undefined)
    setMonth(nextMonth)
    setPeriod(nextPeriod)
  }
  const rowOf = (key: string | undefined) => rows.find(r => r.key === key)

  /** Enter, F2 or a double-click: the row's line, or a new line for what the row is (a category with none, an entry under Other). */
  const openRow = (key: string) => {
    const target = rowOf(key)
    if (!target || readOnly) return
    if (target.kind === 'row' && target.row?.lineId !== undefined) run(C.editLine, { id: target.row.lineId })
    else if (target.target) run(C.newLine, { target: target.target } satisfies NewLineArgs)
    else if (target.row?.kind === 'other') run(C.newLine)
  }
  /** The transactions behind a row's actual: over the period, or in the Year, one month's (a month's cell). */
  const showTransactions = (key: string, inMonth?: string) => {
    const target = rowOf(key)
    const source = target?.row
    if (!source) return
    const args: TransactionsArgs = {
      budgetId: budget.id, row: rowRef(source), label: source.label,
      months: inMonth ? { from: inMonth, to: inMonth } : months, period: inMonth ? monthName(inMonth) : periodLabel
    }
    run(C.transactions, args)
  }
  /** A line's own amount for a month, typed in the Year, or null to use the plan. Resolves with a problem, if any. */
  const setMonthAmount = async (key: string, inMonth: string, amount: number | null): Promise<string | undefined> => {
    const lineId = rowOf(key)?.row?.lineId
    if (lineId === undefined || readOnly) return 'This row has no line to plan.'
    const request: ChangeLineRequest = { lineId, change: { apply: 'only', month: inMonth, amount } }
    try {
      const result = await window.api.invoke<BudgetResult<BudgetLine>>(BUDGET_CHANNELS.changeLine, request)
      return result.ok ? undefined : result.error.message
    } catch (err) {
      return String((err as Error)?.message ?? err)
    }
  }
  /** Use the plan again for a month: from the toolbar, a cell's menu or `Delete`, each saying if it fails. */
  const usePlan = (key: string, inMonth: string) => {
    setMenu(undefined)
    void setMonthAmount(key, inMonth, null).then(problem => { if (problem) setError(problem) })
  }
  const monthOfColumn = (c: number | undefined) => c === undefined || !shownStatus ? undefined : shownStatus.months[c]
  /** A cell of the Year: its month becomes the month shown, which a new line starts from, and the Month view shows. */
  const selectCell = (cell: { key: string, column: number }) => {
    setSelected(cell.key)
    setColumn(cell.column)
    const chosen = monthOfColumn(cell.column)
    if (chosen !== undefined) setMonth(chosen)
  }
  const deleteLine = (key: string | undefined) => {
    const target = rowOf(key)
    if (!readOnly && target?.kind === 'row' && target.row?.lineId !== undefined) run(C.deleteLine, { id: target.row.lineId })
  }
  const onKey = (event: KeyboardEvent, key: string | undefined) => {
    switch (event.key) {
      case 'Insert': if (!readOnly) run(C.newLine); return true
      case 'Delete': deleteLine(key); return true
      default: return false
    }
  }
  const toggle = (key: string) => {
    const target = rowOf(key)
    if (!target?.expandable) return
    const flip = (set: ReadonlySet<string>, kept: Set<string>) => {
      const next = new Set(set)
      if (next.has(key)) next.delete(key); else next.add(key)
      kept.clear()
      for (const k of next) kept.add(k)
      return next
    }
    if (target.row?.kind === 'subtotal') setCollapsed(set => flip(set, memory.collapsed))
    else setExpanded(set => flip(set, memory.expanded))
  }

  const hasLines = status?.rows.some(r => r.lineId !== undefined) ?? true
  const menuRow = rowOf(menu?.key)
  const lineSelected = row?.kind === 'row' && row.row?.lineId !== undefined
  // The Year's cell selected has an amount of its own, which Use the Plan takes away
  const selectedMonth = year ? monthOfColumn(column) : undefined
  const ownSelected = selectedMonth !== undefined && row?.row?.ownMonths?.includes(selectedMonth) === true

  // Page Up and Page Down step the month from anywhere in the view, but not from a menu or a field being typed in
  const onPageKeys = (event: KeyboardEvent) => {
    if (event.defaultPrevented || (event.key !== 'PageUp' && event.key !== 'PageDown')) return
    if ((event.target as HTMLElement).closest('input, textarea, [role="listbox"], [role="menu"]')) return
    event.preventDefault()
    changePeriod(addMonths(month, event.key === 'PageUp' ? -stepOf(period) : stepOf(period)), period)
  }

  return (
    <Stack ref={root} sx={{ height: '100%', minHeight: 0 }} data-budget-page="view" onKeyDown={onPageKeys}>
      <Stack direction="row" sx={{ px: 2, pt: 1.5, pb: 0.5, gap: 2, alignItems: 'center', flexWrap: 'wrap' }}>
        <Typography variant="h6" component="h1" sx={{ mr: 'auto' }}>
          {budget.name}
          <Typography component="span" color="text.secondary" sx={{ ml: 1 }}>· {budget.covers} · {budget.currency}</Typography>
        </Typography>
        <PeriodChooser month={month} period={period} yearStartMonth={budget.yearStartMonth} onChange={changePeriod} />
      </Stack>

      <Toolbar variant="dense" disableGutters sx={{ px: 1.5, gap: 0.5, minHeight: 36, flexWrap: 'wrap' }}>
        <Button size="small" startIcon={<Icon name="Add" />} disabled={readOnly} onClick={() => run(C.newLine)}>New Line…</Button>
        <Button size="small" startIcon={<Icon name="Edit" />} disabled={readOnly || !lineSelected} onClick={() => selected && openRow(selected)}>Edit Line…</Button>
        <Button size="small" startIcon={<Icon name="Delete" />} disabled={readOnly || !lineSelected} onClick={() => deleteLine(selected)}>Delete Line</Button>
        {year && (
          <Button size="small" startIcon={<Icon name="Undo" />} disabled={readOnly || !ownSelected}
            onClick={() => { if (selected && selectedMonth) usePlan(selected, selectedMonth) }}>
            Use the Plan
          </Button>
        )}
        <Button size="small" startIcon={<Icon name="ShowChart" />} disabled={readOnly} onClick={() => run(C.fillFromHistory)}>Fill from History…</Button>
        <Box sx={{ flex: 1 }} />
        {year && (
          <ToggleButtonGroup size="small" exclusive value={figure} aria-label="Figures shown" onChange={(_event, value: YearFigure | null) => { if (value) setFigure(value) }}>
            <ToggleButton value="budget" sx={{ py: 0.25 }}>Budget</ToggleButton>
            <ToggleButton value="actual" sx={{ py: 0.25 }}>Actual</ToggleButton>
            <ToggleButton value="remaining" sx={{ py: 0.25 }}>Remaining</ToggleButton>
          </ToggleButtonGroup>
        )}
        <Tooltip title="More">
          <IconButton size="small" aria-label="More actions" aria-haspopup="menu" onClick={event => setMenu({ anchor: event.currentTarget })}><Icon name="MoreVert" /></IconButton>
        </Tooltip>
      </Toolbar>

      {readOnly && <Alert severity="info" sx={{ mx: 2, my: 0.5 }}>The ledger is open read-only, so its budgets can be looked at, not changed.</Alert>}
      {error && <Alert severity="error" sx={{ mx: 2, my: 0.5 }} onClose={() => setError(undefined)}>{error}</Alert>}
      {problem && <Alert severity="error" sx={{ mx: 2, my: 0.5 }}>{problem}</Alert>}
      {status && !hasLines && !readOnly && (
        <Alert severity="info" sx={{ mx: 2, my: 0.5 }} action={<>
          <Button size="small" onClick={() => run(C.newLine)}>Add Line…</Button>
          <Button size="small" onClick={() => run(C.fillFromHistory)}>Fill from History…</Button>
        </>}>
          This budget has no lines yet. Add one for each category you want to plan, or fill it from the months before.
        </Alert>
      )}

      {shownStatus === undefined && !problem
        ? <Stack sx={{ p: 3, alignItems: 'center' }}><CircularProgress size={20} aria-label="Loading the budget" /></Stack>
        : shownStatus && (year
          ? <YearGrid
              rows={rows} months={shownStatus.months} currency={budget.currency} figure={figure} editable={figure === 'budget' && !readOnly}
              selected={selected !== undefined && column !== undefined ? { key: selected, column } : undefined}
              label={`${budget.name}, ${periodLabel}`}
              onSelect={selectCell} onToggle={toggle} onOpen={openRow}
              onSetMonth={setMonthAmount} onUsePlan={usePlan}
              onTransactions={cell => showTransactions(cell.key, monthOfColumn(cell.column))}
              onMenu={(cell, at) => setMenu({ key: cell.key, month: monthOfColumn(cell.column), at })}
              onKey={(event, cell) => onKey(event, cell?.key)}
            />
          : <StatusGrid
              rows={rows} currency={budget.currency} period={period} selected={selected} archived={shownStatus.archived} showBars={showBars}
              label={`${budget.name}, ${periodLabel}`}
              onSelect={setSelected} onToggle={toggle} onOpen={openRow} onTransactions={key => showTransactions(key)}
              onMenu={(key, at) => setMenu({ key, at })} onKey={onKey}
            />)}
      {status && status.notCounted.length > 0 && (
        <Typography variant="body2" color="text.secondary" sx={{ px: 2, py: 1 }} data-note="not-counted">
          Not counted: {status.notCounted.map(a => `${a.name}, in ${a.currency}`).join('; ')}
        </Typography>
      )}

      <Menu
        open={menu !== undefined}
        onClose={() => setMenu(undefined)}
        {...(menu?.at ? { anchorReference: 'anchorPosition' as const, anchorPosition: menu.at } : { anchorEl: menu?.anchor })}
      >
        {menuRow
          ? rowMenu(menuRow, readOnly, menu?.month, {
              openRow, showTransactions, deleteLine, newLine: () => run(C.newLine),
              usePlan
            })
          : [
              <MenuItem key="empty" onClick={() => setOption({ showEmptyLines: !showEmpty })} role="menuitemcheckbox" aria-checked={showEmpty}>
                <ListItemIcon><Checkbox size="small" checked={showEmpty} tabIndex={-1} disableRipple sx={{ p: 0 }} /></ListItemIcon>
                <ListItemText>Show lines with nothing this period</ListItemText>
              </MenuItem>,
              <MenuItem key="bars" onClick={() => setOption({ showBars: !showBars })} role="menuitemcheckbox" aria-checked={showBars}>
                <ListItemIcon><Checkbox size="small" checked={showBars} tabIndex={-1} disableRipple sx={{ p: 0 }} /></ListItemIcon>
                <ListItemText>Show bars</ListItemText>
              </MenuItem>,
              <MenuItem key="options" onClick={() => run(SETTINGS_OPEN_COMMAND, BUDGET_SETTINGS_PAGE)}>
                <ListItemIcon><Icon name="Edit" fontSize="small" /></ListItemIcon><ListItemText>Budget Options…</ListItemText>
              </MenuItem>,
              <Divider key="divider" />,
              <MenuItem key="properties" disabled={readOnly} onClick={() => run(C.properties, { id: budget.id })}>
                <ListItemIcon><Icon name="Edit" fontSize="small" /></ListItemIcon><ListItemText>Budget Properties…</ListItemText>
              </MenuItem>,
              <MenuItem key="duplicate" disabled={readOnly} onClick={() => run(C.duplicate, { id: budget.id })}>
                <ListItemIcon><Icon name="ContentCopy" fontSize="small" /></ListItemIcon><ListItemText>Duplicate Budget…</ListItemText>
              </MenuItem>,
              <MenuItem key="delete" disabled={readOnly} onClick={() => run(C.deleteBudget, { id: budget.id })}>
                <ListItemIcon><Icon name="Delete" fontSize="small" /></ListItemIcon><ListItemText>Delete Budget…</ListItemText>
              </MenuItem>
            ]}
      </Menu>
    </Stack>
  )
}

/** A row's context menu (in the Year, a cell's): the same actions as its keys. */
function rowMenu(row: GridRow, readOnly: boolean, month: string | undefined, act: {
  openRow(key: string): void, showTransactions(key: string, month?: string): void, deleteLine(key: string): void, newLine(): void,
  usePlan(key: string, month: string): void
}) {
  const hasLine = row.kind === 'row' && row.row?.lineId !== undefined
  const own = month !== undefined && row.row?.ownMonths?.includes(month) === true
  return [
    hasLine && <MenuItem key="edit" disabled={readOnly} onClick={() => act.openRow(row.key)}>
      <ListItemIcon><Icon name="Edit" fontSize="small" /></ListItemIcon><ListItemText secondary={month ? undefined : 'Enter'}>Edit Line…</ListItemText>
    </MenuItem>,
    own && <MenuItem key="plan" disabled={readOnly} onClick={() => act.usePlan(row.key, month!)}>
      <ListItemIcon><Icon name="Undo" fontSize="small" /></ListItemIcon><ListItemText secondary="Delete">{`Use the Plan for ${monthName(month!)}`}</ListItemText>
    </MenuItem>,
    !hasLine && row.target && <MenuItem key="add" disabled={readOnly} onClick={() => act.openRow(row.key)}>
      <ListItemIcon><Icon name="Add" fontSize="small" /></ListItemIcon><ListItemText secondary="Enter">{`New Line for “${row.label}”…`}</ListItemText>
    </MenuItem>,
    <MenuItem key="new" disabled={readOnly} onClick={act.newLine}>
      <ListItemIcon><Icon name="Add" fontSize="small" /></ListItemIcon><ListItemText secondary="Insert">New Line…</ListItemText>
    </MenuItem>,
    hasLine && <MenuItem key="delete" disabled={readOnly} onClick={() => act.deleteLine(row.key)}>
      <ListItemIcon><Icon name="Delete" fontSize="small" /></ListItemIcon><ListItemText secondary={month ? undefined : 'Delete'}>Delete Line</ListItemText>
    </MenuItem>,
    <Divider key="divider" />,
    <MenuItem key="transactions" onClick={() => act.showTransactions(row.key, month)}>
      <ListItemIcon><Icon name="List" fontSize="small" /></ListItemIcon>
      <ListItemText secondary="Ctrl+Enter">{month ? `Show Transactions in ${monthName(month)}` : 'Show Transactions'}</ListItemText>
    </MenuItem>
  ].filter(Boolean)
}
