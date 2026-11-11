// The user's fonts as a setting (`shell.fonts`): what is accepted, what is kept on disk, and what a hand-edited file can do.
import { describe, expect, it } from 'vitest'
import type { FontSettings } from '@tessera/types'
import { DEFAULT_FONT_SETTINGS } from '../../shared/fonts/resolveFonts'
import { FONT_SETTINGS, FONT_SETTINGS_ID, fontSettingsProblems } from '../../shared/fonts/settings'
import { setupSettings } from '../helpers/settings'

/** The defaults with some roles changed. */
const fonts = (roles: Record<string, object> = {}, over: Partial<FontSettings> = {}): FontSettings => ({
  ...DEFAULT_FONT_SETTINGS,
  roles: Object.fromEntries(Object.entries(DEFAULT_FONT_SETTINGS.roles).map(([id, v]) => [id, { ...v, ...roles[id] }])) as FontSettings['roles'],
  ...over
})

describe('the shell.fonts setting', () => {
  it('is the shell\'s, with every role Automatic and theme fonts on by default', () => {
    expect(FONT_SETTINGS.id).toBe(FONT_SETTINGS_ID)
    expect(FONT_SETTINGS_ID).toBe('shell.fonts')
    expect(FONT_SETTINGS.defaults).toEqual(DEFAULT_FONT_SETTINGS)
    // A copy, so freezing it (as the settings service does) leaves the shared defaults alone
    expect(FONT_SETTINGS.defaults).not.toBe(DEFAULT_FONT_SETTINGS)
    expect(fontSettingsProblems(FONT_SETTINGS.defaults)).toEqual([])
  })

  it('accepts what the user can choose', () => {
    expect(fontSettingsProblems(fonts({
      ui: { family: ['Inter'], size: 15, weight: 500 },
      heading: { family: ['Georgia', 'serif'], weight: 700 },
      small: { size: 11 }, table: { size: 24 }, numeric: { family: ['Cascadia Mono'] }, monospace: { size: 9 }
    }, { useThemeFonts: false }))).toEqual([])
  })

  it("refuses what the user can't choose, with a message for each", () => {
    expect(fontSettingsProblems(fonts({
      ui: { size: 10 }, table: { weight: 600 }, numeric: { size: 14 }, monospace: { family: ['Iosevka;}'] }, heading: { weight: 450 }
    }))).toEqual([
      'Interface text: choose a size from 11 to 24 px.',
      'Headings: choose Regular, Medium, Semibold or Bold.',
      "Tables and registers: its weight can't be set.",
      "Amounts and figures: its size can't be set.",
      'Fixed-width text: the font has "Iosevka;}", which isn\'t a font name.'
    ])
  })

  it('refuses a switch that is not on or off, and roles that are not given role by role', () => {
    expect(fontSettingsProblems(fonts({}, { useThemeFonts: 'yes' as never }))).toEqual(['Say whether to use the fonts themes choose: true or false.'])
    expect(fontSettingsProblems({ useThemeFonts: true, roles: [] } as never)).toEqual(['The fonts must be given role by role.'])
    expect(fontSettingsProblems({ ...fonts(), roles: { ...fonts().roles, ui: 'Inter' } } as never)).toEqual(['Interface text: must be an object.'])
  })

  it('leaves roles it does not know to the version that wrote them', () => {
    const newer = { ...fonts(), roles: { ...fonts().roles, register: { size: 15 } } } as FontSettings

    expect(fontSettingsProblems(newer)).toEqual([])
  })
})

describe('the shell.fonts setting in the settings service', () => {
  const setup = async (saved: Record<string, unknown> = {}) => {
    const service = await setupSettings(saved)
    const handle = service.settings.register('shell', FONT_SETTINGS)
    return { ...service, handle }
  }

  it('saves only what differs from the defaults, and nothing at all at the defaults', async () => {
    const { handle, documents } = await setup()
    expect(documents.has(FONT_SETTINGS_ID)).toBe(false)

    await handle.update({ roles: fonts({ ui: { family: ['Inter'] }, table: { size: 15 } }).roles })

    expect(documents.get(FONT_SETTINGS_ID)).toEqual({ version: 1, values: { roles: { ui: { family: ['Inter'] }, table: { size: 15 } } } })
  })

  it('forgets a choice set back to Automatic, removing the file once nothing differs', async () => {
    const { handle, documents } = await setup()
    await handle.update({ roles: fonts({ ui: { family: ['Inter'] }, table: { size: 15 } }).roles })

    await handle.update({ roles: fonts({ table: { size: 15 } }).roles })
    expect(documents.get(FONT_SETTINGS_ID)).toEqual({ version: 1, values: { roles: { table: { size: 15 } } } })

    await handle.update({ roles: fonts().roles })
    expect(documents.has(FONT_SETTINGS_ID)).toBe(false)
  })

  it('reads a file edited by hand, merged over the defaults', async () => {
    const { handle } = await setup({ [FONT_SETTINGS_ID]: { version: 1, values: { roles: { ui: { size: 16 } }, useThemeFonts: false } } })

    expect(handle.get()).toEqual(fonts({ ui: { size: 16 } }, { useThemeFonts: false }))
  })

  it('uses the defaults, and says why, when a file edited by hand holds what the user could not have chosen', async () => {
    const { handle, log } = await setup({ [FONT_SETTINGS_ID]: { version: 1, values: { roles: { ui: { size: 99, family: ['a;}'] } } } } })

    expect(handle.get()).toEqual(DEFAULT_FONT_SETTINGS)
    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/shell\.fonts.*Interface text: choose a size from 11 to 24 px/))
  })
})
