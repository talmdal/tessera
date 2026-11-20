// The options dialog, driven end to end: the renderer component in front, the real session, commit and service
// behind it, joined by the real IPC router — only Electron and the federation loader are stood in for.
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useEffect } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { ComponentType } from 'react'
import type { OptionsPageProps } from '@tessera/types'
import { OPTIONS_COMMANDS, OPTIONS_EXTENSION_POINT, OPTIONS_OPEN } from '../../shared/options/types'
import type { ShellOptionsValue } from '../../shared/options/types'
import { DEFAULT_THEME, DEFAULT_THEME_ID, THEME_GET } from '../../shared/theme/types'
import { registerShellOptions } from '../../shell/main/theme/appearanceOptions'
import { OptionsService } from '../../core/options/OptionsService'
import { createMemoryOptionsStore } from '../../core/options/memoryOptionsStore'
import { createPluginContext, createPluginRuntime } from '../../core/plugins/PluginContext'
import { registerOptions } from '../../shell/main/options/registerOptions'
import { OptionsDialog } from '../../shell/renderer/options/OptionsDialog'
import type { ViewLoader } from '../../shell/renderer/views/ports'
import { ShellThemeProvider } from '../../shell/renderer/theme/ShellThemeProvider'
import { createLogger } from '../helpers/runtime'

type Backup = { autoBackup: boolean, backup: { count: number } }

/** The book plugin's page: a checkbox and a count, edited through the draft it is given. */
function BackupPage({ value, onChange, disabled }: OptionsPageProps<Backup>) {
  return (
    <>
      <label>
        <input type="checkbox" disabled={disabled} checked={value.autoBackup}
          onChange={event => onChange({ ...value, autoBackup: event.target.checked })} />
        Back up automatically
      </label>
      <label>
        How many to keep
        <input type="number" disabled={disabled} value={value.backup.count}
          onChange={event => onChange({ ...value, backup: { count: Number(event.target.value) } })} />
      </label>
    </>
  )
}

function LedgerPage({ value, onChange }: OptionsPageProps<{ tidy: boolean }>) {
  return (
    <label>
      <input type="checkbox" checked={value.tidy} onChange={event => onChange({ tidy: event.target.checked })} />
      Keep the ledger tidy
    </label>
  )
}

/** A page whose editors hold something unusable from the start. */
function InvalidPage({ onValidityChange }: OptionsPageProps<unknown>) {
  useEffect(() => { onValidityChange(false) }, [onValidityChange])
  return <p>Nothing here is right.</p>
}

function BrokenPage(): never {
  throw new Error('This page cannot even render')
}

const PAGES: Record<string, ComponentType<OptionsPageProps<never>>> = {
  './BackupPage': BackupPage as ComponentType<OptionsPageProps<never>>,
  './LedgerPage': LedgerPage as ComponentType<OptionsPageProps<never>>,
  './InvalidPage': InvalidPage,
  './BrokenPage': BrokenPage
}

const BACKUP_DEFAULTS: Backup = { autoBackup: true, backup: { count: 5 } }

function setup() {
  const log = createLogger()
  const options = new OptionsService(createMemoryOptionsStore(), { log })
  const runtime = createPluginRuntime(undefined, log, options)
  const shell = createPluginContext('shell', runtime).context
  registerShellOptions(options)
  registerOptions(shell, runtime, {
    options,
    remoteEntryFor: () => 'tessera-plugin://x/remoteEntry.js',
    targetWindow: () => 1,
    log
  })

  // The book plugin: options with validation, and a page that edits them.
  const book = createPluginContext('book', runtime).context
  const handle = book.options.register({
    defaults: BACKUP_DEFAULTS,
    validate: value => value.backup.count >= 1 ? [] : ['Keep at least one backup']
  })
  book.extensions.contribute('book', OPTIONS_EXTENSION_POINT, 'book.options', {
    id: 'book.options', title: 'Backups', module: './BackupPage'
  })

  // The renderer's bridge is the real router, speaking as window 1; push events come from the real event hub.
  const listeners = new Map<string, Set<(data: unknown) => void>>()
  runtime.events.subscribe(event => listeners.get(event.name)?.forEach(listener => listener(event.data)))
  const bridge = {
    invoke: vi.fn(async (channel: string, data?: unknown) => {
      const reply = await runtime.ipc.dispatch({ channel, data }, { windowId: 1 })
      if (!reply.ok) throw new Error(reply.error.message)
      return reply.data
    }),
    on: vi.fn((name: string, listener: (data: unknown) => void) => {
      if (!listeners.has(name)) listeners.set(name, new Set())
      listeners.get(name)!.add(listener)
      return () => { listeners.get(name)!.delete(listener) }
    })
  } as never

  // The built-in Appearance page reads the themes over window.api, as shell components do.
  ;(window as { api?: unknown }).api = bridge
  shell.ipc.register(THEME_GET, () => ({
    state: { windowId: 1, global: { theme: DEFAULT_THEME_ID, mode: 'system' }, theme: DEFAULT_THEME_ID, mode: 'light' },
    themes: [DEFAULT_THEME],
    systemPrefersDark: false
  }))

  const loader: ViewLoader = {
    load: vi.fn(async (remote: { module: string }) => {
      const page = PAGES[remote.module]
      if (!page) throw new Error(`Module ${remote.module} is not exposed`)
      return page as ComponentType<unknown>
    })
  }

  const themeSnapshot = {
    state: { windowId: 1, global: { theme: DEFAULT_THEME.id, mode: 'system' as const }, theme: DEFAULT_THEME.id, mode: 'light' as const },
    themes: [DEFAULT_THEME],
    systemPrefersDark: false
  }

  render(
    <ShellThemeProvider bridge={bridge} initial={themeSnapshot}>
      <OptionsDialog bridge={bridge} loader={loader} />
    </ShellThemeProvider>)

  /** Tools ▸ Options…, for real: the command mints the session and the event opens the dialog. */
  const openIt = async () => {
    await act(async () => { await runtime.commands.execute(OPTIONS_COMMANDS.open) })
    await screen.findByRole('dialog', { name: 'Options' })
  }

  const contributePage = (contributor: string, impl: Record<string, unknown>) =>
    runtime.extensions.contribute(contributor, OPTIONS_EXTENSION_POINT, String(impl.id), impl)

  /** A further plugin with options and a page, like the book but simpler. */
  const addPlugin = (id: string, title: string, module: string, defaults: Record<string, unknown> = {}) => {
    createPluginContext(id, runtime).context.options.register({ defaults })
    contributePage(id, { id: `${id}.options`, title, module })
  }

  return { runtime, options, handle, bridge, loader, log, openIt, contributePage, addPlugin }
}

const dialog = () => screen.getByRole('dialog', { name: 'Options' })
const page = (name: string) => within(within(dialog()).getByRole('list', { name: 'Option pages' })).getByRole('button', { name })
const button = (name: string) => within(dialog()).getByRole('button', { name })
const checkbox = () => within(dialog()).getByRole('checkbox', { name: 'Back up automatically' }) as HTMLInputElement
const count = () => within(dialog()).getByRole('spinbutton', { name: /How many to keep/ }) as HTMLInputElement

describe('the options dialog: a page and its draft', () => {
  it('shows the page with the stored value, fetched once per session', async () => {
    const { options, openIt, bridge } = setup()
    options.commit('book', { autoBackup: false, backup: { count: 5 } })

    await openIt()
    await waitFor(() => expect(checkbox().checked).toBe(false))

    await userEvent.click(page('Backups'))
    expect((bridge as any).invoke.mock.calls.filter((call: unknown[]) => String(call[0]).endsWith('options.get'))).toHaveLength(1)
  })

  it('keeps an edit while the user moves around the tree, marking the page dirty', async () => {
    const { openIt, addPlugin } = setup()
    addPlugin('ledger', 'Ledger', './LedgerPage', { tidy: false })
    await openIt()
    await waitFor(() => checkbox())

    await userEvent.click(checkbox())
    expect(page('Backups •')).toBeInTheDocument()

    await userEvent.click(page('Ledger'))
    await waitFor(() => within(dialog()).getByRole('checkbox', { name: 'Keep the ledger tidy' }))
    await userEvent.click(page('Backups •'))

    expect(checkbox().checked).toBe(false)      // still pending, not forgotten and not saved
  })

  it('changes nothing in the application until the user applies', async () => {
    const { handle, openIt } = setup()
    await openIt()
    await waitFor(() => checkbox())

    await userEvent.click(checkbox())

    expect(handle.get().autoBackup).toBe(true)
  })
})

describe('the options dialog: Apply, OK and Cancel', () => {
  it('is dormant until something is dirty', async () => {
    const { openIt } = setup()
    await openIt()
    await waitFor(() => checkbox())

    expect(button('Apply')).toBeDisabled()
    await userEvent.click(checkbox())
    expect(button('Apply')).toBeEnabled()
  })

  it('Apply saves what is dirty, tells the plugin, and stays open', async () => {
    const { handle, openIt } = setup()
    await openIt()
    await waitFor(() => checkbox())
    await userEvent.click(checkbox())

    await userEvent.click(button('Apply'))

    await waitFor(() => expect(handle.get().autoBackup).toBe(false))
    expect(dialog()).toBeInTheDocument()
    expect(page('Backups')).toBeInTheDocument()               // the dirty mark is gone: it is the baseline now
    await waitFor(() => expect(button('Apply')).toBeDisabled())
  })

  it('OK applies and closes; the session is over', async () => {
    const { handle, openIt, bridge } = setup()
    await openIt()
    await waitFor(() => checkbox())
    await userEvent.click(checkbox())

    await userEvent.click(button('OK'))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(handle.get().autoBackup).toBe(false)
    const closed = (bridge as any).invoke.mock.calls.find((call: unknown[]) => String(call[0]).endsWith('options.closed'))
    expect(closed).toBeDefined()
  })

  it('OK with nothing dirty just closes', async () => {
    const { openIt, bridge } = setup()
    await openIt()
    await waitFor(() => checkbox())

    await userEvent.click(button('OK'))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect((bridge as any).invoke.mock.calls.some((call: unknown[]) => String(call[0]).endsWith('options.commit'))).toBe(false)
  })

  it('Cancel with nothing dirty closes without a word', async () => {
    const { openIt } = setup()
    await openIt()
    await waitFor(() => checkbox())

    await userEvent.click(button('Cancel'))

    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('Cancel with edits asks first; Keep Editing keeps them, Discard drops them', async () => {
    const { handle, openIt } = setup()
    await openIt()
    await waitFor(() => checkbox())
    await userEvent.click(checkbox())

    await userEvent.click(button('Cancel'))
    const confirm = screen.getByRole('dialog', { name: 'Discard your changes?' })
    await userEvent.click(within(confirm).getByRole('button', { name: 'Keep Editing' }))
    expect(checkbox().checked).toBe(false)                    // the edit is still there

    await userEvent.click(button('Cancel'))
    await userEvent.click(within(screen.getByRole('dialog', { name: 'Discard your changes?' })).getByRole('button', { name: 'Discard' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(handle.get().autoBackup).toBe(true)                // nothing was saved
  })

  it('a validation failure keeps the dialog open on the failing page while the rest still saves', async () => {
    const { runtime, options, openIt, contributePage } = setup()
    const ledger = createPluginContext('ledger', runtime).context
    ledger.options.register({ defaults: { tidy: false } })
    contributePage('ledger', { id: 'ledger.options', title: 'Ledger', module: './LedgerPage' })
    await openIt()

    // Break the book page, fix up the ledger page, and save both.
    await waitFor(() => count())
    fireEvent.change(count(), { target: { value: '0' } })
    await userEvent.click(page('Ledger'))
    const tidy = await within(dialog()).findByRole('checkbox', { name: 'Keep the ledger tidy' })
    await userEvent.click(tidy)
    await userEvent.click(button('OK'))

    // Still open, back on Backups, saying why; the ledger's save went through.
    await within(dialog()).findByText('Keep at least one backup')
    expect(within(dialog()).getByRole('heading', { level: 3 })).toHaveTextContent('Backups')
    expect(options.get('ledger')).toEqual({ tidy: true })
    expect(options.get<Backup>('book')!.backup.count).toBe(5)

    // Putting it right clears the message on the next save.
    fireEvent.change(count(), { target: { value: '3' } })
    await userEvent.click(button('OK'))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(options.get<Backup>('book')!.backup.count).toBe(3)
  })
})

describe('the options dialog: Restore Defaults', () => {
  it('is a pending edit like any other, saved only by Apply or OK', async () => {
    const { options, handle, openIt } = setup()
    options.commit('book', { autoBackup: false, backup: { count: 9 } })
    await openIt()
    await waitFor(() => expect(checkbox().checked).toBe(false))

    await userEvent.click(button('Restore Defaults'))
    // It asks first; restoring is still only a pending edit.
    const confirm = screen.getByRole('dialog', { name: 'Restore the defaults?' })
    await userEvent.click(within(confirm).getByRole('button', { name: 'Restore' }))

    expect(checkbox().checked).toBe(true)                     // the draft is the defaults again
    expect(count().value).toBe('5')
    expect(handle.get().autoBackup).toBe(false)               // but nothing is saved yet
    expect(button('Apply')).toBeEnabled()

    await userEvent.click(button('Apply'))
    await waitFor(() => expect(handle.get()).toEqual(BACKUP_DEFAULTS))
  })

  it('has nothing to do while the page already shows the defaults', async () => {
    const { openIt } = setup()
    await openIt()
    await waitFor(() => checkbox())

    expect(button('Restore Defaults')).toBeDisabled()
  })
})

describe('the options dialog: pages that cannot behave', () => {
  it('a page that says its editors hold something unusable gates Apply and OK', async () => {
    const { openIt, addPlugin } = setup()
    addPlugin('frail', 'Frail', './InvalidPage')
    await openIt()
    await waitFor(() => checkbox())
    await userEvent.click(checkbox())                          // something is dirty, so Apply would be enabled

    await userEvent.click(page('Frail'))
    await within(dialog()).findByText('Nothing here is right.')

    expect(button('Apply')).toBeDisabled()
    expect(button('OK')).toBeDisabled()
  })

  it('a page that crashes costs that page, never the dialog', async () => {
    const { openIt, addPlugin } = setup()
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    addPlugin('broken', 'Broken', './BrokenPage')
    await openIt()

    await userEvent.click(page('Broken'))
    await within(dialog()).findByText('“Broken” could not be displayed.')

    await userEvent.click(page('Backups'))
    await waitFor(() => expect(checkbox()).toBeInTheDocument())
    quiet.mockRestore()
  })

  it('says so when a page belongs to a plugin that registered no options', async () => {
    const { openIt, contributePage } = setup()
    contributePage('ghost', { id: 'ghost.options', title: 'Ghost', module: './LedgerPage' })
    await openIt()

    await userEvent.click(page('Ghost'))

    await within(dialog()).findByText(/registered no options/)
  })
})

describe('the options dialog: the shell’s built-in Appearance page', () => {
  it('chooses the application theme through the ordinary draft, dirty mark and commit', async () => {
    const { options, openIt } = setup()
    await openIt()

    await userEvent.click(page('Appearance'))
    await userEvent.click(await within(dialog()).findByRole('button', { name: 'Dark' }))

    expect(page('Appearance •')).toBeInTheDocument()            // pending, like any other option
    await userEvent.click(button('OK'))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(options.get<ShellOptionsValue>('shell')!.appearance).toEqual({ theme: DEFAULT_THEME_ID, mode: 'dark' })
  })
})

describe('the options dialog: Restore Defaults asks first', () => {
  it('keeps the settings when the user thinks better of it', async () => {
    const { options, openIt } = setup()
    options.commit('book', { autoBackup: false, backup: { count: 9 } })
    await openIt()
    await waitFor(() => expect(checkbox().checked).toBe(false))

    await userEvent.click(button('Restore Defaults'))
    await userEvent.click(within(screen.getByRole('dialog', { name: 'Restore the defaults?' })).getByRole('button', { name: 'Keep My Settings' }))

    expect(checkbox().checked).toBe(false)                    // untouched
    expect(button('Apply')).toBeDisabled()                    // and nothing pending
  })
})

describe('the options dialog: search', () => {
  const search = () => within(dialog()).getByRole('textbox', { name: 'Search options' })
  const treeTitles = () => within(within(dialog()).getByRole('list', { name: 'Option pages' }))
    .getAllByRole('button').map(item => item.textContent)

  it('filters the tree by title, keeping the ancestors of a match in sight', async () => {
    const { runtime, openIt, contributePage } = setup()
    createPluginContext('ledger', runtime).context.options.register({ defaults: { tidy: false } })
    contributePage('ledger', { id: 'ledger.options', title: 'Ledger', module: './LedgerPage', parent: 'shell.options.general' })
    await openIt()

    await userEvent.type(search(), 'ledg')

    expect(treeTitles()).toEqual(['General', 'Ledger'])       // the parent stays for context; Backups and Appearance are gone
  })

  it('matches keywords as well as titles', async () => {
    const { runtime, openIt, contributePage } = setup()
    createPluginContext('ledger', runtime).context.options.register({ defaults: { tidy: false } })
    contributePage('ledger', { id: 'ledger.options', title: 'Ledger', module: './LedgerPage', keywords: ['sweep', 'tidy'] })
    await openIt()

    await userEvent.type(search(), 'sweep')

    expect(treeTitles()).toEqual(['Ledger'])
  })

  it('shows everything under a matching category', async () => {
    const { runtime, openIt, contributePage } = setup()
    createPluginContext('ledger', runtime).context.options.register({ defaults: { tidy: false } })
    contributePage('ledger', { id: 'ledger.options', title: 'Ledger', module: './LedgerPage', parent: 'shell.options.general' })
    await openIt()

    await userEvent.type(search(), 'general')

    expect(treeTitles()).toEqual(['General', 'Ledger'])
  })

  it('moves the selection to a page still in sight when the search hides the selected one', async () => {
    const { openIt } = setup()
    await openIt()
    await waitFor(() => checkbox())                           // on Backups

    await userEvent.type(search(), 'appearance')

    await waitFor(() => expect(within(dialog()).getByRole('heading', { level: 3 })).toHaveTextContent('Appearance'))
  })

  it('says so when nothing matches, and comes back whole when cleared', async () => {
    const { openIt } = setup()
    await openIt()

    await userEvent.type(search(), 'xyzzy')
    expect(within(dialog()).getByText(/Nothing matches/)).toBeInTheDocument()

    await userEvent.clear(search())
    expect(treeTitles()).toEqual(['General', 'Backups', 'Appearance'])
  })

  it('keeps a pending edit through a search and back', async () => {
    const { openIt } = setup()
    await openIt()
    await waitFor(() => checkbox())
    await userEvent.click(checkbox())

    await userEvent.type(search(), 'appearance')
    await userEvent.clear(search())
    await userEvent.click(page('Backups •'))

    expect(checkbox().checked).toBe(false)
  })
})

describe('the options dialog: opening at a page', () => {
  const item = (name: string) => within(within(dialog()).getByRole('list', { name: 'Option pages' })).getByRole('button', { name })

  it('starts on the page asked for', async () => {
    const { runtime, addPlugin } = setup()
    addPlugin('ledger', 'Ledger', './LedgerPage', { tidy: false })
    await act(async () => { await runtime.commands.execute(OPTIONS_COMMANDS.open, { page: 'ledger.options' }) })
    await screen.findByRole('dialog', { name: 'Options' })
    await waitFor(() => expect(item('Ledger')).toHaveAttribute('aria-current', 'page'))
  })

  it('starts where it always does when the page asked for is not there', async () => {
    const { runtime, addPlugin } = setup()
    addPlugin('ledger', 'Ledger', './LedgerPage', { tidy: false })
    await act(async () => { await runtime.commands.execute(OPTIONS_COMMANDS.open, { page: 'nobody.options.missing' }) })
    await screen.findByRole('dialog', { name: 'Options' })
    // The first page that shows something, as with no page asked for: here, the Backups test page
    await waitFor(() => expect(item('Backups')).toHaveAttribute('aria-current', 'page'))
    expect(item('Ledger')).not.toHaveAttribute('aria-current')
  })
})

describe('the options dialog: keyboard navigation', () => {
  const item = (name: string) => within(within(dialog()).getByRole('list', { name: 'Option pages' })).getByRole('button', { name })
  const search = () => within(dialog()).getByRole('textbox', { name: 'Search options' })

  it('opens with the search field focused, and the arrow keys work from there at once', async () => {
    const { openIt } = setup()
    await openIt()
    await waitFor(() => checkbox())
    expect(search()).toHaveFocus()                            // where the dialog actually puts the user

    fireEvent.keyDown(search(), { key: 'ArrowUp' })            // Backups is second: up lands on General
    await waitFor(() => expect(item('General')).toHaveAttribute('aria-current', 'page'))
    expect(search()).toHaveFocus()                            // typing can carry on

    fireEvent.keyDown(search(), { key: 'ArrowDown' })
    await waitFor(() => expect(within(dialog()).getByRole('heading', { level: 3 })).toHaveTextContent('Backups'))
  })

  it('walks the tree with the arrow keys from a row, taking the focus along', async () => {
    const { openIt } = setup()
    await openIt()
    await waitFor(() => checkbox())

    item('Backups').focus()
    fireEvent.keyDown(item('Backups'), { key: 'ArrowDown' })
    await waitFor(() => expect(within(dialog()).getByRole('heading', { level: 3 })).toHaveTextContent('Appearance'))
    expect(item('Appearance')).toHaveFocus()

    fireEvent.keyDown(item('Appearance'), { key: 'ArrowUp' })
    await waitFor(() => expect(within(dialog()).getByRole('heading', { level: 3 })).toHaveTextContent('Backups'))
  })

  it('jumps to the ends with Home and End, and stops at them', async () => {
    const { openIt } = setup()
    await openIt()
    await waitFor(() => checkbox())

    fireEvent.keyDown(search(), { key: 'End' })
    await waitFor(() => expect(within(dialog()).getByRole('heading', { level: 3 })).toHaveTextContent('Appearance'))
    fireEvent.keyDown(search(), { key: 'ArrowDown' })          // already last: stays
    expect(within(dialog()).getByRole('heading', { level: 3 })).toHaveTextContent('Appearance')

    fireEvent.keyDown(search(), { key: 'Home' })
    await waitFor(() => expect(item('General')).toHaveAttribute('aria-current', 'page'))
  })

  it('searches and chooses in one gesture: type, then arrow onto the match', async () => {
    const { runtime, openIt, contributePage } = setup()
    createPluginContext('ledger', runtime).context.options.register({ defaults: { tidy: false } })
    contributePage('ledger', { id: 'ledger.options', title: 'Ledger', module: './LedgerPage', parent: 'shell.options.general' })
    await openIt()

    await userEvent.type(search(), 'ledg')
    fireEvent.keyDown(search(), { key: 'End' })

    await waitFor(() => expect(within(dialog()).getByRole('heading', { level: 3 })).toHaveTextContent('Ledger'))
    expect(search()).toHaveFocus()
  })

  it('keeps the tree to one tab stop, so Tab does not walk every page', async () => {
    const { openIt } = setup()
    await openIt()
    await waitFor(() => checkbox())

    expect(item('Backups')).toHaveAttribute('tabindex', '0')   // the selected one
    expect(item('General')).toHaveAttribute('tabindex', '-1')
    expect(item('Appearance')).toHaveAttribute('tabindex', '-1')
  })
})

describe('the options dialog: Enter is the default action', () => {
  const search = () => within(dialog()).getByRole('textbox', { name: 'Search options' })

  it('saves and closes, as OK would', async () => {
    const { handle, openIt } = setup()
    await openIt()
    await waitFor(() => checkbox())
    await userEvent.click(checkbox())

    fireEvent.keyDown(search(), { key: 'Enter' })

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(handle.get().autoBackup).toBe(false)
  })

  it('works from a field on the page itself', async () => {
    const { options, openIt } = setup()
    await openIt()
    await waitFor(() => count())
    fireEvent.change(count(), { target: { value: '7' } })

    fireEvent.keyDown(count(), { key: 'Enter' })

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(options.get<Backup>('book')!.backup.count).toBe(7)
  })

  it('leaves a focused button to do its own job', async () => {
    const { handle, openIt } = setup()
    await openIt()
    await waitFor(() => checkbox())
    await userEvent.click(checkbox())

    // Enter on Cancel means Cancel, not OK: the question appears and nothing is saved.
    fireEvent.keyDown(button('Cancel'), { key: 'Enter' })

    expect(screen.queryByRole('dialog', { name: 'Discard your changes?' })).toBeNull()
    expect(handle.get().autoBackup).toBe(true)
  })

  it('answers the question on top rather than the dialog beneath', async () => {
    const { handle, openIt } = setup()
    await openIt()
    await waitFor(() => checkbox())
    await userEvent.click(checkbox())
    await userEvent.click(button('Cancel'))

    const confirm = screen.getByRole('dialog', { name: 'Discard your changes?' })
    expect(within(confirm).getByRole('button', { name: 'Keep Editing' })).toHaveFocus()
    await userEvent.keyboard('{Enter}')

    expect(screen.queryByRole('dialog', { name: 'Discard your changes?' })).toBeNull()
    expect(dialog()).toBeInTheDocument()                      // still open, still editing
    expect(checkbox().checked).toBe(false)
    expect(handle.get().autoBackup).toBe(true)                // and nothing was saved behind the question
  })

  it('does nothing while a page says its editors hold something unusable', async () => {
    const { handle, openIt, addPlugin } = setup()
    addPlugin('frail', 'Frail', './InvalidPage')
    await openIt()
    await waitFor(() => checkbox())
    await userEvent.click(checkbox())
    await userEvent.click(page('Frail'))
    await within(dialog()).findByText('Nothing here is right.')

    fireEvent.keyDown(search(), { key: 'Enter' })

    expect(dialog()).toBeInTheDocument()
    expect(handle.get().autoBackup).toBe(true)
  })
})

describe('the options dialog: reporting a partial Apply', () => {
  it('says why Apply and OK are off while a page needs attention', async () => {
    const { openIt, addPlugin } = setup()
    addPlugin('frail', 'Frail', './InvalidPage')
    await openIt()
    await waitFor(() => checkbox())
    await userEvent.click(checkbox())

    await userEvent.click(page('Frail'))
    await within(dialog()).findByText('Nothing here is right.')

    expect(within(dialog()).getByText(/“Frail” needs attention/)).toBeInTheDocument()
    expect(button('Apply')).toBeDisabled()
  })

  it('says what was saved and what was not, and marks the failing page in the tree', async () => {
    const { runtime, openIt, contributePage } = setup()
    createPluginContext('ledger', runtime).context.options.register({ defaults: { tidy: false } })
    contributePage('ledger', { id: 'ledger.options', title: 'Ledger', module: './LedgerPage' })
    await openIt()

    await waitFor(() => count())
    fireEvent.change(count(), { target: { value: '0' } })      // the book page will fail validation
    await userEvent.click(page('Ledger'))
    await userEvent.click(await within(dialog()).findByRole('checkbox', { name: 'Keep the ledger tidy' }))
    await userEvent.click(button('Apply'))

    const summary = await within(dialog()).findByText(/could not be/)
    expect(summary.textContent).toContain('Your changes to Ledger were saved.')
    expect(summary.textContent).toContain('Your changes to Backups could not be')
    expect(page('Backups ⚠ •')).toBeInTheDocument()            // failing and still unsaved
    expect(page('Ledger')).toBeInTheDocument()                 // saved: no marks

    // Putting it right clears the report with the next Apply.
    fireEvent.change(count(), { target: { value: '3' } })
    await userEvent.click(button('Apply'))
    await waitFor(() => expect(within(dialog()).queryByText(/could not be/)).toBeNull())
    expect(page('Backups')).toBeInTheDocument()
  })
})

describe('the options dialog: a failed save stops talking once the user acts', () => {
  it('clears the messages on a page as soon as its value changes again', async () => {
    const { openIt } = setup()
    await openIt()
    await waitFor(() => count())

    fireEvent.change(count(), { target: { value: '0' } })
    await userEvent.click(button('Apply'))
    await within(dialog()).findByText('Keep at least one backup')
    expect(page('Backups ⚠ •')).toBeInTheDocument()

    fireEvent.change(count(), { target: { value: '2' } })

    expect(within(dialog()).queryByText('Keep at least one backup')).toBeNull()
    expect(page('Backups •')).toBeInTheDocument()             // still unsaved, no longer complained about
  })
})

describe('the options dialog: asking for it again while it is open', () => {
  it('leaves the dialog and its pending edits alone, and can still save', async () => {
    const { handle, openIt } = setup()
    await openIt()
    await waitFor(() => checkbox())
    await userEvent.click(checkbox())

    await openIt()                                            // Tools ▸ Options… again, or Ctrl+, twice

    expect(checkbox().checked).toBe(false)                    // the edit survived
    expect(page('Backups •')).toBeInTheDocument()
    await userEvent.click(button('OK'))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(handle.get().autoBackup).toBe(false)               // the session was still good
  })
})
