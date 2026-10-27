// The theme sample, end to end and without Electron or Module Federation: its
// privileged half contributes a token and a theme on the real registry, the
// real ThemeService resolves them, the real <StyleManager> writes the
// variables, and the plugin's real TSX view reads the snapshot over the real
// router. Selecting the plugin's theme must recolour the document, and
// deactivating the plugin must take its theme and token away cleanly.
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
import { StyleManager } from '../../../shell/renderer/theme/StyleManager'
import { createIpcViewSource } from '../../../shell/renderer/views/ipcViewSource'
import { ViewsProvider } from '../../../shell/renderer/views/ViewsProvider'
import { createLayoutContent } from '../../../shell/main/layout/layoutContent'
import { registerLayout } from '../../../shell/main/layout/registerLayout'
import { registerShellEvents } from '../../../shell/main/events/shellEvents'
import { fixedAppearance } from '../../../shell/main/theme/nativeAppearance'
import { registerTheme } from '../../../shell/main/theme/registerTheme'
import { registerViewsIpc } from '../../../shell/main/views/viewsIpc'
import { activate } from '../../../plugins/theme.sample/src/privileged/index'
import Swatches from '../../../plugins/theme.sample/src/renderer/Swatches'
import { HIGHLIGHT_TOKEN, SEPIA_THEME } from '../../../plugins/theme.sample/src/shared'
import { createLogger, createRuntime } from '../../helpers/runtime'

const WINDOW_ID = 5
const MODULES: Record<string, ComponentType> = { './Swatches': Swatches }

const variable = (name: string) => document.documentElement.style.getPropertyValue(name)

function boot() {
  const runtime = createRuntime()
  const shell = createPluginContext('shell', runtime).context
  const log = createLogger()
  const resources = {
    remoteEntryFor: () => 'tessera-plugin://theme-sample/remoteEntry.js',
    assetUrlFor: (id: string, rel: string) => `tessera-plugin://${id}/${rel}`,
    isCommandEnabled: (id: string) => runtime.commands.isEnabled(id)
  }

  registerShellEvents(shell, runtime)
  registerViewsIpc(shell, resources, log)
  const { service: theme } = registerTheme(shell, runtime, { appearance: fixedAppearance('light'), focusedWindowId: () => WINDOW_ID, log })
  const content = createLayoutContent(runtime.extensions, resources, log)
  const layoutService = new LayoutService(content.source, runtime.contextKeys, { log })
  const layout = registerLayout(shell, runtime, layoutService, content,
    { focusedId: () => WINDOW_ID }, (runtime.commands as CommandRegistryImpl).onDidChange, log)

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

  const plugin = createPluginContext('theme-sample', runtime)
  activate(plugin.context)
  layout.attachWindow(WINDOW_ID, 'main')

  render(
    <ShellStateProvider bridge={bridge as any}>
      <StyleManager>
        <ViewsProvider source={createIpcViewSource(bridge as any)} loader={{ load: async (view: ViewDescriptor) => MODULES[view.module] }}>
          <BarItemsProvider source={createIpcBarItemSource(bridge as any)}>
            <App />
          </BarItemsProvider>
        </ViewsProvider>
      </StyleManager>
    </ShellStateProvider>
  )

  return { runtime, theme, plugin, log }
}

describe('theme-sample plugin, end to end', () => {
  it('shows the resolved tokens, recolours the document when its theme is selected, and withdraws cleanly', async () => {
    const { theme, plugin, log } = boot()

    // The page lists the built-in theme as active and the plugin's theme on offer.
    expect(await screen.findByRole('heading', { name: 'Theme swatches' })).toBeInTheDocument()
    expect(screen.getByText('shell.light', { selector: '[data-theme-sample-active]' })).toBeInTheDocument()
    const sepiaRow = document.querySelector(`[data-theme-sample-theme="${SEPIA_THEME}"]`)!
    expect(within(sepiaRow as HTMLElement).getByText('Sample Sepia')).toBeInTheDocument()

    // The plugin's token resolved through its reference to shell.warning, and reached the document.
    const highlightRow = document.querySelector(`[data-theme-sample-token="${HIGHLIGHT_TOKEN}"]`) as HTMLElement
    expect(within(highlightRow).getByText('#9d5d00')).toBeInTheDocument()
    expect(variable('--theme-sample-highlight')).toBe('#9d5d00')
    expect(variable('--shell-accent')).toBe('#0063b1')

    // Select the plugin's theme: the document and the page follow the push event.
    act(() => { theme.setPreference({ theme: SEPIA_THEME }) })
    expect(await screen.findByText(SEPIA_THEME, { selector: '[data-theme-sample-active]' })).toBeInTheDocument()
    expect(variable('--shell-accent')).toBe('#7a5c1e')
    expect(variable('--shell-background')).toBe('#fbf6ea')
    expect(variable('--theme-sample-highlight')).toBe('#f2e3b8')
    expect(variable('--shell-success')).toBe('#107c10')                // untouched by the theme: the light default
    expect(document.documentElement.dataset.themeId).toBe(SEPIA_THEME)

    // The page's buttons run the shell's commands through shell:commands.execute.
    await act(async () => { await userEvent.click(screen.getByRole('button', { name: 'Toggle light/dark' })) })
    expect(await screen.findByText('shell.dark', { selector: '[data-theme-sample-active]' })).toBeInTheDocument()
    expect(variable('--shell-background')).toBe('#1e1e1e')
    expect(document.documentElement.style.colorScheme).toBe('dark')

    await act(async () => { await userEvent.click(screen.getByRole('button', { name: 'Choose theme…' })) })
    const chooser = await screen.findByRole('dialog', { name: 'Choose Theme' })
    expect(within(chooser).getByRole('radio', { name: /Tessera Dark/ })).toBeChecked()
    await act(async () => { await userEvent.click(within(chooser).getByRole('radio', { name: /Sample Sepia/ })) })
    expect(theme.get().activeTheme).toBe(SEPIA_THEME)                // previewed at once
    await act(async () => { await userEvent.click(within(chooser).getByRole('button', { name: 'Cancel' })) })
    expect(theme.get().activeTheme).toBe('shell.dark')               // and put back
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    act(() => { theme.setPreference({ theme: SEPIA_THEME }) })
    expect(await screen.findByText(SEPIA_THEME, { selector: '[data-theme-sample-active]' })).toBeInTheDocument()

    // Deactivate the plugin: its theme and token go, the shell theme is back, the preference is kept.
    act(() => { plugin.dispose() })
    expect(theme.get()).toMatchObject({ activeTheme: 'shell.light', preference: { theme: SEPIA_THEME } })
    await screen.findByText('Tessera')                                // the main view went with the plugin
    expect(variable('--shell-accent')).toBe('#0063b1')
    expect(variable('--theme-sample-highlight')).toBe('')
    expect(log.warn).toHaveBeenCalledWith(`[theme] Theme "${SEPIA_THEME}" is not available; using "shell.light"`)
  })
})
