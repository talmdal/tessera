// shell/main/layout/registerLayout.ts
//
// Wires the LayoutService to the rest of the shell: the layout IPC, the
// shell.layout.* commands and context keys, the View menu, and the push
// events. See docs/window-manager-design.md.
import {
  BarSide,
  CommandsExecuteRequest,
  Event,
  IpcMessage,
  LayoutRevealRequest,
  LayoutSlotSetRequest,
  LayoutState,
  Logger,
  PluginContext,
  PluginRuntime
} from '@tessera/types'
import { LayoutService } from '../../../core/layout/LayoutService'
import {
  BAR_ITEMS_CHANGED,
  BAR_ITEMS_LIST,
  BAR_SIDES,
  barHasContent,
  COMMANDS_EXECUTE,
  LAYOUT_CHANGED,
  LAYOUT_GET,
  LAYOUT_RESET,
  LAYOUT_REVEAL,
  LAYOUT_REVEALED,
  LAYOUT_SLOT_SET,
  slotOfSide
} from '../../../shared/layout/types'
import { MENUS_EXTENSION_POINT, MenuContribution, VIEW_MENU } from '../../../shared/menus/types'
import { LayoutContent } from './layoutContent'

export const LAYOUT_COMMANDS = {
  toggle: (side: BarSide) => `shell.layout.toggle.${side}`,
  collapseAll: 'shell.layout.collapseAll',
  expandAll: 'shell.layout.expandAll',
  reset: 'shell.layout.reset',
  reveal: 'shell.layout.reveal'
} as const

const TOGGLE_ACCELERATORS: Partial<Record<BarSide, string>> = {
  left: 'CmdOrCtrl+B',
  right: 'CmdOrCtrl+Alt+B',
  bottom: 'CmdOrCtrl+J'
}

const TOGGLE_LABELS: Record<BarSide, string> = {
  left: 'Toggle &Left Bar',
  right: 'Toggle &Right Bar',
  top: 'Toggle &Top Bar',
  bottom: 'Toggle &Bottom Bar'
}

export interface LayoutWindows {
  /** The focused window's id, if any. Commands act on it, else on the first attached window. */
  focusedId(): number | undefined
}

export interface LayoutRegistration {
  /** Attach a window under its stable persistence key, and publish its keys. */
  attachWindow(windowId: number, key: string): void
  detachWindow(windowId: number): void
  /** Rewrites the per-window shell.layout.* keys; call when window focus changes. */
  refreshContextKeys(): void
}

/**
 * `commandsDidChange` is the command registry's change event (fires on
 * registration and on context-key changes); it drives re-publication of the
 * bar-item catalogue when an item's enabled flag actually flips.
 */
export function registerLayout(
  shell: PluginContext,
  runtime: PluginRuntime,
  service: LayoutService,
  content: LayoutContent,
  windows: LayoutWindows,
  commandsDidChange: Event<void>,
  log: Logger
): LayoutRegistration {
  const { events, contextKeys, commands } = runtime

  const targetWindow = () => {
    const id = windows.focusedId()
    if (id !== undefined && service.has(id)) return id
    return service.windowIds()[0]
  }

  /** The window whose state the (application-wide) context keys and menus reflect. */
  const referenceState = (): LayoutState | undefined => {
    const id = targetWindow()
    return id === undefined ? undefined : service.get(id)
  }

  const refreshContextKeys = () => {
    const state = referenceState()
    for (const side of BAR_SIDES) {
      const bar = state?.bars[side]
      const hasContent = bar === undefined ? false : barHasContent(bar)
      contextKeys.set(`shell.layout.${side}.hasContent`, hasContent || undefined)
      contextKeys.set(`shell.layout.${side}.collapsed`, bar?.collapsed || undefined)
      contextKeys.set(`shell.layout.${side}.visible`, (hasContent && !bar?.collapsed) || undefined)
      contextKeys.set(`shell.layout.${side}.activeView`, bar?.activeView)
    }
    contextKeys.set('shell.layout.main.activeView', state?.main.activeView)
  }

  // ---- Push events ----------------------------------------------------------

  shell.subscriptions.push(
    service.onDidChange(state => {
      events.publish(LAYOUT_CHANGED, state)
      if (state.windowId === targetWindow()) refreshContextKeys()
    }),
    service.onDidReveal(revealed => events.publish(LAYOUT_REVEALED, revealed))
  )

  // The renderer's item catalogue changes when items are contributed or removed,
  // and when an item's command flips between enabled and disabled.
  let enabledFingerprint = ''
  const itemsFingerprint = () => JSON.stringify(content.listItems().map(item => [item.id, item.enabled]))
  shell.subscriptions.push(
    commandsDidChange(() => {
      const fingerprint = itemsFingerprint()
      if (fingerprint === enabledFingerprint) return
      enabledFingerprint = fingerprint
      events.publish(BAR_ITEMS_CHANGED)
    })
  )

  // ---- IPC ------------------------------------------------------------------

  const windowOf = (msg: IpcMessage<unknown>): number => {
    const windowId = msg.sender?.windowId
    if (windowId === undefined || !service.has(windowId)) {
      throw new Error('Layout requests must come from a managed window')
    }
    return windowId
  }

  shell.ipc.register(LAYOUT_GET, msg => service.get(windowOf(msg)))
  shell.ipc.register(LAYOUT_RESET, msg => service.reset(windowOf(msg)))
  shell.ipc.register<LayoutSlotSetRequest, LayoutState>(LAYOUT_SLOT_SET, msg => {
    if (typeof msg.data?.slot !== 'string') throw new Error('slot is required')
    return service.setSlot(windowOf(msg), msg.data)
  })
  shell.ipc.register<LayoutRevealRequest, LayoutState>(LAYOUT_REVEAL, msg => {
    if (typeof msg.data?.viewId !== 'string') throw new Error('viewId is required')
    return service.reveal(windowOf(msg), msg.data.viewId)
  })
  shell.ipc.register(BAR_ITEMS_LIST, () => {
    enabledFingerprint = itemsFingerprint()
    return content.listItems()
  })
  shell.ipc.register<CommandsExecuteRequest, unknown>(COMMANDS_EXECUTE, msg => {
    const { id, args } = msg.data ?? {}
    if (typeof id !== 'string' || id.length === 0) throw new Error('A command id is required')
    if (args !== undefined && !Array.isArray(args)) throw new Error('args must be an array')
    log.info(`[commands] Window ${msg.sender?.windowId ?? '?'} executed "${id}"`)
    return commands.execute(id, ...(args ?? []))
  })

  // ---- Commands -------------------------------------------------------------

  const withTarget = (run: (windowId: number) => void) => () => {
    const windowId = targetWindow()
    if (windowId === undefined) return
    run(windowId)
  }

  for (const side of BAR_SIDES) {
    shell.commands.register(LAYOUT_COMMANDS.toggle(side), withTarget(windowId => {
      const bar = service.get(windowId).bars[side]
      service.setSlot(windowId, { slot: slotOfSide(side), collapsed: !bar.collapsed })
    }), { enablement: `shell.layout.${side}.hasContent` })
  }

  const setAll = (collapsed: boolean) => withTarget(windowId => {
    for (const side of BAR_SIDES) {
      if (barHasContent(service.get(windowId).bars[side])) {
        service.setSlot(windowId, { slot: slotOfSide(side), collapsed })
      }
    }
  })
  shell.commands.register(LAYOUT_COMMANDS.collapseAll, setAll(true))
  shell.commands.register(LAYOUT_COMMANDS.expandAll, setAll(false))
  shell.commands.register(LAYOUT_COMMANDS.reset, withTarget(windowId => service.reset(windowId)))
  shell.commands.register(LAYOUT_COMMANDS.reveal, (viewId: unknown) => {
    const windowId = targetWindow()
    if (windowId === undefined || typeof viewId !== 'string') return
    try {
      service.reveal(windowId, viewId)
    } catch (err) {
      log.warn(`[layout] Could not reveal "${viewId}"`, err)
    }
  })

  // ---- The View menu --------------------------------------------------------

  const menu: MenuContribution[] = [
    { kind: 'menu', id: VIEW_MENU, label: '&View' },
    { kind: 'group', id: 'shell.layout.bars', parent: VIEW_MENU },
    ...BAR_SIDES.map((side): MenuContribution => ({
      kind: 'item',
      id: `shell.view.toggle.${side}`,
      label: TOGGLE_LABELS[side],
      parent: VIEW_MENU,
      group: 'shell.layout.bars',
      command: LAYOUT_COMMANDS.toggle(side),
      accelerator: TOGGLE_ACCELERATORS[side]
    })),
    { kind: 'group', id: 'shell.layout.all', parent: VIEW_MENU, order: 10 },
    { kind: 'item', id: 'shell.view.expandAll', label: '&Expand All Bars', parent: VIEW_MENU, group: 'shell.layout.all', command: LAYOUT_COMMANDS.expandAll },
    { kind: 'item', id: 'shell.view.collapseAll', label: '&Collapse All Bars', parent: VIEW_MENU, group: 'shell.layout.all', command: LAYOUT_COMMANDS.collapseAll },
    { kind: 'item', id: 'shell.view.resetLayout', label: 'Reset La&yout', parent: VIEW_MENU, group: 'shell.layout.all', command: LAYOUT_COMMANDS.reset }
  ]
  for (const contribution of menu) {
    shell.extensions.contribute(shell.pluginId, MENUS_EXTENSION_POINT, contribution.id, contribution)
  }

  refreshContextKeys()

  return {
    attachWindow: (windowId, key) => {
      service.attachWindow(windowId, key)
      refreshContextKeys()
    },
    detachWindow: windowId => {
      service.detachWindow(windowId)
      refreshContextKeys()
    },
    refreshContextKeys
  }
}
