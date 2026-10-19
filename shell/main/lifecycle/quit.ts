// shell/main/lifecycle/quit.ts
import { Logger } from '../../../core/ports'

/** The part of Electron's `app` this needs. */
export interface QuitTarget {
  on(event: 'before-quit', listener: (event: { preventDefault(): void }) => void): unknown
  quit(): void
}

/**
 * Runs `shutdown` before the app quits. Electron's quit is synchronous, so the
 * first `before-quit` is cancelled, the async shutdown runs, and `app.quit()`
 * is called again once it succeeds. If a listener vetoed, the app keeps
 * running. If the shutdown itself throws, the app still quits.
 */
export function installQuitHandling(app: QuitTarget, shutdown: () => Promise<boolean>, log: Logger) {
  let state: 'running' | 'shuttingDown' | 'done' = 'running'

  app.on('before-quit', event => {
    if (state === 'done') return

    event.preventDefault()
    if (state === 'shuttingDown') return
    state = 'shuttingDown'

    shutdown().then(
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
  })
}
