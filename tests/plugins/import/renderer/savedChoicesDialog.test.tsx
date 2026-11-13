// Saved Import Choices: the three tabs (account matches, payee names, what each source's files taught), each listing
// what the import plugin gives, and changing or forgetting at once through its channels, then showing what is left.
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { IMPORT_CHANNELS, type AccountLinkView, type PayeeAliasView, type RememberedChoice, type SavedLinks } from '@tessera/import-api'
import SavedChoicesDialog from '../../../../plugins/import/src/renderer/SavedChoicesDialog'
import { createFakeRemote } from '../../../helpers/fakeBridge'

const link = (over: Partial<AccountLinkView>): AccountLinkView => ({
  id: 'l1', rev: 1, key: 'ofx:card:3456', strength: 'strong', accountId: 'visa', autoApply: true, label: 'Northwind Card Services •••• 3456',
  formatId: 'format-ofx.ofx', createdAt: '2026-10-01T00:00:00Z', lastUsedAt: '2026-11-05T12:00:00Z', accountName: 'Visa',
  formatLabel: 'OFX / QFX / QBO statement', ...over
})

/** The plugin's side, in memory: what it answers, and what each change does to it. */
function setup(options: { empty?: boolean, failForget?: boolean } = {}) {
  const state = {
    links: options.empty ? [] : [link({}), link({ id: 'l2', key: 'csv:layout:1', strength: 'weak', autoApply: false, label: 'CSV file with columns Date, Amount', accountId: 'chq', accountName: 'Chequing', formatLabel: 'CSV file' })],
    accounts: [{ id: 'visa', name: 'Visa', currency: 'CAD' }, { id: 'chq', name: 'Chequing', currency: 'CAD' }, { id: 'sav', name: 'Savings', currency: 'CAD' }],
    aliases: options.empty ? [] : [{ id: 'a1', bankText: 'costco whse', payeeName: 'Costco', uses: 3, createdAt: '2026-10-01' }] as PayeeAliasView[],
    remembered: options.empty ? [] : [
      { id: 'm1', what: 'CSV columns', source: 'Date, Description, Amount', detail: 'Dates month first', owner: 'CSV file' },
      { id: 'm2', what: 'Categories from the file', source: 'Maple Trust Chequing', detail: 'The file\'s categories are used', owner: 'Import', categories: 'file' }
    ] as RememberedChoice[]
  }
  const calls: [string, unknown][] = []
  const remote = createFakeRemote({})
  remote.bridge.invoke.mockImplementation(async (channel: string, data: any) => {
    calls.push([channel, data])
    const ok = (value?: unknown) => ({ ok: true, value })
    switch (channel) {
      case IMPORT_CHANNELS.links: return ok({ links: state.links, accounts: state.accounts } satisfies SavedLinks)
      case IMPORT_CHANNELS.aliases: return ok(state.aliases)
      case IMPORT_CHANNELS.remembered: return ok(state.remembered)
      case IMPORT_CHANNELS.updateLink:
        state.links = state.links.map(l => l.id === data.id ? { ...l, ...data, accountName: state.accounts.find(a => a.id === (data.accountId ?? l.accountId))!.name } : l)
        return ok()
      case IMPORT_CHANNELS.forgetLink: state.links = state.links.filter(l => l.id !== data.id); return ok()
      case IMPORT_CHANNELS.forgetAlias: state.aliases = state.aliases.filter(a => a.id !== data.id); return ok()
      case IMPORT_CHANNELS.forgetRemembered:
        if (options.failForget) return { ok: false, error: { code: 'NOT_FOUND', message: 'That choice is no longer saved.' } }
        state.remembered = state.remembered.filter(r => r.id !== data.id); return ok()
      case IMPORT_CHANNELS.updateRemembered: state.remembered = state.remembered.map(r => r.id === data.id ? { ...r, categories: data.categories } : r); return ok()
    }
    throw new Error(`No answer for ${channel}`)
  })
  ;(window as any).api = remote.bridge
  const close = vi.fn()
  render(<SavedChoicesDialog input={{}} close={close} setBusy={vi.fn()} />)
  return { close, calls, state }
}

/** Opens a select's menu and chooses an option. */
async function choose(select: HTMLElement, option: string) {
  fireEvent.mouseDown(select)
  fireEvent.click(within(await screen.findByRole('listbox')).getByText(option))
  await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument())
}
const tab = (name: RegExp) => userEvent.click(screen.getByRole('tab', { name }))

describe('the Saved Import Choices dialog', () => {
  it('shows the saved account matches first, each with its account, whether to ask, and when it was last used', async () => {
    setup()
    const table = await screen.findByRole('table', { name: 'Saved account matches' })
    expect(screen.getByRole('tab', { name: 'Accounts (2)' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: 'Payees (1)' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Files and choices (2)' })).toBeInTheDocument()
    expect(within(table).getByText('Northwind Card Services •••• 3456')).toBeInTheDocument()
    expect(within(table).getByText('OFX / QFX / QBO statement')).toBeInTheDocument()
    expect(screen.getByLabelText('Account for Northwind Card Services •••• 3456')).toHaveTextContent('Visa')
    expect(screen.getByRole('checkbox', { name: 'Ask every time for Northwind Card Services •••• 3456' })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Ask every time for CSV file with columns Date, Amount' })).toBeChecked()
    expect(within(table).getAllByText('Nov 5, 2026')).toHaveLength(2)
  })

  it('points a match at another account, switches asking, and forgets one, showing what is left', async () => {
    const { calls } = setup()
    await screen.findByRole('table', { name: 'Saved account matches' })
    await choose(screen.getByLabelText('Account for Northwind Card Services •••• 3456'), 'Savings')
    expect(calls).toContainEqual([IMPORT_CHANNELS.updateLink, { id: 'l1', accountId: 'sav' }])
    await waitFor(() => expect(screen.getByLabelText('Account for Northwind Card Services •••• 3456')).toHaveTextContent('Savings'))
    await userEvent.click(screen.getByRole('checkbox', { name: 'Ask every time for Northwind Card Services •••• 3456' }))
    expect(calls).toContainEqual([IMPORT_CHANNELS.updateLink, { id: 'l1', autoApply: false }])
    await userEvent.click(screen.getByRole('button', { name: 'Forget CSV file with columns Date, Amount' }))
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Accounts (1)' })).toBeInTheDocument())
    expect(screen.queryByText('CSV file with columns Date, Amount')).not.toBeInTheDocument()
  })

  it('lists the payee names learnt, and forgets one', async () => {
    setup()
    await tab(/^Payees/)
    const table = await screen.findByRole('table', { name: 'Payee names' })
    expect(within(table).getAllByRole('row')[1]).toHaveTextContent('costco whseCostco3 times')
    await userEvent.click(screen.getByRole('button', { name: 'Forget costco whse' }))
    expect(await screen.findByText(/No payee names learnt yet/)).toBeInTheDocument()
  })

  it('lists what each source’s files taught, changes a category choice in place, and forgets one', async () => {
    const { calls } = setup()
    await tab(/^Files and choices/)
    const table = await screen.findByRole('table', { name: 'What imports remember about each source' })
    expect(within(table).getAllByRole('row')[1]).toHaveTextContent('CSV columnsCSV fileDate, Description, AmountDates month first')
    await choose(screen.getByLabelText('Categories for Maple Trust Chequing'), 'My usual category for each payee')
    expect(calls).toContainEqual([IMPORT_CHANNELS.updateRemembered, { id: 'm2', categories: 'payee' }])
    await userEvent.click(screen.getByRole('button', { name: 'Forget CSV columns for Date, Description, Amount' }))
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Files and choices (1)' })).toBeInTheDocument())
  })

  it('says when nothing is remembered yet', async () => {
    setup({ empty: true })
    expect(await screen.findByText(/No saved account matches yet/)).toBeInTheDocument()
    await tab(/^Files and choices/)
    expect(await screen.findByText('Nothing remembered about any file yet.')).toBeInTheDocument()
  })

  it('says why something couldn’t be forgotten', async () => {
    setup({ failForget: true })
    await tab(/^Files and choices/)
    await userEvent.click(await screen.findByRole('button', { name: 'Forget CSV columns for Date, Description, Amount' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('That choice is no longer saved.')
  })

  it('closes', async () => {
    const { close } = setup()
    await screen.findByRole('table', { name: 'Saved account matches' })
    await userEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(close).toHaveBeenCalledWith()
  })
})
