// Show Transactions: what one figure stands for, and which pieces of the flows source are in it. The request is made
// from the run's own plan (its period, scope, currency and filters) and the figure's row and column, so the list can't
// disagree with the figure about what it covers; the pieces are matched by the same keys the totals were grouped by.
// See docs/reporting-design.md, "The transactions behind a figure".
import type { Category } from '@tessera/accounts-api'
import {
  DRILL_ROWS_MAX, ReportsError, firstDayOf, isMonth, lastDayOf,
  type ColumnDrill, type DrillKey, type DrillRequest, type Filter, type ReportSpec, type RowDrill, type SourceQuery
} from '@tessera/reports-api'
import { keyOf, topKind, type FlowsInput, type Piece } from './flows'
import type { RunPlan } from './run'

const bad = (what: string) => new ReportsError('INVALID', `That figure can’t be listed: ${what}.`)

const keyList = (value: unknown): (string | null)[] | undefined =>
  Array.isArray(value) && value.every(k => k === null || typeof k === 'string') ? value as (string | null)[] : undefined

/**
 * The request for one figure: the run's query over the column's part of the period (or the period compared with), in
 * the column's sub-ledger side by side, for the row's keys and the column's member. Throws INVALID for a row or
 * column that says something no run of this report would.
 */
export function drillRequest(plan: RunPlan, spec: ReportSpec, row: RowDrill, column: ColumnDrill, currency?: string): DrillRequest {
  if (typeof row !== 'object' || row === null || typeof column !== 'object' || column === null) throw bad('no row or column')
  if (typeof column.measure !== 'string' || !plan.base.measures.includes(column.measure)) throw bad('a measure the report doesn’t show')
  // The period: the report's, or the one compared with; narrowed to the column's months
  let period: SourceQuery['period'] = column.compared ? plan.compared?.period ?? plan.period : plan.period
  if (!('from' in period)) throw bad('figures at a date are balances, not transactions')
  if (column.months !== undefined) {
    const months = keyList(column.months)
    if (!months || months.length === 0 || !months.every(isMonth)) throw bad('its months are malformed')
    const sorted = [...months as string[]].sort()
    const from = firstDayOf(sorted[0]), to = lastDayOf(sorted[sorted.length - 1])
    period = { from: from > period.from ? from : period.from, to: to < period.to ? to : period.to }
    if (period.from > period.to) throw bad('its months are outside the period')
  }
  // The scope: a sub-ledger column's own, side by side
  let scope = plan.base.scope
  if (column.scope !== undefined) {
    const found = typeof column.scope === 'number' ? plan.scopes?.scopes[column.scope] : undefined
    if (!found) throw bad('a sub-ledger column the report doesn’t have')
    scope = found
  }
  const keys: DrillKey['keys'] = {}
  const own: string[] = []
  const rows = spec.query.rows?.dimension
  if (row.keys !== undefined) {
    const list = keyList(row.keys)
    if (!list || !rows) throw bad('its row is malformed')
    keys[rows] = list
    if (row.own === true) own.push(rows)
  }
  const signed = row.signed === true && rows !== undefined ? rows : undefined
  if (column.member !== undefined) {
    const columns = spec.query.columns?.dimension
    if (!columns || (column.member !== null && typeof column.member !== 'string')) throw bad('its column is malformed')
    keys[columns] = [column.member]
  }
  const { dimensions: _d, measures: _m, scopes: _s, scope: _scope, currency: _c, ...rest } = plan.base
  const chosenCurrency = currency ?? plan.base.currency
  return {
    ...rest, period, ...(scope && { scope }), ...(chosenCurrency !== undefined && { currency: chosenCurrency }),
    key: { keys, ...(own.length > 0 && { own }), ...(signed && { signed }) }, measure: column.measure, limit: DRILL_ROWS_MAX
  }
}

/**
 * Whether a piece is in a figure: its key in each dimension the figure names is one of the figure's keys (on a tree, or
 * beneath one, unless `own`), and it passes the report's filters (on a tree, beneath a key matches too).
 */
export function pieceMatcher(key: DrillKey, filters: readonly Filter[], input: FlowsInput): (piece: Piece) => boolean {
  const categories = new Map<string, Category>(input.categories.map(c => [c.id, c]))
  const subLedgers = new Map(input.subLedgers.map(s => [s.id, s]))
  /** The key and what it is beneath, in a tree dimension. */
  const lineage = (dimension: string, k: string | null): (string | null)[] => {
    if (k === null) return [null]
    const out: (string | null)[] = [k]
    const categoryChain = (id: string) => {
      for (let c = categories.get(id); c && c.parentId !== null; c = categories.get(c.parentId)) out.push(c.parentId)
    }
    switch (dimension) {
      case 'category': categoryChain(k); break
      case 'flow':
        if (k.startsWith('uncategorised:')) out.push(k.slice('uncategorised:'.length))
        else if (k.startsWith('transferIn:') || k.startsWith('transferOut:')) out.push(k.split(':')[0])
        else if (categories.has(k)) { categoryChain(k); out.push(topKind(k, categories)) }
        break
      case 'subLedger': case 'otherSubLedger':
        for (let s = subLedgers.get(k); s && s.parentId !== null; s = subLedgers.get(s.parentId)) out.push(s.parentId)
        break
    }
    return out
  }
  const tests: ((piece: Piece) => boolean)[] = []
  for (const [dimension, wanted] of Object.entries(key.keys)) {
    const set = new Set(wanted)
    const exact = key.own?.includes(dimension) === true
    tests.push(piece => {
      const k = keyOf(dimension, piece, input, categories)
      return exact ? set.has(k) : lineage(dimension, k).some(x => set.has(x))
    })
  }
  for (const filter of filters) {
    const set = new Set<string | null>('in' in filter ? filter.in : filter.notIn)
    const inside = (piece: Piece) => lineage(filter.dimension, keyOf(filter.dimension, piece, input, categories)).some(x => x !== null && set.has(x))
    tests.push('in' in filter ? inside : piece => !inside(piece))
  }
  return piece => tests.every(test => test(piece))
}
