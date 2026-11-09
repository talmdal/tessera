// shell/main/lifecycle/quit.ts
import { Logger } from '../../../core/ports'
import { AppLifecycle, ShutdownReason } from '../../../core/lifecycle/AppLifecycle'
import { shutdownApp } from '../../../core/lifecycle/shutdown'

/** The part of Electron's `app` this needs. */
export interface QuitTarget {
  on(event: 'before-quit', listener: (event: { preventDefault(): void }) => void): unknown
  quit(): void
}

export type QuitEvent = { preventDefault(): void }

/**
 * Something that reports the OS shutting down. It calls `listener` (with an
 * event whose `preventDefault` delays the OS shutdown, if the platform allows
 * it). See systemShutdown.ts for the real ones.
 */
export type SystemShutdownSource = (listener: (event?: QuitEvent) => void) => void

/** What the user chose when pass 1 gave reasons not to close yet. */
export type QuitChoice = 'retry' | 'quit' | 'cancel'

export interface QuitOptions {
  /** Shows pass 1's reasons (see quitPrompt.ts). Without it, a quit goes ahead whatever the reasons. */
  ask?(reasons: string[]): Promise<QuitChoice>
  /** Before pass 2: cancels every open plugin dialog, so code waiting on one can finish. */
  cancelDialogs?(): void
}

export interface QuitHandling {
  /**
   * For the last window's `close` event (Windows and Linux, where closing it quits): pass 1 runs before the window
   * goes, and the window stays when the user cancels. Once the quit is confirmed, the app quits, and the window closes
   * with the others.
   */
  closingLastWindow(event: QuitEvent): void
}

/**
 * Quitting, in two passes (docs/backup-restore-design.md, "Quitting while the ledger is busy"):
 *
 * 1. **"Can we close?"** For a user quit only, before anything shuts down and with no time limit: the lifecycle's
 *    WillQuit listeners may do work (the ledger backs up) and give reasons not to close yet. If they do, the user
 *    chooses: Retry (pass 1 again), Quit Anyway, or Cancel (the app keeps running, its windows open).
 * 2. **The shutdown:** open plugin dialogs are cancelled, then the ShuttingDown listeners (within their time limit),
 *    every plugin's deactivation, and the quit. Electron's quit is synchronous, so the first quit event is cancelled,
 *    the async work runs, and `app.quit()` is called again once it succeeds. If a listener vetoed, the app keeps
 *    running. If the shutdown itself throws, the app still quits.
 *
 * A normal quit (`before-quit`, or closing the last window) is a `'user'` quit. An OS shutdown, reported by any of
 * `systemShutdown`, is a `'system'` one: it skips pass 1 (nobody is there to answer, and it can't be refused), and
 * takes over from a pass 1 that is waiting on the user.
 */
export function installQuitHandling(
  app: QuitTarget,
  lifecycle: AppLifecycle,
  plugins: { deactivateAll(): Promise<void> },
  log: Logger,
  systemShutdown: readonly SystemShutdownSource[] = [],
  options: QuitOptions = {}
): QuitHandling {
  /** asking: pass 1 runs. confirmed: pass 1 said yes, from the last window; the quit it starts goes straight to pass 2. */
  let state: 'running' | 'asking' | 'confirmed' | 'shuttingDown' | 'done' = 'running'

  /** Pass 1, again for each Retry. Resolves whether to go ahead. */
  const confirm = async (): Promise<boolean> => {
    for (;;) {
      const reasons = await lifecycle.askToQuit()
      if (reasons.length === 0 || !options.ask) return true
      const choice = await options.ask(reasons)
      if (choice === 'quit') {
        log.info(`[lifecycle] Quitting anyway: ${reasons.join(' ')}`)
        return true
      }
      if (choice === 'cancel') return false
    }
  }

  /** Pass 2. */
  const shutDown = (reason: ShutdownReason) => {
    state = 'shuttingDown'
    try { options.cancelDialogs?.() } catch (err) { log.error('[lifecycle] Could not cancel the open dialogs', err) }
    shutdownApp(lifecycle, plugins, reason).then(
      completed => {
        state = completed ? 'done' : 'running'
        if (completed) app.quit()
      },
      err => {
        log.error('[lifecycle] Shutdown failed; quitting anyway', err)
        state = 'done'
        app.quit()
      }
    )
  }

  /** Runs pass 1, then `then(go)` unless an OS shutdown took over meanwhile. */
  const ask = (then: (go: boolean) => void) => {
    state = 'asking'
    confirm().then(
      go => { if (state === 'asking') then(go) },
      err => {
        log.error('[lifecycle] Asking whether to quit failed; quitting anyway', err)
        if (state === 'asking') then(true)
      }
    )
  }

  const userQuit = (event?: QuitEvent) => {
    if (state === 'done') return
    event?.preventDefault()
    if (state === 'confirmed') return shutDown('user')
    if (state !== 'running') return
    ask(go => { if (go) shutDown('user'); else state = 'running' })
  }

  for (const subscribe of systemShutdown) {
    subscribe(event => {
      log.info('[lifecycle] The system is shutting down')
      if (state === 'done') return
      event?.preventDefault()
      if (state === 'shuttingDown') return
      shutDown('system')
    })
  }
  app.on('before-quit', event => userQuit(event))

  return {
    closingLastWindow(event) {
      // The real quit closes the windows: let them go
      if (state === 'done' || state === 'shuttingDown' || state === 'confirmed') return
      event.preventDefault()
      if (state !== 'running') return
      ask(go => {
        if (!go) { state = 'running'; return }
        state = 'confirmed'
        app.quit()
      })
    }
  }
}
