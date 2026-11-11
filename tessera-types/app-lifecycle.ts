import { Disposable } from "."
/** starting → started → shuttingDown → shutDown. A vetoed shutdown returns to `started`. */
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
/**
 * Pass 1 of a user quit: a reason not to close yet ("“Importing statements” is still running."), or nothing. It may do
 * work first, with no time limit, while the windows are still open (the ledger backs up here).
 */
export type WillQuitListener = () => string | undefined | void | Promise<string | undefined | void>
export type ShuttingDownListener = (event: ShutdownEvent) => void | Promise<void>
export type ShutDownListener = () => void | Promise<void>

/**
 * The application's lifecycle. Plugins see three of its events:
 * `onStarted` (after every plugin has activated); `onWillQuit` (pass 1 of a
 * user quit: "can we close?", with no time limit); and `onShuttingDown`
 * (pass 2, before any plugin deactivates; may be async, shares a time limit,
 * and may veto a user-initiated quit).
 * Starting and ShutDown are for shell internals: no plugin code is running at
 * either point.
 *
 * A listener that throws is logged and the others still run.
 */
export interface AppLifecycle {
  get phase(): AppPhase

  /** Calls `listener` with the new phase each time it changes (including a vetoed shutdown returning to `started`). */
  onDidChangePhase(listener: (phase: AppPhase) => void): Disposable

  /**
   * Runs `listener` once every plugin has activated. If the app has already
   * started, it runs immediately, so a late subscriber can't miss the event.
   */
  onStarted(listener: StartedListener): void

  /**
   * Pass 1 of a user quit (File › Exit, closing the last window), before anything shuts down: each listener may do
   * work and may return a reason not to close yet. The user sees every reason, with Retry (pass 1 again), Quit Anyway
   * (on to pass 2) and Cancel. Listeners run one at a time, in **reverse** registration order, so a plugin runs before
   * the plugins it depends on (which activated, and registered, before it): it can still hand them its last writes.
   * No time limit. Not run for an OS shutdown. A listener that throws is logged and gives no reason.
   */
  onWillQuit(listener: WillQuitListener): Disposable

  /** Shell: runs pass 1, resolving every reason given (none: nothing stands in the way). Concurrent calls share one run. */
  askToQuit(): Promise<string[]>

  /** Pass 2: runs, in registration order, when the app is quitting (after pass 1, or for an OS shutdown). */
  onShuttingDown(listener: ShuttingDownListener): Disposable

  /** Shell-internal: runs after the last plugin has deactivated, for final flushes. */
  onShutDown(listener: ShutDownListener): Disposable

  /** Called by the shell once all plugins have activated. */
  markStarted(): void

  /**
   * Runs the ShuttingDown listeners, one at a time. Resolves `false` if one
   * vetoed a user-initiated shutdown (the app stays running), otherwise `true`.
   * Concurrent calls share one run.
   */
  requestShutdown(reason?: ShutdownReason): Promise<boolean>

  /** Called by the shell after every plugin has deactivated. */
  markShutDown():void
}