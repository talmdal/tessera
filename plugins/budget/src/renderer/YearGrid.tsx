// The Year: twelve months and a total for every row, one figure a cell, Budget, Actual or Remaining. In Budget, a
// line's month can be typed in: that month's own amount (an override), marked with a dot, as Money's advanced budget
// had; *Use the plan* (Delete, or an empty cell) takes it away. The editor keeps what is typed in its own state, and
// rows are memoised with stable callbacks, so a key redraws the editor, not the grid (docs/budget-design.md, Phase B0
// results: typing with the value in the grid's state took 0.36 s a key).
import { KeyboardEvent, MouseEvent, memo, useCallback, useEffect, useRef, useState } from 'react'
import { amountToInput, parseAmount } from '@tessera/accounts-api'
import { BUDGET_AMOUNT_MAX, type Figures } from '@tessera/budget-api'
import { Box, Icon, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TextField, Tooltip } from '@tessera/ui'
import { useLatest } from './bridge'
import { amount, monthName, shortMonth } from './display'
import { remainingIsBad, type GridRow } from './gridModel'

export type YearFigure = 'budget' | 'actual' | 'remaining'

/** A cell: its row's key, and its column: -1 for the row's name, 0 to 11 for the months, 12 for the year's total. */
export interface YearCell {
  key: string
  column: number
}

/**
 * How many times a row, and the cell editor, have been drawn: for tests that check typing redraws only the editor.
 * Counted only outside production builds, as `StatusGrid`'s `rowRenders`.
 */
export const yearRenders = { rows: 0, editor: 0 }
const COUNT_RENDERS = process.env.NODE_ENV !== 'production'

export interface YearGridProps {
  rows: GridRow[]
  /** The status's months, 'YYYY-MM'. */
  months: string[]
  currency: string
  figure: YearFigure
  /** Budget is shown and the ledger can change: lines' months can be typed in. */
  editable: boolean
  selected: YearCell | undefined
  /** The table's name, for screen readers. */
  label: string
  onSelect(cell: YearCell): void
  onToggle(key: string): void
  /** Enter or F2 on the row's name or total, or on a cell that can't be typed in: the line's dialog, or a new line. */
  onOpen(key: string): void
  /** A month's own amount, or null to use the plan. Resolves with a problem to show, or undefined once saved. */
  onSetMonth(key: string, month: string, amount: number | null): Promise<string | undefined>
  /** `Delete` on a month with an amount of its own: use the plan again (the view says if that fails). */
  onUsePlan(key: string, month: string): void
  /** Ctrl+Enter, or double-clicking a figure that can't be typed in: the transactions behind it. */
  onTransactions(cell: YearCell): void
  onMenu(cell: YearCell, at: { top: number, left: number }): void
  /** Keys the grid doesn't handle (Insert, Delete on a row's name). */
  onKey(event: KeyboardEvent, cell: YearCell | undefined): boolean
}

interface Editing extends YearCell {
  /** What the editor starts with: the amount, or the key that started it. */
  initial: string
  problem?: string
  saving?: boolean
}

// Fourteen columns of figures: a narrower padding than the table's, so a year fits a window 1,280 pixels wide
const NUMBER = { typography: 'numeric', whiteSpace: 'nowrap', px: 1 } as const
/** The rows' names stay in view while the months scroll sideways in a narrow window. */
const STICKY = { position: 'sticky', left: 0, zIndex: 1, bgcolor: 'background.default' } as const
const STARTS_EDIT = /^[0-9.,-]$/

/** The figure a row shows in a month (or the year, for column 12). */
export function figureOf(row: GridRow, column: number, figure: YearFigure): number | undefined {
  const f: Figures | undefined = column === 12 ? row.figures : row.months?.[column]
  return f?.[figure]
}

const canType = (row: GridRow | undefined, column: number, editable: boolean, months: number) =>
  editable && row?.kind === 'row' && row.row?.lineId !== undefined && column >= 0 && column < months

export function YearGrid(props: YearGridProps) {
  const { rows, months, selected } = props
  const [editing, setEditing] = useState<Editing>()
  const refs = useRef(new Map<string, HTMLElement>())
  const container = useRef<HTMLDivElement>(null)
  // The latest props and editor, for callbacks that stay the same object from render to render
  const latest = useLatest(props)
  const editingRef = useLatest(editing)
  const selectable = rows.filter(r => r.selectable)
  const cellId = (cell: YearCell) => `${cell.key}|${cell.column}`

  // The cell being edited can go: its line deleted elsewhere, its parent closed, the ledger become read-only. Editing
  // ends then, or every key and click would go on waiting for an editor that is no longer there
  useEffect(() => {
    if (editing && !canType(rows.find(r => r.key === editing.key), editing.column, props.editable, months.length)) setEditing(undefined)
  }, [rows, editing, props.editable, months.length])

  // Focus follows the selection while the grid has the focus, and comes back to the cell when editing ends
  useEffect(() => {
    if (!selected || editing || !container.current?.contains(document.activeElement) && document.activeElement !== document.body) return
    refs.current.get(cellId(selected))?.focus()
  }, [selected?.key, selected?.column, editing === undefined])

  const startEdit = useCallback((cell: YearCell, initial?: string) => {
    const { rows: all, editable, months: ms, figure, currency } = latest.current
    const row = all.find(r => r.key === cell.key)
    if (!canType(row, cell.column, editable, ms.length) || figure !== 'budget') return false
    latest.current.onSelect(cell)
    setEditing({ ...cell, initial: initial ?? amountToInput(figureOf(row!, cell.column, 'budget') ?? 0, currency) })
    return true
  }, [])

  const move = (cell: YearCell, by: number) => ({ key: cell.key, column: Math.max(-1, Math.min(12, cell.column + by)) })

  /** Saves what was typed: a month's own amount; nothing (the plan again) when emptied. Moves on by `step` columns. */
  const commit = useCallback(async (cell: YearCell, text: string, step: number) => {
    const { rows: all, months: ms, currency, onSetMonth, onSelect } = latest.current
    const row = all.find(r => r.key === cell.key)
    const month = ms[cell.column]
    if (!row || month === undefined) { setEditing(undefined); return }
    const own = row.row?.ownMonths?.includes(month) === true
    const done = () => { setEditing(undefined); if (step !== 0) onSelect(move(cell, step)) }
    let value: number | null
    if (text.trim() === '') {
      if (!own) { done(); return }
      value = null
    } else {
      const parsed = parseAmount(text, currency)
      const problem = !parsed.ok ? parsed.message : parsed.value < 0 ? 'Enter an amount of zero or more.'
        : parsed.value > BUDGET_AMOUNT_MAX ? 'That amount is too large for a budget.' : undefined
      if (problem || !parsed.ok) { setEditing(current => current && { ...current, initial: text, problem }); return }
      value = parsed.value
      // The same amount the plan gives, and no own amount to change: nothing to save
      if (!own && value === figureOf(row, cell.column, 'budget')) { done(); return }
    }
    setEditing(current => current && { ...current, initial: text, saving: true, problem: undefined })
    const problem = await onSetMonth(cell.key, month, value)
    if (problem) setEditing(current => current && { ...current, saving: false, problem })
    else done()
  }, [])
  const cancel = useCallback(() => setEditing(undefined), [])

  const register = useCallback((id: string, element: HTMLElement | null) => {
    if (element) refs.current.set(id, element); else refs.current.delete(id)
  }, [])
  const select = useCallback((cell: YearCell) => { if (!editingRef.current) latest.current.onSelect(cell) }, [])
  const toggle = useCallback((key: string) => latest.current.onToggle(key), [])
  const activate = useCallback((cell: YearCell) => {
    // A double-click: type in a line's month, else the row's dialog (its name) or the transactions (a figure)
    if (startEdit(cell)) return
    if (cell.column === -1) latest.current.onOpen(cell.key)
    else latest.current.onTransactions(cell)
  }, [startEdit])
  const menu = useCallback((cell: YearCell, event: MouseEvent) => {
    event.preventDefault()
    latest.current.onSelect(cell)
    latest.current.onMenu(cell, { top: event.clientY, left: event.clientX })
  }, [])

  const onKeyDown = (event: KeyboardEvent) => {
    if (editing) return
    const current = selected && rows.find(r => r.key === selected.key)
    const cell = current ? selected! : undefined
    const index = current ? selectable.indexOf(current) : -1
    const go = (row: GridRow | undefined, column = cell?.column ?? 0) => { if (row) props.onSelect({ key: row.key, column }) }
    const handled = (() => {
      switch (event.key) {
        case 'ArrowDown': go(selectable[Math.min(index + 1, selectable.length - 1)]); return true
        case 'ArrowUp': go(selectable[Math.max(index - 1, 0)]); return true
        case 'Home': if (event.ctrlKey) { go(selectable[0]); return true } go(current, -1); return true
        case 'End': if (event.ctrlKey) { go(selectable[selectable.length - 1]); return true } go(current, 12); return true
        case 'ArrowLeft':
          if (!cell || !current) return true
          if (cell.column === -1) { if (current.expandable && current.open) props.onToggle(current.key) } else go(current, cell.column - 1)
          return true
        case 'ArrowRight':
          if (!cell || !current) return true
          if (cell.column === -1 && current.expandable && !current.open) props.onToggle(current.key)
          else go(current, Math.min(12, cell.column + 1))
          return true
        case 'Enter':
          if (!cell) return false
          if (event.ctrlKey) props.onTransactions(cell)
          else if (!startEdit(cell)) props.onOpen(cell.key)
          return true
        case 'F2': if (cell && !startEdit(cell)) props.onOpen(cell.key); return true
        case 'Delete':
          if (cell && canType(current, cell.column, props.editable, months.length)) {
            // A month's cell: its own amount goes, and the plan applies again
            if (current!.row?.ownMonths?.includes(months[cell.column])) props.onUsePlan(cell.key, months[cell.column])
            return true
          }
          return props.onKey(event, cell)
        case 'ContextMenu': openMenuAt(cell); return true
        default:
          if (event.key === 'F10' && event.shiftKey) { openMenuAt(cell); return true }
          if (cell && STARTS_EDIT.test(event.key) && !event.ctrlKey && !event.metaKey && !event.altKey) return startEdit(cell, event.key)
          return props.onKey(event, cell)
      }
    })()
    if (handled) event.preventDefault()
  }
  const openMenuAt = (cell: YearCell | undefined) => {
    const element = cell && refs.current.get(cellId(cell))
    if (!cell || !element) return
    const box = element.getBoundingClientRect()
    props.onMenu(cell, { top: box.bottom, left: box.left + 12 })
  }

  return (
    <TableContainer ref={container} onKeyDown={onKeyDown} sx={{ flex: 1, overflow: 'auto' }}>
      {/* A treegrid, as the month's: rows of a tree, here with a cell selected in each */}
      <Table size="small" stickyHeader aria-label={props.label} role="treegrid" data-year-grid data-figure={props.figure}>
        <TableHead>
          <TableRow>
            <TableCell sx={{ ...STICKY, zIndex: 3 }}>Category</TableCell>
            {months.map(m => <TableCell key={m} align="right" title={monthName(m)} sx={{ px: 1 }}>{shortMonth(m)}</TableCell>)}
            <TableCell align="right" sx={{ px: 1 }}>Total</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {rows.map(row => (
            <YearRowView
              key={row.key} row={row} months={months} currency={props.currency} figure={props.figure}
              editable={props.editable}
              selectedColumn={selected?.key === row.key ? selected.column : undefined}
              editing={editing?.key === row.key ? editing : undefined}
              register={register} select={select} toggle={toggle} activate={activate} menu={menu} commit={commit} cancel={cancel}
            />
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  )
}

interface RowProps {
  row: GridRow
  months: string[]
  currency: string
  figure: YearFigure
  editable: boolean
  selectedColumn: number | undefined
  editing: Editing | undefined
  register(id: string, element: HTMLElement | null): void
  select(cell: YearCell): void
  toggle(key: string): void
  activate(cell: YearCell): void
  menu(cell: YearCell, event: MouseEvent): void
  commit(cell: YearCell, text: string, step: number): Promise<void>
  cancel(): void
}

const YearRowView = memo(function YearRowView(props: RowProps) {
  if (COUNT_RENDERS) yearRenders.rows++
  const { row, months, currency, figure, selectedColumn, editing } = props
  if (row.kind === 'heading') {
    return (
      <TableRow data-grid-row={row.key}>
        <TableCell sx={{ ...STICKY, fontWeight: 600, textTransform: 'uppercase', color: 'text.secondary', pt: 1.5 }}>{row.label}</TableCell>
        <TableCell colSpan={months.length + 1} />
      </TableRow>
    )
  }
  const strong = row.kind === 'total' || row.kind === 'net' || row.row?.kind === 'subtotal'
  const cell = (column: number) => ({
    ref: (element: HTMLElement | null) => { if (row.selectable) props.register(`${row.key}|${column}`, element) },
    tabIndex: row.selectable ? (selectedColumn === column ? 0 : -1) : undefined,
    'aria-selected': row.selectable ? selectedColumn === column : undefined,
    onClick: row.selectable ? () => props.select({ key: row.key, column }) : undefined,
    onDoubleClick: row.selectable ? () => props.activate({ key: row.key, column }) : undefined,
    onContextMenu: row.selectable ? (event: MouseEvent) => props.menu({ key: row.key, column }, event) : undefined,
    'data-cell': `${row.key}|${column}`
  })
  const selectedSx = (column: number) => selectedColumn === column
    ? { bgcolor: 'action.selected', outline: 2, outlineColor: 'primary.main', outlineOffset: -2 } : {}
  const shown = (column: number) => {
    const value = figureOf(row, column, figure)
    if (value === undefined) return ''
    if (figure === 'budget' && !row.budgeted) return '—'
    return amount(value, currency)
  }
  const bad = (column: number) => figure === 'remaining' && remainingIsBad({
    kind: row.kind, group: row.group, figures: column === 12 ? row.figures : row.months?.[column]
  })
  return (
    <TableRow data-grid-row={row.key} data-kind={row.kind === 'row' ? row.row?.kind : row.kind} hover={row.selectable}
      aria-level={row.selectable ? row.depth + 1 : undefined} aria-expanded={row.expandable ? row.open : undefined}>
      <TableCell {...cell(-1)} sx={{ ...STICKY, pl: 1 + row.depth * 2.5, fontWeight: strong ? 600 : undefined, whiteSpace: 'nowrap', cursor: 'default', ...selectedSx(-1) }}>
        <Box component="span" aria-hidden
          onClick={event => { if (row.expandable) { event.stopPropagation(); props.toggle(row.key) } }}
          sx={{ display: 'inline-flex', verticalAlign: 'middle', width: 20, visibility: row.expandable ? 'visible' : 'hidden' }}>
          <Icon name={row.open ? 'ExpandMore' : 'ChevronRight'} fontSize="small" />
        </Box>
        {row.label}
      </TableCell>
      {months.map((month, column) => {
        const own = figure === 'budget' && row.row?.ownMonths?.includes(month) === true
        if (editing?.column === column) {
          return (
            <TableCell key={month} align="right" sx={{ p: 0.25, minWidth: '7em' }} data-cell={`${row.key}|${column}`}>
              <CellEditor editing={editing} label={`${row.label}, ${monthName(month)}`} commit={props.commit} cancel={props.cancel} />
            </TableCell>
          )
        }
        return (
          <TableCell key={month} align="right" {...cell(column)} data-own={own || undefined} data-bad={bad(column) || undefined}
            title={own ? `${monthName(month)}: an amount of its own, instead of the plan’s` : undefined}
            sx={{ ...NUMBER, fontWeight: strong ? 600 : undefined, color: bad(column) ? 'error.main' : undefined, cursor: 'default', ...selectedSx(column) }}>
            {own && <Box component="span" aria-label="its own amount" sx={{ color: 'primary.main', mr: 0.5 }}>•</Box>}
            {shown(column)}
          </TableCell>
        )
      })}
      <TableCell align="right" {...cell(12)} data-bad={bad(12) || undefined}
        sx={{ ...NUMBER, fontWeight: 600, color: bad(12) ? 'error.main' : undefined, cursor: 'default', ...selectedSx(12) }}>
        {shown(12)}
      </TableCell>
    </TableRow>
  )
})

/** The editor of one month's amount: what is typed stays here until Enter, Tab or leaving the cell. */
function CellEditor({ editing, label, commit, cancel }: { editing: Editing, label: string, commit(cell: YearCell, text: string, step: number): Promise<void>, cancel(): void }) {
  if (COUNT_RENDERS) yearRenders.editor++
  const [text, setText] = useState(editing.initial)
  const finished = useRef(false)
  const input = useRef<HTMLInputElement | null>(null)
  // A problem with what was typed (or the save): back to the editor, to put it right
  useEffect(() => { if (editing.problem && !editing.saving) input.current?.focus() }, [editing.problem, editing.saving])
  const cell = { key: editing.key, column: editing.column }
  const save = (step: number) => {
    if (finished.current || editing.saving) return
    void commit(cell, text, step)
  }
  const onKeyDown = (event: KeyboardEvent) => {
    event.stopPropagation()
    if (event.key === 'Enter') { event.preventDefault(); save(0) }
    else if (event.key === 'Tab') { event.preventDefault(); save(event.shiftKey ? -1 : 1) }
    else if (event.key === 'Escape') { event.preventDefault(); finished.current = true; cancel() }
  }
  return (
    <Tooltip open={editing.problem !== undefined} title={editing.problem ?? ''} placement="bottom">
      <TextField
        size="small" margin="none" autoFocus value={text} disabled={editing.saving} error={editing.problem !== undefined}
        inputRef={input} onChange={event => setText(event.target.value)} onKeyDown={onKeyDown} onBlur={() => save(0)}
        // Typing a first key replaces the cell; F2 and Enter start from its amount, selected
        onFocus={event => { if (editing.initial.length > 1) event.target.select() }}
        slotProps={{ htmlInput: { 'aria-label': label, inputMode: 'decimal', style: { textAlign: 'right' }, 'aria-invalid': editing.problem !== undefined } }}
        sx={{ width: '100%', '& input': { typography: 'numeric', py: 0.25, px: 0.5 } }}
      />
    </Tooltip>
  )
}
