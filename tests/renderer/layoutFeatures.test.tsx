import { describe, it, expect, vi } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { BorderItemDescriptor, LayoutState } from '@tessera/types'
import { BAR_ITEMS_CHANGED, LAYOUT_CHANGED, LAYOUT_REVEALED } from '../../shared/layout/types'
import { CONTEXT_KEYS_CHANGED } from '../../shared/shellEvents'
import App from '../../shell/renderer/App'
import { ShellStateProvider } from '../../shell/renderer/state/ShellState'
import { ViewsProvider } from '../../shell/renderer/views/ViewsProvider'
import { fakeBridge, layoutOf, renderFrame, view } from '../helpers/layoutFrame'

const button = (id: string, extra: Partial<BorderItemDescriptor> = {}): BorderItemDescriptor =>
  ({ kind: 'button', id, slot: 'shell.top', label: `Label ${id}`, command: `p.${id}`, pluginId: 'p', enabled: true, ...extra }) as BorderItemDescriptor
const text = (id: string, extra: Partial<BorderItemDescriptor> = {}): BorderItemDescriptor =>
  ({ kind: 'text', id, slot: 'shell.bottom', text: `Text ${id}`, pluginId: 'p', enabled: true, ...extra }) as BorderItemDescriptor

const topWith = (...ids: string[]) => layoutOf({ bars: { top: { items: ids } } })

describe('bar items', () => {
  it('draws a button for each item, enabled as the main process says, and runs its command when clicked', async () => {
    const user = userEvent.setup()
    const { bridge } = await renderFrame(topWith('save', 'print'), [], {}, {
      items: [button('save'), button('print', { enabled: false })]
    })

    expect(await screen.findByRole('button', { name: 'Label save' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Label print' })).toBeDisabled()

    await user.click(screen.getByRole('button', { name: 'Label save' }))
    expect(bridge.ran).toEqual([{ id: 'p.save' }])
  })

  it('shows the tooltip, and a labelled bar of its own for the strip', async () => {
    await renderFrame(topWith('save'), [], {}, { items: [button('save', { tooltip: 'Save the vault' })] })

    expect(await screen.findByTitle('Save the vault')).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'top bar items' })).toBeInTheDocument()
  })

  it('draws the text of a text item, replacing {key} with the context key and following it live', async () => {
    const { bridge } = await renderFrame(layoutOf({ bars: { bottom: { items: ['name'] } } }), [], {}, {
      items: [text('name', { text: 'Vault: {vault.name} ({ missing })' })],
      keys: { 'vault.name': 'Home' }
    })

    expect(await screen.findByText('Vault: Home ()')).toBeInTheDocument()

    await bridge.emit(CONTEXT_KEYS_CHANGED, { 'vault.name': 'Work' })
    expect(screen.getByText('Vault: Work ()')).toBeInTheDocument()

    await bridge.emit(CONTEXT_KEYS_CHANGED, { 'vault.name': null })
    expect(screen.getByText('Vault: ()')).toBeInTheDocument()
  })

  it('makes text with a command clickable, and leaves plain text as plain text', async () => {
    const user = userEvent.setup()
    const { bridge } = await renderFrame(layoutOf({ bars: { bottom: { items: ['plain', 'link'] } } }), [], {}, {
      items: [text('plain'), text('link', { command: 'p.open' })]
    })

    await user.click(await screen.findByRole('button', { name: /Text link/ }))

    expect(bridge.ran).toEqual([{ id: 'p.open' }])
    expect(screen.queryByRole('button', { name: /Text plain/ })).toBeNull()
    expect(screen.getByText('Text plain')).toBeInTheDocument()
  })

  it('puts items aligned to the end after those aligned to the start, whatever their order', async () => {
    await renderFrame(topWith('late', 'first', 'last'), [], {}, {
      items: [button('late', { align: 'end' }), button('first'), button('last', { align: 'end' })]
    })

    const group = await screen.findByRole('group', { name: 'top bar items' })
    expect(within(group).getAllByRole('button').map(b => b.getAttribute('data-item'))).toEqual(['first', 'late', 'last'])
  })

  it('does not draw an item that the layout lists but the catalogue does not know yet', async () => {
    await renderFrame(topWith('known', 'unknown'), [], {}, { items: [button('known')] })

    expect(await screen.findByRole('button', { name: 'Label known' })).toBeInTheDocument()
    expect(screen.getAllByRole('button')).toHaveLength(1)
  })

  it('does not draw items that are not in the layout', async () => {
    const { container } = await renderFrame(layoutOf(), [], {}, { items: [button('save')] })

    expect(screen.queryByRole('button', { name: 'Label save' })).toBeNull()
    expect(container.querySelector('[data-bar]')).toBeNull()
  })

  it('draws a shell icon as its glyph, a plugin file by its URL, and nothing for an item without one', async () => {
    const { container } = await renderFrame(topWith('named', 'file', 'none'), [], {}, {
      items: [button('named', { icon: 'Save' }), button('file', { icon: 'tessera-plugin://p/i.svg' }), button('none')]
    })
    await screen.findByRole('button', { name: 'Label named' })

    const icon = (id: string) => container.querySelector(`[data-item="${id}"] [data-icon]`)
    expect(icon('named')?.tagName.toLowerCase()).toBe('svg')
    expect(icon('named')?.getAttribute('data-icon')).toBe('Save')
    expect(icon('named')?.querySelector('path')?.getAttribute('d')).toBeTruthy()
    expect(icon('file')?.getAttribute('data-icon')).toBe('tessera-plugin://p/i.svg')
    expect(icon('none')).toBeNull()
  })

  it('follows a change to the catalogue, such as a command becoming enabled', async () => {
    const { bridge } = await renderFrame(topWith('save'), [], {}, { items: [button('save', { enabled: false })] })
    expect(await screen.findByRole('button', { name: 'Label save' })).toBeDisabled()

    bridge.items = [button('save', { enabled: true })]
    await bridge.emit(BAR_ITEMS_CHANGED)
    await act(async () => {})

    expect(screen.getByRole('button', { name: 'Label save' })).toBeEnabled()
  })

  it('goes after the active view in the bottom bar, and before the tabs in the others', async () => {
    const state = layoutOf({ bars: {
      top: { views: ['t'], activeView: 't', items: ['ti'] },
      bottom: { views: ['b'], activeView: 'b', items: ['bi'] }
    } })
    await renderFrame(state, [view('t', 'shell.top'), view('b', 'shell.bottom')], {}, {
      items: [button('ti'), text('bi')]
    })
    await screen.findByText('Content of t')

    const follows = (a: Element, b: Element) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)
    const top = screen.getByRole('banner')
    const bottom = screen.getByRole('contentinfo')
    expect(follows(within(top).getByRole('group'), within(top).getByRole('tablist'))).toBe(true)
    expect(follows(within(bottom).getByRole('tabpanel'), within(bottom).getByRole('group'))).toBe(true)
  })

  it('is not drawn while the bar is collapsed, and the rail offers the way back', async () => {
    const user = userEvent.setup()
    const { bridge } = await renderFrame(layoutOf({ bars: { top: { items: ['save'], collapsed: true } } }), [], {}, { items: [button('save')] })

    expect(screen.queryByRole('group', { name: 'top bar items' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Expand top bar' }))
    expect(bridge.sent).toEqual([{ slot: 'shell.top', collapsed: false }])
  })

  it('asks for the provider', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const bridge = fakeBridge(layoutOf())

    expect(() => render(
      <ShellStateProvider bridge={bridge as any}>
        <ViewsProvider source={{ listViews: async () => [] }} loader={{ load: async () => () => null }}>
          <App />
        </ViewsProvider>
      </ShellStateProvider>
    )).toThrow('Bar items must be used inside <BarItemsProvider>')
    vi.mocked(console.error).mockRestore()
  })

  it('keeps showing what it had when the list cannot be fetched', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const bridge = fakeBridge(topWith('save'), [button('save')])
    const invoke = bridge.invoke.getMockImplementation()!
    bridge.invoke.mockImplementation(async (channel: string, data?: unknown) => {
      if (channel === 'shell:bar.items.list') throw new Error('ipc down')
      return invoke(channel, data)
    })

    const { Frame } = await import('../helpers/layoutFrame')
    render(<Frame bridge={bridge} views={[]} load={async () => () => null} />)
    await act(async () => {})

    expect(error).toHaveBeenCalledWith('[layout] Failed to list bar items', expect.any(Error))
    expect(screen.queryByRole('button')).toBeNull()
    error.mockRestore()
  })
})

describe('resizing a bar', () => {
  const leftViews = [view('accounts', 'shell.left')]
  const left = (size = 260) => layoutOf({ bars: { left: { views: ['accounts'], activeView: 'accounts', size } } })
  const columns = (container: HTMLElement) => (container.querySelector('[data-layout]') as HTMLElement).style.gridTemplateColumns

  it('puts a separator on the inner edge of an expanded bar that holds views', async () => {
    await renderFrame(left(), leftViews)

    const separator = screen.getByRole('separator', { name: 'Resize left bar' })
    expect(separator).toHaveAttribute('aria-orientation', 'vertical')
    expect(separator).toHaveAttribute('aria-valuenow', '260')
    expect(separator).toHaveAttribute('aria-valuemin', '100')
    expect(separator).toHaveAttribute('aria-valuemax', String(Math.floor(window.innerWidth / 2)))
    expect(separator).toHaveAttribute('tabindex', '0')
  })

  it('is horizontal on the top and bottom bars', async () => {
    await renderFrame(layoutOf({ bars: { bottom: { views: ['log'], activeView: 'log' } } }), [view('log', 'shell.bottom')])

    expect(screen.getByRole('separator', { name: 'Resize bottom bar' })).toHaveAttribute('aria-orientation', 'horizontal')
  })

  it('is absent on a collapsed bar, on a bar with only items, and on a bar with nothing', async () => {
    const collapsed = await renderFrame(layoutOf({ bars: { left: { views: ['accounts'], activeView: 'accounts', collapsed: true } } }), leftViews)
    expect(screen.queryByRole('separator')).toBeNull()
    collapsed.unmount()

    await renderFrame(layoutOf({ bars: { bottom: { items: ['status'] } } }), [], {}, { items: [text('status')] })
    expect(screen.queryByRole('separator')).toBeNull()
  })

  it('follows the pointer while dragging without asking the main process, and reports the final size once on release', async () => {
    const { container, bridge } = await renderFrame(left(), leftViews)
    const separator = screen.getByRole('separator')

    fireEvent.mouseDown(separator, { button: 0, clientX: 260 })
    fireEvent.mouseMove(document, { clientX: 300 })
    fireEvent.mouseMove(document, { clientX: 320 })

    expect(columns(container)).toBe('min(320px, 50%) minmax(0, 1fr) 0px')
    expect(separator).toHaveAttribute('aria-valuenow', '320')
    expect(bridge.sent).toEqual([])

    fireEvent.mouseUp(document)
    expect(bridge.sent).toEqual([{ slot: 'shell.left', size: 320 }])

    fireEvent.mouseMove(document, { clientX: 500 })           // no longer dragging
    expect(bridge.sent).toHaveLength(1)
  })

  it('keeps the dragged size until the controller has answered, then adopts the controller\'s', async () => {
    const { container, bridge } = await renderFrame(left(), leftViews)

    fireEvent.mouseDown(screen.getByRole('separator'), { button: 0, clientX: 260 })
    fireEvent.mouseMove(document, { clientX: 320 })
    fireEvent.mouseUp(document)
    expect(columns(container)).toContain('min(320px')                // before the reply: no jump back

    await bridge.emit(LAYOUT_CHANGED, left(320))
    await act(async () => {})
    expect(columns(container)).toBe('min(320px, 50%) minmax(0, 1fr) 0px')
  })

  it('grows a right bar when dragged to the left', async () => {
    const { bridge } = await renderFrame(layoutOf({ bars: { right: { views: ['bills'], activeView: 'bills', size: 300 } } }), [view('bills', 'shell.right')])

    fireEvent.mouseDown(screen.getByRole('separator'), { button: 0, clientX: 800 })
    fireEvent.mouseMove(document, { clientX: 750 })
    fireEvent.mouseUp(document)

    expect(bridge.sent).toEqual([{ slot: 'shell.right', size: 350 }])
  })

  it('uses the vertical position for the top and bottom bars', async () => {
    const { bridge } = await renderFrame(layoutOf({ bars: { bottom: { views: ['log'], activeView: 'log', size: 200 } } }), [view('log', 'shell.bottom')])

    fireEvent.mouseDown(screen.getByRole('separator'), { button: 0, clientY: 500 })
    fireEvent.mouseMove(document, { clientY: 460 })              // up by 40 grows the bottom bar
    fireEvent.mouseUp(document)

    expect(bridge.sent).toEqual([{ slot: 'shell.bottom', size: 240 }])
  })

  it('never goes below the minimum or above half the window', async () => {
    const { bridge } = await renderFrame(left(), leftViews)
    const separator = screen.getByRole('separator')

    fireEvent.mouseDown(separator, { button: 0, clientX: 260 })
    fireEvent.mouseMove(document, { clientX: -500 })
    fireEvent.mouseUp(document)
    fireEvent.mouseDown(separator, { button: 0, clientX: 260 })
    fireEvent.mouseMove(document, { clientX: 5000 })
    fireEvent.mouseUp(document)

    expect(bridge.sent).toEqual([{ slot: 'shell.left', size: 100 }, { slot: 'shell.left', size: Math.floor(window.innerWidth / 2) }])
  })

  it('sends nothing for a click that does not move, or for a button other than the primary one', async () => {
    const { bridge } = await renderFrame(left(), leftViews)
    const separator = screen.getByRole('separator')

    fireEvent.mouseDown(separator, { button: 0, clientX: 260 })
    fireEvent.mouseUp(document)
    fireEvent.mouseDown(separator, { button: 2, clientX: 260 })
    fireEvent.mouseMove(document, { clientX: 300 })
    fireEvent.mouseUp(document)

    expect(bridge.sent).toEqual([])
  })

  it('stops following the pointer if the bar goes away mid-drag', async () => {
    const { bridge, unmount } = await renderFrame(left(), leftViews)

    fireEvent.mouseDown(screen.getByRole('separator'), { button: 0, clientX: 260 })
    unmount()
    fireEvent.mouseMove(document, { clientX: 300 })
    fireEvent.mouseUp(document)

    expect(bridge.sent).toEqual([])
  })

  it('moves by 10 px per arrow key, reporting each step, in the direction the key points', async () => {
    const user = userEvent.setup()
    const { bridge } = await renderFrame(left(), leftViews)
    screen.getByRole('separator').focus()

    // Each step starts from the size the controller last reported, as it does in the application.
    await user.keyboard('{ArrowRight}')
    await bridge.emit(LAYOUT_CHANGED, left(270))
    await user.keyboard('{ArrowRight}')
    await bridge.emit(LAYOUT_CHANGED, left(280))
    await user.keyboard('{ArrowLeft}')

    expect(bridge.sent).toEqual([
      { slot: 'shell.left', size: 270 },
      { slot: 'shell.left', size: 280 },
      { slot: 'shell.left', size: 270 }
    ])
  })

  it.each([
    ['right', 'ArrowLeft', 'ArrowRight', 310, 290],
    ['top', 'ArrowDown', 'ArrowUp', 130, 110],
    ['bottom', 'ArrowUp', 'ArrowDown', 210, 190]
  ] as const)('grows the %s bar with %s and shrinks it with %s', async (side, grow, shrink, bigger, smaller) => {
    const user = userEvent.setup()
    const size = { right: 300, top: 120, bottom: 200 }[side]
    const { bridge } = await renderFrame(layoutOf({ bars: { [side]: { views: ['v'], activeView: 'v', size } } }), [view('v', `shell.${side}`)])
    screen.getByRole('separator').focus()

    await user.keyboard(`{${grow}}`)
    await user.keyboard(`{${shrink}}`)

    expect(bridge.sent.map((sent: any) => sent.size)).toEqual([bigger, smaller])
  })

  it('ignores other keys', async () => {
    const user = userEvent.setup()
    const { bridge } = await renderFrame(left(), leftViews)
    screen.getByRole('separator').focus()

    await user.keyboard('{ArrowUp}{ArrowDown}a{Enter}')

    expect(bridge.sent).toEqual([])
  })

  it('restores the default size on a double-click', async () => {
    const user = userEvent.setup()
    const { bridge } = await renderFrame(left(400), leftViews)

    await user.dblClick(screen.getByRole('separator'))

    expect(bridge.sent).toEqual([{ slot: 'shell.left', size: 260 }])
  })
})

describe('revealing a view', () => {
  const state = (activeView: string): LayoutState => layoutOf({ main: { views: ['home', 'register'], activeView } })
  const mainViews = [view('home', 'shell.main'), view('register', 'shell.main')]

  it('moves focus to the section of the view once it is shown', async () => {
    const { bridge } = await renderFrame(state('home'), mainViews)
    await screen.findByText('Content of home')

    await bridge.emit(LAYOUT_CHANGED, state('register'))
    await bridge.emit(LAYOUT_REVEALED, { windowId: 1, viewId: 'register', slot: 'shell.main' })
    await act(async () => {})

    expect(await screen.findByText('Content of register')).toBeVisible()
    expect(screen.getByRole('region', { name: 'Title register' })).toHaveFocus()
  })

  it('focuses a view in a bar', async () => {
    const bar = (activeView: string) => layoutOf({ bars: { right: { views: ['a', 'b'], activeView } } })
    const { bridge } = await renderFrame(bar('a'), [view('a', 'shell.right'), view('b', 'shell.right')])
    await screen.findByText('Content of a')

    await bridge.emit(LAYOUT_CHANGED, bar('b'))
    await bridge.emit(LAYOUT_REVEALED, { windowId: 1, viewId: 'b', slot: 'shell.right' })
    await act(async () => {})

    expect(await screen.findByRole('region', { name: 'Title b' })).toHaveFocus()
  })

  it('ignores a reveal in another window', async () => {
    const { bridge } = await renderFrame(state('home'), mainViews)
    await screen.findByText('Content of home')
    await bridge.emit(LAYOUT_CHANGED, state('register'))

    await bridge.emit(LAYOUT_REVEALED, { windowId: 2, viewId: 'register', slot: 'shell.main' })
    await act(async () => {})

    expect(screen.getByRole('region', { name: 'Title register' })).not.toHaveFocus()
  })

  it('does nothing for a view that is not drawn', async () => {
    const { bridge } = await renderFrame(state('home'), mainViews)
    await screen.findByText('Content of home')

    await expect(bridge.emit(LAYOUT_REVEALED, { windowId: 1, viewId: 'ghost', slot: 'shell.main' })).resolves.not.toThrow()
  })
})

describe('moving between regions with F6', () => {
  const all = () => layoutOf({
    main: { views: ['page'], activeView: 'page' },
    bars: {
      top: { views: ['t'], activeView: 't' },
      left: { views: ['l'], activeView: 'l' },
      right: { views: ['r'], activeView: 'r' },
      bottom: { views: ['b'], activeView: 'b' }
    }
  })
  const views = [view('page', 'shell.main'), view('t', 'shell.top'), view('l', 'shell.left'), view('r', 'shell.right'), view('b', 'shell.bottom')]
  const focusedRegion = () => (document.activeElement as HTMLElement | null)?.getAttribute('data-region') ?? null

  it('visits top, left, main, right and bottom in turn, then wraps', async () => {
    const user = userEvent.setup()
    await renderFrame(all(), views)

    const visited: (string | null)[] = []
    for (let i = 0; i < 6; i++) {
      await user.keyboard('{F6}')
      visited.push(focusedRegion())
    }

    expect(visited).toEqual(['top', 'left', 'main', 'right', 'bottom', 'top'])
  })

  it('goes backwards with Shift+F6, starting from the last region', async () => {
    const user = userEvent.setup()
    await renderFrame(all(), views)

    const visited: (string | null)[] = []
    for (let i = 0; i < 3; i++) {
      await user.keyboard('{Shift>}{F6}{/Shift}')
      visited.push(focusedRegion())
    }

    expect(visited).toEqual(['bottom', 'right', 'main'])
  })

  it('continues from the region that holds focus, such as a button inside a bar', async () => {
    const user = userEvent.setup()
    await renderFrame(all(), views)
    await screen.findByText('Content of l')

    await user.click(within(screen.getByRole('complementary', { name: 'Left bar' })).getByRole('tab'))
    await user.keyboard('{F6}')

    expect(focusedRegion()).toBe('main')
  })

  it('skips bars that are not there', async () => {
    const user = userEvent.setup()
    await renderFrame(layoutOf({ main: { views: ['page'], activeView: 'page' }, bars: { bottom: { views: ['b'], activeView: 'b' } } }), [views[0], views[4]])

    const visited: (string | null)[] = []
    for (let i = 0; i < 3; i++) {
      await user.keyboard('{F6}')
      visited.push(focusedRegion())
    }

    expect(visited).toEqual(['main', 'bottom', 'main'])
  })

  it('leaves other keys alone', async () => {
    const user = userEvent.setup()
    await renderFrame(all(), views)

    await user.keyboard('{F5}a')

    expect(focusedRegion()).toBeNull()
  })

  it('stops listening when the frame goes away', async () => {
    const user = userEvent.setup()
    const { unmount } = await renderFrame(all(), views)
    unmount()

    await user.keyboard('{F6}')

    expect(document.activeElement).toBe(document.body)
  })
})
