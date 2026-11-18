import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ACCOUNTS_CHANNELS, ACCOUNTS_EVENTS, type Account, type Category, type Chart, type RegisterSnapshot, type Transaction
} from '@tessera/accounts-api'
import Register from '../../../../plugins/accounts/src/renderer/register/Register'
import { createFakeRemote } from '../../../helpers/fakeBridge'

const account = (over: Partial<Account> = {}): Account => ({
  id: 'c', rev: 1, name: 'Chequing', type: 'chequing', subBookId: null, currency: 'CAD', openingDate: '2026-01-01',
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
  book: { name: 'Home' }, subBooks: [], totals: {},
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
    [ACCOUNTS_CHANNELS.registerOverlays]: () => [],
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

  it('shows a figure another plugin contributes, asks its command again when told to, and hides it when it has nothing', async () => {
    let projected: { minor: number, currency: string, detail?: string } | undefined = { minor: 123456, currency: 'CAD', detail: 'after 2 scheduled transactions' }
    const b = setup({
      answers: {
        [ACCOUNTS_CHANNELS.registerFigures]: () => [
          { id: 'recurring.projected', label: 'Projected (30 days)', command: 'recurring.projectBalance', refreshOn: 'recurring:snapshot.changed', enabled: true }
        ],
        'shell:commands.execute': ({ id }) => id === 'recurring.projectBalance' ? projected : undefined
      }
    })
    await table()
    const figure = await waitFor(() => {
      const found = document.querySelector('[data-figure="recurring.projected"]') as HTMLElement | null
      expect(found).not.toBeNull()
      return found!
    })
    expect(figure).toHaveTextContent('Projected (30 days)')
    expect(figure).toHaveTextContent(/1,234\.56/)
    expect(figure).toHaveTextContent('after 2 scheduled transactions')
    expect(b.calls('shell:commands.execute').at(-1)).toEqual({ id: 'recurring.projectBalance', args: [{ accountId: 'c' }] })

    // The event the contribution names makes the register ask again; nothing back means no figure
    projected = undefined
    act(() => { b.emit('recurring:snapshot.changed', null) })
    await waitFor(() => expect(document.querySelector('[data-figure="recurring.projected"]')).toBeNull())
  })

  it('reconciles from the toolbar: one option is a button, running its command with the account', async () => {
    const { calls } = setup()
    await table()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Reconcile…' })).toBeEnabled())
    await userEvent.click(screen.getByRole('button', { name: 'Reconcile…' }))
    expect(calls('shell:commands.execute')).toEqual([{ id: 'accounts.reconcile.statement', args: [{ accountId: 'c' }] }])
  })

  it('lists several reconciliation options in a menu, and a plugin\'s row actions in the row menu', async () => {
    const { calls } = setup({
      answers: {
        [ACCOUNTS_CHANNELS.reconcileActions]: () =>
          [STATEMENT_ACTION, { id: 'bank.sync', label: 'Match Downloaded…', scope: 'account', command: 'bank.match', enabled: false }],
        // A row's contributed items come from `accounts.transaction.actions`, which also carries a reconciler's
        // transaction-scope options; the register asks for them each time the menu opens
        [ACCOUNTS_CHANNELS.transactionActions]: ({ count }) => count === 1
          ? [
            { id: 'bank.find', label: 'Find on Statement', command: 'bank.find', enabled: true },
            // What the recurring plugin contributes, as the register receives it
            { id: 'recurring.fromTransaction', label: 'Make Recurring…', command: 'recurring.fromTransaction', icon: 'Repeat', enabled: true }
          ]
          : []
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

    // The row's own items first, then a divider, then what other plugins added
    await userEvent.pointer({ keys: '[MouseRight]', target: line('a') })
    const rowMenu = await screen.findByRole('menu')
    expect(within(rowMenu).getAllByRole('menuitem').map(i => i.textContent)).toEqual([
      'Edit', 'Mark Uncleared', 'Void', 'Delete…', 'Find on Statement', 'Make Recurring…'
    ])
    await userEvent.click(within(rowMenu).getByRole('menuitem', { name: 'Make Recurring…' }))
    expect(calls('shell:commands.execute').at(-1))
      .toEqual({ id: 'recurring.fromTransaction', args: [{ accountId: 'c', transactionIds: ['a'] }] })
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

describe('provisional rows (accounts.register.overlays)', () => {
  const overlayRow = (over: Record<string, unknown> = {}) => ({
    key: 'ex:s1:r0',
    date: '2026-10-03',
    amount: -15000,
    payee: 'Hydro Ottawa',
    note: 'New',
    actions: [
      { id: 'x.accept', label: 'Accept', command: 'x.accept', primary: true },
      { id: 'x.change', label: 'Change…', command: 'x.change' }
    ],
    ...over
  })

  const withOverlay = (rows: unknown[] = [overlayRow()]) => setup({
    answers: {
      [ACCOUNTS_CHANNELS.registerOverlays]: () => [{ id: 'x.pending', channel: 'x:pending.rows' }],
      'x:pending.rows': () => rows
    }
  })

  const overlayLine = (key: string) => document.querySelector(`[data-overlay="${key}"]`) as HTMLElement

  it('merges the provider’s rows into the register by date, bold with a ? in the gutter', async () => {
    withOverlay()
    await table()
    await waitFor(() => expect(overlayLine('ex:s1:r0')).not.toBeNull())
    const cells = within(overlayLine('ex:s1:r0')).getAllByRole('cell').map(c => c.textContent)
    expect(cells[0]).toBe('?')
    expect(cells[3]).toBe('Hydro Ottawa')
    // Between b (10-03) and c2 (10-04): same-date register rows come first
    const order = [...document.querySelectorAll('[data-row], [data-overlay]')]
      .map(el => el.getAttribute('data-row') ?? el.getAttribute('data-overlay'))
    expect(order).toEqual(['opening', 'a', 'b', 'ex:s1:r0', 'c2'])
  })

  it('adds an unmatched row to the shown balance, and a matched one not', async () => {
    withOverlay([
      overlayRow(),
      overlayRow({ key: 'ex:s1:r1', date: '2026-10-05', amount: -5000, matchedId: 'a', note: 'Matches 2 Oct' })
    ])
    await table()
    await waitFor(() => expect(overlayLine('ex:s1:r1')).not.toBeNull())
    // After b the balance is 949.75; the unmatched -150.00 shows 799.75; the matched row adds nothing more…
    expect(within(overlayLine('ex:s1:r0')).getAllByRole('cell').at(-1)).toHaveTextContent(/799\.75/)
    // …but still reflects the unmatched one before it, over the last real row's balance
    expect(within(overlayLine('ex:s1:r1')).getAllByRole('cell').at(-1)).toHaveTextContent(/3,799\.75/)
  })

  it('draws a matched row and its register transaction as one line, where the statement puts it', async () => {
    withOverlay([overlayRow({ key: 'ex:s1:r1', date: '2026-10-05', amount: -5000, payee: 'METRO #4471', matchedId: 'a', note: 'Matches 2 Oct' })])
    await table()
    await waitFor(() => expect(overlayLine('ex:s1:r1')).not.toBeNull())

    // The transaction's own line is gone; the combined one sits at the bank's date
    const order = [...document.querySelectorAll('[data-row], [data-overlay]')]
      .map(el => el.getAttribute('data-row') ?? el.getAttribute('data-overlay'))
    expect(order).toEqual(['opening', 'b', 'c2', 'ex:s1:r1'])
    expect(overlayLine('ex:s1:r1')).toHaveAttribute('data-matched', 'a')

    // The bank's date and amount, the user's number, payee and category — every cell bold, ? in the gutter
    const cells = within(overlayLine('ex:s1:r1')).getAllByRole('cell')
    expect(cells.map(c => c.textContent)).toEqual(['?', '101', expect.stringMatching(/2026/), 'Metro', 'Food : Groceries', '50.00', '', expect.stringMatching(/3,949\.75/)])
    expect(cells[2]).toHaveTextContent(/Oct 5|5 Oct|10\/05|2026-10-05/)
    for (const cell of cells) expect(getComputedStyle(cell).fontWeight).toBe('600')
  })

  it('shows Accept and Change… only while the row is selected, and runs the command with the row’s key', async () => {
    const { calls } = withOverlay()
    await table()
    await waitFor(() => expect(overlayLine('ex:s1:r0')).not.toBeNull())
    expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull()

    await userEvent.click(overlayLine('ex:s1:r0'))
    await userEvent.click(await screen.findByRole('button', { name: 'Accept' }))
    expect(calls('shell:commands.execute').at(-1))
      .toEqual({ id: 'x.accept', args: [{ accountId: 'c', key: 'ex:s1:r0' }] })

    await userEvent.click(screen.getByRole('button', { name: 'Change…' }))
    expect(calls('shell:commands.execute').at(-1))
      .toEqual({ id: 'x.change', args: [{ accountId: 'c', key: 'ex:s1:r0' }] })
  })

  describe('what the statement said, under a matched row', () => {
    const statementLine = (key: string) =>
      document.querySelector(`[data-statement-line="${key}"]`) as HTMLElement

    /** A matched row whose bank values differ from the register's in payee and amount, but not in date. */
    const matchedRow = (over: Record<string, unknown> = {}) => overlayRow({
      key: 'ex:s1:r1', date: '2026-10-02', amount: -5000, payee: 'METRO #4471',
      matchedId: 'a', note: 'Matches 2 Oct', ...over
    })

    it('appears only when a matched row is selected', async () => {
      withOverlay([matchedRow()])
      await table()
      await waitFor(() => expect(overlayLine('ex:s1:r1')).not.toBeNull())
      expect(statementLine('ex:s1:r1')).toBeNull()

      await userEvent.click(overlayLine('ex:s1:r1'))
      expect(statementLine('ex:s1:r1')).not.toBeNull()
    })

    it('does not appear for an unmatched row, which has nothing to compare against', async () => {
      withOverlay()
      await table()
      await waitFor(() => expect(overlayLine('ex:s1:r0')).not.toBeNull())
      await userEvent.click(overlayLine('ex:s1:r0'))
      expect(statementLine('ex:s1:r0')).toBeNull()
    })

    it('puts the bank’s values in the same columns as the register’s, so they line up', async () => {
      withOverlay([matchedRow()])
      await table()
      await waitFor(() => expect(overlayLine('ex:s1:r1')).not.toBeNull())
      await userEvent.click(overlayLine('ex:s1:r1'))

      const above = within(overlayLine('ex:s1:r1')).getAllByRole('cell')
      const below = within(statementLine('ex:s1:r1')).getAllByRole('cell')
      // Same number of columns, so every value sits under the one it should be compared with.
      expect(below).toHaveLength(above.length)
      expect(below[3]).toHaveTextContent('METRO #4471')   // the bank's payee, under the register's
      expect(below[5]).toHaveTextContent('50.00')          // and its amount, in the debit column
    })

    it('draws the cells the bank disagrees with in full strength, and the rest dimmed', async () => {
      withOverlay([matchedRow()])
      await table()
      await waitFor(() => expect(overlayLine('ex:s1:r1')).not.toBeNull())
      await userEvent.click(overlayLine('ex:s1:r1'))

      const cells = within(statementLine('ex:s1:r1')).getAllByRole('cell')
      // The payee differs — METRO #4471 against Metro — so it is the one worth reading.
      expect(getComputedStyle(cells[3]).fontWeight).toBe('600')
      // The date agrees, so it is not competing for attention.
      expect(getComputedStyle(cells[2]).fontWeight).toBe('400')
    })

    it('treats a payee differing only by case or spacing as agreeing', async () => {
      withOverlay([matchedRow({ payee: '  metro  ' })])
      await table()
      await waitFor(() => expect(overlayLine('ex:s1:r1')).not.toBeNull())
      await userEvent.click(overlayLine('ex:s1:r1'))

      const cells = within(statementLine('ex:s1:r1')).getAllByRole('cell')
      expect(getComputedStyle(cells[3]).fontWeight).toBe('400')
    })

    it('no longer says it in prose, which is what the columns replaced', async () => {
      withOverlay([matchedRow()])
      await table()
      await waitFor(() => expect(overlayLine('ex:s1:r1')).not.toBeNull())
      await userEvent.click(overlayLine('ex:s1:r1'))
      expect(screen.queryByText(/the bank reported/)).toBeNull()
      // The disposition is still said, because that is not a comparison.
      expect(screen.getByText('Matches 2 Oct')).toBeInTheDocument()
    })
  })

  it('leaves the register untouched when the provider fails', async () => {
    setup({
      answers: {
        [ACCOUNTS_CHANNELS.registerOverlays]: () => [{ id: 'x.pending', channel: 'x:pending.rows' }],
        'x:pending.rows': () => { throw new Error('boom') }
      }
    })
    await table()
    expect(line('a')).toBeInTheDocument()
    expect(document.querySelector('[data-overlay]')).toBeNull()
  })
})
