// shell/main/window/windowState.ts
import type { AppState, Logger } from '@tessera/types'

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** A window's position and size when it is not maximized, and whether it is. */
export interface WindowState {
  /** Absent when the window has no remembered position, so the system places it. */
  x?: number
  y?: number
  width: number
  height: number
  maximized: boolean
}

/** The smallest a restored window may be, and how much of it must be on a screen to count as visible. */
export const MIN_WINDOW_SIZE = { width: 400, height: 300 }
const MIN_VISIBLE = { width: 100, height: 50 }

/** The `app.state` key a window's position and size are kept under. */
export const windowStateKey = (windowKey: string) => `shell.window.${windowKey}`

const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

/**
 * The state to open a window with: what was saved if it is usable, otherwise
 * `defaults`. Damaged values fall back individually, a size below the minimum
 * is raised to it, and a position that would leave the window off every screen
 * (a monitor that has since been unplugged) is dropped so the system places it.
 * `workAreas` are the usable areas of the connected screens.
 */
export function restoreWindowState(saved: unknown, defaults: { width: number, height: number }, workAreas: readonly Rect[]): WindowState {
  const raw = (typeof saved === 'object' && saved !== null ? saved : {}) as Record<string, unknown>

  const width = isNumber(raw.width) ? Math.max(MIN_WINDOW_SIZE.width, Math.round(raw.width)) : defaults.width
  const height = isNumber(raw.height) ? Math.max(MIN_WINDOW_SIZE.height, Math.round(raw.height)) : defaults.height
  const maximized = raw.maximized === true
  const state: WindowState = { width, height, maximized }

  if (isNumber(raw.x) && isNumber(raw.y)) {
    const at = { x: Math.round(raw.x), y: Math.round(raw.y), width, height }
    if (workAreas.some(area => overlaps(at, area))) {
      state.x = at.x
      state.y = at.y
    }
  }
  return state
}

/** True when enough of `window` is inside `area` for the user to see and grab it. */
function overlaps(window: Rect, area: Rect) {
  const w = Math.min(window.x + window.width, area.x + area.width) - Math.max(window.x, area.x)
  const h = Math.min(window.y + window.height, area.y + area.height) - Math.max(window.y, area.y)
  return w >= MIN_VISIBLE.width && h >= MIN_VISIBLE.height
}

/** The part of an Electron BrowserWindow this needs. */
export interface TrackedWindow {
  /** The bounds the window has right now, whatever its state. */
  getBounds(): Rect
  /** What Electron believes the window restores to. Not trusted while maximized: on Linux it answers with the maximized bounds. */
  getNormalBounds(): Rect
  isMaximized(): boolean
  isFullScreen?(): boolean
  isMinimized?(): boolean
  on(event: 'resize' | 'move' | 'maximize' | 'unmaximize' | 'close' | 'closed', listener: () => void): unknown
}

export interface WindowStateTracker {
  /** Saves now if anything changed since the last save. Resolves once written. */
  flush(): Promise<void>
}

/**
 * Saves a window's position, size and maximized flag as they change. Moving and
 * resizing fire continuously, so a save waits until they have been quiet for
 * `delayMs`; closing saves at once, while the window can still be asked where it
 * is. A save that fails is logged and the next change tries again.
 *
 * The restored size is the window's own last size while it was *not* maximized,
 * tracked here rather than asked of Electron: on Linux `getNormalBounds()` reports
 * the maximized bounds while the window is maximized, which saved the screen's size
 * as the size to restore to. A resize that merely fills the display's work area is
 * not taken as the restored size either, since that is the maximize itself arriving
 * before the flag has flipped — `workAreaOf` says what the work area is.
 */
export function trackWindowState(
  win: TrackedWindow,
  save: (state: WindowState) => Promise<void>,
  options: {
    delayMs?: number
    log?: Logger
    workAreaOf?: (bounds: Rect) => Rect | undefined
    /**
     * The state the window was opened with. Its size and position are the restored ones until the window is
     * seen in its normal state: a session that starts maximized and is closed without ever being restored
     * otherwise had only Electron's `getNormalBounds()` to go on, which on Linux is the maximized bounds — so
     * the screen's size was saved as the size to restore to.
     */
    initial?: WindowState
  } = {}
): WindowStateTracker {
  const { delayMs = 500, log, workAreaOf, initial } = options
  let timer: ReturnType<typeof setTimeout> | undefined
  let saved = ''
  let last: WindowState | undefined
  let normal: Rect | undefined =
    initial?.x !== undefined && initial.y !== undefined
      ? { x: initial.x, y: initial.y, width: initial.width, height: initial.height }
      : undefined
  let writes: Promise<void> = Promise.resolve()
  let closed = false

  /** Whether `bounds` are the display's whole work area, give or take a frame: a maximized window's, not a restored one's. */
  const fillsWorkArea = (bounds: Rect) => {
    const area = workAreaOf?.(bounds)
    if (area === undefined) return false
    const slack = 2
    return Math.abs(bounds.x - area.x) <= slack && Math.abs(bounds.y - area.y) <= slack &&
      bounds.width >= area.width - slack && bounds.height >= area.height - slack
  }

  /** Remembers the window's bounds as the ones to restore to, when it is in its normal state. */
  const capture = () => {
    if (closed) return
    try {
      if (win.isMaximized() || win.isFullScreen?.() === true || win.isMinimized?.() === true) return
      const bounds = win.getBounds()
      if (fillsWorkArea(bounds)) return
      normal = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }
    } catch {
      // the window was destroyed under us; keep what we last saw
    }
  }

  const read = (): WindowState | undefined => {
    if (closed) return last
    try {
      const maximized = win.isMaximized()
      // With nothing seen yet and no remembered position, a window that is not maximized can be asked; one
      // that is cannot — so it keeps the size it was opened with, and lets the system place it next time.
      if (normal === undefined && maximized && initial !== undefined) {
        return last = { width: initial.width, height: initial.height, maximized }
      }
      const { x, y, width, height } = normal ?? win.getNormalBounds()
      return last = { x, y, width, height, maximized }
    } catch {
      return last      // the window was destroyed under us; keep what we last saw
    }
  }

  const flush = () => {
    clearTimeout(timer)
    timer = undefined
    const state = read()
    if (!state) return writes
    const serialised = JSON.stringify(state)
    if (serialised === saved) return writes

    return writes = writes.then(async () => {
      try {
        await save(state)
        saved = serialised
      } catch (err) {
        log?.warn(`[window] Could not save the window position and size: ${err instanceof Error ? err.message : String(err)}`)
      }
    })
  }

  const schedule = () => {
    clearTimeout(timer)
    timer = setTimeout(() => { void flush() }, delayMs)
  }

  for (const event of ['resize', 'move'] as const) win.on(event, () => { capture(); schedule() })
  for (const event of ['maximize', 'unmaximize'] as const) win.on(event, schedule)
  win.on('close', () => { void flush() })
  win.on('closed', () => { closed = true; clearTimeout(timer) })

  return { flush }
}

/** Keeps window states in the `app-state` plugin, one entry per window key. `appState` is looked up on every use. */
export function createWindowStateStore(appState: () => AppState | undefined) {
  return {
    load: async (windowKey: string): Promise<unknown> => appState()?.get<unknown>(windowStateKey(windowKey)),
    save: async (windowKey: string, state: WindowState): Promise<void> => { await appState()?.set(windowStateKey(windowKey), state) }
  }
}

/**
 * Every window being tracked, so they can all be saved together. Closing the
 * app is not enough on its own: a quit through the menu shuts the plugins down
 * first and only then closes the windows, by which time the store is gone.
 * Flushing from the shutdown sequence saves while it is still there.
 */
export function createWindowStateGroup() {
  const trackers = new Set<WindowStateTracker>()
  return {
    track(win: TrackedWindow, save: (state: WindowState) => Promise<void>, options?: Parameters<typeof trackWindowState>[2]) {
      const tracker = trackWindowState(win, save, options)
      trackers.add(tracker)
      win.on('closed', () => { trackers.delete(tracker) })
      return tracker
    },
    /** Saves every tracked window that changed. Resolves once written. */
    async flush() {
      await Promise.all([...trackers].map(tracker => tracker.flush()))
    }
  }
}
