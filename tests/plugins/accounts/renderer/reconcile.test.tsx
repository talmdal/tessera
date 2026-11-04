import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ACCOUNTS_CHANNELS, ACCOUNTS_EVENTS, todayIso,
  type Account, type Category, type ReconcileDialogInput, type ReconcileState, type RegisterSnapshot, type Transaction
} from '@tessera/accounts-api'
import ReconcileDialog, { initialFigures, readFigures, type StatementForm } from '../../../../plugins/accounts/src/renderer/reconcile/ReconcileDialog'
import ReconcilePanel from '../../../../plugins/accounts/src/renderer/reconcile/ReconcilePanel'
import Register from '../../../../plugins/accounts/src/renderer/register/Register'
import { correctedAmount } from '../../../../plugins/accounts/src/renderer/register/model'
import { createFakeRemote } from '../../../helpers/fakeBridge'

const account = (over: Partial<Account> = {}): Account => ({
  id: 'c', rev: 1, name: 'Chequing', type: 'chequing', subBookId: null, currency: 'CAD', openingDate: '2026-01-01',
  openingBalance: 100000, order: 0, closed: false, ...over
})
const tx = (over: Partial<Transaction>): Transaction => ({
  id: 't', rev: 3, accountId: 'c', date: '2026-10-02', amount: -5000, status: 'uncleared', voided: false, createdAt: '', updatedAt: '', ...over
})
const metro = tx({ id: 'a', amount: -5025, status: 'cleared' })
const hydro = tx({ id: 'h', amount: -8000, date: '2026-10-03' })
const pay = tx({ id: 'p', amount: 300000, date: '2026-11-04' })

const state = (over: Partial<ReconcileState['summary']> & { paused?: boolean } = {}): ReconcileState => ({
  account: account(),
  reconciliation: {
    id: 'r', rev: 1, accountId: 'c', reconcilerId: 'accounts.reconcile.statement', paused: over.paused ?? false, addedIds: [], startedAt: '',
    statementDate: '2026-10-31', startingBalance: 100000, statementBalance: 86975
  },
  summary: { starting: 100000, marked: -5025, markedCount: 1, difference: -8000, lastReconciledBalance: 100000, adjustment: -8000, ...over },
  candidates: [
    { transaction: metro, payeeName: 'Metro', marked: true, afterStatement: false },
    { transaction: hydro, payeeName: 'Hydro', marked: false, afterStatement: false },
    { transaction: pay, payeeName: 'Employer', marked: false, afterStatement: true }
  ]
})

function bridge(answers: Record<string, (data: any) => unknown>) {
  const remote = createFakeRemote({})
  remote.bridge.invoke.mockImplementation(async (channel: string, data?: any) => {
    const answer = answers[channel]
    if (!answer) throw new Error(`No answer for ${channel}`)
    return answer(data)
  })
  ;(window as any).api = remote.bridge
  const calls = (channel: string) => remote.bridge.invoke.mock.calls.filter((c: unknown[]) => c[0] === channel).map((c: unknown[]) => c[1]) as any[]
  return { ...remote, calls }
}

afterEach(() => { delete (window as any).api })

describe('the statement dialog', () => {
  const categories: Category[] = [
    { id: 'fees', parentId: null, name: 'Bank fees', kind: 'expense', rev: 1 },
    { id: 'int', parentId: null, name: 'Interest', kind: 'income', rev: 1 },
    { id: 'paid', parentId: null, name: 'Interest paid', kind: 'expense', rev: 1 },
    { id: 'food', parentId: null, name: 'Food', kind: 'expense', rev: 1 }
  ]
  const input = (over: Partial<ReconcileDialogInput> = {}): ReconcileDialogInput => ({
    account: account(), lastReconciled: { balance: 123456, date: '2026-09-30' },
    categories, defaultCategories: { serviceCharge: 'fees', interest: 'int' }, ...over
  })
  const noCharge = (categoryId: string | null = null) => ({ amount: '', date: '', categoryId })
  const form = (over: Partial<StatementForm> = {}): StatementForm => ({
    statementDate: '2026-10-31', startingBalance: '1234.56', statementBalance: '1500',
    serviceCharge: noCharge(), interest: noCharge(), ...over
  })

  it('starts from today and the balance the last reconciliation left, with the usual categories for charges', () => {
    expect(initialFigures(input())).toEqual({
      statementDate: todayIso(), startingBalance: '1234.56', statementBalance: '',
      serviceCharge: noCharge('fees'), interest: noCharge('int')
    })
  })

  it('shows a credit card\'s balances as amounts owed, and stores them negative', () => {
    const card = input({ account: account({ type: 'creditCard' }), lastReconciled: { balance: -50000 } })
    expect(initialFigures(card).startingBalance).toBe('500.00')
    expect(readFigures(form({ startingBalance: '500', statementBalance: '725.10' }), card).figures)
      .toEqual({ statementDate: '2026-10-31', startingBalance: -50000, statementBalance: -72510 })
  })

  it('says what is wrong with each figure', () => {
    expect(readFigures(form({
      statementDate: '', startingBalance: 'x', statementBalance: '',
      serviceCharge: { amount: '-4', date: '', categoryId: null }, interest: { amount: 'abc', date: '', categoryId: null }
    }), input()).problems).toEqual({
      statementDate: 'Enter the statement date.',
      startingBalance: expect.stringMatching(/number/),
      statementBalance: 'Enter the balance the statement ends with.',
      serviceCharge: expect.stringMatching(/without a sign/),
      interest: expect.stringMatching(/number/)
    })
  })

  it('gives charges unsigned, dated the statement date unless another is chosen, and leaves out blank and zero ones', () => {
    expect(readFigures(form({
      serviceCharge: { amount: '4.95', date: '', categoryId: 'fees' },
      interest: { amount: '0.12', date: '2026-10-30', categoryId: null }
    }), input()).figures).toEqual({
      statementDate: '2026-10-31', startingBalance: 123456, statementBalance: 150000,
      serviceCharge: { amount: 495, date: '2026-10-31', categoryId: 'fees' },
      interest: { amount: 12, date: '2026-10-30' }
    })
    expect(readFigures(form({ serviceCharge: { amount: '0', date: '', categoryId: 'fees' } }), input()).figures).not.toHaveProperty('serviceCharge')
  })

  it('returns the figures, and notes a starting balance other than the reconciled one', async () => {
    const close = vi.fn()
    render(<ReconcileDialog input={input()} close={close} setBusy={() => undefined} />)
    expect(screen.getByRole('textbox', { name: 'Starting balance' })).toHaveValue('1234.56')
    expect(screen.getByText(/Reconciled to .*2026: .*1,234\.56/)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(close).not.toHaveBeenCalled()
    expect(screen.getByText('Enter the balance the statement ends with.')).toBeInTheDocument()

    const starting = screen.getByRole('textbox', { name: 'Starting balance' })
    await userEvent.clear(starting)
    await userEvent.type(starting, '1200')
    expect(screen.getByText(/starts from a different balance/)).toBeInTheDocument()
    await userEvent.type(screen.getByRole('textbox', { name: 'Ending balance' }), '1,500.25{Enter}')
    expect(close).toHaveBeenCalledWith({ statementDate: todayIso(), startingBalance: 120000, statementBalance: 150025 })
  })

  it('takes a service charge and interest earned, each with a date and a category', async () => {
    const close = vi.fn()
    render(<ReconcileDialog input={input()} close={close} setBusy={() => undefined} />)
    await userEvent.type(screen.getByRole('textbox', { name: 'Ending balance' }), '1500')
    await userEvent.type(screen.getByRole('textbox', { name: 'Service charge' }), '4.95')
    expect(screen.getByRole('combobox', { name: 'Service charge category' })).toHaveValue('Bank fees')
    await userEvent.type(screen.getByRole('textbox', { name: 'Interest earned' }), '1.20')
    expect(screen.getByLabelText('Interest earned date')).toHaveValue(todayIso())
    // Another category for the interest
    const interestCategory = screen.getByRole('combobox', { name: 'Interest earned category' })
    await userEvent.clear(interestCategory)
    await userEvent.type(interestCategory, 'Foo')
    await userEvent.click(await screen.findByRole('option', { name: 'Food' }))
    await userEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(close).toHaveBeenCalledWith(expect.objectContaining({
      serviceCharge: { amount: 495, date: todayIso(), categoryId: 'fees' },
      interest: { amount: 120, date: todayIso(), categoryId: 'food' }
    }))
  })

  it('calls a liability\'s interest "Interest charged"', () => {
    render(<ReconcileDialog close={() => undefined} setBusy={() => undefined}
      input={input({ account: account({ type: 'creditCard' }), defaultCategories: { serviceCharge: 'fees', interest: 'paid' } })} />)
    expect(screen.getByRole('textbox', { name: 'Interest charged' })).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Interest charged category' })).toHaveValue('Interest paid')
  })

  it('keeps the dialog open on a bad charge, saying what is wrong', async () => {
    const close = vi.fn()
    render(<ReconcileDialog input={input()} close={close} setBusy={() => undefined} />)
    await userEvent.type(screen.getByRole('textbox', { name: 'Ending balance' }), '1500')
    await userEvent.type(screen.getByRole('textbox', { name: 'Service charge' }), 'lots{Enter}')
    expect(close).not.toHaveBeenCalled()
    expect(screen.getByRole('textbox', { name: 'Service charge' })).toHaveAttribute('aria-invalid', 'true')
  })

  it('carries on with a paused reconciliation\'s figures, its charges already added', () => {
    render(<ReconcileDialog close={() => undefined} setBusy={() => undefined}
      input={input({ current: { statementDate: '2026-10-31', startingBalance: 100000, statementBalance: 86975 } })} />)
    expect(screen.getByRole('textbox', { name: 'Ending balance' })).toHaveValue('869.75')
    expect(screen.getByRole('textbox', { name: 'Service charge' })).toHaveValue('')
    expect(screen.getByText(/already in the register/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Continue' })).toBeInTheDocument()
    expect(screen.getByText(/part way through/)).toBeInTheDocument()
  })
})

describe('the reconcile panel', () => {
  const setup = (answers: Record<string, (data: any) => unknown> = {}) => {
    const b = bridge({
      [ACCOUNTS_CHANNELS.registerAccount]: () => ({ accountId: 'c' }),
      [ACCOUNTS_CHANNELS.reconcileState]: () => state(),
      [ACCOUNTS_CHANNELS.reconcilePause]: () => ({ ok: true }),
      [ACCOUNTS_CHANNELS.reconcileCancel]: () => ({ ok: true }),
      [ACCOUNTS_CHANNELS.reconcileFinish]: () => ({ ok: true, value: { reconciledCount: 1 } }),
      ...answers
    })
    render(<ReconcilePanel />)
    return b
  }
  const figure = (name: string) => document.querySelector(`[data-figure="${name}"]`) as HTMLElement

  it('shows the statement\'s figures, the marked total and the difference', async () => {
    setup()
    expect(await screen.findByText('Reconciling Chequing')).toBeInTheDocument()
    expect(figure('starting')).toHaveTextContent(/1,000\.00/)
    expect(figure('marked')).toHaveTextContent(/-\S*50\.25/)
    expect(figure('ending')).toHaveTextContent(/869\.75/)
    expect(figure('difference')).toHaveTextContent(/-\S*80\.00/)
    expect(screen.getByText('Marked (1)')).toBeInTheDocument()
  })

  it('follows the reconciliation as transactions are marked', async () => {
    const { emit } = setup()
    await screen.findByText('Reconciling Chequing')
    act(() => emit(ACCOUNTS_EVENTS.reconcile, { accountId: 'other', state: null }))
    act(() => emit(ACCOUNTS_EVENTS.reconcile, { accountId: 'c', state: state({ marked: -13025, markedCount: 2, difference: 0, adjustment: 0 }) }))
    expect(figure('difference')).toHaveTextContent(/^\S*0\.00$/)
    expect(screen.getByText('Marked (2)')).toBeInTheDocument()
  })

  it('completes; when the statement still differs, asks before adding a balance adjustment', async () => {
    let first = true
    const { calls } = setup({
      [ACCOUNTS_CHANNELS.reconcileFinish]: () => {
        if (!first) return { ok: true, value: { reconciledCount: 1 } }
        first = false
        return { ok: false, error: { code: 'CONFIRMATION_REQUIRED', message: 'Your records and the statement differ by -$80.00.', reasons: ['adjustBalance'] } }
      }
    })
    await userEvent.click(await screen.findByRole('button', { name: 'Complete' }))
    const dialog = await screen.findByRole('dialog', { name: 'Add a balance adjustment?' })
    expect(dialog).toHaveTextContent('differ by')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add Adjustment' }))
    await waitFor(() => expect(calls(ACCOUNTS_CHANNELS.reconcileFinish)).toEqual([
      { accountId: 'c', confirm: [] }, { accountId: 'c', confirm: ['adjustBalance'] }
    ]))
  })

  it('goes back to marking when the user declines the adjustment', async () => {
    const { calls } = setup({
      [ACCOUNTS_CHANNELS.reconcileFinish]: () => ({ ok: false, error: { code: 'CONFIRMATION_REQUIRED', message: 'Differ.', reasons: ['adjustBalance'] } })
    })
    await userEvent.click(await screen.findByRole('button', { name: 'Complete' }))
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Go Back' }))
    expect(calls(ACCOUNTS_CHANNELS.reconcileFinish)).toHaveLength(1)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('pauses at once, and cancels only after asking', async () => {
    const { calls } = setup()
    await userEvent.click(await screen.findByRole('button', { name: 'Pause' }))
    expect(calls(ACCOUNTS_CHANNELS.reconcilePause)).toEqual([{ accountId: 'c' }])

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    const dialog = await screen.findByRole('dialog', { name: 'Cancel this reconciliation?' })
    expect(dialog).toHaveTextContent('go back to how they were')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Keep Reconciling' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(calls(ACCOUNTS_CHANNELS.reconcileCancel)).toEqual([])
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel Reconciliation' }))
    await waitFor(() => expect(calls(ACCOUNTS_CHANNELS.reconcileCancel)).toEqual([{ accountId: 'c' }]))
  })

  it('warns that cancelling deletes the charges it added from the statement', async () => {
    const withCharges = state()
    withCharges.reconciliation.addedIds = ['fee']
    setup({ [ACCOUNTS_CHANNELS.reconcileState]: () => withCharges })
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    expect(await screen.findByRole('dialog', { name: 'Cancel this reconciliation?' })).toHaveTextContent('service charge and interest added from the statement are deleted')
  })

  it('shows why a request failed', async () => {
    setup({ [ACCOUNTS_CHANNELS.reconcilePause]: () => ({ ok: false, error: { code: 'READ_ONLY', message: 'The book is read-only.' } }) })
    await userEvent.click(await screen.findByRole('button', { name: 'Pause' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('The book is read-only.')
  })

  it('explains a statement that starts elsewhere than the records', async () => {
    setup({ [ACCOUNTS_CHANNELS.reconcileState]: () => state({ starting: 90000, difference: 0, adjustment: 10000 }) })
    const note = await waitFor(() => {
      const found = document.querySelector('[data-note="starting"]') as HTMLElement | null
      expect(found).not.toBeNull()
      return found!
    })
    expect(note).toHaveTextContent(/reconciled to .*1,000\.00, not the statement’s starting .*900\.00/)
    expect(note).toHaveTextContent(/adds an adjustment of .*100\.00/)
  })

  it('shows a credit card\'s figures as amounts owed', async () => {
    const card = state()
    card.account = account({ type: 'creditCard' })
    card.summary = { ...card.summary, starting: -50000 }
    setup({ [ACCOUNTS_CHANNELS.reconcileState]: () => card })
    expect(await screen.findByText('Starting amount owed')).toBeInTheDocument()
    expect(figure('starting')).toHaveTextContent(/^\S*500\.00$/)
  })
})

describe('the register while reconciling', () => {
  const snapshot: RegisterSnapshot = {
    account: account(),
    rows: [metro, hydro, pay].map(transaction => ({ transaction, balance: 0, available: 0 })),
    balances: { current: 0, available: 0, cleared: 0, reconciled: 0, transactionCount: 3 }
  }
  const setup = (answers: Record<string, (data: any) => unknown> = {}) => {
    const b = bridge({
      [ACCOUNTS_CHANNELS.registerAccount]: () => ({ accountId: 'c' }),
      [ACCOUNTS_CHANNELS.chart]: () => ({ book: { name: 'Home' }, subBooks: [], totals: {}, accounts: [] }),
      [ACCOUNTS_CHANNELS.categories]: () => [],
      [ACCOUNTS_CHANNELS.loadRegister]: () => snapshot,
      [ACCOUNTS_CHANNELS.reconcileState]: () => state(),
      [ACCOUNTS_CHANNELS.reconcileActions]: () => [],
      [ACCOUNTS_CHANNELS.reconcileMark]: () => ({ ok: true, value: state() }),
      [ACCOUNTS_CHANNELS.patchTransaction]: () => ({ ok: true, value: hydro }),
      [ACCOUNTS_CHANNELS.setVoided]: () => ({ ok: true }),
      [ACCOUNTS_CHANNELS.saveTransaction]: () => ({ ok: true, value: tx({ id: 'fee' }) }),
      'shell:commands.execute': () => undefined,
      ...answers
    })
    render(<Register />)
    return b
  }
  const list = () => screen.findByRole('table', { name: 'Reconcile Chequing' })
  const line = (id: string) => document.querySelector(`[data-row="${id}"]`) as HTMLElement

  it('lists what the statement can include, the later-dated apart, with their marks', async () => {
    setup()
    const table = await list()
    const rows = within(table).getAllByRole('row').map(r => r.getAttribute('data-row') ?? r.getAttribute('data-group')).filter(Boolean)
    expect(rows).toEqual(['Up to the statement date', 'a', 'h', 'After the statement date', 'p'])
    expect(within(line('a')).getByRole('checkbox')).toBeChecked()
    expect(within(line('h')).getByRole('checkbox')).not.toBeChecked()
    // Only the statement's list: the normal register and its row actions step aside
    expect(screen.queryByRole('table', { name: 'Register of Chequing' })).toBeNull()
    expect(within(screen.getByRole('toolbar', { name: 'Register actions' })).queryByRole('button', { name: 'Void' })).toBeNull()
  })

  it('marks and unmarks by ticking, one at a time or a group at once', async () => {
    const { calls } = setup()
    await list()
    await userEvent.click(within(line('h')).getByRole('checkbox'))
    await userEvent.click(within(line('a')).getByRole('checkbox'))
    await userEvent.click(screen.getByRole('checkbox', { name: 'Mark every transaction up to the statement date' }))
    expect(calls(ACCOUNTS_CHANNELS.reconcileMark)).toEqual([
      { accountId: 'c', ids: ['h'], marked: true }, { accountId: 'c', ids: ['a'], marked: false }, { accountId: 'c', ids: ['h'], marked: true }
    ])
  })

  it('marks the selected transaction with Space', async () => {
    const { calls } = setup()
    const table = await list()
    await userEvent.click(line('h'))
    ;(table.closest('[tabindex="0"]') as HTMLElement).focus()
    await userEvent.keyboard(' ')
    expect(calls(ACCOUNTS_CHANNELS.reconcileMark)).toEqual([{ accountId: 'c', ids: ['h'], marked: true }])
  })

  it('corrects an amount in place, keeping its direction and checking its revision', async () => {
    const { calls } = setup()
    await list()
    await userEvent.click(within(line('h')).getByRole('button', { name: 'Correct the amount' }))
    const field = within(line('h')).getByRole('textbox', { name: 'Amount of Hydro' })
    expect(field).toHaveValue('80.00')
    await userEvent.clear(field)
    await userEvent.type(field, '82.15{Enter}')
    expect(calls(ACCOUNTS_CHANNELS.patchTransaction)).toEqual([
      { accountId: 'c', id: 'h', patch: { amount: -8215 }, expectedRev: 3, confirm: [] }
    ])
    await waitFor(() => expect(within(line('h')).queryByRole('textbox')).toBeNull())
  })

  it('keeps the amount field open on a mistake, and Escape leaves it unchanged', async () => {
    const { calls } = setup()
    await list()
    await userEvent.click(within(line('h')).getAllByRole('cell')[5])
    const field = within(line('h')).getByRole('textbox', { name: 'Amount of Hydro' })
    await userEvent.clear(field)
    await userEvent.type(field, 'abc{Enter}')
    expect(field).toHaveAttribute('aria-invalid', 'true')
    await userEvent.keyboard('{Escape}')
    expect(within(line('h')).queryByRole('textbox')).toBeNull()
    expect(calls(ACCOUNTS_CHANNELS.patchTransaction)).toEqual([])
  })

  it('voids a transaction that never happened', async () => {
    const { calls } = setup()
    await list()
    await userEvent.click(within(line('h')).getByRole('button', { name: 'Void' }))
    expect(calls(ACCOUNTS_CHANNELS.setVoided)).toEqual([{ accountId: 'c', ids: ['h'], voided: true, confirm: [] }])
  })

  it('shows why a mark failed', async () => {
    setup({ [ACCOUNTS_CHANNELS.reconcileMark]: () => ({ ok: false, error: { code: 'NOT_FOUND', message: 'That transaction no longer exists.' } }) })
    await list()
    await userEvent.click(within(line('h')).getByRole('checkbox'))
    expect(await screen.findByText('That transaction no longer exists.')).toBeInTheDocument()
  })

  it('keeps the entry row, for a fee the register is missing', async () => {
    const { calls } = setup()
    await list()
    const entry = document.querySelector('[data-editing="new"]') as HTMLElement
    await userEvent.type(within(entry).getByRole('combobox', { name: 'Payee' }), 'Bank')
    await userEvent.type(within(entry).getByRole('textbox', { name: 'Payment' }), '4{Enter}')
    expect(calls(ACCOUNTS_CHANNELS.saveTransaction)).toHaveLength(1)
  })

  it('goes back to the register when the reconciliation ends', async () => {
    const { emit } = setup()
    await list()
    act(() => emit(ACCOUNTS_EVENTS.reconcile, { accountId: 'c', state: null }))
    expect(await screen.findByRole('table', { name: 'Register of Chequing' })).toBeInTheDocument()
  })
})

describe('correcting an amount', () => {
  it('keeps the transaction\'s direction whatever sign is typed', () => {
    expect(correctedAmount(-8000, '82.15', 'CAD')).toEqual({ amount: -8215 })
    expect(correctedAmount(-8000, '-82.15', 'CAD')).toEqual({ amount: -8215 })
    expect(correctedAmount(5000, '(1)', 'CAD')).toEqual({ amount: 100 })
    expect(correctedAmount(5000, 'x', 'CAD').problem).toMatch(/number/)
  })
})
