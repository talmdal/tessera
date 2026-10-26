// The window manager's plugin-facing contracts: the per-window layout state
// the main process owns and the renderer mirrors, the `shell.bar.items`
// extension point, the payloads of the `shell:layout.*` channels, and the
// persistence port. Channel names, slot ids and defaults are values and live
// in shared/layout/types.ts. See docs/window-manager-design.md.

// -----------------------------
// Layout state
// -----------------------------

export type BarSide = 'top' | 'bottom' | 'left' | 'right'

/**
 * A slot's present content, decided by the main process: the ids of the
 * contributions whose `when` holds and whose plugin is active, in order. The
 * renderer renders exactly this list, looking each id up in its catalogue.
 */
export interface SlotState {
  views: string[]
  /** Present bar-item ids. Always [] for the main slot. */
  items: string[]
  /** One of `views`; absent when `views` is empty. */
  activeView?: string
}

export interface BarState extends SlotState {
  /** The user's preference; kept while the bar is hidden. Persisted. */
  collapsed: boolean
  /** Width (left/right) or height (top/bottom) in px, used when expanded with views. Persisted. */
  size: number
}

/** One window's layout. Pushed as `shell:layout.changed`; other windows ignore it. */
export interface LayoutState {
  /** The window this state belongs to; -1 before the renderer learns its own. */
  windowId: number
  main: SlotState
  bars: Record<BarSide, BarState>
}

// -----------------------------
// The shell.bar.items extension point
// -----------------------------

export interface BarItemBase {
  id: string
  /** A bar slot ('shell.top', 'shell.bottom', 'shell.left', 'shell.right'); never the main slot. */
  slot: string
  /** "./file.svg" in the renderer folder, or a shell icon-set name. */
  icon?: string
  /** Which end of the strip the item sits at. Defaults to 'start'. */
  align?: 'start' | 'end'
  /** Lower sorts first within the slot and alignment. Defaults to 0. */
  order?: number
  /** Context-key expression; the item is absent while it evaluates to false. */
  when?: string
  tooltip?: string
}

/** A button. Enabled exactly when its command is enabled, like a menu item. */
export interface BarButtonItem extends BarItemBase {
  kind: 'button'
  /** Always the accessible name; visually dropped when `icon` is set and space is short. */
  label: string
  command: string
}

/** Text. `{key}` is replaced with the value of that context key ('' when unset). */
export interface BarTextItem extends BarItemBase {
  kind: 'text'
  text: string
  /** Optional: clicking the text runs it. */
  command?: string
}

export type BarItemContribution = BarButtonItem | BarTextItem

/** An item resolved by the main process, ready for the renderer to draw. */
export type BarItemDescriptor = BarItemContribution & {
  pluginId: string
  /** Whether the item's command is registered and currently enabled. Always true for plain text. */
  enabled: boolean
}

// -----------------------------
// Request and event payloads (channel names are in shared/layout/types.ts)
// -----------------------------

/** `shell:layout.slot.set`: a preference change for the sending window. */
export interface LayoutSlotSetRequest {
  slot: string
  /** Must be a present view of the slot. */
  activeView?: string
  /** Rejected for the main slot. */
  collapsed?: boolean
  /** Rejected for the main slot; clamped to the minimum bar size. */
  size?: number
}

/** `shell:layout.reveal`: make a view active in its slot, expanding its bar. */
export interface LayoutRevealRequest {
  viewId: string
}

/** `shell:layout.revealed`: pushed after a reveal so the renderer can focus the view. */
export interface LayoutRevealedEvent {
  windowId: number
  viewId: string
  slot: string
}

/** `shell:commands.execute`: run a command from the renderer. */
export interface CommandsExecuteRequest {
  id: string
  args?: unknown[]
}

// -----------------------------
// Persistence port
// -----------------------------

/** The persisted part of a window's layout. */
export interface LayoutPreferences {
  main?: { activeView?: string }
  bars?: Partial<Record<BarSide, { collapsed?: boolean, size?: number, activeView?: string }>>
}

/** Stores layout preferences under a stable window key ('main' for the primary window). */
export interface LayoutPersistence {
  load(windowKey: string): LayoutPreferences | undefined
  save(windowKey: string, preferences: LayoutPreferences): void
}
