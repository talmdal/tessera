// The budget grid: a row per line, subtotal, Other and Uncategorised row, then the totals and the net. Rows are
// memoised and every callback is stable, so moving the selection redraws two rows, not 150 (docs/budget-design.md,
// Phase B0 results: a grid that redrew every row on every change took 0.36 s a key).
import { KeyboardEvent, MouseEvent, memo, useCallback, useEffect, useRef } from 'react'
import type { BudgetPeriod } from '@tessera/budget-api'
import { Box, Icon, LinearProgress, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Tooltip } from '@tessera/ui'
import { useLatest } from './bridge'
import { amount, percentOf } from './display'
import { remainingIsBad, type GridRow } from './gridModel'

/**
 * How many times a grid row has been drawn, for tests that check a change redraws only the rows it touches. Counted
 * only outside production builds: the plugin's build replaces `process.env.NODE_ENV`, so the count is left out there.
 */
export const rowRenders = { count: 0 }
const COUNT_RENDERS = process.env.NODE_ENV !== 'production'

export interface StatusGridProps {
  rows: GridRow[]
  currency: string
  period: BudgetPeriod
  selected: string | undefined
  /** What came from archives, by status row index: shown on the Actual cell. */
  archived?: Record<number, number>
  /** The bars beside each line (the Budget page's *Show a bar beside each line*). Default true. */
  showBars?: boolean
  /** The label of the table, for screen readers: 'Household, March 2027'. */
  label: string
  onSelect(key: string): void
  onToggle(key: string): void
  /** Enter, F2, or double-clicking a row: edit its line, or add one. */
  onOpen(key: string): void
  /** Ctrl+Enter, or double-clicking an Actual: the transactions behind it. */
  onTransactions(key: string): void
  onMenu(key: string, at: { top: number, left: number }): void
  /** Keys the grid doesn't handle itself (Insert, Delete, Page Up and Down). */
  onKey(event: KeyboardEvent, key: string | undefined): boolean
}

const NUMBER = { typography: 'numeric', whiteSpace: 'nowrap' } as const

export function StatusGrid(props: StatusGridProps) {
  const { rows, selected } = props
  const refs = useRef(new Map<string, HTMLElement>())
  const selectable = rows.filter(r => r.selectable)
  // The latest props, for callbacks that stay the same object from render to render
  const latest = useLatest(props)

  // Focus follows the selection while the grid has the focus (the keys moved it), never taking it from elsewhere
  const container = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (selected === undefined || !container.current?.contains(document.activeElement)) return
    refs.current.get(selected)?.focus()
  }, [selected])

  const register = useCallback((key: string, element: HTMLElement | null) => {
    if (element) refs.current.set(key, element); else refs.current.delete(key)
  }, [])
  const select = useCallback((key: string) => latest.current.onSelect(key), [])
  const toggle = useCallback((key: string) => latest.current.onToggle(key), [])
  const open = useCallback((key: string) => latest.current.onOpen(key), [])
  const transactions = useCallback((key: string) => latest.current.onTransactions(key), [])
  const menu = useCallback((key: string, event: MouseEvent) => {
    event.preventDefault()
    latest.current.onSelect(key)
    latest.current.onMenu(key, { top: event.clientY, left: event.clientX })
  }, [])

  const onKeyDown = (event: KeyboardEvent) => {
    const current = rows.find(r => r.key === selected)
    const index = current ? selectable.indexOf(current) : -1
    const go = (row: GridRow | undefined) => { if (row) { props.onSelect(row.key); refs.current.get(row.key)?.focus() } }
    const handled = (() => {
      switch (event.key) {
        case 'ArrowDown': go(selectable[Math.min(index + 1, selectable.length - 1)]); return true
        case 'ArrowUp': go(selectable[Math.max(index - 1, 0)]); return true
        case 'Home': if (!event.ctrlKey) { go(selectable[0]); return true } return false
        case 'End': if (!event.ctrlKey) { go(selectable[selectable.length - 1]); return true } return false
        case 'ArrowRight': if (current?.expandable && !current.open) props.onToggle(current.key); return true
        case 'ArrowLeft':
          if (current?.expandable && current.open) props.onToggle(current.key)
          else if (current?.kind === 'breakdown') go(rows.find(r => r.kind === 'row' && r.row === current.row))
          return true
        case 'Enter':
          if (!current) return false
          if (event.ctrlKey) props.onTransactions(current.key); else props.onOpen(current.key)
          return true
        case 'F2': if (current) props.onOpen(current.key); return true
        case 'ContextMenu': openMenuAt(current); return true
        default:
          if (event.key === 'F10' && event.shiftKey) { openMenuAt(current); return true }
          return props.onKey(event, current?.key)
      }
    })()
    if (handled) event.preventDefault()
  }
  const openMenuAt = (row: GridRow | undefined) => {
    const element = row && refs.current.get(row.key)
    if (!row || !element) return
    const box = element.getBoundingClientRect()
    props.onMenu(row.key, { top: box.bottom, left: box.left + 24 })
  }

  const month = props.period === 'month'
  const bars = props.showBars !== false
  return (
    <TableContainer ref={container} onKeyDown={onKeyDown} sx={{ flex: 1, overflow: 'auto' }}>
      {/* A treegrid: rows are selected and focused one at a time, and parents open and close (aria-level, aria-expanded) */}
      <Table size="small" stickyHeader aria-label={props.label} role="treegrid">
        <TableHead>
          <TableRow>
            <TableCell>Category</TableCell>
            {month && <TableCell>Due</TableCell>}
            <TableCell align="right">Budget</TableCell>
            <TableCell align="right">Actual</TableCell>
            <TableCell align="right">Remaining</TableCell>
            {bars && <TableCell sx={{ width: '13em' }}><Box component="span" sx={visuallyHidden}>Spent</Box></TableCell>}
          </TableRow>
        </TableHead>
        <TableBody>
          {rows.map(row => (
            <GridRowView
              key={row.key} row={row} currency={props.currency} month={month} bars={bars} selected={row.key === selected}
              archived={row.kind === 'row' && row.index !== undefined ? props.archived?.[row.index] : undefined}
              register={register} select={select} toggle={toggle} open={open} transactions={transactions} menu={menu}
            />
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  )
}

const visuallyHidden = { position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' } as const

interface RowProps {
  row: GridRow
  currency: string
  month: boolean
  bars: boolean
  selected: boolean
  archived: number | undefined
  register(key: string, element: HTMLElement | null): void
  select(key: string): void
  toggle(key: string): void
  open(key: string): void
  transactions(key: string): void
  menu(key: string, event: MouseEvent): void
}

const GridRowView = memo(function GridRowView({ row, currency, month, bars, selected, archived, register, select, toggle, open, transactions, menu }: RowProps) {
  if (COUNT_RENDERS) rowRenders.count++
  const { figures } = row
  const strong = row.kind === 'heading' || row.kind === 'total' || row.kind === 'net' || row.row?.kind === 'subtotal'
  const columns = (month ? 6 : 5) - (bars ? 0 : 1)
  if (row.kind === 'heading') {
    return (
      <TableRow data-grid-row={row.key}>
        <TableCell colSpan={columns} sx={{ fontWeight: 600, textTransform: 'uppercase', color: 'text.secondary', pt: 1.5 }}>{row.label}</TableCell>
      </TableRow>
    )
  }
  const percent = figures && row.budgeted && row.kind === 'row' ? percentOf(figures.actual, figures.budget) : undefined
  const warning = row.kind === 'row' ? row.row?.warning : undefined
  const tone = warning === 'over' ? 'error' : warning === 'near' ? 'warning' : 'primary'
  const bad = row.kind !== 'breakdown' && remainingIsBad(row)
  const due = month && row.row?.due && row.kind === 'row' ? row.row.due.join(', ') : ''
  return (
    <TableRow
      ref={(element: HTMLTableRowElement | null) => { if (row.selectable) register(row.key, element) }}
      hover={row.selectable}
      selected={selected}
      tabIndex={row.selectable ? (selected ? 0 : -1) : undefined}
      aria-selected={row.selectable ? selected : undefined}
      aria-expanded={row.expandable ? row.open : undefined}
      aria-level={row.selectable ? row.depth + 1 : undefined}
      onClick={row.selectable ? () => select(row.key) : undefined}
      onDoubleClick={row.selectable ? () => open(row.key) : undefined}
      onContextMenu={row.selectable ? event => menu(row.key, event) : undefined}
      data-grid-row={row.key}
      data-kind={row.kind === 'row' ? row.row?.kind : row.kind}
      data-warning={warning}
      sx={{ cursor: 'default', '&:focus-visible': { outline: 2, outlineColor: 'primary.main', outlineOffset: -2 } }}
    >
      <TableCell sx={{ pl: 1 + row.depth * 2.5, fontWeight: strong ? 600 : undefined, whiteSpace: 'nowrap' }}>
        <Box component="span" aria-hidden
          onClick={event => { if (row.expandable) { event.stopPropagation(); toggle(row.key) } }}
          sx={{ display: 'inline-flex', verticalAlign: 'middle', width: 20, visibility: row.expandable ? 'visible' : 'hidden' }}>
          <Icon name={row.open ? 'ExpandMore' : 'ChevronRight'} fontSize="small" />
        </Box>
        {row.label}
      </TableCell>
      {month && <TableCell sx={NUMBER} data-column="due">{due}</TableCell>}
      <TableCell align="right" sx={NUMBER} data-column="budget">{figures && row.budgeted ? amount(figures.budget, currency) : '—'}</TableCell>
      <TableCell align="right" sx={NUMBER} data-column="actual"
        title={archived ? `${amount(archived, currency)} of it is from archived months` : undefined}
        onDoubleClick={row.selectable ? event => { event.stopPropagation(); transactions(row.key) } : undefined}>
        {figures ? amount(figures.actual, currency) : ''}
      </TableCell>
      <TableCell align="right" sx={{ ...NUMBER, color: bad ? 'error.main' : undefined }} data-column="remaining" data-bad={bad || undefined}>
        {figures && row.kind !== 'breakdown' ? amount(figures.remaining, currency) : ''}
      </TableCell>
      {bars && <TableCell data-column="bar">
        {percent !== undefined && (
          <Tooltip title={`${percent}% of the budget`}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <LinearProgress variant="determinate" value={Math.min(percent, 100)} color={tone} aria-label={`${row.label}: ${percent}% of the budget`}
                sx={{ flex: 1, minWidth: '6em', height: 6, borderRadius: 1 }} />
              <Box component="span" sx={{ ...NUMBER, minWidth: '3.5em', textAlign: 'right', color: warning ? `${tone}.main` : 'text.secondary' }}>{percent}%</Box>
            </Box>
          </Tooltip>
        )}
      </TableCell>}
    </TableRow>
  )
})
