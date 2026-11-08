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
  systemPrefersDark: false
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
})
