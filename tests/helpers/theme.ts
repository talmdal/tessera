import { vi } from 'vitest'
import type { ThemeDescriptor, ThemePersistence, ThemeSelection, ThemeState } from '@tessera/types'
import { ExtensionRegistryImpl } from '../../core/extensions/ExtensionRegistry'
import type { ThemePort } from '../../core/ports'
import { ThemeOptions, ThemeService } from '../../core/theme/ThemeService'
import { THEMES_EXTENSION_POINT } from '../../shared/theme/types'

/** A platform port with a switchable OS setting, recording what the service told the platform. */
export function fakeThemePort(initiallyDark = false) {
  let dark = initiallyDark
  const listeners = new Set<() => void>()
  const sources: string[] = []
  const port: ThemePort = {
    get systemPrefersDark() { return dark },
    setSource: mode => { sources.push(mode) },
    onSystemChange: listener => { listeners.add(listener); return () => { listeners.delete(listener) } }
  }
  return {
    port,
    sources,
    listeners,
    /** The user flips the OS setting. */
    setSystemDark(value: boolean) { dark = value; for (const l of [...listeners]) l() }
  }
}

/** A persistence port backed by maps. */
export function memoryThemePersistence(initial: { global?: unknown, overrides?: Record<string, unknown> } = {}) {
  const store = { global: initial.global, overrides: new Map<string, unknown>(Object.entries(initial.overrides ?? {})) }
  const persistence: ThemePersistence = {
    loadGlobal: vi.fn(async () => store.global),
    saveGlobal: vi.fn(async (selection: ThemeSelection) => { store.global = selection }),
    loadOverride: vi.fn(async (key: string) => store.overrides.get(key)),
    saveOverride: vi.fn(async (key: string, selection: ThemeSelection | undefined) => {
      if (selection === undefined) store.overrides.delete(key)
      else store.overrides.set(key, selection)
    })
  }
  return { store, persistence }
}

/** A theme with a dark variant only, so it cannot follow the system. */
export const midnight = (extra: Partial<ThemeDescriptor> = {}): ThemeDescriptor => ({
  id: 'p.midnight', label: 'Midnight', dark: { primary: '#8899ff', background: { default: '#000011' } }, ...extra
})

/** A theme with both variants. */
export const sunrise = (extra: Partial<ThemeDescriptor> = {}): ThemeDescriptor => ({
  id: 'p.sunrise',
  label: 'Sunrise',
  light: { primary: '#ff8800' },
  dark: { primary: '#ffaa55' },
  ...extra
})

/** A theme manager over a real extension registry and a fake platform. */
export function setupTheme(options: ThemeOptions & { systemDark?: boolean } = {}) {
  const extensions = new ExtensionRegistryImpl()
  const platform = fakeThemePort(options.systemDark)
  const theme = new ThemeService(extensions, platform.port, options)
  const changes: ThemeState[] = []
  theme.onDidChange(state => changes.push(state))

  const contribute = (descriptor: unknown, contributor = 'p') =>
    extensions.contribute(contributor, THEMES_EXTENSION_POINT, (descriptor as any)?.id ?? 'x', descriptor)

  return { extensions, theme, platform, changes, contribute }
}
