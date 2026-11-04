// The shell's own components are built on MUI through @tessera/ui. These cover what that changed; the
// behaviour of the frame itself (roles, names, gestures) is in layoutController.test.tsx and layoutFeatures.test.tsx.
import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { BorderItemDescriptor } from '@tessera/types'
import { DEFAULT_THEME, THEME_GET } from '../../shared/theme/types'
import { ShellThemeProvider } from '../../shell/renderer/theme/ShellThemeProvider'
import { createFakeRemote } from '../helpers/fakeBridge'
import { Frame, fakeBridge, layoutOf, view } from '../helpers/layoutFrame'

const leftViews = [view('accounts', 'shell.left', { icon: 'Home' }), view('categories', 'shell.left', { icon: 'List' })]
const barOf = (side: 'top' | 'bottom' | 'left' | 'right', extra: object = {}) =>
  layoutOf({ bars: { [side]: { views: ['accounts', 'categories'], activeView: 'accounts', ...extra } } })

const button = (id: string, extra: Partial<BorderItemDescriptor> = {}): BorderItemDescriptor =>
  ({ kind: 'button', id, slot: 'shell.top', label: `Label ${id}`, command: `p.${id}`, pluginId: 'p', enabled: true, ...extra }) as BorderItemDescriptor

/** The frame inside the shell's theme, as the app renders it. */
function renderThemed(snapshot = barOf('left'), views = leftViews, mode: 'light' | 'dark' = 'dark', items: BorderItemDescriptor[] = []) {
  const bridge = fakeBridge(snapshot, items)
  const theme = { state: { windowId: 1, global: { theme: DEFAULT_THEME.id, mode }, theme: DEFAULT_THEME.id, mode }, themes: [DEFAULT_THEME] }
  const { bridge: themeBridge } = createFakeRemote({ [THEME_GET]: () => theme })
  return {
    bridge,
    ...render(
      <ShellThemeProvider bridge={themeBridge} initial={theme}>
        <Frame bridge={bridge} views={views} load={async v => () => <p>Content of {v.id}</p>} />
      </ShellThemeProvider>)
  }
}

describe('the bar tab strip', () => {
  it('is a MUI tab list named for its bar, with a tab for each view and the active one selected', async () => {
    renderThemed()
    await act(async () => {})

    const list = screen.getByRole('tablist', { name: 'Left bar views' })
    expect(within(list).getAllByRole('tab').map(t => [t.textContent, t.getAttribute('aria-selected')])).toEqual([
      ['Title accounts', 'true'], ['Title categories', 'false']
    ])
    expect(list.closest('.MuiTabs-root')).toBeInTheDocument()
  })

  it('draws each view\'s icon in its tab, hidden from assistive technology so the name stays the title', async () => {
    renderThemed()
    await act(async () => {})

    const tab = screen.getByRole('tab', { name: 'Title accounts' })
    expect(tab.querySelector('svg[data-icon="Home"]')).toBeInTheDocument()
    expect(tab.querySelector('svg[data-icon="Home"]')).toHaveAttribute('aria-hidden', 'true')
  })

  it('links each tab to its panel', async () => {
    renderThemed()
    await act(async () => {})

    const tab = screen.getByRole('tab', { name: 'Title accounts' })
    expect(tab).toHaveAttribute('id', 'tab-accounts')
    expect(tab).toHaveAttribute('aria-controls', 'panel-accounts')
    expect(document.getElementById('panel-accounts')).toHaveAttribute('aria-labelledby', 'tab-accounts')
  })

  it('moves focus between tabs with the arrow keys, and choosing one reports it', async () => {
    const user = userEvent.setup()
    const { bridge } = renderThemed()
    await act(async () => {})

    await user.click(screen.getByRole('tab', { name: 'Title accounts' }))
    await user.keyboard('{ArrowRight}')
    expect(screen.getByRole('tab', { name: 'Title categories' })).toHaveFocus()
    await user.keyboard('{Enter}')

    expect(bridge.sent).toEqual([{ slot: 'shell.left', activeView: 'categories' }])
  })

  it('shows the view\'s id while its catalogue entry has not arrived', async () => {
    renderThemed(barOf('left'), [])
    await act(async () => {})

    expect(screen.getAllByRole('tab').map(t => t.textContent)).toEqual(['accounts', 'categories'])
  })
})

describe('collapsing and expanding', () => {
  it.each([
    ['left', 'ChevronLeft'], ['right', 'ChevronRight'], ['top', 'ExpandLess'], ['bottom', 'ExpandMore']
  ] as const)('points the %s bar\'s collapse button away from the main area (%s)', async (side, icon) => {
    renderThemed(barOf(side), [view('accounts', `shell.${side}`, { icon: 'Home' }), view('categories', `shell.${side}`)])
    await act(async () => {})

    const collapse = screen.getByRole('button', { name: `Collapse ${side} bar` })
    expect(collapse.querySelector(`svg[data-icon="${icon}"]`)).toBeInTheDocument()
    expect(collapse).toHaveAttribute('title', `Collapse ${side} bar`)
  })

  it.each([
    ['left', 'ChevronRight'], ['right', 'ChevronLeft'], ['top', 'ExpandMore'], ['bottom', 'ExpandLess']
  ] as const)('points the %s bar\'s expand button towards the main area (%s)', async (side, icon) => {
    // A bar with only items has no view to show on its rail, so it gets one expand button
    renderThemed(layoutOf({ bars: { [side]: { items: ['i'], collapsed: true } } }), [], 'dark', [button('i', { slot: `shell.${side}` as never })])
    await act(async () => {})

    expect(screen.getByRole('button', { name: `Expand ${side} bar` }).querySelector(`svg[data-icon="${icon}"]`)).toBeInTheDocument()
  })

  it('marks the active view on a collapsed rail with the primary colour, and the others not', async () => {
    renderThemed(barOf('left', { collapsed: true }))
    await act(async () => {})

    const rail = screen.getByRole('toolbar', { name: 'Left bar (collapsed)' })
    expect(within(rail).getByRole('button', { name: 'Title accounts' })).toHaveClass('MuiIconButton-colorPrimary')
    expect(within(rail).getByRole('button', { name: 'Title categories' })).not.toHaveClass('MuiIconButton-colorPrimary')
  })

  it('shows a placeholder, not a broken button, for a rail view whose entry has not arrived', async () => {
    renderThemed(barOf('left', { collapsed: true }), [])
    await act(async () => {})

    expect(screen.getByRole('button', { name: 'accounts' })).toHaveTextContent('…')
  })
})

describe('bar items', () => {
  it('are MUI buttons that keep the case they were written in', async () => {
    renderThemed(layoutOf({ bars: { top: { items: ['a'] } } }), [], 'dark', [button('a')])
    await act(async () => {})

    const item = screen.getByRole('button', { name: 'Label a' })
    expect(item).toHaveClass('MuiButton-root')
    expect(item).toHaveTextContent('Label a')
    expect(getComputedStyle(item).textTransform).toBe('none')
  })

  it('show their icon at the start, and a disabled command as a disabled button', async () => {
    renderThemed(layoutOf({ bars: { top: { items: ['a'] } } }), [], 'dark', [button('a', { icon: 'Save', enabled: false })])
    await act(async () => {})

    const item = screen.getByRole('button', { name: 'Label a' })
    expect(item).toBeDisabled()
    expect(item.querySelector('svg[data-icon="Save"]')).toBeInTheDocument()
  })

  it('draw text that names no command as plain text, not a control', async () => {
    renderThemed(layoutOf({ bars: { bottom: { items: ['t'] } } }), [], 'dark', [
      { kind: 'text', id: 't', slot: 'shell.bottom', text: 'Ready', pluginId: 'p', enabled: true } as BorderItemDescriptor
    ])
    await act(async () => {})

    expect(screen.getByText('Ready')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Ready' })).toBeNull()
  })

  it('are a labelled group on a themed toolbar', async () => {
    renderThemed(layoutOf({ bars: { top: { items: ['a'] } } }), [], 'dark', [button('a')])
    await act(async () => {})

    expect(screen.getByRole('group', { name: 'top bar items' })).toHaveClass('MuiToolbar-root')
  })
})

describe('theming of the frame', () => {
  it.each([
    ['dark', 'rgb(30, 30, 30)'],
    ['light', 'rgb(255, 255, 255)']
  ] as const)('paints a bar with the %s theme\'s paper colour, never a literal', async (mode, paper) => {
    renderThemed(barOf('left'), leftViews, mode)
    await act(async () => {})

    expect(getComputedStyle(screen.getByRole('complementary', { name: 'Left bar' })).backgroundColor).toBe(paper)
  })

  it('draws the divider between a bar and the main area on the bar\'s inner edge', async () => {
    renderThemed(barOf('left'), leftViews)
    await act(async () => {})

    const style = getComputedStyle(screen.getByRole('complementary', { name: 'Left bar' }))
    expect(style.borderRightStyle).toBe('solid')
    expect(style.borderLeftStyle).not.toBe('solid')
  })

  it('draws the welcome text as headings and text from the theme', async () => {
    renderThemed(layoutOf(), [])
    await act(async () => {})

    expect(screen.getByRole('heading', { level: 1, name: 'Tessera' })).toHaveClass('MuiTypography-h4')
    expect(screen.getByText('Renderer shell is running.')).toHaveClass('MuiTypography-root')
  })
})

describe('loading placeholders', () => {
  it('show a message, with a decorative spinner that is not announced as a progress bar', async () => {
    // Hold the view's component so its Suspense fallback shows
    const bridge = fakeBridge(barOf('left'))
    render(<Frame bridge={bridge} views={leftViews} load={() => new Promise(() => {})} />)
    await act(async () => {})

    expect(screen.getAllByText('Loading Title accounts…').length).toBeGreaterThan(0)
    expect(screen.queryByRole('progressbar')).toBeNull()
  })

  it('show "Loading…" for a main-area view whose entry has not arrived', async () => {
    renderThemed(layoutOf({ main: { views: ['home'], activeView: 'home' } }), [])
    await act(async () => {})

    expect(screen.getByText('Loading…')).toBeInTheDocument()
  })
})

describe('a view that fails', () => {
  it('shows its message as an alert in the error colour', async () => {
    const bridge = fakeBridge(layoutOf({ main: { views: ['home'], activeView: 'home' } }))
    const Broken = () => { throw new Error('render failure') }
    const spy = (await import('vitest')).vi.spyOn(console, 'error').mockImplementation(() => {})

    render(<Frame bridge={bridge} views={[view('home', 'shell.main')]} load={async () => Broken} />)
    await act(async () => {})

    expect(screen.getByRole('alert')).toHaveTextContent('Title home could not be displayed.')
    expect(screen.getByRole('alert')).toHaveClass('MuiTypography-root')
    spy.mockRestore()
  })
})
