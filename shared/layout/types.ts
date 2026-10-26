// shared/layout/types.ts
//
// Values of the window manager: slot-side mapping, defaults, the
// `shell.bar.items` extension point name, and the IPC channel names. The
// interfaces (LayoutState, BarItemContribution, request and event payloads,
// LayoutPersistence) are in @tessera/types (tessera-types/layout.ts). See
// docs/window-manager-design.md.
import { BarSide, BarState, LayoutState, SlotState, channelFor } from '@tessera/types'
import { SHELL_CONTRIBUTOR_ID } from '../plugins/manifest'
import { BOTTOM_SLOT, LEFT_SLOT, RIGHT_SLOT, TOP_SLOT } from '../views/types'

const shell = (event: string) => channelFor(SHELL_CONTRIBUTOR_ID, event)

// -----------------------------
// Sides and slots
// -----------------------------

export const BAR_SIDES: readonly BarSide[] = ['top', 'bottom', 'left', 'right']

const SLOT_OF_SIDE: Record<BarSide, string> = {
  top: TOP_SLOT, bottom: BOTTOM_SLOT, left: LEFT_SLOT, right: RIGHT_SLOT
}

export function slotOfSide(side: BarSide): string {
  return SLOT_OF_SIDE[side]
}

/** The bar side a slot belongs to, or undefined for MAIN_SLOT and unknown slots. */
export function sideOfSlot(slot: string): BarSide | undefined {
  return BAR_SIDES.find(side => SLOT_OF_SIDE[side] === slot)
}

// -----------------------------
// Layout state helpers and defaults
// -----------------------------

/** A bar has content when it has at least one present view or item. */
export function barHasContent(bar: SlotState) {
  return bar.views.length + bar.items.length > 0
}

export const DEFAULT_BAR_SIZE: Record<BarSide, number> = { top: 120, bottom: 200, left: 260, right: 300 }
export const MIN_BAR_SIZE = 100
/** Width (or height) of a collapsed bar's rail. */
export const RAIL_SIZE = 40

export function emptyLayout(windowId = -1): LayoutState {
  const bar = (side: BarSide): BarState =>
    ({ views: [], items: [], collapsed: false, size: DEFAULT_BAR_SIZE[side] })
  return {
    windowId,
    main: { views: [], items: [] },
    bars: { top: bar('top'), bottom: bar('bottom'), left: bar('left'), right: bar('right') }
  }
}

// -----------------------------
// The shell.bar.items extension point
// -----------------------------

/** Extension point for things a bar shows directly, without a renderer remote. */
export const BAR_ITEMS_EXTENSION_POINT = 'shell.bar.items'

// -----------------------------
// IPC channels (payload types: LayoutSlotSetRequest etc. in @tessera/types)
// -----------------------------

// Requests (renderer → main). Layout requests act on the sending window.
export const LAYOUT_GET = shell('layout.get')               // → LayoutState
export const LAYOUT_SLOT_SET = shell('layout.slot.set')     // LayoutSlotSetRequest → LayoutState
export const LAYOUT_RESET = shell('layout.reset')           // → LayoutState
export const LAYOUT_REVEAL = shell('layout.reveal')         // LayoutRevealRequest → LayoutState
export const BAR_ITEMS_LIST = shell('bar.items.list')       // → BarItemDescriptor[]
export const COMMANDS_EXECUTE = shell('commands.execute')   // CommandsExecuteRequest → the command's result

// Push events (main → renderer). Per-window payloads carry the windowId;
// other windows ignore them.
export const LAYOUT_CHANGED = shell('layout.changed')       // → LayoutState
export const LAYOUT_REVEALED = shell('layout.revealed')     // → LayoutRevealedEvent
export const BAR_ITEMS_CHANGED = shell('bar.items.changed') // no payload; re-request BAR_ITEMS_LIST
