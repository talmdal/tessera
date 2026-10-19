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

/**
 * Runs the shutdown sequence before the app quits. Electron's quit is
 * synchronous, so the first quit event is cancelled, the async shutdown runs,
 * and `app.quit()` is called again once it succeeds. If a listener vetoed, the
 * app keeps running. If the shutdown itself throws, the app still quits.
 *
 * A normal quit (`before-quit`) is a `'user'` shutdown, which plugins may veto.
 * An OS shutdown, reported by any of `systemShutdown`, is a `'system'` one,
 * which they can't.
 */
export function installQuitHandling(
  app: QuitTarget,
  lifecycle: AppLifecycle,
  plugins: { deactivateAll(): Promise<void> },
  log: Logger,
  systemShutdown: readonly SystemShutdownSource[] = []
) {
  let state: 'running' | 'shuttingDown' | 'done' = 'running'

  const onQuit = (reason: ShutdownReason, event?: QuitEvent) => {
    if (state === 'done') return

    event?.preventDefault()
    if (state === 'shuttingDown') return
    state = 'shuttingDown'

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

  for (const subscribe of systemShutdown) {
    subscribe(event => {
      log.info('[lifecycle] The system is shutting down')
      onQuit('system', event)
    })
  }
  app.on('before-quit', event => onQuit('user', event))
}
