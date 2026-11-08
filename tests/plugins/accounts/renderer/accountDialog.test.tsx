import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ThemeSnapshot } from '@tessera/types'
import { ACCOUNTS_CHANNELS, type Account, type AccountDialogInput, type Chart } from '@tessera/accounts-api'
import { DEFAULT_THEME, THEME_GET } from '../../../../shared/theme/types'
import { ShellThemeProvider } from '../../../../shell/renderer/theme/ShellThemeProvider'
import AccountDialog, { toInput } from '../../../../plugins/accounts/src/renderer/AccountDialog'
import Navigator from '../../../../plugins/accounts/src/renderer/Navigator'
import { createFakeRemote } from '../../../helpers/fakeBridge'
import { DEFAULT_FONT_SETTINGS } from '../../../../shared/fonts/resolveFonts'

const theme: ThemeSnapshot = {
  state: { windowId: 1, global: { theme: DEFAULT_THEME.id, mode: 'light' }, theme: DEFAULT_THEME.id, mode: 'light' },
  themes: [DEFAULT_THEME],
  fonts: DEFAULT_FONT_SETTINGS
}
const base = { subLedgers: [], ledgerName: 'Home', defaultCurrency: 'CAD' }

function bridge(answers: Record<string, (data: any) => unknown> = {}) {
  const remote = createFakeRemote({})
  remote.bridge.invoke.mockImplementation(async (channel: string, data?: any) => {
    if (channel === 'shell:commands.execute') return undefined
    const answer = answers[channel] ?? (channel === THEME_GET ? () => theme : undefined)
    if (!answer) throw new Error(`No answer for ${channel}`)
    return answer(data)
  })
  ;(window as any).api = remote.bridge
  return remote
}

/** The dialog as the app shows it: under the shell's theme, whose defaults (dense margins) apply. */
function showDialog(input: AccountDialogInput, save: (data: any) => unknown = data => ({ ok: true, value: { id: 'new', ...data.input } })) {
  const remote = bridge({ [ACCOUNTS_CHANNELS.saveAccount]: save })
  const close = vi.fn()
  render(<ShellThemeProvider bridge={remote.bridge} initial={theme}><AccountDialog input={input} close={close} setBusy={vi.fn()} /></ShellThemeProvider>)
  const calls = (channel: string) => remote.bridge.invoke.mock.calls.filter((c: unknown[]) => c[0] === channel).map((c: unknown[]) => c[1]) as any[]
  return { close, calls }
}

afterEach(() => { delete (window as any).api })

describe('the account dialog: layout', () => {
  it('keeps the currency field level with its row: it must not take the theme\'s dense top margin', () => {
    showDialog({ ...base, mode: 'create', subLedgerId: null })
    const formControl = (input: HTMLElement) => input.closest('.MuiFormControl-root') as HTMLElement
    // The theme's default reaches the other fields (the row removes it from them with its own spacing)…
    expect(formControl(screen.getByRole('textbox', { name: 'Opening balance' }))).toHaveClass('MuiFormControl-marginDense')
    // …but the currency field, nested in its Autocomplete where the row can't reach, has none
    expect(formControl(screen.getByRole('combobox', { name: 'Currency' }))).not.toHaveClass('MuiFormControl-marginDense')
  })
})

describe('the account dialog: minimum balance', () => {
  it('offers a minimum balance and the choice to show the balance above it, for asset accounts only', async () => {
    showDialog({ ...base, mode: 'create', subLedgerId: null })
    expect(screen.getByRole('textbox', { name: 'Minimum balance' })).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'Show the balance above the minimum' })).not.toBeChecked()
    await userEvent.click(screen.getByRole('combobox', { name: 'Type' }))
    await userEvent.click(screen.getByRole('option', { name: 'Credit card' }))
    expect(screen.queryByRole('textbox', { name: 'Minimum balance' })).toBeNull()
  })

  it('saves both, in minor units', async () => {
    const { calls } = showDialog({ ...base, mode: 'create', subLedgerId: null })
    await userEvent.type(screen.getByRole('textbox', { name: 'Name' }), 'Savings')
    await userEvent.type(screen.getByRole('textbox', { name: 'Minimum balance' }), '1,000')
    await userEvent.click(screen.getByRole('checkbox', { name: 'Show the balance above the minimum' }))
    await userEvent.click(screen.getByRole('button', { name: 'Create' }))
    expect(calls(ACCOUNTS_CHANNELS.saveAccount)[0].input).toMatchObject({ minimumBalance: 100000, showAvailableBalance: true })
  })

  it('asks for the minimum before the balance above it can be shown', () => {
    const form = { name: 'S', type: 'savings' as const, subLedger: '(ledger)', currency: 'CAD', openingDate: '2026-01-01', openingBalance: '0', creditLimit: '', minimumBalance: '', showAvailableBalance: true, institution: '', accountNumber: '', notes: '' }
    expect(toInput(form).problems.minimumBalance).toBe('Enter the minimum balance, to show the balance above it.')
    expect(toInput({ ...form, type: 'creditCard', minimumBalance: '100' }).input).not.toHaveProperty('minimumBalance')
  })

  it('shows an account\'s minimum when editing it', () => {
    const account: Account = { id: 'a', rev: 1, name: 'S', type: 'savings', subLedgerId: null, currency: 'CAD', openingDate: '2026-01-01', openingBalance: 0, order: 0, closed: false, minimumBalance: 50000, showAvailableBalance: true }
    showDialog({ ...base, mode: 'edit', account })
    expect(screen.getByRole('textbox', { name: 'Minimum balance' })).toHaveValue('500.00')
    expect(screen.getByRole('checkbox', { name: 'Show the balance above the minimum' })).toBeChecked()
  })
})

describe('the account dialog: starting from what an importer knows', () => {
  const subLedgers = [{ id: 'p', parentId: null, name: 'Personal', order: 0, totals: {} }]
  const textbox = (name: string) => screen.getByRole('textbox', { name })

  it('starts with every field it is given, as they would be typed', () => {
    showDialog({
      ...base, subLedgers, mode: 'create', subLedgerId: null,
      initial: {
        name: 'TD Chequing 5678', type: 'savings', subLedgerId: 'p', currency: 'USD', institution: 'TD Canada Trust',
        accountNumber: '5678', openingDate: '2026-09-30', openingBalance: 123456, minimumBalance: 50000,
        showAvailableBalance: true, notes: 'From October.ofx'
      }
    })
    expect(textbox('Name')).toHaveValue('TD Chequing 5678')
    expect(screen.getByRole('combobox', { name: 'Type' })).toHaveTextContent('Savings')
    expect(screen.getByRole('combobox', { name: 'In' })).toHaveTextContent('Personal')     // the one it was given
    expect(screen.getByRole('combobox', { name: 'Currency' })).toHaveValue('USD')
    expect(textbox('Institution')).toHaveValue('TD Canada Trust')
    expect(textbox('Account number')).toHaveValue('5678')
    expect(screen.getByLabelText('Opened')).toHaveValue('2026-09-30')
    expect(textbox('Opening balance')).toHaveValue('1234.56')
    expect(textbox('Minimum balance')).toHaveValue('500.00')
    expect(screen.getByRole('checkbox', { name: 'Show the balance above the minimum' })).toBeChecked()
    expect(textbox('Notes')).toHaveValue('From October.ofx')
  })

  it("shows a card's opening balance as the amount owed, and saves it back as owed", async () => {
    const { calls, close } = showDialog({
      ...base, mode: 'create', subLedgerId: null,
      initial: { name: 'Visa', type: 'creditCard', currency: 'CAD', openingDate: '2026-09-30', openingBalance: -54000, creditLimit: 500000 }
    })
    expect(textbox('Amount owed')).toHaveValue('540.00')
    expect(textbox('Credit limit')).toHaveValue('5000.00')

    await userEvent.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(close).toHaveBeenCalledWith({ id: 'new' }))
    expect(calls(ACCOUNTS_CHANNELS.saveAccount)).toEqual([{ input: expect.objectContaining({ name: 'Visa', type: 'creditCard', openingBalance: -54000, creditLimit: 500000 }) }])
  })

  it('keeps the blanks for what it is not given, and the sub-ledger it was opened in', () => {
    showDialog({ ...base, subLedgers, mode: 'create', subLedgerId: 'p', initial: { accountNumber: '9012' } })
    expect(textbox('Name')).toHaveValue('')
    expect(screen.getByRole('combobox', { name: 'Type' })).toHaveTextContent('Chequing')
    expect(screen.getByRole('combobox', { name: 'In' })).toHaveTextContent('Personal')
    expect(screen.getByRole('combobox', { name: 'Currency' })).toHaveValue('CAD')
    expect(textbox('Opening balance')).toHaveValue('0.00')
    expect(textbox('Account number')).toHaveValue('9012')
  })

  it('checks what it was given as if typed: a bad value is shown, and nothing is sent', async () => {
    const { calls, close } = showDialog({
      ...base, mode: 'create', subLedgerId: null,
      initial: { name: '   ', type: 'chequing', currency: 'XX', openingDate: '2026-09-30', openingBalance: 1000 }
    })
    expect(textbox('Opening balance')).toHaveValue('1000')        // a currency it can't use: shown as given, not a crash
    await userEvent.click(screen.getByRole('button', { name: 'Create' }))
    expect(await screen.findByText('Enter a name.')).toBeInTheDocument()
    expect(screen.getByText('Choose a currency, like CAD.')).toBeInTheDocument()
    expect(calls(ACCOUNTS_CHANNELS.saveAccount)).toEqual([])
    expect(close).not.toHaveBeenCalled()
  })
})

describe('the navigator, with registers and minimum balances', () => {
  const account = (over: Partial<Account>): Account => ({ id: 'a', rev: 1, name: 'A', type: 'savings', subLedgerId: null, currency: 'CAD', openingDate: '2026-01-01', openingBalance: 0, order: 0, closed: false, ...over })
  const chart: Chart = {
    ledger: { name: 'Home' }, subLedgers: [], totals: { CAD: 300000 },
    accounts: [
      { account: account({ id: 's', name: 'Savings', minimumBalance: 100000, showAvailableBalance: true }), balances: { current: 300000, available: 200000, cleared: 0, reconciled: 0, transactionCount: 0 } },
      { account: account({ id: 'c', name: 'Chequing', order: 1 }), balances: { current: 0, available: 0, cleared: 0, reconciled: 0, transactionCount: 0 } }
    ]
  }
  const setup = () => {
    const remote = bridge({ [ACCOUNTS_CHANNELS.chart]: () => chart, [ACCOUNTS_CHANNELS.selection]: () => ({ kind: 'ledger' }), [ACCOUNTS_CHANNELS.select]: () => undefined })
    render(<Navigator />)
    return { ...remote, executed: () => remote.bridge.invoke.mock.calls.filter((c: unknown[]) => c[0] === 'shell:commands.execute').map((c: any[]) => c[1]) }
  }

  it('shows the balance above the minimum, marked, for an account that asks for it', async () => {
    setup()
    const savings = await screen.findByRole('treeitem', { name: 'Savings' })
    expect(savings).toHaveTextContent(/avail\..*2,000\.00/)
    expect(savings.getAttribute('title')).toMatch(/balance .*3,000\.00, minimum .*1,000\.00, showing what is above it/)
    expect(screen.getByRole('treeitem', { name: 'Chequing' })).not.toHaveTextContent('avail.')
  })

  it('opens an account\'s register with one click or Enter, and edits it with F2', async () => {
    const { executed } = setup()
    const savings = await screen.findByRole('treeitem', { name: 'Savings' })
    await userEvent.click(savings)
    await waitFor(() => expect(executed()).toEqual([{ id: 'accounts.register.show', args: [{ id: 's' }] }]))
    savings.focus()
    await userEvent.keyboard('{Enter}{F2}')
    await userEvent.click(screen.getByRole('treeitem', { name: 'Chequing' }))
    await waitFor(() => expect(executed()).toEqual([
      { id: 'accounts.register.show', args: [{ id: 's' }] },
      { id: 'accounts.register.show', args: [{ id: 's' }] }, { id: 'accounts.account.edit', args: [{ id: 's' }] },
      { id: 'accounts.register.show', args: [{ id: 'c' }] }
    ]))
  })
})
