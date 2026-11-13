import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Account, Category, Chart } from '@tessera/accounts-api'
import {
  RECURRING_CHANNELS, type EnterDialogInput, type EnterRequest, type RecurringRow, type Series, type SeriesDialogInput
} from '@tessera/recurring-api'
import EnterDialog from '../../../../plugins/recurring/src/renderer/EnterDialog'
import SeriesDialog from '../../../../plugins/recurring/src/renderer/SeriesDialog'
import { createFakeRemote } from '../../../helpers/fakeBridge'

const account = (over: Partial<Account> = {}): Account => ({
  id: 'c', rev: 1, name: 'Chequing', type: 'chequing', subBookId: null, currency: 'CAD',
  openingDate: '2026-01-01', openingBalance: 0, order: 0, closed: false, ...over
})
const visa = account({ id: 'v', name: 'Visa', type: 'creditCard', order: 1 })

const series = (over: Partial<Series> = {}): Series => ({
  id: 's1', rev: 3, accountId: 'c', name: 'Hydro',
  template: { amount: -14200, payee: 'Hydro', autoNumber: false, estimated: false },
  schedule: { frequency: 'monthly', interval: 1, startDate: '2026-11-15' },
  remindDays: 3, autoEnter: false, paused: false, nextIndex: 0, nextDate: '2026-11-15',
  enteredCount: 0, skippedCount: 0, createdAt: '', updatedAt: '', ...over
})

const row = (over: Partial<RecurringRow> = {}, seriesOver: Partial<Series> = {}): RecurringRow => ({
  series: series(seriesOver),
  kind: 'payment',
  occurrence: { index: 0, date: '2026-11-15' },
  dueCount: 1,
  account: { id: 'c', name: 'Chequing', type: 'chequing', currency: 'CAD', closed: false },
  payeeName: 'Hydro',
  categoryLabel: 'Utilities : Electricity',
  scheduleLabel: 'Monthly on the 15th',
  ...over
})

const CATEGORIES: Category[] = [
  { id: 'util', parentId: null, name: 'Utilities', kind: 'expense', rev: 1 },
  { id: 'elec', parentId: 'util', name: 'Electricity', kind: 'expense', rev: 1 },
  { id: 'salary', parentId: null, name: 'Salary', kind: 'income', rev: 1 }
]

const CHART: Chart = {
  book: { name: 'Home' },
  subBooks: [],
  accounts: [account(), visa].map(a => ({
    account: a,
    balances: { current: 0, available: 0, cleared: 0, reconciled: 0, transactionCount: 0 }
  })),
  totals: {}
}

function bridge(answers: Record<string, (data: any) => unknown> = {}) {
  const remote = createFakeRemote({})
  remote.bridge.invoke.mockImplementation(async (channel: string, data?: any) => answers[channel]?.(data))
  ;(window as any).api = remote.bridge
  const calls = (channel: string) => remote.bridge.invoke.mock.calls.filter((c: unknown[]) => c[0] === channel).map((c: unknown[]) => c[1])
  return { ...remote, calls }
}

afterEach(() => { delete (window as any).api })

describe('the enter dialog', () => {
  const input = (rows: RecurringRow[], requests?: Partial<EnterRequest>[]): EnterDialogInput => ({
    rows: rows.map((r, i) => ({
      row: r,
      request: { seriesId: r.series.id, amount: r.series.template.amount, date: r.occurrence!.date, ...requests?.[i] }
    })),
    accounts: [account(), visa]
  })

  const show = (dialogInput: EnterDialogInput) => {
    const close = vi.fn()
    render(<EnterDialog input={dialogInput} close={close} />)
    return { close }
  }

  it('shows what is about to be written, with the amount ready to change', async () => {
    const { close } = show(input([row()]))
    // The occurrence's date, not today's
    expect(screen.getByLabelText('Date for Hydro')).toHaveValue('2026-11-15')
    // Unsigned, under the column its account calls it
    const amount = screen.getByLabelText('Amount for Hydro')
    expect(amount).toHaveValue('142.00')
    // The label the account's own type gives the column it sits in
    expect(screen.getAllByText('Payment').length).toBeGreaterThan(0)

    await userEvent.clear(amount)
    await userEvent.type(amount, '150.75')
    await userEvent.click(screen.getByRole('button', { name: 'Enter in Register' }))
    expect(close).toHaveBeenCalledWith([{ seriesId: 's1', amount: -15075, date: '2026-11-15' }])
  })

  it('keeps each row’s own amount when several go in at once', async () => {
    const { close } = show(input([
      row({}, { id: 's1', name: 'Hydro' }),
      row({ account: { id: 'v', name: 'Visa', type: 'creditCard', currency: 'CAD', closed: false } },
        { id: 's2', name: 'Phone', template: { amount: -8000, payee: 'Telco', autoNumber: false, estimated: false } })
    ]))
    await userEvent.clear(screen.getByLabelText('Amount for Phone'))
    await userEvent.type(screen.getByLabelText('Amount for Phone'), '81.50')

    await userEvent.click(screen.getByRole('button', { name: 'Enter 2 in Registers' }))
    expect(close).toHaveBeenCalledWith([
      { seriesId: 's1', amount: -14200, date: '2026-11-15' },
      { seriesId: 's2', amount: -8150, date: '2026-11-15' }
    ])
  })

  it('labels a credit card’s columns its own way', () => {
    show(input([row({ account: { id: 'v', name: 'Visa', type: 'creditCard', currency: 'CAD', closed: false } })]))
    // A negative amount on a credit card is a Charge, not a Payment
    expect(screen.getAllByText('Charge').length).toBeGreaterThan(0)
  })

  it('offers to keep a new estimate, and only for a series whose amount varies', async () => {
    const { close } = show(input([row({}, { template: { amount: -14200, payee: 'Hydro', autoNumber: false, estimated: true } })]))
    expect(screen.getByText(/varies/)).toBeTruthy()
    await userEvent.click(screen.getByRole('checkbox', { name: /Use as the new estimate/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Enter in Register' }))
    expect(close).toHaveBeenCalledWith([expect.objectContaining({ updateEstimate: true })])
  })

  it('refuses an amount it can’t read, and keeps the dialog open', async () => {
    const { close } = show(input([row()]))
    await userEvent.clear(screen.getByLabelText('Amount for Hydro'))
    await userEvent.type(screen.getByLabelText('Amount for Hydro'), 'lots')
    await userEvent.click(screen.getByRole('button', { name: 'Enter in Register' }))
    expect(close).not.toHaveBeenCalled()
    expect(await screen.findByText(/Enter a number/)).toBeTruthy()
  })

  it('closes with nothing when cancelled', async () => {
    const { close } = show(input([row()]))
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(close).toHaveBeenCalledWith(undefined)
  })
})

describe('the series dialog', () => {
  const show = (over: Partial<SeriesDialogInput> = {}) => {
    const close = vi.fn()
    const input = { chart: CHART, categories: CATEGORIES, today: '2026-11-13', mode: 'create', ...over } as SeriesDialogInput
    render(<SeriesDialog input={input} close={close} />)
    return { close }
  }

  it('creates one from an empty form, saving through the plugin', async () => {
    const b = bridge({ [RECURRING_CHANNELS.saveSeries]: () => ({ ok: true, value: series({ id: 'new' }) }) })
    const { close } = show()

    await userEvent.type(screen.getByLabelText('Payee'), 'Hydro')
    await userEvent.type(screen.getByLabelText('Amount'), '142.00')
    await userEvent.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() => expect(close).toHaveBeenCalledWith({ id: 'new' }))
    expect(b.calls(RECURRING_CHANNELS.saveSeries)[0]).toEqual({
      input: {
        accountId: 'c',
        template: { amount: -14200, autoNumber: false, estimated: false, payee: 'Hydro' },
        schedule: { frequency: 'monthly', interval: 1, startDate: '2026-11-13' },
        remindDays: 3
      }
    })
  })

  it('starts from the series it is editing, and saves against its revision', async () => {
    const b = bridge({ [RECURRING_CHANNELS.saveSeries]: () => ({ ok: true, value: series() }) })
    show({ mode: 'edit', series: series({ notes: 'Account 55-1' }) } as Partial<SeriesDialogInput>)

    expect(screen.getByLabelText('Name')).toHaveValue('Hydro')
    expect(screen.getByLabelText('Amount')).toHaveValue('142.00')
    expect(screen.getByLabelText('Notes')).toHaveValue('Account 55-1')

    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(b.calls(RECURRING_CHANNELS.saveSeries)[0]).toMatchObject({ id: 's1', expectedRev: 3 }))
  })

  it('shows the schedule in words, with the next few dates, as it is changed', async () => {
    show()
    const preview = () => document.querySelector('[data-preview="schedule"]')!
    expect(preview()).toHaveTextContent('Monthly on the 13th')
    expect(preview()).toHaveTextContent(/Next:/)

    await userEvent.click(screen.getByLabelText('How often'))
    await userEvent.click(await screen.findByRole('option', { name: 'Every two weeks' }))
    await waitFor(() => expect(preview()).toHaveTextContent('Every two weeks on Friday'))
  })

  it('offers the extra controls a monthly rule needs, and drops them when they mean nothing', async () => {
    show()
    await userEvent.click(screen.getByLabelText('On'))
    await userEvent.click(await screen.findByRole('option', { name: 'a weekday' }))
    await userEvent.click(screen.getByLabelText('Week'))
    await userEvent.click(await screen.findByRole('option', { name: 'second' }))
    await waitFor(() => expect(document.querySelector('[data-preview="schedule"]')).toHaveTextContent('Monthly on the second Monday'))

    // Switching to weekly drops the rule rather than keeping one the service would refuse
    await userEvent.click(screen.getByLabelText('How often'))
    await userEvent.click(await screen.findByRole('option', { name: 'Weekly' }))
    await waitFor(() => expect(document.querySelector('[data-preview="schedule"]')).toHaveTextContent('Weekly on Friday'))
    expect(screen.queryByLabelText('Week')).toBeNull()
  })

  it('lets a transfer stand in for a category', async () => {
    const b = bridge({ [RECURRING_CHANNELS.saveSeries]: () => ({ ok: true, value: series() }) })
    show()
    await userEvent.type(screen.getByLabelText('Amount'), '500.00')
    await userEvent.click(screen.getByLabelText('Category or transfer'))
    await userEvent.click(await screen.findByRole('option', { name: 'Transfer to: Visa' }))
    await userEvent.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() => expect(b.calls(RECURRING_CHANNELS.saveSeries)[0].input.template)
      .toEqual({ amount: -50000, autoNumber: false, estimated: false, transferAccountId: 'v' }))
  })

  it('shows the plugin’s reason on the field it names, and stays open', async () => {
    const b = bridge({
      [RECURRING_CHANNELS.saveSeries]: () => ({ ok: false, error: { code: 'ACCOUNT_CLOSED', message: '“Chequing” is closed.', field: 'accountId' } })
    })
    const { close } = show()
    await userEvent.type(screen.getByLabelText('Amount'), '10.00')
    await userEvent.click(screen.getByRole('button', { name: 'Create' }))

    expect(await screen.findByText('“Chequing” is closed.')).toBeTruthy()
    expect(close).not.toHaveBeenCalled()
    expect(b.calls(RECURRING_CHANNELS.saveSeries)).toHaveLength(1)
  })

  it('checks what it can before asking the plugin', async () => {
    const b = bridge({ [RECURRING_CHANNELS.saveSeries]: () => ({ ok: true, value: series() }) })
    show()
    await userEvent.click(screen.getByRole('button', { name: 'Create' }))
    expect(await screen.findByText('Enter an amount.')).toBeTruthy()
    expect(b.calls(RECURRING_CHANNELS.saveSeries)).toHaveLength(0)

    // Unless the amount varies, when a blank one is an estimate nobody has made yet
    await userEvent.click(screen.getByRole('checkbox', { name: /The amount varies/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(b.calls(RECURRING_CHANNELS.saveSeries)).toHaveLength(1))
    expect(b.calls(RECURRING_CHANNELS.saveSeries)[0].input.template).toMatchObject({ amount: 0, estimated: true })
  })

  it('starts from a register\'s transaction, saving through the path that records it', async () => {
    const b = bridge({ [RECURRING_CHANNELS.createFromTransaction]: () => ({ ok: true, value: series({ id: 'made' }) }) })
    const { close } = show({
      mode: 'fromTransaction', accountId: 'c', transactionId: 't1', sourceDate: '2026-11-01',
      template: { amount: -120000, payee: 'Landlord', autoNumber: false, estimated: false },
      schedule: { frequency: 'monthly', interval: 1, startDate: '2026-11-01' }
    } as Partial<SeriesDialogInput>)

    // Prefilled from the transaction, and it says what will happen to the one already in the register
    expect(screen.getByLabelText('Payee')).toHaveValue('Landlord')
    expect(screen.getByLabelText('Amount')).toHaveValue('1200.00')
    expect(screen.getByText(/stays in the register as it is/)).toBeTruthy()

    // The preview starts *after* the transaction, which has already been paid
    const preview = document.querySelector('[data-preview="schedule"]')!
    expect(preview).toHaveTextContent('Monthly on the 1st')
    expect(preview).not.toHaveTextContent('1 Nov 2026')

    await userEvent.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(close).toHaveBeenCalledWith({ id: 'made' }))
    expect(b.calls(RECURRING_CHANNELS.saveSeries)).toHaveLength(0)
    expect(b.calls(RECURRING_CHANNELS.createFromTransaction)[0]).toEqual({
      input: {
        accountId: 'c',
        template: { amount: -120000, autoNumber: false, estimated: false, payee: 'Landlord' },
        schedule: { frequency: 'monthly', interval: 1, startDate: '2026-11-01' },
        remindDays: 3
      },
      source: { accountId: 'c', transactionId: 't1' }
    })
  })

  it('keeps an edit made before confirming a transaction\'s series', async () => {
    const b = bridge({ [RECURRING_CHANNELS.createFromTransaction]: () => ({ ok: true, value: series() }) })
    show({
      mode: 'fromTransaction', accountId: 'c', transactionId: 't1', sourceDate: '2026-11-01',
      template: { amount: -120000, payee: 'Landlord', autoNumber: false, estimated: false },
      schedule: { frequency: 'monthly', interval: 1, startDate: '2026-11-01' }
    } as Partial<SeriesDialogInput>)

    await userEvent.clear(screen.getByLabelText('Amount'))
    await userEvent.type(screen.getByLabelText('Amount'), '1250.00')
    await userEvent.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() => expect(b.calls(RECURRING_CHANNELS.createFromTransaction)[0].input.template.amount).toBe(-125000))
  })

  it('says so when there is nowhere to put a recurring transaction', () => {
    show({ chart: { ...CHART, accounts: [] } })
    expect(screen.getByText(/Add an account first/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Create' })).toBeNull()
  })
})
