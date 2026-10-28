/** The four bars around the main area. */
export const BORDERS = [ 'top', 'bottom', 'left', 'right' ] as const
export type Border = typeof BORDERS[number]

/** A slot's present content, decided by the layout controller in the main process. */
export interface SlotState {
  /** Ids of the present views, in order. */
  views: string[]
  /** Ids of the present bar items, in order. Always empty for the main area. */
  items: string[]
  /** One of `views`; absent when `views` is empty. */
  activeView?: string
}

export interface BorderState extends SlotState {
  /** The user's preference; kept while the bar is hidden. */
  collapsed: boolean
  /** Width (left, right) or height (top, bottom) in px, used when expanded and holding views. */
  size: number
}

/** One window's layout. A bar has content when `views.length + items.length > 0`. */
export interface LayoutState {
  /** The window this state belongs to; -1 before the snapshot has arrived. */
  windowId: number
  main: SlotState
  bars: Record<Border, BorderState>
}

/** Payload of `shell:layout.slot.set`. `collapsed` and `size` are rejected for the main slot. */
export interface LayoutSlotSet {
  slot: string
  activeView?: string
  collapsed?: boolean
  size?: number
}

/** Payload of `shell:layout.reveal`. */
export interface LayoutReveal {
  viewId: string
}

/** Push event `shell:layout.revealed`, sent after a view was revealed in a window. */
export interface LayoutRevealed {
  windowId: number
  viewId: string
  slot: string
}

// -----------------------------
// Bar items (`shell.bar.items`)
// -----------------------------

/** The slots a bar item can target; items never go in the main area. */
export const BORDER_ITEM_SLOT = [ 'shell.top', 'shell.bottom', 'shell.left', 'shell.right' ] as const
export type BorderItemSlot = typeof BORDER_ITEM_SLOT[number]

interface BorderItemBase {
  id: string
  slot: BorderItemSlot
  /** A shell icon name, or a file in the plugin's renderer folder starting with `./`. */
  icon?: string
  /** Default `'start'`. */
  align?: 'start' | 'end'
  /** Within the slot; lower first. Ties keep registration order. */
  order?: number
  /** Context-key expression; the item is absent while it is false. */
  when?: string
  tooltip?: string
}

/** A button. Enabled exactly when its command is enabled, like a menu item. */
export interface BorderButtonItem extends BorderItemBase {
  kind: 'button'
  /** Always the accessible name. */
  label: string
  command: string
}

/** Text. `{key}` is replaced with the value of that context key ('' when unset). */
export interface BorderTextItem extends BorderItemBase {
  kind: 'text'
  text: string
  /** Clicking the text runs this command. */
  command?: string
}

export type BorderItemContribution = BorderButtonItem | BorderTextItem

/** A valid item, with the contributing plugin and its icon resolved to a URL when it is a file. */
export type BorderItemInfo = BorderItemContribution & { pluginId: string }

/** What the renderer receives: the item, plus whether its command is enabled (true for plain text). */
export type BorderItemDescriptor = BorderItemInfo & { enabled: boolean }

// -----------------------------
// Persistence
// -----------------------------

export interface PersistedBar {
  collapsed?: boolean
  size?: number
  activeView?: string
}

/**
 * What is kept of a window's layout: preferences only, never which views or
 * items are present. Read back defensively, so every field is optional.
 */
export interface PersistedLayout {
  main?: { activeView?: string }
  bars?: Partial<Record<Border, PersistedBar>>
}

/** Where window layouts are kept, by stable window key (`main` for the primary window). */
export interface LayoutPersistence {
  load(key: string): Promise<PersistedLayout | undefined>
  save(key: string, layout: PersistedLayout): Promise<void>
}
