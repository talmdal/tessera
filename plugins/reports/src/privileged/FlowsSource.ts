// `reports.flows`, the source behind Income vs Expenses, Spending by Category and by Payee, Cash Flow and Category
// Trends: what went in and out, read from accounts.service (`transactionTotals` for what is in the ledger, once per
// query; `archivedTotals` for what archives removed; `balanceHistory` for Cash Flow's balances) and classified by
// flows.ts. See docs/reporting-design.md, "What counts: the flows source".
import type { Disposable, Event, Logger } from '@tessera/types'
import type { AccountsService, ArchivedTotal, Transaction, TransactionTotal } from '@tessera/accounts-api'
import type { LedgerSession } from '@tessera/ledger-api'
import {
  ReportsError, addDays, dayLabel, firstDayOf, lastDayOf, monthOf, periodLabel,
  type DimensionField, type DrillRequest, type DrillResult, type Member, type MembersRequest, type ReportNote, type ReportSource, type SourceQuery,
  type SourceResult, type SourceRow
} from '@tessera/reports-api'
import { pieceMatcher } from './drill'
import {
  BALANCE_MEASURES, FLOWS_CONTRIBUTION, GROUPS, balanceDates, balanceRows, countsFor, figure, flowMembers, flowRows, piecesOf, type FlowsInput
} from './flows'
import { counts, covers, placedAccounts, scopeOf, type LedgerView, type Placed } from './ledgerView'
import { Emitter, translate } from './store'

export interface SourceDeps {
  session: LedgerSession
  accounts: AccountsService
  log: Pick<Logger, 'warn' | 'error'>
  /** Today, 'YYYY-MM-DD' (tests fix it). */
  today: () => string
}

/** What both sources read first: the tree, the accounts, and those archives removed. */
export async function readLedger(deps: Pick<SourceDeps, 'session' | 'accounts'>): Promise<LedgerView> {
  try {
    const [tree, accounts, removed] = await Promise.all([deps.session.tree(), deps.accounts.list(), deps.accounts.removedAccounts()])
    return { ledgerName: tree.ledger.name, subLedgers: tree.subLedgers, accounts, removed }
  } catch (err) { throw translate(err) }
}

/** "Not counted: US Visa, in USD." for the accounts in scope left out for their currency. */
export function notCountedNote(placed: Iterable<Placed>, isCovered: (a: Placed) => boolean, currency: string | undefined): ReportNote | undefined {
  if (currency === undefined) return undefined
  const left = [...placed].filter(a => isCovered(a) && a.currency !== currency).sort((a, b) => a.name.localeCompare(b.name))
  if (left.length === 0) return undefined
  return { tone: 'info', text: `Not counted: ${left.map(a => `${a.name}, in ${a.currency}`).join('; ')}.` }
}

/** Follows what a source reports on: fires after anything it reads changes. */
export function followLedger(deps: Pick<SourceDeps, 'session' | 'accounts'>, fire: () => void, balances: boolean): Disposable[] {
  return [
    deps.session.onDidChange(() => fire()),
    deps.session.onDidChangeTree(() => fire()),
    deps.session.onDidArchive(() => fire()),
    deps.accounts.onDidChange(c => {
      const flows = c.transactions.length > 0 || c.categories || c.created.length > 0 || c.updated.length > 0 || c.deleted.length > 0
      if (flows || (balances && (c.balances.length > 0 || c.chart))) fire()
    })
  ]
}

export class FlowsSource implements ReportSource {
  private readonly changes: Emitter<void>
  private readonly subscriptions: Disposable[]
  readonly onDidChange: Event<void>

  constructor(private readonly deps: SourceDeps) {
    this.changes = new Emitter(deps.log, 'source')
    this.onDidChange = this.changes.event
    this.subscriptions = followLedger(deps, () => this.changes.fire(), true)
  }

  dispose() {
    for (const s of this.subscriptions.splice(0)) s.dispose()
  }

  private async outside<T>(work: () => Promise<T>): Promise<T> {
    try { return await work() } catch (err) { throw translate(err) }
  }

  async query(request: SourceQuery): Promise<SourceResult> {
    if (!('from' in request.period)) throw new ReportsError('INVALID', 'Transactions are reported over a period.', 'period')
    const range = { from: request.period.from, to: request.period.to }
    const view = await readLedger(this.deps)
    const placed = placedAccounts(view)
    const currency = request.currency
    const scopes = (request.scopes ?? [request.scope ?? { kind: 'ledger' as const }]).map(s => scopeOf(s, view, currency))
    const counted = [...placed.values()].filter(a => scopes.some(s => counts(s, a, currency)))
    const flowMeasures = request.measures.filter(m => !(BALANCE_MEASURES as readonly string[]).includes(m))
    const wantsBalances = request.measures.some(m => (BALANCE_MEASURES as readonly string[]).includes(m))
    const byPayee = request.dimensions.includes('payee') || request.filters.some(f => f.dimension === 'payee')
    const notes: ReportNote[] = []

    // What is in the ledger: one read, for every scope's accounts
    const liveIds = counted.filter(a => !a.removed).map(a => a.id)
    const live: TransactionTotal[] = flowMeasures.length === 0 || liveIds.length === 0 ? [] : await this.outside(() =>
      this.deps.accounts.transactionTotals({ from: range.from, to: range.to, accountIds: liveIds, includeTransfers: true, byPayee }))
    // What archives removed, kept by month: a month the period cuts in two can't be split, so it is left out, and said
    let archived: ArchivedTotal[] = []
    if (flowMeasures.length > 0) {
      const kept = await this.outside(() => this.deps.accounts.archivedTotals({
        from: firstDayOf(monthOf(range.from)), to: lastDayOf(monthOf(range.to)), includeTransfers: true, byPayee
      }))
      const whole = (month: string) => firstDayOf(month) >= range.from && lastDayOf(month) <= range.to
      const cut = [...new Set(kept.filter(t => !whole(t.month)).map(t => t.month))].sort()
      archived = kept.filter(t => whole(t.month))
      if (cut.length > 0) {
        notes.push({ tone: 'warning', text: `Transactions archived from ${cut.map(m => periodLabel({ from: firstDayOf(m), to: lastDayOf(m) }, CALENDAR)).join(' and ')} are kept as monthly totals, which this period cuts in two, so they are left out. Choose whole months to include them.` })
      }
    }

    const categories = await this.outside(() => this.deps.accounts.categories.list())
    const payeeIds = byPayee ? [...new Set([...live, ...archived].flatMap(t => t.payeeId ? [t.payeeId] : []))] : []
    const payees = payeeIds.length === 0 ? new Map<string, string>() : new Map((await this.outside(() => this.deps.accounts.payees.get(payeeIds))).map(p => [p.id, p.name]))
    const sideBySide = request.scopes !== undefined
    const input = { live, archived, categories, placed, subLedgers: view.subLedgers, payees, scopes, sideBySide, currency, dimensions: request.dimensions, measures: request.measures }
    const { rows, transfers } = flowMeasures.length > 0 ? flowRows(input) : { rows: [] as SourceRow[], transfers: false }

    if (wantsBalances) {
      const spans = balanceDates(range, request.dimensions.includes('month'))
      const dates = [...new Set(spans.flatMap(s => [addDays(s.start, -1), s.end]))]
      const points = counted.length === 0 ? [] : await this.outside(() => this.deps.accounts.balanceHistory({ dates, accountIds: counted.map(a => a.id) }))
      const balances = new Map<string, Map<string, number>>()
      for (const p of points) {
        let byDate = balances.get(p.accountId)
        if (!byDate) balances.set(p.accountId, byDate = new Map())
        byDate.set(p.date, p.balance)
      }
      const made = balanceRows({ range, balances, placed, scopes, sideBySide, currency, dimensions: request.dimensions, measures: request.measures })
      rows.push(...made.rows)
      if (made.unknown.length > 0) {
        notes.push({ tone: 'warning', text: `Balances before the last archive of ${made.unknown.map(a => a.name).sort().join(', ')} aren’t known: ${made.unknown.length === 1 ? 'it was' : 'they were'} archived before reports could keep their totals.` })
      }
    }

    // Notes: accounts left out for their currency; history archived before totals were kept; transfers side by side
    const whole = scopes[scopes.length - 1]
    const notCounted = notCountedNote(placed.values(), a => covers(whole, a), currency)
    if (notCounted) notes.push(notCounted)
    const incomplete = counted.filter(a => a.incompleteBefore !== undefined && a.incompleteBefore > range.from)
    if (incomplete.length > 0 && flowMeasures.length > 0) {
      const before = incomplete.map(a => a.incompleteBefore!).sort()[incomplete.length - 1]
      notes.push({ tone: 'warning', text: `Transactions archived before ${dayLabel(before)} were archived before reports could keep their totals, so they aren’t in this report. Open the archive file to report on them.` })
    }
    if (request.scopes && request.scopes.length > 1 && transfers) {
      notes.push({ tone: 'info', text: 'Transfers between these sub-ledgers cancel out over the whole.' })
    }
    const fields = FLOWS_CONTRIBUTION.fields.filter((f): f is DimensionField => f.kind === 'dimension')
    return { rows, members: flowMembers(rows, input, fields), notes }
  }

  /**
   * The transactions behind a figure (Show Transactions): every transaction in the counted accounts over the period,
   * each made a total of one and classified by the same rules as the totals, kept when one of its pieces is in the
   * figure, with its part of it. Archived months can't be listed: what they add is given apart.
   */
  async transactions(request: DrillRequest): Promise<DrillResult> {
    if (!('from' in request.period)) throw new ReportsError('INVALID', 'Transactions are listed over a period.', 'period')
    const { from, to } = request.period
    const view = await readLedger(this.deps)
    const placed = placedAccounts(view)
    const currency = request.currency
    const scope = scopeOf(request.scope ?? { kind: 'ledger' }, view, currency)
    const categories = await this.outside(() => this.deps.accounts.categories.list())
    const input: FlowsInput = {
      live: [], archived: [], categories, placed, subLedgers: view.subLedgers, payees: new Map(), scopes: [scope], currency, dimensions: [], measures: []
    }
    const byId = new Map(categories.map(c => [c.id, c]))
    const matches = pieceMatcher(request.key, request.filters, input)
    const measure = request.measure === 'count' ? 'net' : request.measure
    // A net's parts go with their group's sign: income adds, expenses take away
    const signOf = (p: { group: string }) => request.key.signed ? GROUPS.find(g => g.id === p.group)?.sign ?? 1 : 1
    const partOf = (pieces: ReturnType<typeof piecesOf>) => pieces.filter(matches).reduce((sum, p) => sum + signOf(p) * figure(measure, p), 0)

    // What archives kept, by whole months in the period
    const kept = await this.outside(() => this.deps.accounts.archivedTotals({ from: firstDayOf(monthOf(from)), to: lastDayOf(monthOf(to)), includeTransfers: true, byPayee: true }))
    let archivedAmount = 0
    let archivedAny = false
    for (const t of kept) {
      if (firstDayOf(t.month) < from || lastDayOf(t.month) > to || !countsFor(t, scope, placed, currency)) continue
      const pieces = piecesOf(t, byId, true)
      if (pieces.some(matches)) { archivedAny = true; archivedAmount += partOf(pieces) }
    }

    // What is in the ledger, transaction by transaction
    const found: { t: Transaction, amount: number }[] = []
    for (const account of placed.values()) {
      if (account.removed || !counts(scope, account, currency)) continue
      for (const t of await this.outside(() => this.deps.accounts.transactions(account.id).list({ from, to }))) {
        if (t.voided) continue
        const total = {
          accountId: t.accountId, month: monthOf(t.date), categoryId: t.transferAccountId === undefined ? t.categoryId ?? null : null,
          transferAccountId: t.transferAccountId ?? null, inflow: Math.max(t.amount, 0), outflow: Math.max(-t.amount, 0), count: 1, payeeId: t.payeeId ?? null
        }
        if (!countsFor(total, scope, placed, currency)) continue
        const pieces = piecesOf(total, byId, false)
        if (pieces.some(matches)) found.push({ t, amount: partOf(pieces) })
      }
    }
    found.sort((a, b) => a.t.date < b.t.date ? -1 : a.t.date > b.t.date ? 1 : (placed.get(a.t.accountId)?.name ?? '').localeCompare(placed.get(b.t.accountId)?.name ?? ''))
    const listed = found.slice(0, Math.max(0, request.limit))

    // Payees and labels as the register shows them, read only for the accounts listed
    const shown = new Map<string, { payeeName?: string, categoryLabel?: string }>()
    for (const accountId of new Set(listed.map(f => f.t.accountId))) {
      for (const r of (await this.outside(() => this.deps.accounts.transactions(accountId).register())).rows) shown.set(r.transaction.id, r)
    }
    // Archived before: the latest archive of the accounts counted
    const lastArchive = view.accounts.filter(a => counts(scope, placed.get(a.id)!, currency))
      .map(a => a.lastArchiveDate).filter((d): d is string => d !== undefined).sort().at(-1)
    return {
      transactions: listed.map(({ t, amount }) => {
        const more = shown.get(t.id)
        return {
          id: t.id, accountId: t.accountId, accountName: placed.get(t.accountId)?.name ?? '', date: t.date, amount,
          currency: placed.get(t.accountId)?.currency ?? currency ?? '',
          ...(more?.payeeName !== undefined && { payee: more.payeeName }), ...(more?.categoryLabel !== undefined && { label: more.categoryLabel })
        }
      }),
      total: found.length,
      ...(archivedAny && { archived: { amount: archivedAmount, before: lastArchive ?? from } })
    }
  }

  async members(request: MembersRequest): Promise<Member[]> {
    const view = await readLedger(this.deps)
    switch (request.dimension) {
      case 'group': case 'flow': return GROUPS.map(g => ({ id: g.id, label: g.label, sign: g.sign }))
      case 'category': {
        const categories = await this.outside(() => this.deps.accounts.categories.list())
        return categories.map(c => ({ id: c.id, label: c.name, parentId: c.parentId })).sort((a, b) => a.label.localeCompare(b.label))
      }
      case 'account': case 'otherAccount':
        return [...placedAccounts(view).values()].map(a => ({ id: a.id, label: a.removed ? `${a.name} (archived)` : a.name }))
      case 'subLedger': case 'otherSubLedger':
        return view.subLedgers.map(s => ({ id: s.id, label: s.name, parentId: s.parentId, order: s.order }))
      case 'payee':
        return (await this.outside(() => this.deps.accounts.payees.search('', 1000))).map(p => ({ id: p.id, label: p.name }))
      default: return []
    }
  }
}

const CALENDAR = { month: 1, day: 1 }
