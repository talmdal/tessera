// The `accounts.register.annotations` extension point: marks other plugins put on register rows, with buttons that
// run their commands. Contributions are plain data naming a `RegisterAnnotator` service; this reads them, asks each
// annotator for an account's marks, and merges the answers into what the register draws. Whatever an annotator
// returns is checked here, and one that fails, is missing or is slow is left out, so a broken plugin can't break the
// register. See docs/import-manager-design.md, "The accounts.register.annotations extension point".
import type { Disposable, ExtensionRegistry, Logger, ServiceRegistry } from '@tessera/types'
import {
  ANNOTATE_TIMEOUT_MS, ANNOTATION_TONES, REGISTER_ANNOTATIONS_POINT,
  type AccountAnnotations, type AnnotationAction, type RegisterAnnotations, type RegisterAnnotationsContribution,
  type RegisterAnnotator, type ResolvedRowAnnotation, type RowAnnotation
} from '@tessera/accounts-api'

const text = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''

function problemWith(raw: unknown, contributor: string): string | undefined {
  if (typeof raw !== 'object' || raw === null) return `A register annotations contribution from "${contributor}" is not an object`
  const c = raw as Record<string, unknown>
  if (!text(c.id) || !c.id.startsWith(`${contributor}.`)) return `A register annotations contribution from "${contributor}" needs an id starting with "${contributor}."`
  if (!text(c.service)) return `Register annotations "${c.id}" needs a service`
  if (c.order !== undefined && (typeof c.order !== 'number' || !Number.isFinite(c.order))) return `Register annotations "${c.id}" has an invalid order`
}

/** An action as given, or undefined when it isn't one the register can draw and run. */
function cleanAction(raw: unknown): AnnotationAction | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const a = raw as Record<string, unknown>
  if (!text(a.id) || !text(a.label) || !text(a.command) || (a.placement !== 'button' && a.placement !== 'menu')) return undefined
  return {
    id: a.id, label: a.label, command: a.command, placement: a.placement, args: a.args,
    ...(text(a.icon) && { icon: a.icon }),
    ...(text(a.tooltip) && { tooltip: a.tooltip })
  }
}

const cleanActions = (raw: unknown): AnnotationAction[] =>
  Array.isArray(raw) ? raw.map(cleanAction).filter((a): a is AnnotationAction => a !== undefined) : []

/** A row as given, or undefined when it isn't one (or isn't for a transaction the register shows). */
function cleanRow(raw: unknown, shown: Set<string>): RowAnnotation | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const r = raw as Record<string, unknown>
  if (typeof r.transactionId !== 'string' || !shown.has(r.transactionId)) return undefined
  const detail = (typeof r.detail === 'object' && r.detail !== null ? r.detail : {}) as Record<string, unknown>
  const parts = Array.isArray(detail.parts)
    ? detail.parts.filter((p): p is { text: string, emphasis?: unknown } => typeof p === 'object' && p !== null && typeof (p as { text?: unknown }).text === 'string')
      .map(p => ({ text: p.text, ...(p.emphasis === true && { emphasis: true }) }))
    : []
  return {
    transactionId: r.transactionId,
    review: r.review === true,
    tone: (ANNOTATION_TONES as readonly unknown[]).includes(r.tone) ? r.tone as RowAnnotation['tone'] : 'info',
    detail: { parts, ...(text(detail.icon) && { icon: detail.icon }) },
    actions: cleanActions(r.actions)
  }
}

/** Rejects after `ms` unless `work` settles first; the timer never outlives it. */
function within<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} didn't answer within ${ms} ms`)), ms) })
  return Promise.race([work, late]).finally(() => clearTimeout(timer))
}

export class RegisterAnnotationsReader {
  private readonly warned = new Set<string>()
  private readonly subscriptions = new Map<string, { annotator: RegisterAnnotator, subscription: Disposable }>()

  constructor(
    private readonly extensions: Pick<ExtensionRegistry, 'getContributions'>,
    private readonly services: Pick<ServiceRegistry, 'has' | 'get'>,
    private readonly log: Pick<Logger, 'warn'>,
    /** Told which registers to reload when an annotator says its marks changed. */
    private readonly onChange: (accounts: string[]) => void,
    private readonly timeoutMs = ANNOTATE_TIMEOUT_MS
  ) {}

  private warn(problem: string) {
    if (this.warned.has(problem)) return
    this.warned.add(problem)
    this.log.warn(`[accounts] ${problem}`)
  }

  /** The valid contributions, by order then as contributed. Invalid ones are skipped with one warning each. */
  contributions(): RegisterAnnotationsContribution[] {
    const valid: { contribution: RegisterAnnotationsContribution, seq: number }[] = []
    const seen = new Set<string>()
    this.extensions.getContributions(REGISTER_ANNOTATIONS_POINT).forEach(({ contributor, impl }, seq) => {
      const id = (impl as { id?: unknown } | null)?.id
      const problem = problemWith(impl, contributor) ?? (seen.has(id as string) ? `Duplicate register annotations "${id}" ignored` : undefined)
      if (problem) { this.warn(problem); return }
      const contribution = impl as RegisterAnnotationsContribution
      seen.add(contribution.id)
      valid.push({ contribution, seq })
    })
    return valid.sort((a, b) => (a.contribution.order ?? 0) - (b.contribution.order ?? 0) || a.seq - b.seq).map(v => v.contribution)
  }

  /** The annotator behind a contribution, if its plugin provides it (and it looks like one). */
  private annotator(contribution: RegisterAnnotationsContribution): RegisterAnnotator | undefined {
    if (!this.services.has(contribution.service)) return undefined
    const annotator = this.services.get<RegisterAnnotator>(contribution.service)
    if (typeof annotator?.annotate !== 'function') {
      this.warn(`Register annotations "${contribution.id}": service "${contribution.service}" isn't a register annotator`)
      return undefined
    }
    return annotator
  }

  /**
   * Follows each annotator's changes. Services can come and go, and nothing announces them, so this runs whenever
   * there is reason to look (start-up, the point changing, a register loading): it subscribes to new annotators, and
   * drops subscriptions to ones that went or were replaced.
   */
  sync(): void {
    const current = new Map(this.contributions().map(c => [c.id, this.annotator(c)] as const))
    for (const [id, held] of this.subscriptions) {
      if (current.get(id) !== held.annotator) { held.subscription.dispose(); this.subscriptions.delete(id) }
    }
    for (const [id, annotator] of current) {
      if (!annotator || this.subscriptions.has(id) || typeof annotator.onDidChange !== 'function') continue
      const subscription = annotator.onDidChange(change => {
        const accounts = Array.isArray(change?.accounts) ? change.accounts.filter((a): a is string => typeof a === 'string') : []
        if (accounts.length > 0) this.onChange(accounts)
      })
      this.subscriptions.set(id, { annotator, subscription })
    }
  }

  /**
   * Every annotator's marks for an account, merged, in register order (`transactionIds`). Annotators are asked at once;
   * one that fails, is slow or isn't provided is logged and left out.
   */
  async load(accountId: string, transactionIds: string[]): Promise<RegisterAnnotations> {
    this.sync()
    const shown = new Set(transactionIds)
    const answers = await Promise.all(this.contributions().map(async contribution => {
      const annotator = this.annotator(contribution)
      if (!annotator) return undefined
      try {
        const answer = await within(Promise.resolve(annotator.annotate(accountId)), this.timeoutMs, `Register annotations "${contribution.id}"`)
        return { contribution, answer }
      } catch (err) {
        this.warn(`Register annotations "${contribution.id}" failed: ${(err as Error)?.message ?? String(err)}`)
        return undefined
      }
    }))
    return merge(answers.filter((a): a is { contribution: RegisterAnnotationsContribution, answer: AccountAnnotations } => a !== undefined), shown, transactionIds)
  }

  dispose(): void {
    for (const { subscription } of this.subscriptions.values()) subscription.dispose()
    this.subscriptions.clear()
  }
}

/**
 * Merges annotators' answers (already in order): per row, the first annotator gives the tone, the second line and up
 * to two buttons; every other action goes to the row's menu. A summary shows while its annotator has a row to review,
 * or says something is outstanding that isn't a row.
 */
export function merge(
  answers: { contribution: RegisterAnnotationsContribution, answer: AccountAnnotations }[], shown: Set<string>, order: string[]
): RegisterAnnotations {
  const rows = new Map<string, ResolvedRowAnnotation>()
  const summaries: RegisterAnnotations['summaries'] = []
  for (const { contribution, answer } of answers) {
    const mine = new Set<string>()
    let reviewing = false
    for (const raw of Array.isArray(answer?.rows) ? answer.rows : []) {
      const row = cleanRow(raw, shown)
      if (!row || mine.has(row.transactionId)) continue   // one row per transaction from each annotator
      mine.add(row.transactionId)
      reviewing ||= row.review
      const existing = rows.get(row.transactionId)
      if (existing) {
        existing.review ||= row.review
        existing.menu.push(...row.actions)
        continue
      }
      const buttons = row.actions.filter(a => a.placement === 'button')
      rows.set(row.transactionId, {
        transactionId: row.transactionId, review: row.review, tone: row.tone, detail: row.detail,
        buttons: buttons.slice(0, 2),
        menu: [...buttons.slice(2), ...row.actions.filter(a => a.placement === 'menu')]
      })
    }
    const summary = answer?.summary
    const outstanding = typeof summary?.outstanding === 'number' && summary.outstanding > 0
    if ((reviewing || outstanding) && summary && text(summary.message)) {
      summaries.push({ contributor: contribution.id, message: summary.message, actions: cleanActions(summary.actions) })
    }
  }
  return { rows: order.map(id => rows.get(id)).filter((r): r is ResolvedRowAnnotation => r !== undefined), summaries }
}
