import { describe, it, expect, vi } from 'vitest'
import { createPluginContext } from '../../../core/plugins/PluginContext'
import { activate } from '../../../plugins/theme.sample/src/privileged/index'
import { COMMANDS, HIGHLIGHT_TOKEN, SEPIA_THEME, VIEWS } from '../../../plugins/theme.sample/src/shared'
import { resolveColors } from '../../../shared/theme/resolveColors'
import { resolveThemes } from '../../../shared/theme/resolveThemes'
import { SHELL_THEMES } from '../../../shared/theme/themes'
import { createRuntime } from '../../helpers/runtime'

function setup({ withWindowManager = true } = {}) {
  const runtime = createRuntime()
  const reveal = vi.fn()
  if (withWindowManager) runtime.commands.register('shell.layout.reveal', reveal)
  const scope = createPluginContext('theme-sample', runtime)
  activate(scope.context)
  return { runtime, reveal, scope }
}

describe('theme-sample: privileged half', () => {
  it('contributes one valid token and one valid theme under its own prefix', () => {
    const { runtime } = setup()

    const colors = resolveColors(runtime.extensions.getContributions('shell.colors'))
    expect(colors.diagnostics).toEqual([])
    expect(colors.colors).toEqual([{
      id: HIGHLIGHT_TOKEN, description: expect.any(String), defaults: { light: 'shell.warning', dark: 'shell.warning' }, pluginId: 'theme-sample'
    }])

    const themes = resolveThemes([
      ...SHELL_THEMES.map(impl => ({ contributor: 'shell', impl })),
      ...runtime.extensions.getContributions('shell.themes')
    ])
    expect(themes.diagnostics).toEqual([])
    expect(themes.themes.find(t => t.id === SEPIA_THEME)).toMatchObject({ kind: 'light', extends: 'shell.light', pluginId: 'theme-sample' })
    expect(themes.themes.find(t => t.id === SEPIA_THEME)!.colors[HIGHLIGHT_TOKEN]).toBe('#f2e3b8')
  })

  it('contributes a main view, a command that reveals it, and a View-menu entry', async () => {
    const { runtime, reveal } = setup()

    expect(runtime.extensions.getContributions('shell.views').map(c => c.impl)).toEqual([
      expect.objectContaining({ id: VIEWS.swatches, slot: 'shell.main', module: './Swatches' })
    ])
    expect(runtime.extensions.getContributions('shell.menus').map(c => (c.impl as any).command)).toEqual([COMMANDS.show])

    await runtime.commands.execute(COMMANDS.show)
    expect(reveal).toHaveBeenCalledWith(VIEWS.swatches)
  })

  it('copes without the window manager', async () => {
    const { runtime } = setup({ withWindowManager: false })
    await expect(runtime.commands.execute(COMMANDS.show)).resolves.toBeUndefined()
  })

  it('takes its contributions away on deactivation', () => {
    const { runtime, scope } = setup()
    scope.dispose()

    for (const point of ['shell.colors', 'shell.themes', 'shell.views', 'shell.menus']) {
      expect(runtime.extensions.getContributions(point)).toEqual([])
    }
    expect(runtime.commands.has(COMMANDS.show)).toBe(false)
  })
})
