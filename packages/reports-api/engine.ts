// The engine: a source's rows, shaped into a report. It filters, rolls trees up to a depth, pivots the columns (time,
// sub-ledgers side by side, or members), sorts, keeps the top rows and gathers the rest as Other, totals, nets,
// shares, averages, changes and running totals, and a chart's series. Pure and deterministic, and integers only: the
// one division is `ratio`'s and `average`'s, exact through BigInt. It knows nothing about money: what counts is the
// source's. See docs/reporting-design.md, "The engine".
import { ReportsError } from './errors'
import { REPORT_CELLS_MAX, REPORT_ROWS_MAX, REPORT_SERIES_MAX, REPORT_SLICES_MAX } from './protocol'
import type { ColumnDrill, ResultChart, ResultColumn, ResultRow, RowDrill } from './result'
import type { DimensionField, Filter, Member, MeasureField, ReportNote, ReportSourceContribution, SourceResult } from './source'
import type { MeasureUse, NetSpec, ReportSpec } from './spec'

/** A column of the axis across: a time column (with the source's time keys in it), a member, or a sub-ledger. */
export interface ShapeColumn {
  key: string
  label: string
  /** The source's time keys that fall in it (months, or a date). */
  keys?: string[]
}

export interface ShapeInput {
  /** The spec, with its options applied. */
  spec: ReportSpec
  source: ReportSourceContribution
  result: SourceResult
  /** The dimensions the rows are keyed by, and the measures their values are, in order (as asked of the source). */
  dimensions: string[]
  measures: string[]
  /** The time axis's columns, when time is across. */
  columns?: ShapeColumn[]
  /** Sub-ledgers side by side: one column per scope (each row's `scope`), labelled, the whole scope last. */
  scopes?: string[]
  /** The earlier period (or date) compared with: its result, its columns (matched by position), and its label ("2025"). */
  compared?: { result: SourceResult, columns?: ShapeColumn[], label: string }
  /** Balance rows: the source's opening balance, closing balance and accounts opened, by the time columns. */
  balances?: { result: SourceResult, dimensions: string[], measures: string[] }
  /** Filters the heading adds (the members picked), on top of the spec's. */
  filters?: Filter[]
}

export interface ShapedResult {
  columns: ResultColumn[]
  rows: ResultRow[]
  chart?: ResultChart
  notes: ReportNote[]
}

type Cells = (number | null)[]
/** Figures by currency ('' when the report is in one). */
type Money = Map<string, Cells>

const NONE = '\u0000none'
const OTHER = 'other'

// ---- Exact arithmetic

const tooLarge = () => new ReportsError('TOO_LARGE', 'A figure in this report is too large to be shown exactly.')

/** a + b, or TOO_LARGE past the safe integers. null is nothing yet. */
function plus(a: number | null, b: number | null): number | null {
  if (a === null) return b
  if (b === null) return a
  const sum = a + b
  if (!Number.isSafeInteger(sum)) throw tooLarge()
  return sum
}

const times = (a: number | null, sign: number): number | null => a === null ? null : a * sign

/** a ÷ b in basis points, toward zero: 45.2 % is 4520. null when either is missing or b is zero. */
export function ratio(a: number | null, b: number | null): number | null {
  if (a === null || b === null || b === 0) return null
  return Number((BigInt(a) * 10000n) / BigInt(b))
}

/** a ÷ b to the nearest whole number, halves up. b > 0. */
export function averageOf(a: number | null, b: number): number | null {
  if (a === null || b <= 0) return null
  const n = BigInt(a), d = BigInt(b)
  const q = (2n * n + d) / (2n * d)
  // BigInt division truncates toward zero: for a negative numerator, floor instead
  const floored = (2n * n + d) < 0n && (2n * n + d) % (2n * d) !== 0n ? q - 1n : q
  return Number(floored)
}

// ---- Helpers over cells

const blank = (n: number): Cells => new Array<number | null>(n).fill(null)

function addInto(target: Cells, source: Cells, sign = 1) {
  for (let i = 0; i < source.length; i++) if (source[i] !== null) target[i] = plus(target[i], times(source[i], sign))
}

function addMoney(into: Money, from: Money, width: number, sign = 1) {
  for (const [currency, cells] of from) {
    let target = into.get(currency)
    if (!target) into.set(currency, target = blank(width))
    addInto(target, cells, sign)
  }
}

const hasFigures = (money: Money) => [...money.values()].some(cells => cells.some(v => v !== null))

// ---- The shape

interface Node {
  id: string
  label: string
  kind: 'member' | 'none' | 'own' | 'other'
  member?: Member
  parent?: Node
  children: Node[]
  own: Money
  cmp: Money
  /** Own plus children's: what its row shows. */
  total: Money
  cmpTotal: Money
  /** *Other*: the rows it gathers. */
  gathered?: Node[]
}

interface Entry {
  kind: 'col' | 'total' | 'avg'
  col: number
  use: MeasureUse & { show: NonNullable<MeasureUse['show']> }
  /** The measure's place in the source's values. */
  j: number
  field: MeasureField
  /** For 'percentOf': the place, and the field, of the measure it is a share of. */
  jOf?: number
  fieldOf?: MeasureField
}

interface Line {
  id: string
  label: string
  depth: number
  parentId?: string
  kind: ResultRow['kind']
  money: Money
  cmp: Money
  /** Totals the source gave, for measures it combines itself. */
  sourceTotals?: number[]
  sign?: number
  balance?: 'opening' | 'closing' | 'opened'
  /** What its figures gather, for Show Transactions. */
  drill?: RowDrill
  /** It is under a top member where a negative figure is bad (a budget's expenses). */
  bad?: boolean
}

export function shape(input: ShapeInput): ShapedResult {
  const { spec, source, result, dimensions, measures } = input
  const query = spec.query
  const notes: ReportNote[] = [...result.notes]
  for (const note of input.compared?.result.notes ?? []) if (!notes.some(n => n.text === note.text)) notes.push(note)
  for (const note of input.balances?.result.notes ?? []) if (!notes.some(n => n.text === note.text)) notes.push(note)
  const fieldOf = (key: string) => source.fields.find((f): f is DimensionField => f.kind === 'dimension' && f.key === key)
  const measureField = (key: string) => source.fields.find((f): f is MeasureField => f.kind === 'measure' && f.key === key)!
  const nM = measures.length

  // What is shown: 'compared', 'change' and 'changePercent' only while comparing with an earlier period or date
  const comparing = input.compared !== undefined
  const uses = query.measures
    .map((use, index) => ({ ...use, show: use.show ?? 'value' as const, index }))
    .filter(use => comparing || !['compared', 'change', 'changePercent'].includes(use.show))

  // ---- Columns across
  const rowAxis = query.rows
  const colAxis = input.scopes ? undefined : query.columns
  const colField = colAxis ? fieldOf(colAxis.dimension) : undefined
  let cols: ShapeColumn[]
  let colOf: (keys: (string | null)[], scope: number | undefined, columns?: ShapeColumn[]) => number
  if (input.scopes) {
    cols = input.scopes.map((label, i) => ({ key: `scope:${i}`, label }))
    colOf = (_keys, scope) => scope ?? -1
  } else if (colAxis && colField?.type === 'time') {
    cols = input.columns ?? []
    const at = dimensions.indexOf(colAxis.dimension)
    const index = (columns: ShapeColumn[]) => new Map(columns.flatMap((c, i) => (c.keys ?? [c.key]).map(k => [k, i] as const)))
    const main = index(cols)
    const compared = input.compared?.columns ? index(input.compared.columns) : main
    colOf = (keys, _scope, columns) => { const i = (columns ? compared : main).get(keys[at] ?? ''); return i === undefined ? -1 : i }
  } else if (colAxis && colField) {
    const at = dimensions.indexOf(colAxis.dimension)
    const seen = new Set<string | null>()
    for (const r of [...result.rows, ...input.compared?.result.rows ?? []]) seen.add(r.keys[at])
    const list = membersOf(colField, result, input.compared?.result)
    cols = [...seen].map(id => ({ key: id ?? NONE, label: id === null ? colField.noneLabel ?? '(none)' : list.get(id)?.member.label ?? id }))
      .sort((a, b) => (list.get(a.key)?.index ?? 1e9) - (list.get(b.key)?.index ?? 1e9) || a.label.localeCompare(b.label))
    const map = new Map(cols.map((c, i) => [c.key, i]))
    colOf = keys => map.get(keys[at] ?? NONE) ?? -1
  } else {
    cols = [{ key: '', label: '' }]
    colOf = () => 0
  }
  const nC = cols.length
  const width = nC * nM

  // ---- Filters: the spec's, and the heading's picks. On a tree, a member's descendants match with it
  const rowField = rowAxis ? fieldOf(rowAxis.dimension) : undefined
  const allMembers = new Map<string, ReturnType<typeof membersOf>>()
  const membersFor = (dim: string) => {
    let found = allMembers.get(dim)
    if (!found) allMembers.set(dim, found = membersOf(fieldOf(dim)!, result, input.compared?.result))
    return found
  }
  const filters = [...query.filters ?? [], ...input.filters ?? []]
  const passes = (keys: (string | null)[]) => filters.every(f => {
    const at = dimensions.indexOf(f.dimension)
    if (at < 0) return true            // the source filtered it: it isn't in the rows
    const key = keys[at]
    const list = 'in' in f ? f.in : f.notIn
    const field = fieldOf(f.dimension)
    let matches = key !== null && list.includes(key)
    if (!matches && key !== null && field?.tree) {
      const members = membersFor(f.dimension)
      for (let m = members.get(key)?.member; m?.parentId; m = members.get(m.parentId)?.member) {
        if (list.includes(m.parentId)) { matches = true; break }
      }
    }
    return 'in' in f ? matches : !matches
  })

  // ---- Rows down: every source row into the member it rolls up to
  const rowAt = rowAxis ? dimensions.indexOf(rowAxis.dimension) : -1
  const members = rowField ? membersFor(rowField.key) : new Map()
  const depthCache = new Map<string, number>()
  /** How deep a member is, 1 at the top. A source's tree with a loop in it is cut where it loops. */
  const depthOf = (id: string): number => {
    let d = depthCache.get(id)
    if (d === undefined) {
      d = 1
      const seen = new Set([id])
      for (let p = members.get(id)?.member.parentId; p && members.has(p) && !seen.has(p); p = members.get(p)?.member.parentId) { seen.add(p); d++ }
      depthCache.set(id, d)
    }
    return d
  }
  const depth = rowAxis?.depth ?? (rowField?.tree ? 1 : undefined)
  const target = (key: string | null): string => {
    if (!rowAxis) return '*'
    if (key === null) return NONE
    if (!rowField?.tree || depth === 'all' || depth === undefined) return key
    let id = key
    for (let d = depthOf(id); d > depth; d--) id = members.get(id)!.member.parentId!
    return id
  }

  const aggregate = (rows: SourceResult['rows'], columns?: ShapeColumn[]) => {
    const out = new Map<string, Money>()
    for (const row of rows) {
      if (!passes(row.keys)) continue
      const c = colOf(row.keys, row.scope, columns)
      if (c < 0) continue
      const id = target(rowAt < 0 ? null : row.keys[rowAt])
      let money = out.get(id)
      if (!money) out.set(id, money = new Map())
      const currency = row.currency ?? ''
      let cells = money.get(currency)
      if (!cells) money.set(currency, cells = blank(width))
      for (let j = 0; j < nM; j++) cells[c * nM + j] = plus(cells[c * nM + j], row.values[j])
    }
    return out
  }
  const own = aggregate(result.rows)
  const cmpOwn = input.compared ? aggregate(input.compared.result.rows, input.compared.columns) : new Map<string, Money>()

  // ---- The tree of rows
  const nodes = new Map<string, Node>()
  const node = (id: string): Node => {
    let n = nodes.get(id)
    if (!n) {
      const member = members.get(id)?.member
      const label = id === NONE ? rowField?.noneLabel ?? '(none)' : id === '*' ? 'Total' : member?.label ?? id
      n = { id, label, kind: id === NONE || member?.none ? 'none' : 'member', member, children: [], own: new Map(), cmp: new Map(), total: new Map(), cmpTotal: new Map() }
      nodes.set(id, n)
      // A member's parents are rows too, up to the top
      const parentId = member?.parentId
      if (rowField?.tree && parentId && members.has(parentId)) {
        const parent = node(parentId)
        n.parent = parent
        parent.children.push(n)
      }
    }
    return n
  }
  for (const [id, money] of own) addMoney(node(id).own, money, width)
  for (const [id, money] of cmpOwn) addMoney(node(id).cmp, money, width)
  if (rowAxis && rowAxis.empty === 'show' && rowField) {
    for (const [id] of members) if (!rowField.tree || depth === 'all' || depthOf(id) <= (depth as number)) node(id)
  }
  // A member with figures of its own beside its children gets a row for them: "Food (other)"
  for (const n of [...nodes.values()]) {
    if (n.children.length > 0 && (hasFigures(n.own) || hasFigures(n.cmp))) {
      const o: Node = { id: `own:${n.id}`, label: `${n.label} (other)`, kind: 'own', parent: n, children: [], own: n.own, cmp: n.cmp, total: new Map(), cmpTotal: new Map() }
      n.children.push(o)
      n.own = new Map()
      n.cmp = new Map()
      nodes.set(o.id, o)
    }
  }
  const totalUp = (n: Node) => {
    addMoney(n.total, n.own, width)
    addMoney(n.cmpTotal, n.cmp, width)
    for (const child of n.children) {
      totalUp(child)
      addMoney(n.total, child.total, width)
      addMoney(n.cmpTotal, child.cmpTotal, width)
    }
  }
  let roots = [...nodes.values()].filter(n => !n.parent)
  for (const root of roots) totalUp(root)
  const hideEmpty = rowAxis?.empty !== 'show'
  const prune = (list: Node[]): Node[] => list.filter(n => !hideEmpty || hasFigures(n.total) || hasFigures(n.cmpTotal))
    .map(n => { n.children = prune(n.children); return n })
  roots = prune(roots)

  // ---- Sorting, and the top rows
  const first = uses.find(u => u.show === 'value') ?? uses[0]
  const sortJ = measures.indexOf(first.measure)
  const sortCombine = measureField(first.measure).combine
  const sortValue = (n: Node): number => {
    let v = 0
    for (const cells of n.total.values()) {
      if (sortCombine === 'last' || input.scopes) v += cells[(nC - 1) * nM + sortJ] ?? 0
      else for (let c = 0; c < nC; c++) v += cells[c * nM + sortJ] ?? 0
    }
    return v
  }
  const naturalIndex = (n: Node) => n.member?.order ?? members.get(n.id)?.index ?? 1e9
  const rank = (n: Node) => n.kind === 'none' ? 2 : n.kind === 'own' ? 1 : 0
  // A signed tree's top members (income, expenses, transfers) keep their own order: only what is in each is sorted
  const fixedTop = rowField?.tree === true && rowField.values !== undefined
  const sortNodes = (list: Node[], top = false) => {
    const sort = top && fixedTop ? 'natural' : rowAxis?.sort ?? 'natural'
    list.sort((a, b) => rank(a) - rank(b) || (
      sort === 'label' ? a.label.localeCompare(b.label)
        : sort === 'valueDesc' ? sortValue(b) - sortValue(a) || a.label.localeCompare(b.label)
          : sort === 'valueAsc' ? sortValue(a) - sortValue(b) || a.label.localeCompare(b.label)
            : naturalIndex(a) - naturalIndex(b) || a.label.localeCompare(b.label)))
    for (const n of list) sortNodes(n.children)
  }
  sortNodes(roots, true)
  // 'user' is settled by the report manager before a run (`applyTop`); a spec run without it keeps every row
  if (typeof rowAxis?.top === 'number') {
    const keep = rowAxis.top
    const named = roots.filter(n => n.kind !== 'none')
    if (named.length > keep) {
      const rest = named.slice(keep)
      const other: Node = {
        id: OTHER, label: `Other ${rowField?.plural ?? ''}`.trimEnd() + ` (${rest.length})`, kind: 'other',
        children: [], own: new Map(), cmp: new Map(), total: new Map(), cmpTotal: new Map(), gathered: rest
      }
      for (const n of rest) { addMoney(other.total, n.total, width); addMoney(other.cmpTotal, n.cmpTotal, width) }
      roots = [...named.slice(0, keep), other, ...roots.filter(n => n.kind === 'none')]
      notes.push({ tone: 'info', text: `Showing the top ${keep} of ${named.length} ${rowField?.plural ?? 'rows'}.` })
    }
  }

  // ---- Lines, in order: each tree drawn with its subtotals above or below, then nets, totals and balances
  const lines: Line[] = []
  /** The row dimension's key a node stands for. */
  const keyOfNode = (n: Node): string | null => n.id === NONE ? null : n.id
  /** What a node's row gathers, for Show Transactions: its key (a tree's takes in what is beneath it), or what Other holds. */
  const drillOf = (n: Node): RowDrill => n.kind === 'own' ? { keys: [keyOfNode(n.parent!)], own: true }
    : n.kind === 'other' ? { keys: (n.gathered ?? []).map(keyOfNode) }
      : { keys: [keyOfNode(n)] }
  const below = rowAxis?.subtotals === 'below'
  const blockEnd = new Map<string, number>()
  /** Whether a negative figure is bad under this top member (`EnumValue.negativeIsBad`). */
  const badUnder = (top: string) => rowField?.values?.find(v => v.id === top)?.negativeIsBad === true
  const emit = (n: Node, level: number, parentLine: string | undefined, top: string) => {
    const bad = badUnder(top) ? { bad: true } : {}
    if (n.children.length > 0 && below && level === 1) {
      lines.push({ id: n.id, label: n.label, depth: level, ...(parentLine && { parentId: parentLine }), kind: 'heading', money: new Map(), cmp: new Map() })
      for (const child of n.children) emit(child, level + 1, n.id, top)
      lines.push({ id: `total:${n.id}`, label: `Total ${n.label.toLocaleLowerCase()}`, depth: level, ...(parentLine && { parentId: parentLine }), kind: 'subtotal', money: n.total, cmp: n.cmpTotal, sourceTotals: result.totals?.[n.id], drill: drillOf(n), ...bad })
    } else {
      const kind: ResultRow['kind'] = n.children.length > 0 ? 'subtotal' : n.kind
      lines.push({ id: n.id === NONE ? 'none' : n.id, label: n.label, depth: level, ...(parentLine && { parentId: parentLine }), kind, money: n.total, cmp: n.cmpTotal, sourceTotals: result.totals?.[n.id], drill: drillOf(n), ...bad })
      for (const child of n.children) emit(child, level + 1, n.id, top)
    }
    blockEnd.set(n.id, lines.length)
  }
  if (rowAxis) for (const root of roots) emit(root, 1, undefined, root.id)
  else if (nodes.has('*')) lines.push({ id: 'all', label: spec.presentation.table.totals?.label ?? 'Total', depth: 1, kind: 'total', money: nodes.get('*')!.total, cmp: nodes.get('*')!.cmpTotal, sourceTotals: result.totals?.[''], drill: {} })

  // Net rows over a signed dimension's top members
  const signOf = (n: Node): number => n.member?.sign ?? rowField?.values?.find(v => v.id === n.id)?.sign ?? 1
  let previous: string | undefined
  const nets: { spec: NetSpec, line: Line, at: number }[] = []
  for (const net of rowField?.signed ? spec.presentation.table.nets ?? [] : []) {
    const contributing = roots.filter(n => n.kind !== 'other' && n.kind !== 'none' && (net.of === undefined || net.of.includes(n.id)))
    const key = contributing.map(n => n.id).sort().join('|')
    const repeats = key === previous
    previous = key
    if (contributing.length === 0 || repeats) continue          // nothing to net, or the same as the net before it
    const money: Money = new Map(), cmp: Money = new Map()
    for (const n of contributing) { addMoney(money, n.total, width, signOf(n)); addMoney(cmp, n.cmpTotal, width, signOf(n)) }
    // Measures the net reads the other way: a budget's Remaining, which on the net is how far ahead of the plan
    for (const key of net.negate ?? []) {
      const j = measures.indexOf(key)
      if (j < 0) continue
      for (const cells of [...money.values(), ...cmp.values()]) for (let c = 0; c < nC; c++) cells[c * nM + j] = times(cells[c * nM + j], -1)
    }
    const after = net.after !== undefined && blockEnd.has(net.after) ? blockEnd.get(net.after)! : Math.max(...contributing.map(n => blockEnd.get(n.id) ?? 0))
    nets.push({ spec: net, line: { id: `net:${nets.length}`, label: net.label, depth: 1, kind: 'net', money, cmp, drill: { keys: contributing.map(keyOfNode), signed: true } }, at: net.after === undefined ? Infinity : after })
  }
  // Inserted from the last, so earlier positions hold
  for (const { line, at } of [...nets].sort((a, b) => b.at - a.at)) lines.splice(at === Infinity ? lines.length : at, 0, line)

  // The total row: by currency when the rows are in several
  const totals = spec.presentation.table.totals
  if (rowAxis && totals?.row) {
    const money: Money = new Map(), cmp: Money = new Map()
    for (const n of roots) { addMoney(money, n.total, width); addMoney(cmp, n.cmpTotal, width) }
    const label = totals.label ?? 'Total'
    if (money.size > 1) {
      for (const currency of [...money.keys()].sort()) {
        lines.push({ id: `total:${currency}`, label: `${label} (${currency})`, depth: 1, kind: 'total', money: new Map([[currency, money.get(currency)!]]), cmp: new Map(cmp.has(currency) ? [[currency, cmp.get(currency)!]] : []), drill: {} })
      }
    } else lines.push({ id: 'total', label, depth: 1, kind: 'total', money, cmp, sourceTotals: result.totals?.[''], drill: {} })
  }

  // Balance rows: the opening balance first; accounts opened (when there were any) and the closing balance last
  if (spec.presentation.table.balanceRows && input.balances) {
    const b = input.balances
    const at = b.dimensions.indexOf(colAxis?.dimension ?? '')
    const byCol = (measure: string): Money => {
      const j = b.measures.indexOf(measure)
      const cells = blank(width)
      const index = new Map(cols.flatMap((c, i) => (c.keys ?? [c.key]).map(k => [k, i] as const)))
      for (const row of b.result.rows) {
        const c = input.scopes ? row.scope ?? -1 : at < 0 ? 0 : index.get(row.keys[at] ?? '') ?? -1
        if (c < 0 || j < 0) continue
        for (let m = 0; m < nM; m++) cells[c * nM + m] = plus(cells[c * nM + m], row.values[j])
      }
      return new Map([['', cells]])
    }
    const opened = byCol('opened')
    lines.unshift({ id: 'opening', label: 'Opening balance', depth: 1, kind: 'balance', money: byCol('openingBalance'), cmp: new Map(), balance: 'opening' })
    if ([...opened.values()].some(cells => cells.some(v => v !== null && v !== 0))) {
      lines.push({ id: 'opened', label: 'Accounts opened', depth: 1, kind: 'balance', money: opened, cmp: new Map(), balance: 'opened' })
    }
    lines.push({ id: 'closing', label: 'Closing balance', depth: 1, kind: 'balance', money: byCol('closingBalance'), cmp: new Map(), balance: 'closing' })
  }

  // ---- Columns of the table
  const entries: Entry[] = []
  const perColumn = uses.filter(u => u.show !== 'average')
  const averages = uses.filter(u => u.show === 'average')
  const entry = (kind: Entry['kind'], col: number, use: typeof uses[number]): Entry => ({
    kind, col, use, j: measures.indexOf(use.measure), field: measureField(use.measure),
    ...(use.show === 'percentOf' && use.of !== undefined && { jOf: measures.indexOf(use.of), fieldOf: measureField(use.of) })
  })
  const across = input.scopes !== undefined || colAxis !== undefined
  if (across) {
    for (let c = 0; c < nC; c++) for (const use of perColumn) entries.push(entry('col', c, use))
    if (totals?.column && !input.scopes) for (const use of perColumn) entries.push(entry('total', 0, use))
    for (const use of averages) entries.push(entry('avg', 0, use))
  } else {
    for (const use of uses) entries.push(entry('col', 0, use))
  }
  const useLabel = (e: Entry) => e.use.label ?? (
    e.use.show === 'share' ? 'Share' : e.use.show === 'compared' ? input.compared!.label : e.use.show === 'change' ? 'Change'
      : e.use.show === 'changePercent' ? 'Change %' : e.use.show === 'average' ? 'Average' : e.use.show === 'cumulative' ? `${e.field.label} to date`
        : e.use.show === 'percentOf' ? `${e.field.label} as % of ${e.fieldOf?.label ?? ''}`.trimEnd() : e.field.label)
  const unitOf = (e: Entry): ResultColumn['unit'] => e.use.show === 'share' || e.use.show === 'changePercent' || e.use.show === 'percentOf' ? 'percent' : e.field.unit
  const several = perColumn.length > 1
  // Show Transactions: a figure that is a sum of what a source can list, over the report's period or the one compared
  const drills = source.drillDown === true && source.time !== 'asOf'
  const columnDrill = (e: Entry): ColumnDrill | undefined => {
    const show = e.use.show
    if (!drills || e.kind === 'avg' || e.field.combine !== 'sum' || e.field.drillDown === false || !['value', 'share', 'compared', 'cumulative'].includes(show)) return undefined
    const compared = show === 'compared'
    const drill: ColumnDrill = { measure: e.use.measure, ...(compared && { compared: true }) }
    if (e.kind === 'total' || !across) return drill
    if (input.scopes) return { ...drill, scope: e.col }
    if (colField?.type === 'time') {
      const list = (compared ? input.compared?.columns : cols) ?? []
      const covered = show === 'cumulative' ? list.slice(0, e.col + 1) : list.slice(e.col, e.col + 1)
      return covered.length === 0 ? undefined : { ...drill, months: covered.flatMap(c => c.keys ?? [c.key]) }
    }
    return { ...drill, member: cols[e.col].key === NONE ? null : cols[e.col].key }
  }
  const columns: ResultColumn[] = entries.map((e, i): ResultColumn => {
    const key = `c${i}`
    const drill = columnDrill(e)
    const withDrill = (column: ResultColumn): ResultColumn => drill ? { ...column, drill } : column
    if (e.kind === 'avg') return { key, label: useLabel(e), unit: unitOf(e), total: true }
    if (e.kind === 'total') return withDrill({ key, label: several ? useLabel(e) : 'Total', ...(several && { group: 'Total' }), unit: unitOf(e), total: true })
    if (!across) return withDrill({ key, label: useLabel(e), unit: unitOf(e) })
    return withDrill(several
      ? { key, label: useLabel(e), group: cols[e.col].label, unit: unitOf(e) }
      : { key, label: cols[e.col].label, unit: unitOf(e) })
  })

  // The totals each column's shares are of: the total row's, or the whole rows' when there is none
  const grand: Money = new Map()
  for (const n of roots) addMoney(grand, n.total, width)
  const grandCells = grand.size === 1 ? [...grand.values()][0] : blank(width)

  const combine = (cells: Cells, e: Entry, sourceTotal?: number): number | null => {
    if (e.field.combine === 'none') return sourceTotal ?? null
    let v: number | null = null
    if (e.field.combine === 'last') {
      for (let c = nC - 1; c >= 0; c--) { const x = cells[c * nM + e.j]; if (x !== null) return x }
      return null
    }
    for (let c = 0; c < nC; c++) v = plus(v, cells[c * nM + e.j])
    return v
  }
  const change = (v: number | null, p: number | null) => v === null && p === null ? null : plus(v ?? 0, -(p ?? 0))
  const combineSum = (cells: Cells, j: number) => { let v: number | null = null; for (let c = 0; c < nC; c++) v = plus(v, cells[c * nM + j]); return v }

  const valueOf = (line: Line, cells: Cells, prior: Cells | undefined, e: Entry): number | null => {
    const at = e.col * nM + e.j
    if (line.balance) {
      if (e.use.show !== 'value') return null
      if (e.kind === 'col') return cells[at]
      if (e.kind === 'avg') return null
      if (line.balance === 'opening') { for (let c = 0; c < nC; c++) if (cells[c * nM + e.j] !== null) return cells[c * nM + e.j]; return null }
      if (line.balance === 'closing') { for (let c = nC - 1; c >= 0; c--) if (cells[c * nM + e.j] !== null) return cells[c * nM + e.j]; return null }
      let v: number | null = null
      for (let c = 0; c < nC; c++) v = plus(v, cells[c * nM + e.j])
      return v
    }
    const noShare = line.kind === 'net'
    // A per cent of another figure, in each cell: of the same cells, summed for a total, never for a net
    if (e.use.show === 'percentOf') {
      if (noShare || e.jOf === undefined || e.jOf < 0 || e.kind === 'avg') return null
      if (e.kind === 'total') return ratio(combine(cells, e), combine(cells, { ...e, j: e.jOf, field: e.fieldOf! }))
      return ratio(cells[at], cells[e.col * nM + e.jOf])
    }
    if (e.kind === 'avg') return averageOf(combineSum(cells, e.j), nC)
    if (e.kind === 'total') {
      const v = combine(cells, e, line.sourceTotals?.[e.j])
      const p = prior ? combine(prior, e) : null
      switch (e.use.show) {
        case 'value': case 'cumulative': return v
        case 'share': return noShare ? null : ratio(v, combine(grandCells, e, result.totals?.['']?.[e.j]))
        case 'compared': return p
        case 'change': return change(v, p)
        case 'changePercent': return p === null || p === 0 ? null : ratio(change(v, p), Math.abs(p))
        default: return null
      }
    }
    const v = cells[at]
    const p = prior ? prior[at] : null
    switch (e.use.show) {
      case 'value': return v
      case 'share': return noShare ? null : ratio(v, grandCells[at])
      case 'compared': return p
      case 'change': return change(v, p)
      case 'changePercent': return p === null || p === 0 ? null : ratio(change(v, p), Math.abs(p))
      case 'cumulative': {
        let sum: number | null = null
        for (let c = 0; c <= e.col; c++) sum = plus(sum, cells[c * nM + e.j])
        return sum
      }
      default: return null
    }
  }

  const negativeIsBad = (line: Line, e?: Entry) => line.kind === 'net' || line.kind === 'balance' || line.bad === true || e?.field.negativeIsBad === true
  let rows: ResultRow[] = lines.map(line => {
    const currencies = [...line.money.keys()]
    const mixed = currencies.length > 1
    const cells = mixed ? blank(width) : line.money.get(currencies[0] ?? '') ?? blank(width)
    const prior = input.compared ? (mixed ? blank(width) : line.cmp.get(currencies[0] ?? '') ?? line.cmp.get('') ?? blank(width)) : undefined
    const values = line.kind === 'heading' ? entries.map(() => null) : entries.map(e => valueOf(line, cells, prior, e))
    const currency = !mixed && currencies[0] ? currencies[0] : undefined
    return {
      id: line.id, label: line.label, depth: line.depth, ...(line.parentId && { parentId: line.parentId }), kind: line.kind, values,
      ...(currency && { currency }), ...(negativeIsBad(line, entries[0]) && { negativeIsBad: true }),
      ...(drills && line.drill && { drill: line.drill })
    }
  })

  // ---- Limits: the first rows that fit, the summary rows kept
  const summary = (r: ResultRow) => r.kind === 'total' || r.kind === 'net' || r.kind === 'balance'
  const fit = Math.min(REPORT_ROWS_MAX, Math.floor(REPORT_CELLS_MAX / Math.max(1, entries.length)))
  if (rows.length > fit) {
    const kept = rows.filter(r => !summary(r)).slice(0, Math.max(0, fit - rows.filter(summary).length))
    notes.push({ tone: 'warning', text: `This report is too large to show whole: showing the first ${kept.length} of ${rows.filter(r => !summary(r)).length} rows. Choose a shorter period, fewer columns or fewer rows.` })
    rows = [...kept, ...rows.filter(summary)]
  }

  // ---- The chart
  const chart = chartOf(input, {
    roots, cols, entries, useLabel, across, width, nM,
    value: (money, cmp, e) => {
      const currencies = [...money.keys()]
      if (currencies.length > 1) return null
      const cells = money.get(currencies[0] ?? '') ?? blank(width)
      return valueOf({ id: '', label: '', depth: 1, kind: 'member', money, cmp }, cells, input.compared ? cmp.get(currencies[0] ?? '') ?? blank(width) : undefined, e)
    },
    lines: lines.filter(l => l.kind === 'net' || l.kind === 'total'),
    uses
  })
  return { columns, rows, ...(chart && { chart }), notes }
}

/** Members of a dimension, from a result and the one compared with, with their place in the list. */
function membersOf(field: DimensionField, result: SourceResult, compared?: SourceResult): Map<string, { member: Member, index: number }> {
  const out = new Map<string, { member: Member, index: number }>()
  const add = (member: Member) => { if (!out.has(member.id)) out.set(member.id, { member, index: out.size }) }
  for (const value of field.values ?? []) add({ id: value.id, label: value.label, ...(value.sign !== undefined && { sign: value.sign }) })
  for (const member of result.members[field.key] ?? []) add(member)
  for (const member of compared?.members[field.key] ?? []) add(member)
  return out
}

interface ChartParts {
  roots: Node[]
  cols: ShapeColumn[]
  entries: Entry[]
  uses: (MeasureUse & { show: NonNullable<MeasureUse['show']>, index: number })[]
  useLabel(e: Entry): string
  across: boolean
  width: number
  nM: number
  value(money: Money, cmp: Money, e: Entry): number | null
  lines: Line[]
}

/** The chart's series, from the same figures as the table: at most 12 series or 8 slices, the smallest as Other. */
function chartOf(input: ShapeInput, parts: ChartParts): ResultChart | undefined {
  const spec = input.spec.presentation.chart
  if (!spec) return undefined
  const use = parts.uses.find(u => u.index === spec.measure)
  if (!use) return undefined                        // a compared figure, while nothing is compared
  const field = input.source.fields.find((f): f is MeasureField => f.kind === 'measure' && f.key === use.measure)!
  const unit = field.unit === 'count' ? 'count' : 'money'
  const entryFor = (kind: Entry['kind'], col: number): Entry => ({ kind, col, use, j: input.measures.indexOf(use.measure), field })
  const total = parts.across && input.spec.presentation.table.totals?.column && !input.scopes ? entryFor('total', 0) : undefined
  const byValue = (values: (number | null)[]) => values.reduce<number>((a, v) => a + Math.abs(v ?? 0), 0)
  const gather = <T extends { label: string, values: (number | null)[] }>(list: T[], keep: number, make: (values: (number | null)[], count: number) => T): T[] => {
    if (list.length <= keep) return list
    const ranked = [...list].sort((a, b) => byValue(b.values) - byValue(a.values))
    const kept = new Set(ranked.slice(0, keep - 1))
    const rest = list.filter(x => !kept.has(x))
    const values = rest[0].values.map((_, i) => rest.reduce<number | null>((a, x) => plus(a, x.values[i]), null))
    return [...list.filter(x => kept.has(x)), make(values, rest.length)]
  }

  // Figures side by side (Budget and Actual), one series each, for the rows, or those under a top member
  if (spec.kind !== 'donut' && spec.series === 'measures' && spec.measures && !parts.across) {
    const nodes = spec.under !== undefined ? parts.roots.find(n => n.id === spec.under)?.children ?? [] : parts.roots
    const shown = nodes.slice(0, spec.limit ?? REPORT_SERIES_MAX)
    const series = spec.measures.flatMap(index => {
      const u = parts.uses.find(x => x.index === index)
      if (!u) return []
      const f = input.source.fields.find((x): x is MeasureField => x.kind === 'measure' && x.key === u.measure)!
      const e: Entry = { kind: 'col', col: 0, use: u, j: input.measures.indexOf(u.measure), field: f }
      return [{ key: `m${index}`, label: parts.useLabel(e), values: shown.map(n => parts.value(n.total, n.cmpTotal, e)), as: 'bar' as const }]
    })
    return { kind: spec.kind, ...(spec.horizontal && { horizontal: true }), categories: shown.map(n => n.label), series, unit }
  }
  if (spec.kind === 'donut' || !parts.across) {
    // The rows are the categories: each row's figure (its total across, when there are columns)
    const points = parts.roots.map(n => ({
      key: n.id === NONE ? 'none' : n.id, label: n.label,
      values: [parts.value(n.total, n.cmpTotal, total ?? entryFor('col', 0))]
    }))
    if (spec.kind === 'donut') {
      const slices = gather(points, spec.slices ?? REPORT_SLICES_MAX, (values, count) => ({ key: 'other', label: `Other (${count})`, values }))
      return { kind: 'donut', categories: slices.map(s => s.label), series: [{ key: 'value', label: parts.useLabel(entryFor('col', 0)), values: slices.map(s => s.values[0]) }], unit }
    }
    const bars = points.slice(0, spec.limit ?? REPORT_SERIES_MAX)
    return {
      kind: spec.kind, ...(spec.horizontal && { horizontal: true }), categories: bars.map(b => b.label),
      series: [{ key: 'value', label: parts.useLabel(entryFor('col', 0)), values: bars.map(b => b.values[0]) }], unit
    }
  }
  // Columns across: a series per row, by column
  const series = parts.roots.map(n => ({
    key: n.id === NONE ? 'none' : n.id, label: n.label,
    values: parts.cols.map((_, c) => parts.value(n.total, n.cmpTotal, entryFor('col', c)))
  }))
  const stack = spec.kind === 'stackedBar' || spec.kind === 'area' ? 'all' : undefined
  const as = spec.kind === 'line' || spec.kind === 'area' ? 'line' as const : 'bar' as const
  const kept = gather(series, spec.limit ?? REPORT_SERIES_MAX, (values, count) => ({ key: 'other', label: `Other (${count})`, values }))
    .map(s => ({ ...s, as, ...(stack && { stack }) }))
  if (spec.line) {
    const line = parts.lines.find(l => l.kind === spec.line!.row)
    if (line) kept.push({ key: line.id, label: line.label, values: parts.cols.map((_, c) => parts.value(line.money, line.cmp, entryFor('col', c))), as: 'line' })
  }
  return { kind: spec.kind, ...(spec.horizontal && { horizontal: true }), categories: parts.cols.map(c => c.label), series: kept, unit }
}
