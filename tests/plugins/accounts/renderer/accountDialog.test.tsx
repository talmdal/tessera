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

const theme: ThemeSnapshot = {
  state: { windowId: 1, global: { theme: DEFAULT_THEME.id, mode: 'light' }, theme: DEFAULT_THEME.id, mode: 'light' },
  themes: [DEFAULT_THEME]
}
const base = { subBooks: [], bookName: 'Home', defaultCurrency: 'CAD' }

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
    showDialog({ ...base, mode: 'create', subBookId: null })
    const formControl = (input: HTMLElement) => input.closest('.MuiFormControl-root') as HTMLElement
    // The theme's default reaches the other fields (the row removes it from them with its own spacing)…
    expect(formControl(screen.getByRole('textbox', { name: 'Opening balance' }))).toHaveClass('MuiFormControl-marginDense')
    // …but the currency field, nested in its Autocomplete where the row can't reach, has none
    expect(formControl(screen.getByRole('combobox', { name: 'Currency' }))).not.toHaveClass('MuiFormControl-marginDense')
  })
})

describe('the account dialog: minimum balance', () => {
  it('offers a minimum balance and the choice to show the balance above it, for asset accounts only', async () => {
    showDialog({ ...base, mode: 'create', subBookId: null })
    expect(screen.getByRole('textbox', { name: 'Minimum balance' })).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'Show the balance above the minimum' })).not.toBeChecked()
    await userEvent.click(screen.getByRole('combobox', { name: 'Type' }))
    await userEvent.click(screen.getByRole('option', { name: 'Credit card' }))
    expect(screen.queryByRole('textbox', { name: 'Minimum balance' })).toBeNull()
  })

  it('saves both, in minor units', async () => {
    const { calls } = showDialog({ ...base, mode: 'create', subBookId: null })
    await userEvent.type(screen.getByRole('textbox', { name: 'Name' }), 'Savings')
    await userEvent.type(screen.getByRole('textbox', { name: 'Minimum balance' }), '1,000')
    await userEvent.click(screen.getByRole('checkbox', { name: 'Show the balance above the minimum' }))
    await userEvent.click(screen.getByRole('button', { name: 'Create' }))
    expect(calls(ACCOUNTS_CHANNELS.saveAccount)[0].input).toMatchObject({ minimumBalance: 100000, showAvailableBalance: true })
  })

  it('asks for the minimum before the balance above it can be shown', () => {
    const form = { name: 'S', type: 'savings' as const, subBook: '(book)', currency: 'CAD', openingDate: '2026-01-01', openingBalance: '0', creditLimit: '', minimumBalance: '', showAvailableBalance: true, institution: '', accountNumber: '', notes: '' }
    expect(toInput(form).problems.minimumBalance).toBe('Enter the minimum balance, to show the balance above it.')
    expect(toInput({ ...form, type: 'creditCard', minimumBalance: '100' }).input).not.toHaveProperty('minimumBalance')
  })

  it('shows an account\'s minimum when editing it', () => {
    const account: Account = { id: 'a', rev: 1, name: 'S', type: 'savings', subBookId: null, currency: 'CAD', openingDate: '2026-01-01', openingBalance: 0, order: 0, closed: false, minimumBalance: 50000, showAvailableBalance: true }
    showDialog({ ...base, mode: 'edit', account })
    expect(screen.getByRole('textbox', { name: 'Minimum balance' })).toHaveValue('500.00')
    expect(screen.getByRole('checkbox', { name: 'Show the balance above the minimum' })).toBeChecked()
  })
})

describe('the navigator, with registers and minimum balances', () => {
  const account = (over: Partial<Account>): Account => ({ id: 'a', rev: 1, name: 'A', type: 'savings', subBookId: null, currency: 'CAD', openingDate: '2026-01-01', openingBalance: 0, order: 0, closed: false, ...over })
  const chart: Chart = {
    book: { name: 'Home' }, subBooks: [], totals: { CAD: 300000 },
    accounts: [
      { account: account({ id: 's', name: 'Savings', minimumBalance: 100000, showAvailableBalance: true }), balances: { current: 300000, available: 200000, cleared: 0, reconciled: 0, transactionCount: 0 } },
      { account: account({ id: 'c', name: 'Chequing', order: 1 }), balances: { current: 0, available: 0, cleared: 0, reconciled: 0, transactionCount: 0 } }
    ]
  }
  const setup = () => {
    const remote = bridge({ [ACCOUNTS_CHANNELS.chart]: () => chart, [ACCOUNTS_CHANNELS.selection]: () => ({ kind: 'book' }), [ACCOUNTS_CHANNELS.select]: () => undefined })
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
