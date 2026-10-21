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
export type ShuttingDownListener = (event: ShutdownEvent) => void | Promise<void>
export type ShutDownListener = () => void | Promise<void>

/**
 * The application's lifecycle. Plugins see two of its four events:
 * `onStarted` (after every plugin has activated) and `onShuttingDown` (before
 * any plugin deactivates; may be async and may veto a user-initiated quit).
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

  /** Runs, in registration order, when the app is asked to quit. */
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