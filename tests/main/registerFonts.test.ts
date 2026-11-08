import { describe, expect, it, vi } from 'vitest'
import { SETTINGS_OPEN_COMMAND, SETTINGS_PAGES_EXTENSION_POINT } from '@tessera/types'
import { createPluginContext, createPluginRuntime } from '../../core/plugins/PluginContext'
import { FONT_SETTINGS } from '../../shared/fonts/settings'
import { FONTS_FAMILIES, FONT_COMMANDS } from '../../shared/fonts/types'
import { SHELL_CONTRIBUTOR_ID } from '../../shared/plugins/manifest'
import { THEME_SETTINGS } from '../../shared/theme/settings'
import { FONTS_PAGE, registerFonts } from '../../shell/main/fonts/registerFonts'
import { APPEARANCE_PAGE } from '../../shell/main/theme/registerTheme'
import { createLogger } from '../helpers/runtime'

function setup(families = vi.fn(async () => ({ families: ['Inter'], complete: true }))) {
  const runtime = createPluginRuntime(undefined, createLogger())
  const shell = createPluginContext(SHELL_CONTRIBUTOR_ID, runtime).context
  runtime.settings.register(SHELL_CONTRIBUTOR_ID, THEME_SETTINGS)
  runtime.settings.register(SHELL_CONTRIBUTOR_ID, FONT_SETTINGS)
  shell.extensions.contribute(SHELL_CONTRIBUTOR_ID, SETTINGS_PAGES_EXTENSION_POINT, APPEARANCE_PAGE.id, APPEARANCE_PAGE)
  registerFonts(shell, { families })
  return { runtime, families }
}

describe('registerFonts', () => {
  it('adds the Fonts page under Appearance, over the shell.fonts setting, drawn by the shell', () => {
    const { runtime } = setup()

    const pages = runtime.settings.pages()
    expect(pages.map(p => [p.id, p.parent, p.settings, p.module])).toEqual([
      ['shell.appearance', undefined, 'shell.theme', './Appearance'],
      ['shell.appearance.fonts', 'shell.appearance', 'shell.fonts', './Fonts']
    ])
    expect(FONTS_PAGE.keywords).toEqual(expect.arrayContaining(['font', 'larger text', 'monospace']))
  })

  it('opens the Options dialog at the Fonts page', async () => {
    const { runtime } = setup()
    const opened = vi.fn()
    runtime.commands.register(SETTINGS_OPEN_COMMAND, opened)

    await runtime.commands.execute(FONT_COMMANDS.choose)

    expect(opened).toHaveBeenCalledWith('shell.appearance.fonts')
  })

  it('answers the installed fonts', async () => {
    const { runtime, families } = setup()

    await expect(runtime.ipc.dispatch({ channel: FONTS_FAMILIES }, { windowId: 1 })).resolves.toEqual({ ok: true, data: { families: ['Inter'], complete: true } })
    expect(families).toHaveBeenCalledTimes(1)
  })
})
