// core/theme/ThemeService.ts
import type {
  Disposable,
  ExtensionRegistry,
  Logger,
  ThemeDescriptor,
  ThemePersistence,
  ThemeSelection,
  ThemeState
} from '@tessera/types'
import { contrastFindings } from '../../shared/theme/contrast'
import { resolveThemes } from '../../shared/theme/resolveThemes'
import {
  DEFAULT_SELECTION,
  followsSystem,
  parseStoredSelection,
  resolveSelection,
  selectionProblem
} from '../../shared/theme/selection'
import { THEMES_EXTENSION_POINT } from '../../shared/theme/types'
import { Emitter } from '../events'
import type { ThemePort } from '../ports'

interface WindowEntry {
  /** Stable key the window's override is saved under; windows without one are not saved. */
  key?: string
  override?: ThemeSelection
  /** The last state announced, to stay silent when nothing changed. */
  published: string
}

export interface ThemeOptions {
  /** Where choices are kept. Without it they last for the session. */
  persistence?: ThemePersistence
  log?: Logger
}

const describe = (err: unknown) => err instanceof Error ? err.message : String(err)

/**
 * The theme manager: one application-wide selection, an optional override per
 * window, and the themes both choose from (the shell's own, and those plugins
 * contribute to `shell.themes`).
 *
 * A selection is a theme and a mode preference (`system`, `light` or `dark`).
 * What a window shows is resolved here, from its override or else the global
 * selection and the platform's setting, so every observer agrees. Changes are
 * published through `onDidChange`, only for windows whose state differs. The
 * global mode is also handed to the platform port, so native chrome follows it.
 */
export class ThemeService {
  private readonly windows = new Map<number, WindowEntry>()
  private readonly changed = new Emitter<ThemeState>()
  private readonly subscriptions: Disposable[] = []
  private readonly persistence?: ThemePersistence
  private readonly log?: Logger
  private writes: Promise<void> = Promise.resolve()

  private global: ThemeSelection = { ...DEFAULT_SELECTION }
  private catalogue: ThemeDescriptor[] = resolveThemes([]).themes
  private catalogueJson = JSON.stringify(this.catalogue)
  private diagnosed = ''
  private readonly missing = new Set<string>()
  /** Themes already reported as hard to read, so a theme is reported once, and again if it changes. */
  private readonly warnedContrast = new Set<string>()
  private readonly themeListChanged = new Emitter<ThemeDescriptor[]>()

  /** Fires with a window's new state whenever it changes (and for every window when the themes change). */
  readonly onDidChange = this.changed.event
  /** Fires with the new list when a theme is added, removed or changed, whether or not any window exists. */
  readonly onDidChangeThemes = this.themeListChanged.event

  constructor(
    private readonly extensions: ExtensionRegistry,
    private readonly port: ThemePort,
    options: ThemeOptions = {}
  ) {
    this.persistence = options.persistence
    this.log = options.log
    this.refreshThemes()
    this.port.setSource(this.platformSource())

    this.subscriptions.push(
      extensions.onDidChange(({ point }) => { if (point === THEMES_EXTENSION_POINT) this.update() }),
      { dispose: port.onSystemChange(() => this.update()) }
    )
  }

  // ---- Queries ----

  /** Every registered theme: the shell's own first, then plugins' in registration order. */
  list(): ThemeDescriptor[] {
    return this.catalogue
  }

  getGlobal(): ThemeSelection {
    return { ...this.global }
  }

  isAttached(windowId: number) {
    return this.windows.has(windowId)
  }

  windowIds() {
    return [...this.windows.keys()]
  }

  /** The id of the window attached under `key`, if any. */
  windowIdOf(key: string) {
    return [...this.windows].find(([, entry]) => entry.key === key)?.[0]
  }

  getState(windowId: number): ThemeState {
    const entry = this.windows.get(windowId)
    if (!entry) throw new Error(`Unknown window: ${windowId}`)
    return this.stateOf(windowId, entry)
  }

  /** True while the operating system wants dark colours. */
  get systemPrefersDark() {
    return this.port.systemPrefersDark
  }

  /** What the global selection shows right now: what a window with no override shows. */
  resolveGlobal() {
    const { theme, mode } = resolveSelection(this.global, this.catalogue, this.port.systemPrefersDark)
    return { theme, mode }
  }

  // ---- Choices ----

  /** Throws a message the user can read when the selection can't be used. */
  setGlobal(selection: ThemeSelection) {
    this.check(selection)
    if (selection.theme === this.global.theme && selection.mode === this.global.mode) return

    this.global = { theme: selection.theme, mode: selection.mode }
    this.port.setSource(this.platformSource())
    this.queue(() => this.persistence?.saveGlobal(this.global))
    this.update()
  }

  /** Gives a window its own theme, or with `undefined` returns it to the global setting. */
  setOverride(windowId: number, selection: ThemeSelection | undefined) {
    const entry = this.entry(windowId)
    if (selection !== undefined) this.check(selection)
    if (JSON.stringify(entry.override) === JSON.stringify(selection)) return

    entry.override = selection && { theme: selection.theme, mode: selection.mode }
    if (entry.key !== undefined) this.queue(() => this.persistence?.saveOverride(entry.key!, entry.override))
    this.update()
  }

  // ---- Windows and persistence ----

  /** Reads the saved application-wide selection. Call once, before the first window. */
  async loadGlobal() {
    const raw = await this.persistence?.loadGlobal().catch(err => {
      this.log?.warn(`[theme] Could not load the saved theme: ${describe(err)}`)
      return undefined
    })
    this.adoptGlobal(raw)
  }

  /**
   * Takes the application-wide selection from where it is kept (the settings), without saving it back. Only its
   * form is checked: its theme may be a plugin's that hasn't activated yet, and until it does the shell's own theme
   * is shown (see `noteMissing`). True when the selection changed; windows are told as for `setGlobal`.
   */
  adoptGlobal(raw: unknown): boolean {
    const { selection, warning } = parseStoredSelection(raw)
    if (warning) this.log?.warn(`[theme] ${warning}`)
    if (!selection || (selection.theme === this.global.theme && selection.mode === this.global.mode)) return false
    this.global = selection
    this.port.setSource(this.platformSource())
    this.update()
    return true
  }

  /** Returns every window with a theme of its own to the application-wide one, forgetting the overrides. */
  clearOverrides() {
    let cleared = false
    for (const entry of this.windows.values()) {
      if (entry.override === undefined) continue
      entry.override = undefined
      cleared = true
      if (entry.key !== undefined) this.queue(() => this.persistence?.saveOverride(entry.key!, undefined))
    }
    if (cleared) this.update()
  }

  /** Starts tracking a window, with the override saved under `key` (if any). Resolves with its first state. */
  async attach(windowId: number, key?: string): Promise<ThemeState> {
    let override: ThemeSelection | undefined
    if (key !== undefined && this.persistence) {
      try {
        const { selection, warning } = parseStoredSelection(await this.persistence.loadOverride(key))
        if (warning) this.log?.warn(`[theme] ${warning} (window "${key}")`)
        override = selection
      } catch (err) {
        this.log?.warn(`[theme] Could not load the theme of window "${key}": ${describe(err)}`)
      }
    }

    const entry: WindowEntry = { key, override, published: '' }
    this.windows.set(windowId, entry)
    const state = this.stateOf(windowId, entry)
    entry.published = JSON.stringify(state)
    return state
  }

  /** Stops tracking a window. Its override is already saved, so this only waits for the write. */
  async detach(windowId: number) {
    this.windows.delete(windowId)
    await this.writes
  }

  /** Resolves once every pending write has finished. */
  flush() {
    return this.writes
  }

  dispose() {
    for (const subscription of this.subscriptions) subscription.dispose()
  }

  // ---- Internals ----

  private entry(windowId: number) {
    const entry = this.windows.get(windowId)
    if (!entry) throw new Error(`Unknown window: ${windowId}`)
    return entry
  }

  private check(selection: unknown): asserts selection is ThemeSelection {
    const problem = selectionProblem(selection, this.catalogue)
    if (problem) throw new Error(problem)
  }

  /** What platform chrome is told: `system` only while the global theme can follow it. */
  private platformSource() {
    const { theme, mode } = this.resolveGlobal()
    const descriptor = this.catalogue.find(t => t.id === theme)!
    return this.global.mode === 'system' && followsSystem(descriptor) ? 'system' as const : mode
  }

  private stateOf(windowId: number, entry: WindowEntry): ThemeState {
    const selection = entry.override ?? this.global
    const { theme, mode, fellBack } = resolveSelection(selection, this.catalogue, this.port.systemPrefersDark)
    this.noteMissing(selection.theme, fellBack)
    return { windowId, global: { ...this.global }, ...(entry.override && { override: { ...entry.override } }), theme, mode }
  }

  /** Warns once that a saved theme is not available (its plugin may be gone), and again if it goes missing anew. */
  private noteMissing(theme: string, fellBack: boolean) {
    if (!fellBack) { this.missing.delete(theme); return }
    if (this.missing.has(theme)) return
    this.missing.add(theme)
    this.log?.warn(`[theme] Theme "${theme}" is not available; showing the default. The choice is kept in case it returns.`)
  }

  private refreshThemes() {
    const { themes, diagnostics } = resolveThemes(this.extensions.getContributions(THEMES_EXTENSION_POINT))
    const diagnosed = diagnostics.join('\n')
    if (diagnosed !== this.diagnosed) {
      this.diagnosed = diagnosed
      for (const message of diagnostics) this.log?.warn(`[theme] ${message}`)
    }

    // A theme that is hard to read is reported, not refused: the user may want exactly that, and a plugin can
    // be fixed. The shell's own theme is held to the same figures by a test.
    for (const theme of themes.slice(1)) {
      const key = JSON.stringify(theme)
      if (this.warnedContrast.has(key)) continue
      this.warnedContrast.add(key)
      for (const { mode, pair, ratio, minimum } of contrastFindings(theme)) {
        this.log?.warn(`[theme] Theme "${theme.id}" may be hard to read: ${pair} is ${ratio.toFixed(1)}:1 in ${mode} mode (WCAG AA asks for ${minimum}:1)`)
      }
    }

    const json = JSON.stringify(themes)
    const different = json !== this.catalogueJson
    this.catalogue = themes
    this.catalogueJson = json
    return different
  }

  /** Re-resolves every window, announcing those that changed (all of them when the themes did). */
  private update() {
    const themesChanged = this.refreshThemes()
    if (themesChanged) {
      this.port.setSource(this.platformSource())
      this.themeListChanged.fire(this.catalogue)
    }

    for (const [windowId, entry] of this.windows) {
      const state = this.stateOf(windowId, entry)
      const json = JSON.stringify(state)
      if (json === entry.published && !themesChanged) continue
      entry.published = json
      this.changed.fire(state)
    }
  }

  /** Writes happen one after another, and a failed one is logged rather than lost or thrown. */
  private queue(write: () => Promise<void> | undefined) {
    this.writes = this.writes
      .then(write)
      .catch(err => this.log?.error(`[theme] Could not save the theme: ${describe(err)}`))
  }
}
