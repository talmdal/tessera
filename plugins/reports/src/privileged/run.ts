// A run: a spec and the parameters the heading chose, turned into a result. The parameters are resolved against the
// open ledger (its year start, its accounts, today): the period or dates, the scope (checked, and for sub-ledgers side
// by side, one per column), the currency. Then the source is asked, once (twice to compare with an earlier period, and
// once more for balance rows), within its time limit; its reply is checked; and the engine shapes it.
// See docs/reporting-design.md, "The model: sources, definitions, results".
import type { Logger } from '@tessera/types'
import { mostUsedCurrency, type AccountsService } from '@tessera/accounts-api'
import { yearStartOf, type LedgerSession, type YearStart } from '@tessera/ledger-api'
import {
  REPORT_COLUMNS_MAX, REPORT_DATES_MAX, ReportsError, SOURCE_TIMEOUT_MS, addDays, columnLabel, firstDayOf, monthOf, comparedPeriod, dateColumns,
  datesLabel, dayLabel, isDate, isMonth, lastDayOf, parameterProblems, periodLabel, resolveAsOf, resolvePeriod, shape, timeColumns,
  type AsOfValue, type DateRange, type DimensionField, type Filter, type PeriodValue, type ReportNote, type ReportParameters, type ReportResult, type ReportSource,
  type ReportSourceContribution, type ReportSpec, type ScopeValue, type ShapeColumn, type SourceQuery, type SourceResult, type TimeColumn
} from '@tessera/reports-api'
import { readLedger } from './FlowsSource'
import { checkedScope, covers, placedAccounts, scopeLabel, scopeOf, subLedgerScopes, type LedgerView, type Placed } from './ledgerView'
import { translate } from './store'

export interface RunDeps {
  session: LedgerSession
  accounts: AccountsService
  log: Pick<Logger, 'warn' | 'error'>
  /** Today, 'YYYY-MM-DD'. */
  today: () => string
  /** Now, ISO 8601: when the figures were worked out. */
  now: () => string
  timeoutMs?: number
}

export interface RunRequest {
  title: string
  /** The spec, options applied and validated. */
  spec: ReportSpec
  source: ReportSourceContribution
  service: ReportSource
  /** The parameters, the spec's defaults filled in. */
  parameters: ReportParameters
  /** Said while opening (an option no longer offered): shown with the figures. */
  notes?: string[]
}

/** The spec's parameter defaults, with the ones given over them. */
export function mergeParameters(spec: ReportSpec, source: ReportSourceContribution, given: ReportParameters = {}): ReportParameters {
  const d = spec.parameters
  const scoped = source.scopes !== 'none'
  return {
    ...(d.period && { period: d.period }), ...(d.asOf && { asOf: d.asOf }),
    ...(scoped && { scope: d.scope ?? { kind: 'ledger' } }),
    ...(source.currency !== false && { currency: d.currency ?? 'mostUsed' }),
    compare: d.compare ?? 'none',
    ...(d.source && { source: { ...d.source } }),
    ...structuredClone(given),
    ...(given.source && { source: { ...d.source, ...given.source } })
  }
}

/** Runs `work` for at most `ms`; TIMEOUT past it. */
export async function within<T>(ms: number, label: string, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => {
    const seconds = Math.max(1, Math.round(ms / 1000))
    timer = setTimeout(() => reject(new ReportsError('TIMEOUT', `The report took too long: “${label}” didn’t answer within ${seconds} second${seconds === 1 ? '' : 's'}.`)), ms)
  })
  try {
    return await Promise.race([work, late])
  } finally {
    clearTimeout(timer)
  }
}

/** Checks a source's reply: rows of the right width, integers only, members for every key. Throws SOURCE_FAILED. */
export function checkReply(reply: unknown, query: SourceQuery, source: ReportSourceContribution): SourceResult {
  const bad = (why: string): never => { throw new ReportsError('SOURCE_FAILED', `The figures from “${source.label}” couldn’t be used: ${why}.`) }
  if (typeof reply !== 'object' || reply === null) bad('it gave nothing')
  const r = reply as SourceResult
  if (!Array.isArray(r.rows) || typeof r.members !== 'object' || r.members === null || !Array.isArray(r.notes)) bad('it gave no rows, members or notes')
  const fields = query.dimensions.map(d => source.fields.find((f): f is DimensionField => f.kind === 'dimension' && f.key === d)!)
  const known = fields.map(f => f.type === 'member' ? new Set((r.members[f.key] ?? []).map(m => m.id)) : f.type === 'enum' ? new Set((f.values ?? []).map(v => v.id)) : undefined)
  const timeKey = source.time === 'asOf' ? isDate : isMonth
  for (const row of r.rows) {
    if (!Array.isArray(row.keys) || row.keys.length !== query.dimensions.length) bad('a row has the wrong number of keys')
    if (!Array.isArray(row.values) || row.values.length !== query.measures.length || !row.values.every(v => Number.isSafeInteger(v))) bad('a row’s figures aren’t whole numbers')
    row.keys.forEach((key, i) => {
      if (key === null) return
      if (typeof key !== 'string') bad('a row has a key that isn’t text')
      if (fields[i].type === 'time' ? !timeKey(key) : !known[i]!.has(key)) bad(`“${key}” isn’t a known ${fields[i].label.toLocaleLowerCase()}`)
    })
    if (query.scopes && !(Number.isInteger(row.scope) && row.scope! >= 0 && row.scope! < query.scopes.length)) bad('a row names no column')
    // Each account's own (currency 'all'), or a source's own (a budget's): text, when given
    if (row.currency !== undefined && typeof row.currency !== 'string') bad('a row’s currency isn’t text')
  }
  return r
}

/** What a run needs from the ledger: read only for a source that reports over accounts. */
interface Ledger {
  view: LedgerView
  placed: Map<string, Placed>
}

/**
 * What a run asks of its source, worked out from the parameters and the open ledger before anything is asked: the
 * period or dates and their columns, the scope (and a scope per sub-ledger side by side), the currency, the grain and
 * filters, and the earlier period compared with. A run asks with it; Show Transactions asks for one figure with it, so
 * the two can't disagree about what a figure covers.
 */
export interface RunPlan {
  /** The query, less its period. */
  base: Omit<SourceQuery, 'period'>
  period: SourceQuery['period']
  /** The time columns across, when time is across. */
  columns?: ShapeColumn[]
  subtitle: string
  /** Sub-ledgers side by side: a scope per column, labelled. */
  scopes?: { scopes: ScopeValue[], labels: string[] }
  /** The earlier period or date compared with, its columns (by position) and its label. */
  compared?: { period: SourceQuery['period'], columns?: ShapeColumn[], label: string }
  /** The heading's picks, as filters. */
  picks: Filter[]
  scope?: ScopeValue
  currency?: string
  ledger?: Ledger
  notes: ReportNote[]
}

export async function planRun(deps: RunDeps, request: Omit<RunRequest, 'service' | 'title'>): Promise<RunPlan> {
  const { spec, source } = request
  const info = deps.session.current
  if (!info) throw new ReportsError('NO_LEDGER', 'No ledger is open.')
  const yearStart: YearStart = yearStartOf(info)
  const today = deps.today()
  const params = request.parameters
  const problems = parameterProblems(params, source, true)
  if (problems.length > 0) throw new ReportsError('INVALID', problems[0].message, problems[0].path)
  const notes: ReportNote[] = (request.notes ?? []).map(text => ({ tone: 'info' as const, text }))

  // The ledger, for scopes, currencies and All dates
  const scoped = source.scopes !== 'none'
  const ledger: Ledger | undefined = scoped || source.currency !== false
    ? await (async () => { const view = await readLedger(deps); return { view, placed: placedAccounts(view) } })()
    : undefined
  let scope: ScopeValue | undefined
  if (scoped && ledger) {
    const checked = checkedScope(params.scope ?? { kind: 'ledger' }, ledger.view, ledger.placed)
    scope = checked.scope
    if (checked.dropped > 0) notes.push({ tone: 'warning', text: `${checked.dropped} account${checked.dropped === 1 ? '' : 's'} chosen for this report no longer exist${checked.dropped === 1 ? 's' : ''}.` })
  }
  const inScope = (): Placed[] => ledger && scope ? [...ledger.placed.values()].filter(a => covers(scopeOf(scope!, ledger.view, undefined), a)) : []

  // The currency: the one most accounts in scope use, unless chosen; each account's own for 'all'
  let currency: string | undefined
  if (source.currency !== false && ledger) {
    const chosen = params.currency ?? 'mostUsed'
    currency = chosen === 'all' ? undefined
      : chosen === 'mostUsed' ? mostUsedCurrency(inScope().filter(a => !a.removed), mostUsedCurrency(ledger.view.accounts, 'CAD'))
        : chosen
  }

  // All dates: the earliest opening date in scope to the latest transaction, or today
  const allDates = async (): Promise<DateRange> => {
    const accounts = inScope()
    const from = accounts.map(a => a.openingDate).sort()[0] ?? today
    const live = accounts.filter(a => !a.removed).map(a => a.id)
    let to = today
    if (live.length > 0) {
      const later = await outside(() => deps.accounts.transactionTotals({ from: addDays(today, 1), to: '9999-12-31', accountIds: live }))
      const last = later.map(t => t.month).sort().pop()
      if (last) to = lastDayOf(last)
    }
    return { from: from < to ? from : to, to }
  }
  const isAll = (period: PeriodValue | undefined) => period !== undefined && 'preset' in period && period.preset === 'allDates'
  const endsAll = (asOf: AsOfValue | undefined) => asOf !== undefined && 'ends' in asOf && isAll(asOf.ends)
  const compareAsOf = typeof params.compare === 'object' ? params.compare.asOf : undefined
  const bounds = isAll(params.period) || endsAll(params.asOf) || endsAll(compareAsOf) ? await allDates() : undefined

  // The period or dates, and the columns across
  const query = spec.query
  const columnsField = query.columns ? source.fields.find((f): f is DimensionField => f.kind === 'dimension' && f.key === query.columns!.dimension) : undefined
  const timeAcross = columnsField?.type === 'time'
  const grain = query.columns?.grain ?? 'month'
  const compare = params.compare ?? 'none'
  const bySubLedger = compare === 'subLedgers'
  let period: SourceQuery['period']
  let columns: TimeColumn[] | undefined
  let subtitle: string
  if (source.time === 'asOf') {
    const dates = resolveAsOf(params.asOf ?? { at: 'today' }, grain, today, yearStart, bounds)
    if (dates.length > REPORT_DATES_MAX) throw new ReportsError('TOO_LARGE', `Choose at most ${REPORT_DATES_MAX} dates: quarter or year ends, or a shorter period.`, 'parameters.asOf')
    period = { dates }
    columns = timeAcross ? dateColumns(dates) : undefined
    subtitle = datesLabel(dates, grain)
  } else {
    let range = resolvePeriod(params.period ?? { preset: 'thisYear' }, today, yearStart, bounds)
    // A source of whole months (a budget's) takes the months the period touches, and the report says so
    if (source.time === 'months') {
      const whole = { from: firstDayOf(monthOf(range.from)), to: lastDayOf(monthOf(range.to)) }
      if (whole.from !== range.from || whole.to !== range.to) {
        notes.push({ tone: 'info', text: `“${source.label}” is kept by whole months, so this shows ${periodLabel(whole, yearStart)}.` })
        range = whole
      }
    }
    period = range
    columns = timeAcross && !bySubLedger ? timeColumns(range, grain, yearStart) : undefined
    if (columns && columns.length > REPORT_COLUMNS_MAX) {
      throw new ReportsError('TOO_LARGE', `This period has ${columns.length} ${grain === 'month' ? 'months' : grain === 'quarter' ? 'quarters' : 'years'}: choose at most ${REPORT_COLUMNS_MAX} columns, with a shorter period, or quarters or years.`, 'parameters.period')
    }
    const months = timeColumns(range, 'month', yearStart).length
    if (source.maxPeriods !== undefined && months > source.maxPeriods) {
      throw new ReportsError('TOO_LARGE', `Choose at most ${source.maxPeriods} months.`, 'parameters.period')
    }
    if (columns && grain !== 'month' && yearStart.day !== 1) {
      notes.push({ tone: 'info', text: `${grain === 'quarter' ? 'Quarters' : 'Years'} are shown in whole months, from the 1st: totals are kept by month.` })
    }
    subtitle = periodLabel(range, yearStart)
  }
  const shapeColumns = (list?: TimeColumn[]): ShapeColumn[] | undefined => list?.map(c => ({ key: c.key, label: columnLabel(c, yearStart), keys: c.keys }))

  // Sub-ledgers side by side: a scope per column
  let scopes: { scopes: ScopeValue[], labels: string[] } | undefined
  if (bySubLedger && ledger && scope) {
    const made = subLedgerScopes(scope, ledger.view, ledger.placed)
    scopes = made
    if (made.left > 0) notes.push({ tone: 'info', text: `Showing the first ${made.scopes.length - 1} sub-ledgers: ${made.left} more aren’t shown side by side, though the last column includes them.` })
  }

  // The grain: the rows' and columns' dimensions, and those the filters need
  const picks: Filter[] = Object.entries(params.chosen ?? {})
    .filter(([dimension, ids]) => (spec.parameters.choose ?? []).includes(dimension) && ids.length > 0)
    .map(([dimension, ids]) => ({ dimension, in: [...ids] }))
  const dimensions = [...new Set([
    ...(query.rows ? [query.rows.dimension] : []),
    ...(query.columns && !(bySubLedger && timeAcross) ? [query.columns.dimension] : []),
    ...(query.filters ?? []).map(f => f.dimension),
    ...picks.map(f => f.dimension)
  ])]
  // The measures shown, and those a per cent is of
  const measures = [...new Set(query.measures.flatMap(m => m.show === 'percentOf' && m.of !== undefined ? [m.measure, m.of] : [m.measure]))]
  const base: Omit<SourceQuery, 'period'> = {
    sourceId: source.id, dimensions, measures, filters: [...query.filters ?? [], ...picks],
    ...(scoped && scope && { scope }), ...(scopes && { scopes: scopes.scopes }), ...(currency !== undefined && { currency }),
    parameters: { ...params.source }
  }
  // Compared with an earlier period, or another date
  let compared: RunPlan['compared']
  if ((compare === 'previousPeriod' || compare === 'previousYear') && 'from' in period) {
    const earlier = comparedPeriod(period, compare)
    const earlierColumns = timeAcross ? timeColumns(earlier, grain, yearStart) : undefined
    compared = { period: earlier, ...(earlierColumns && { columns: shapeColumns(earlierColumns)! }), label: periodLabel(earlier, yearStart) }
  } else if (typeof compare === 'object' && 'asOf' in compare) {
    const dates = resolveAsOf(compare.asOf, grain, today, yearStart, bounds)
    compared = { period: { dates }, ...(timeAcross && { columns: shapeColumns(dateColumns(dates))! }), label: dates.length === 1 ? dayLabel(dates[0]) : datesLabel(dates, grain) }
  }
  return {
    base, period, ...(columns && { columns: shapeColumns(columns)! }), subtitle, ...(scopes && { scopes }), ...(compared && { compared }), picks,
    ...(scope && { scope }), ...(currency !== undefined && { currency }), ...(ledger && { ledger }), notes
  }

  async function outside<T>(work: () => Promise<T>): Promise<T> {
    try { return await work() } catch (err) { throw translate(err) }
  }
}

export async function runReport(deps: RunDeps, request: RunRequest): Promise<ReportResult> {
  const { spec, source, service, title } = request
  const plan = await planRun(deps, request)
  const { base, period, scopes, scope, currency, ledger, notes, picks } = plan
  const scoped = source.scopes !== 'none'
  const query = spec.query
  const bySubLedger = (request.parameters.compare ?? 'none') === 'subLedgers'
  const dimensions = base.dimensions
  const measures = base.measures
  const columnsField = query.columns ? source.fields.find((f): f is DimensionField => f.kind === 'dimension' && f.key === query.columns!.dimension) : undefined
  const timeAcross = columnsField?.type === 'time'
  const ask = async (q: SourceQuery): Promise<SourceResult> => {
    let reply: unknown
    try {
      reply = await within(deps.timeoutMs ?? SOURCE_TIMEOUT_MS, source.label, service.query(structuredClone(q)))
    } catch (err) {
      const known = translate(err)
      if (known !== err || (err as { name?: string })?.name === 'ReportsError') throw known
      deps.log.error(`[reports] Source "${source.id}" failed`, err)
      throw new ReportsError('SOURCE_FAILED', `The figures from “${source.label}” couldn’t be worked out: ${err instanceof Error ? err.message : String(err)}`)
    }
    return checkReply(reply, q, source)
  }
  const main = await ask({ ...base, period })

  // Compared with an earlier period, or another date
  const compared = plan.compared && { result: await ask({ ...base, period: plan.compared.period }), ...(plan.compared.columns && { columns: plan.compared.columns }), label: plan.compared.label }

  // Balance rows: the balances at the edges of each column
  let balances: { result: SourceResult, dimensions: string[], measures: string[] } | undefined
  if (spec.presentation.table.balanceRows) {
    const balanceMeasures = ['openingBalance', 'closingBalance', 'opened'].filter(m => source.fields.some(f => f.kind === 'measure' && f.key === m))
    const balanceDims = timeAcross && !bySubLedger ? [query.columns!.dimension] : []
    const q: SourceQuery = { ...base, period, dimensions: balanceDims, measures: balanceMeasures, filters: [] }
    balances = { result: await ask(q), dimensions: balanceDims, measures: balanceMeasures }
  }

  const shaped = shape({
    spec, source, result: main, dimensions, measures, filters: picks,
    ...(plan.columns && { columns: plan.columns }),
    ...(scopes && { scopes: scopes.labels }),
    ...(compared && { compared }),
    ...(balances && { balances })
  })
  for (const note of shaped.notes) if (!notes.some(n => n.text === note.text)) notes.push(note)

  // A source with a currency of its own (a budget's) says it, or its rows do
  const rowCurrencies = new Set(main.rows.map(r => r.currency))
  const ownCurrency = source.currency !== false ? undefined
    : typeof main.currency === 'string' ? main.currency : rowCurrencies.size === 1 ? [...rowCurrencies][0] : undefined
  const parts = [plan.subtitle]
  if (main.subject) parts.push(main.subject)
  if (scoped && ledger && scope) parts.push(scopeLabel(scope, ledger.view, ledger.placed) + (bySubLedger ? ', by sub-ledger' : ''))
  if (source.currency !== false) parts.push(currency ?? 'All currencies')
  else if (ownCurrency) parts.push(ownCurrency)
  return {
    title, subtitle: parts.join(' · '), currency: source.currency === false ? ownCurrency ?? null : currency ?? null, period,
    ...(plan.compared && { compared: plan.compared.period }),
    columns: shaped.columns, rows: shaped.rows, ...(shaped.chart && { chart: shaped.chart }), notes, at: deps.now()
  }
}
