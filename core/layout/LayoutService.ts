// core/layout/LayoutService.ts
import type {
  BorderItemInfo,
  Border,
  ContextKeyService,
  Disposable,
  ExtensionRegistry,
  LayoutPersistence,
  LayoutRevealed,
  LayoutSlotSet,
  LayoutState,
  Logger,
  PersistedLayout,
  SlotState
} from '@tessera/types'
import { WhenExpression, evaluateWhen, parseWhen } from '../../shared/context/when'
import { resolveBarItems } from '../../shared/layout/resolveBarItems'
import {
  BAR_ITEMS_EXTENSION_POINT,
  BAR_SIDES,
  DEFAULT_BAR_SIZE,
  MIN_BAR_SIZE,
  SLOT_FOR_SIDE,
  sideOfSlot
} from '../../shared/layout/types'
import { resolveViews } from '../../shared/views/resolveViews'
import { MAIN_SLOT, VIEWS_EXTENSION_POINT, ViewDescriptor } from '../../shared/views/types'
import { Emitter } from '../events'

/** What the user chose for one slot. Kept while the slot has no content, so it is there when content returns. */
interface SlotPrefs {
  activeView?: string
}

interface BarPrefs extends SlotPrefs {
  collapsed: boolean
  size: number
}

interface Prefs {
  main: SlotPrefs
  bars: Record<Border, BarPrefs>
}

interface WindowEntry extends Prefs {
  /** Stable key the window's preferences are saved under; windows without one are not saved. */
  key?: string
  /** The last state announced, to stay silent when nothing changed. */
  published: string
  /** The last preferences saved (or loaded), to skip writes that would change nothing. */
  saved: string
  saveTimer?: ReturnType<typeof setTimeout>
}

const defaultPrefs = (): Prefs => ({
  main: {},
  bars: Object.fromEntries(
    BAR_SIDES.map(side => [side, { collapsed: false, size: DEFAULT_BAR_SIZE[side] }])
  ) as Record<Border, BarPrefs>
})

const describe = (err: unknown) => err instanceof Error ? err.message : String(err)
const isString = (value: unknown): value is string => typeof value === 'string' && value.length > 0

/** What is kept of a window's preferences. Without `activeView` keys that are unset. */
function toPersisted(prefs: Prefs): PersistedLayout {
  const bars: PersistedLayout['bars'] = {}
  for (const side of BAR_SIDES) {
    const { collapsed, size, activeView } = prefs.bars[side]
    bars[side] = { collapsed, size, ...(activeView !== undefined && { activeView }) }
  }
  return { main: prefs.main.activeView !== undefined ? { activeView: prefs.main.activeView } : {}, bars }
}

/** Preferences from untrusted saved data: whatever is valid is used, the rest falls back to defaults. */
export function sanitizePrefs(raw: unknown): Prefs {
  const prefs = defaultPrefs()
  if (typeof raw !== 'object' || raw === null) return prefs

  const { main, bars } = raw as Record<string, any>
  if (isString(main?.activeView)) prefs.main.activeView = main.activeView

  for (const side of BAR_SIDES) {
    const saved = bars?.[side]
    if (typeof saved !== 'object' || saved === null) continue
    if (typeof saved.collapsed === 'boolean') prefs.bars[side].collapsed = saved.collapsed
    if (typeof saved.size === 'number' && Number.isFinite(saved.size)) prefs.bars[side].size = Math.max(MIN_BAR_SIZE, Math.round(saved.size))
    if (isString(saved.activeView)) prefs.bars[side].activeView = saved.activeView
  }
  return prefs
}

export interface LayoutResolvers {
  /** The renderer remote entry of a plugin, or undefined when it has no renderer. */
  remoteEntryFor(pluginId: string): string | undefined
  /** The URL of a file in a plugin's renderer folder, or undefined when it has no renderer. */
  iconUrlFor?(pluginId: string, relativePath: string): string | undefined
}

export interface LayoutOptions {
  /** Where preferences are kept. Without it they last for the session. */
  persistence?: LayoutPersistence
  log?: Logger
  /** How long to wait after a change before writing it, so a drag is one write. Default 500. */
  saveDelayMs?: number
}

/**
 * The layout controller: one `LayoutState` per attached window.
 *
 * Presence (which views and items are in which slot) comes from the
 * `shell.views` and `shell.bar.items` contributions and their `when`
 * expressions over context keys; preferences (collapsed, size, active view)
 * come from the user. The state a window sees is the two combined, and is only
 * ever changed here, so every observer agrees. Changes are published through
 * `onDidChange`, and only when a window's state actually differs.
 *
 * Preferences are saved per window key through the optional persistence port,
 * debounced, and written out on `detach` and `flush`.
 */
export class LayoutService {
  private readonly windows = new Map<number, WindowEntry>()
  private readonly changed = new Emitter<LayoutState>()
  private readonly revealed = new Emitter<LayoutRevealed>()
  private readonly subscriptions: Disposable[]
  private readonly whens = new Map<string, WhenExpression>()
  private readonly persistence?: LayoutPersistence
  private readonly log?: Logger
  private readonly saveDelayMs: number
  private writes: Promise<void> = Promise.resolve()

  /** Every valid view and item, present or not. */
  private catalogue: { views: ViewDescriptor[], items: BorderItemInfo[] } = { views: [], items: [] }
  /** The part of the catalogue whose `when` currently holds. */
  private views: ViewDescriptor[] = []
  private items: BorderItemInfo[] = []

  /** Fires with a window's new state whenever it changes. */
  readonly onDidChange = this.changed.event
  /** Fires after a view was revealed (made the active view of its slot), following the state change. */
  readonly onDidReveal = this.revealed.event

  constructor(
    private readonly extensions: ExtensionRegistry,
    private readonly contextKeys: ContextKeyService,
    private readonly resolvers: LayoutResolvers,
    options: LayoutOptions = {}
  ) {
    this.persistence = options.persistence
    this.log = options.log
    this.saveDelayMs = options.saveDelayMs ?? 500

    this.resolve()
    this.subscriptions = [
      extensions.onDidChange(({ point }) => {
        if (point === VIEWS_EXTENSION_POINT || point === BAR_ITEMS_EXTENSION_POINT) this.refresh()
      }),
      contextKeys.onDidChange(() => this.refilter())
    ]
  }

  dispose() {
    for (const subscription of this.subscriptions) subscription.dispose()
    for (const window of this.windows.values()) clearTimeout(window.saveTimer)
  }

  /**
   * Recomputes presence for every window and publishes what changed. Runs on
   * its own when contributions or context keys change; call it too once
   * something the resolvers depend on changes, such as every plugin having
   * activated.
   */
  refresh() {
    this.resolve()
    this.publishAll()
  }

  // -----------------------------
  // Windows
  // -----------------------------

  /**
   * Starts tracking a window and returns its first state. `initial` is saved
   * preferences to start from (invalid parts fall back to defaults). A window
   * with a `key` has its preferences saved under it.
   */
  attach(windowId: number, key?: string, initial?: PersistedLayout): LayoutState {
    if (this.windows.has(windowId)) throw new Error(`Window ${windowId} is already attached`)
    if (key !== undefined && this.windowIdOf(key) !== undefined) throw new Error(`Layout key "${key}" is already in use`)

    const prefs = initial ? sanitizePrefs(initial) : defaultPrefs()
    this.windows.set(windowId, { ...prefs, key, published: '', saved: JSON.stringify(toPersisted(prefs)) })
    return this.publish(windowId)
  }

  /**
   * Like `attach`, but starts from what was saved under `key`. A key with
   * nothing saved starts from the primary window's current preferences, if
   * there is a primary window, otherwise from the defaults.
   */
  async attachPersisted(windowId: number, key: string, primaryKey: string): Promise<LayoutState> {
    let initial = await this.load(key)
    if (!initial && key !== primaryKey) {
      const primary = this.windowIdOf(primaryKey)
      initial = primary !== undefined ? this.exportPrefs(primary) : await this.load(primaryKey)
    }
    return this.attach(windowId, key, initial)
  }

  /** Stops tracking a window, writing its preferences first if they changed. Resolves once written. */
  detach(windowId: number): Promise<void> {
    const written = this.save(windowId)       // reads the window's preferences before it is dropped
    this.windows.delete(windowId)
    return written
  }

  isAttached(windowId: number) {
    return this.windows.has(windowId)
  }

  /** The window attached under `key`, if any. */
  windowIdOf(key: string): number | undefined {
    for (const [windowId, window] of this.windows) if (window.key === key) return windowId
    return undefined
  }

  /** Ids of the attached windows, oldest first. */
  windowIds(): number[] {
    return [...this.windows.keys()]
  }

  /** What is saved of a window's preferences: the shape `attach` takes as `initial`. */
  exportPrefs(windowId: number): PersistedLayout {
    return toPersisted(this.entryOf(windowId))
  }

  /** Writes every window's unsaved preferences now. Resolves once they are written. */
  async flush(): Promise<void> {
    await Promise.all([...this.windows.keys()].map(windowId => this.save(windowId)))
  }

  get(windowId: number): LayoutState {
    return this.compute(windowId, this.entryOf(windowId))
  }

  /** True when anything is present in the bar, whichever window is asking: presence is the same everywhere. */
  hasContent(side: Border) {
    const slot = SLOT_FOR_SIDE[side]
    return this.views.some(view => view.slot === slot) || this.items.some(item => item.slot === slot)
  }

  // -----------------------------
  // Changing a window's layout
  // -----------------------------

  /**
   * Applies what the user chose in a slot. Rejects what makes no sense (an
   * unknown slot, a view that is not there, collapsing the main area) with an
   * error naming the problem, and leaves the state untouched.
   */
  setSlot(windowId: number, request: LayoutSlotSet): LayoutState {
    this.entryOf(windowId)
    const { slot, activeView, collapsed, size } = request ?? {}

    if (typeof slot !== 'string') throw new Error('A slot is required')
    if (activeView !== undefined && typeof activeView !== 'string') throw new Error('activeView must be a view id')
    if (collapsed !== undefined && typeof collapsed !== 'boolean') throw new Error('collapsed must be true or false')
    if (size !== undefined && (typeof size !== 'number' || !Number.isFinite(size))) throw new Error('size must be a number')

    const side = sideOfSlot(slot)
    if (slot !== MAIN_SLOT && !side) throw new Error(`Unknown slot: ${slot}`)
    if (!side && (collapsed !== undefined || size !== undefined)) {
      throw new Error(`The main area cannot be ${collapsed !== undefined ? 'collapsed' : 'resized'}`)
    }

    if (activeView !== undefined && !this.presentIn(slot).some(view => view.id === activeView)) {
      throw new Error(`View "${activeView}" is not present in ${slot}`)
    }

    return this.change(windowId, prefs => {
      if (!side) {
        if (activeView !== undefined) prefs.main.activeView = activeView
        return
      }
      const bar = prefs.bars[side]
      if (activeView !== undefined) bar.activeView = activeView
      if (collapsed !== undefined) bar.collapsed = collapsed
      if (size !== undefined) bar.size = Math.max(MIN_BAR_SIZE, Math.round(size))
    })
  }

  /** Collapses the bar if it is expanded and expands it if it is collapsed. */
  toggle(windowId: number, side: Border): LayoutState {
    return this.change(windowId, prefs => { prefs.bars[side].collapsed = !prefs.bars[side].collapsed })
  }

  /** Collapses or expands every bar that has content. */
  setAllCollapsed(windowId: number, collapsed: boolean): LayoutState {
    return this.change(windowId, prefs => {
      for (const side of BAR_SIDES) if (this.hasContent(side)) prefs.bars[side].collapsed = collapsed
    })
  }

  /** Default sizes, all bars expanded, the first view active everywhere. */
  reset(windowId: number): LayoutState {
    return this.change(windowId, prefs => Object.assign(prefs, defaultPrefs()))
  }

  /**
   * Makes a view the active view of its slot, expanding the bar if it is one,
   * then announces it through `onDidReveal` so the renderer can focus it.
   * Throws for a view that is not present.
   */
  reveal(windowId: number, viewId: string): LayoutState {
    this.entryOf(windowId)
    const view = this.views.find(v => v.id === viewId)
    if (!view) throw new Error(`View "${String(viewId)}" is not present`)

    const side = sideOfSlot(view.slot)
    const state = this.change(windowId, prefs => {
      if (!side) {
        prefs.main.activeView = view.id
      } else {
        prefs.bars[side].activeView = view.id
        prefs.bars[side].collapsed = false
      }
    })
    this.revealed.fire({ windowId, viewId: view.id, slot: view.slot })
    return state
  }

  // -----------------------------
  // Internals
  // -----------------------------

  private entryOf(windowId: number): WindowEntry {
    const entry = this.windows.get(windowId)
    if (!entry) throw new Error(`Unknown window: ${windowId}`)
    return entry
  }

  /** Re-reads the contributions, then filters them by `when`. */
  private resolve() {
    // Problems with contributions are reported by the list requests, which resolve the same set.
    const { remoteEntryFor, iconUrlFor } = this.resolvers
    this.catalogue = {
      views: resolveViews(this.extensions.getContributions(VIEWS_EXTENSION_POINT), remoteEntryFor, iconUrlFor).views,
      items: resolveBarItems(this.extensions.getContributions(BAR_ITEMS_EXTENSION_POINT), iconUrlFor).items
    }
    this.filter()
  }

  private filter() {
    const holds = (when?: string) => {
      if (when === undefined) return true
      let expression = this.whens.get(when)
      if (!expression) this.whens.set(when, expression = parseWhen(when))     // validated when resolved
      return evaluateWhen(expression, key => this.contextKeys.get(key))
    }
    this.views = this.catalogue.views.filter(view => holds(view.when))
    this.items = this.catalogue.items.filter(item => holds(item.when))
  }

  /** A context key changed: presence may have changed with it. */
  private refilter() {
    this.filter()
    this.publishAll()
  }

  private publishAll() {
    for (const windowId of this.windows.keys()) this.publish(windowId)
  }

  private presentIn(slot: string) {
    return this.views.filter(view => view.slot === slot)
  }

  private slotState(slot: string, prefs: SlotPrefs): SlotState {
    const views = this.presentIn(slot).map(view => view.id)
    const items = this.items.filter(item => item.slot === slot).map(item => item.id)
    // A preference for a view that is not there is kept but not shown: the first view takes its place.
    const activeView = views.find(id => id === prefs.activeView) ?? views[0]
    return { views, items, ...(activeView !== undefined && { activeView }) }
  }

  private compute(windowId: number, prefs: Prefs): LayoutState {
    const bars = {} as LayoutState['bars']
    for (const side of BAR_SIDES) {
      const { collapsed, size } = prefs.bars[side]
      bars[side] = { ...this.slotState(SLOT_FOR_SIDE[side], prefs.bars[side]), collapsed, size }
    }
    return { windowId, main: this.slotState(MAIN_SLOT, prefs.main), bars }
  }

  /** Changes a window's preferences, schedules them to be saved, and announces the new state. */
  private change(windowId: number, apply: (prefs: Prefs) => void): LayoutState {
    const entry = this.entryOf(windowId)
    apply(entry)
    this.scheduleSave(windowId)
    return this.publish(windowId)
  }

  /** Computes a window's state and announces it if it differs from the last one announced. */
  private publish(windowId: number): LayoutState {
    const entry = this.entryOf(windowId)
    const state = this.compute(windowId, entry)
    const serialised = JSON.stringify(state)
    if (serialised !== entry.published) {
      entry.published = serialised
      this.changed.fire(state)
    }
    return state
  }

  // -----------------------------
  // Persistence
  // -----------------------------

  private async load(key: string): Promise<PersistedLayout | undefined> {
    if (!this.persistence) return undefined
    try {
      return await this.persistence.load(key)
    } catch (err) {
      this.log?.warn(`[layout] Could not load the layout saved as "${key}"; using the defaults: ${describe(err)}`)
      return undefined
    }
  }

  private scheduleSave(windowId: number) {
    const entry = this.windows.get(windowId)
    if (!entry || !this.persistence || entry.key === undefined) return
    clearTimeout(entry.saveTimer)
    entry.saveTimer = setTimeout(() => { void this.save(windowId) }, this.saveDelayMs)
  }

  /** Writes a window's preferences if they differ from what was last saved. Writes never overlap. */
  private save(windowId: number): Promise<void> {
    const entry = this.windows.get(windowId)
    if (!entry) return this.writes
    clearTimeout(entry.saveTimer)
    entry.saveTimer = undefined

    const { key } = entry
    if (!this.persistence || key === undefined) return this.writes

    const layout = toPersisted(entry)
    const serialised = JSON.stringify(layout)
    if (serialised === entry.saved) return this.writes

    const write = async () => {
      try {
        await this.persistence!.save(key, layout)
        entry.saved = serialised
      } catch (err) {
        // The preference is lost for this session at worst; the next change tries again.
        this.log?.warn(`[layout] Could not save the layout of "${key}": ${describe(err)}`)
      }
    }
    return this.writes = this.writes.then(write)
  }
}
