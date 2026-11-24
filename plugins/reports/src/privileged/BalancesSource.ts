// `reports.balances`, the source behind Net Worth and Account Balances: each account's balance at the dates asked,
// from accounts.service's `balanceHistory` (archived history and accounts an archive removed included), placed by
// balances.ts. See docs/reporting-design.md, "How things stood: the balances source".
import type { Disposable, Event } from '@tessera/types'
import {
  ReportsError, addDays, dayLabel,
  type DimensionField, type Member, type MembersRequest, type ReportNote, type ReportSource, type SourceQuery, type SourceResult
} from '@tessera/reports-api'
import { BALANCES_CONTRIBUTION, balanceMembers, balanceRowsOf } from './balances'
import { followLedger, notCountedNote, readLedger, type SourceDeps } from './FlowsSource'
import { counts, covers, placedAccounts, scopeOf } from './ledgerView'
import { Emitter, translate } from './store'

export class BalancesSource implements ReportSource {
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
    if (!('dates' in request.period)) throw new ReportsError('INVALID', 'Balances are reported at dates.', 'period')
    const dates = [...new Set(request.period.dates)].sort()
    const view = await readLedger(this.deps)
    const placed = placedAccounts(view)
    const currency = request.currency
    const scopes = (request.scopes ?? [request.scope ?? { kind: 'ledger' as const }]).map(s => scopeOf(s, view, currency))
    const counted = [...placed.values()].filter(a => scopes.some(s => counts(s, a, currency)))
    const points = counted.length === 0 || dates.length === 0 ? [] : await this.outside(() =>
      this.deps.accounts.balanceHistory({ dates, accountIds: counted.map(a => a.id) }))
    const input = { points, placed, subLedgers: view.subLedgers, scopes, sideBySide: request.scopes !== undefined, currency, dimensions: request.dimensions, measures: request.measures }
    const rows = balanceRowsOf(input)
    const notes: ReportNote[] = []

    const whole = scopes[scopes.length - 1]
    const notCounted = notCountedNote(placed.values(), a => covers(whole, a), currency)
    if (notCounted) notes.push(notCounted)
    if (points.some(p => !p.exact)) {
      notes.push({ tone: 'info', text: 'Balances on dates inside a month an archive removed transactions from are as of that month’s end: archived totals are kept by month.' })
    }
    const has = new Set(points.map(p => `${p.accountId}|${p.date}`))
    const unknown = counted.filter(a => a.incompleteBefore !== undefined && dates.some(d => d >= a.openingDate && !has.has(`${a.id}|${d}`)))
    if (unknown.length > 0) {
      notes.push({ tone: 'warning', text: `Balances before the last archive of ${unknown.map(a => a.name).sort().join(', ')} aren’t known: ${unknown.length === 1 ? 'it was' : 'they were'} archived before reports could keep their totals.` })
    }
    // As of today: what is entered for later isn't in today's balance, though the navigator adds it
    const today = this.deps.today()
    const live = counted.filter(a => !a.removed).map(a => a.id)
    if (dates.includes(today) && live.length > 0) {
      const later = await this.outside(() => this.deps.accounts.transactionTotals({ from: addDays(today, 1), to: '9999-12-31', accountIds: live }))
      const count = later.reduce((n, t) => n + t.count, 0)
      if (count > 0) notes.push({ tone: 'info', text: `${count} transaction${count === 1 ? '' : 's'} dated after ${dayLabel(today)} ${count === 1 ? 'isn’t' : 'aren’t'} included.` })
    }
    const fields = BALANCES_CONTRIBUTION.fields.filter((f): f is DimensionField => f.kind === 'dimension')
    return { rows, members: balanceMembers(rows, input, fields), notes }
  }

  async members(request: MembersRequest): Promise<Member[]> {
    const view = await readLedger(this.deps)
    const placed = placedAccounts(view)
    switch (request.dimension) {
      case 'account': case 'byPlace': case 'byType':
        return [...placed.values()].map(a => ({ id: a.id, label: a.removed ? `${a.name} (archived)` : a.name }))
      case 'currency':
        return [...new Set([...placed.values()].map(a => a.currency))].sort().map(c => ({ id: c, label: c }))
      default: return []
    }
  }
}
