// core/theme/ThemeService.ts
//
// The style manager's state: the user's theme preference, the theme in use,
// and every colour token resolved to a hex value, owned by the main process
// and mirrored by the renderer. Platform-free: the shell feeds it the token
// catalogue and the themes through a ThemeContentSource, the operating
// system's light/dark setting through SystemAppearance, and persists the
// preference through ThemePersistence. See docs/style-manager-design.md.
import {
  ColorDefinition,
  Disposable,
  Logger,
  SystemAppearance,
  ThemeCustomizations,
  ThemeDefinition,
  ThemeKind,
  ThemePersistence,
  ThemePreference,
  ThemeSetRequest,
  ThemeState
} from '@tessera/types'
import { resolveColorMap } from '../../shared/theme/resolveColorMap'
import { SYSTEM_THEME, defaultPreference, defaultThemeFor, isColorValue, isTokenId } from '../../shared/theme/types'
import { Emitter } from '../events'

/**
 * Where the service learns what has been contributed: the resolved token
 * catalogue and themes, in display order. The shell implements it over the
 * extension registry (and, before that, over its own built-ins).
 */
export interface ThemeContentSource {
  colors(): readonly ColorDefinition[]
  themes(): readonly ThemeDefinition[]
  /** Fires when either list may have changed. */
  onDidChange(listener: () => void): Disposable
}

export class ThemeService implements Disposable {
  private preference: ThemePreference = defaultPreference()
  private state: ThemeState
  private readonly subscriptions: Disposable[] = []
  private readonly changed = new Emitter<ThemeState>()
  /** Fallbacks and resolution problems already reported, so they are logged once, not on every refresh. */
  private readonly reported = new Set<string>()
  /** The kind of every theme seen so far, so a theme that disappears falls back within its own kind. */
  private readonly knownKinds = new Map<string, ThemeKind>()

  /** Fires with the new state whenever anything in it changed. */
  readonly onDidChange = this.changed.event

  constructor(
    private readonly content: ThemeContentSource,
    private readonly appearance: SystemAppearance,
    private readonly options: { persistence?: ThemePersistence, log?: Logger } = {}
  ) {
    this.state = this.compute()
    this.subscriptions.push(
      content.onDidChange(() => this.refresh()),
      appearance.onDidChange(() => this.refresh())
    )
  }

  get(): ThemeState {
    return this.state
  }

  /**
   * Applies a preference change: any subset of the preference. Throws for a
   * theme id that is not present, or a malformed request. Returns the new
   * state, and saves the preference.
   */
  setPreference(request: ThemeSetRequest): ThemeState {
    const next: ThemePreference = { ...this.preference }
    const present = new Map(this.content.themes().map(theme => [theme.id, theme.kind]))
    const requireTheme = (field: 'theme' | 'light' | 'dark', value: unknown) => {
      if (typeof value !== 'string' || !(present.has(value) || (field === 'theme' && value === SYSTEM_THEME))) {
        throw new Error(`Unknown theme "${String(value)}"`)
      }
      // The per-kind picks must be themes of that kind, or following the system would contradict it.
      if (field !== 'theme' && present.get(value) !== field) {
        throw new Error(`"${value}" is not a ${field} theme`)
      }
      next[field] = value
    }
    if (request.theme !== undefined) requireTheme('theme', request.theme)
    if (request.light !== undefined) requireTheme('light', request.light)
    if (request.dark !== undefined) requireTheme('dark', request.dark)
    if (request.customizations !== undefined) {
      next.customizations = this.cleanCustomizations(request.customizations)
    }

    this.preference = next
    this.save()
    return this.publish()
  }

  /** Loads the stored preference, if any, and applies it. Safe to call before any plugin has contributed. */
  async load(): Promise<ThemeState> {
    const { persistence, log } = this.options
    if (!persistence) return this.state
    let stored: ThemePreference | undefined
    try {
      stored = await persistence.load()
    } catch (err) {
      log?.warn('[theme] Could not load the theme preference; using the defaults', err)
    }
    if (!stored || typeof stored !== 'object') return this.state

    const next = defaultPreference()
    const kinds = new Map(this.content.themes().map(theme => [theme.id, theme.kind]))
    for (const field of ['theme', 'light', 'dark'] as const) {
      const value = stored[field]
      if (typeof value !== 'string' || !(isTokenId(value) || (field === 'theme' && value === SYSTEM_THEME))) continue
      // A per-kind pick of the other kind is a corrupt entry; the default is safer than a contradiction.
      if (field !== 'theme' && kinds.has(value) && kinds.get(value) !== field) {
        log?.warn(`[theme] Ignoring stored ${field} theme "${value}": it is not a ${field} theme`)
        continue
      }
      next[field] = value
    }
    if (stored.customizations !== undefined) next.customizations = this.cleanCustomizations(stored.customizations)
    this.preference = next
    return this.publish()
  }

  /** Recomputes the state; announces it when it changed. */
  refresh(): void {
    this.publish()
  }

  dispose(): void {
    for (const subscription of this.subscriptions.splice(0)) subscription.dispose()
  }

  // -----------------------------

  private publish(): ThemeState {
    const next = this.compute()
    if (JSON.stringify(next) !== JSON.stringify(this.state)) {
      this.state = next
      this.changed.fire(next)
    }
    return this.state
  }

  private compute(): ThemeState {
    const themes = this.content.themes()
    const byId = new Map(themes.map(theme => [theme.id, theme]))
    for (const theme of themes) this.knownKinds.set(theme.id, theme.kind)
    const systemKind = this.appearance.kind()
    const { theme: chosenId, kind: chosenKind } = this.chosenTheme(systemKind)

    let active = byId.get(chosenId)
    if (!active) {
      const fallbackId = defaultThemeFor(chosenKind)
      active = byId.get(fallbackId)
      this.warnOnce(`missing:${chosenId}`, `[theme] Theme "${chosenId}" is not available; using "${fallbackId}"`)
    }

    const colors: Record<string, string> = {}
    if (active) {
      const resolved = resolveColorMap(this.content.colors(), themes, active, this.preference.customizations)
      Object.assign(colors, resolved.colors)
      for (const message of resolved.diagnostics) this.warnOnce(message, `[theme] ${message}`)
    } else {
      this.warnOnce('no-themes', '[theme] No themes are available; colours are unresolved')
    }

    return {
      preference: this.preference,
      activeTheme: active?.id ?? chosenId,
      kind: active?.kind ?? chosenKind,
      colors,
      themes: themes.map(({ id, label, kind, pluginId }) => ({ id, label, kind, pluginId }))
    }
  }

  /** The theme the preference asks for, and the kind to fall back within when it is absent. */
  private chosenTheme(systemKind: ThemeKind): { theme: string, kind: ThemeKind } {
    const { theme, light, dark } = this.preference
    if (theme === SYSTEM_THEME) return { theme: systemKind === 'dark' ? dark : light, kind: systemKind }
    return { theme, kind: this.knownKinds.get(theme) ?? systemKind }
  }

  /** Keeps well-formed entries only; a bad entry is skipped with a warning, never the whole map. */
  private cleanCustomizations(raw: unknown): ThemeCustomizations {
    const clean: ThemeCustomizations = {}
    if (typeof raw !== 'object' || raw === null) return clean
    const input = raw as Record<string, unknown>

    const cleanMap = (map: unknown, where: string): Record<string, string> | undefined => {
      if (typeof map !== 'object' || map === null) return undefined
      const result: Record<string, string> = {}
      for (const [token, value] of Object.entries(map as Record<string, unknown>)) {
        if (isTokenId(token) && isColorValue(value)) result[token] = value
        else this.options.log?.warn(`[theme] Ignoring customisation ${where} "${token}": "${String(value)}" is not a hex colour or a token id`)
      }
      return result
    }

    const global = cleanMap(input.global, 'of')
    if (global) clean.global = global
    if (typeof input.byTheme === 'object' && input.byTheme !== null) {
      clean.byTheme = {}
      for (const [themeId, map] of Object.entries(input.byTheme as Record<string, unknown>)) {
        const entries = cleanMap(map, `for "${themeId}" of`)
        if (entries) clean.byTheme[themeId] = entries
      }
    }
    return clean
  }

  private save(): void {
    const { persistence, log } = this.options
    if (!persistence) return
    persistence.save(this.preference).catch(err => log?.warn('[theme] Could not save the theme preference', err))
  }

  private warnOnce(key: string, message: string) {
    if (this.reported.has(key)) return
    this.reported.add(key)
    this.options.log?.warn(message)
  }
}
