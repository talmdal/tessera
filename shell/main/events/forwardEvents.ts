// shell/main/events/forwardEvents.ts
import { EventHub } from '../../../core/ipc/EventHub'
import { Disposable, Logger } from '../../../core/ports'
import { EVENT_CHANNEL } from '../../../shared/ipc'

/** The part of an Electron BrowserWindow this needs. */
export interface WindowLike {
  isDestroyed(): boolean
  webContents: { send(channel: string, ...args: unknown[]): void }
}

/**
 * Delivers every event published on the hub to all open windows, over the one
 * push channel the preload listens on. Windows that are gone are skipped, and a
 * payload Electron can't clone is logged rather than thrown.
 */
export function forwardEventsToWindows(hub: EventHub, windows: () => WindowLike[], log: Logger): Disposable {
  return hub.subscribe(event => {
    for (const window of windows()) {
      if (window.isDestroyed()) continue
      try {
        window.webContents.send(EVENT_CHANNEL, event)
      } catch (err) {
        log.error(`[events] Could not send ${event.name} to a window`, err)
      }
    }
  })
}
