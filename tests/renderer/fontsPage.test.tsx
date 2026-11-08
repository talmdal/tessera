// The Options dialog's Fonts page, in the real dialog: a row per role, Automatic and what it gives, choosing and typing
// a font, sizes and weights, Reset and Restore Defaults, fonts that aren't installed, the switch, and the preview.
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { FontSettings, SettingsCommitResult, ThemeSnapshot } from '@tessera/types'
import { DEFAULT_FONT_SETTINGS } from '../../shared/fonts/resolveFonts'
import { FONT_SETTINGS_ID, FONT_SETTINGS_MODULE, FONT_SETTINGS_PAGE } from '../../shared/fonts/settings'
import type { InstalledFonts } from '../../shared/fonts/types'
import { SETTINGS_COMMIT, SETTINGS_GET, SETTINGS_OPEN, type SettingsCatalogue, type SettingsCommitRequest } from '../../shared/settings/types'
import { THEME_SETTINGS_ID, THEME_SETTINGS_MODULE, THEME_SETTINGS_PAGE } from '../../shared/theme/settings'
import { DEFAULT_THEME, THEME_GET } from '../../shared/theme/types'
import { InstalledFontsProvider } from '../../shell/renderer/fonts/InstalledFonts'
import { SettingsDialog } from '../../shell/renderer/settings/SettingsDialog'
import { ShellThemeProvider } from '../../shell/renderer/theme/ShellThemeProvider'
import { createFakeRemote } from '../helpers/fakeBridge'

const theme: ThemeSnapshot = {
  state: { windowId: 1, global: { theme: DEFAULT_THEME.id, mode: 'light' }, theme: DEFAULT_THEME.id, mode: 'light' },
  themes: [DEFAULT_THEME], fonts: DEFAULT_FONT_SETTINGS
}
const INSTALLED: InstalledFonts = { families: ['Cascadia Mono', 'Georgia', 'Inter'], complete: true }

const appearance = { id: THEME_SETTINGS_PAGE, title: 'Appearance', pluginId: 'shell', settings: THEME_SETTINGS_ID, module: THEME_SETTINGS_MODULE, keywords: [] }
const fontsPage = {
  id: FONT_SETTINGS_PAGE, title: 'Fonts', pluginId: 'shell', parent: THEME_SETTINGS_PAGE, settings: FONT_SETTINGS_ID, module: FONT_SETTINGS_MODULE,
  description: 'The fonts and text sizes Tessera uses for each kind of text.', keywords: ['larger text', 'font']
}

/** The Options dialog, as the shell shows it, open at the Fonts page, with the fonts at `value`. */
async function setup({ value = DEFAULT_FONT_SETTINGS, installed = INSTALLED, readOnly, windowTheme = theme }: {
  value?: FontSettings, installed?: InstalledFonts, readOnly?: string, windowTheme?: ThemeSnapshot
} = {}) {
  const catalogue: SettingsCatalogue = {
    pages: [appearance, fontsPage],
    namespaces: [
      { id: THEME_SETTINGS_ID, owner: 'shell', value: { theme: DEFAULT_THEME.id, mode: 'light' }, defaults: { theme: DEFAULT_THEME.id, mode: 'system' } },
      { id: FONT_SETTINGS_ID, owner: 'shell', value: value as never, defaults: DEFAULT_FONT_SETTINGS as never, ...(readOnly && { readOnly }) }
    ]
  }
  const remote = createFakeRemote({ [THEME_GET]: () => windowTheme, [SETTINGS_GET]: () => catalogue })
  const answer = remote.bridge.invoke.getMockImplementation()!
  const commits: SettingsCommitRequest[] = []
  remote.bridge.invoke.mockImplementation(async (channel: string, data?: unknown) => {
    if (channel !== SETTINGS_COMMIT) return answer(channel, data)
    const request = data as SettingsCommitRequest
    commits.push(structuredClone(request))
    return { ok: true, namespaces: request.changes.map(c => ({ ...catalogue.namespaces[1], value: c.value as never })) } satisfies SettingsCommitResult
  })
  const families = vi.fn(async () => installed)

  render(
    <ShellThemeProvider bridge={remote.bridge} initial={windowTheme}>
      <InstalledFontsProvider source={{ families }}>
        <SettingsDialog bridge={remote.bridge} loader={{ load: vi.fn() }} />
      </InstalledFontsProvider>
    </ShellThemeProvider>)
  await act(async () => { remote.emit(SETTINGS_OPEN, { windowId: 1, page: FONT_SETTINGS_PAGE }) })
  await waitFor(() => expect(families).toHaveBeenCalled())
  await act(async () => {})
  return { commits, families }
}

const dialog = () => screen.getByRole('dialog', { name: 'Options' })
const page = () => screen.getByRole('region', { name: 'Fonts' })
const role = (name: string) => within(page()).getByRole('group', { name })
const font = (name: string) => within(role(name)).getByRole('combobox', { name: 'Font' })
const size = (name: string) => within(role(name)).getByRole('textbox', { name: 'Size' })
const button = (name: string) => within(dialog()).getByRole('button', { name })
const committedFonts = (commits: SettingsCommitRequest[]) => commits.at(-1)!.changes.find(c => c.id === FONT_SETTINGS_ID)!.value as FontSettings

describe('the Fonts page', () => {
  it('is under Appearance, and search finds it by "larger text"', async () => {
    await setup()

    const nav = within(dialog()).getByRole('navigation', { name: 'Settings pages' })
    expect(within(nav).getAllByRole('button').map(b => b.textContent)).toEqual(['Appearance', 'Fonts'])
    expect(within(nav).getByRole('button', { name: /^Fonts/ })).toHaveAttribute('aria-current', 'page')

    // A search keeps a match's parents, so the match is seen where it is
    await userEvent.type(within(nav).getByRole('textbox', { name: 'Search settings' }), 'larger text')
    expect(within(nav).getAllByRole('button').map(b => b.textContent)).toEqual(['Appearance', 'Fonts'])
  })

  it('has a row for each role, in order, with only the controls that role has', async () => {
    await setup()

    const rows = within(page()).getAllByRole('group').map(g => g.getAttribute('aria-labelledby') && g.querySelector('h3')?.textContent)
    expect(rows).toEqual(['Interface text', 'Headings', 'Small text', 'Tables and registers', 'Amounts and figures', 'Fixed-width text'])
    const controls = (name: string) => [
      within(role(name)).queryByRole('combobox', { name: 'Font' }) && 'font',
      within(role(name)).queryByRole('textbox', { name: 'Size' }) && 'size',
      within(role(name)).queryByRole('combobox', { name: 'Weight' }) && 'weight'
    ].filter(Boolean)
    expect(controls('Interface text')).toEqual(['font', 'size', 'weight'])
    expect(controls('Headings')).toEqual(['font', 'weight'])
    expect(controls('Tables and registers')).toEqual(['font', 'size'])
    expect(controls('Amounts and figures')).toEqual(['font'])
  })

  it('says what Automatic gives each role, and where it comes from', async () => {
    await setup()

    expect(font('Interface text')).toHaveAttribute('placeholder', "Automatic: the system's interface font")
    expect(font('Tables and registers')).toHaveAttribute('placeholder', "Automatic: the system's interface font")
    expect(font('Fixed-width text')).toHaveAttribute('placeholder', "Automatic: the system's fixed-width font")
    expect(size('Interface text')).toHaveAttribute('placeholder', '13')
    expect(size('Small text')).toHaveAttribute('placeholder', '11.1')
    expect(font('Tables and registers')).toHaveAccessibleDescription('Font: follows Interface text · Size: follows Interface text')
    expect(font('Amounts and figures')).toHaveAccessibleDescription('Font: follows the text around it')
    expect(font('Interface text')).toHaveAccessibleDescription('Font: automatic · Size: automatic · Weight: automatic (Regular)')
    expect(font('Headings')).toHaveAccessibleDescription("Font: follows Interface text · Weight: automatic (each heading's own)")
  })

  it('lists the installed fonts, each in its own face, and changes only the draft until OK', async () => {
    const { commits } = await setup()

    await userEvent.click(font('Interface text'))
    const inter = await screen.findByRole('option', { name: 'Inter' })
    expect(inter.style.fontFamily).toBe('"Inter", system-ui, sans-serif')
    expect(screen.getByRole('option', { name: "Automatic: the system's interface font" })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'System serif (serif)' }).style.fontFamily).toBe('serif')
    await userEvent.click(inter)

    expect(font('Interface text')).toHaveValue('Inter')
    expect(font('Interface text')).toHaveAccessibleDescription(/^Font: yours/)
    // What follows Interface text says so
    expect(font('Tables and registers')).toHaveAttribute('placeholder', 'Automatic: Inter')
    expect(font('Tables and registers')).toHaveAccessibleDescription(/^Font: follows Interface text/)
    expect(commits).toEqual([])

    await userEvent.click(button('OK'))
    expect(committedFonts(commits)).toEqual({ ...DEFAULT_FONT_SETTINGS, roles: { ...DEFAULT_FONT_SETTINGS.roles, ui: { family: ['Inter'], size: null, weight: null } } })
  })

  it('takes a name typed in, checks it as it is typed, and blocks OK while it cannot be used', async () => {
    const { commits } = await setup()

    await userEvent.type(font('Headings'), 'Baskerville;')
    expect(within(role('Headings')).getByText('This has "Baskerville;", which isn\'t a font name.')).toBeInTheDocument()
    expect(button('OK')).toBeDisabled()
    expect(button('Apply')).toBeDisabled()

    await userEvent.type(font('Headings'), '{Backspace}, serif')
    expect(button('OK')).toBeEnabled()
    await userEvent.click(button('OK'))
    expect(committedFonts(commits).roles.heading).toEqual({ family: ['Baskerville', 'serif'], weight: null })
  })

  it('takes a size within the range, and Automatic when blank', async () => {
    const { commits } = await setup()

    await userEvent.type(size('Interface text'), '30')
    expect(within(role('Interface text')).getByText('Choose a size from 11 to 24 px.')).toBeInTheDocument()
    expect(button('OK')).toBeDisabled()

    await userEvent.clear(size('Interface text'))
    await userEvent.type(size('Interface text'), '16')
    // Small text follows, at MUI's caption ratio
    expect(size('Small text')).toHaveAttribute('placeholder', '13.7')
    await userEvent.type(size('Tables and registers'), '15')
    await userEvent.click(button('Apply'))
    expect(committedFonts(commits).roles).toMatchObject({ ui: { size: 16 }, table: { size: 15 }, small: { size: null } })

    await userEvent.clear(size('Tables and registers'))
    await userEvent.click(button('OK'))
    expect(committedFonts(commits).roles.table).toEqual({ family: null, size: null })
  })

  it('chooses a weight', async () => {
    const { commits } = await setup()

    await userEvent.click(within(role('Headings')).getByRole('combobox', { name: 'Weight' }))
    await userEvent.click(screen.getByRole('option', { name: 'Bold' }))
    await userEvent.click(button('OK'))

    expect(committedFonts(commits).roles.heading).toEqual({ family: null, weight: 700 })
  })

  it('resets a role to Automatic, and Restore Defaults resets them all and turns theme fonts back on', async () => {
    const chosen: FontSettings = {
      useThemeFonts: false,
      roles: { ...DEFAULT_FONT_SETTINGS.roles, ui: { family: ['Inter'], size: 15, weight: null }, table: { family: null, size: 16 } }
    }
    const { commits } = await setup({ value: chosen })
    expect(within(role('Headings')).getByRole('button', { name: 'Reset Headings to Automatic' })).toBeDisabled()

    await userEvent.click(within(role('Interface text')).getByRole('button', { name: 'Reset Interface text to Automatic' }))
    expect(font('Interface text')).toHaveValue('')
    expect(size('Interface text')).toHaveValue('')
    expect(size('Tables and registers')).toHaveValue('16')

    await userEvent.click(button('Restore Defaults'))
    expect(size('Tables and registers')).toHaveValue('')
    expect(within(page()).getByRole('checkbox', { name: 'Use the fonts themes choose' })).toBeChecked()
    await userEvent.click(button('OK'))
    expect(committedFonts(commits)).toEqual(DEFAULT_FONT_SETTINGS)
  })

  it('says when a chosen font is not installed, only when it knows what is installed', async () => {
    const value: FontSettings = { ...DEFAULT_FONT_SETTINGS, roles: { ...DEFAULT_FONT_SETTINGS.roles, numeric: { family: ['Fira Code', 'monospace'] } } }
    await setup({ value })

    expect(within(role('Amounts and figures')).getByRole('alert')).toHaveTextContent('“Fira Code” isn\'t installed on this computer; the Interface text font is used instead.')
  })

  it('works without the list of installed fonts: a name can be typed, and nothing is said to be missing', async () => {
    const value: FontSettings = { ...DEFAULT_FONT_SETTINGS, roles: { ...DEFAULT_FONT_SETTINGS.roles, numeric: { family: ['Fira Code'] } } }
    const { commits } = await setup({ value, installed: { families: [], complete: false } })

    expect(within(page()).queryByRole('alert')).toBeNull()
    await userEvent.click(font('Interface text'))
    expect(screen.queryByRole('option', { name: 'Inter' })).toBeNull()
    await userEvent.type(font('Interface text'), 'Inter')
    await userEvent.click(button('OK'))
    expect(committedFonts(commits).roles.ui.family).toEqual(['Inter'])
  })

  it('turns theme fonts off and on', async () => {
    const { commits } = await setup()

    await userEvent.click(within(page()).getByRole('checkbox', { name: 'Use the fonts themes choose' }))
    await userEvent.click(button('OK'))

    expect(committedFonts(commits).useThemeFonts).toBe(false)
  })

  it('previews the draft in every role, in the window\'s theme', async () => {
    await setup()
    const preview = within(page()).getByRole('img', { name: 'Preview of the Tessera theme in light mode' })
    const cell = within(preview).getByText('1,111.11')
    expect(getComputedStyle(cell).fontVariantNumeric).toBe('tabular-nums')
    expect(within(preview).getByText('Last reconciled Oct 31, 2026')).toBeInTheDocument()
    expect(within(preview).getByText(/Home Finances\.tessera/)).toBeInTheDocument()

    await userEvent.type(size('Tables and registers'), '18')

    // The draft, not what is applied
    expect(getComputedStyle(within(preview).getByText('1,111.11')).fontSize).toBe('1.125rem')
  })

  it("shows what the window's theme sets, used for what is left on Automatic, and not while theme fonts are off", async () => {
    const serif = { id: 'p.serif', label: 'Ledger Book', light: { primary: '#7c2d12' }, fonts: { heading: { family: ['Georgia', 'serif'] }, ui: { size: 14 } } }
    const windowTheme: ThemeSnapshot = {
      ...theme, themes: [DEFAULT_THEME, serif],
      state: { ...theme.state, global: { theme: serif.id, mode: 'light' }, theme: serif.id }
    }
    const { commits } = await setup({ windowTheme })
    const note = () => page().querySelector('[data-theme-fonts]')!

    expect(note()).toHaveTextContent("The Ledger Book theme sets: Interface text (14 px), Headings (Georgia). They're used for roles you leave on Automatic.")
    expect(font('Headings')).toHaveAttribute('placeholder', 'Automatic: Georgia')
    expect(font('Headings')).toHaveAccessibleDescription(/^Font: from the theme/)
    expect(size('Interface text')).toHaveAttribute('placeholder', '14')
    expect(font('Interface text')).toHaveAccessibleDescription(/Size: from the theme/)

    await userEvent.click(within(page()).getByRole('checkbox', { name: 'Use the fonts themes choose' }))

    expect(note()).toHaveTextContent("They aren't used while this is off.")
    expect(font('Headings')).toHaveAttribute('placeholder', "Automatic: the system's interface font")
    expect(size('Interface text')).toHaveAttribute('placeholder', '13')
    await userEvent.click(button('OK'))
    expect(committedFonts(commits).useThemeFonts).toBe(false)
  })

  it('cannot be changed when the settings are read-only', async () => {
    await setup({ readOnly: 'These settings were saved by a newer version of "shell", so they can\'t be changed here.' })

    expect(font('Interface text')).toBeDisabled()
    expect(size('Interface text')).toBeDisabled()
    expect(within(page()).getByRole('checkbox', { name: 'Use the fonts themes choose' })).toBeDisabled()
  })
})
