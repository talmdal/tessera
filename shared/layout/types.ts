// shared/layout/types.ts — slot ids, channel names and defaults for the layout controller.
import { channelFor } from '@tessera/types'
import type { Border, LayoutState } from '@tessera/types'
import { SHELL_CONTRIBUTOR_ID } from '../plugins/manifest'
import { BOTTOM_SLOT, LEFT_SLOT, MAIN_SLOT, RIGHT_SLOT, TOP_SLOT } from '../views/types'

const shell = (event: string) => channelFor(SHELL_CONTRIBUTOR_ID, event)

/** In reading order, which is also the order F6 cycles the regions in. */
export const BAR_SIDES: readonly Border[] = ['top', 'left', 'right', 'bottom']

export const SLOT_FOR_SIDE: Record<Border, string> = {
  top: TOP_SLOT,
  bottom: BOTTOM_SLOT,
  left: LEFT_SLOT,
  right: RIGHT_SLOT
}

/** The bar a slot id names, or undefined for the main slot and unknown slots. */
export function sideOfSlot(slot: string): Border | undefined {
  return BAR_SIDES.find(side => SLOT_FOR_SIDE[side] === slot)
}

/** Default bar sizes in px (width for left and right, height for top and bottom). */
export const DEFAULT_BAR_SIZE: Record<Border, number> = { left: 260, right: 300, top: 120, bottom: 200 }
export const MIN_BAR_SIZE = 100

/** Width in px of a collapsed bar's rail. */
export const RAIL_SIZE = 40

/** Key of the primary window's layout in persisted state. */
export const PRIMARY_WINDOW_KEY = 'main'

// Requests (renderer → main); each acts on the sending window
export const LAYOUT_GET = shell('layout.get')                 // → LayoutState
export const LAYOUT_SLOT_SET = shell('layout.slot.set')       // LayoutSlotSet → LayoutState
export const LAYOUT_RESET = shell('layout.reset')             // → LayoutState
export const LAYOUT_REVEAL = shell('layout.reveal')           // LayoutReveal → LayoutState

// Push events (main → renderer); carry the window id, so other windows ignore them
export const LAYOUT_CHANGED = shell('layout.changed')         // LayoutState
export const LAYOUT_REVEALED = shell('layout.revealed')       // LayoutRevealed

// Bar items
export const BAR_ITEMS_EXTENSION_POINT = 'shell.bar.items'
export const BAR_ITEMS_LIST_CHANNEL = shell('bar.items.list') // → BarItemDescriptor[]
export const BAR_ITEMS_CHANGED = shell('bar.items.changed')   // no payload; re-request the list

/** Commands the shell registers for the layout. Each acts on the focused window. */
export const LAYOUT_COMMANDS = {
  toggle: {
    left: 'shell.layout.toggle.left',
    right: 'shell.layout.toggle.right',
    top: 'shell.layout.toggle.top',
    bottom: 'shell.layout.toggle.bottom'
  } satisfies Record<Border, string>,
  collapseAll: 'shell.layout.collapseAll',
  expandAll: 'shell.layout.expandAll',
  reset: 'shell.layout.reset',
  /** Argument: a view id. */
  reveal: 'shell.layout.reveal'
} as const

/** Context keys the shell sets for the layout, so `when` expressions can depend on it. */
export const layoutKey = {
  hasContent: (side: Border) => `shell.layout.${side}.hasContent`,
  collapsed: (side: Border) => `shell.layout.${side}.collapsed`,
  visible: (side: Border) => `shell.layout.${side}.visible`,
  activeView: (side: Border) => `shell.layout.${side}.activeView`,
  mainActiveView: 'shell.layout.main.activeView'
} as const

/** What the renderer shows before the snapshot arrives: every slot empty. */
export const EMPTY_LAYOUT: LayoutState = {
  windowId: -1,
  main: { views: [], items: [] },
  bars: {
    top: { views: [], items: [], collapsed: false, size: DEFAULT_BAR_SIZE.top },
    bottom: { views: [], items: [], collapsed: false, size: DEFAULT_BAR_SIZE.bottom },
    left: { views: [], items: [], collapsed: false, size: DEFAULT_BAR_SIZE.left },
    right: { views: [], items: [], collapsed: false, size: DEFAULT_BAR_SIZE.right }
  }
}

/** A bar has content when anything is present in it. Not stored, so there is one source of truth. */
export function barHasContent(bar: { views: readonly string[], items: readonly string[] }) {
  return bar.views.length + bar.items.length > 0
}

/** The largest a bar may be: half the window in its dimension. */
export function maxBarSize(side: Border, window: { width: number, height: number }) {
  return Math.max(MIN_BAR_SIZE, Math.floor((side === 'left' || side === 'right' ? window.width : window.height) / 2))
}
