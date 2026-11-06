import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ThemeDescriptor, ThemeSnapshot } from '@tessera/types'
import { COMMANDS_EXECUTE } from '../../shared/shellEvents'
import { DEFAULT_THEME, THEME_CHOOSER_OPEN, THEME_COMMANDS, THEME_GET } from '../../shared/theme/types'
import { ShellThemeProvider } from '../../shell/renderer/theme/ShellThemeProvider'
import { ThemeChooser } from '../../shell/renderer/theme/ThemeChooser'
import { createFakeRemote } from '../helpers/fakeBridge'
import { settle } from '../helpers/settle'
import { midnight, sunrise } from '../helpers/theme'

const murky: ThemeDescriptor = {
  id: 'p.murky', label: 'Murky',
  light: { background: { default: '#cccccc', paper: '#cccccc' }, text: { primary: '#bbbbbb', secondary: '#bbbbbb' } },
  dark: { primary: '#90caf9' }
}
const THEMES = [DEFAULT_THEME, sunrise({ id: 'p.sunrise', label: 'Sunrise', light: { primary: '#c2410c' }, dark: { primary: '#fb923c' } }), midnight({ label: 'Midnight' }), murky]

const snapshot = (over: Partial<ThemeSnapshot['state']> = {}, extra: Partial<ThemeSnapshot> = {}): ThemeSnapshot => ({
  state: { windowId: 1, global: { theme: DEFAULT_THEME.id, mode: 'system' }, theme: DEFAULT_THEME.id, mode: 'light', ...over },
  themes: THEMES,
  systemPrefersDark: false,
  ...extra
})

/** The chooser in a themed window 1, with every request answered or recorded by the fake bridge. */
function setup(open: ThemeSnapshot = snapshot(), failWith?: Error) {
  const remote = createFakeRemote({ [THEME_GET]: () => open })
  const answer = remote.bridge.invoke.getMockImplementation()!
  remote.bridge.invoke.mockImplementation(async (channel: string, data?: unknown) => {
    if (channel === COMMANDS_EXECUTE) {
      if (failWith) throw failWith
      return undefined
    }
    return answer(channel, data)
  })

  render(
    <ShellThemeProvider bridge={remote.bridge} initial={snapshot()}>
      <ThemeChooser bridge={remote.bridge} />
    </ShellThemeProvider>)

  const run = () => remote.bridge.invoke.mock.calls.filter((c: unknown[]) => c[0] === COMMANDS_EXECUTE).map((c: any[]) => c[1] as { id: string, args: unknown[] })
  const openIt = async (windowId = 1) => { await act(async () => { remote.emit(THEME_CHOOSER_OPEN, { windowId }) }) }
  return { ...remote, run, openIt }
}

const dialog = () => screen.getByRole('dialog', { name: 'Choose a theme' })
const radio = (name: string) => within(dialog()).getByRole('radio', { name: new RegExp(name) })

describe('the theme chooser: opening', () => {
  it('is not there until the main process asks for it', async () => {
    setup()
    await settle()   // even once everything has loaded

    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('opens in the window it was asked to open in, fetching the current themes as it does', async () => {
    const { openIt, bridge } = setup()
    const before = bridge.invoke.mock.calls.length

    await openIt(1)

    expect(dialog()).toBeInTheDocument()
    expect(bridge.invoke.mock.calls.slice(before).map((c: unknown[]) => c[0])).toContain(THEME_GET)
  })

  it('ignores a request meant for another window', async () => {
    const { openIt } = setup()

    await openIt(2)

    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('stays closed, and logs, if the themes cannot be fetched', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const remote = createFakeRemote({})
    render(<ShellThemeProvider bridge={remote.bridge} initial={snapshot()}><ThemeChooser bridge={remote.bridge} /></ShellThemeProvider>)

    await act(async () => { remote.emit(THEME_CHOOSER_OPEN, { windowId: 1 }) })

    await waitFor(() => expect(error).toHaveBeenCalledWith('[theme] Could not open the theme chooser', expect.any(Error)))
    expect(screen.queryByRole('dialog')).toBeNull()
    error.mockRestore()
  })
})

describe('the theme chooser: choosing', () => {
  afterEach(() => vi.restoreAllMocks())

  it('lists every theme, with the current one selected and a note on those that show one mode only', async () => {
    const { openIt } = setup()
    await openIt()

    const themes = within(dialog()).getByRole('radiogroup', { name: 'Theme' })
    expect(within(themes).getAllByRole('radio').map(r => (r.closest('label') as HTMLElement).textContent)).toEqual([
      'Tessera', 'Sunrise', 'Midnight · Dark only', 'Murky'
    ])
    expect(radio('Tessera')).toBeChecked()
  })

  it('selects a theme with the arrow keys, since the list is a radio group', async () => {
    const user = userEvent.setup()
    const { openIt } = setup()
    await openIt()

    act(() => radio('Tessera').focus())   // focusing changes the radio's own state
    await user.keyboard('{ArrowDown}')

    expect(radio('Sunrise')).toBeChecked()
  })

  it('previews the chosen theme in its own colours before anything is applied', async () => {
    const user = userEvent.setup()
    const { openIt, run } = setup()
    await openIt()
    expect(screen.getByRole('img', { name: 'Preview of the Tessera theme in light mode' })).toBeInTheDocument()

    await user.click(radio('Sunrise'))

    expect(screen.getByRole('img', { name: 'Preview of the Sunrise theme in light mode' })).toBeInTheDocument()
    // The preview is drawn with the theme's own primary colour, not the application's
    expect(document.head.innerHTML.toLowerCase()).toContain('#c2410c')
    expect(run()).toEqual([])
  })

  it('previews the other mode when asked', async () => {
    const user = userEvent.setup()
    const { openIt } = setup()
    await openIt()

    await user.click(within(dialog()).getByRole('button', { name: 'Dark' }))

    expect(screen.getByRole('img', { name: 'Preview of the Tessera theme in dark mode' })).toBeInTheDocument()
  })

  it('previews "follow the system" as whatever the system shows now, and says so', async () => {
    const light = setup(snapshot({}, { systemPrefersDark: false }))
    await light.openIt()
    expect(screen.getByRole('img', { name: 'Preview of the Tessera theme in light mode' })).toBeInTheDocument()
    expect(within(dialog()).getByText(/following the system/)).toBeInTheDocument()
  })

  it('previews the system\'s dark mode when the system is dark', async () => {
    const { openIt } = setup(snapshot({}, { systemPrefersDark: true }))
    await openIt()

    expect(screen.getByRole('img', { name: 'Preview of the Tessera theme in dark mode' })).toBeInTheDocument()
  })

  it('offers only the modes a theme has: a dark-only theme turns System and Light off and shows Dark', async () => {
    const user = userEvent.setup()
    const { openIt } = setup()
    await openIt()

    await user.click(radio('Midnight'))

    const modes = within(dialog())
    expect(modes.getByRole('button', { name: 'System' })).toBeDisabled()
    expect(modes.getByRole('button', { name: 'Light' })).toBeDisabled()
    expect(modes.getByRole('button', { name: 'Dark' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('img', { name: 'Preview of the Midnight theme in dark mode' })).toBeInTheDocument()
  })

  it('remembers the mode you wanted, and gives it back when you return to a theme that has it', async () => {
    const user = userEvent.setup()
    const { openIt } = setup()
    await openIt()
    await user.click(within(dialog()).getByRole('button', { name: 'Light' }))

    await user.click(radio('Midnight'))
    expect(within(dialog()).getByRole('button', { name: 'Dark' })).toHaveAttribute('aria-pressed', 'true')
    await user.click(radio('Sunrise'))

    expect(within(dialog()).getByRole('button', { name: 'Light' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('warns when the previewed theme is hard to read in the previewed mode, and only then', async () => {
    const user = userEvent.setup()
    const { openIt } = setup()
    await openIt()
    expect(within(dialog()).queryByRole('alert')).toBeNull()

    await user.click(radio('Murky'))
    await user.click(within(dialog()).getByRole('button', { name: 'Light' }))
    expect(within(dialog()).getByRole('alert')).toHaveTextContent(/hard to read in light mode: text\.primary on background\.default is \d\.\d:1 \(needs 4\.5:1\)/)

    // Its dark variant is fine, so the warning goes
    await user.click(within(dialog()).getByRole('button', { name: 'Dark' }))
    expect(within(dialog()).queryByRole('alert')).toBeNull()
  })
})

describe('the theme chooser: applying', () => {
  it('cannot apply what is already in use', async () => {
    const { openIt } = setup()
    await openIt()

    expect(within(dialog()).getByRole('button', { name: 'Apply' })).toBeDisabled()
  })

  it('applies a theme and mode to the whole application, then closes', async () => {
    const user = userEvent.setup()
    const { openIt, run } = setup()
    await openIt()
    await user.click(radio('Sunrise'))
    await user.click(within(dialog()).getByRole('button', { name: 'Dark' }))

    await user.click(within(dialog()).getByRole('button', { name: 'Apply' }))

    expect(run()).toEqual([{ id: THEME_COMMANDS.set, args: [{ theme: 'p.sunrise', mode: 'dark' }] }])
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('applies "follow the system" as the system mode, not as what the preview happened to show', async () => {
    const user = userEvent.setup()
    const { openIt, run } = setup(snapshot({ global: { theme: DEFAULT_THEME.id, mode: 'dark' }, mode: 'dark' }))
    await openIt()
    await user.click(within(dialog()).getByRole('button', { name: 'System' }))

    await user.click(within(dialog()).getByRole('button', { name: 'Apply' }))

    expect(run()).toEqual([{ id: THEME_COMMANDS.set, args: [{ theme: DEFAULT_THEME.id, mode: 'system' }] }])
  })

  it('applies to this window only, leaving the application alone', async () => {
    const user = userEvent.setup()
    const { openIt, run } = setup()
    await openIt()
    await user.click(radio('Midnight'))
    await user.click(within(dialog()).getByRole('radio', { name: 'In this window only' }))

    await user.click(within(dialog()).getByRole('button', { name: 'Apply' }))

    expect(run()).toEqual([{ id: THEME_COMMANDS.setForWindow, args: [{ theme: 'p.midnight', mode: 'dark' }] }])
  })

  it('starts on "this window only" when the window has a theme of its own, with that theme selected', async () => {
    const { openIt } = setup(snapshot({ theme: 'p.midnight', mode: 'dark', override: { theme: 'p.midnight', mode: 'dark' } }))
    await openIt()

    expect(within(dialog()).getByRole('radio', { name: 'In this window only' })).toBeChecked()
    expect(radio('Midnight')).toBeChecked()
    expect(within(dialog()).getByRole('button', { name: 'Apply' })).toBeDisabled()
  })

  it('replaces a window\'s own theme when applying to everywhere, and says it will', async () => {
    const user = userEvent.setup()
    const { openIt, run } = setup(snapshot({ theme: 'p.midnight', mode: 'dark', override: { theme: 'p.midnight', mode: 'dark' } }))
    await openIt()

    await user.click(within(dialog()).getByRole('radio', { name: 'Everywhere' }))
    expect(within(dialog()).getByText(/choosing Everywhere replaces it/)).toBeInTheDocument()
    await user.click(within(dialog()).getByRole('button', { name: 'Apply' }))

    expect(run().map((c: { id: string }) => c.id)).toEqual([THEME_COMMANDS.set, THEME_COMMANDS.clearWindowOverride])
  })

  it('closes without changing anything on Cancel and on Escape', async () => {
    const user = userEvent.setup()
    const { openIt, run } = setup()
    await openIt()
    await user.click(radio('Sunrise'))

    await user.click(within(dialog()).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await openIt()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    expect(run()).toEqual([])
  })

  it('shows why when the main process refuses, keeps the dialog open, and lets the user try again', async () => {
    const user = userEvent.setup()
    const { openIt } = setup(snapshot(), new Error('HANDLER_ERROR: Theme "p.sunrise" has a single variant'))
    await openIt()
    await user.click(radio('Sunrise'))

    await user.click(within(dialog()).getByRole('button', { name: 'Apply' }))

    await waitFor(() => expect(within(dialog()).getByText('Theme "p.sunrise" has a single variant')).toBeInTheDocument())
    expect(dialog()).toBeInTheDocument()
    expect(within(dialog()).getByRole('button', { name: 'Apply' })).toBeEnabled()
    expect(within(dialog()).getByRole('button', { name: 'Cancel' })).toBeEnabled()
  })
})

describe('the theme preview', () => {
  it('is described, not exposed as controls, and cannot be reached with the keyboard', async () => {
    const { openIt } = setup()
    await openIt()

    const preview = screen.getByRole('img', { name: /Preview of the/ })
    expect(preview).toHaveAttribute('inert')
    // Its buttons are part of the picture: they are out of the tab order
    for (const button of preview.querySelectorAll('button')) expect(button).toHaveAttribute('tabindex', '-1')
  })

  it('shows the parts of the application a theme colours', async () => {
    const { openIt } = setup()
    await openIt()

    const preview = screen.getByRole('img', { name: /Preview of the/ })
    for (const text of ['Tessera', 'Accounts', 'Reports', 'Account summary', 'Most recent', 'Primary', 'Outlined', 'Disabled', 'error', 'warning', 'info', 'success']) {
      expect(within(preview).getAllByText(new RegExp(text)).length, text).toBeGreaterThan(0)
    }
  })
})
