// The Appearance page: where the application theme is chosen, driven by the dialog's draft like any other page.
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OptionsPageProps, ThemeSnapshot } from '@tessera/types'
import { ShellOptionsValue } from '../../shared/options/types'
import { DEFAULT_THEME, DEFAULT_THEME_ID, THEME_GET } from '../../shared/theme/types'
import { AppearancePage } from '../../shell/renderer/options/AppearancePage'
import { midnight, sunrise } from '../helpers/theme'

const SHELL = DEFAULT_THEME_ID
const THEMES = [DEFAULT_THEME, sunrise(), midnight()]

function setup(over: Partial<OptionsPageProps<ShellOptionsValue>> & { themes?: typeof THEMES, systemPrefersDark?: boolean } = {}) {
  const { themes = THEMES, systemPrefersDark = false, ...props } = over

  const snapshot: ThemeSnapshot = {
    state: { windowId: 1, global: { theme: SHELL, mode: 'system' }, theme: SHELL, mode: 'light' },
    themes,
    systemPrefersDark
  }
  const invoke = vi.fn(async (channel: string) => {
    if (channel !== THEME_GET) throw new Error(`No answer for ${channel}`)
    return snapshot
  })
  ;(window as { api?: unknown }).api = { invoke }

  const onChange = vi.fn()
  render(<AppearancePage
    value={{ appearance: { theme: SHELL, mode: 'system' } }}
    defaults={{ appearance: { theme: SHELL, mode: 'system' } }}
    onChange={onChange}
    onValidityChange={vi.fn()}
    disabled={false}
    {...props} />)

  return { invoke, onChange }
}

afterEach(() => { delete (window as { api?: unknown }).api })

const radio = (name: string | RegExp) => screen.getByRole('radio', { name })
const mode = (name: string) => screen.getByRole('button', { name })

describe('the Appearance page', () => {
  it('lists the registered themes with the chosen one selected, and a preview of it', async () => {
    setup()

    await waitFor(() => expect(radio(/Tessera/)).toBeChecked())
    expect(radio(/Sunrise/)).not.toBeChecked()
    expect(radio(/Midnight · Dark only/)).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /Preview/ })).toHaveTextContent('Tessera, light mode (following the system)')
  })

  it('edits the draft when a theme is picked, keeping the wished mode', async () => {
    const { onChange } = setup({ value: { appearance: { theme: SHELL, mode: 'dark' } } })
    await waitFor(() => radio(/Sunrise/))

    await userEvent.click(radio(/Sunrise/))

    expect(onChange).toHaveBeenCalledWith({ appearance: { theme: 'p.sunrise', mode: 'dark' } })
  })

  it("uses a single-variant theme's own mode when it cannot show the wished one", async () => {
    const { onChange } = setup()
    await waitFor(() => radio(/Midnight/))

    await userEvent.click(radio(/Midnight/))

    expect(onChange).toHaveBeenCalledWith({ appearance: { theme: 'p.midnight', mode: 'dark' } })
  })

  it('edits the draft when the mode changes, and never the application', async () => {
    const { onChange, invoke } = setup()
    await waitFor(() => mode('Dark'))

    await userEvent.click(mode('Dark'))

    expect(onChange).toHaveBeenCalledWith({ appearance: { theme: SHELL, mode: 'dark' } })
    expect(invoke.mock.calls.every(call => call[0] === THEME_GET)).toBe(true)   // reads only; the dialog saves
  })

  it('offers only the modes the chosen theme has', async () => {
    setup({ value: { appearance: { theme: 'p.midnight', mode: 'dark' } } })
    await waitFor(() => mode('System'))

    expect(mode('System')).toBeDisabled()
    expect(mode('Light')).toBeDisabled()
    expect(mode('Dark')).toBeEnabled()
  })

  it('says so when the chosen theme is not available, keeping the choice visible', async () => {
    setup({ value: { appearance: { theme: 'p.gone', mode: 'dark' } } })

    await waitFor(() => screen.getByText(/not available right now/))
    expect(screen.getByText(/p\.gone/)).toBeInTheDocument()
    await waitFor(() => expect(radio(/Tessera/)).toBeChecked())   // the default stands in
  })

  it('warns when the previewed combination is hard to read', async () => {
    const murky = sunrise({
      id: 'p.murky', label: 'Murky',
      light: { background: { default: '#cccccc', paper: '#cccccc' }, text: { primary: '#bbbbbb', secondary: '#bbbbbb' } }
    })
    setup({ value: { appearance: { theme: 'p.murky', mode: 'light' } }, themes: [DEFAULT_THEME, murky] })

    await waitFor(() => screen.getByText(/hard to read in light mode/))
  })

  it('disables its controls while the dialog is committing', async () => {
    setup({ disabled: true })
    await waitFor(() => radio(/Tessera/))

    expect(radio(/Tessera/)).toBeDisabled()
    expect(mode('Dark')).toBeDisabled()
  })

  it('shows what went wrong when the themes cannot be read', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    ;(window as { api?: unknown }).api = { invoke: vi.fn(async () => { throw new Error('no themes') }) }

    render(<AppearancePage value={{ appearance: { theme: SHELL, mode: 'system' } }}
      defaults={{ appearance: { theme: SHELL, mode: 'system' } }}
      onChange={vi.fn()} onValidityChange={vi.fn()} disabled={false} />)

    await waitFor(() => screen.getByText(/could not be read: no themes/))
    quiet.mockRestore()
  })
})
