// The three extension points: sources, groups and definitions, as plugins contribute them, in any order. Each is
// validated once (per contribution and source), so a malformed one is refused with one `[reports]` warning and never
// half-drawn; a definition whose source's plugin isn't running is listed as unavailable, saying which plugin it needs.
// See docs/reporting-design.md, "Adding a report from another plugin".
import type { Disposable, Event, ExtensionContribution, ExtensionRegistry, Logger, ServiceRegistry } from '@tessera/types'
import {
  REPORT_DEFINITIONS_POINT, REPORT_GROUPS_POINT, REPORT_SOURCES_POINT, definitionProblems, groupProblem, sourceProblem,
  type ReportDefinitionContribution, type ReportDefinitionInfo, type ReportGroupContribution, type ReportGroupInfo, type ReportSource,
  type ReportSourceContribution
} from '@tessera/reports-api'
import { Emitter } from './store'

/** Where a definition whose group isn't contributed is listed, rather than nowhere. */
export const FALLBACK_GROUP: ReportGroupInfo = { id: 'reports.group.other', label: 'Other Reports', order: 1000 }

/** A definition that passed validation, with what it needs. */
export interface Offered {
  definition: ReportDefinitionContribution
  contributor: string
  group: ReportGroupInfo
  source?: ReportSourceContribution
  /** The source's service, when its plugin provides it. */
  service?: ReportSource
  reason?: string
}

/** The plugin a contribution's id says it comes from: its id's first part. */
export const pluginOf = (id: string) => id.split('.')[0]

const POINTS = [REPORT_SOURCES_POINT, REPORT_GROUPS_POINT, REPORT_DEFINITIONS_POINT]

export class Registry {
  private readonly warned = new Set<string>()
  /** Validation, once per definition object and source object it was checked against. */
  private readonly checked = new WeakMap<object, { source?: object, ok: boolean }>()
  private readonly changes: Emitter<void>
  private readonly subscription: Disposable
  readonly onDidChange: Event<void>

  constructor(
    private readonly extensions: Pick<ExtensionRegistry, 'getContributions' | 'onDidChange'>,
    private readonly services: Pick<ServiceRegistry, 'has' | 'get'>,
    private readonly log: Pick<Logger, 'warn' | 'error'>
  ) {
    this.changes = new Emitter(log, 'catalog')
    this.onDidChange = this.changes.event
    this.subscription = extensions.onDidChange(({ point }) => { if (POINTS.includes(point)) this.changes.fire() })
  }

  dispose() {
    this.subscription.dispose()
  }

  private warn(problem: string) {
    if (this.warned.has(problem)) return
    this.warned.add(problem)
    this.log.warn(`[reports] ${problem}`)
  }

  /** The valid contributions to a point, the first of each id; the rest skipped with a warning. */
  private valid<T extends { id: string }>(point: string, problem: (c: ExtensionContribution) => string | undefined, what: string): { item: T, contributor: string }[] {
    const seen = new Set<string>()
    const out: { item: T, contributor: string }[] = []
    for (const c of this.extensions.getContributions(point)) {
      const found = problem(c)
      if (found) { this.warn(found); continue }
      const item = c.impl as T
      if (seen.has(item.id)) { this.warn(`Duplicate ${what} "${item.id}" ignored`); continue }
      seen.add(item.id)
      out.push({ item, contributor: c.contributor })
    }
    return out
  }

  sources(): ReportSourceContribution[] {
    return this.valid<ReportSourceContribution>(REPORT_SOURCES_POINT, c => sourceProblem(c.impl, c.contributor), 'report source').map(x => x.item)
  }

  source(id: string): ReportSourceContribution | undefined {
    return this.sources().find(s => s.id === id)
  }

  /** The service behind a source, or undefined when its plugin doesn't provide it (or it isn't one). */
  service(source: ReportSourceContribution): ReportSource | undefined {
    if (!this.services.has(source.service)) return undefined
    const service = this.services.get<ReportSource>(source.service)
    return typeof service?.query === 'function' && typeof service?.members === 'function' ? service : undefined
  }

  groups(): ReportGroupInfo[] {
    return this.valid<ReportGroupContribution>(REPORT_GROUPS_POINT, c => groupProblem(c.impl, c.contributor), 'report group')
      .map(({ item }) => ({ id: item.id, label: item.label, order: item.order ?? 0 }))
      .sort((a, b) => a.order - b.order || a.label.localeCompare(b.label))
  }

  /**
   * Every definition that can be offered, by group and order: valid against its source, each option too. One whose
   * source isn't contributed, or whose source's service isn't there, is kept, unavailable, with the reason.
   */
  offered(): Offered[] {
    const sources = new Map(this.sources().map(s => [s.id, s]))
    const groups = new Map(this.groups().map(g => [g.id, g]))
    const out: Offered[] = []
    for (const { item: definition, contributor } of this.valid<ReportDefinitionContribution>(REPORT_DEFINITIONS_POINT,
      c => typeof (c.impl as { id?: unknown } | null)?.id === 'string' && (c.impl as { id: string }).id.startsWith(`${c.contributor}.`)
        ? undefined : `A report definition contributed by "${c.contributor}" needs an id starting with "${c.contributor}."`, 'report definition')) {
      const sourceId = definition.spec?.source
      const source = typeof sourceId === 'string' ? sources.get(sourceId) : undefined
      const group = groups.get(definition.group) ?? FALLBACK_GROUP
      if (!source) {
        out.push({ definition, contributor, group, reason: `It needs the “${pluginOf(String(sourceId))}” plugin, which isn’t running.` })
        continue
      }
      if (!this.validates(definition, source, contributor)) continue
      const service = this.service(source)
      out.push({
        definition, contributor, group, source, ...(service && { service }),
        ...(!service && { reason: `It needs the “${pluginOf(source.service)}” plugin, which isn’t running.` })
      })
    }
    return out.sort((a, b) => a.group.order - b.group.order || a.group.label.localeCompare(b.group.label)
      || (a.definition.order ?? 0) - (b.definition.order ?? 0) || a.definition.label.localeCompare(b.definition.label))
  }

  private validates(definition: ReportDefinitionContribution, source: ReportSourceContribution, contributor: string): boolean {
    const cached = this.checked.get(definition)
    if (cached && cached.source === source) return cached.ok
    const problems = definitionProblems(definition, source, contributor)
    const [first] = problems
    if (first) {
      const id = typeof definition.id === 'string' ? definition.id : '?'
      this.warn(`Report "${id}": ${first.path ? `${first.path}: ` : ''}${first.message}${problems.length > 1 ? ` (and ${problems.length - 1} more)` : ''}`)
    }
    this.checked.set(definition, { source, ok: problems.length === 0 })
    return problems.length === 0
  }

  offeredById(id: string): Offered | undefined {
    return this.offered().find(o => o.definition.id === id)
  }

  /** The definitions, as other plugins and the views see them. */
  info(): ReportDefinitionInfo[] {
    return this.offered().map(o => ({
      id: o.definition.id, label: o.definition.label, description: o.definition.description,
      ...(o.definition.icon && { icon: o.definition.icon }), order: o.definition.order ?? 0,
      group: { ...o.group }, contributor: o.contributor, ...(o.definition.when && { when: o.definition.when }),
      available: o.reason === undefined, ...(o.reason && { reason: o.reason })
    }))
  }
}
