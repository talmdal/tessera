// shell/main/theme/themeContent.ts
//
// Feeds the ThemeService with what has been contributed under `shell.colors`
// and `shell.themes`, the shell's own built-ins included (registerTheme
// contributes them through the shell's plugin context, so one path serves
// everything). Contributions are resolved per change, not per read, and a
// diagnostic is logged the first time it appears, not on every refresh.
import { ColorDefinition, ExtensionRegistry, Logger, ThemeDefinition } from '@tessera/types'
import { ThemeContentSource } from '../../../core/theme/ThemeService'
import { resolveColors } from '../../../shared/theme/resolveColors'
import { resolveThemes } from '../../../shared/theme/resolveThemes'
import { COLORS_EXTENSION_POINT, THEMES_EXTENSION_POINT } from '../../../shared/theme/types'

export function createThemeContent(extensions: ExtensionRegistry, log: Logger): ThemeContentSource {
  let colors: readonly ColorDefinition[] | undefined
  let themes: readonly ThemeDefinition[] | undefined
  const reported = new Set<string>()

  const report = (diagnostics: string[]) => {
    for (const message of diagnostics) {
      if (reported.has(message)) continue
      reported.add(message)
      log.warn(`[theme] ${message}`)
    }
  }

  // Invalidate on every change of the two points, whether or not anyone listens.
  const listeners = new Set<() => void>()
  extensions.onDidChange(({ point }) => {
    if (point !== COLORS_EXTENSION_POINT && point !== THEMES_EXTENSION_POINT) return
    colors = undefined
    themes = undefined
    for (const listener of [...listeners]) listener()
  })

  return {
    colors: () => {
      if (!colors) {
        const resolved = resolveColors(extensions.getContributions(COLORS_EXTENSION_POINT))
        report(resolved.diagnostics)
        colors = resolved.colors
      }
      return colors
    },
    themes: () => {
      if (!themes) {
        const resolved = resolveThemes(extensions.getContributions(THEMES_EXTENSION_POINT))
        report(resolved.diagnostics)
        themes = resolved.themes
      }
      return themes
    },
    onDidChange: listener => {
      listeners.add(listener)
      return { dispose: () => { listeners.delete(listener) } }
    }
  }
}
