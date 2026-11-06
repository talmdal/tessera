import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ACCOUNTS_CHANNELS, ACCOUNTS_EVENTS, type Account, type Category, type Chart, type RegisterSnapshot, type Transaction
} from '@tessera/accounts-api'
import Register from '../../../../plugins/accounts/src/renderer/register/Register'
import { createFakeRemote } from '../../../helpers/fakeBridge'

const account = (over: Partial<Account> = {}): Account => ({
  id: 'c', rev: 1, name: 'Chequing', type: 'chequing', subLedgerId: null, currency: 'CAD', openingDate: '2026-01-01',
  openingBalance: 100000, order: 0, closed: false, ...over
})
const tx = (over: Partial<Transaction>): Transaction => ({
  id: 't', rev: 1, accountId: 'c', date: '2026-10-02', amount: -5000, status: 'uncleared', voided: false, createdAt: '', updatedAt: '', ...over
})
const categories: Category[] = [
  { id: 'food', parentId: null, name: 'Food', kind: 'expense', rev: 1 },
  { id: 'groc', parentId: 'food', name: 'Groceries', kind: 'expense', rev: 1 }
]
const snapshot = (over: Partial<RegisterSnapshot> = {}): RegisterSnapshot => ({
  account: account(),
  rows: [
    { transaction: tx({ id: 'a', amount: -5025, payeeId: 'p', categoryId: 'groc', number: '101', status: 'cleared' }), balance: 94975, available: 94975, payeeName: 'Metro', categoryLabel: 'Food : Groceries' },
    { transaction: tx({ id: 'b', date: '2026-10-03', amount: -200000, voided: true }), balance: 94975, available: 94975, payeeName: 'Landlord' },
    { transaction: tx({ id: 'c2', date: '2026-10-04', amount: 300000 }), balance: 394975, available: 394975, payeeName: 'Employer', categoryLabel: 'Transfer from: Savings' }
  ],
  balances: { current: 394975, available: 394975, cleared: 94975, reconciled: 100000, transactionCount: 3 },
  ...over
})
/** A reconciliation of Chequing: a, cleared already (so marked), and c2 after the statement date. */
export const reconcileState = (over: { paused?: boolean, starting?: number, statementBalance?: number } = {}) => {
  const rows = snapshot().rows
  return {
    account: account(),
    reconciliation: {
      id: 'r', rev: 1, accountId: 'c', reconcilerId: 'accounts.reconcile.statement', paused: over.paused ?? false, addedIds: [], startedAt: '',
      statementDate: '2026-10-03', startingBalance: over.starting ?? 100000, statementBalance: over.statementBalance ?? 94975
    },
    summary: { starting: over.starting ?? 100000, marked: -5025, markedCount: 1, difference: 0, lastReconciledBalance: 100000, adjustment: 0 },
    candidates: [
      { transaction: rows[0].transaction, payeeName: 'Metro', categoryLabel: 'Food : Groceries', marked: true, afterStatement: false },
      { transaction: rows[2].transaction, payeeName: 'Employer', categoryLabel: 'Transfer from: Savings', marked: false, afterStatement: true }
    ]
  }
}

const chart = (accounts: Account[]): Chart => ({
  ledger: { name: 'Home' }, subLedgers: [], totals: {},
  accounts: accounts.map(a => ({ account: a, balances: { current: 0, available: 0, cleared: 0, reconciled: 0, transactionCount: 0 } }))
})

const STATEMENT_ACTION = {
  id: 'accounts.reconcile.statement', label: 'Reconcile with Statement…', scope: 'account', command: 'accounts.reconcile.statement', icon: 'Check', enabled: true
}

function setup(options: { snapshot?: RegisterSnapshot | null, answers?: Record<string, (data: any) => unknown> } = {}) {
  const remote = createFakeRemote({})
  const answers: Record<string, (data: any) => unknown> = {
    [ACCOUNTS_CHANNELS.registerAccount]: () => ({ accountId: options.snapshot === null ? null : 'c' }),
    [ACCOUNTS_CHANNELS.chart]: () => chart([account(), account({ id: 's', name: 'Savings' })]),
    [ACCOUNTS_CHANNELS.categories]: () => categories,
    [ACCOUNTS_CHANNELS.loadRegister]: () => options.snapshot === undefined ? snapshot() : options.snapshot,
    [ACCOUNTS_CHANNELS.searchPayees]: () => [{ id: 'p', name: 'Metro', rev: 1, lastCategoryId: 'groc', lastAmount: -5025 }],
    [ACCOUNTS_CHANNELS.saveTransaction]: data => ({ ok: true, value: tx({ id: data.id ?? 'new' }) }),
    [ACCOUNTS_CHANNELS.setStatus]: () => ({ ok: true }),
    [ACCOUNTS_CHANNELS.setVoided]: () => ({ ok: true }),
    [ACCOUNTS_CHANNELS.deleteTransactions]: () => ({ ok: true }),
    [ACCOUNTS_CHANNELS.reconcileState]: () => null,
    [ACCOUNTS_CHANNELS.reconcileActions]: ({ scope }) => scope === 'account' ? [STATEMENT_ACTION] : [],
    'shell:commands.execute': () => undefined,
    ...options.answers
  }
  remote.bridge.invoke.mockImplementation(async (channel: string, data?: any) => {
    const answer = answers[channel]
    if (!answer) throw new Error(`No answer for ${channel}`)
    return answer(data)
  })
  ;(window as any).api = remote.bridge
  render(<Register />)
  const calls = (channel: string) => remote.bridge.invoke.mock.calls.filter((c: unknown[]) => c[0] === channel).map((c: unknown[]) => c[1]) as any[]
  return { ...remote, calls }
}

afterEach(() => { delete (window as any).api })

const table = () => screen.findByRole('table', { name: 'Register of Chequing' })
const line = (id: string) => document.querySelector(`[data-row="${id}"]`) as HTMLElement

describe('the register', () => {
  it('asks for an account when none is chosen', async () => {
    setup({ snapshot: null })
    expect(await screen.findByText(/Choose an account in the Accounts panel/)).toBeInTheDocument()
  })

  it('shows the opening balance, then one line per transaction with its running balance', async () => {
    setup()
    const grid = await table()
    expect(within(grid).getAllByRole('columnheader').map(h => h.textContent)).toEqual(['St', 'Num', 'Date', 'Payee', 'Category', 'Payment', 'Deposit', 'Balance'])
    expect(line('opening')).toHaveTextContent(/Opening balance.*1,000\.00/)
    const a = within(line('a')).getAllByRole('cell').map(c => c.textContent)
    expect(a).toEqual(['C', '101', expect.stringMatching(/2026/), 'Metro', 'Food : Groceries', '50.25', '', expect.stringMatching(/949\.75/)])
    expect(line('b')).toHaveAttribute('data-voided', 'true')
    expect(within(line('b')).getAllByRole('cell')[0]).toHaveTextContent('V')
    expect(line('c2')).toHaveTextContent('Transfer from: Savings')
  })

  it('heads the register with the balances, the available one when the account has a minimum', async () => {
    setup({ snapshot: snapshot({ account: account({ minimumBalance: 50000 }), balances: { current: 394975, available: 344975, cleared: 94975, reconciled: 100000, transactionCount: 3 } }) })
    await table()
    expect(screen.getByText('Current').parentElement).toHaveTextContent(/3,949\.75/)
    expect(screen.getByText(/Available \(above .*500\.00\)/).parentElement).toHaveTextContent(/3,449\.75/)
  })

  it('shows the running balance above the minimum when the account asks for that, headed Available', async () => {
    // The case from review: a CA$4,000 minimum, opening at 4,000, then a 4,000 transfer in
    const minimum = account({ openingBalance: 400000, minimumBalance: 400000, showAvailableBalance: true })
    setup({ snapshot: snapshot({
      account: minimum,
      rows: [{ transaction: tx({ id: 't', amount: 400000 }), balance: 800000, available: 400000, payeeName: 'Me', categoryLabel: 'Transfer from: Savings' }],
      balances: { current: 800000, available: 400000, cleared: 400000, reconciled: 400000, transactionCount: 1 }
    }) })
    const grid = await table()
    expect(within(grid).getAllByRole('columnheader').at(-1)).toHaveTextContent('Available')
    expect(within(line('opening')).getAllByRole('cell').at(-1)).toHaveTextContent(/^\S*0\.00$/)
    expect(within(line('t')).getAllByRole('cell').at(-1)).toHaveTextContent(/4,000\.00/)
    expect(within(line('t')).getAllByRole('cell').at(-1)).not.toHaveTextContent(/8,000/)
  })

  it('shows actual running balances, headed Balance, when the flag is off, even with a minimum', async () => {
    setup({ snapshot: snapshot({
      account: account({ openingBalance: 400000, minimumBalance: 400000 }),
      rows: [{ transaction: tx({ id: 't', amount: 400000 }), balance: 800000, available: 400000 }]
    }) })
    const grid = await table()
    expect(within(grid).getAllByRole('columnheader').at(-1)).toHaveTextContent('Balance')
    expect(within(line('opening')).getAllByRole('cell').at(-1)).toHaveTextContent(/4,000\.00/)
    expect(within(line('t')).getAllByRole('cell').at(-1)).toHaveTextContent(/8,000\.00/)
  })

  it('adds a transaction from the entry row, in minor units, then offers a fresh row for the next', async () => {
    const { calls } = setup()
    await table()
    const entry = document.querySelector('[data-editing="new"]') as HTMLElement
    await userEvent.clear(within(entry).getByRole('textbox', { name: 'Number' }))
    await userEvent.type(within(entry).getByRole('textbox', { name: 'Number' }), '102')
    await userEvent.type(within(entry).getByRole('combobox', { name: 'Payee' }), 'Hydro')
    await userEvent.type(within(entry).getByRole('textbox', { name: 'Payment' }), '80.5{Enter}')

    expect(calls(ACCOUNTS_CHANNELS.saveTransaction)).toEqual([{
      accountId: 'c', confirm: [], draft: { date: '2026-10-04', amount: -8050, status: 'uncleared', number: '102', payee: 'Hydro' }
    }])
    // The next row keeps the date and goes on to the next cheque number
    await waitFor(() => expect(within(document.querySelector('[data-editing="new"]') as HTMLElement).getByRole('textbox', { name: 'Number' })).toHaveValue('103'))
  })

  it('fills the category and amount from a known payee on a new entry', async () => {
    setup()
    await table()
    const entry = document.querySelector('[data-editing="new"]') as HTMLElement
    await userEvent.type(within(entry).getByRole('combobox', { name: 'Payee' }), 'Met')
    await userEvent.click(await screen.findByRole('option', { name: 'Metro' }))
    expect(within(entry).getByRole('textbox', { name: 'Payment' })).toHaveValue('50.25')
    expect(within(entry).getByRole('combobox', { name: 'Category' })).toHaveValue('Food : Groceries')
  })

  it('edits a row in place, sending the whole row with its revision', async () => {
    const { calls } = setup()
    await table()
    await userEvent.dblClick(line('a'))
    const editor = document.querySelector('[data-editing="a"]') as HTMLElement
    const payment = within(editor).getByRole('textbox', { name: 'Payment' })
    expect(payment).toHaveValue('50.25')
    await userEvent.clear(payment)
    await userEvent.type(payment, '60{Enter}')
    expect(calls(ACCOUNTS_CHANNELS.saveTransaction).at(-1)).toEqual({
      accountId: 'c', id: 'a', expectedRev: 1, confirm: [],
      draft: { date: '2026-10-02', amount: -6000, status: 'cleared', number: '101', payee: 'Metro', categoryId: 'groc' }
    })
  })

  it('asks before changing a reconciled transaction, and sends the confirmation when the user agrees', async () => {
    let first = true
    const { calls } = setup({
      answers: {
        [ACCOUNTS_CHANNELS.saveTransaction]: () => {
          if (first) { first = false; return { ok: false, error: { code: 'CONFIRMATION_REQUIRED', message: 'The transaction of 2026-10-02 is reconciled.', reasons: ['reconciled'] } } }
          return { ok: true, value: tx({ id: 'a' }) }
        }
      }
    })
    await table()
    await userEvent.dblClick(line('a'))
    // The memo is on the editor's second line
    const memoLine = (document.querySelector('[data-editing="a"]') as HTMLElement).nextElementSibling as HTMLElement
    await userEvent.type(within(memoLine).getByRole('textbox', { name: 'Memo' }), 'x{Enter}')
    const dialog = await screen.findByRole('dialog', { name: 'Change a reconciled transaction?' })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Change It' }))
    await waitFor(() => expect(calls(ACCOUNTS_CHANNELS.saveTransaction).map(c => c.confirm)).toEqual([[], ['reconciled']]))
  })

  it('shows a problem on its field, and keeps the row open', async () => {
    setup({ answers: { [ACCOUNTS_CHANNELS.saveTransaction]: () => ({ ok: false, error: { code: 'CURRENCY_MISMATCH', message: '“US” is in USD.', field: 'category' } }) } })
    await table()
    const entry = document.querySelector('[data-editing="new"]') as HTMLElement
    await userEvent.type(within(entry).getByRole('textbox', { name: 'Deposit' }), '5{Enter}')
    expect(await within(entry.nextElementSibling as HTMLElement).findByRole('alert')).toHaveTextContent('“US” is in USD.')
    expect(within(entry).getByRole('combobox', { name: 'Category' })).toHaveAttribute('aria-invalid', 'true')
  })

  it('clears with Space, voids with Ctrl+Shift+V and deletes with Delete (after asking)', async () => {
    const { calls } = setup()
    const grid = await table()
    await userEvent.click(line('c2'))
    const container = grid.closest('[tabindex="0"]') as HTMLElement
    container.focus()
    await userEvent.keyboard(' ')
    await userEvent.keyboard('{Control>}{Shift>}v{/Shift}{/Control}')
    await userEvent.keyboard('{Delete}')
    const dialog = await screen.findByRole('dialog', { name: 'Delete this transaction?' })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(calls(ACCOUNTS_CHANNELS.deleteTransactions)).toHaveLength(1))
    expect(calls(ACCOUNTS_CHANNELS.setStatus)).toEqual([{ accountId: 'c', confirm: [], ids: ['c2'], status: 'cleared' }])
    expect(calls(ACCOUNTS_CHANNELS.setVoided)).toEqual([{ accountId: 'c', confirm: [], ids: ['c2'], voided: true }])
    expect(calls(ACCOUNTS_CHANNELS.deleteTransactions)).toEqual([{ accountId: 'c', confirm: [], ids: ['c2'] }])
  })

  it('offers no entry row, and no editing, in a closed account', async () => {
    setup({ snapshot: snapshot({ account: account({ closed: true, closedOn: '2026-11-01' }) }) })
    await table()
    expect(document.querySelector('[data-editing]')).toBeNull()
    expect(screen.getByText(/This account is closed/)).toBeInTheDocument()
    await userEvent.dblClick(line('a'))
    expect(document.querySelector('[data-editing]')).toBeNull()
  })

  it('reloads when its account\'s transactions change, and not for another account\'s', async () => {
    const { calls, emit } = setup()
    await table()
    const before = calls(ACCOUNTS_CHANNELS.loadRegister).length
    act(() => emit(ACCOUNTS_EVENTS.transactions, { accounts: ['other'] }))
    act(() => emit(ACCOUNTS_EVENTS.transactions, { accounts: ['c'] }))
    await waitFor(() => expect(calls(ACCOUNTS_CHANNELS.loadRegister).length).toBe(before + 1))
  })

  it('offers the selected row\'s actions on a toolbar, greyed out until a row is selected', async () => {
    const { calls } = setup()
    await table()
    const bar = screen.getByRole('toolbar', { name: 'Register actions' })
    // The entry row is selected to begin with
    for (const name of ['Edit', 'Mark Cleared', 'Void', 'Delete']) expect(within(bar).getByRole('button', { name })).toBeDisabled()

    await userEvent.click(line('a'))
    // Row a is cleared: the toolbar offers the opposite
    expect(within(bar).getByRole('button', { name: 'Mark Uncleared' })).toBeEnabled()
    await userEvent.click(within(bar).getByRole('button', { name: 'Mark Uncleared' }))
    await userEvent.click(within(bar).getByRole('button', { name: 'Void' }))
    expect(calls(ACCOUNTS_CHANNELS.setStatus)).toEqual([{ accountId: 'c', confirm: [], ids: ['a'], status: 'uncleared' }])
    expect(calls(ACCOUNTS_CHANNELS.setVoided)).toEqual([{ accountId: 'c', confirm: [], ids: ['a'], voided: true }])

    await userEvent.click(line('b'))
    expect(within(bar).getByRole('button', { name: 'Unvoid' })).toBeEnabled()

    await userEvent.click(within(bar).getByRole('button', { name: 'Edit' }))
    expect(document.querySelector('[data-editing="b"]')).not.toBeNull()
    // While a row is being edited, the row actions wait
    expect(within(bar).getByRole('button', { name: 'Delete' })).toBeDisabled()
  })

  it('deletes from the toolbar after asking', async () => {
    const { calls } = setup()
    await table()
    await userEvent.click(line('c2'))
    await userEvent.click(within(screen.getByRole('toolbar', { name: 'Register actions' })).getByRole('button', { name: 'Delete' }))
    await userEvent.click(within(await screen.findByRole('dialog', { name: 'Delete this transaction?' })).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(calls(ACCOUNTS_CHANNELS.deleteTransactions)).toEqual([{ accountId: 'c', confirm: [], ids: ['c2'] }]))
  })

  it('greys out the row actions in a closed account', async () => {
    setup({ snapshot: snapshot({ account: account({ closed: true, closedOn: '2026-11-01' }) }) })
    await table()
    await userEvent.click(line('a'))
    const bar = screen.getByRole('toolbar', { name: 'Register actions' })
    for (const name of ['New', 'Edit', 'Mark Uncleared', 'Void', 'Delete', 'Reconcile…']) expect(within(bar).getByRole('button', { name })).toBeDisabled()
  })

  it('reconciles from the toolbar: one option is a button, running its command with the account', async () => {
    const { calls } = setup()
    await table()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Reconcile…' })).toBeEnabled())
    await userEvent.click(screen.getByRole('button', { name: 'Reconcile…' }))
    expect(calls('shell:commands.execute')).toEqual([{ id: 'accounts.reconcile.statement', args: [{ accountId: 'c' }] }])
  })

  it('lists several reconciliation options in a menu, and a plugin\'s row options in the row menu', async () => {
    const { calls } = setup({
      answers: {
        [ACCOUNTS_CHANNELS.reconcileActions]: ({ scope }) => scope === 'account'
          ? [STATEMENT_ACTION, { id: 'bank.sync', label: 'Match Downloaded…', scope: 'account', command: 'bank.match', enabled: false }]
          : [{ id: 'bank.find', label: 'Find on Statement', scope: 'transaction', command: 'bank.find', enabled: true }]
      }
    })
    await table()
    await userEvent.click(await screen.findByRole('button', { name: 'Reconcile' }))
    const menu = screen.getByRole('menu')
    expect(within(menu).getByRole('menuitem', { name: 'Match Downloaded…' })).toHaveAttribute('aria-disabled', 'true')
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Reconcile with Statement…' }))

    await userEvent.pointer({ keys: '[MouseRight]', target: line('a') })
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Find on Statement' }))
    expect(calls('shell:commands.execute')).toEqual([
      { id: 'accounts.reconcile.statement', args: [{ accountId: 'c' }] },
      { id: 'bank.find', args: [{ accountId: 'c', transactionIds: ['a'] }] }
    ])
  })

  it('says when a reconciliation is paused, and resumes it', async () => {
    const { calls } = setup({ answers: { [ACCOUNTS_CHANNELS.reconcileState]: () => reconcileState({ paused: true }) } })
    await table()
    const note = await waitFor(() => {
      const found = document.querySelector('[data-note="paused"]') as HTMLElement | null
      expect(found).not.toBeNull()
      return found!
    })
    expect(note).toHaveTextContent(/statement of .*2026 is paused/)
    await userEvent.click(within(note).getByRole('button', { name: 'Resume' }))
    expect(calls('shell:commands.execute')).toEqual([{ id: 'accounts.reconcile.statement', args: [{ accountId: 'c' }] }])
  })
})
