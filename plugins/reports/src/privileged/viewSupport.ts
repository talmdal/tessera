// What the report view's heading needs beyond a run: the report opened (its source's parameters, what Compare with
// offers, the pickers), the ledger's tree, accounts and currencies to choose from, and *Accounts* carried from the
// report shown before. Reads only. See docs/reporting-design.md, "The Reports tab and the report view".
import { mostUsedCurrency, type AccountsService } from '@tessera/accounts-api'
import { yearStartOf, type LedgerSession } from '@tessera/ledger-api'
import {
  ReportsError, parameterProblems,
  type DimensionField, type OpenedView, type ReportParameters, type ReportRef, type ReportSpec, type ReportsSettings, type RunArgs, type ScopeKind, type ScopeValue
} from '@tessera/reports-api'
import type { ReportsServiceImpl } from './ReportsServiceImpl'
import { translate } from './store'
import { stable, type LastChoices } from './viewState'

const ALL_KINDS: ScopeKind[] = ['ledger', 'subLedger', 'types', 'accounts']

/**
 * *Accounts* carried from the last report to the next: the sub-ledger chosen goes with the user (Personal stays
 * Personal), as the next report takes it. A report that starts on account types (Cash Flow: the everyday accounts)
 * keeps its types, in that sub-ledger; types chosen are carried only to such a report; accounts chosen one by one, to a
 * report that takes them. Otherwise the report's own start.
 */
export function carryScope(remembered: ScopeValue | undefined, start: ScopeValue | undefined, allowed: readonly ScopeKind[], subLedgerIds: ReadonlySet<string>): ScopeValue | undefined {
  if (!remembered || !start) return start
  if (remembered.kind === 'accounts') return allowed.includes('accounts') ? remembered : start
  const raw = remembered.kind === 'subLedger' ? remembered.subLedgerId : remembered.kind === 'types' ? remembered.subLedgerId : undefined
  const sub = raw !== undefined && subLedgerIds.has(raw) ? raw : undefined
  if (start.kind === 'types') {
    if (remembered.kind === 'types' && allowed.includes('types')) return sub === undefined ? { kind: 'types', types: [...remembered.types] } : { ...remembered, types: [...remembered.types] }
    return { kind: 'types', types: [...start.types], ...(sub !== undefined && { subLedgerId: sub }) }
  }
  if (sub !== undefined) return allowed.includes('subLedger') ? { kind: 'subLedger', subLedgerId: sub } : start
  return allowed.includes('ledger') ? { kind: 'ledger' } : start
}

/** What a report opens on, left to itself: its definition's choice, or the table alone where the Reports page says so. */
export const defaultShow = (spec: ReportSpec, openOn: ReportsSettings['openOn']): OpenedView['show'] =>
  spec.presentation.show === 'both' && openOn === 'table' ? 'table' : spec.presentation.show

/** Parameters remembered, less a scope naming a sub-ledger that is gone, and accounts that are gone. */
export function stillThere(parameters: ReportParameters, subLedgerIds: ReadonlySet<string>, accountIds: ReadonlySet<string>): ReportParameters {
  const scope = parameters.scope
  if (!scope) return parameters
  const { scope: _scope, ...rest } = parameters
  if ((scope.kind === 'subLedger' || scope.kind === 'types') && scope.subLedgerId !== undefined && !subLedgerIds.has(scope.subLedgerId)) return rest
  if (scope.kind === 'accounts') {
    const kept = scope.accountIds.filter(id => accountIds.has(id))
    return kept.length === 0 ? rest : { ...rest, scope: { kind: 'accounts', accountIds: kept } }
  }
  return parameters
}

export class ReportsViewSupport {
  constructor(
    private readonly service: ReportsServiceImpl,
    private readonly session: LedgerSession,
    private readonly accounts: AccountsService,
    private readonly today: () => string,
    /** The Reports page's *Open reports on*. */
    private readonly openOn: () => ReportsSettings['openOn'] = () => 'both'
  ) {}

  /**
   * Whether a saved report, as the view shows it, differs from what was saved: its parameters, its options, the chart
   * or table, the rows folded. As the view opened it is the same, whatever the saved report left out.
   */
  async differs(savedId: string, args: RunArgs): Promise<boolean> {
    const r = await this.service.resolve({ savedId })
    const saved = (await this.service.saved()).find(s => s.id === savedId)
    if (!saved) return false
    const show = saved.view?.show ?? defaultShow(r.spec, this.openOn())
    const collapsed = [...saved.view?.collapsed ?? []].sort()
    return stable(r.parameters) !== stable(args.parameters) || stable(r.options) !== stable(args.options ?? {})
      || (args.view?.show !== undefined && args.view.show !== show)
      || (args.view?.collapsed !== undefined && stable([...args.view.collapsed].sort()) !== stable(collapsed))
  }

  private async outside<T>(work: () => Promise<T>): Promise<T> {
    try { return await work() } catch (err) { throw translate(err) }
  }

  /**
   * A report opened for the view: NOT_FOUND, NO_SOURCE as a run would say. `carried`: the *Accounts* chosen last, in any
   * report; `last`: what the user last chose for this one, when it isn't saved (choices it no longer takes are left out).
   */
  async open(ref: ReportRef, carried?: ScopeValue, last?: LastChoices): Promise<OpenedView> {
    const ledger = this.session.current
    if (!ledger) throw new ReportsError('NO_LEDGER', 'No ledger is open.')
    let r = await this.service.resolve(ref)
    const [tree, all] = await Promise.all([this.outside(() => this.session.tree()), this.outside(() => this.accounts.list())])
    const subLedgerIds = new Set(tree.subLedgers.map(s => s.id))
    if ('definitionId' in ref && last) {
      // The last parameters, if they still hold, less accounts and sub-ledgers gone since; and the last options, which
      // resolve checks (a value the definition no longer offers falls back to its default)
      const fits = parameterProblems(last.parameters, r.source, true).length === 0
      const parameters = fits ? stillThere(last.parameters, subLedgerIds, new Set(all.map(a => a.id))) : {}
      r = await this.service.resolve(ref, parameters, last.options ?? {})
    }
    const allowed = r.source.scopes === 'none' ? [] : r.source.scopes ?? ALL_KINDS
    const parameters = structuredClone(r.parameters)
    // A saved report keeps its own accounts; a definition takes those chosen last
    if ('definitionId' in ref && r.source.scopes !== 'none') {
      const scope = carryScope(carried, parameters.scope, allowed, subLedgerIds)
      if (scope) parameters.scope = scope
    }
    const offered = 'definitionId' in ref ? this.service.registry.offeredById(ref.definitionId) : undefined
    const saved = 'savedId' in ref ? (await this.service.saved()).find(s => s.id === ref.savedId) : undefined
    const basisLabel = saved?.basis.kind === 'definition'
      ? this.service.registry.offeredById(saved.basis.definitionId)?.definition.label ?? saved.basis.definitionId
      : 'A report of its own'
    const fieldLabel = (key: string) => r.source.fields.find((f): f is DimensionField => f.kind === 'dimension' && f.key === key)?.label ?? key
    const currencies = [...new Set(all.map(a => a.currency))]
      .sort((a, b) => all.filter(x => x.currency === b).length - all.filter(x => x.currency === a).length || a.localeCompare(b))
    const compareOptions = (r.spec.parameters.compareOptions ?? []).filter(o => o !== 'subLedgers' || tree.subLedgers.length > 0)
    const chosenView = saved?.view ?? ('definitionId' in ref ? last?.view : undefined)
    const emptyText = offered?.definition.emptyText ?? (saved?.basis.kind === 'definition' ? this.service.registry.offeredById(saved.basis.definitionId)?.definition.emptyText : undefined)
    return {
      ref: structuredClone(ref), title: r.title,
      description: offered?.definition.description ?? (saved ? `Made from ${basisLabel}.` : ''),
      source: {
        id: r.source.id, label: r.source.label, time: r.source.time, scopes: r.source.scopes === 'none' ? 'none' : [...allowed],
        currency: r.source.currency !== false, parameters: structuredClone(r.source.parameters ?? []), drillDown: r.source.drillDown === true
      },
      options: { ...r.options }, parameters, compareOptions,
      choose: (r.spec.parameters.choose ?? []).map(dimension => ({ dimension, label: fieldLabel(dimension) })),
      grain: r.spec.query.columns?.grain ?? 'month',
      show: chosenView?.show ?? defaultShow(r.spec, this.openOn()), hasChart: r.spec.presentation.chart !== undefined && r.spec.presentation.chart !== null,
      collapsed: [...chosenView?.collapsed ?? []],
      ...(emptyText && { emptyText }),
      notes: [...r.notes],
      choices: {
        ledgerName: tree.ledger.name,
        subLedgers: tree.subLedgers.map(s => ({ id: s.id, name: s.name, parentId: s.parentId, order: s.order })),
        accounts: all.map(a => ({ id: a.id, name: a.name, type: a.type, subLedgerId: a.subLedgerId, currency: a.currency, closed: a.closed })),
        currencies: currencies.length > 0 ? currencies : [mostUsedCurrency([], 'CAD')]
      },
      today: this.today(), yearStart: yearStartOf(tree.ledger), readOnly: ledger.readOnly
    }
  }
}
