// The report view (main area): one report. Its heading names it and holds its parameters; changing one runs it again
// at once. The body is the chart above the table, or either alone; notes under them. What it shows (its parameters,
// options, chart or table, rows folded) is reported as it changes: a saved report is told apart from what was saved,
// and one not saved is remembered, to open as it was left (R4). Customise Report… and saving run commands. It runs again when its figures may have changed, but only while on screen: hidden behind another view
// (which the shell keeps mounted), it is marked stale and runs once when shown again. A reply to an earlier run is
// dropped, so a quick Page Up, Page Up ends on the period shown; a failed run never leaves an old result on screen as
// if current. Asked to print (Print Report…, Save Report as PDF…), it draws the report in its print layout and says
// when it is ready; the plugin prints the window (R6). See docs/reporting-design.md, "The Reports tab and the report
// view" and "Printing and exporting".
import { KeyboardEvent, Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react'
import {
  REPORTS_CHANNELS, REPORTS_COMMANDS as C, REPORTS_EVENTS, resolveAsOf,
  type OpenedView, type OptionValues, type PrintReady, type PrintRequest, type ReportParameters, type ReportResult, type ReportsCatalog,
  type ReportsResult, type RunArgs, type StaleEvent, type TransactionsArgs
} from '@tessera/reports-api'
import {
  Alert, Box, Button, CircularProgress, Divider, Icon, IconButton, LinearProgress, ListItemIcon, ListItemText, Menu, MenuItem, Stack,
  ToggleButton, ToggleButtonGroup, Toolbar, Tooltip, Typography
} from '@tessera/ui'
import { runCommand, useEvent, useFollowed, useShown } from './bridge'
import { chartModel } from './chartModel'
import { showDate, showTime } from './display'
import { COMPARE_LABELS, ParameterBar, stepParameters } from './ParameterBar'
import { PrintLayout, type PrintLayoutProps } from './PrintLayout'
import { ResultTable, type Cell } from './ResultTable'
import { canDrill, parentsOf } from './tableModel'

// Loaded the first time a chart is drawn, with @tessera/ui/charts (MUI X Charts) behind it
const ResultChart = lazy(() => import('./ResultChart'))

type Show = 'chart' | 'table' | 'both'

const refKey = (shown: NonNullable<ReportsCatalog['shown']>) => 'savedId' in shown.ref ? `saved:${shown.ref.savedId}` : `definition:${shown.ref.definitionId}`

export default function ReportView() {
  const catalog = useFollowed<ReportsCatalog | null>(REPORTS_CHANNELS.catalog, REPORTS_EVENTS.catalog)
  if (catalog === undefined) return <Stack sx={{ p: 3, alignItems: 'center' }}><CircularProgress size={20} aria-label="Loading reports" /></Stack>
  if (catalog === null) return <Typography color="text.secondary" sx={{ p: 3 }}>Open a ledger to see its reports.</Typography>
  if (!catalog.shown) return <Landing catalog={catalog} />
  return <ReportPage key={refKey(catalog.shown)} shown={catalog.shown} catalog={catalog} />
}

/** Nothing chosen yet: the reports offered, to choose one. */
function Landing({ catalog }: { catalog: ReportsCatalog }) {
  const [error, setError] = useState<string>()
  return (
    <Stack sx={{ p: 3, gap: 1.5, alignItems: 'flex-start' }} data-reports-page="landing">
      <Typography variant="h6" component="h1">Reports</Typography>
      <Typography color="text.secondary">Choose a report, here or in the Reports tab.</Typography>
      {catalog.groups.map(g => (
        <Box key={g.id}>
          <Typography variant="overline" color="text.secondary" component="h2">{g.label}</Typography>
          <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 1 }}>
            {catalog.definitions.filter(d => d.group === g.id).map(d => (
              <Tooltip key={d.id} title={d.enabled ? d.description : d.reason ?? d.description}>
                <span>
                  <Button variant="outlined" size="small" disabled={!d.enabled}
                    onClick={() => { runCommand(C.show, { definitionId: d.id }).catch(err => setError(String(err?.message ?? err))) }}>
                    {d.label}
                  </Button>
                </span>
              </Tooltip>
            ))}
          </Stack>
        </Box>
      ))}
      {error && <Alert severity="error">{error}</Alert>}
    </Stack>
  )
}

interface Run {
  result?: ReportResult
  /** What went wrong with the last run, when it failed. */
  problem?: string
  running: boolean
}

function ReportPage({ shown, catalog }: { shown: NonNullable<ReportsCatalog['shown']>, catalog: ReportsCatalog }) {
  const key = refKey(shown)
  const saved = 'savedId' in shown.ref
  const readOnly = catalog.readOnly
  const [view, setView] = useState<OpenedView>()
  const [openProblem, setOpenProblem] = useState<string>()
  const [opens, setOpens] = useState(0)
  const [parameters, setParameters] = useState<ReportParameters>()
  const [run, setRun] = useState<Run>({ running: false })
  const [reloads, setReloads] = useState(0)
  const [options, setOptions] = useState<OptionValues>()
  const [show, setShowChoice] = useState<Show>()
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const [more, setMore] = useState<HTMLElement>()
  const [selected, setSelected] = useState<Cell>()
  const [menu, setMenu] = useState<{ cell: Cell, at: { top: number, left: number } }>()
  const [error, setError] = useState<string>()

  // Open the report: its heading's choices and the parameters it starts with, the command's over them
  useEffect(() => {
    let live = true
    window.api.invoke<ReportsResult<OpenedView>>(REPORTS_CHANNELS.open, { ref: shown.ref }).then(result => {
      if (!live) return
      // Opened again (the ledger changed under it): new choices, and what is chosen kept
      if (result.ok) {
        const opened = result.value
        setView(opened)
        setOpenProblem(undefined)
        setParameters(current => current ?? { ...opened.parameters, ...shown.parameters })
        setOptions(current => current ?? { ...opened.options, ...shown.options })
        setShowChoice(current => current ?? shown.show ?? opened.show)
        if (!foldedOnce.current) { foldedOnce.current = true; setCollapsed(new Set(opened.collapsed)) }
      } else setOpenProblem(result.error.message)
    }, err => { if (live) setOpenProblem(String(err?.message ?? err)) })
    return () => { live = false }
  }, [opens])
  const foldedOnce = useRef(false)
  // Asked to show it again, with other parameters (another plugin's link) or options (Customise Report…): those now
  const lastRequest = useRef(shown.request)
  useEffect(() => {
    if (shown.request === lastRequest.current) return
    lastRequest.current = shown.request
    if (shown.parameters) setParameters(current => ({ ...current, ...shown.parameters }))
    if (shown.options) setOptions({ ...shown.options })
    if (shown.show) setShowChoice(shown.show)
  }, [shown.request])

  // Run it whenever the parameters change, or its figures may have; a late reply to an earlier run is dropped
  const latest = useRef(0)
  const args: RunArgs | undefined = view && parameters && options ? { ref: shown.ref, parameters, options } : undefined
  const argsText = JSON.stringify(args ?? null)
  useEffect(() => {
    if (!args) return
    const request = ++latest.current
    setRun(current => ({ ...current, running: true }))
    window.api.invoke<ReportsResult<ReportResult>>(REPORTS_CHANNELS.run, args).then(result => {
      if (request !== latest.current) return
      setRun(current => result.ok ? { result: result.value, running: false } : { result: current.result, problem: result.error.message, running: false })
    }, err => { if (request === latest.current) setRun(current => ({ result: current.result, problem: String(err?.message ?? err), running: false })) })
  }, [argsText, reloads])
  // What the view shows, for the commands and context keys, so Accounts carries to the next report, a report not saved
  // opens as it was left, and a saved one is told apart from what was saved. Commands wait for it, so they act on what
  // the user sees
  const selected$ = useRef<Promise<unknown>>(Promise.resolve())
  const foldedText = JSON.stringify([...collapsed].sort())
  useEffect(() => {
    if (!args || !show) return
    selected$.current = window.api.invoke(REPORTS_CHANNELS.select, { ...args, view: { show, collapsed: [...collapsed].sort() } }).catch(() => undefined)
  }, [argsText, show, foldedText])
  const command = (id: string, ...commandArgs: unknown[]) => {
    setMore(undefined)
    setError(undefined)
    selected$.current.then(() => runCommand(id, ...commandArgs)).catch(err => setError(String(err?.message ?? err)))
  }

  // Run again only while on screen; hidden, once when shown again, however many changes came meanwhile
  const root = useRef<HTMLDivElement>(null)
  const onScreen = useShown(root)
  const [stale, setStale] = useState(false)
  useEvent<StaleEvent>(REPORTS_EVENTS.stale, event => {
    if (!view || (event?.sources !== null && !event?.sources?.includes(view.source.id))) return
    if (onScreen) reload(); else setStale(true)
  })
  useEffect(() => {
    if (onScreen && stale) { setStale(false); reload() }
  }, [onScreen, stale])
  /** The figures again, and the heading's choices (accounts added, a new year start), the parameters kept. */
  function reload() {
    setOpens(n => n + 1)
    setReloads(n => n + 1)
  }

  const result = run.result
  const model = useMemo(() => result && view?.hasChart ? chartModel(result) : undefined, [result, view?.hasChart])
  // What is drawn: the choice, but the table alone when there is no chart to draw
  const shownAs: Show = !model ? 'table' : show ?? 'both'

  const toggle = (rowId: string, open: boolean) => {
    const next = new Set(collapsed)
    if (open) next.delete(rowId); else next.add(rowId)
    setCollapsed(next)
  }
  const setAll = (open: boolean) => setCollapsed(open || !result ? new Set<string>() : parentsOf(result.rows))

  const showTransactions = (cell: Cell) => {
    if (!result || !args || !view) return
    const row = result.rows.find(r => r.id === cell.row)
    const column = result.columns[cell.column]
    const value = row && column ? row.values[cell.column] ?? null : null
    if (!row || !column || !canDrill(row, column, value)) return
    const currency = row.currency ?? result.currency ?? undefined
    const request: TransactionsArgs = {
      ...args, row: row.drill!, column: column.drill!, ...(currency && { currency }), label: row.label,
      columnLabel: [column.group, column.label].filter(Boolean).join(' '), figure: value
    }
    setError(undefined)
    runCommand(C.transactions, request).catch(err => setError(String(err?.message ?? err)))
  }

  const onKey = (event: KeyboardEvent) => {
    if (!view || !parameters) return
    if (event.key === 'F5') { event.preventDefault(); setReloads(n => n + 1); return }
    if (event.key === 'PageUp' || event.key === 'PageDown') {
      const next = stepParameters(parameters, event.key === 'PageUp' ? -1 : 1, view)
      if (next) { event.preventDefault(); setParameters(next) }
    }
  }

  // Print Report… and Save Report as PDF…: the report is drawn in the print layout, as the view shows it once its figures
  // are worked out, and the plugin told when it is ready (or why it can't be). What is printed is kept as it was drawn
  // until the plugin has printed it, even if the figures run again meanwhile (the print dialog can stay open a while)
  const [printing, setPrinting] = useState<PrintRequest & { at: string, layout?: Omit<PrintLayoutProps, 'onReady'> }>()
  const answered = useRef(new Set<number>())
  useEvent<PrintRequest>(REPORTS_EVENTS.print, request => {
    if (typeof request?.request === 'number') setPrinting({ ...request, at: printedAt() })
  })
  const printReady = (ready: PrintReady) => {
    if (answered.current.has(ready.request)) return
    answered.current.add(ready.request)
    window.api.invoke<ReportsResult<boolean>>(REPORTS_CHANNELS.printReady, ready)
      .catch(err => setError(String(err?.message ?? err)))
      .finally(() => setPrinting(current => current?.request === ready.request ? undefined : current))
  }
  const printable = printing !== undefined && view !== undefined && run.result !== undefined && !run.running && run.problem === undefined
  useEffect(() => {
    if (!printing || printing.layout) return
    if (printable) {
      const layout: Omit<PrintLayoutProps, 'onReady'> = {
        title: view.title, result: run.result!, show: shownAs, model, collapsed, lines: parameters ? compareLines(view, parameters) : [],
        notes: view.notes, ledgerName: view.choices.ledgerName, printedAt: printing.at, ...(view.emptyText && { emptyText: view.emptyText })
      }
      setPrinting(current => current?.request === printing.request ? { ...current, layout } : current)
      return
    }
    // Nothing to print: the report couldn't be opened, or its figures worked out; else it is still on its way
    const problem = openProblem ?? (!run.running && view && parameters ? run.problem ?? (run.result ? undefined : 'The report hasn’t been worked out.') : undefined)
    if (problem) printReady({ request: printing.request, problem })
  }, [printing, printable, openProblem, run, view, parameters])

  // One root, whatever the page shows: it is what `useShown` watches, from the first render
  const page = openProblem ? 'problem' : !view || !parameters ? 'opening' : 'report'
  return (
    <Stack ref={root} sx={{ height: '100%', overflow: 'auto' }} onKeyDown={onKey} data-reports-page={page} data-report={key}>
      {openProblem
        ? <Stack sx={{ p: 3, gap: 1.5, alignItems: 'flex-start' }}>
            <Typography variant="h6" component="h1">{catalog.definitions.find(d => 'definitionId' in shown.ref && d.id === shown.ref.definitionId)?.label ?? 'Report'}</Typography>
            <Alert severity="error" action={<Button size="small" onClick={() => { setOpenProblem(undefined); setOpens(n => n + 1) }}>Try Again</Button>}>{openProblem}</Alert>
          </Stack>
        : !view || !parameters
          ? <Stack sx={{ p: 3, alignItems: 'center' }}><CircularProgress size={20} aria-label="Opening the report" /></Stack>
          : report()}
      {printing?.layout && (
        <PrintLayout key={printing.request} {...printing.layout} onReady={landscape => printReady({ request: printing.request, landscape })} />
      )}
    </Stack>
  )

  /** The report opened: its heading, parameters, figures and notes. Called, not drawn as a component of its own, so its
   * parts keep their state from render to render. */
  function report() {
    if (!view || !parameters) return null

    const empty = result !== undefined && result.rows.every(r => r.values.every(v => v === null || v === 0))
    const failedOver = run.problem !== undefined && result !== undefined
    const menuRow = menu && result?.rows.find(r => r.id === menu.cell.row)
    const menuColumn = menu && menu.cell.column >= 0 ? result?.columns[menu.cell.column] : undefined
    const menuDrill = menuRow && menuColumn ? canDrill(menuRow, menuColumn, menuRow.values[menu!.cell.column] ?? null) : false

    return (
      <>
        <Toolbar variant="dense" disableGutters sx={{ px: 2, gap: 1, minHeight: 48, alignItems: 'center' }}>
          <Box sx={{ minWidth: 0 }}>
            <Tooltip title={view.description} placement="bottom-start" enterDelay={600} describeChild>
              <Typography variant="h6" component="h1" noWrap>{view.title}</Typography>
            </Tooltip>
            {result && <Typography variant="caption" color="text.secondary" component="div" noWrap data-subtitle>{result.subtitle}</Typography>}
          </Box>
          <Box sx={{ flex: 1 }} />
          {model && (
            <ToggleButtonGroup size="small" exclusive value={shownAs} aria-label="Show" onChange={(_event, value: Show | null) => { if (value) setShowChoice(value) }}>
              <ToggleButton value="chart" sx={{ py: 0.25 }}>Chart</ToggleButton>
              <ToggleButton value="table" sx={{ py: 0.25 }}>Table</ToggleButton>
              <ToggleButton value="both" sx={{ py: 0.25 }}>Both</ToggleButton>
            </ToggleButtonGroup>
          )}
          <Button size="small" onClick={() => command(C.customise)}>Customise…</Button>
          <Tooltip title={readOnly ? 'This ledger is open read-only' : 'Keep this report, as it is now, in the ledger'}>
            <span><Button size="small" disabled={readOnly} onClick={() => command(C.saveAs)}>Save As…</Button></span>
          </Tooltip>
          <Tooltip title="Work out the figures again (F5)">
            <Button size="small" onClick={() => setReloads(n => n + 1)}>Refresh</Button>
          </Tooltip>
          <Tooltip title="More">
            <IconButton size="small" aria-label="More actions" aria-haspopup="menu" onClick={event => setMore(event.currentTarget)}><Icon name="MoreVert" /></IconButton>
          </Tooltip>
        </Toolbar>
        <Menu open={more !== undefined} anchorEl={more} onClose={() => setMore(undefined)}>
          {[
            <MenuItem key="customise" onClick={() => command(C.customise)}>
              <ListItemIcon><Icon name="Edit" fontSize="small" /></ListItemIcon><ListItemText>Customise Report…</ListItemText>
            </MenuItem>,
            saved && <MenuItem key="save" disabled={readOnly || !catalog.changed} onClick={() => command(C.save)}>
              <ListItemIcon><Icon name="Save" fontSize="small" /></ListItemIcon><ListItemText>Save Report</ListItemText>
            </MenuItem>,
            <MenuItem key="saveAs" disabled={readOnly} onClick={() => command(C.saveAs)}>
              <ListItemIcon><Icon name="Save" fontSize="small" /></ListItemIcon><ListItemText>Save Report As…</ListItemText>
            </MenuItem>,
            saved && <Divider key="divider" />,
            saved && <MenuItem key="rename" disabled={readOnly} onClick={() => command(C.rename)}>
              <ListItemIcon><Icon name="Edit" fontSize="small" /></ListItemIcon><ListItemText>Rename…</ListItemText>
            </MenuItem>,
            saved && <MenuItem key="duplicate" disabled={readOnly} onClick={() => command(C.duplicate)}>
              <ListItemIcon><Icon name="ContentCopy" fontSize="small" /></ListItemIcon><ListItemText>Duplicate…</ListItemText>
            </MenuItem>,
            saved && <MenuItem key="delete" disabled={readOnly} onClick={() => command(C.deleteSaved)}>
              <ListItemIcon><Icon name="Delete" fontSize="small" /></ListItemIcon><ListItemText>Delete…</ListItemText>
            </MenuItem>,
            <Divider key="output" />,
            <MenuItem key="exportCsv" onClick={() => command(C.exportCsv)}>
              <ListItemIcon><Icon name="FileDownload" fontSize="small" /></ListItemIcon><ListItemText>Export Report…</ListItemText>
            </MenuItem>,
            <MenuItem key="print" onClick={() => command(C.print)}>
              <ListItemIcon><Icon name="Print" fontSize="small" /></ListItemIcon><ListItemText secondary="Ctrl+P">Print Report…</ListItemText>
            </MenuItem>,
            <MenuItem key="savePdf" onClick={() => command(C.savePdf)}>
              <ListItemIcon><Icon name="PictureAsPdf" fontSize="small" /></ListItemIcon><ListItemText>Save Report as PDF…</ListItemText>
            </MenuItem>
          ].filter(Boolean)}
        </Menu>
        <ParameterBar view={view} parameters={parameters} resolvedCurrency={result?.currency} onChange={setParameters} />
        {printing && (
          <Typography variant="body2" color="text.secondary" sx={{ px: 2 }} role="status" data-printing>
            {printing.output === 'pdf' ? 'Saving the report as PDF…' : 'Printing the report…'}
          </Typography>
        )}
        <Box sx={{ height: 4 }}>{run.running && <LinearProgress aria-label="Working out the figures" />}</Box>
        <Divider />

        {view.readOnly && <Alert severity="info" sx={{ mx: 2, my: 0.5 }}>This ledger is open read-only: its reports can be run, and nothing it holds can change.</Alert>}
        {error && <Alert severity="error" sx={{ mx: 2, my: 0.5 }} onClose={() => setError(undefined)}>{error}</Alert>}
        {run.problem && (
          <Alert severity="error" sx={{ mx: 2, my: 0.5 }} data-problem
            action={<Button size="small" onClick={() => setReloads(n => n + 1)}>Try Again</Button>}>
            {run.problem}
            {failedOver && ` Showing the figures from ${showTime(result!.at)}.`}
          </Alert>
        )}

        {result === undefined
          ? !run.problem && <Stack sx={{ p: 3, alignItems: 'center' }}><CircularProgress size={20} aria-label="Working out the figures" /></Stack>
          : empty
            ? <Typography color="text.secondary" sx={{ px: 2, py: 3 }} data-empty>{view.emptyText ?? 'Nothing to show for these accounts in this period.'}</Typography>
            : <Box sx={{ opacity: failedOver ? 0.6 : 1 }}>
                {model && shownAs !== 'table' && (
                  <Box sx={{ px: 2, pt: 1 }} data-chart-area>
                    <Suspense fallback={<Box sx={{ height: 280 }} />}>
                      <ResultChart model={model} result={result} height={shownAs === 'chart' ? 420 : 280} />
                    </Suspense>
                  </Box>
                )}
                {shownAs !== 'chart' && (
                  <ResultTable
                    result={result} collapsed={collapsed} selected={selected} label={`${view.title}, ${result.subtitle}`}
                    onSelect={setSelected} onToggle={toggle} onTransactions={showTransactions}
                    onMenu={(cell, at) => setMenu({ cell, at })}
                  />
                )}
              </Box>}
        {(result?.notes.length ?? 0) + view.notes.length > 0 && (
          <Box sx={{ px: 2, py: 1 }} data-notes>
            {view.notes.map(text => <Typography key={text} variant="body2" color="text.secondary" data-note="info">{text}</Typography>)}
            {result?.notes.map(n => (
              <Typography key={n.text} variant="body2" color={n.tone === 'warning' ? 'warning.main' : 'text.secondary'} data-note={n.tone}>{n.text}</Typography>
            ))}
          </Box>
        )}

        <Menu open={menu !== undefined} onClose={() => setMenu(undefined)} anchorReference="anchorPosition" anchorPosition={menu?.at}>
          <MenuItem disabled={!menuDrill} onClick={() => { const cell = menu!.cell; setMenu(undefined); showTransactions(cell) }}>
            <ListItemText secondary="Ctrl+Enter">Show Transactions</ListItemText>
          </MenuItem>
          <Divider />
          <MenuItem onClick={() => { setMenu(undefined); setAll(true) }}><ListItemText>Expand All</ListItemText></MenuItem>
          <MenuItem onClick={() => { setMenu(undefined); setAll(false) }}><ListItemText>Collapse All</ListItemText></MenuItem>
        </Menu>
      </>
    )
  }
}

/** When a report is printed, as its last line says: 'Nov 17, 2026, 10:42 AM', in the user's locale. */
const printedAt = () => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date())

/** What the printed report is compared with, which its subtitle doesn't say: "Compared with the period before". */
export function compareLines(view: Pick<OpenedView, 'grain' | 'today' | 'yearStart'>, parameters: ReportParameters): string[] {
  const compare = parameters.compare
  if (compare === undefined || compare === 'none') return []
  if (typeof compare === 'object') {
    const [date] = resolveAsOf(compare.asOf, view.grain, view.today, view.yearStart)
    return date ? [`Compared with ${showDate(date)}`] : []
  }
  if (compare === 'subLedgers') return ['Sub-ledgers side by side']
  const label = COMPARE_LABELS[compare]
  return label ? [`Compared with ${label.charAt(0).toLocaleLowerCase()}${label.slice(1)}`] : []
}
