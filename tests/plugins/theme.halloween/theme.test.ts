import { describe, it, expect } from 'vitest'
import { getContrastRatio } from '@mui/material'
import type { ThemeContribution } from '@tessera/types'
import { createPluginContext, createPluginRuntime } from '../../../core/plugins/PluginContext'
import { ThemeService } from '../../../core/theme/ThemeService'
import { resolveThemes, validateTheme } from '../../../shared/themes/resolveThemes'
import { COLOR_SCHEMES, THEMES_EXTENSION_POINT } from '../../../shared/themes/types'
import halloween from '../../../plugins/theme-halloween/themes/halloween.json'
import { activate } from '../../../plugins/theme-halloween/src/privileged'
import { resolveTheme } from '../../../shell/renderer/theme/resolveTheme'
import { createLogger } from '../../helpers/runtime'

const contribution = halloween as ThemeContribution

describe('the Halloween theme plugin', () => {
  it('ships a valid theme with both schemes and a swatch for each', () => {
    expect(validateTheme(contribution)).toBeUndefined()
    const { themes } = resolveThemes([{ contributor: 'theme-halloween', impl: contribution }])
    expect(themes[0]).toMatchObject({ id: 'theme-halloween.main', label: 'Halloween', schemes: ['light', 'dark'] })
    for (const scheme of COLOR_SCHEMES) expect(contribution.swatch?.[scheme]).toHaveLength(4)
  })

  it('builds in both schemes with readable text and pumpkin-orange primaries', () => {
    const descriptor = { ...contribution, pluginId: 'theme-halloween', schemes: [...COLOR_SCHEMES] }
    for (const scheme of COLOR_SCHEMES) {
      const { theme, themeId, problem } = resolveTheme(descriptor, scheme)
      expect(problem, scheme).toBeUndefined()
      expect(themeId).toBe('theme-halloween.main')
      expect(theme.palette.mode).toBe(scheme)
      expect(getContrastRatio(theme.palette.text.primary, theme.palette.background.default)).toBeGreaterThan(7)
      expect(getContrastRatio(theme.palette.text.secondary, theme.palette.background.paper)).toBeGreaterThan(4)
      expect(getContrastRatio(theme.palette.primary.contrastText, theme.palette.primary.main)).toBeGreaterThan(4)
      expect(theme.tessera.finance.credit).not.toBe(theme.tessera.finance.debit)
      expect(theme.typography.fontFamily).toMatch(/Georgia/)
      expect(theme.typography.fontSize).toBe(13)               // the shell's base shows through
    }
    expect(resolveTheme(descriptor, 'dark').theme.palette.primary.main).toBe('#ff7518')
  })

  it('contributes the theme on activation and withdraws it on deactivation', () => {
    const log = createLogger()
    const runtime = createPluginRuntime(undefined, log)
    const service = new ThemeService(runtime.extensions, { system: { isDark: () => true, onDidChange: () => ({ dispose() {} }) }, log })
    const scope = createPluginContext('theme-halloween', runtime)

    activate(scope.context)
    expect(service.themes().map(t => t.id)).toEqual(['theme-halloween.main'])
    expect(service.backgroundColor()).toBe('#121212')           // not chosen yet: the shell's default

    scope.dispose()
    expect(service.themes()).toEqual([])
    expect(runtime.extensions.getContributions(THEMES_EXTENSION_POINT)).toEqual([])
  })
})
