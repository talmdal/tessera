// What the report view shows, and what the Reports tab lists: the catalog (the groups, the reports offered, the
// ledger's saved reports) and the report a command asked for. Menu clicks pass no arguments, so commands act on what
// the view last said it shows; that is published as context keys, so menu items grey out to match, and the catalog as
// the `catalog.changed` event, sent only when it changed. *Accounts* is remembered per ledger, so it carries from one
// report to the next (docs/reporting-design.md, "The Reports tab and the report view"); and what the user last chose
// for each report they didn't save (its period, options, chart or table), per ledger, so it opens as they left it
// ("Customising and saving reports", R4).
import type { CommandRegistry, PluginContext } from '@tessera/types'
import { isLedgerError, type LedgerSession } from '@tessera/ledger-api'
import {
  REPORTS_CONTEXT_KEYS as K, REPORTS_EVENTS, REPORTS_PLUGIN_ID, isReportsError, showCommandOf,
  type OptionValues, type ReportParameters, type ReportRef, type ReportsCatalog, type RunArgs, type SavedReport, type ScopeValue, type ViewChoices
} from '@tessera/reports-api'
import type { ReportsServiceImpl } from './ReportsServiceImpl'

/** `events.emit` adds the plugin's prefix itself. */
export const local = (event: string) => event.slice(`${REPORTS_PLUGIN_ID}:`.length)

/** Key in `context.state`: `{ [ledger id, or path]: ScopeValue }`, the *Accounts* chosen last in each ledger. */
export const SCOPE_KEY = 'scope'

/** How many ledgers' last *Accounts* are remembered: the most recently used, so the map can't grow for ever. */
export const SCOPE_KEPT = 50

/**
 * Key in `context.state`: `{ [ledger id, or path]: { [definition id]: LastChoices } }`, what the user last chose for each
 * report they showed without saving it, in the 50 ledgers used last (`LAST_KEPT`). (R4.)
 */
export const LAST_KEY = 'last'
export const LAST_KEPT = 50

/** What the user last chose for a report: its heading's parameters, its options, and what it showed. */
export interface LastChoices {
  parameters: ReportParameters
  options?: OptionValues
  view?: ViewChoices
}

/** The same value, whatever the order of its keys: for telling whether choices changed. */
export const stable = (value: unknown): string => JSON.stringify(value, (_key, v) =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v)

/** No ledger is open, or it closed while being read. */
const isNoLedger = (err: unknown) => (isReportsError(err) || isLedgerError(err)) && err.code === 'NO_LEDGER'

/** The id a reference names: a definition's or a saved report's. */
export const refId = (ref: ReportRef) => 'savedId' in ref ? ref.savedId : ref.definitionId

const sameRef = (a: ReportRef | undefined, b: ReportRef | undefined) =>
  a !== undefined && b !== undefined && ('savedId' in a ? 'savedId' in b && a.savedId === b.savedId : 'definitionId' in b && a.definitionId === b.definitionId)

export class ViewState {
  private shown: ReportsCatalog['shown'] = null
  private requests = 0
  /** What the view said it shows, with its parameters: what Refresh and the menu act on. */
  private current: RunArgs | undefined
  private ledgerKey: string | undefined
  private saved: SavedReport[] | undefined
  private remembered: ScopeValue | undefined
  /** The last choices for each report in this ledger. */
  private last: Record<string, LastChoices> = {}
  /** The saved report shown differs from what was saved (`reports.changed`). */
  private changed = false
  /** The revision of each saved report as it was shown, which Save Report saves over, or refuses to. */
  private readonly shownRevs = new Map<string, number>()
  private sent: string | undefined

  constructor(
    private readonly context: Pick<PluginContext, 'contextKeys' | 'events' | 'state' | 'logger'> & { commands: Pick<CommandRegistry, 'isEnabled'> },
    private readonly service: ReportsServiceImpl,
    private readonly session: LedgerSession,
    /** Whether a saved report shown as `args` differs from what was saved (`reports.changed`). */
    private readonly differs: (savedId: string, args: RunArgs) => Promise<boolean> = async () => false
  ) {}

  /** What the user last chose for a report in this ledger, when they showed it without saving it. */
  lastFor(definitionId: string): LastChoices | undefined {
    const last = this.last[definitionId]
    return last && structuredClone(last)
  }

  /** What the view shows now, as it last said. */
  get(): RunArgs | undefined {
    return this.current
  }

  /** The report shown, whether or not its view has said what it shows yet. */
  shownRef(): ReportRef | undefined {
    return this.shown?.ref && structuredClone(this.shown.ref)
  }

  /** The revision a saved report was at when it was shown: what Save Report expects to save over. */
  shownRev(savedId: string): number | undefined {
    return this.shownRevs.get(savedId)
  }

  /** After this window saved or renamed it: the revision it now expects. */
  savedAt(savedId: string, rev: number): void {
    if (this.shownRevs.has(savedId)) this.shownRevs.set(savedId, rev)
  }

  /** The *Accounts* chosen last in this ledger, to carry to the next report. */
  carried(): ScopeValue | undefined {
    return this.remembered
  }

  /** The catalog, as the Reports tab and the view follow it; null while no ledger is open. */
  async catalog(): Promise<ReportsCatalog | null> {
    const ledger = this.session.current
    if (!ledger) return null
    let saved: SavedReport[]
    try {
      saved = this.saved ??= await this.service.saved()
    } catch (err) {
      if (isNoLedger(err)) return null
      throw err
    }
    const definitions = this.service.definitions()
    const groups = this.service.groups().filter(g => definitions.some(d => d.group.id === g.id))
    for (const d of definitions) if (!groups.some(g => g.id === d.group.id)) groups.push({ ...d.group })
    return {
      groups: groups.map(g => ({ id: g.id, label: g.label })),
      definitions: definitions.map(d => ({
        id: d.id, label: d.label, description: d.description, ...(d.icon && { icon: d.icon }), group: d.group.id,
        enabled: d.available && this.context.commands.isEnabled(showCommandOf(d.id)), ...(d.reason && { reason: d.reason })
      })),
      saved: saved.map(s => {
        const definition = s.basis.kind === 'definition' ? definitions.find(d => d.id === (s.basis as { definitionId: string }).definitionId) : undefined
        const needs = s.basis.kind === 'definition' ? s.basis.definitionId.split('.')[0] : undefined
        const available = s.basis.kind === 'spec' || (definition?.available ?? false)
        return {
          id: s.id, name: s.name, basis: s.basis.kind === 'spec' ? 'A report of its own' : definition?.label ?? s.basis.definitionId,
          available, ...(!available && { reason: definition?.reason ?? `Needs the “${needs}” plugin.` })
        }
      }),
      readOnly: ledger.readOnly, archive: ledger.archive !== undefined, ledgerName: ledger.name, shown: this.shown,
      changed: this.changed && this.shown !== null && 'savedId' in this.shown.ref
    }
  }

  /**
   * A command asked for a report: the view shows it, with these parameters over what it would start with; and (Customise
   * Report…) with these option values, and showing the chart, the table or both.
   */
  async show(ref: ReportRef, parameters?: ReportParameters, options?: OptionValues, show?: ViewChoices['show']): Promise<void> {
    this.shown = {
      ref: structuredClone(ref), ...(parameters && { parameters: structuredClone(parameters) }), ...(options && { options: structuredClone(options) }),
      ...(show && { show }), request: ++this.requests
    }
    if (!sameRef(ref, this.current?.ref)) {
      // Another report: nothing of the last one's is changed in it until its view says what it shows
      this.current = undefined
      this.changed = false
      this.context.contextKeys.set(K.changed, false)
      if ('savedId' in ref) {
        const saved = (await this.service.saved().catch(() => [])).find(s => s.id === ref.savedId)
        if (saved) this.shownRevs.set(saved.id, saved.rev)
      }
    }
    this.publishKeys()
    await this.refresh()
  }

  /**
   * The view says what it shows. A report for one no longer shown is late, and ignored. Its *Accounts* carry to the next
   * report; a report not saved is remembered as it is, to open so next time; a saved one is told apart from what was saved.
   */
  async report(args: RunArgs): Promise<void> {
    if (!sameRef(args.ref, this.shown?.ref)) return
    this.current = structuredClone(args)
    this.publishKeys()
    const scope = args.parameters?.scope
    if (scope && JSON.stringify(scope) !== JSON.stringify(this.remembered)) {
      this.remembered = structuredClone(scope)
      await this.rememberScope(scope)
    }
    if ('definitionId' in args.ref) await this.rememberLast(args.ref.definitionId, args)
    await this.publishChanged()
  }

  /** `reports.changed`: the saved report shown differs from what was saved. */
  private async publishChanged() {
    const current = this.current
    const shown = this.shown
    let changed = false
    if (current && shown && 'savedId' in shown.ref) {
      try {
        changed = await this.differs(shown.ref.savedId, current)
      } catch (err) {
        if (!isNoLedger(err) && !(isReportsError(err) && err.code === 'NOT_FOUND')) this.context.logger.warn(`[reports] Could not compare the saved report: ${String((err as Error)?.message ?? err)}`)
      }
    }
    // Late: another report was shown meanwhile
    if (this.current !== current) return
    this.context.contextKeys.set(K.changed, changed)
    if (changed !== this.changed) {
      this.changed = changed
      await this.refresh()
    }
  }

  /**
   * After anything changed: another ledger starts with nothing shown and its own remembered *Accounts*; a saved report
   * shown that is gone is shown no more. Sends the catalog if it changed. `saved`: the saved reports may have changed.
   */
  async refresh(options: { saved?: boolean } = {}): Promise<void> {
    const ledger = this.session.current
    const key = ledger ? ledger.id ?? ledger.path : undefined
    if (key !== this.ledgerKey) {
      this.ledgerKey = key
      this.shown = null
      this.current = undefined
      this.saved = undefined
      this.remembered = key === undefined ? undefined : await this.rememberedScope(key)
      this.last = key === undefined ? {} : await this.rememberedLast(key)
      this.changed = false
      this.context.contextKeys.set(K.changed, false)
    }
    if (options.saved) this.saved = undefined
    const catalog = await this.catalog()
    if (this.shown && 'savedId' in this.shown.ref && catalog && !catalog.saved.some(s => s.id === (this.shown!.ref as { savedId: string }).savedId)) {
      this.shown = null
      this.current = undefined
      if (catalog) catalog.shown = null
    }
    this.context.contextKeys.set(K.hasSaved, catalog !== null && catalog.saved.length > 0)
    this.publishKeys()
    const text = JSON.stringify(catalog)
    if (text !== this.sent) {
      this.sent = text
      this.context.events.emit(local(REPORTS_EVENTS.catalog), catalog)
    }
  }

  private publishKeys() {
    const open = this.session.current !== undefined
    const ref = open ? this.shown?.ref : undefined
    this.context.contextKeys.set(K.shown, ref ? refId(ref) : undefined)
    this.context.contextKeys.set(K.shownSaved, ref !== undefined && 'savedId' in ref)
    if (!ref || !('savedId' in ref)) {
      this.changed = false
      this.context.contextKeys.set(K.changed, false)
    }
  }

  /** After a save: the saved report shown is as saved, or the catalog's copy of it changed. */
  async savedChanged(): Promise<void> {
    this.saved = undefined
    await this.publishChanged()
  }

  private async rememberedLast(ledgerKey: string): Promise<Record<string, LastChoices>> {
    try {
      const all = await this.context.state.get<Record<string, Record<string, LastChoices>>>(LAST_KEY)
      const mine = all?.[ledgerKey]
      return typeof mine === 'object' && mine !== null ? structuredClone(mine) : {}
    } catch (err) {
      this.context.logger.warn(`[reports] Could not read the choices made last: ${String((err as Error)?.message ?? err)}`)
      return {}
    }
  }

  /** Remembers what a report not saved shows now, in this ledger (not an archive file, which isn't the ledger). */
  private async rememberLast(definitionId: string, args: RunArgs) {
    const ledger = this.session.current
    if (!ledger || ledger.archive !== undefined) return
    const choices: LastChoices = {
      parameters: structuredClone(args.parameters), ...(args.options && { options: structuredClone(args.options) }),
      ...(args.view && { view: structuredClone(args.view) })
    }
    if (stable(choices) === stable(this.last[definitionId])) return
    this.last[definitionId] = choices
    try {
      // Most recently used last: delete and add again, then let the oldest go beyond LAST_KEPT
      const key = ledger.id ?? ledger.path
      const all = { ...(await this.context.state.get<Record<string, Record<string, LastChoices>>>(LAST_KEY)) }
      delete all[key]
      all[key] = structuredClone(this.last)
      const keys = Object.keys(all)
      for (const old of keys.slice(0, Math.max(0, keys.length - LAST_KEPT))) delete all[old]
      await this.context.state.set(LAST_KEY, all)
    } catch (err) {
      this.context.logger.warn(`[reports] Could not remember the choices made: ${String((err as Error)?.message ?? err)}`)
    }
  }

  private async rememberedScope(ledgerKey: string): Promise<ScopeValue | undefined> {
    try {
      const all = await this.context.state.get<Record<string, ScopeValue>>(SCOPE_KEY)
      const scope = all?.[ledgerKey]
      return typeof scope === 'object' && scope !== null ? scope : undefined
    } catch (err) {
      this.context.logger.warn(`[reports] Could not read the accounts chosen last: ${String((err as Error)?.message ?? err)}`)
      return undefined
    }
  }

  private async rememberScope(scope: ScopeValue) {
    // An archive file shares its ledger's id, and isn't that ledger: what is chosen in it isn't the ledger's to remember
    const ledger = this.session.current
    if (!ledger || ledger.archive !== undefined) return
    try {
      // Most recently used last: delete and add again, then let the oldest go beyond SCOPE_KEPT
      const key = ledger.id ?? ledger.path
      const all = { ...(await this.context.state.get<Record<string, ScopeValue>>(SCOPE_KEY)) }
      delete all[key]
      all[key] = scope
      const keys = Object.keys(all)
      for (const old of keys.slice(0, Math.max(0, keys.length - SCOPE_KEPT))) delete all[old]
      await this.context.state.set(SCOPE_KEY, all)
    } catch (err) {
      this.context.logger.warn(`[reports] Could not remember the accounts chosen: ${String((err as Error)?.message ?? err)}`)
    }
  }
}
