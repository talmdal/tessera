import { describe, it, expect, vi } from 'vitest'
import { act, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useTheme } from '@mui/material'
import type { ThemeDescriptor } from '@tessera/types'
import { THEME_CHANGED, THEME_PICKER_OPEN, THEMES_CHANGED } from '../../shared/themes/types'
import { DEFAULT_SELECTION, SHELL_THEME_DESCRIPTOR, fakeBridge, layoutOf, renderFrame, view } from '../helpers/layoutFrame'

// Each test builds several MUI themes and drives a Dialog under jsdom, which takes seconds under load.
vi.setConfig({ testTimeout: 30_000 })

const pumpkin: ThemeDescriptor = {
  id: 'halloween.main', label: 'Halloween', pluginId: 'theme-halloween', schemes: ['light', 'dark'],
  light: { palette: { primary: { main: '#b94a00' }, background: { default: '#fff4e3' } } },
  dark: { palette: { primary: { main: '#ff7518' } } },
  swatch: { light: ['#fff4e3', '#ffe9c9', '#b94a00', '#6a0dad'], dark: ['#120a1f', '#1e1233', '#ff7518', '#9d4edd'] }
}
const nightOnly: ThemeDescriptor = { id: 'p.night', label: 'Night', pluginId: 'p', schemes: ['dark'], dark: { palette: { primary: { main: '#0000ee' } } } }

/** A main view reporting the window's theme, so a test can see what the window (not the dialog) renders with. */
function Probe() {
  const theme = useTheme()
  return <p>window primary {theme.palette.primary.main} {theme.palette.mode}</p>
}

async function open(themes = [SHELL_THEME_DESCRIPTOR, pumpkin, nightOnly], selection = DEFAULT_SELECTION) {
  const layout = layoutOf({ main: { views: ['probe'], activeView: 'probe' } })
  const bridge = fakeBridge(layout)
  bridge.themes = themes
  bridge.selection = selection
  const utils = await renderFrame(layout, [view('probe', 'shell.main')], { probe: Probe }, {}, bridge)
  await screen.findByText(/window primary/)
  await bridge.emit(THEME_PICKER_OPEN, { windowId: 1 })
  const dialog = await screen.findByRole('dialog', { name: 'Theme' })
  return { ...utils, bridge, dialog, user: userEvent.setup() }
}

describe('the theme chooser', () => {
  it('opens on the request for its window only, listing the themes by plugin with the choice highlighted', async () => {
    const layout = layoutOf()
    const bridge = fakeBridge(layout)
    bridge.themes = [SHELL_THEME_DESCRIPTOR, pumpkin]
    await renderFrame(layout, [], {}, {}, bridge)

    await bridge.emit(THEME_PICKER_OPEN, { windowId: 2 })
    expect(screen.queryByRole('dialog')).toBeNull()

    await bridge.emit(THEME_PICKER_OPEN, { windowId: 1 })
    const dialog = await screen.findByRole('dialog', { name: 'Theme' })
    expect(within(dialog).getByText('Built in')).toBeInTheDocument()
    expect(within(dialog).getByText('theme-halloween')).toBeInTheDocument()
    const options = within(dialog).getAllByRole('option')
    expect(options).toHaveLength(2)
    expect(options[0]).toHaveAccessibleName(/Tessera/)
    expect(options[1]).toHaveAccessibleName(/Halloween/)
    expect(options[0]).toHaveAttribute('aria-selected', 'true')
    expect(within(options[0]).getByTitle('current theme')).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Light', pressed: true })).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Apply' })).toBeDisabled()   // nothing changed yet
  })

  it('shows the highlighted theme in the sample, and follows the arrow keys', async () => {
    const { dialog, user } = await open()
    const sample = () => within(dialog).getByRole('region', { name: 'Preview' })
    expect(within(sample()).getByRole('button', { name: 'Primary' })).toBeInTheDocument()
    expect(within(sample()).getByText('Salary')).toBeInTheDocument()

    await user.click(within(dialog).getByRole('option', { name: /Halloween/ }))
    expect(within(dialog).getByRole('option', { name: /Halloween/ })).toHaveAttribute('aria-selected', 'true')
    // The sample now has Halloween's page colour; the window does not.
    expect(getComputedStyle(sample().querySelector('[data-theme-sample]')!).backgroundColor).toBe('rgb(255, 244, 227)')
    expect(screen.getByText(/window primary/)).toHaveTextContent('window primary #1976d2 light')

    await user.keyboard('{ArrowDown}')
    expect(within(dialog).getByRole('option', { name: /Night/ })).toHaveAttribute('aria-selected', 'true')
    expect(within(dialog).getByText('dark only')).toBeInTheDocument()
    await user.keyboard('{ArrowDown}')    // wraps
    expect(within(dialog).getByRole('option', { name: /Tessera/ })).toHaveAttribute('aria-selected', 'true')
    await user.keyboard('{ArrowUp}')
    expect(within(dialog).getByRole('option', { name: /Night/ })).toHaveAttribute('aria-selected', 'true')
  })

  it('previews the candidate on the whole window while the switch is on, and restores it on Cancel', async () => {
    const { dialog, user, bridge } = await open()
    await user.click(within(dialog).getByRole('option', { name: /Halloween/ }))
    await user.click(within(dialog).getByRole('button', { name: 'Dark' }))
    expect(screen.getByText(/window primary/)).toHaveTextContent('#1976d2 light')

    await user.click(within(dialog).getByRole('switch', { name: 'Preview in the whole window' }))
    expect(screen.getByText(/window primary/)).toHaveTextContent('#ff7518 dark')
    expect(bridge.themed).toEqual([])                               // nothing was sent

    await user.click(within(dialog).getByRole('button', { name: 'Light' }))
    expect(screen.getByText(/window primary/)).toHaveTextContent('#b94a00 light')   // the preview follows the candidate

    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.getByText(/window primary/)).toHaveTextContent('#1976d2 light')
    expect(bridge.themed).toEqual([])
  })

  it('ends a preview when the dialog is dismissed with Escape', async () => {
    const { user } = await open()
    const dialog = screen.getByRole('dialog')
    await user.click(within(dialog).getByRole('option', { name: /Halloween/ }))
    await user.click(within(dialog).getByRole('switch', { name: 'Preview in the whole window' }))
    expect(screen.getByText(/window primary/)).toHaveTextContent('#b94a00')

    await user.keyboard('{Escape}')
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.getByText(/window primary/)).toHaveTextContent('#1976d2 light')
  })

  it('applies the candidate through the main process and closes once it has answered', async () => {
    const { dialog, user, bridge } = await open()
    await user.click(within(dialog).getByRole('option', { name: /Halloween/ }))
    await user.click(within(dialog).getByRole('button', { name: 'System' }))
    expect(within(dialog).getByText('currently light')).toBeInTheDocument()

    await user.click(within(dialog).getByRole('button', { name: 'Apply' }))
    expect(bridge.themed).toEqual([{ themeId: 'halloween.main', mode: 'system' }])
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    // The main process then pushes the new selection to every window, which is what restyles this one.
    await bridge.emit(THEME_CHANGED, { themeId: 'halloween.main', mode: 'system', resolvedMode: 'light', effectiveThemeId: 'halloween.main' })
    expect(screen.getByText(/window primary/)).toHaveTextContent('#b94a00 light')
  })

  it('stays open and shows the error when the main process refuses', async () => {
    const { dialog, user, bridge } = await open()
    bridge.invoke.mockImplementationOnce(async () => { throw new Error('HANDLER_ERROR: Unknown theme: halloween.main') })
    await user.click(within(dialog).getByRole('option', { name: /Halloween/ }))
    await user.click(within(dialog).getByRole('button', { name: 'Apply' }))

    expect(await within(dialog).findByText(/Unknown theme: halloween.main/)).toBeInTheDocument()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('explains when the chosen theme is missing, and falls back to the choice if the highlighted theme disappears', async () => {
    const missing = { themeId: 'gone.theme', mode: 'light', resolvedMode: 'light', effectiveThemeId: 'shell.default' } as const
    const { dialog, user, bridge } = await open([SHELL_THEME_DESCRIPTOR, pumpkin], missing)
    expect(within(dialog).getByText(/is not available/)).toHaveTextContent(/gone\.theme.*is not available.*Tessera.*is in use/)

    await user.click(within(dialog).getByRole('option', { name: /Halloween/ }))
    bridge.themes = [SHELL_THEME_DESCRIPTOR]
    await bridge.emit(THEMES_CHANGED)
    await act(async () => {})
    expect(within(dialog).queryByRole('option', { name: /Halloween/ })).toBeNull()
    expect(within(dialog).getByRole('button', { name: 'Apply' })).toBeDisabled()   // back to the (missing) choice: nothing to apply
  })
})
