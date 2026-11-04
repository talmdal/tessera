// shell/main/window/windowReveal.ts
import type { Logger, PluginContext } from '@tessera/types'
import { WINDOW_READY } from '../../../shared/shellEvents'

/** The part of an Electron BrowserWindow this needs. */
export interface RevealableWindow {
  id: number
  isDestroyed(): boolean
  show(): void
  once(event: 'ready-to-show' | 'closed', listener: () => void): unknown
}

export interface WindowReveal {
  /**
   * Keeps a window hidden until both its page is ready to show and its renderer
   * has said its first frame is ready (theme applied, layout loaded), then calls
   * `show`, which defaults to `window.show()`. A window whose renderer never says
   * is shown after `timeoutMs`, so a broken page is visible rather than lost.
   */
  track(window: RevealableWindow, options?: { show?: () => void }): void
  /** The renderer of this window says its first frame is ready. Unknown and already shown windows are ignored. */
  rendererReady(windowId: number): void
}

interface Pending {
  pageReady: boolean
  rendererReady: boolean
  reveal(): void
  timer: ReturnType<typeof setTimeout>
}

export function createWindowReveal(log: Pick<Logger, 'warn'>, timeoutMs = 5_000): WindowReveal {
  const pending = new Map<number, Pending>()

  return {
    track(window, { show = () => window.show() } = {}) {
      const finish = (windowId: number) => {
        const entry = pending.get(windowId)
        if (!entry) return
        clearTimeout(entry.timer)
        pending.delete(windowId)
        if (!window.isDestroyed()) show()
      }

      const entry: Pending = {
        pageReady: false,
        rendererReady: false,
        reveal: () => { if (entry.pageReady && entry.rendererReady) finish(window.id) },
        timer: setTimeout(() => {
          if (!pending.has(window.id)) return
          log.warn(`[window] Window ${window.id} was not ready after ${timeoutMs} ms; showing it anyway`)
          finish(window.id)
        }, timeoutMs)
      }
      entry.timer.unref?.()
      pending.set(window.id, entry)

      window.once('ready-to-show', () => { entry.pageReady = true; entry.reveal() })
      window.once('closed', () => { clearTimeout(entry.timer); pending.delete(window.id) })
    },

    rendererReady(windowId) {
      const entry = pending.get(windowId)
      if (!entry) return
      entry.rendererReady = true
      entry.reveal()
    }
  }
}

/**
 * Handles the renderer's `shell:window.ready` request for the window it came from, telling each listener. A page
 * sends it each time it loads, so listeners also hear when a window's page has reloaded.
 */
export function registerWindowReady(shell: PluginContext, ...listeners: (WindowReveal | Pick<WindowReveal, 'rendererReady'>)[]) {
  shell.ipc.register(WINDOW_READY, msg => {
    const windowId = msg.sender?.windowId
    if (windowId === undefined) throw new Error(`Unknown window: ${windowId}`)
    for (const listener of listeners) listener.rendererReady(windowId)
  })
}
