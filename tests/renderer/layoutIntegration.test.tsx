// The whole loop, without Electron: the real router, event hub, LayoutService
// and shell handlers on one side, the real WindowManager on the other, joined
// by a bridge that dispatches requests and forwards published events.
import type { ViewDescriptor } from '@tessera/types'
import { describe, it, expect, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CommandRegistryImpl } from '../../core/commands/CommandRegistry'
import { LayoutService } from '../../core/layout/LayoutService'
import { createPluginContext } from '../../core/plugins/PluginContext'
import { VIEWS_EXTENSION_POINT } from '../../shared/views/types'
import { BAR_ITEMS_EXTENSION_POINT } from '../../shared/layout/types'
import App from '../../shell/renderer/App'
import { BarItemsProvider, createIpcBarItemSource } from '../../shell/renderer/layout/BarItemsProvider'
import { ShellStateProvider } from '../../shell/renderer/state/ShellState'
import { createIpcViewSource } from '../../shell/renderer/views/ipcViewSource'
import { ViewsProvider } from '../../shell/renderer/views/ViewsProvider'
import { createLayoutContent } from '../../shell/main/layout/layoutContent'
import { registerLayout } from '../../shell/main/layout/registerLayout'
import { registerShellEvents } from '../../shell/main/events/shellEvents'
import { fixedAppearance } from '../../shell/main/theme/nativeAppearance'
import { registerTheme } from '../../shell/main/theme/registerTheme'
import { registerViewsIpc } from '../../shell/main/views/viewsIpc'
import { createLogger, createRuntime } from '../helpers/runtime'

const WINDOW_ID = 7

function boot() {
  const runtime = createRuntime()
  const shell = createPluginContext('shell', runtime).context
  const log = createLogger()

  const resources = {
    remoteEntryFor: () => 'tessera-plugin://p/remoteEntry.js',
    assetUrlFor: (id: string, rel: string) => `tessera-plugin://${id}/${rel}`,
    isCommandEnabled: (id: string) => runtime.commands.isEnabled(id)
  }

  registerShellEvents(shell, runtime)
  registerTheme(shell, runtime, { appearance: fixedAppearance(), log })
  registerViewsIpc(shell, resources, log)
  const content = createLayoutContent(runtime.extensions, resources, log)
  const service = new LayoutService(content.source, runtime.contextKeys, { log })
  const registration = registerLayout(shell, runtime, service, content,
    { focusedId: () => WINDOW_ID }, (runtime.commands as CommandRegistryImpl).onDidChange, log)

  // The bridge: invoke dispatches into the router as this window; published
  // events are delivered like the preload does.
  const listeners = new Map<string, Set<(data: unknown) => void>>()
  runtime.events.subscribe(event => {
    listeners.get(event.name)?.forEach(listener => listener(event.data))
  })
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

  registration.attachWindow(WINDOW_ID, 'main')

  const loader = { load: async (view: ViewDescriptor) => () => <p>Body of {view.id}</p> }
  render(
    <ShellStateProvider bridge={bridge as any}>
      <ViewsProvider source={createIpcViewSource(bridge as any)} loader={loader}>
        <BarItemsProvider source={createIpcBarItemSource(bridge as any)}>
          <App />
        </BarItemsProvider>
      </ViewsProvider>
    </ShellStateProvider>
  )

  return { runtime, log }
}

describe('window manager end to end', () => {
  it('runs the full loop: contributions, tabs, commands, items and reveal', async () => {
    const { runtime } = boot()
    const opened = vi.fn()

    // A plugin activates: a navigation view, two pages, a toolbar button and status text.
    await act(async () => {
      runtime.extensions.contribute('accounts', VIEWS_EXTENSION_POINT, 'accounts.list',
        { id: 'accounts.list', title: 'Accounts', slot: 'shell.left', module: './List', icon: 'accounts' })
      runtime.extensions.contribute('accounts', VIEWS_EXTENSION_POINT, 'accounts.register',
        { id: 'accounts.register', title: 'Register', slot: 'shell.main', module: './Register' })
      runtime.extensions.contribute('accounts', VIEWS_EXTENSION_POINT, 'accounts.reports',
        { id: 'accounts.reports', title: 'Reports', slot: 'shell.main', module: './Reports' })
      runtime.extensions.contribute('vault', BAR_ITEMS_EXTENSION_POINT, 'vault.open',
        { kind: 'button', id: 'vault.open', slot: 'shell.top', label: 'Open Vault', command: 'vault.open' })
      runtime.extensions.contribute('vault', BAR_ITEMS_EXTENSION_POINT, 'vault.name',
        { kind: 'text', id: 'vault.name', slot: 'shell.bottom', text: '{vault.name}', when: 'vault.isOpen' })
      runtime.commands.register('vault.open', () => {
        opened()
        runtime.contextKeys.set('vault.isOpen', true)
        runtime.contextKeys.set('vault.name', 'Home Vault')
      })
    })

    // The frame appears: left bar with its tab, the first main view, the button.
    expect(await screen.findByText('Body of accounts.list')).toBeVisible()
    expect(await screen.findByText('Body of accounts.register')).toBeVisible()
    expect(screen.getByRole('tab', { name: /Accounts/ })).toBeInTheDocument()
    // The status text is absent: its `when` is false, so the bottom bar is hidden.
    expect(screen.queryByRole('contentinfo')).not.toBeInTheDocument()

    // Clicking the toolbar button runs the command in the "main process"…
    await userEvent.click(await screen.findByRole('button', { name: 'Open Vault' }))
    expect(opened).toHaveBeenCalledOnce()
    // …whose context keys make the bottom bar appear with the interpolated text.
    expect(await screen.findByText('Home Vault')).toBeVisible()

    // A menu accelerator collapses the left bar to a rail of icons.
    await act(async () => { await runtime.commands.execute('shell.layout.toggle.left') })
    const rail = await screen.findByRole('button', { name: 'Accounts' })
    expect(screen.getByText('Body of accounts.list')).not.toBeVisible()

    // Revealing the accounts list from privileged code expands it again.
    await act(async () => { await runtime.commands.execute('shell.layout.reveal', 'accounts.list') })
    expect(await screen.findByRole('tab', { name: /Accounts/ })).toBeInTheDocument()
    expect(screen.getByText('Body of accounts.list')).toBeVisible()

    // Navigation: revealing a main view swaps the page and keeps the old one mounted.
    await act(async () => { await runtime.commands.execute('shell.layout.reveal', 'accounts.reports') })
    expect(await screen.findByText('Body of accounts.reports')).toBeVisible()
    expect(screen.getByText('Body of accounts.register')).not.toBeVisible()
    expect(runtime.contextKeys.get('shell.layout.main.activeView')).toBe('accounts.reports')

    void rail
  })
})
