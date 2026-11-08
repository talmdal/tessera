import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, inject, it, vi } from 'vitest'
import { useEffect } from 'react'
import type { ComponentType } from 'react'
import type { SettingsCommitResult, SettingsNamespaceSnapshot, SettingsPageProps, ThemeSnapshot } from '@tessera/types'
import {
  SETTINGS_CHANGED, SETTINGS_COMMIT, SETTINGS_GET, SETTINGS_OPEN, SettingsCatalogue, SettingsCommitRequest, SettingsPageInfo
} from '../../shared/settings/types'
import { DEFAULT_THEME, THEME_GET } from '../../shared/theme/types'
import { SettingsDialog } from '../../shell/renderer/settings/SettingsDialog'
import { ShellThemeProvider } from '../../shell/renderer/theme/ShellThemeProvider'
import { createFederationViewLoader } from '../../shell/renderer/views/federationViewLoader'
import type { ViewLoader } from '../../shell/renderer/views/ports'
import { createFakeRemote } from '../helpers/fakeBridge'
import { settle } from '../helpers/settle'
import { DEFAULT_FONT_SETTINGS } from '../../shared/fonts/resolveFonts'

const theme: ThemeSnapshot = {
  state: { windowId: 1, global: { theme: DEFAULT_THEME.id, mode: 'light' }, theme: DEFAULT_THEME.id, mode: 'light' },
  themes: [DEFAULT_THEME],
  fonts: DEFAULT_FONT_SETTINGS
}

const LEDGER = { reopenLast: true, recentLimit: 10, sort: 'name' }
const ledger = (value: object = {}, extra: Partial<SettingsNamespaceSnapshot> = {}): SettingsNamespaceSnapshot =>
  ({ id: 'ledger', owner: 'ledger', value: { ...LEDGER, ...value }, defaults: LEDGER, ...extra })
const accounts = (value: object = {}): SettingsNamespaceSnapshot =>
  ({ id: 'accounts', owner: 'accounts', value: { compact: false, ...value }, defaults: { compact: false } })

const PAGES: SettingsPageInfo[] = [
  { id: 'ledger.root', title: 'Ledger', pluginId: 'ledger', keywords: [], description: 'Ledger files.' },
  {
    id: 'ledger.settings', title: 'Start-up', pluginId: 'ledger', parent: 'ledger.root', settings: 'ledger', keywords: ['launch'],
    fields: [
      { kind: 'boolean', key: 'reopenLast', label: 'Reopen the last ledger', description: 'Instead of the start page' },
      { kind: 'number', key: 'recentLimit', label: 'Recent ledgers', min: 1, max: 30, integer: true, unit: 'ledgers' }
    ]
  },
  {
    id: 'ledger.order', title: 'Order', pluginId: 'ledger', parent: 'ledger.root', settings: 'ledger', keywords: [],
    fields: [{ kind: 'choice', key: 'sort', label: 'Sort recent ledgers by', options: [{ value: 'name', label: 'Name' }, { value: 'date', label: 'Date opened', description: 'The one used last first' }] }]
  },
  { id: 'accounts.settings', title: 'Accounts', pluginId: 'accounts', settings: 'accounts', keywords: [], module: './AccountsPage', remoteEntry: 'tessera-plugin://accounts/remoteEntry.js' }
]

/** A plugin page the fake loader hands out: it shows its props and can change the draft or report itself invalid. */
function AccountsPage({ value, defaults, onChange, onValidityChange, disabled, errors }: SettingsPageProps<{ compact: boolean }>) {
  useEffect(() => { onValidityChange(true) }, [onValidityChange])
  return (
    <div>
      <p>Compact is {String(value.compact)}, by default {String(defaults.compact)}{disabled ? ', disabled' : ''}</p>
      <p>{errors.length} errors</p>
      <button onClick={() => onChange({ ...value, compact: !value.compact })}>Toggle compact</button>
      <button onClick={() => onValidityChange(false)}>Make invalid</button>
      <button onClick={() => onValidityChange(true)}>Make valid</button>
    </div>
  )
}
function Broken(): never { throw new Error('broken page') }

function setup({ catalogue = { pages: PAGES, namespaces: [ledger(), accounts()] } as SettingsCatalogue, loader, commit }: {
  catalogue?: SettingsCatalogue
  loader?: ViewLoader
  commit?: (request: SettingsCommitRequest) => SettingsCommitResult | Promise<SettingsCommitResult>
} = {}) {
  const remote = createFakeRemote({ [THEME_GET]: () => theme, [SETTINGS_GET]: () => catalogue })
  const answer = remote.bridge.invoke.getMockImplementation()!
  const commits: SettingsCommitRequest[] = []
  remote.bridge.invoke.mockImplementation(async (channel: string, data?: unknown) => {
    if (channel !== SETTINGS_COMMIT) return answer(channel, data)
    const request = data as SettingsCommitRequest
    commits.push(structuredClone(request))
    if (commit) return commit(request)
    const namespaces = request.changes.map(({ id, value }) => ({ ...catalogue.namespaces.find(n => n.id === id)!, value: value as never }))
    return { ok: true, namespaces } satisfies SettingsCommitResult
  })
  const load = vi.fn(async (m: { module: string }) => (m.module === './Broken' ? Broken : AccountsPage) as ComponentType<any>)

  render(
    <ShellThemeProvider bridge={remote.bridge} initial={theme}>
      <SettingsDialog bridge={remote.bridge} loader={loader ?? { load }} />
    </ShellThemeProvider>)

  const open = async (page?: string, windowId = 1) => {
    await act(async () => { remote.emit(SETTINGS_OPEN, { windowId, ...(page && { page }) }) })
  }
  return { ...remote, commits, open, load }
}

const dialog = () => screen.getByRole('dialog', { name: 'Options' })
const nav = () => within(dialog()).getByRole('navigation', { name: 'Settings pages' })
const navItem = (title: string) => within(nav()).getByRole('button', { name: new RegExp(`^${title}`) })
const page = (title: string) => within(dialog()).getByRole('region', { name: title })
const button = (name: string) => within(dialog()).getByRole('button', { name })

describe('the Options dialog: opening', () => {
  it('is not there until the main process asks for it, in this window', async () => {
    const { open } = setup()
    await settle()
    expect(screen.queryByRole('dialog')).toBeNull()

    await open(undefined, 2)
    expect(screen.queryByRole('dialog')).toBeNull()

    await open()
    expect(dialog()).toBeInTheDocument()
  })

  it("keeps its title row short: the theme's dialog title, half the vertical padding MUI gives one", async () => {
    const { open } = setup()
    await open()

    const title = within(dialog()).getByRole('heading', { name: 'Options' })
    expect([getComputedStyle(title).paddingTop, getComputedStyle(title).paddingBottom]).toEqual(['8px', '8px'])
  })

  it('lists the pages as a tree and shows the first one', async () => {
    const { open } = setup()
    await open()

    expect(within(nav()).getAllByRole('button').map(b => b.textContent)).toEqual(['Ledger', 'Start-up', 'Order', 'Accounts'])
    expect(navItem('Ledger')).toHaveAttribute('aria-current', 'page')
    expect(within(page('Ledger')).getByText('Ledger files.')).toBeInTheDocument()
  })

  it('opens at the page asked for, and moves to another asked for while open, keeping the changes', async () => {
    const { open } = setup()
    await open('ledger.settings')
    expect(navItem('Start-up')).toHaveAttribute('aria-current', 'page')
    await userEvent.click(within(page('Start-up')).getByRole('checkbox', { name: 'Reopen the last ledger' }))

    await open('accounts.settings')

    expect(navItem('Accounts')).toHaveAttribute('aria-current', 'page')
    expect(button('Apply')).toBeEnabled()
  })

  it('lists the pages under a category, and goes to one when chosen', async () => {
    const { open } = setup()
    await open()

    await userEvent.click(within(page('Ledger')).getByRole('button', { name: 'Order' }))

    expect(navItem('Order')).toHaveAttribute('aria-current', 'page')
    expect(within(page('Order')).getByRole('radio', { name: 'Name' })).toBeChecked()
  })

  it('says so when there are no pages', async () => {
    const { open } = setup({ catalogue: { pages: [], namespaces: [] } })
    await open()
    expect(within(dialog()).getByText('No plugin has settings to change.')).toBeInTheDocument()
  })

  it('stays closed, and logs, if the settings cannot be fetched', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const remote = createFakeRemote({ [THEME_GET]: () => theme })
    render(<ShellThemeProvider bridge={remote.bridge} initial={theme}><SettingsDialog bridge={remote.bridge} loader={{ load: vi.fn() }} /></ShellThemeProvider>)

    await act(async () => { remote.emit(SETTINGS_OPEN, { windowId: 1 }) })

    await waitFor(() => expect(error).toHaveBeenCalledWith('[settings] Could not open the settings', expect.any(Error)))
    expect(screen.queryByRole('dialog')).toBeNull()
    error.mockRestore()
  })
})

describe('the Options dialog: pages the shell draws', () => {
  it('edits a checkbox, a number and a choice, and applies only the namespaces that changed', async () => {
    const { open, commits } = setup()
    await open('ledger.settings')
    expect(button('Apply')).toBeDisabled()

    await userEvent.click(within(page('Start-up')).getByRole('checkbox', { name: 'Reopen the last ledger' }))
    const limit = within(page('Start-up')).getByRole('textbox', { name: 'Recent ledgers' })
    await userEvent.clear(limit)
    await userEvent.type(limit, '5')
    await userEvent.click(navItem('Order'))
    await userEvent.click(within(page('Order')).getByRole('radio', { name: 'Date opened' }))
    await userEvent.click(button('Apply'))

    expect(commits).toEqual([{ changes: [{ id: 'ledger', value: { reopenLast: false, recentLimit: 5, sort: 'date' } }] }])
    await waitFor(() => expect(button('Apply')).toBeDisabled())
    expect(dialog()).toBeInTheDocument()
  })

  it('shows the help, and the unit, with a field', async () => {
    const { open } = setup()
    await open('ledger.settings')
    expect(within(page('Start-up')).getByRole('checkbox', { name: 'Reopen the last ledger' })).toHaveAccessibleDescription('Instead of the start page')
    expect(within(page('Start-up')).getByText('ledgers')).toBeInTheDocument()
  })

  it('says what an option of a choice means, under it', async () => {
    const { open } = setup()
    await open('ledger.order')
    expect(within(page('Order')).getByRole('radio', { name: 'Date opened' })).toHaveAccessibleDescription('The one used last first')
    expect(within(page('Order')).getByRole('radio', { name: 'Name' })).not.toHaveAttribute('aria-describedby')
  })

  it('refuses a number out of range or half typed, saying why, until it is put right', async () => {
    const { open } = setup()
    await open('ledger.settings')
    const limit = within(page('Start-up')).getByRole('textbox', { name: 'Recent ledgers' })

    await userEvent.clear(limit)
    expect(within(page('Start-up')).getByText('Recent ledgers: enter a number.')).toBeInTheDocument()
    expect(button('OK')).toBeDisabled()
    expect(navItem('Start-up')).toHaveAccessibleName(/Has a problem/)

    await userEvent.type(limit, '31')
    expect(within(page('Start-up')).getByText('Recent ledgers: enter a number from 1 to 30.')).toBeInTheDocument()
    expect(button('Apply')).toBeDisabled()

    await userEvent.type(limit, '{Backspace}')
    expect(button('OK')).toBeEnabled()
    expect(within(page('Start-up')).queryByText(/enter a number/)).toBeNull()
  })

  it('restores the defaults of the page\'s own fields, leaving the rest of the namespace', async () => {
    const { open } = setup({ catalogue: { pages: PAGES, namespaces: [ledger({ reopenLast: false, recentLimit: 4, sort: 'date' }), accounts()] } })
    await open('ledger.settings')
    expect(within(page('Start-up')).getByRole('textbox', { name: 'Recent ledgers' })).toHaveValue('4')

    await userEvent.click(button('Restore Defaults'))

    expect(within(page('Start-up')).getByRole('checkbox', { name: 'Reopen the last ledger' })).toBeChecked()
    expect(within(page('Start-up')).getByRole('textbox', { name: 'Recent ledgers' })).toHaveValue('10')
    expect(button('Restore Defaults')).toBeDisabled()
    await userEvent.click(navItem('Order'))
    expect(within(page('Order')).getByRole('radio', { name: 'Date opened' })).toBeChecked()
  })

  it('shows settings it may not change, saved by a newer version, without letting them change', async () => {
    const readOnly = 'These settings were saved by a newer version of "ledger", so they can\'t be changed here.'
    const { open } = setup({ catalogue: { pages: PAGES, namespaces: [ledger({ reopenLast: false }, { readOnly }), accounts()] } })
    await open('ledger.settings')

    expect(within(page('Start-up')).getByText(readOnly)).toBeInTheDocument()
    expect(within(page('Start-up')).getByRole('checkbox', { name: 'Reopen the last ledger' })).toBeDisabled()
    expect(button('Restore Defaults')).toBeDisabled()
  })
})

describe('the Options dialog: applying and closing', () => {
  it('applies and closes on OK, and just closes when nothing changed', async () => {
    const first = setup()
    await first.open('ledger.settings')
    await userEvent.click(button('OK'))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(first.commits).toEqual([])

    await first.open('ledger.settings')
    await userEvent.click(within(page('Start-up')).getByRole('checkbox', { name: 'Reopen the last ledger' }))
    await userEvent.click(button('OK'))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(first.commits).toHaveLength(1)
  })

  it('closes at once on Cancel when nothing changed', async () => {
    const { open } = setup()
    await open()
    await userEvent.click(button('Cancel'))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('asks before discarding changes, from Cancel or Escape, and keeps them when the user goes back', async () => {
    const { open, commits } = setup()
    await open('ledger.settings')
    await userEvent.click(within(page('Start-up')).getByRole('checkbox', { name: 'Reopen the last ledger' }))

    await userEvent.click(button('Cancel'))
    const ask = await screen.findByRole('dialog', { name: 'Discard your changes?' })
    await userEvent.click(within(ask).getByRole('button', { name: 'Keep Editing' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Discard your changes?' })).toBeNull())
    expect(within(page('Start-up')).getByRole('checkbox', { name: 'Reopen the last ledger' })).not.toBeChecked()

    await userEvent.keyboard('{Escape}')
    await userEvent.click(within(await screen.findByRole('dialog', { name: 'Discard your changes?' })).getByRole('button', { name: 'Discard' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(commits).toEqual([])
  })

  it('shows what the main process refused on the page, stays open, and clears it once the user edits', async () => {
    const { open } = setup({ commit: () => ({ ok: false, errors: { ledger: ['Keep at least one recent ledger.', 'Another problem.'] } }) })
    await open('accounts.settings')
    await userEvent.click(within(page('Accounts')).getByRole('button', { name: 'Toggle compact' }))
    await userEvent.click(navItem('Start-up'))
    await userEvent.click(within(page('Start-up')).getByRole('checkbox', { name: 'Reopen the last ledger' }))
    await userEvent.click(navItem('Accounts'))

    await userEvent.click(button('OK'))

    // Moved to the first page of the namespace that was refused
    await waitFor(() => expect(navItem('Start-up')).toHaveAttribute('aria-current', 'page'))
    expect(within(page('Start-up')).getByText('Keep at least one recent ledger.')).toBeInTheDocument()
    expect(navItem('Order')).toHaveAccessibleName(/Has a problem/)
    expect(dialog()).toBeInTheDocument()

    await userEvent.click(within(page('Start-up')).getByRole('checkbox', { name: 'Reopen the last ledger' }))
    expect(within(page('Start-up')).queryByText('Keep at least one recent ledger.')).toBeNull()
  })

  it('warns, and stays open, when the changes are in effect but could not be saved', async () => {
    const { open } = setup({ commit: request => ({ ok: true, namespaces: [ledger(request.changes[0].value as object)], saveError: 'disk full' }) })
    await open('ledger.settings')
    await userEvent.click(within(page('Start-up')).getByRole('checkbox', { name: 'Reopen the last ledger' }))
    await userEvent.click(button('OK'))

    expect(await within(dialog()).findByText('Your changes are in effect, but could not be saved for next time: disk full')).toBeInTheDocument()
    expect(button('Apply')).toBeDisabled()
  })

  it('says so when applying fails, keeping the changes', async () => {
    const { open } = setup({ commit: () => { throw new Error('HANDLER_ERROR: gone') } })
    await open('ledger.settings')
    await userEvent.click(within(page('Start-up')).getByRole('checkbox', { name: 'Reopen the last ledger' }))
    await userEvent.click(button('Apply'))

    expect(await within(dialog()).findByText('Your changes could not be applied: gone')).toBeInTheDocument()
    expect(button('Apply')).toBeEnabled()
  })

  it('disables the buttons and the pages while applying', async () => {
    let finish!: (result: SettingsCommitResult) => void
    const { open } = setup({ commit: () => new Promise(resolve => { finish = resolve }) })
    await open('ledger.settings')
    await userEvent.click(within(page('Start-up')).getByRole('checkbox', { name: 'Reopen the last ledger' }))
    await userEvent.click(button('Apply'))

    expect(button('OK')).toBeDisabled()
    expect(button('Cancel')).toBeDisabled()
    expect(within(page('Start-up')).getByRole('checkbox', { name: 'Reopen the last ledger' })).toBeDisabled()
    await act(async () => { finish({ ok: true, namespaces: [ledger({ reopenLast: false })] }) })
    expect(button('OK')).toBeEnabled()
  })

  it('follows changes applied elsewhere, keeping the user\'s own unapplied ones', async () => {
    const { open, emit } = setup()
    await open('ledger.settings')
    await userEvent.click(navItem('Accounts'))
    await within(page('Accounts')).findByText('Compact is false, by default false')
    await userEvent.click(navItem('Start-up'))
    await userEvent.click(within(page('Start-up')).getByRole('checkbox', { name: 'Reopen the last ledger' }))

    await act(async () => {
      emit(SETTINGS_CHANGED, ledger({ recentLimit: 3 }))
      emit(SETTINGS_CHANGED, accounts({ compact: true }))
    })

    expect(within(page('Start-up')).getByRole('textbox', { name: 'Recent ledgers' })).toHaveValue('10')
    expect(within(page('Start-up')).getByRole('checkbox', { name: 'Reopen the last ledger' })).not.toBeChecked()
    await userEvent.click(navItem('Accounts'))
    expect(within(page('Accounts')).getByText('Compact is true, by default false')).toBeInTheDocument()
  })
})

describe('the Options dialog: plugin pages', () => {
  it('loads a plugin\'s page from its remote and gives it the draft, the defaults and what to call', async () => {
    const { open, load, commits } = setup()
    await open('accounts.settings')

    expect(await within(page('Accounts')).findByText('Compact is false, by default false')).toBeInTheDocument()
    expect(load).toHaveBeenCalledWith({ id: 'accounts.settings', pluginId: 'accounts', module: './AccountsPage', remoteEntry: 'tessera-plugin://accounts/remoteEntry.js' })

    await userEvent.click(within(page('Accounts')).getByRole('button', { name: 'Toggle compact' }))
    expect(within(page('Accounts')).getByText('Compact is true, by default false')).toBeInTheDocument()
    await userEvent.click(button('Apply'))
    expect(commits).toEqual([{ changes: [{ id: 'accounts', value: { compact: true } }] }])
  })

  it('disables OK and Apply while a page says it is invalid, even when another page is shown', async () => {
    const { open } = setup()
    await open('accounts.settings')
    await userEvent.click(await within(page('Accounts')).findByRole('button', { name: 'Make invalid' }))
    await userEvent.click(navItem('Start-up'))

    expect(button('OK')).toBeDisabled()
    expect(navItem('Accounts')).toHaveAccessibleName(/Has a problem/)

    // Even while a search hides it, the dialog says where the problem is, and goes there
    await userEvent.type(within(nav()).getByRole('textbox', { name: 'Search settings' }), 'launch')
    expect(within(nav()).queryByRole('button', { name: /^Accounts/ })).toBeNull()
    await userEvent.click(button('Correct “Accounts” to apply'))
    expect(navItem('Accounts')).toHaveAttribute('aria-current', 'page')
    expect(within(dialog()).queryByRole('button', { name: 'Correct “Accounts” to apply' })).toBeNull()

    await userEvent.click(within(page('Accounts')).getByRole('button', { name: 'Make valid' }))
    expect(button('OK')).toBeEnabled()
  })

  it('restores every default of a page of its own', async () => {
    const { open } = setup({ catalogue: { pages: PAGES, namespaces: [ledger(), accounts({ compact: true })] } })
    await open('accounts.settings')
    await within(page('Accounts')).findByText('Compact is true, by default false')

    await userEvent.click(button('Restore Defaults'))

    expect(within(page('Accounts')).getByText('Compact is false, by default false')).toBeInTheDocument()
  })

  it('shows a page that fails without losing the others', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const broken: SettingsPageInfo = { ...PAGES[3], module: './Broken' }
    const { open } = setup({ catalogue: { pages: [PAGES[0], PAGES[1], broken], namespaces: [ledger(), accounts()] } })
    await open('accounts.settings')

    expect(await within(page('Accounts')).findByText('This page could not be displayed.')).toBeInTheDocument()
    await userEvent.click(navItem('Start-up'))
    expect(within(page('Start-up')).getByRole('checkbox', { name: 'Reopen the last ledger' })).toBeInTheDocument()
    expect(error).toHaveBeenCalledWith('[settings] Settings page "accounts.settings" failed', expect.any(Error), expect.anything())
    error.mockRestore()
  })

  it('ignores a change that is not a JSON object, and says so', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    function Bad({ onChange }: SettingsPageProps) {
      return <button onClick={() => onChange({ when: new Date() } as never)}>Break</button>
    }
    const { open } = setup({ loader: { load: vi.fn(async () => Bad as ComponentType<any>) } })
    await open('accounts.settings')
    await userEvent.click(await within(page('Accounts')).findByRole('button', { name: 'Break' }))

    expect(error).toHaveBeenCalledWith('[settings] Ignored a change to settings "accounts": the value.when is not a plain object')
    expect(button('Apply')).toBeDisabled()
    error.mockRestore()
  })
})

describe('the Options dialog: search', () => {
  it('lists the pages it finds, under the pages above them, and goes to the first with Enter', async () => {
    const { open } = setup()
    await open()

    await userEvent.type(within(nav()).getByRole('textbox', { name: 'Search settings' }), 'recent ledgers')
    expect(within(nav()).getAllByRole('button').map(b => b.textContent)).toEqual(['Ledger', 'Start-up', 'Order'])

    await userEvent.clear(within(nav()).getByRole('textbox', { name: 'Search settings' }))
    await userEvent.type(within(nav()).getByRole('textbox', { name: 'Search settings' }), 'launch{Enter}')
    expect(within(nav()).getAllByRole('button').map(b => b.textContent)).toEqual(['Ledger', 'Start-up'])
    expect(navItem('Start-up')).toHaveAttribute('aria-current', 'page')
  })

  it('says so when nothing matches', async () => {
    const { open } = setup()
    await open()
    await userEvent.type(within(nav()).getByRole('textbox', { name: 'Search settings' }), 'zebra')
    expect(within(nav()).getByText('No settings match “zebra”.')).toBeInTheDocument()
  })
})

describe('the Options dialog: a page from a real plugin remote', () => {
  // Built once by tests/setup/buildUiFixture.ts
  const remoteEntry = inject('themedRemoteEntry')
  beforeEach(() => { URL.createObjectURL = vi.fn(() => 'blob:x'); URL.revokeObjectURL = vi.fn() })
  afterEach(() => { vi.unstubAllGlobals() })

  it("loads through module federation, shares the shell's @tessera/ui, and edits the draft", async () => {
    const themed: SettingsNamespaceSnapshot = { id: 'themed', owner: 'themed', value: { compact: false }, defaults: { compact: false } }
    const { open, commits } = setup({
      loader: createFederationViewLoader(),
      catalogue: {
        pages: [{ id: 'themed.settings', title: 'Themed', pluginId: 'themed', settings: 'themed', keywords: [], module: './ThemedSettingsPage', remoteEntry }],
        namespaces: [themed]
      },
      commit: request => ({ ok: true, namespaces: [{ ...themed, value: request.changes[0].value as never }] })
    })
    await open()

    await userEvent.click(await within(page('Themed')).findByRole('checkbox', { name: 'Compact rows' }, { timeout: 5_000 }))
    await userEvent.click(button('OK'))

    expect(commits).toEqual([{ changes: [{ id: 'themed', value: { compact: true } }] }])
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })
})
