import { describe, it, expect, vi } from 'vitest'
import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useEffect } from 'react'
import type { LayoutState } from '@tessera/types'
import { LAYOUT_CHANGED } from '../../shared/layout/types'
import type { ViewDescriptor } from '../../shared/views/types'
import { Frame, fakeBridge, layoutOf, renderFrame, view } from '../helpers/layoutFrame'

const leftViews = [view('accounts', 'shell.left'), view('categories', 'shell.left')]
const leftBar = (extra: Partial<LayoutState['bars']['left']> = {}) =>
  layoutOf({ bars: { left: { views: ['accounts', 'categories'], activeView: 'accounts', ...extra } } })

describe('layout controller frame', () => {
  describe('bars with nothing in them', () => {
    it('are not in the DOM at all, and the main area shows the welcome text', async () => {
      const { container } = await renderFrame(layoutOf(), [])

      expect(screen.getByText(/Renderer shell is running/i)).toBeInTheDocument()
      expect(container.querySelector('[data-bar]')).toBeNull()
      expect(screen.queryByRole('banner')).toBeNull()
      expect(screen.queryByRole('complementary')).toBeNull()
      expect(screen.queryByRole('contentinfo')).toBeNull()
      expect(screen.getByRole('main', { name: 'Main' })).toBeInTheDocument()
    })

    it('take no space in the grid', async () => {
      const { container } = await renderFrame(layoutOf(), [])
      const grid = container.querySelector<HTMLElement>('[data-layout]')!

      expect(grid.style.gridTemplateColumns).toBe('0px minmax(0, 1fr) 0px')
      expect(grid.style.gridTemplateRows).toBe('0px minmax(0, 1fr) 0px')
    })
  })

  describe('an expanded bar', () => {
    it('is a landmark with one tab per view, the active one selected, and a collapse button', async () => {
      await renderFrame(leftBar(), leftViews)

      const bar = screen.getByRole('complementary', { name: 'Left bar' })
      expect(within(bar).getByRole('tab', { name: /Title accounts/ })).toHaveAttribute('aria-selected', 'true')
      expect(within(bar).getByRole('tab', { name: /Title categories/ })).toHaveAttribute('aria-selected', 'false')
      expect(within(bar).getByRole('button', { name: 'Collapse left bar' })).toBeInTheDocument()
    })

    it.each([
      ['top', 'banner', 'Top bar'],
      ['bottom', 'contentinfo', 'Bottom bar'],
      ['right', 'complementary', 'Right bar']
    ] as const)('puts the %s bar in a %s landmark', async (side, role, name) => {
      const slot = `shell.${side}`
      await renderFrame(layoutOf({ bars: { [side]: { views: ['v'], activeView: 'v' } } }), [view('v', slot)])

      expect(screen.getByRole(role, { name })).toHaveAttribute('data-bar', side)
    })

    it('loads and shows only the active view', async () => {
      const { loaded } = await renderFrame(leftBar(), leftViews)

      expect(await screen.findByText('Content of accounts')).toBeVisible()
      expect(screen.queryByText('Content of categories')).toBeNull()
      expect(loaded()).toEqual(['accounts'])
    })

    it('asks the controller to switch when a tab is clicked, and shows the view the controller then chooses', async () => {
      const user = userEvent.setup()
      const { bridge, loaded } = await renderFrame(leftBar(), leftViews)
      await screen.findByText('Content of accounts')

      await user.click(screen.getByRole('tab', { name: /Title categories/ }))
      expect(bridge.sent).toEqual([{ slot: 'shell.left', activeView: 'categories' }])
      expect(screen.queryByText('Content of categories')).toBeNull()      // nothing changes until the controller says so

      await bridge.emit(LAYOUT_CHANGED, leftBar({ activeView: 'categories' }))

      expect(await screen.findByText('Content of categories')).toBeVisible()
      expect(loaded()).toEqual(['accounts', 'categories'])
      expect(screen.getAllByRole('tab').map(t => t.getAttribute('aria-selected'))).toEqual(['false', 'true'])
    })

    it('keeps a view that was shown mounted but hidden when another tab is chosen', async () => {
      let mounts = 0
      const Accounts = () => { useEffect(() => { mounts++ }, []); return <p>Content of accounts</p> }
      const { bridge } = await renderFrame(leftBar(), leftViews, { accounts: Accounts })
      await screen.findByText('Content of accounts')

      await bridge.emit(LAYOUT_CHANGED, leftBar({ activeView: 'categories' }))
      expect(screen.getByText('Content of accounts')).not.toBeVisible()
      expect(await screen.findByText('Content of categories')).toBeVisible()

      await bridge.emit(LAYOUT_CHANGED, leftBar({ activeView: 'accounts' }))
      expect(screen.getByText('Content of accounts')).toBeVisible()
      expect(mounts).toBe(1)                                                 // never remounted
    })

    it('asks the controller to collapse it', async () => {
      const user = userEvent.setup()
      const { bridge } = await renderFrame(leftBar(), leftViews)

      await user.click(screen.getByRole('button', { name: 'Collapse left bar' }))

      expect(bridge.sent).toEqual([{ slot: 'shell.left', collapsed: true }])
    })

    it('sizes its grid track from the controller, capped at half the window', async () => {
      const { container } = await renderFrame(leftBar({ size: 320 }), leftViews)

      expect((container.querySelector('[data-layout]') as HTMLElement).style.gridTemplateColumns)
        .toBe('min(320px, 50%) minmax(0, 1fr) 0px')
    })

    it('shows a loading placeholder for a view whose descriptor has not arrived', async () => {
      await renderFrame(leftBar(), [])

      expect(screen.getByText('Loading…')).toBeInTheDocument()
    })
  })

  describe('a collapsed bar', () => {
    it('is a 40px rail with one labelled icon per view and no tabs', async () => {
      const { container } = await renderFrame(leftBar({ collapsed: true }), leftViews)

      const rail = screen.getByRole('toolbar', { name: 'Left bar (collapsed)' })
      expect(within(rail).getAllByRole('button').map(b => b.getAttribute('aria-label'))).toEqual(['Title accounts', 'Title categories'])
      expect(within(rail).getAllByRole('button').map(b => b.getAttribute('title'))).toEqual(['Title accounts', 'Title categories'])
      expect(within(rail).getByRole('button', { name: 'Title accounts' })).toHaveAttribute('aria-current', 'true')
      expect(screen.queryByRole('tablist')).toBeNull()
      expect((container.querySelector('[data-layout]') as HTMLElement).style.gridTemplateColumns).toBe('40px minmax(0, 1fr) 0px')
    })

    it('does not load its views', async () => {
      const { loaded } = await renderFrame(leftBar({ collapsed: true }), leftViews)

      expect(loaded()).toEqual([])
    })

    it('expands on the view whose icon is clicked', async () => {
      const user = userEvent.setup()
      const { bridge } = await renderFrame(leftBar({ collapsed: true }), leftViews)

      await user.click(screen.getByRole('button', { name: 'Title categories' }))

      expect(bridge.sent).toEqual([{ slot: 'shell.left', activeView: 'categories', collapsed: false }])
    })

    it('keeps the views it had shown mounted, but out of sight', async () => {
      const state = leftBar()
      const { bridge, loaded } = await renderFrame(state, leftViews)
      await screen.findByText('Content of accounts')

      await bridge.emit(LAYOUT_CHANGED, leftBar({ collapsed: true }))

      expect(screen.getByRole('toolbar', { name: 'Left bar (collapsed)' })).toBeInTheDocument()
      expect(screen.getByText('Content of accounts')).not.toBeVisible()
      expect(loaded()).toEqual(['accounts'])

      await bridge.emit(LAYOUT_CHANGED, leftBar())
      expect(screen.getByText('Content of accounts')).toBeVisible()
      expect(loaded()).toEqual(['accounts'])                                // not loaded again
    })

    it('shows a single expand button when the bar has items but no views', async () => {
      const user = userEvent.setup()
      const { bridge } = await renderFrame(layoutOf({ bars: { bottom: { items: ['status'], collapsed: true } } }), [])

      await user.click(screen.getByRole('button', { name: 'Expand bottom bar' }))

      expect(bridge.sent).toEqual([{ slot: 'shell.bottom', collapsed: false }])
    })

    it('uses a horizontal rail on the top and bottom bars', async () => {
      await renderFrame(layoutOf({ bars: { top: { views: ['t'], activeView: 't', collapsed: true } } }), [view('t', 'shell.top')])

      expect(screen.getByRole('toolbar', { name: 'Top bar (collapsed)' })).toHaveAttribute('aria-orientation', 'horizontal')
    })
  })

  describe('a bar that has only items', () => {
    it('is content-sized and has no tab strip', async () => {
      const { container } = await renderFrame(layoutOf({ bars: { bottom: { items: ['status'] } } }), [])

      expect(screen.getByRole('contentinfo', { name: 'Bottom bar' })).toBeInTheDocument()
      expect(screen.queryByRole('tablist')).toBeNull()
      expect((container.querySelector('[data-layout]') as HTMLElement).style.gridTemplateRows).toBe('0px minmax(0, 1fr) auto')
    })
  })

  describe('the main area', () => {
    const mainViews = [view('home', 'shell.main'), view('register', 'shell.main')]
    const main = (activeView: string) => layoutOf({ main: { views: ['home', 'register'], activeView } })

    it('shows only the active main view, not the welcome text', async () => {
      const { loaded } = await renderFrame(main('home'), mainViews)

      expect(await screen.findByText('Content of home')).toBeVisible()
      expect(screen.queryByText(/Renderer shell is running/i)).toBeNull()
      expect(loaded()).toEqual(['home'])
    })

    it('switches when the controller reveals another view, keeping the first mounted but hidden', async () => {
      const { bridge, loaded } = await renderFrame(main('home'), mainViews)
      await screen.findByText('Content of home')

      await bridge.emit(LAYOUT_CHANGED, main('register'))

      expect(await screen.findByText('Content of register')).toBeVisible()
      expect(screen.getByText('Content of home')).not.toBeVisible()
      expect(loaded()).toEqual(['home', 'register'])
    })

    it('goes back to the welcome text when its views go away', async () => {
      const { bridge } = await renderFrame(main('home'), mainViews)
      await screen.findByText('Content of home')

      await bridge.emit(LAYOUT_CHANGED, layoutOf())

      expect(screen.getByText(/Renderer shell is running/i)).toBeInTheDocument()
    })

    it('isolates a main view that fails', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      const Broken = () => { throw new Error('render failure') }

      await renderFrame(main('home'), mainViews, { home: Broken })

      expect(await screen.findByText('Title home could not be displayed.')).toBeInTheDocument()
      expect(screen.getByRole('main')).toBeInTheDocument()
      error.mockRestore()
    })
  })

  describe('following the controller', () => {
    it('shows a bar when it gains a view, and hides it when it loses it', async () => {
      const { bridge, container } = await renderFrame(layoutOf(), leftViews)
      expect(container.querySelector('[data-bar]')).toBeNull()

      await bridge.emit(LAYOUT_CHANGED, leftBar())
      expect(await screen.findByRole('complementary', { name: 'Left bar' })).toBeInTheDocument()

      await bridge.emit(LAYOUT_CHANGED, layoutOf())
      expect(container.querySelector('[data-bar]')).toBeNull()
    })

    it('ignores a state that belongs to another window', async () => {
      const { bridge, container } = await renderFrame(layoutOf(), leftViews)

      await bridge.emit(LAYOUT_CHANGED, { ...leftBar(), windowId: 2 })

      expect(container.querySelector('[data-bar]')).toBeNull()
    })

    it('applies a state that arrives before the snapshot, on top of it', async () => {
      const bridge = fakeBridge(layoutOf())
      render(<Frame bridge={bridge} views={leftViews} load={async () => () => null} />)

      await bridge.emit(LAYOUT_CHANGED, leftBar())
      await act(async () => {})

      expect(screen.getByRole('complementary', { name: 'Left bar' })).toBeInTheDocument()
    })

    it('logs a gesture the controller rejects, and leaves the frame as it was', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      const user = userEvent.setup()
      const { bridge } = await renderFrame(leftBar(), leftViews)
      bridge.invoke.mockRejectedValueOnce(new Error('HANDLER_ERROR: nope'))

      await user.click(screen.getByRole('button', { name: 'Collapse left bar' }))

      expect(error).toHaveBeenCalledWith('[layout] Could not apply', { slot: 'shell.left', collapsed: true }, expect.any(Error))
      expect(screen.getAllByRole('tab')).toHaveLength(2)
      error.mockRestore()
    })
  })
})
