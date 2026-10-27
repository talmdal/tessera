import type { ThemeSetRequest, ThemeState } from '@tessera/types'
import { describe, it, expect, vi } from 'vitest'
import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { emptyLayout } from '../../shared/layout/types'
import { builtinThemeState } from '../../shared/theme/builtin'
import { THEME_CHANGED, THEME_CHOOSE_REQUESTED, THEME_GET, THEME_SET } from '../../shared/theme/types'
import { ShellStateProvider } from '../../shell/renderer/state/ShellState'
import { ThemeChooser } from '../../shell/renderer/theme/ThemeChooser'

const WINDOW_ID = 4

/** A bridge with a tiny theme "service": set requests apply to the state and push the change event. */
function setup(initial: ThemeState = withSepia(builtinThemeState('light'))) {
  let state = initial
  const listeners = new Map<string, Set<(data: any) => void>>()
  const emit = (name: string, data?: unknown) => listeners.get(name)?.forEach(l => l(data))
  const sets: ThemeSetRequest[] = []

  const bridge = {
    invoke: vi.fn(async (channel: string, data?: unknown) => {
      if (channel === 'shell:lifecycle.get') return 'started'
      if (channel === 'shell:contextKeys.snapshot') return {}
      if (channel === 'shell:layout.get') return emptyLayout(WINDOW_ID)
      if (channel === THEME_GET) return state
      if (channel === THEME_SET) {
        const request = data as ThemeSetRequest
        sets.push(request)
        const preference = { ...state.preference, ...request }
        const active = preference.theme === 'system' ? preference.light : preference.theme
        const kind = state.themes.find(t => t.id === active)?.kind ?? 'light'
        state = { ...builtinThemeState(kind), themes: state.themes, preference, activeTheme: active }
        emit(THEME_CHANGED, state)
        return state
      }
      throw new Error(`Unexpected request ${channel}`)
    }),
    on: vi.fn((name: string, listener: (data: any) => void) => {
      if (!listeners.has(name)) listeners.set(name, new Set())
      listeners.get(name)!.add(listener)
      return () => { listeners.get(name)!.delete(listener) }
    })
  }

  render(
    <ShellStateProvider bridge={bridge as any}>
      <button type="button">Opener</button>
      <ThemeChooser />
    </ShellStateProvider>
  )

  const open = async (windowId?: number) => {
    await act(async () => {})                                    // the snapshots, including this window's id
    act(() => { emit(THEME_CHOOSE_REQUESTED, { windowId }) })
  }
  return { bridge, sets, open, state: () => state }
}

function withSepia(state: ThemeState): ThemeState {
  return { ...state, themes: [...state.themes, { id: 'm.sepia', label: 'Sample Sepia', kind: 'light', pluginId: 'm' }] }
}

describe('ThemeChooser', () => {
  it('stays closed until asked, and opens only for its own window', async () => {
    const { open } = setup()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    await open(99)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    await open(WINDOW_ID)
    expect(screen.getByRole('dialog', { name: 'Choose Theme' })).toBeInTheDocument()
  })

  it('opens in every window when no window was focused', async () => {
    const { open } = setup()
    await open(undefined)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('lists follow-system and the themes by kind, with the current choice checked and focused', async () => {
    const { open } = setup()
    await open(WINDOW_ID)
    const dialog = screen.getByRole('dialog')

    expect(within(dialog).getByRole('radio', { name: /Follow the system/ })).toBeChecked()
    expect(within(dialog).getByRole('radio', { name: /Follow the system/ })).toHaveFocus()
    expect(within(dialog).getByText('now light')).toBeInTheDocument()

    const light = within(dialog).getByRole('region', { name: 'Light themes' })
    expect(within(light).getAllByRole('radio').map(r => (r as HTMLInputElement).value)).toEqual(['shell.light', 'm.sepia'])
    expect(within(light).getByText('from m')).toBeInTheDocument()
    const dark = within(dialog).getByRole('region', { name: 'Dark themes' })
    expect(within(dark).getAllByRole('radio').map(r => (r as HTMLInputElement).value)).toEqual(['shell.dark'])

    // Following the system: the per-kind picks are editable
    expect(within(dialog).getByLabelText('When light:')).toHaveValue('shell.light')
    expect(within(dialog).getByLabelText('When dark:')).toHaveValue('shell.dark')
  })

  it('previews each choice at once, and OK keeps the last one', async () => {
    const { sets, open, state } = setup()
    await open(WINDOW_ID)
    const dialog = screen.getByRole('dialog')

    await act(async () => { await userEvent.click(within(dialog).getByRole('radio', { name: /Tessera Dark/ })) })
    expect(sets).toEqual([{ theme: 'shell.dark' }])
    expect(state().activeTheme).toBe('shell.dark')
    expect(within(dialog).getByRole('radio', { name: /Tessera Dark/ })).toBeChecked()
    expect(within(dialog).queryByLabelText('When light:')).not.toBeInTheDocument()   // not following the system now

    await act(async () => { await userEvent.click(within(dialog).getByRole('radio', { name: /Sample Sepia/ })) })
    await act(async () => { await userEvent.click(within(dialog).getByRole('button', { name: 'OK' })) })

    expect(sets).toEqual([{ theme: 'shell.dark' }, { theme: 'm.sepia' }])
    expect(state().activeTheme).toBe('m.sepia')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Opener' })).not.toHaveFocus()   // focus was elsewhere before; nothing to restore
  })

  it('Cancel and Escape put the opening preference back', async () => {
    const { sets, open, state } = setup()
    await open(WINDOW_ID)

    await act(async () => { await userEvent.click(screen.getByRole('radio', { name: /Tessera Dark/ })) })
    await act(async () => { await userEvent.click(screen.getByRole('button', { name: 'Cancel' })) })

    expect(sets).toEqual([{ theme: 'shell.dark' }, { theme: 'system', light: 'shell.light', dark: 'shell.dark' }])
    expect(state().activeTheme).toBe('shell.light')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    await open(WINDOW_ID)
    await act(async () => { await userEvent.click(screen.getByRole('radio', { name: /Sample Sepia/ })) })
    await act(async () => { await userEvent.keyboard('{Escape}') })
    expect(sets.at(-1)).toEqual({ theme: 'system', light: 'shell.light', dark: 'shell.dark' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('edits the per-kind system themes while following the system', async () => {
    const { sets, open } = setup()
    await open(WINDOW_ID)

    await act(async () => { await userEvent.selectOptions(screen.getByLabelText('When light:'), 'm.sepia') })

    expect(sets).toEqual([{ light: 'm.sepia' }])
    expect(screen.getByLabelText('When light:')).toHaveValue('m.sepia')
  })

  it('keeps Tab inside the dialog', async () => {
    const { open } = setup()
    await open(WINDOW_ID)
    const dialog = screen.getByRole('dialog')
    const ok = within(dialog).getByRole('button', { name: 'OK' })
    const first = within(dialog).getByRole('radio', { name: /Follow the system/ })

    ok.focus()
    await act(async () => { await userEvent.tab() })
    expect(first).toHaveFocus()

    await act(async () => { await userEvent.tab({ shift: true }) })
    expect(ok).toHaveFocus()
  })

  it('gives focus back to the element that had it', async () => {
    const { open } = setup()
    await act(async () => {})
    screen.getByRole('button', { name: 'Opener' }).focus()

    await open(WINDOW_ID)
    expect(screen.getByRole('button', { name: 'Opener' })).not.toHaveFocus()

    await act(async () => { await userEvent.click(screen.getByRole('button', { name: 'OK' })) })
    expect(screen.getByRole('button', { name: 'Opener' })).toHaveFocus()
  })
})
