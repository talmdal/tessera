// core/problems/ProblemLog.ts — the warnings and errors the framework and its plugins report, kept so the user
// can see them.
//
// Everything the shell and the plugins log goes through one `Logger`. Most of what matters to a user arrives
// there as a warning — a plugin skipped because a service it needs is missing, a view dropped over an unknown
// icon, a contribution that failed validation — and until now it reached only the terminal, so the app simply
// behaved as if a feature did not exist. The log keeps the recent ones, and says when they change.
import type { Logger } from '@tessera/types'
import { Emitter } from '../events'

export type ProblemLevel = 'warning' | 'error'

export interface Problem {
  /** Increasing; unique for the life of the process. */
  id: number
  /** ISO timestamp. */
  time: string
  level: ProblemLevel
  /** Who reported it: the `[prefix]` the message began with ('plugins', 'views', 'exchange'), else 'shell'. */
  source: string
  /** The message, without its prefix. */
  message: string
  /** The error's stack or text, when one came with it. */
  detail?: string
  /** How many times in a row this same problem was reported. A repeat bumps this rather than adding a line. */
  count: number
}

export interface ProblemSummary {
  total: number
  errors: number
  warnings: number
}

/** The most kept: enough to see a whole startup's worth of trouble, bounded so a noisy loop cannot grow it. */
export const PROBLEM_LIMIT = 200

/** How long changes are gathered before they are announced. Short enough to feel immediate. */
export const NOTIFY_DELAY_MS = 100

const PREFIX = /^\s*\[([^\]]+)\]\s*/

export function describeError(error: unknown): string | undefined {
  if (error === undefined) return undefined
  if (error instanceof Error) return error.stack ?? `${error.name}: ${error.message}`
  if (typeof error === 'string') return error
  try { return JSON.stringify(error) } catch { return String(error) }
}

export class ProblemLog {
  private readonly problems: Problem[] = []
  private readonly changed = new Emitter<ProblemSummary>()
  private nextId = 1
  private pending = false

  /** Fires once per burst of changes (not once per problem), with the new totals. */
  readonly onDidChange = this.changed.event

  constructor(
    private readonly options: { limit?: number, now?: () => string, defer?: (work: () => void) => void } = {}
  ) {}

  record(level: ProblemLevel, text: string, error?: unknown): Problem {
    const match = PREFIX.exec(text)
    const source = match?.[1] ?? 'shell'
    const message = match ? text.slice(match[0].length) : text
    const detail = describeError(error)

    const last = this.problems[this.problems.length - 1]
    if (last !== undefined && last.level === level && last.source === source && last.message === message && last.detail === detail) {
      last.count += 1
      last.time = this.now()
      this.notify()
      return last
    }

    const problem: Problem = {
      id: this.nextId++, time: this.now(), level, source, message, count: 1,
      ...(detail !== undefined && { detail })
    }
    this.problems.push(problem)
    const limit = this.options.limit ?? PROBLEM_LIMIT
    if (this.problems.length > limit) this.problems.splice(0, this.problems.length - limit)
    this.notify()
    return problem
  }

  /** Newest last, as they happened. */
  list(): Problem[] {
    return this.problems.map(problem => ({ ...problem }))
  }

  summary(): ProblemSummary {
    const errors = this.problems.filter(problem => problem.level === 'error').length
    return { total: this.problems.length, errors, warnings: this.problems.length - errors }
  }

  clear(): void {
    if (this.problems.length === 0) return
    this.problems.length = 0
    this.notify()
  }

  private now() {
    return this.options.now?.() ?? new Date().toISOString()
  }

  /**
   * Coalesced over a short delay, so a startup that logs thirty warnings announces once. The delay also bounds
   * a listener that itself logs (forwarding to a window that keeps failing, say): it can only feed back a few
   * times a second, and a repeat of the same problem bumps a count rather than adding a line.
   */
  private notify() {
    if (this.pending) return
    this.pending = true
    const defer = this.options.defer ?? ((work: () => void) => { setTimeout(work, NOTIFY_DELAY_MS) })
    defer(() => {
      this.pending = false
      this.changed.fire(this.summary())
    })
  }
}

/**
 * A logger that also records its warnings and errors. Everything still goes to `inner` — the terminal is where a
 * developer looks — and the log is where the user does.
 */
export function recordingLogger(inner: Logger, problems: ProblemLog): Logger {
  return {
    info: message => inner.info(message),
    warn: message => {
      inner.warn(message)
      problems.record('warning', message)
    },
    error: (message, error) => {
      if (error === undefined) inner.error(message)
      else inner.error(message, error)
      problems.record('error', message, error)
    }
  }
}

