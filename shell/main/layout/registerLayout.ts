// shell/main/layout/registerLayout.ts
import type { IpcMessage, LayoutReveal, LayoutSlotSet, LayoutState, PluginContext, PluginRuntime } from '@tessera/types'
import { LayoutService } from '../../../core/layout/LayoutService'
import {
  LAYOUT_CHANGED,
  LAYOUT_GET,
  LAYOUT_RESET,
  LAYOUT_REVEAL,
  LAYOUT_REVEALED,
  LAYOUT_SLOT_SET,
  PRIMARY_WINDOW_KEY
} from '../../../shared/layout/types'
import { MENUS_EXTENSION_POINT } from '../../../shared/menus/types'
import { registerBorderItemsIpc } from './borderItemsIpc'
import { createLayoutKeys } from './layoutKeys'
import { registerLayoutCommands } from './layoutCommands'
import { layoutMenus } from './layoutMenus'

/** What the Electron side tells the layout about its windows. */
export interface LayoutHost {
  /**
   * Starts tracking a window under its stable layout key (`main` for the
   * primary window), loading what was saved for it first. Resolves with its
   * first state, once it is safe to load the window's page.
   */
  attachWindow(windowId: number, key: string): Promise<LayoutState>
  /** Stops tracking a window, saving its layout. */
  detachWindow(windowId: number): Promise<void>
  /** Records that a window has focus: the layout commands and context keys follow it. */
  focus(windowId: number): void
}

/**
 * Connects the layout controller to the rest of the shell: answers the
 * renderer's layout requests for the window they came from, publishes each
 * window's state when it changes, registers the `shell.layout.*` commands, the
 * View menu and the layout's context keys, and saves layouts on shutdown.
 * `shell` is the shell's own plugin context, which owns the handlers.
 */
export function registerLayout(
  shell: PluginContext,
  runtime: PluginRuntime,
  layout: LayoutService,
  iconUrlFor: (pluginId: string, relativePath: string) => string | undefined
): LayoutHost {
  let focused: number | undefined

  /** The window layout commands act on: the focused one, else the primary window, else the oldest. */
  const targetOrUndefined = () => {
    if (focused !== undefined && layout.isAttached(focused)) return focused
    return layout.windowIdOf(PRIMARY_WINDOW_KEY) ?? layout.windowIds()[0]
  }
  const target = () => {
    const windowId = targetOrUndefined()
    if (windowId === undefined) throw new Error('There is no window')
    return windowId
  }

  /** The window a request came from, as identified by the main process. */
  const windowOf = (msg: IpcMessage) => {
    const windowId = msg.sender?.windowId
    if (windowId === undefined || !layout.isAttached(windowId)) throw new Error(`Unknown window: ${windowId}`)
    return windowId
  }

  shell.ipc.register(LAYOUT_GET, (msg: IpcMessage) => layout.get(windowOf(msg)))
  shell.ipc.register(LAYOUT_SLOT_SET, (msg: IpcMessage<LayoutSlotSet>) => layout.setSlot(windowOf(msg), msg.data))
  shell.ipc.register(LAYOUT_RESET, (msg: IpcMessage) => layout.reset(windowOf(msg)))
  shell.ipc.register(LAYOUT_REVEAL, (msg: IpcMessage<LayoutReveal>) => layout.reveal(windowOf(msg), msg.data?.viewId))

  registerLayoutCommands(shell, layout, target, runtime.logger)
  for (const contribution of layoutMenus) {
    shell.extensions.contribute(shell.pluginId, MENUS_EXTENSION_POINT, contribution.id, contribution)
  }
  registerBorderItemsIpc(shell, iconUrlFor, event => runtime.events.publish(event), runtime.logger)

  const syncKeys = createLayoutKeys(shell.contextKeys, layout, targetOrUndefined)
  syncKeys()

  shell.subscriptions.push(
    // Delivered to every window; each ignores a state that carries another window's id.
    layout.onDidChange(state => {
      runtime.events.publish(LAYOUT_CHANGED, state)
      syncKeys()
    }),
    layout.onDidReveal(revealed => runtime.events.publish(LAYOUT_REVEALED, revealed)),
    // Whether a bar has content is the same everywhere, so it follows contributions and keys even with no window.
    // The layout service listens to these first, so it is up to date when this runs.
    runtime.extensions.onDidChange(syncKeys),
    runtime.contextKeys.onDidChange(syncKeys),
    runtime.lifecycle.onShuttingDown(() => layout.flush())
  )

  return {
    async attachWindow(windowId, key) {
      const state = await layout.attachPersisted(windowId, key, PRIMARY_WINDOW_KEY)
      syncKeys()
      return state
    },
    async detachWindow(windowId) {
      if (focused === windowId) focused = undefined
      const written = layout.detach(windowId)
      syncKeys()
      await written
    },
    focus(windowId) {
      if (!layout.isAttached(windowId)) return
      focused = windowId
      syncKeys()
    }
  }
}
