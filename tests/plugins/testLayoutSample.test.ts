// The bundled test-layout plugin is the reference for what a plugin contributes. Its theme and icon
// contributions go through the same validators the shell uses, so a mistake in the sample shows up here.
import { beforeEach, describe, expect, it } from 'vitest'
import { createPluginContext, createPluginRuntime } from '../../core/plugins/PluginContext'
import { ThemeService } from '../../core/theme/ThemeService'
import { resolveIcons } from '../../shared/layout/resolveIcons'
import { ICONS_EXTENSION_POINT } from '../../shared/layout/types'
import { resolveThemes } from '../../shared/theme/resolveThemes'
import { DEFAULT_THEME_ID, THEMES_EXTENSION_POINT } from '../../shared/theme/types'
import { activate } from '../../plugins/test-layout/src/privileged/index'
import { createLogger } from '../helpers/runtime'
import { fakeThemePort } from '../helpers/theme'

function activated() {
  const log = createLogger()
  const runtime = createPluginRuntime(undefined, log)
  activate(createPluginContext('test-layout', runtime).context)
  return { runtime, log }
}

describe('the test-layout sample: themes', () => {
  let runtime: ReturnType<typeof activated>['runtime']
  beforeEach(() => { runtime = activated().runtime })

  it('contributes themes that pass the shell\'s validation', () => {
    const { themes, diagnostics } = resolveThemes(runtime.extensions.getContributions(THEMES_EXTENSION_POINT))

    expect(diagnostics).toEqual([])
    expect(themes.map(t => t.id)).toEqual([DEFAULT_THEME_ID, 'test-layout.sunrise', 'test-layout.midnight'])
  })

  it('offers one theme that can follow the system and one that cannot', () => {
    const { themes } = resolveThemes(runtime.extensions.getContributions(THEMES_EXTENSION_POINT))
    const [sunrise, midnight] = themes.slice(1)

    expect(Boolean(sunrise.light && sunrise.dark)).toBe(true)
    expect(Boolean(midnight.light)).toBe(false)
    expect(Boolean(midnight.dark)).toBe(true)
  })

  it('can be chosen: the theme manager accepts each, and a single-variant one only in its own mode', () => {
    const theme = new ThemeService(runtime.extensions, fakeThemePort().port)

    expect(() => theme.setGlobal({ theme: 'test-layout.sunrise', mode: 'system' })).not.toThrow()
    expect(() => theme.setGlobal({ theme: 'test-layout.midnight', mode: 'dark' })).not.toThrow()
    expect(() => theme.setGlobal({ theme: 'test-layout.midnight', mode: 'system' })).toThrow('cannot follow the system')
  })
})

describe('the test-layout sample: icons', () => {
  it('registers an icon that passes the shell\'s validation', () => {
    const { runtime } = activated()

    const { icons, diagnostics } = resolveIcons(runtime.extensions.getContributions(ICONS_EXTENSION_POINT),
      (pluginId, relative) => `tessera-plugin://${pluginId}/${relative}`)

    expect(diagnostics).toEqual([])
    expect(icons).toEqual([{ id: 'test-layout.ping', url: 'tessera-plugin://test-layout/icons/ping.svg', pluginId: 'test-layout' }])
  })
})

describe('the test-layout sample: bar items', () => {
  it('shows its ping count from the context key the plugin actually publishes', () => {
    const { runtime } = activated()
    const status = runtime.extensions.getContributions('shell.bar.items').map(c => c.impl as { text?: string }).find(i => i.text?.startsWith('Sample pings'))!

    const keys = [...status.text!.matchAll(/\{([^{}]+)\}/g)].map(m => m[1].trim())

    expect(keys).toEqual(['test-layout.pings'])
    // ... and that key is one the plugin sets (activation publishes it)
    expect(runtime.contextKeys.snapshot()).toHaveProperty(keys[0])
  })
})
