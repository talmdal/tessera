// core/layout/LayoutService.ts
//
// The window manager's state: one LayoutState per attached window, owned by
// the main process. Which views and items are *present* (contributed, plugin
// active, `when` true) is computed here, once, so every window and the
// renderer always agree; collapsed flags, sizes and active tabs are per-window
// preferences. Platform-free: the shell feeds it contributions through a
// LayoutContentSource and persists preferences through LayoutPersistence.
// See docs/window-manager-design.md.
import {
  BarSide,
  BarState,
  ContextKeyService,
  Disposable,
  LayoutPersistence,
  LayoutPreferences,
  LayoutRevealedEvent,
  LayoutSlotSetRequest,
  LayoutState,
  Logger,
  SlotState
} from '@tessera/types'
import { WhenExpression, evaluateWhen, parseWhen } from '../../shared/context/when'
import {
  BAR_SIDES,
  DEFAULT_BAR_SIZE,
  MIN_BAR_SIZE,
  emptyLayout,
  sideOfSlot,
  slotOfSide
} from '../../shared/layout/types'
import { MAIN_SLOT } from '../../shared/views/types'
import { Emitter } from '../events'

/** A contribution as the layout needs it: identity, placement and visibility. */
export interface LayoutContentRef {
  id: string
  slot: string
  when?: string
}

/**
 * Where the service learns what has been contributed. The shell implements it
 * with resolveViews/resolveBarItems over the extension registry; both lists
 * are expected in display order.
 */
export interface LayoutContentSource {
  views(): readonly LayoutContentRef[]
  items(): readonly LayoutContentRef[]
  /** Fires when either list may have changed. */
  onDidChange(listener: () => void): Disposable
}

interface WindowEntry {
  key: string
  preferences: Required<InternalPrefs>
  /** Last state handed out, for change detection. */
  state: LayoutState
}

interface InternalPrefs {
  main: { activeView?: string }
  bars: Record<BarSide, { collapsed: boolean, size: number, activeView?: string }>
}

export class LayoutService implements Disposable {
  private readonly windows = new Map<number, WindowEntry>()
  private readonly whenCache = new Map<string, WhenExpression | null>()
  private readonly subscriptions: Disposable[] = []
  private readonly changed = new Emitter<LayoutState>()
  private readonly revealed = new Emitter<LayoutRevealedEvent>()

  /** Fires with a window's new state whenever anything in it changed. */
  readonly onDidChange = this.changed.event
  /** Fires after a reveal, once the state change (if any) has been announced. */
  readonly onDidReveal = this.revealed.event

  constructor(
    private readonly content: LayoutContentSource,
    private readonly contextKeys: ContextKeyService,
    private readonly options: { persistence?: LayoutPersistence, log?: Logger } = {}
  ) {
    this.subscriptions.push(
      content.onDidChange(() => this.refresh()),
      contextKeys.onDidChange(() => this.refresh())
    )
  }

  /** The attached windows' ids, in attachment order. */
  windowIds(): number[] {
    return [...this.windows.keys()]
  }

  has(windowId: number): boolean {
    return this.windows.has(windowId)
  }

  /**
   * Starts managing a window. `key` is the stable identity its preferences are
   * persisted under. Attaching an attached id replaces it (a reloaded window).
   */
  attachWindow(windowId: number, key: string): LayoutState {
    const entry: WindowEntry = {
      key,
      preferences: this.loadPreferences(key),
      state: emptyLayout(windowId)
    }
    this.windows.set(windowId, entry)
    entry.state = this.computeState(windowId, entry)
    return entry.state
  }

  /** Stops managing a window, saving its preferences. */
  detachWindow(windowId: number): void {
    const entry = this.windows.get(windowId)
    if (!entry) return
    this.savePreferences(entry)
    this.windows.delete(windowId)
  }

  get(windowId: number): LayoutState {
    return this.entry(windowId).state
  }

  /** The slot of a contributed view, present or not; undefined when unknown. */
  slotOf(viewId: string): string | undefined {
    return this.content.views().find(view => view.id === viewId)?.slot
  }

  /**
   * Applies a preference change: the active tab, a collapse or a resize.
   * Throws for an unknown slot, an absent view, or collapsed/size on the main
   * slot. `size` is clamped to MIN_BAR_SIZE. Returns the new state.
   */
  setSlot(windowId: number, request: LayoutSlotSetRequest): LayoutState {
    const entry = this.entry(windowId)
    const { slot, activeView, collapsed, size } = request
    const side = sideOfSlot(slot)

    if (slot !== MAIN_SLOT && side === undefined) throw new Error(`Unknown slot "${slot}"`)
    if (slot === MAIN_SLOT && (collapsed !== undefined || size !== undefined)) {
      throw new Error('The main slot cannot be collapsed or resized')
    }
    if (collapsed !== undefined && typeof collapsed !== 'boolean') throw new Error('collapsed must be a boolean')
    if (size !== undefined && (typeof size !== 'number' || !Number.isFinite(size))) throw new Error('size must be a number')
    if (activeView !== undefined) {
      const present = slot === MAIN_SLOT ? entry.state.main.views : entry.state.bars[side!].views
      if (!present.includes(activeView)) throw new Error(`View "${activeView}" is not present in slot "${slot}"`)
    }

    if (side === undefined) {
      if (activeView !== undefined) entry.preferences.main.activeView = activeView
    } else {
      const bar = entry.preferences.bars[side]
      if (activeView !== undefined) bar.activeView = activeView
      if (collapsed !== undefined) bar.collapsed = collapsed
      if (size !== undefined) bar.size = Math.max(MIN_BAR_SIZE, Math.round(size))
    }

    this.savePreferences(entry)
    return this.publish(windowId, entry)
  }

  /** Back to defaults: every bar expanded at its default size, first views active. */
  reset(windowId: number): LayoutState {
    const entry = this.entry(windowId)
    entry.preferences = defaultPreferences()
    this.savePreferences(entry)
    return this.publish(windowId, entry)
  }

  /**
   * Makes a view the active view of its slot, expanding its bar, and announces
   * it through onDidReveal so the renderer can focus it. Throws for a view
   * that is unknown or absent.
   */
  reveal(windowId: number, viewId: string): LayoutState {
    const entry = this.entry(windowId)
    const slot = this.slotOf(viewId)
    if (slot === undefined) throw new Error(`Unknown view "${viewId}"`)

    const side = sideOfSlot(slot)
    const present = side === undefined ? entry.state.main.views : entry.state.bars[side].views
    if (!present.includes(viewId)) throw new Error(`View "${viewId}" is not present (its when is false or its plugin is inactive)`)

    if (side === undefined) {
      entry.preferences.main.activeView = viewId
    } else {
      entry.preferences.bars[side].activeView = viewId
      entry.preferences.bars[side].collapsed = false
    }

    this.savePreferences(entry)
    const state = this.publish(windowId, entry)
    this.revealed.fire({ windowId, viewId, slot })
    return state
  }

  /** Recomputes presence for every window; announces the windows whose state changed. */
  refresh(): void {
    for (const windowId of this.windows.keys()) {
      this.publish(windowId, this.windows.get(windowId)!)
    }
  }

  dispose(): void {
    for (const subscription of this.subscriptions.splice(0)) subscription.dispose()
    this.windows.clear()
  }

  // -----------------------------

  private entry(windowId: number): WindowEntry {
    const entry = this.windows.get(windowId)
    if (!entry) throw new Error(`Unknown window ${windowId}`)
    return entry
  }

  private publish(windowId: number, entry: WindowEntry): LayoutState {
    const next = this.computeState(windowId, entry)
    if (JSON.stringify(next) !== JSON.stringify(entry.state)) {
      entry.state = next
      this.changed.fire(next)
    }
    return entry.state
  }

  private computeState(windowId: number, entry: WindowEntry): LayoutState {
    const views = this.presentBySlot(this.content.views())
    const items = this.presentBySlot(this.content.items())

    const slotState = (slot: string, activePreference: string | undefined): SlotState => {
      const present = views.get(slot) ?? []
      const active = activePreference !== undefined && present.includes(activePreference)
        ? activePreference
        : present[0]
      return {
        views: present,
        items: items.get(slot) ?? [],
        ...(active === undefined ? {} : { activeView: active })
      }
    }

    const bars = {} as Record<BarSide, BarState>
    for (const side of BAR_SIDES) {
      const preference = entry.preferences.bars[side]
      bars[side] = {
        ...slotState(slotOfSide(side), preference.activeView),
        collapsed: preference.collapsed,
        size: preference.size
      }
    }

    return { windowId, main: slotState(MAIN_SLOT, entry.preferences.main.activeView), bars }
  }

  /** Slot → present contribution ids, keeping the source's order. */
  private presentBySlot(refs: readonly LayoutContentRef[]): Map<string, string[]> {
    const bySlot = new Map<string, string[]>()
    for (const ref of refs) {
      if (!this.isPresent(ref)) continue
      let list = bySlot.get(ref.slot)
      if (!list) bySlot.set(ref.slot, list = [])
      list.push(ref.id)
    }
    return bySlot
  }

  private isPresent(ref: LayoutContentRef): boolean {
    if (ref.when === undefined) return true
    let expression = this.whenCache.get(ref.when)
    if (expression === undefined) {
      try {
        expression = parseWhen(ref.when)
      } catch (err) {
        this.options.log?.warn(`[layout] "${ref.id}" has an invalid when expression; hiding it`, err)
        expression = null
      }
      this.whenCache.set(ref.when, expression)
    }
    return expression === null ? false : evaluateWhen(expression, key => this.contextKeys.get(key))
  }

  private loadPreferences(key: string): Required<InternalPrefs> {
    const defaults = defaultPreferences()
    let stored: LayoutPreferences | undefined
    try {
      stored = this.options.persistence?.load(key)
    } catch (err) {
      this.options.log?.warn(`[layout] Could not load preferences for window "${key}"; using defaults`, err)
    }
    if (!stored) return defaults

    if (typeof stored.main?.activeView === 'string') defaults.main.activeView = stored.main.activeView
    for (const side of BAR_SIDES) {
      const bar = stored.bars?.[side]
      if (!bar) continue
      if (typeof bar.collapsed === 'boolean') defaults.bars[side].collapsed = bar.collapsed
      if (typeof bar.size === 'number' && Number.isFinite(bar.size)) {
        defaults.bars[side].size = Math.max(MIN_BAR_SIZE, Math.round(bar.size))
      }
      if (typeof bar.activeView === 'string') defaults.bars[side].activeView = bar.activeView
    }
    return defaults
  }

  private savePreferences(entry: WindowEntry): void {
    try {
      this.options.persistence?.save(entry.key, entry.preferences)
    } catch (err) {
      this.options.log?.warn(`[layout] Could not save preferences for window "${entry.key}"`, err)
    }
  }
}

function defaultPreferences(): Required<InternalPrefs> {
  const bars = {} as Required<InternalPrefs>['bars']
  for (const side of BAR_SIDES) bars[side] = { collapsed: false, size: DEFAULT_BAR_SIZE[side] }
  return { main: {}, bars }
}
