// core/theme/ThemeService.ts
import type {
  ColorScheme,
  Disposable,
  ExtensionRegistry,
  Logger,
  PersistedTheme,
  ThemeDescriptor,
  ThemeMode,
  ThemePersistence,
  ThemeSelection,
  ThemeSet
} from '@tessera/types'
import { resolveThemes } from '../../shared/themes/resolveThemes'
import {
  DEFAULT_BACKGROUND,
  DEFAULT_THEME_ID,
  DEFAULT_THEME_MODE,
  SHELL_THEME_ID,
  THEMES_EXTENSION_POINT,
  isThemeMode
} from '../../shared/themes/types'
import { Emitter } from '../events'

/** Where the service learns whether the system is in dark mode: Electron's nativeTheme, or a fake in tests. */
export interface SystemModeSource {
  isDark(): boolean
  /** Calls `listener` when the system setting changes; returns a subscription to dispose. */
  onDidChange(listener: () => void): Disposable
}

export interface ThemeServiceOptions {
  system: SystemModeSource
  /** Where the choice is kept. Without it, it lasts for the session. */
  persistence?: ThemePersistence
  log?: Logger
}

const describe = (err: unknown) => err instanceof Error ? err.message : String(err)
const isString = (value: unknown): value is string => typeof value === 'string' && value.length > 0

/** A choice from untrusted saved data: whatever is valid is used, the rest falls back to the defaults. */
export function sanitizeTheme(raw: unknown): Required<PersistedTheme> {
  const saved = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  return {
    themeId: isString(saved.themeId) ? saved.themeId : DEFAULT_THEME_ID,
    mode: isThemeMode(saved.mode) ? saved.mode : DEFAULT_THEME_MODE
  }
}

/**
 * Holds the application's theme choice and the themes it can be made from.
 *
 * The themes come from `shell.themes` contributions, validated as they
 * change. The choice is a theme id and a mode; the service resolves `system`
 * through the system source and decides which theme is in effect: the chosen
 * one when it exists, otherwise the shell's own. The choice is kept even while
 * its theme is missing, so a theme plugin that comes back is used again with
 * no action from the user. The MUI theme itself is built in the renderer; this
 * only knows contributions as data.
 */
export class ThemeService {
  private readonly themesChanged = new Emitter<void>()
  private readonly selectionChanged = new Emitter<ThemeSelection>()
  private readonly subscriptions: Disposable[] = []
  private readonly persistence?: ThemePersistence
  private readonly system: SystemModeSource
  private readonly log?: Logger

  private catalogue: ThemeDescriptor[] = []
  private choice: Required<PersistedTheme> = { themeId: DEFAULT_THEME_ID, mode: DEFAULT_THEME_MODE }
  /** The last selection announced, to stay silent when nothing changed. */
  private published?: string
  private writes: Promise<void> = Promise.resolve()

  /** Fires when the set of themes changed; ask `themes()` for the new list. */
  readonly onDidChangeThemes = this.themesChanged.event
  /** Fires with the new selection whenever any part of it changed, including the system's mode. */
  readonly onDidChangeSelection = this.selectionChanged.event

  constructor(private readonly extensions: ExtensionRegistry, options: ThemeServiceOptions) {
    this.system = options.system
    this.persistence = options.persistence
    this.log = options.log

    this.subscriptions.push(
      extensions.onDidChange(({ point }) => {
        if (point === THEMES_EXTENSION_POINT) this.refresh()
      }),
      this.system.onDidChange(() => this.announce())
    )
    this.refresh(false)
  }

  /** Loads the saved choice. Call once at startup, before the first window, so its background and mode are right. */
  async load(): Promise<ThemeSelection> {
    try {
      const saved = await this.persistence?.load()
      if (saved !== undefined) this.choice = sanitizeTheme(saved)
    } catch (err) {
      this.log?.warn(`[themes] Could not load the saved theme: ${describe(err)}`)
    }
    this.announce()
    return this.selection()
  }

  /** Every valid theme, in chooser order. */
  themes(): ThemeDescriptor[] {
    return this.catalogue
  }

  /** The theme with this id, if it is present. */
  theme(id: string): ThemeDescriptor | undefined {
    return this.catalogue.find(theme => theme.id === id)
  }

  selection(): ThemeSelection {
    const { themeId, mode } = this.choice
    return {
      themeId,
      mode,
      resolvedMode: this.resolve(mode),
      effectiveThemeId: this.theme(themeId) ? themeId : SHELL_THEME_ID
    }
  }

  /** The theme in effect: the chosen one, or the shell's while it is missing. Undefined only if even that is gone. */
  effectiveTheme(): ThemeDescriptor | undefined {
    return this.theme(this.selection().effectiveThemeId)
  }

  /**
   * The page background of the theme in effect, for painting a window before
   * its renderer has drawn: what the theme's scheme says, else MUI's default
   * for the resolved mode. Read from the contribution, since the MUI theme
   * itself is only built in the renderer.
   */
  backgroundColor(): string {
    const { resolvedMode } = this.selection()
    const theme = this.effectiveTheme()
    const scheme = theme?.[resolvedMode] ?? theme?.[resolvedMode === 'dark' ? 'light' : 'dark']
    const background = (scheme?.palette as { background?: { default?: unknown } } | undefined)?.background?.default
    return typeof background === 'string' ? background : DEFAULT_BACKGROUND[resolvedMode]
  }

  /**
   * Changes the theme, the mode, or both. An unknown theme or mode is refused
   * and nothing changes. The new choice is saved and announced.
   */
  async set(request: ThemeSet): Promise<ThemeSelection> {
    if (typeof request !== 'object' || request === null) throw new Error('Expected a theme request')
    const { themeId, mode } = request
    if (themeId !== undefined && !this.theme(themeId)) throw new Error(`Unknown theme: ${String(themeId)}`)
    if (mode !== undefined && !isThemeMode(mode)) throw new Error(`Unknown theme mode: ${String(mode)}`)
    const next = { themeId: themeId ?? this.choice.themeId, mode: mode ?? this.choice.mode }
    if (next.themeId === this.choice.themeId && next.mode === this.choice.mode) return this.selection()

    this.choice = next
    this.save()
    this.announce()
    return this.selection()
  }

  /** Light becomes dark and dark light; `system` becomes the opposite of what the system currently is. */
  toggleMode(): Promise<ThemeSelection> {
    return this.set({ mode: this.resolve(this.choice.mode) === 'dark' ? 'light' : 'dark' })
  }

  /** Re-reads the contributions. Called for you when they change. */
  refresh(announce = true) {
    const contributions = this.extensions.getContributions(THEMES_EXTENSION_POINT)
      .map(({ contributor, impl }) => ({ contributor, impl }))
    const { themes, diagnostics } = resolveThemes(contributions)
    for (const message of diagnostics) this.log?.warn(`[themes] ${message}`)

    this.catalogue = themes
    this.themesChanged.fire()
    if (announce) this.announce()   // the chosen theme may have appeared or gone
  }

  /** Waits for pending writes. */
  flush(): Promise<void> {
    return this.writes
  }

  dispose() {
    for (const subscription of this.subscriptions.splice(0)) subscription.dispose()
  }

  private resolve(mode: ThemeMode): ColorScheme {
    return mode === 'system' ? (this.system.isDark() ? 'dark' : 'light') : mode
  }

  private announce() {
    const selection = this.selection()
    const key = JSON.stringify(selection)
    if (key === this.published) return
    this.published = key
    this.selectionChanged.fire(selection)
  }

  private save() {
    if (!this.persistence) return
    const choice = { ...this.choice }
    this.writes = this.writes
      .then(() => this.persistence!.save(choice))
      .catch(err => this.log?.error('[themes] Could not save the theme', err))
  }
}
