// The sample plugin, end to end and without Electron or Module Federation:
// its privileged half activates on the real runtime and shell handlers, its
// real TSX views render inside the real window manager, and the bridge between
// them is the real router and event hub. Clicking a bar's button must reach the
// privileged side, whose pushed state must update every view and switch the
// content page.
import type { ViewDescriptor } from '@tessera/types'
import { describe, it, expect } from 'vitest'
import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ComponentType } from 'react'
import { CommandRegistryImpl } from '../../../core/commands/CommandRegistry'
import { LayoutService } from '../../../core/layout/LayoutService'
import { createPluginContext } from '../../../core/plugins/PluginContext'
import App from '../../../shell/renderer/App'
import { BarItemsProvider, createIpcBarItemSource } from '../../../shell/renderer/layout/BarItemsProvider'
import { ShellStateProvider } from '../../../shell/renderer/state/ShellState'
import { createIpcViewSource } from '../../../shell/renderer/views/ipcViewSource'
import { ViewsProvider } from '../../../shell/renderer/views/ViewsProvider'
import { createLayoutContent } from '../../../shell/main/layout/layoutContent'
import { registerLayout } from '../../../shell/main/layout/registerLayout'
import { registerShellEvents } from '../../../shell/main/events/shellEvents'
import { registerViewsIpc } from '../../../shell/main/views/viewsIpc'
import { activate } from '../../../plugins/layout.sample/src/privileged/index'
import Dashboard from '../../../plugins/layout.sample/src/renderer/Dashboard'
import Detail from '../../../plugins/layout.sample/src/renderer/Detail'
import TopPanel from '../../../plugins/layout.sample/src/renderer/TopPanel'
import BottomPanel from '../../../plugins/layout.sample/src/renderer/BottomPanel'
import LeftPanel from '../../../plugins/layout.sample/src/renderer/LeftPanel'
import RightPanel from '../../../plugins/layout.sample/src/renderer/RightPanel'
import { createLogger, createRuntime } from '../../helpers/runtime'

const WINDOW_ID = 3

// What the federation loader would fetch from modules/layout-sample/renderer/.
const MODULES: Record<string, ComponentType> = {
  './Dashboard': Dashboard, './Detail': Detail,
  './TopPanel': TopPanel, './BottomPanel': BottomPanel, './LeftPanel': LeftPanel, './RightPanel': RightPanel
}

function boot() {
  const runtime = createRuntime()
  const shell = createPluginContext('shell', runtime).context
  const log = createLogger()
  const resources = {
    remoteEntryFor: () => 'tessera-plugin://layout-sample/remoteEntry.js',
    assetUrlFor: (id: string, rel: string) => `tessera-plugin://${id}/${rel}`,
    isCommandEnabled: (id: string) => runtime.commands.isEnabled(id)
  }

  registerShellEvents(shell, runtime)
  registerViewsIpc(shell, resources, log)
  const content = createLayoutContent(runtime.extensions, resources, log)
  const service = new LayoutService(content.source, runtime.contextKeys, { log })
  const layout = registerLayout(shell, runtime, service, content,
    { focusedId: () => WINDOW_ID }, (runtime.commands as CommandRegistryImpl).onDidChange, log)

  // The bridge: requests dispatch into the router as this window, events are
  // delivered like the preload does. Installed as window.api, which is what
  // the plugin's views use.
  const listeners = new Map<string, Set<(data: unknown) => void>>()
  runtime.events.subscribe(event => listeners.get(event.name)?.forEach(listener => listener(event.data)))
  const bridge = {
    invoke: async (channel: string, data?: unknown) => {
      const response = await runtime.ipc.dispatch({ channel, data }, { windowId: WINDOW_ID })
      if (response.ok) return response.data
      throw new Error(`${response.error.code}: ${response.error.message}`)
    },
    on: (name: string, listener: (data: unknown) => void) => {
      if (!listeners.has(name)) listeners.set(name, new Set())
      listeners.get(name)!.add(listener)
      return () => { listeners.get(name)!.delete(listener) }
    }
  }
  ;(window as any).api = bridge

  // The plugin activates, as PluginManager would do it.
  activate(createPluginContext('layout-sample', runtime).context)

  layout.attachWindow(WINDOW_ID, 'main')

  const loader = { load: async (view: ViewDescriptor) => MODULES[view.module] }
  render(
    <ShellStateProvider bridge={bridge as any}>
      <ViewsProvider source={createIpcViewSource(bridge as any)} loader={loader}>
        <BarItemsProvider source={createIpcBarItemSource(bridge as any)}>
          <App />
        </BarItemsProvider>
      </ViewsProvider>
    </ShellStateProvider>
  )

  return { runtime, service }
}

describe('layout-sample plugin, end to end', () => {
  it('fills every slot, and a bar button drives the privileged side, which updates all views and the page', async () => {
    const { runtime, service } = boot()

    // Every slot has the plugin's view; the main area shows the dashboard.
    const left = await screen.findByRole('complementary', { name: 'Left bar' })
    const right = await screen.findByRole('complementary', { name: 'Right bar' })
    const top = await screen.findByRole('banner')
    const bottom = await screen.findByRole('contentinfo')
    for (const region of [left, right, top, bottom]) {
      expect(await within(region).findByRole('button', { name: /Ping from/ })).toBeInTheDocument()
    }
    const page = await screen.findByText('Layout sample')
    expect(page).toBeVisible()
    expect(screen.queryByText('Ping received')).not.toBeInTheDocument()   // detail not shown, so not loaded

    // The toolbar button item is there but disabled (nothing to reset), and no status text yet.
    expect(await screen.findByRole('button', { name: 'Reset sample' })).toBeDisabled()
    expect(screen.queryByText(/Sample pings:/)).not.toBeInTheDocument()

    // Press the left bar's button. Wait for the privileged side to have handled it.
    const leftButton = within(left).getByRole('button', { name: 'Ping from left' })
    await act(async () => { await userEvent.click(leftButton) })

    // 1. The privileged side updated its state and keys.
    expect(runtime.contextKeys.get('layout-sample.pings')).toBe(1)

    // 2. The pushed event reached the bar view (the one clicked) and the others.
    expect(await within(left).findByText('1')).toBeInTheDocument()
    expect(within(left).getByText(/most recent/)).toBeInTheDocument()
    expect(within(right).getByText('0')).toBeInTheDocument()

    // 3. The content page changed: the Detail view was revealed and names the bar.
    expect(await screen.findByText('Ping received')).toBeVisible()
    expect(screen.getByText('Layout sample')).not.toBeVisible()       // dashboard stays mounted, hidden
    expect(screen.getByText('left', { selector: '[data-sample-last-side]' })).toBeInTheDocument()
    expect(service.get(WINDOW_ID).main.activeView).toBe('layout-sample.detail')

    // 4. Items followed the keys: the status text appeared, the toolbar button enabled.
    expect(await screen.findByText('Sample pings: 1')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reset sample' })).toBeEnabled()

    // A second bar: counts accumulate, the detail page re-renders for the new side.
    await act(async () => { await userEvent.click(within(top).getByRole('button', { name: 'Ping from top' })) })
    expect(await screen.findByText('top', { selector: '[data-sample-last-side]' })).toBeInTheDocument()
    expect(await screen.findByText('Sample pings: 2')).toBeInTheDocument()

    // Back from the detail page runs one of the plugin's own commands through the shell.
    await act(async () => { await userEvent.click(screen.getByRole('button', { name: 'Back to the dashboard' })) })
    expect(await screen.findByText('Layout sample')).toBeVisible()
    expect(screen.getByText('Ping received')).not.toBeVisible()
    expect(screen.getByText('2', { selector: '[data-sample-total="all"]' })).toBeInTheDocument()

    // Reset from the toolbar item: zero everywhere, status text gone.
    await act(async () => { await userEvent.click(screen.getByRole('button', { name: 'Reset sample' })) })
    expect(await screen.findByText('0', { selector: '[data-sample-total="all"]' })).toBeInTheDocument()
    expect(screen.queryByText(/Sample pings:/)).not.toBeInTheDocument()
    expect(within(left).getByText('0')).toBeInTheDocument()
  })
})
