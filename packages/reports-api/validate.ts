// Checking what plugins contribute and users save: sources, groups, definitions, specs, options and parameters, each
// problem named by its path (`query.rows.dimension`), so a contribution is refused with a reason and a designer can
// show it on the part at fault. And applying options: JSON merge patches on the spec. Pure.
// See docs/reporting-design.md, "Report definitions".
import { ACCOUNT_TYPES, isCurrencyCode } from '@tessera/accounts-api'
import { isDate } from './periods'
import { REPORT_SERIES_MAX, REPORT_SLICES_MAX, REPORT_SPEC_VERSION, TOP_MAX } from './protocol'
import { TOP_OPTION, TOP_ROWS_MAX } from './settings'
import { ReportsError } from './errors'
import type { DimensionField, MeasureField, ReportField, ReportSourceContribution, ScopeKind, ScopeValue, SourceTime } from './source'
import type {
  AsOfValue, Axis, CompareOption, OptionValues, PeriodValue, ReportDefinitionContribution, ReportOption, ReportSpec, SpecPatch
} from './spec'

export interface SpecProblem {
  path: string
  message: string
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const text = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''
const OPTION_KEY = /^[A-Za-z][A-Za-z0-9_]*$/
const PRESETS = ['thisMonth', 'lastMonth', 'thisQuarter', 'lastQuarter', 'thisYear', 'lastYear', 'yearToDate', 'last3Months', 'last12Months', 'allDates']
const SCOPE_KINDS: ScopeKind[] = ['ledger', 'subLedger', 'types', 'accounts']
const TIMES: SourceTime[] = ['range', 'months', 'asOf']
const COMPARE_OPTIONS: CompareOption[] = ['previousPeriod', 'previousYear', 'subLedgers', 'asOf']
const SHOWS = ['value', 'share', 'compared', 'change', 'changePercent', 'average', 'cumulative', 'percentOf']
const CHART_KINDS = ['bar', 'stackedBar', 'groupedBar', 'line', 'area', 'donut']

// ---- Merge patches and options

/** RFC 7396: objects merge, arrays and other values replace, null removes. Returns a new value; neither input changes. */
export function mergePatch<T>(target: T, patch: unknown): T {
  if (!isObj(patch)) return structuredClone(patch) as T
  const out: Obj = isObj(target) ? structuredClone(target) : {}
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete out[key]
    else out[key] = mergePatch(out[key], value)
  }
  return out as T
}

/** Whether a value of *Show the top* (`TOP_OPTION`) is one: a whole number from 1 to `TOP_ROWS_MAX` as text, or 'all'. */
export function isTopValue(value: unknown): value is string {
  return value === 'all' || (typeof value === 'string' && /^[1-9][0-9]*$/.test(value) && Number(value) <= TOP_ROWS_MAX)
}

/**
 * Each option's value: the one given when the option offers it, else its default; and *Show the top* when given and
 * sound. `dropped` lists the keys given that the options no longer take (a saved report's, after its definition moved
 * on).
 */
export function optionValues(options: readonly ReportOption[] = [], given: OptionValues = {}): { values: OptionValues, dropped: string[] } {
  const values: OptionValues = {}
  const dropped: string[] = []
  for (const option of options) {
    const value = given[option.key]
    const fits = option.kind === 'boolean' ? typeof value === 'boolean' : option.choices?.some(c => c.value === value) === true
    if (value !== undefined && !fits) dropped.push(option.key)
    values[option.key] = fits ? value! : option.default
  }
  if (given[TOP_OPTION] !== undefined) {
    if (isTopValue(given[TOP_OPTION])) values[TOP_OPTION] = given[TOP_OPTION]
    else dropped.push(TOP_OPTION)
  }
  for (const key of Object.keys(given)) if (key !== TOP_OPTION && !options.some(o => o.key === key)) dropped.push(key)
  return { values, dropped }
}

/**
 * The row axis's top, settled (R4): the user's *Show the top* for this report when given ('all': no top), else, for
 * `top: 'user'`, the Reports page's *Rows before "Other"*. A report whose rows keep no top is left as it is.
 */
export function applyTop(spec: ReportSpec, values: OptionValues, userTop: number): ReportSpec {
  const rows = spec.query.rows
  if (!rows || rows.top === undefined) return spec
  const chosen = values[TOP_OPTION]
  const top = chosen === 'all' ? undefined : isTopValue(chosen) ? Number(chosen) : rows.top === 'user' ? userTop : rows.top
  const { top: _old, ...rest } = rows
  return { ...spec, query: { ...spec.query, rows: top === undefined ? rest : { ...rest, top } } }
}

/** The spec with each option's value applied, in the options' order: a choice's patch, or a boolean's when true. */
export function applyOptions(spec: ReportSpec, options: readonly ReportOption[] = [], given: OptionValues = {}): ReportSpec {
  const { values } = optionValues(options, given)
  let out = structuredClone(spec)
  for (const option of options) {
    const value = values[option.key]
    const patch: SpecPatch | undefined = option.kind === 'boolean'
      ? (value === true ? option.patch : undefined)
      : option.choices?.find(c => c.value === value)?.patch
    if (!patch) continue
    if (patch.query !== undefined) out = { ...out, query: mergePatch(out.query, patch.query) }
    if (patch.presentation !== undefined) out = { ...out, presentation: mergePatch(out.presentation, patch.presentation) }
  }
  return out
}

/** A spec brought up to date from any earlier `specVersion`. Throws INVALID for one that isn't a spec, or is newer. */
export function migrateSpec(spec: unknown): ReportSpec {
  if (!isObj(spec) || !Number.isInteger(spec.specVersion)) throw new ReportsError('INVALID', 'This isn’t a report.', 'specVersion')
  if ((spec.specVersion as number) > REPORT_SPEC_VERSION) {
    throw new ReportsError('INVALID', 'This report was made by a newer version of Tessera.', 'specVersion')
  }
  if ((spec.specVersion as number) < 1) throw new ReportsError('INVALID', 'This isn’t a report.', 'specVersion')
  // Version 1 is the first: nothing to bring up to date yet
  return structuredClone(spec) as unknown as ReportSpec
}

// ---- Values the heading takes

export function isPeriodValue(v: unknown): v is PeriodValue {
  if (!isObj(v)) return false
  if ('preset' in v) return PRESETS.includes(v.preset as string)
  return isDate(v.from) && isDate(v.to) && (v.from as string) <= (v.to as string)
}

export function isAsOfValue(v: unknown): v is AsOfValue {
  if (!isObj(v)) return false
  if ('at' in v) return ['today', 'endOfLastMonth', 'endOfLastYear'].includes(v.at as string)
  if ('date' in v) return isDate(v.date)
  if ('ends' in v) return isPeriodValue(v.ends)
  return false
}

/** A scope, shaped right. `withIds`: sub-ledger and account ids are allowed (parameters), or not (a definition). */
export function scopeProblem(v: unknown, allowed: readonly ScopeKind[], withIds: boolean): string | undefined {
  if (!isObj(v) || !SCOPE_KINDS.includes(v.kind as ScopeKind)) return 'Choose which accounts the report covers.'
  if (!allowed.includes(v.kind as ScopeKind)) return `This report can’t cover accounts chosen that way (“${v.kind}”).`
  switch (v.kind) {
    case 'subLedger':
      if (!withIds) return 'A definition can’t name a sub-ledger: sub-ledgers belong to a ledger.'
      return text(v.subLedgerId) ? undefined : 'Choose the sub-ledger.'
    case 'accounts':
      if (!withIds) return 'A definition can’t name accounts: accounts belong to a ledger.'
      return Array.isArray(v.accountIds) && v.accountIds.every(text) ? undefined : 'Choose the accounts.'
    case 'types':
      if (!Array.isArray(v.types) || v.types.length === 0 || !v.types.every(t => (ACCOUNT_TYPES as readonly unknown[]).includes(t))) return 'Choose account types.'
      if (v.subLedgerId !== undefined && !withIds) return 'A definition can’t name a sub-ledger: sub-ledgers belong to a ledger.'
      return v.subLedgerId === undefined || text(v.subLedgerId) ? undefined : 'Choose the sub-ledger.'
  }
  return undefined
}

const scopeKinds = (source: ReportSourceContribution): ScopeKind[] =>
  source.scopes === 'none' ? [] : source.scopes ?? SCOPE_KINDS

const isRange = (source: ReportSourceContribution) => source.time === 'range' || source.time === 'months'
const hasCurrencyDimension = (source: ReportSourceContribution) => source.fields.some(f => f.kind === 'dimension' && f.key === 'currency')

/** Which *Compare with* values a source can take. */
function compareFits(option: CompareOption, source: ReportSourceContribution): boolean {
  switch (option) {
    case 'previousPeriod': case 'previousYear': return isRange(source)
    case 'subLedgers': return source.time === 'range' && scopeKinds(source).includes('subLedger')
    case 'asOf': return source.time === 'asOf'
  }
}

/**
 * The parameters' problems, against the source (and the spec whose heading they fill). `withIds`: a saved report's or
 * a run's, which may name sub-ledgers, accounts and members; or a definition's, which may not.
 */
export function parameterProblems(params: unknown, source: ReportSourceContribution, withIds: boolean, path = 'parameters'): SpecProblem[] {
  const problems: SpecProblem[] = []
  const add = (at: string, message: string) => problems.push({ path: `${path}.${at}`, message })
  if (!isObj(params)) return [{ path, message: 'The report’s parameters are missing.' }]
  const p = params as Obj
  if (p.period !== undefined) {
    if (!isRange(source)) add('period', 'This report is for dates (“as of”), not a period.')
    else if (!isPeriodValue(p.period)) add('period', 'Choose a period: a preset, or a first and last date with the first not after the last.')
  }
  if (p.asOf !== undefined) {
    if (source.time !== 'asOf') add('asOf', 'This report is for a period, not dates.')
    else if (!isAsOfValue(p.asOf)) add('asOf', 'Choose a date.')
  }
  if (p.scope !== undefined) {
    if (source.scopes === 'none') add('scope', 'This report has its own accounts.')
    else {
      const problem = scopeProblem(p.scope, scopeKinds(source), withIds)
      if (problem) add('scope', problem)
    }
  }
  if (p.currency !== undefined) {
    if (source.currency === false) add('currency', 'This report has its own currency.')
    else if (p.currency === 'all') { if (!hasCurrencyDimension(source)) add('currency', 'This report shows one currency at a time.') }
    else if (p.currency !== 'mostUsed' && !isCurrencyCode(p.currency)) add('currency', 'Choose a currency, like CAD.')
  }
  if (p.compare !== undefined && p.compare !== 'none') {
    const option: CompareOption | undefined = isObj(p.compare) ? ('asOf' in p.compare ? 'asOf' : undefined)
      : COMPARE_OPTIONS.includes(p.compare as CompareOption) && p.compare !== 'asOf' ? p.compare as CompareOption : undefined
    if (option === undefined) add('compare', 'Choose what to compare with.')
    else if (!compareFits(option, source)) add('compare', 'This report can’t be compared that way.')
    else if (option === 'asOf' && !isAsOfValue((p.compare as { asOf: unknown }).asOf)) add('compare', 'Choose the date to compare with.')
  }
  if (p.source !== undefined) {
    if (!isObj(p.source)) add('source', 'The report’s own choices are malformed.')
    else for (const [key, value] of Object.entries(p.source)) {
      if (!source.parameters?.some(sp => sp.key === key)) add(`source.${key}`, `This report has no choice “${key}”.`)
      else if (typeof value !== 'string') add(`source.${key}`, 'Choose one.')
    }
  }
  if (p.chosen !== undefined) {
    if (!withIds) add('chosen', 'A definition can’t pick members: they belong to a ledger.')
    else if (!isObj(p.chosen)) add('chosen', 'The members picked are malformed.')
    else for (const [dimension, ids] of Object.entries(p.chosen)) {
      const field = source.fields.find(f => f.kind === 'dimension' && f.key === dimension) as DimensionField | undefined
      if (!field || field.type === 'time') add(`chosen.${dimension}`, `“${dimension}” isn’t something to pick from.`)
      else if (!Array.isArray(ids) || !ids.every(text)) add(`chosen.${dimension}`, 'The members picked are malformed.')
    }
  }
  return problems
}

// ---- Specs

const dimensionOf = (source: ReportSourceContribution, key: unknown) =>
  source.fields.find((f): f is DimensionField => f.kind === 'dimension' && f.key === key)
const measureOf = (source: ReportSourceContribution, key: unknown) =>
  source.fields.find((f): f is MeasureField => f.kind === 'measure' && f.key === key)

function axisProblems(axis: unknown, source: ReportSourceContribution, at: 'rows' | 'columns'): SpecProblem[] {
  const path = `query.${at}`
  if (!isObj(axis)) return [{ path, message: 'An axis needs a dimension.' }]
  const a = axis as Partial<Axis> & Obj
  const problems: SpecProblem[] = []
  const add = (key: string, message: string) => problems.push({ path: `${path}.${key}`, message })
  const field = dimensionOf(source, a.dimension)
  if (!field) return [{ path: `${path}.dimension`, message: `“${String(a.dimension)}” is not a dimension of source “${source.id}”.` }]
  if (field.type === 'time' && at === 'rows') add('dimension', 'Time goes across the columns.')
  if (a.depth !== undefined) {
    if (!field.tree) add('depth', `“${field.key}” isn’t a tree, so it has no depth.`)
    else if (a.depth !== 'all' && !(Number.isInteger(a.depth) && (a.depth as number) >= 1)) add('depth', 'A depth is 1 or more, or “all”.')
  }
  if (a.grain !== undefined) {
    if (field.type !== 'time') add('grain', `“${field.key}” isn’t time, so it has no grain.`)
    else if (!['month', 'quarter', 'year'].includes(a.grain as string)) add('grain', 'A grain is month, quarter or year.')
  }
  if (a.sort !== undefined && !['natural', 'label', 'valueDesc', 'valueAsc'].includes(a.sort)) add('sort', 'Sort naturally, by label, or by value.')
  if (a.top !== undefined) {
    if (at === 'columns') add('top', 'Only rows keep a top.')
    else if (a.top !== 'user' && (!Number.isInteger(a.top) || (a.top as number) < 1 || (a.top as number) > TOP_MAX)) add('top', `Keep from 1 to ${TOP_MAX} rows, or as many as the user chooses (“user”).`)
  }
  if (a.empty !== undefined && a.empty !== 'hide' && a.empty !== 'show') add('empty', 'Hide or show members with nothing.')
  if (a.subtotals !== undefined) {
    if (!field.tree) add('subtotals', `“${field.key}” isn’t a tree, so it has no subtotals.`)
    else if (a.subtotals !== 'above' && a.subtotals !== 'below') add('subtotals', 'Subtotals go above or below.')
  }
  return problems
}

/**
 * Everything wrong with a spec, against its source: each problem with its path. Empty when the spec is fine.
 * `withIds`: a saved or designed spec may name ledger ids in its parameters and filters; a definition may not.
 */
export function specProblems(spec: unknown, source: ReportSourceContribution, withIds = true): SpecProblem[] {
  if (!isObj(spec)) return [{ path: '', message: 'A report needs a spec.' }]
  const s = spec as Obj
  const problems: SpecProblem[] = []
  const add = (path: string, message: string) => problems.push({ path, message })
  if (!Number.isInteger(s.specVersion) || (s.specVersion as number) < 1 || (s.specVersion as number) > REPORT_SPEC_VERSION) {
    add('specVersion', `The spec version must be 1 to ${REPORT_SPEC_VERSION}.`)
  }
  if (s.source !== source.id) add('source', `The spec is for source “${String(s.source)}”, not “${source.id}”.`)

  // The parameters' defaults
  const params = s.parameters
  problems.push(...parameterProblems(params, source, withIds))
  if (isObj(params)) {
    if (isRange(source) && params.period === undefined) add('parameters.period', 'A report over a period needs a default period.')
    if (source.time === 'asOf' && params.asOf === undefined) add('parameters.asOf', 'A report of balances needs a default date.')
    if (params.compareOptions !== undefined) {
      const options = params.compareOptions
      if (!Array.isArray(options) || options.some(o => !COMPARE_OPTIONS.includes(o)) || new Set(options).size !== options.length) {
        add('parameters.compareOptions', 'Compare with: previous period, previous year, sub-ledgers or a date, each once.')
      } else for (const option of options as CompareOption[]) {
        if (!compareFits(option, source)) add('parameters.compareOptions', `This report can’t be compared with “${option}”.`)
      }
    }
    const compare = params.compare
    if (compare !== undefined && compare !== 'none' && !problems.some(p => p.path === 'parameters.compare')) {
      const option = isObj(compare) ? 'asOf' : compare as CompareOption
      if (!Array.isArray(params.compareOptions) || !params.compareOptions.includes(option)) add('parameters.compare', 'Compare with must be one of the report’s compare options.')
    }
    if (params.choose !== undefined) {
      if (!Array.isArray(params.choose)) add('parameters.choose', 'List the dimensions to pick from.')
      else for (const key of params.choose) {
        const field = dimensionOf(source, key)
        if (!field || field.type === 'time') add('parameters.choose', `“${String(key)}” isn’t something to pick from.`)
      }
    }
  }

  // The query
  const query = s.query
  if (!isObj(query)) { add('query', 'A report needs a query.'); return problems }
  const rows = query.rows === undefined ? undefined : query.rows as Axis
  const columns = query.columns === undefined ? undefined : query.columns as Axis
  if (query.rows !== undefined) problems.push(...axisProblems(query.rows, source, 'rows'))
  if (query.columns !== undefined) problems.push(...axisProblems(query.columns, source, 'columns'))
  if (rows && columns && rows.dimension === columns.dimension) add('query.columns.dimension', 'Rows and columns need different dimensions.')
  const columnField = columns ? dimensionOf(source, columns.dimension) : undefined
  const filterDims: string[] = []
  if (query.filters !== undefined) {
    if (!Array.isArray(query.filters)) add('query.filters', 'Filters are a list.')
    else query.filters.forEach((f, i) => {
      const path = `query.filters[${i}]`
      if (!isObj(f)) { add(path, 'A filter needs a dimension.'); return }
      const field = dimensionOf(source, f.dimension)
      if (!field || field.type === 'time') { add(`${path}.dimension`, `“${String(f.dimension)}” isn’t a dimension to filter on.`); return }
      if (!withIds && field.type === 'member') add(`${path}.dimension`, `A definition filters only on fixed values: “${field.key}”’s members belong to a ledger.`)
      const list = 'in' in f ? f.in : f.notIn
      if (('in' in f) === ('notIn' in f) || !Array.isArray(list) || !list.every(v => typeof v === 'string')) add(path, 'A filter has a list, “in” or “notIn”.')
      else if (field.type === 'enum' && field.values && list.some(v => !field.values!.some(x => x.id === v))) add(path, `“${field.key}” has no such value.`)
      filterDims.push(field.key)
    })
  }
  const measures = query.measures
  const uses = Array.isArray(measures) ? measures : []
  if (!Array.isArray(measures) || measures.length === 0) add('query.measures', 'A report needs at least one figure.')
  else measures.forEach((m, i) => {
    const path = `query.measures[${i}]`
    if (!isObj(m)) { add(path, 'A figure needs a measure.'); return }
    const field = measureOf(source, m.measure)
    if (!field) { add(`${path}.measure`, `“${String(m.measure)}” is not a measure of source “${source.id}”.`); return }
    if (m.label !== undefined && !text(m.label)) add(`${path}.label`, 'A label is text.')
    const show = m.show ?? 'value'
    if (!SHOWS.includes(show as string)) add(`${path}.show`, 'Show a value, share, compared, change, change in per cent, average, running total or per cent of another figure.')
    if (show === 'percentOf') {
      const of = measureOf(source, m.of)
      if (!of) add(`${path}.of`, 'A per cent is of another of the source’s measures.')
      else if (of.unit === 'percent' || field.unit === 'percent') add(`${path}.of`, 'A per cent is of amounts or counts.')
      else if (of.key === field.key) add(`${path}.of`, 'A per cent is of another measure.')
    } else if (m.of !== undefined) add(`${path}.of`, 'Only a per cent of another figure names one.')
    if ((show === 'average' || show === 'cumulative') && columnField?.type !== 'time') add(`${path}.show`, 'Averages and running totals are across time columns.')
    if (show === 'share' && field.unit === 'percent') add(`${path}.show`, 'A share of a percentage means nothing.')
    if (field.dimensions) {
      for (const dim of [rows?.dimension, columns?.dimension, ...filterDims]) {
        if (dim !== undefined && !field.dimensions.includes(dim)) add(`${path}.measure`, `“${field.key}” can’t be broken down by “${dim}”.`)
      }
    }
  })
  if (source.time === 'asOf' && isObj(params) && isObj(params.asOf) && 'ends' in params.asOf && columnField?.type !== 'time') {
    add('query.columns', 'Balances at several dates need the dates across the columns.')
  }

  // The presentation
  const pres = s.presentation
  if (!isObj(pres)) { add('presentation', 'A report needs a presentation.'); return problems }
  if (!['chart', 'table', 'both'].includes(pres.show as string)) add('presentation.show', 'Open on the chart, the table, or both.')
  const table = pres.table
  if (!isObj(table)) add('presentation.table', 'A report needs a table.')
  else {
    if (table.totals !== undefined) {
      const t = table.totals
      if (!isObj(t) || (t.row !== undefined && typeof t.row !== 'boolean') || (t.column !== undefined && typeof t.column !== 'boolean') || (t.label !== undefined && !text(t.label))) {
        add('presentation.table.totals', 'Totals are a row and a column, each on or off, and a label.')
      } else if (t.column === true && columnField === undefined) add('presentation.table.totals.column', 'A total column needs columns.')
    }
    if (table.nets !== undefined) {
      const rowField = rows ? dimensionOf(source, rows.dimension) : undefined
      if (!Array.isArray(table.nets)) add('presentation.table.nets', 'Net rows are a list.')
      else if (!rowField?.signed) add('presentation.table.nets', 'Net rows need a signed dimension on the rows.')
      else table.nets.forEach((n, i) => {
        const path = `presentation.table.nets[${i}]`
        if (!isObj(n) || !text(n.label)) { add(path, 'A net row needs a label.'); return }
        const known = (id: unknown) => typeof id === 'string' && (!rowField.values || rowField.values.some(v => v.id === id))
        if (n.of !== undefined && (!Array.isArray(n.of) || !n.of.every(known))) add(`${path}.of`, `A net row adds “${rowField.key}”’s top members.`)
        if (n.after !== undefined && !known(n.after)) add(`${path}.after`, `A net row goes after one of “${rowField.key}”’s top members.`)
        // A measure the report doesn't show (in one of its layouts) has nothing to read the other way
        if (n.negate !== undefined && (!Array.isArray(n.negate) || !n.negate.every(k => measureOf(source, k) !== undefined))) {
          add(`${path}.negate`, 'A net row reads the other way only the source’s measures.')
        }
      })
    }
    if (table.balanceRows !== undefined) {
      if (typeof table.balanceRows !== 'boolean') add('presentation.table.balanceRows', 'Balance rows are on or off.')
      else if (table.balanceRows && (!measureOf(source, 'openingBalance') || !measureOf(source, 'closingBalance'))) {
        add('presentation.table.balanceRows', `Source “${source.id}” has no opening and closing balances.`)
      } else if (table.balanceRows && columnField !== undefined && columnField.type !== 'time') {
        add('presentation.table.balanceRows', 'Balance rows need time across the columns, or no columns.')
      }
    }
  }
  const chart = pres.chart
  if (chart !== undefined) {
    if (!isObj(chart) || !CHART_KINDS.includes(chart.kind as string)) add('presentation.chart.kind', 'A chart is bars, stacked or grouped bars, a line, an area or a donut.')
    else {
      if (!Number.isInteger(chart.measure) || (chart.measure as number) < 0 || (chart.measure as number) >= uses.length) add('presentation.chart.measure', 'The chart draws one of the report’s figures.')
      else {
        const use = uses[chart.measure as number] as Obj
        const field = measureOf(source, use?.measure)
        if (field?.unit === 'percent' || ['share', 'changePercent'].includes(use?.show as string)) add('presentation.chart.measure', 'A chart draws amounts or counts, not percentages.')
      }
      if (chart.kind === 'donut') {
        if (chart.slices !== undefined && (!Number.isInteger(chart.slices) || (chart.slices as number) < 2 || (chart.slices as number) > REPORT_SLICES_MAX)) {
          add('presentation.chart.slices', `A donut has 2 to ${REPORT_SLICES_MAX} slices.`)
        }
      } else {
        if (chart.series !== undefined && chart.series !== 'rows' && chart.series !== 'measures') add('presentation.chart.series', 'Series are the rows or the measures.')
        if (chart.measures !== undefined) {
          const list = chart.measures
          if (chart.series !== 'measures') add('presentation.chart.measures', 'Figures side by side are for series of the measures.')
          else if (!Array.isArray(list) || list.length < 1 || list.length > REPORT_SERIES_MAX || !list.every(i => Number.isInteger(i) && i >= 0 && i < uses.length)) {
            add('presentation.chart.measures', 'The chart draws some of the report’s figures.')
          }
        }
        if (chart.under !== undefined) {
          const rowField = rows ? dimensionOf(source, rows.dimension) : undefined
          if (columns !== undefined) add('presentation.chart.under', 'Bars under a row are for a report with no columns.')
          else if (!rowField?.tree || !rowField.values?.some(v => v.id === chart.under)) add('presentation.chart.under', 'Bars are under one of the rows’ top members.')
        }
        if (chart.horizontal !== undefined && typeof chart.horizontal !== 'boolean') add('presentation.chart.horizontal', 'Horizontal is on or off.')
        if (chart.limit !== undefined && (!Number.isInteger(chart.limit) || (chart.limit as number) < 1 || (chart.limit as number) > REPORT_SERIES_MAX)) {
          add('presentation.chart.limit', `A chart draws 1 to ${REPORT_SERIES_MAX} series.`)
        }
        if (chart.line !== undefined) {
          const row = isObj(chart.line) ? chart.line.row : undefined
          if (row !== 'net' && row !== 'total') add('presentation.chart.line', 'The line is the net row or the total row.')
          else if (row === 'net' && !(isObj(table) && Array.isArray(table.nets) && table.nets.length > 0)) add('presentation.chart.line', 'A net line needs a net row.')
          else if (row === 'total' && !(isObj(table) && isObj(table.totals) && table.totals.row === true)) add('presentation.chart.line', 'A total line needs a total row.')
        }
      }
    }
  }
  return problems
}

// ---- Contributions

const fieldProblem = (f: unknown, sourceId: string, dims: Set<string>): string | undefined => {
  if (!isObj(f) || (f.kind !== 'dimension' && f.kind !== 'measure')) return `A field of source "${sourceId}" is neither a dimension nor a measure`
  if (!text(f.key) || !OPTION_KEY.test(f.key)) return `A field of source "${sourceId}" needs a key of letters and digits`
  if (!text(f.label)) return `Field "${f.key}" of source "${sourceId}" needs a label`
  if (f.kind === 'dimension') {
    if (!['time', 'member', 'enum'].includes(f.type as string)) return `Dimension "${f.key}" of source "${sourceId}" has an unknown type`
    if (f.values !== undefined && (!Array.isArray(f.values) || !f.values.every(v => isObj(v) && text(v.id) && text(v.label) && (v.sign === undefined || v.sign === 1 || v.sign === -1)
      && (v.negativeIsBad === undefined || typeof v.negativeIsBad === 'boolean')))) {
      return `Dimension "${f.key}" of source "${sourceId}" has invalid values`
    }
    if (f.type === 'enum' && !Array.isArray(f.values)) return `Enum dimension "${f.key}" of source "${sourceId}" needs its values`
    return undefined
  }
  if (!['money', 'count', 'percent'].includes(f.unit as string)) return `Measure "${f.key}" of source "${sourceId}" needs a unit: money, count or percent`
  if (!['sum', 'last', 'none'].includes(f.combine as string)) return `Measure "${f.key}" of source "${sourceId}" needs combine: sum, last or none`
  if (f.drillDown !== undefined && typeof f.drillDown !== 'boolean') return `Measure "${f.key}" of source "${sourceId}" has an invalid drillDown`
  if (f.dimensions !== undefined && (!Array.isArray(f.dimensions) || !f.dimensions.every(d => dims.has(d as string)))) {
    return `Measure "${f.key}" of source "${sourceId}" names a dimension it doesn't have`
  }
  return undefined
}

/** Why a source contribution can't be used, or undefined when it can. */
export function sourceProblem(raw: unknown, contributor: string): string | undefined {
  if (!isObj(raw)) return `A report source contributed by "${contributor}" is not an object`
  if (!text(raw.id) || !raw.id.startsWith(`${contributor}.`)) return `A report source contributed by "${contributor}" needs an id starting with "${contributor}."`
  if (!text(raw.label)) return `Report source "${raw.id}" needs a label`
  if (!text(raw.service)) return `Report source "${raw.id}" needs a service`
  if (!TIMES.includes(raw.time as SourceTime)) return `Report source "${raw.id}" needs time: range, months or asOf`
  if (raw.maxPeriods !== undefined && !(Number.isInteger(raw.maxPeriods) && (raw.maxPeriods as number) >= 1)) return `Report source "${raw.id}" has an invalid maxPeriods`
  if (raw.scopes !== undefined && raw.scopes !== 'none' && (!Array.isArray(raw.scopes) || !raw.scopes.every(k => SCOPE_KINDS.includes(k)))) {
    return `Report source "${raw.id}" has invalid scopes`
  }
  if (raw.currency !== undefined && typeof raw.currency !== 'boolean') return `Report source "${raw.id}" has an invalid currency`
  if (raw.drillDown !== undefined && typeof raw.drillDown !== 'boolean') return `Report source "${raw.id}" has an invalid drillDown`
  if (raw.parameters !== undefined && (!Array.isArray(raw.parameters) || !raw.parameters.every(p => isObj(p) && text(p.key) && text(p.label) && (p.kind === 'member' || p.kind === 'choice')))) {
    return `Report source "${raw.id}" has invalid parameters`
  }
  if (!Array.isArray(raw.fields) || raw.fields.length === 0) return `Report source "${raw.id}" needs fields`
  const fields = raw.fields as ReportField[]
  const keys = fields.map(f => isObj(f) ? f.key : undefined)
  if (new Set(keys).size !== keys.length) return `Report source "${raw.id}" has two fields with the same key`
  const dims = new Set(fields.filter(f => isObj(f) && f.kind === 'dimension').map(f => f.key))
  for (const field of fields) {
    const problem = fieldProblem(field, raw.id as string, dims)
    if (problem) return problem
  }
  if (fields.filter(f => f.kind === 'dimension' && f.type === 'time').length > 1) return `Report source "${raw.id}" has more than one time dimension`
  if (!fields.some(f => f.kind === 'measure')) return `Report source "${raw.id}" needs a measure`
  return undefined
}

/** Why a group contribution can't be used, or undefined when it can. */
export function groupProblem(raw: unknown, contributor: string): string | undefined {
  if (!isObj(raw)) return `A report group contributed by "${contributor}" is not an object`
  if (!text(raw.id) || !raw.id.startsWith(`${contributor}.`)) return `A report group contributed by "${contributor}" needs an id starting with "${contributor}."`
  if (!text(raw.label)) return `Report group "${raw.id}" needs a label`
  if (raw.order !== undefined && (typeof raw.order !== 'number' || !Number.isFinite(raw.order))) return `Report group "${raw.id}" has an invalid order`
  return undefined
}

function optionProblems(options: unknown): SpecProblem[] {
  if (options === undefined) return []
  if (!Array.isArray(options)) return [{ path: 'options', message: 'Options are a list.' }]
  const problems: SpecProblem[] = []
  const keys = new Set<string>()
  options.forEach((o, i) => {
    const path = `options[${i}]`
    const add = (message: string, at = '') => problems.push({ path: `${path}${at}`, message })
    if (!isObj(o)) { add('An option needs a key, a label and a kind.'); return }
    if (!text(o.key) || !OPTION_KEY.test(o.key)) add('An option needs a key of letters and digits.', '.key')
    else if (keys.has(o.key)) add(`Two options have the key “${o.key}”.`, '.key')
    else keys.add(o.key)
    if (!text(o.label)) add('An option needs a label.', '.label')
    const patchOk = (p: unknown) => isObj(p) && Object.keys(p).every(k => k === 'query' || k === 'presentation')
    if (o.kind === 'boolean') {
      if (typeof o.default !== 'boolean') add('A yes-or-no option’s default is true or false.', '.default')
      if (!patchOk(o.patch)) add('A yes-or-no option needs a patch on the query or the presentation.', '.patch')
    } else if (o.kind === 'choice') {
      const choices = o.choices
      if (!Array.isArray(choices) || choices.length < 2) { add('A choice needs at least two choices.', '.choices'); return }
      choices.forEach((c, j) => {
        if (!isObj(c) || typeof c.value !== 'string' || !text(c.label) || !patchOk(c.patch)) add('A choice needs a value, a label and a patch on the query or the presentation.', `.choices[${j}]`)
      })
      const values = choices.map(c => isObj(c) ? c.value : undefined)
      if (new Set(values).size !== values.length) add('Two choices have the same value.', '.choices')
      if (!values.includes(o.default)) add('The default isn’t one of the choices.', '.default')
    } else add('An option is a choice or yes-or-no.', '.kind')
  })
  return problems
}

/**
 * Everything wrong with a definition, against its source: its own fields, its spec (with no ledger ids), its options,
 * and the spec as each option's every value makes it (the others at their defaults). Empty when it can be offered.
 */
export function definitionProblems(raw: unknown, source: ReportSourceContribution, contributor: string): SpecProblem[] {
  if (!isObj(raw)) return [{ path: '', message: `A report definition contributed by "${contributor}" is not an object` }]
  const d = raw as Obj
  const problems: SpecProblem[] = []
  const add = (path: string, message: string) => problems.push({ path, message })
  if (!text(d.id) || !d.id.startsWith(`${contributor}.`)) add('id', `The id must start with "${contributor}."`)
  if (!text(d.label)) add('label', 'A report needs a label.')
  if (!text(d.description)) add('description', 'A report needs a description.')
  if (!text(d.group)) add('group', 'A report needs a group.')
  if (!Number.isInteger(d.version) || (d.version as number) < 1) add('version', 'The version is a whole number, 1 or more.')
  if (d.order !== undefined && (typeof d.order !== 'number' || !Number.isFinite(d.order))) add('order', 'The order is a number.')
  for (const key of ['icon', 'when', 'emptyText'] as const) if (d[key] !== undefined && !text(d[key])) add(key, `The ${key} is text.`)
  const base = specProblems(d.spec, source, false).map(p => ({ path: p.path ? `spec.${p.path}` : 'spec', message: p.message }))
  problems.push(...base)
  const options = optionProblems(d.options)
  problems.push(...options)
  if (base.length > 0 || options.length > 0 || problems.length > 0) return problems
  // Each option's each value, the others at their defaults: every spec a user can reach must be valid
  const def = raw as unknown as ReportDefinitionContribution
  const list = def.options ?? []
  const defaults = applyOptions(def.spec, list, {})
  problems.push(...specProblems(defaults, source, false).map(p => ({ path: `options(defaults).${p.path}`, message: p.message })))
  list.forEach((option, i) => {
    const values: (string | boolean)[] = option.kind === 'boolean' ? [true, false] : (option.choices ?? []).map(c => c.value)
    for (const value of values) {
      const spec = applyOptions(def.spec, list, { [option.key]: value })
      for (const p of specProblems(spec, source, false)) problems.push({ path: `options[${i}]=${String(value)}.${p.path}`, message: p.message })
    }
  })
  return problems
}
