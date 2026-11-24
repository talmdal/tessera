// The report as printed, or saved as PDF (R6): drawn in the shell's print area, off screen, only while printing. Its
// title and subtitle, what it is compared with, the chart (if the view shows one) at the page's width, the whole table
// as the view shows it (rows folded stay folded; nothing scrolls, and it isn't drawn in chunks), the notes, and the
// ledger and the date it was printed. It picks the page: portrait when the table fits across it, else landscape; a
// table wider than a landscape page is scaled down to fit, or, where that would leave it too small to read, printed in
// blocks of columns one under another, each with the rows' labels; so no figure is ever cut off. Once drawn, and the
// chart with it, it says so (`onReady`), with the orientation. See docs/reporting-design.md, "Printing and exporting".
import { Suspense, lazy, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReportNote, ReportResult, ResultColumn, ResultRow } from '@tessera/reports-api'
import { Box, PRINT_WIDTHS, PrintArea, Typography } from '@tessera/ui'
import type { ChartModel } from './chartModel'
import { figure } from './display'
import { headingGroups, isBad, visibleRows } from './tableModel'

const ResultChart = lazy(() => import('./ResultChart'))

export interface PrintLayoutProps {
  /** The report's name: a saved report's own. */
  title: string
  result: ReportResult
  /** What the view shows: the chart, the table, or both. */
  show: 'chart' | 'table' | 'both'
  /** The chart, when the report has one. */
  model?: ChartModel
  collapsed: ReadonlySet<string>
  /** The parameters the subtitle doesn't say, as text: "Compared with the period before". */
  lines: string[]
  /** Notes of the view's own (an option no longer offered), then the result's. */
  notes: readonly string[]
  ledgerName: string
  /** Said instead of the table when every figure is nothing. */
  emptyText?: string
  /** When it is printed: 'Nov 17, 2026, 10:42 AM'. */
  printedAt: string
  /** Drawn, and ready to print, on a landscape page or not. */
  onReady(landscape: boolean): void
}

/** The table's styles, once, keyed by data attributes: the print table has thousands of cells, drawn at once. */
const TABLE_STYLES = {
  borderCollapse: 'collapse', typography: 'body2',
  '& th, & td': { px: 1, py: 0.25, borderBottom: 1, borderColor: 'divider', textAlign: 'left', verticalAlign: 'bottom' },
  '& tbody th': { fontWeight: 400 },
  '& thead th': { fontWeight: 600, whiteSpace: 'nowrap' },
  '& thead th[data-group]': { typography: 'caption', color: 'text.secondary', textAlign: 'center', borderBottom: 0 },
  '& td[data-column], & th[data-column]': { textAlign: 'right', whiteSpace: 'nowrap' },
  '& td[data-column]': { typography: 'numeric' },
  '& td[data-bad]': { color: 'error.main' },
  '& [data-total]': { fontWeight: 600 },
  '& tr[data-strong] > *': { fontWeight: 600 },
  '& tr[data-kind="balance"] > th': { fontStyle: 'italic' },
  '& tr[data-rule] > *': { borderTop: 1, borderTopColor: 'text.secondary' }
} as const

const STRONG = new Set(['subtotal', 'total', 'net', 'heading'])

/** Resolves after a frame has been painted (at once where there are no frames). */
const nextFrame = () => new Promise<void>(resolve => {
  if (typeof requestAnimationFrame !== 'function') { setTimeout(resolve, 0); return }
  requestAnimationFrame(() => setTimeout(resolve, 0))
})

/**
 * Waits for what is drawn after the first render: the fonts, and the chart, which is loaded on first use and draws at
 * its container's width once measured. In a page with no layout (jsdom) there is nothing to measure, so only the chart's
 * element is waited for. Gives up after `limitMs`, printing what there is.
 */
async function drawn(area: HTMLElement | null, chart: boolean, limitMs = 10_000): Promise<void> {
  await (document as { fonts?: { ready?: Promise<unknown> } }).fonts?.ready
  const start = Date.now()
  const laidOut = (area?.getBoundingClientRect().width ?? 0) > 0
  const chartDrawn = () => {
    const box = area?.querySelector('[data-chart]')
    if (!box) return false
    if (!laidOut) return true
    // The chart's own surface, not the legend's marks: the widest drawing in it, with something drawn
    const svgs = [...box.querySelectorAll('svg')].sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)
    const svg = svgs[0]
    return svg !== undefined && svg.getBoundingClientRect().width > 0 && svg.querySelector('path, rect') !== null
  }
  while (chart && !chartDrawn() && Date.now() - start < limitMs) await nextFrame()
  await nextFrame()
  await nextFrame()
}

export function PrintLayout(props: PrintLayoutProps) {
  const [page, setPage] = useState<Page>()
  return (
    <PrintArea title={props.title} landscape={page?.landscape ?? true}>
      <PrintPage {...props} page={page} onMeasured={setPage} />
    </PrintArea>
  )
}

/** The smallest a table is scaled to fit across a page: below it, its columns print in blocks instead. */
export const MIN_ZOOM = 0.7

/**
 * The page it prints on, and how its table fits across it: landscape or not, and the table's columns in blocks, one
 * under another, each with the rows' labels and scaled to fit (1: as drawn). One block, unless scaling the whole table
 * to fit would make it smaller than `MIN_ZOOM`.
 */
export interface Page {
  landscape: boolean
  blocks: { columns: number[], zoom: number }[]
}

/**
 * The page for a table as wide as `table` drawn as it likes, whose rows' labels take `label` of it and each column
 * `columns[i]` (pixels): portrait if it fits across one, else landscape; scaled down to fit if that leaves it at least
 * `MIN_ZOOM` of its size; else its columns in blocks that each fit as drawn, in order, the labels repeated in each.
 */
export function pageFor(table: number, label: number, columns: readonly number[]): Page {
  const all = columns.map((_, i) => i)
  const landscape = table > PRINT_WIDTHS.portrait
  const across = landscape ? PRINT_WIDTHS.landscape : PRINT_WIDTHS.portrait
  if (table <= across) return { landscape, blocks: [{ columns: all, zoom: 1 }] }
  if (across / table >= MIN_ZOOM) return { landscape, blocks: [{ columns: all, zoom: across / table }] }
  const blocks: Page['blocks'] = []
  let current: number[] = []
  let width = label
  const close = () => { if (current.length > 0) blocks.push({ columns: current, zoom: Math.min(1, across / width) }) }
  columns.forEach((w, i) => {
    if (current.length > 0 && width + w > across) { close(); current = []; width = label }
    current.push(i)
    width += w
  })
  close()
  // As many blocks as that, but as even as they fit: not six, six, six, six and the total alone
  const per = Math.ceil(columns.length / blocks.length)
  const even = Array.from({ length: blocks.length }, (_, b) => all.slice(b * per, (b + 1) * per)).filter(c => c.length > 0)
  const widthOf = (block: number[]) => label + block.reduce((sum, i) => sum + columns[i], 0)
  if (even.length === blocks.length && even.every(block => widthOf(block) <= across)) {
    return { landscape, blocks: even.map(block => ({ columns: block, zoom: 1 })) }
  }
  return { landscape, blocks }
}

/**
 * The layout itself, inside the print area: so it is measured once in the document, first drawn as wide as it likes on
 * a landscape-wide area (its table's width says which page it needs), then again for its page.
 */
function PrintPage({ title, result, show, model, collapsed, lines, notes, ledgerName, emptyText, printedAt, onReady, page, onMeasured }: PrintLayoutProps & {
  page: Page | undefined
  onMeasured(page: Page): void
}) {
  const table = useRef<HTMLTableElement>(null)
  const area = useRef<HTMLDivElement>(null)
  const empty = result.rows.every(r => r.values.every(v => v === null || v === 0))
  const chart = model !== undefined && show !== 'table' && !empty
  const tabled = show !== 'chart'
  const rows = visibleRows(result.rows, collapsed)

  useLayoutEffect(() => {
    if (page) return
    const heads = [...table.current?.querySelectorAll('thead tr:last-child th') ?? []].map(th => th.getBoundingClientRect().width)
    onMeasured(pageFor(table.current?.scrollWidth ?? 0, heads[0] ?? 0, result.columns.map((_, i) => heads[i + 1] ?? 0)))
  }, [page])

  // Then, laid out for its page and with the chart drawn, it is ready
  const ready = useRef(onReady)
  ready.current = onReady
  useEffect(() => {
    if (!page) return
    let live = true
    drawn(area.current, chart).then(() => { if (live) ready.current(page.landscape) })
    return () => { live = false }
  }, [page])

  const across = page?.landscape === false ? PRINT_WIDTHS.portrait : PRINT_WIDTHS.landscape
  return (
    <Box ref={area} data-print-layout data-orientation={page ? (page.landscape ? 'landscape' : 'portrait') : 'measuring'}>
      <Typography variant="h6" component="h1" sx={{ lineHeight: 1.3 }}>{title}</Typography>
      <Typography variant="body2" color="text.secondary" data-subtitle>{result.subtitle}</Typography>
      {lines.map(line => <Typography key={line} variant="body2" color="text.secondary" data-parameter>{line}</Typography>)}

      {empty
        ? <Typography sx={{ mt: 2 }} data-empty>{emptyText ?? 'Nothing to show for these accounts in this period.'}</Typography>
        : <>
            {chart && page && (
              <Box sx={{ width: across, mt: 1.5, breakInside: 'avoid' }} data-print-chart>
                <Suspense fallback={null}>
                  <ResultChart model={model!} result={result} height={show === 'chart' ? 420 : 300} />
                </Suspense>
              </Box>
            )}
            {tabled && (page?.blocks ?? [{ columns: result.columns.map((_, i) => i), zoom: 1 }]).map((block, b, blocks) => {
              // Measuring: as wide as it likes. Then as wide as the page, or scaled down to fit across it
              const fits = page !== undefined && block.zoom === 1
              const part = blocks.length > 1 ? ` (part ${b + 1} of ${blocks.length})` : ''
              return (
                <Box key={b} sx={{ mt: 1.5, zoom: block.zoom }} data-print-block={b}>
                  <Box component="table" ref={b === 0 ? table : undefined} aria-label={`${title}, ${result.subtitle}${part}`} data-print-table
                    sx={{ ...TABLE_STYLES, width: fits ? undefined : 'max-content', minWidth: fits ? '100%' : undefined }}>
                    <PrintTableHead columns={result.columns} shown={block.columns} />
                    <tbody>
                      {rows.map(({ row }) => <PrintRow key={row.id} row={row} columns={result.columns} shown={block.columns} currency={result.currency} />)}
                    </tbody>
                  </Box>
                </Box>
              )
            })}
          </>}

      {notes.length + result.notes.length > 0 && (
        <Box sx={{ mt: 1.5 }} data-notes>
          {notes.map(text => <Typography key={text} variant="body2" color="text.secondary" data-note="info">{text}</Typography>)}
          {result.notes.map((n: ReportNote) => <Typography key={n.text} variant="body2" color="text.secondary" data-note={n.tone}>{n.text}</Typography>)}
        </Box>
      )}
      <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 1.5 }} data-printed>
        {`${ledgerName} · Printed ${printedAt}`}
      </Typography>
    </Box>
  )
}

/** A block's headings: its columns' groups (the months of several figures each) over their labels. */
function PrintTableHead({ columns, shown }: { columns: readonly ResultColumn[], shown: readonly number[] }) {
  const own = shown.map(i => columns[i])
  const groups = headingGroups(own)
  return (
    <thead>
      {groups && (
        <tr>
          <th />
          {groups.map((g, i) => <th key={i} colSpan={g.span} data-group>{g.label}</th>)}
        </tr>
      )}
      <tr>
        <th />
        {own.map(c => <th key={c.key} data-column {...(c.total && { 'data-total': true })}>{c.label}</th>)}
      </tr>
    </thead>
  )
}

function PrintRow({ row, columns, shown, currency }: { row: ResultRow, columns: readonly ResultColumn[], shown: readonly number[], currency: string | null }) {
  return (
    <tr data-print-row={row.id} data-kind={row.kind} {...(STRONG.has(row.kind) && { 'data-strong': true })}
      {...((row.kind === 'total' || row.kind === 'net') && { 'data-rule': true })}>
      <th scope="row" style={{ paddingLeft: `${0.5 + (row.depth - 1) * 1.25}em` }}>{row.label}</th>
      {shown.map(i => {
        const c = columns[i]
        const value = row.kind === 'heading' ? null : row.values[i] ?? null
        return (
          <td key={c.key} data-column={i} {...(isBad(row, c, value) && { 'data-bad': true })} {...(c.total && { 'data-total': true })}>
            {row.kind === 'heading' ? '' : figure(value, c, row.currency ?? currency)}
          </td>
        )
      })}
    </tr>
  )
}
