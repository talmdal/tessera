// core/lifecycle/AppLifecycle.ts
import { Disposable, Logger } from '../ports'

/** starting → started → shuttingDown → shutDown. A vetoed shutdown goes back to the previous phase. */
export type AppPhase = 'starting' | 'started' | 'shuttingDown' | 'shutDown'

export type ShutdownReason = 'user' | 'system'

export interface ShutdownEvent {
  readonly reason: ShutdownReason
  /**
   * Cancels the shutdown, e.g. the user chose "Cancel" on an unsaved-changes
   * prompt. Honoured only for a `'user'` shutdown; an OS-initiated shutdown
   * can't be refused, so the call is ignored (and logged).
   */
  veto(why?: string): void
}

export type StartedListener = () => void | Promise<void>
export type ShuttingDownListener = (event: ShutdownEvent) => void | Promise<void>
export type ShutDownListener = () => void | Promise<void>

export interface AppLifecycleOptions {
  log?: Logger
  /** Total time the shutdown listeners get before the shutdown carries on without them. Default 10 s. */
  shutdownTimeoutMs?: number
}

/**
 * The application's lifecycle. Plugins see two of its four events:
 * `onStarted` (after every plugin has activated) and `onShuttingDown` (before
 * any plugin deactivates; may be async and may veto a user-initiated quit).
 * Starting and ShutDown are for shell internals: no plugin code is running at
 * either point.
 *
 * A listener that throws is logged and the others still run.
 */
export class AppLifecycle {
  private current: AppPhase = 'starting'
  private started = new Set<StartedListener>()
  private shuttingDown = new Set<ShuttingDownListener>()
  private shutDown = new Set<ShutDownListener>()
  private pending?: Promise<boolean>
  private readonly log?: Logger
  private readonly timeoutMs: number

  constructor({ log, shutdownTimeoutMs = 10_000 }: AppLifecycleOptions = {}) {
    this.log = log
    this.timeoutMs = shutdownTimeoutMs
  }

  get phase(): AppPhase {
    return this.current
  }

  /**
   * Runs `listener` once every plugin has activated. If the app has already
   * started, it runs immediately, so a late subscriber can't miss the event.
   */
  onStarted(listener: StartedListener): Disposable {
    if (this.current === 'started') {
      void this.run('onStarted listener', listener)
      return { dispose() {} }
    }
    this.started.add(listener)
    return { dispose: () => { this.started.delete(listener) } }
  }

  /** Runs, in registration order, when the app is asked to quit. */
  onShuttingDown(listener: ShuttingDownListener): Disposable {
    this.shuttingDown.add(listener)
    return { dispose: () => { this.shuttingDown.delete(listener) } }
  }

  /** Shell-internal: runs after the last plugin has deactivated, for final flushes. */
  onShutDown(listener: ShutDownListener): Disposable {
    this.shutDown.add(listener)
    return { dispose: () => { this.shutDown.delete(listener) } }
  }

  /** Called by the shell once all plugins have activated. */
  async markStarted() {
    if (this.current !== 'starting') return
    this.current = 'started'

    const listeners = [...this.started]
    this.started.clear()
    await Promise.all(listeners.map(listener => this.run('onStarted listener', listener)))
  }

  /**
   * Runs the ShuttingDown listeners, one at a time. Resolves `false` if one
   * vetoed a user-initiated shutdown (the app stays running), otherwise `true`.
   * Concurrent calls share one run.
   */
  requestShutdown(reason: ShutdownReason = 'user'): Promise<boolean> {
    if (this.current === 'shutDown') return Promise.resolve(true)
    if (this.current === 'shuttingDown' && this.pending) return this.pending

    this.pending = this.runShuttingDown(reason)
    return this.pending
  }

  /** Called by the shell after every plugin has deactivated. */
  async markShutDown() {
    if (this.current === 'shutDown') return
    this.current = 'shutDown'

    for (const listener of [...this.shutDown]) await this.run('onShutDown listener', listener)
  }

  private async runShuttingDown(reason: ShutdownReason): Promise<boolean> {
    const previous = this.current
    this.current = 'shuttingDown'

    let vetoed: string | undefined
    let open = true
    const event: ShutdownEvent = {
      reason,
      veto: why => {
        if (!open) return
        if (reason === 'user') vetoed ??= why ?? 'vetoed'
        else this.log?.warn('[lifecycle] Ignoring a veto: a system shutdown cannot be refused')
      }
    }

    const work = (async () => {
      for (const listener of [...this.shuttingDown]) {
        await this.run('onShuttingDown listener', () => listener(event))
        if (vetoed !== undefined) return
      }
    })()

    const timedOut = await this.withTimeout(work)
    open = false
    if (timedOut) this.log?.warn(`[lifecycle] Shutdown listeners exceeded ${this.timeoutMs} ms; continuing without them`)

    if (vetoed !== undefined) {
      this.log?.info(`[lifecycle] Shutdown cancelled: ${vetoed}`)
      this.current = previous
      this.pending = undefined
      return false
    }
    return true
  }

  /** Resolves true if `work` didn't finish within the shutdown time limit. */
  private async withTimeout(work: Promise<void>): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(true), this.timeoutMs) })
    try {
      return await Promise.race([work.then(() => false), timeout])
    } finally {
      clearTimeout(timer)
    }
  }

  private async run(what: string, fn: () => void | Promise<void>) {
    try {
      await fn()
    } catch (err) {
      this.log?.error(`[lifecycle] ${what} failed`, err)
    }
  }
}
