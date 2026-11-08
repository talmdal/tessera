import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import type { SettingsCommitResult, ThemeDescriptor, ThemeSelection, ThemeSnapshot } from '@tessera/types'
import { SETTINGS_COMMIT, SETTINGS_GET, SETTINGS_OPEN, SettingsCatalogue, SettingsCommitRequest } from '../../shared/settings/types'
import { THEME_SETTINGS_ID, THEME_SETTINGS_MODULE, THEME_SETTINGS_PAGE } from '../../shared/theme/settings'
import { DEFAULT_THEME, THEME_CHANGED, THEME_GET } from '../../shared/theme/types'
import { SettingsDialog } from '../../shell/renderer/settings/SettingsDialog'
import { ShellThemeProvider } from '../../shell/renderer/theme/ShellThemeProvider'
import { ThemeGallery } from '../../shell/renderer/theme/ThemeGallery'
import { createFakeRemote } from '../helpers/fakeBridge'
import { midnight, sunrise } from '../helpers/theme'
import { DEFAULT_FONT_SETTINGS } from '../../shared/fonts/resolveFonts'

const murky: ThemeDescriptor = {
  id: 'p.murky', label: 'Murky',
  light: { background: { default: '#cccccc', paper: '#cccccc' }, text: { primary: '#bbbbbb', secondary: '#bbbbbb' } },
  dark: { primary: '#90caf9' }
}
const THEMES = [
  DEFAULT_THEME,
  sunrise({ id: 'p.sunrise', label: 'Sunrise', description: 'Warm oranges for early starts.', light: { primary: '#c2410c' }, dark: { primary: '#fb923c' } }),
  midnight({ label: 'Midnight' }),
  murky
]

const SYSTEM: ThemeSelection = { theme: DEFAULT_THEME.id, mode: 'system' }

const snapshot = (over: Partial<ThemeSnapshot['state']> = {}, themes = THEMES): ThemeSnapshot => ({
  state: { windowId: 1, global: SYSTEM, theme: DEFAULT_THEME.id, mode: 'light', ...over },
  themes,
  systemPrefersDark: false,
  fonts: DEFAULT_FONT_SETTINGS
})

const appearance = { id: THEME_SETTINGS_PAGE, title: 'Appearance', pluginId: 'shell', settings: THEME_SETTINGS_ID, module: THEME_SETTINGS_MODULE, keywords: ['theme'] }

/** The Options dialog, as the shell shows it, with the Appearance page and the theme setting at `value`. */
function setup({ value = SYSTEM, theme = snapshot() }: { value?: ThemeSelection, theme?: ThemeSnapshot } = {}) {
  const catalogue: SettingsCatalogue = {
    pages: [appearance],
    namespaces: [{ id: THEME_SETTINGS_ID, owner: 'shell', value: { theme: value.theme, mode: value.mode }, defaults: { theme: SYSTEM.theme, mode: SYSTEM.mode } }]
  }
  const remote = createFakeRemote({ [THEME_GET]: () => theme, [SETTINGS_GET]: () => catalogue })
  const answer = remote.bridge.invoke.getMockImplementation()!
  const commits: SettingsCommitRequest[] = []
  remote.bridge.invoke.mockImplementation(async (channel: string, data?: unknown) => {
    if (channel !== SETTINGS_COMMIT) return answer(channel, data)
    const request = data as SettingsCommitRequest
    commits.push(structuredClone(request))
    return { ok: true, namespaces: request.changes.map(c => ({ ...catalogue.namespaces[0], value: c.value as never })) } satisfies SettingsCommitResult
  })

  render(
    <ShellThemeProvider bridge={remote.bridge} initial={theme}>
      <SettingsDialog bridge={remote.bridge} loader={{ load: vi.fn() }} />
    </ShellThemeProvider>)

  const open = async () => { await act(async () => { remote.emit(SETTINGS_OPEN, { windowId: 1 }) }) }
  return { ...remote, commits, open }
}

const page = () => screen.getByRole('region', { name: 'Appearance' })
const gallery = () => within(page()).getByRole('radiogroup', { name: 'Theme' })
const card = (name: string) => within(gallery()).getByRole('radio', { name })
const mode = (name: string) => within(page()).getByRole('button', { name })
const button = (name: string) => within(screen.getByRole('dialog', { name: 'Options' })).getByRole('button', { name })

describe('the Appearance page', () => {
  it('is the shell\'s own page in the Options dialog, showing every theme with the chosen one checked', async () => {
    const { open } = setup()
    await open()

    expect(within(gallery()).getAllByRole('radio').map(r => r.getAttribute('data-theme-id'))).toEqual([DEFAULT_THEME.id, 'p.sunrise', 'p.midnight', 'p.murky'])
    expect(card('Tessera')).toHaveAttribute('aria-checked', 'true')
    expect(card('Sunrise')).toHaveAccessibleDescription('Warm oranges for early starts. · From p')
    expect(card('Midnight')).toHaveAccessibleDescription('Dark only · From p')
    expect(mode('System')).toHaveAttribute('aria-pressed', 'true')
  })

  it('changes only the draft until OK, which applies the theme and mode chosen', async () => {
    const { open, commits } = setup()
    await open()

    await userEvent.click(card('Sunrise'))
    await userEvent.click(mode('Dark'))

    expect(commits).toEqual([])
    expect(card('Sunrise')).toHaveAttribute('aria-checked', 'true')
    await userEvent.click(button('OK'))

    expect(commits).toEqual([{ changes: [{ id: THEME_SETTINGS_ID, value: { theme: 'p.sunrise', mode: 'dark' } }] }])
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('shows a theme without the mode asked for in the mode it has, and brings the wish back with one that has it', async () => {
    const { open, commits } = setup()
    await open()

    await userEvent.click(card('Midnight'))
    expect(mode('Dark')).toHaveAttribute('aria-pressed', 'true')
    expect(mode('System')).toBeDisabled()
    expect(mode('Light')).toBeDisabled()

    await userEvent.click(card('Sunrise'))
    expect(mode('System')).toHaveAttribute('aria-pressed', 'true')
    await userEvent.click(button('Apply'))
    expect(commits.at(-1)).toEqual({ changes: [{ id: THEME_SETTINGS_ID, value: { theme: 'p.sunrise', mode: 'system' } }] })
  })

  it('previews the chosen theme, and warns when it may be hard to read', async () => {
    const { open } = setup()
    await open()
    expect(within(page()).getByRole('img', { name: 'Preview of the Tessera theme in light mode' })).toBeInTheDocument()

    await userEvent.click(card('Murky'))
    await userEvent.click(mode('Light'))

    expect(within(page()).getByRole('img', { name: 'Preview of the Murky theme in light mode' })).toBeInTheDocument()
    expect(within(page()).getByText(/may be hard to read in light mode/)).toBeInTheDocument()
  })

  it("previews a theme in its own fonts, under the user's, and says when the user turned themes' fonts off", async () => {
    const serif = sunrise({ id: 'p.serif', label: 'Ledger Book', light: { primary: '#7c2d12' }, fonts: { heading: { family: ['Georgia', 'serif'] }, ui: { size: 14 } } })
    const user = { ...DEFAULT_FONT_SETTINGS, roles: { ...DEFAULT_FONT_SETTINGS.roles, ui: { family: null, size: 16, weight: null } } }
    const { open } = setup({ theme: { ...snapshot({}, [...THEMES, serif]), fonts: user } })
    await open()
    await userEvent.click(card('Ledger Book'))

    const preview = within(page()).getByRole('img', { name: /Preview of the Ledger Book theme/ })
    // The theme's headings, and the user's size over the theme's 14
    expect(getComputedStyle(within(preview).getByText('Account summary')).fontFamily.startsWith('"Georgia", serif')).toBe(true)
    expect(getComputedStyle(within(preview).getByText('Balance after the latest transactions.')).fontSize).toBe('1rem')
    expect(within(page()).queryByText(/themes' fonts are turned off/)).toBeNull()
  })

  it("says a theme's fonts aren't used while themes' fonts are off", async () => {
    const serif = sunrise({ id: 'p.serif', label: 'Ledger Book', fonts: { heading: { family: ['Georgia', 'serif'] } } })
    const { open } = setup({ theme: { ...snapshot({}, [...THEMES, serif]), fonts: { ...DEFAULT_FONT_SETTINGS, useThemeFonts: false } } })
    await open()
    await userEvent.click(card('Ledger Book'))

    expect(within(page()).getByText(/Ledger Book sets fonts of its own \(Headings \(Georgia\)\), but themes' fonts are turned off/)).toBeInTheDocument()
    const preview = within(page()).getByRole('img', { name: /Preview of the Ledger Book theme/ })
    expect(getComputedStyle(within(preview).getByText('Account summary')).fontFamily.startsWith('"Georgia"')).toBe(false)
  })

  it("previews a theme in the user's fonts, as choosing it would show it", async () => {
    const fonts = { ...DEFAULT_FONT_SETTINGS, roles: { ...DEFAULT_FONT_SETTINGS.roles, ui: { family: ['Inter'], size: 16, weight: null } } }
    const { open } = setup({ theme: { ...snapshot(), fonts } })
    await open()

    const preview = within(page()).getByRole('img', { name: 'Preview of the Tessera theme in light mode' })
    const text = within(preview).getByText('Balance after the latest transactions.')
    // body2 at an interface size of 16 px
    expect(getComputedStyle(text).fontSize).toBe('1rem')
    expect(getComputedStyle(text).fontFamily.startsWith('"Inter"')).toBe(true)
  })

  it('says what "System" follows now', async () => {
    const { open } = setup({ theme: { ...snapshot(), systemPrefersDark: true } })
    await open()
    expect(within(page()).getByText('Follows your system, which is set to dark now.')).toBeInTheDocument()
  })

  it('restores the shell\'s theme, following the system', async () => {
    const { open } = setup({ value: { theme: 'p.midnight', mode: 'dark' } })
    await open()

    await userEvent.click(button('Restore Defaults'))

    expect(card('Tessera')).toHaveAttribute('aria-checked', 'true')
    expect(mode('System')).toHaveAttribute('aria-pressed', 'true')
  })

  it('says so when this window has a theme of its own, which applying here replaces', async () => {
    const { open } = setup({ theme: snapshot({ override: { theme: 'p.midnight', mode: 'dark' }, theme: 'p.midnight', mode: 'dark' }) })
    await open()
    expect(within(page()).getByText(/This window has a theme of its own \(Midnight\)/)).toBeInTheDocument()
  })

  it('keeps a chosen theme whose plugin is missing, saying so, until another is chosen', async () => {
    const { open, commits } = setup({ value: { theme: 'gone.theme', mode: 'dark' } })
    await open()

    expect(within(page()).getByText(/The chosen theme, “gone.theme”, is not available/)).toBeInTheDocument()
    expect(within(gallery()).getAllByRole('radio').every(r => r.getAttribute('aria-checked') === 'false')).toBe(true)

    await userEvent.click(mode('Light'))
    await userEvent.click(button('Apply'))
    expect(commits.at(-1)).toEqual({ changes: [{ id: THEME_SETTINGS_ID, value: { theme: 'gone.theme', mode: 'light' } }] })
  })

  it('lists a theme a plugin contributes while the page is open', async () => {
    const { open, emit } = setup()
    await open()
    const rising = sunrise({ id: 'q.dawn', label: 'Dawn' })

    await act(async () => { emit(THEME_CHANGED, snapshot({}, [...THEMES, rising])) })

    expect(card('Dawn')).toBeInTheDocument()
  })
})

describe('the theme gallery', () => {
  function Gallery({ themes }: { themes: ThemeDescriptor[] }) {
    const [selected, setSelected] = useState(themes[0].id)
    return (
      <>
        <span id="label">Theme</span>
        <ThemeGallery themes={themes} selected={selected} onSelect={setSelected} modeOf={() => 'light'} labelledBy="label" />
      </>
    )
  }
  /** The gallery, and queries scoped to it. */
  const renderGallery = (themes = THEMES) => {
    const remote = createFakeRemote({ [THEME_GET]: () => snapshot() })
    const { container } = render(<ShellThemeProvider bridge={remote.bridge} initial={snapshot()}><Gallery themes={themes} /></ShellThemeProvider>)
    return within(container)
  }
  const radios = () => screen.getAllByRole('radio')

  it('moves the choice with the arrow keys, Home and End, and has one tab stop', async () => {
    renderGallery()
    expect(radios().map(r => r.tabIndex)).toEqual([0, -1, -1, -1])

    await userEvent.tab()
    await userEvent.keyboard('{ArrowRight}')
    expect(screen.getByRole('radio', { name: 'Sunrise' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('radio', { name: 'Sunrise' })).toHaveFocus()

    await userEvent.keyboard('{End}')
    expect(screen.getByRole('radio', { name: 'Murky' })).toHaveAttribute('aria-checked', 'true')
    await userEvent.keyboard('{ArrowDown}')
    expect(screen.getByRole('radio', { name: 'Tessera' })).toHaveAttribute('aria-checked', 'true')
    await userEvent.keyboard('{ArrowLeft}')
    expect(screen.getByRole('radio', { name: 'Murky' })).toHaveFocus()
    expect(radios().map(r => r.tabIndex)).toEqual([-1, -1, -1, 0])
  })

  it('offers a filter once there are many themes, by name, description or plugin', async () => {
    expect(renderGallery(THEMES).queryByRole('textbox', { name: 'Filter themes' })).toBeNull()

    const many = renderGallery([...THEMES, ...['Ash', 'Birch', 'Cedar'].map(label => sunrise({ id: `woods.${label.toLowerCase()}`, label }))])
    const filter = many.getByRole('textbox', { name: 'Filter themes' })
    const shown = () => many.getAllByRole('radio').map(r => r.getAttribute('data-theme-id'))

    await userEvent.type(filter, 'early')
    expect(shown()).toEqual(['p.sunrise'])

    await userEvent.clear(filter)
    await userEvent.type(filter, 'woods')
    expect(shown()).toEqual(['woods.ash', 'woods.birch', 'woods.cedar'])

    await userEvent.clear(filter)
    await userEvent.type(filter, 'zebra')
    expect(many.getByText('No theme matches “zebra”.')).toBeInTheDocument()
  })

  it('says what fonts a theme sets, draws its name in its own font, and finds it by them', async () => {
    const serif = sunrise({ id: 'p.serif', label: 'Ledger Book', fonts: { heading: { family: ['Georgia', 'serif'], weight: 600 }, numeric: { family: ['Cascadia Mono'] } } })
    const many = renderGallery([...THEMES, serif, ...['Ash', 'Birch'].map(label => sunrise({ id: `woods.${label.toLowerCase()}`, label }))])

    const ledgerBook = many.getByRole('radio', { name: 'Ledger Book' })
    expect(ledgerBook).toHaveAccessibleDescription('Sets fonts: Headings (Georgia, Semibold), Amounts and figures (Cascadia Mono) · From p')
    expect(getComputedStyle(within(ledgerBook).getByText('Ledger Book')).fontFamily.startsWith('"Georgia", serif')).toBe(true)
    // A theme that sets no fonts keeps the page's
    expect(getComputedStyle(within(many.getByRole('radio', { name: 'Midnight' })).getByText('Midnight')).fontFamily.startsWith('"Georgia"')).toBe(false)

    await userEvent.type(many.getByRole('textbox', { name: 'Filter themes' }), 'cascadia')
    expect(many.getAllByRole('radio').map(r => r.getAttribute('data-theme-id'))).toEqual(['p.serif'])
  })
})
