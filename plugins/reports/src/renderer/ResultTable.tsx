// A result's table: a tree grid of its rows and columns. Figures are right-aligned in the *Amounts and figures* font
// role, bad ones (what is owed; a net below zero) in the theme's error colour, columns as wide as their figures in em
// so larger text widens them, and the table scrolls sideways rather than cut a figure short. Rows fold under their
// parents. It draws 500 rows, then 500 more after each painted frame, so a long report shows its first rows at once
// and never holds the window (docs/reporting-design.md, "Reports and @tessera/ui").
//
// Drawn for speed (R3, measured in Chromium): each row is memoised, so a new chunk draws only its own rows, not every
// row before it again; and the styles are the table's, once, keyed by data attributes (a bad figure, a total row),
// not an `sx` on each of 5,000 cells, which made Emotion work out a style per cell.
import { KeyboardEvent, MouseEvent, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReportResult, ResultColumn, ResultRow } from '@tessera/reports-api'
import { Box, IconButton, Icon, Table, TableBody, TableCell, TableContainer, TableHead, TableRow } from '@tessera/ui'
import { useLatest } from './bridge'
import { figure } from './display'
import { ROWS_PER_CHUNK, canDrill, columnWidthEm, headingGroups, isBad, visibleRows } from './tableModel'

/** A cell: its row's id, and its column (-1 for the row's label). */
export interface Cell { row: string, column: number }

export interface ResultTableProps {
  result: ReportResult
  collapsed: ReadonlySet<string>
  selected?: Cell
  label: string
  onSelect(cell: Cell): void
  onToggle(rowId: string, open: boolean): void
  /** Show Transactions for a figure (Ctrl+Enter, a double-click). */
  onTransactions(cell: Cell): void
  onMenu(cell: Cell, at: { top: number, left: number }): void
}

/** The table's styles, once: rows and cells say what they are in data attributes. */
const TABLE_STYLES = {
  width: 'auto', minWidth: '100%', tableLayout: 'auto',
  '& td[data-column]': { typography: 'numeric', whiteSpace: 'nowrap', textAlign: 'right' },
  '& td[data-bad]': { color: 'error.main' },
  '& td[data-drill]': { cursor: 'pointer' },
  '& td[data-selected]': { outline: 1, outlineColor: 'primary.main', outlineOffset: -1 },
  '& td[data-total]': { fontWeight: 600 },
  '& th[data-label]': { whiteSpace: 'nowrap' },
  '& tr[data-strong] > *': { fontWeight: 600 },
  '& tr[data-kind="balance"] > th': { fontStyle: 'italic' },
  '& tr[data-rule] > *': { borderTop: 1, borderTopColor: 'divider' },
  '& tr[data-report-row]:focus-visible': { outline: 2, outlineColor: 'primary.main', outlineOffset: -2 },
  '& [data-spacer]': { width: '1.25em', display: 'inline-block' },
  '& [data-label-box]': { display: 'inline-flex', alignItems: 'center', gap: 0.25 },
  '& [data-toggle]': { p: 0 }
} as const

const STRONG = new Set(['subtotal', 'total', 'net', 'heading'])

interface RowProps {
  row: ResultRow
  columns: readonly ResultColumn[]
  currency: string | null
  parent: boolean
  open: boolean
  /** The column selected, when this row is: -1 its label. */
  selectedColumn?: number
  focusable: boolean
  handlers: { current: Handlers }
  register(id: string, element: HTMLElement | null): void
}

interface Handlers {
  select(cell: Cell): void
  toggle(rowId: string, open: boolean): void
  transactions(cell: Cell): void
  menu(event: MouseEvent, cell: Cell): void
}

/** One row: drawn again only when it, its fold or its selection changes. */
const Row = memo(function Row({ row, columns, currency, parent, open, selectedColumn, focusable, handlers, register }: RowProps) {
  const isSelected = selectedColumn !== undefined
  return (
    <TableRow
      ref={(element: HTMLElement | null) => register(row.id, element)}
      hover selected={isSelected} tabIndex={isSelected || focusable ? 0 : -1}
      aria-level={row.depth} {...(parent && { 'aria-expanded': open })} aria-selected={isSelected}
      data-report-row={row.id} data-kind={row.kind} {...(STRONG.has(row.kind) && { 'data-strong': true })}
      {...((row.kind === 'total' || row.kind === 'net') && { 'data-rule': true })}
      onClick={() => handlers.current.select({ row: row.id, column: isSelected ? selectedColumn : -1 })}
    >
      <TableCell component="th" scope="row" data-label onContextMenu={event => handlers.current.menu(event, { row: row.id, column: -1 })}
        style={{ paddingLeft: `${0.5 + (row.depth - 1) * 1.25}em` }}>
        <span data-label-box>
          {parent
            ? <IconButton size="small" aria-label={open ? `Collapse ${row.label}` : `Expand ${row.label}`} tabIndex={-1} data-toggle
                onClick={event => { event.stopPropagation(); handlers.current.toggle(row.id, !open) }}>
                <Icon name={open ? 'ExpandMore' : 'ChevronRight'} fontSize="small" />
              </IconButton>
            : <span data-spacer />}
          {row.label}
        </span>
      </TableCell>
      {columns.map((c, i) => {
        const value = row.kind === 'heading' ? null : row.values[i] ?? null
        const drill = canDrill(row, c, value)
        return (
          <TableCell
            key={c.key} data-column={i}
            {...(isBad(row, c, value) && { 'data-bad': true })} {...(drill && { 'data-drill': true })}
            {...(c.total && { 'data-total': true })} {...(selectedColumn === i && { 'data-selected': true })}
            onClick={event => { event.stopPropagation(); handlers.current.select({ row: row.id, column: i }) }}
            onDoubleClick={drill ? () => handlers.current.transactions({ row: row.id, column: i }) : undefined}
            onContextMenu={event => handlers.current.menu(event, { row: row.id, column: i })}
            title={drill ? 'Double-click to show the transactions' : undefined}
          >
            {row.kind === 'heading' ? '' : figure(value, c, row.currency ?? currency)}
          </TableCell>
        )
      })}
    </TableRow>
  )
})

export function ResultTable({ result, collapsed, selected, label, onSelect, onToggle, onTransactions, onMenu }: ResultTableProps) {
  const { columns } = result
  const rows = useMemo(() => visibleRows(result.rows, collapsed), [result.rows, collapsed])
  const groups = useMemo(() => headingGroups(columns), [columns])
  const widths = useMemo(() => columns.map((c, i) => columnWidthEm(c, result.rows.map(r => figure(r.values[i] ?? null, c, r.currency ?? result.currency)))), [result, columns])

  // The rows drawn so far: a chunk more after each painted frame. A frame's callback runs before the paint; the
  // timeout after it runs once the frame is painted (R0: a bare timeout lands in the same frame)
  const [drawn, setDrawn] = useState(ROWS_PER_CHUNK)
  useEffect(() => setDrawn(ROWS_PER_CHUNK), [result])
  useEffect(() => {
    if (drawn >= rows.length) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const frame = requestAnimationFrame(() => { timer = setTimeout(() => setDrawn(n => n + ROWS_PER_CHUNK), 0) })
    return () => { cancelAnimationFrame(frame); clearTimeout(timer) }
  }, [drawn, rows.length])

  const refs = useRef(new Map<string, HTMLElement>())
  const register = useCallback((id: string, element: HTMLElement | null) => { if (element) refs.current.set(id, element); else refs.current.delete(id) }, [])
  const focusWanted = useRef(false)
  useEffect(() => {
    if (!focusWanted.current || !selected) return
    focusWanted.current = false
    refs.current.get(selected.row)?.focus()
  }, [selected])

  // The same object from render to render, acting on the latest props: so memoised rows needn't draw again for them
  const handlers = useLatest<Handlers>({
    select: onSelect, toggle: onToggle, transactions: onTransactions,
    menu: (event, cell) => { event.preventDefault(); onSelect(cell); onMenu(cell, { top: event.clientY, left: event.clientX }) }
  })

  const current = rows.findIndex(r => r.row.id === selected?.row)
  const firstFigure = (rowId: string) => {
    const row = result.rows.find(r => r.id === rowId)
    return row ? columns.findIndex((c, j) => canDrill(row, c, row.values[j] ?? null)) : -1
  }
  const move = (cell: Cell) => { focusWanted.current = true; onSelect(cell) }
  const menuAt = (rowId: string, column: number) => {
    const box = refs.current.get(rowId)?.getBoundingClientRect()
    onMenu({ row: rowId, column }, { top: box?.bottom ?? 0, left: box?.left ?? 0 })
  }

  const onKeyDown = (event: KeyboardEvent) => {
    const at = current < 0 ? 0 : current
    const here = rows[at]
    // Keys it doesn't use (F5, Page Up, Page Down) go on to the view
    if (!here) return
    const column = selected?.column ?? -1
    const handled = (() => {
      switch (event.key) {
        case 'ArrowDown': move({ row: rows[Math.min(rows.length - 1, at + 1)].row.id, column }); return true
        case 'ArrowUp': move({ row: rows[Math.max(0, at - 1)].row.id, column }); return true
        case 'Home': move({ row: rows[0].row.id, column }); return true
        case 'End': move({ row: rows[rows.length - 1].row.id, column }); return true
        case 'ArrowLeft':
          if (column < 0 && here.parent && here.open) onToggle(here.row.id, false)
          else if (column < 0 && here.row.parentId !== undefined) move({ row: here.row.parentId, column })
          else if (column >= 0) move({ row: here.row.id, column: column - 1 })
          return true
        case 'ArrowRight':
          if (column < 0 && here.parent && !here.open) onToggle(here.row.id, true)
          else move({ row: here.row.id, column: Math.min(columns.length - 1, column + 1) })
          return true
        case 'Enter':
          if (!event.ctrlKey && !event.metaKey) return false
          onTransactions({ row: here.row.id, column: column >= 0 ? column : firstFigure(here.row.id) })
          return true
        case 'F10':
          if (!event.shiftKey) return false
          menuAt(here.row.id, column)
          return true
        case 'ContextMenu':
          menuAt(here.row.id, column)
          return true
        default: return false
      }
    })()
    if (handled) event.preventDefault()
  }

  return (
    <TableContainer sx={{ overflowX: 'auto' }}>
      <Table size="small" role="treegrid" aria-label={label} onKeyDown={onKeyDown} sx={TABLE_STYLES}>
        <TableHead>
          {groups && (
            <TableRow>
              <TableCell />
              {groups.map((g, i) => <TableCell key={i} colSpan={g.span} align="center" sx={{ typography: 'caption', color: 'text.secondary', borderBottom: g.label ? undefined : 'none' }}>{g.label}</TableCell>)}
            </TableRow>
          )}
          <TableRow>
            <TableCell sx={{ minWidth: '16em' }} />
            {columns.map((c, i) => (
              <TableCell key={c.key} align="right" sx={{ width: `${widths[i]}em`, minWidth: `${widths[i]}em`, whiteSpace: 'nowrap', fontWeight: c.total ? 600 : undefined }}>{c.label}</TableCell>
            ))}
          </TableRow>
        </TableHead>
        <TableBody>
          {rows.slice(0, drawn).map(({ row, parent, open }, i) => (
            <Row
              key={row.id} row={row} columns={columns} currency={result.currency} parent={parent} open={open}
              {...(row.id === selected?.row && { selectedColumn: selected.column })}
              focusable={current < 0 && i === 0} handlers={handlers} register={register}
            />
          ))}
        </TableBody>
      </Table>
      {drawn < rows.length && <Box sx={{ px: 2, py: 0.5, typography: 'caption', color: 'text.secondary' }} data-drawing>Drawing {rows.length - drawn} more rows…</Box>}
    </TableContainer>
  )
}
