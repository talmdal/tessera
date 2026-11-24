// `reports.service`: the reports offered (the registry's), the open ledger's saved reports, and running either. Every
// rule about saved reports is enforced here, so whatever saves one (the dialogs, later the designer, another plugin)
// gets the same checks. Figures are never stored: each run is worked out from the sources.
// See docs/reporting-design.md, "Customising and saving reports" and "The contract".
import type { Database, Disposable, Event, ExtensionRegistry, Logger, ServiceRegistry, Transaction } from '@tessera/types'
import { nameKey, validateLedgerName, type LedgerSession, type SubLedgerParticipant } from '@tessera/ledger-api'
import type { AccountsService } from '@tessera/accounts-api'
import {
  REPORTS_PLUGIN_ID, REPORTS_SETTINGS_DEFAULTS, ReportsError, SAVED_NOTES_MAX_LENGTH, SOURCE_TIMEOUT_MS, TOP_OPTION, TOP_ROWS_MAX, applyOptions,
  applyTop, isReportsError, isTopValue, migrateSpec, optionValues, parameterProblems, specProblems,
  type ColumnDrill, type DrillResult, type Member, type RowDrill, type OpenedReport, type OptionValues, type ReportDefinitionInfo, type ReportGroupInfo, type ReportParameters, type ReportRef,
  type ReportResult, type ReportSource, type ReportSourceContribution, type ReportSpec, type ReportsChange, type ReportsService, type SavedBasis,
  type SavedReport, type SavedReportInput, type WriteOptions
} from '@tessera/reports-api'
import { pluginOf, Registry } from './registry'
import { drillRequest } from './drill'
import { mergeParameters, planRun, runReport, within } from './run'
import { Emitter, collectionsOf, invalid, optionalText, toSaved, translate, type Collections, type StoredSaved } from './store'

export interface ReportsServiceDeps {
  session: LedgerSession
  accounts: AccountsService
  extensions: Pick<ExtensionRegistry, 'getContributions' | 'onDidChange'>
  services: Pick<ServiceRegistry, 'has' | 'get'>
  log: Pick<Logger, 'warn' | 'error'>
  /** Today, 'YYYY-MM-DD'. */
  today: () => string
  /** Now, as an ISO timestamp: when reports are saved, and run. */
  now?: () => string
  /** A source's time limit (tests shorten it). */
  timeoutMs?: number
  /** The Reports page's *Rows before "Other"*: the top of an axis that takes it from the user. Default 25. (R4.) */
  topRows?: () => number
}

/** What a run resolves a reference to. */
export interface Resolved {
  title: string
  spec: ReportSpec
  source: ReportSourceContribution
  service: ReportSource
  options: OptionValues
  parameters: ReportParameters
  notes: string[]
  /**
   * The row axis's top left alone (R4): its number, the Reports page's for `'user'`, 'all' for none kept; undefined when
   * its rows keep no top. What *Show the top* starts from.
   */
  topDefault?: number | 'all'
}

const change = (partial: Partial<ReportsChange>): ReportsChange => ({ catalog: partial.catalog ?? false, figures: partial.figures ?? false, ...(partial.sources && { sources: partial.sources }) })

export class ReportsServiceImpl implements ReportsService {
  readonly registry: Registry
  private readonly changes: Emitter<ReportsChange>
  private readonly subscriptions: Disposable[] = []
  /** The sources' own change events, followed while their services are there. */
  private readonly following = new Map<ReportSource, Disposable>()
  /** Saved reports a sub-ledger delete moved, by the sub-ledger: announced once the delete is known to be committed. */
  private readonly moved = new Map<string, string[]>()
  readonly onDidChange: Event<ReportsChange>
  readonly subLedgerParticipant: SubLedgerParticipant

  constructor(private readonly deps: ReportsServiceDeps) {
    this.changes = new Emitter(deps.log)
    this.onDidChange = this.changes.event
    this.registry = new Registry(deps.extensions, deps.services, deps.log)
    this.subLedgerParticipant = this.participant()
    this.subscriptions.push(
      this.registry.onDidChange(() => { this.follow(); this.changes.fire(change({ catalog: true })) }),
      // Another ledger: other saved reports, other figures
      deps.session.onDidChange(() => this.changes.fire(change({ catalog: true, figures: true }))),
      // A new year start moves This year, quarters and year columns in every report
      deps.session.onDidChangeInfo(() => this.changes.fire(change({ figures: true }))),
      deps.session.onDidChangeTree(() => { void this.treeChanged() })
    )
    this.follow()
  }

  dispose() {
    for (const s of this.subscriptions.splice(0)) s.dispose()
    for (const s of this.following.values()) s.dispose()
    this.following.clear()
    this.registry.dispose()
  }

  /** Follows every source's service that is there, once each: its figures changed, so reports on it are stale. */
  private follow() {
    const wanted = new Map<ReportSource, string[]>()
    for (const source of this.registry.sources()) {
      const service = this.registry.service(source)
      if (service?.onDidChange) wanted.set(service, [...wanted.get(service) ?? [], source.id])
    }
    for (const [service, subscription] of this.following) {
      if (!wanted.has(service)) { subscription.dispose(); this.following.delete(service) }
    }
    for (const [service, ids] of wanted) {
      if (this.following.has(service)) continue
      this.following.set(service, service.onDidChange!(() => this.changes.fire(change({ figures: true, sources: ids }))))
    }
  }

  private get now() { return this.deps.now ?? (() => new Date().toISOString()) }

  private db(): Database {
    try { return this.deps.session.database(REPORTS_PLUGIN_ID) } catch (err) { throw translate(err) }
  }

  private c(tx?: Transaction): Collections {
    return collectionsOf(tx ?? this.db())
  }

  private async read<T>(work: (c: Collections) => Promise<T>): Promise<T> {
    try { return await work(this.c()) } catch (err) { throw translate(err) }
  }

  private async write<T>(work: (c: Collections) => Promise<T>): Promise<T> {
    let result: T
    try {
      if (this.deps.session.current?.readOnly) throw new ReportsError('READ_ONLY', 'This ledger is open read-only, so its saved reports can’t change.')
      result = await this.db().transaction(tx => work(this.c(tx)))
    } catch (err) { throw translate(err) }
    this.changes.fire(change({ catalog: true }))
    return result
  }

  // ---- What is offered

  definitions(): ReportDefinitionInfo[] {
    return this.registry.info()
  }

  groups(): ReportGroupInfo[] {
    return this.registry.groups()
  }

  async saved(): Promise<SavedReport[]> {
    return this.read(async c => (await c.saved.find()).map(toSaved).sort((a, b) => a.name.localeCompare(b.name)))
  }

  private async savedOf(id: string): Promise<SavedReport> {
    const doc = await this.read(c => typeof id === 'string' ? c.saved.get(id) : Promise.resolve(undefined))
    if (!doc) throw new ReportsError('NOT_FOUND', 'That saved report no longer exists.', 'savedId')
    return toSaved(doc)
  }

  /** A definition that can run now: NOT_FOUND when it isn't offered, NO_SOURCE when its source's plugin isn't running. */
  private runnable(definitionId: string) {
    const offered = this.registry.offeredById(definitionId)
    if (!offered) {
      throw new ReportsError('NOT_FOUND', `That report isn’t offered: it needs the “${pluginOf(String(definitionId))}” plugin, or it is no longer there.`, 'definitionId')
    }
    if (!offered.source || !offered.service) throw new ReportsError('NO_SOURCE', `That report can’t run now. ${offered.reason ?? ''}`.trim())
    return { ...offered, source: offered.source, service: offered.service }
  }

  /** A spec of one's own (the designer's): brought up to date, and checked against its source. */
  private runnableSpec(raw: unknown, path: string) {
    const spec = migrateSpec(raw)
    const source = this.registry.source(spec.source)
    if (!source) throw new ReportsError('NO_SOURCE', `This report needs the “${pluginOf(String(spec.source))}” plugin, which isn’t running.`, `${path}.source`)
    const problems = specProblems(spec, source, true)
    if (problems.length > 0) throw new ReportsError('INVALID', problems[0].message, `${path}.${problems[0].path}`)
    const service = this.registry.service(source)
    if (!service) throw new ReportsError('NO_SOURCE', `This report needs the “${pluginOf(source.service)}” plugin, which isn’t running.`)
    return { spec, source, service }
  }

  /** A reference resolved: the spec with its options applied, and the parameters filled in. For the views too. */
  async resolve(ref: ReportRef, parameters: ReportParameters = {}, options: OptionValues = {}): Promise<Resolved> {
    if (typeof ref !== 'object' || ref === null) throw new ReportsError('INVALID', 'Say which report to run.', 'ref')
    if ('definitionId' in ref) {
      const { definition, source, service } = this.runnable(ref.definitionId)
      const { values } = optionValues(definition.options, options)
      const { spec, topDefault } = this.topped(applyOptions(definition.spec, definition.options, values), values)
      return {
        title: definition.label, spec, source, service, options: values, parameters: mergeParameters(spec, source, parameters), notes: [],
        ...(topDefault !== undefined && { topDefault })
      }
    }
    if (!('savedId' in ref)) throw new ReportsError('INVALID', 'Say which report to run.', 'ref')
    this.db()
    const saved = await this.savedOf(ref.savedId)
    const notes: string[] = []
    let resolved: Omit<Resolved, 'parameters' | 'notes' | 'title'>
    if (saved.basis.kind === 'definition') {
      const { definition, source, service } = this.runnable(saved.basis.definitionId)
      // Options the definition no longer offers fall back to their defaults, and say so
      const { values, dropped } = optionValues(definition.options, { ...saved.basis.options, ...options })
      if (dropped.length > 0) notes.push(`${dropped.length === 1 ? 'A choice' : `${dropped.length} choices`} this report was saved with ${dropped.length === 1 ? 'is' : 'are'} no longer offered by “${definition.label}”, so ${dropped.length === 1 ? 'it shows its' : 'they show their'} default.`)
      resolved = { ...this.topped(applyOptions(definition.spec, definition.options, values), values), source, service, options: values }
    } else {
      // A spec of its own has no options, but can still be shown with another top
      const { values } = optionValues([], options)
      const runnable = this.runnableSpec(saved.basis.spec, 'basis.spec')
      resolved = { ...runnable, ...this.topped(runnable.spec, values), options: values }
    }
    const withSaved = { ...structuredClone(saved.parameters), ...structuredClone(parameters) }
    return { ...resolved, title: saved.name, parameters: mergeParameters(resolved.spec, resolved.source, withSaved), notes }
  }

  async open(ref: ReportRef): Promise<OpenedReport> {
    const { title, spec, options, parameters, notes } = await this.resolve(ref)
    return { title, spec, options, parameters, notes }
  }

  async run(ref: ReportRef, parameters?: ReportParameters, options?: OptionValues): Promise<ReportResult> {
    if (!this.deps.session.current) throw new ReportsError('NO_LEDGER', 'No ledger is open.')
    const r = await this.resolve(ref, parameters, options)
    return this.runResolved(r)
  }

  async runSpec(spec: ReportSpec, parameters: ReportParameters = {}, title = 'Report'): Promise<ReportResult> {
    if (!this.deps.session.current) throw new ReportsError('NO_LEDGER', 'No ledger is open.')
    const runnable = this.runnableSpec(spec, 'spec')
    const { spec: checked } = this.topped(runnable.spec, {})
    return this.runResolved({ title, spec: checked, source: runnable.source, service: runnable.service, options: {}, parameters: mergeParameters(checked, runnable.source, parameters), notes: [] })
  }

  /** The row axis's top settled (*Show the top*, or the Reports page's for 'user'), and what it would be left alone. */
  private topped(spec: ReportSpec, values: OptionValues): { spec: ReportSpec, topDefault?: number | 'all' } {
    const top = spec.query.rows?.top
    if (top === undefined) return { spec }
    const userTop = this.deps.topRows?.() ?? REPORTS_SETTINGS_DEFAULTS.topRows
    return { spec: applyTop(spec, values, userTop), topDefault: top === 'user' ? userTop : top }
  }

  private get runDeps() {
    return {
      session: this.deps.session, accounts: this.deps.accounts, log: this.deps.log, today: this.deps.today, now: this.now,
      ...(this.deps.timeoutMs !== undefined && { timeoutMs: this.deps.timeoutMs })
    }
  }

  private runResolved(r: Resolved): Promise<ReportResult> {
    return runReport(this.runDeps, { title: r.title, spec: r.spec, source: r.source, service: r.service, parameters: r.parameters, notes: r.notes })
  }

  // ---- For the plugin's own views (not in the contract)

  /** A picker's choices: a dimension's members, or a source parameter's, from the report's source. */
  async members(ref: ReportRef, request: { dimension?: string, parameter?: string, parameters?: ReportParameters }): Promise<Member[]> {
    if (!this.deps.session.current) throw new ReportsError('NO_LEDGER', 'No ledger is open.')
    const r = await this.resolve(ref, request.parameters)
    const dimension = typeof request.dimension === 'string' ? request.dimension : undefined
    const parameter = typeof request.parameter === 'string' ? request.parameter : undefined
    if (dimension !== undefined && !r.source.fields.some(f => f.kind === 'dimension' && f.key === dimension)) throw new ReportsError('INVALID', `“${r.source.label}” has no “${dimension}”.`, 'dimension')
    if (parameter !== undefined && !r.source.parameters?.some(p => p.key === parameter)) throw new ReportsError('INVALID', `“${r.source.label}” has no parameter “${parameter}”.`, 'parameter')
    const reply = await within(this.deps.timeoutMs ?? SOURCE_TIMEOUT_MS, r.source.label, r.service.members({
      sourceId: r.source.id, ...(dimension !== undefined && { dimension }), ...(parameter !== undefined && { parameter }),
      ...(r.parameters.scope && { scope: r.parameters.scope }), parameters: { ...r.parameters.source }
    }))
    if (!Array.isArray(reply)) throw new ReportsError('SOURCE_FAILED', `The choices from “${r.source.label}” couldn’t be used.`)
    return reply.filter(m => typeof m?.id === 'string' && typeof m.label === 'string')
  }

  /**
   * The transactions behind one figure of a report as run: the run's own plan (period, scope, currency, filters) and
   * the figure's row and column, asked of the source. NO_SOURCE when the source can't list them.
   */
  async transactions(ref: ReportRef, parameters: ReportParameters, options: OptionValues, row: RowDrill, column: ColumnDrill, currency?: string): Promise<DrillResult> {
    if (!this.deps.session.current) throw new ReportsError('NO_LEDGER', 'No ledger is open.')
    const r = await this.resolve(ref, parameters, options)
    if (!r.source.drillDown || !r.service.transactions) throw new ReportsError('NO_SOURCE', `“${r.source.label}” can’t list the transactions behind its figures.`)
    const plan = await planRun(this.runDeps, { spec: r.spec, source: r.source, parameters: r.parameters })
    const request = drillRequest(plan, r.spec, row, column, typeof currency === 'string' ? currency : undefined)
    try {
      return await within(this.deps.timeoutMs ?? SOURCE_TIMEOUT_MS, r.source.label, r.service.transactions(structuredClone(request)))
    } catch (err) {
      const known = translate(err)
      if (known !== err || isReportsError(err)) throw known
      this.deps.log.error(`[reports] Source "${r.source.id}" couldn't list transactions`, err)
      throw new ReportsError('SOURCE_FAILED', `The transactions from “${r.source.label}” couldn’t be listed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // ---- Saved reports

  /** A name, what the report shows, and its notes, checked. */
  private checkNaming(input: Pick<SavedReportInput, 'name' | 'view' | 'notes'>): Pick<StoredSaved, 'name' | 'nameKey' | 'view' | 'notes'> {
    const problem = typeof input.name === 'string' ? validateLedgerName(input.name) : 'Enter a name.'
    if (problem) throw invalid('name', problem)
    const name = input.name.trim()
    const view = input.view
    if (view !== undefined && (typeof view !== 'object' || view === null
      || (view.show !== undefined && !['chart', 'table', 'both'].includes(view.show))
      || (view.collapsed !== undefined && (!Array.isArray(view.collapsed) || !view.collapsed.every(id => typeof id === 'string') || view.collapsed.length > 5000)))) {
      throw invalid('view', 'What the report shows is malformed.')
    }
    const notes = optionalText(input.notes, 'notes', SAVED_NOTES_MAX_LENGTH)
    return { name, nameKey: nameKey(name), ...(view !== undefined && { view: structuredClone(view) }), ...(notes !== undefined && { notes }) }
  }

  /** Checks and normalises what a saved report holds. Throws INVALID, NOT_FOUND or NO_SOURCE naming the part at fault. */
  private checkInput(input: SavedReportInput): Omit<StoredSaved, 'createdAt' | 'updatedAt'> {
    if (typeof input !== 'object' || input === null) throw invalid('name', 'Enter the report’s name.')
    const naming = this.checkNaming(input)
    const b = input.basis as unknown
    if (typeof b !== 'object' || b === null) throw invalid('basis', 'Say what the report is made from.')
    let basis: SavedBasis
    let source: ReportSourceContribution
    if ((b as { kind?: unknown }).kind === 'definition') {
      const given = b as { definitionId?: unknown, options?: unknown }
      if (typeof given.definitionId !== 'string') throw invalid('basis.definitionId', 'Say which report this is.')
      const offered = this.registry.offeredById(given.definitionId)
      if (!offered || !offered.source) throw new ReportsError('NOT_FOUND', 'That report isn’t offered now, so it can’t be saved.', 'basis.definitionId')
      const options = given.options === undefined ? {} : given.options
      if (typeof options !== 'object' || options === null || Array.isArray(options)) throw invalid('basis.options', 'The report’s choices are malformed.')
      for (const [key, value] of Object.entries(options as OptionValues)) {
        if (key === TOP_OPTION) {
          if (!isTopValue(value)) throw invalid(`basis.options.${key}`, `Show the top 1 to ${TOP_ROWS_MAX} rows, or all of them.`)
          continue
        }
        const option = offered.definition.options?.find(o => o.key === key)
        const fits = option && (option.kind === 'boolean' ? typeof value === 'boolean' : option.choices?.some(c => c.value === value))
        if (!fits) throw invalid(`basis.options.${key}`, `“${offered.definition.label}” has no choice “${key}” of “${String(value)}”.`)
      }
      basis = { kind: 'definition', definitionId: offered.definition.id, definitionVersion: offered.definition.version, options: optionValues(offered.definition.options, options as OptionValues).values }
      source = offered.source
    } else if ((b as { kind?: unknown }).kind === 'spec') {
      const spec = migrateSpec((b as { spec?: unknown }).spec)
      const found = this.registry.source(spec.source)
      if (!found) throw new ReportsError('NO_SOURCE', `This report needs the “${pluginOf(String(spec.source))}” plugin, which isn’t running.`, 'basis.spec.source')
      const problems = specProblems(spec, found, true)
      if (problems.length > 0) throw invalid(`basis.spec.${problems[0].path}`, problems[0].message)
      basis = { kind: 'spec', spec }
      source = found
    } else throw invalid('basis', 'A saved report is made from a report, or a spec of its own.')
    const parameters = input.parameters ?? {}
    const problems = parameterProblems(parameters, source, true)
    if (problems.length > 0) throw invalid(problems[0].path, problems[0].message)
    return { ...naming, basis, parameters: structuredClone(parameters) }
  }

  private async checkNameFree(c: Collections, key: string, except?: string) {
    const clash = await c.saved.findOne({ nameKey: key })
    if (clash && clash.id !== except) throw new ReportsError('DUPLICATE_NAME', `There is already a saved report named “${clash.name}”.`, 'name')
  }

  async saveReport(input: SavedReportInput): Promise<SavedReport> {
    this.db()
    const fields = this.checkInput(input)
    return this.write(async c => {
      await this.checkNameFree(c, fields.nameKey)
      const now = this.now()
      return toSaved(await c.saved.insert({ ...fields, createdAt: now, updatedAt: now }))
    })
  }

  async updateReport(id: string, patch: Partial<SavedReportInput>, options: WriteOptions = {}): Promise<SavedReport> {
    const current = await this.savedOf(id)
    if (typeof patch !== 'object' || patch === null) throw invalid('name', 'Nothing to change.')
    const naming = {
      name: patch.name ?? current.name,
      ...('view' in patch ? (patch.view !== undefined && { view: patch.view }) : current.view !== undefined && { view: current.view }),
      ...('notes' in patch ? (patch.notes !== undefined && { notes: patch.notes }) : current.notes !== undefined && { notes: current.notes })
    }
    // Renaming, notes and what it shows keep the basis as it is: a report whose definition is gone can still be renamed
    const fields: Omit<StoredSaved, 'createdAt' | 'updatedAt'> = patch.basis === undefined && patch.parameters === undefined
      ? { ...this.checkNaming(naming), basis: current.basis, parameters: current.parameters }
      : this.checkInput({
          ...naming,
          basis: patch.basis ?? (current.basis.kind === 'definition'
            ? { kind: 'definition', definitionId: current.basis.definitionId, options: current.basis.options }
            : current.basis),
          parameters: patch.parameters ?? current.parameters
        })
    return this.write(async c => {
      const stored = await c.saved.get(id)
      if (!stored) throw new ReportsError('NOT_FOUND', 'That saved report no longer exists.', 'savedId')
      await this.checkNameFree(c, fields.nameKey, id)
      const next: StoredSaved = { ...fields, createdAt: stored.createdAt, updatedAt: this.now() }
      return toSaved(await c.saved.replace({ ...next, id }, options.expectedRev === undefined ? {} : { expectedRev: options.expectedRev }))
    })
  }

  async duplicateReport(id: string, name: string): Promise<SavedReport> {
    const current = await this.savedOf(id)
    const problem = typeof name === 'string' ? validateLedgerName(name) : 'Enter a name.'
    if (problem) throw invalid('name', problem)
    const { id: _id, rev: _rev, createdAt: _c, updatedAt: _u, ...rest } = current
    return this.write(async c => {
      const key = nameKey(name.trim())
      await this.checkNameFree(c, key)
      const now = this.now()
      return toSaved(await c.saved.insert({ ...structuredClone(rest), name: name.trim(), nameKey: key, createdAt: now, updatedAt: now }))
    })
  }

  async deleteReport(id: string): Promise<void> {
    await this.write(async c => {
      const stored = typeof id === 'string' ? await c.saved.get(id) : undefined
      if (!stored) throw new ReportsError('NOT_FOUND', 'That saved report no longer exists.', 'savedId')
      await c.saved.deleteOne({ id })
    })
  }

  // ---- Sub-ledgers

  /**
   * Deleting a sub-ledger moves what is in it to its parent; a saved report over it covers the parent from then on (the
   * whole ledger, for one directly beneath it), as a budget does. Inside the ledger's transaction, so all or nothing.
   */
  private participant(): SubLedgerParticipant {
    const over = (doc: StoredSaved, id: string) => {
      const scopes = [doc.parameters.scope, doc.basis.kind === 'spec' ? doc.basis.spec.parameters.scope : undefined]
      return scopes.some(s => s !== undefined && (s.kind === 'subLedger' || s.kind === 'types') && s.subLedgerId === id)
    }
    return {
      describe: async subLedgerId => {
        const count = (await this.c().saved.find()).filter(d => over(d, subLedgerId)).length
        return count === 0 ? undefined : `${count} saved report${count === 1 ? '' : 's'}`
      },
      reparent: async (tx, from, to) => {
        const c = collectionsOf(tx)
        const moved: string[] = []
        for (const doc of await c.saved.find()) {
          if (!over(doc, from)) continue
          const next = structuredClone(doc)
          next.parameters.scope = moveScope(next.parameters.scope, from, to)
          if (next.basis.kind === 'spec') next.basis.spec.parameters.scope = moveScope(next.basis.spec.parameters.scope, from, to)
          if (next.parameters.scope === undefined) delete next.parameters.scope
          await c.saved.replace({ ...next, updatedAt: this.now() })
          moved.push(doc.id)
        }
        if (moved.length > 0) this.moved.set(from, moved)
      }
    }
  }

  /** After a tree change: saved reports a committed delete moved are announced. (A delete rolled back leaves its sub-ledger.) */
  private async treeChanged(): Promise<void> {
    if (this.moved.size === 0) return
    const pending = [...this.moved]
    this.moved.clear()
    const tree = await this.deps.session.tree().catch(() => undefined)
    if (tree && pending.some(([from]) => !tree.subLedgers.some(s => s.id === from))) this.changes.fire(change({ catalog: true }))
  }
}

/** A scope over `from`, moved to its parent `to` (null: the ledger itself). */
function moveScope<T extends ReportParameters['scope']>(scope: T, from: string, to: string | null): T {
  if (scope === undefined) return scope
  if (scope.kind === 'subLedger' && scope.subLedgerId === from) return (to === null ? { kind: 'ledger' } : { kind: 'subLedger', subLedgerId: to }) as T
  if (scope.kind === 'types' && scope.subLedgerId === from) {
    const { subLedgerId: _old, ...rest } = scope
    return (to === null ? rest : { ...rest, subLedgerId: to }) as T
  }
  return scope
}
