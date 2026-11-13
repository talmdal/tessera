// The Export dialog (docs/export-design.md, "The Export dialog"): two tabs, What to export and File options, with what
// the file would hold always below them; it starts on the account the user is looking at, chosen in a list that opens
// over the dialog; each format's options are drawn from their declaration; the preview is asked again as things
// change, shows problems (which block Export…) and warnings; a format holding one account gets one; and the dialog
// closes with the request.
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import {
  EXPORT_CHANNELS,
  type CheckResponse, type ExportDialogInput, type ExportFormatInfo, type ExportRequest
} from '@tessera/export-api'
import ExportDialog from '../../../../plugins/export/src/renderer/ExportDialog'
import { CSV_EXPORT } from '../../../../plugins/format-csv/src/privileged/export'
import { createFakeRemote } from '../../../helpers/fakeBridge'

const CSV: ExportFormatInfo = {
  id: CSV_EXPORT.id, label: CSV_EXPORT.label, extension: 'csv', description: CSV_EXPORT.description, accounts: 'many', options: CSV_EXPORT.options!,
  accountFields: []
}
/** A format holding one bank account, with no options, writing the account's number, and a chequing account's bank number. */
const STATEMENT: ExportFormatInfo = {
  id: 'fmt.ofx', label: 'OFX statement', extension: 'ofx', accounts: 'one', accountTypes: ['chequing', 'savings'], options: [],
  accountFields: [{ field: 'accountNumber', need: 'required' }, { field: 'bankId', need: 'required', accountTypes: ['chequing'] }]
}

function input(over: Partial<ExportDialogInput> = {}): ExportDialogInput {
  return {
    ledgerName: 'Home', formats: [CSV, STATEMENT], formatId: CSV.id,
    accounts: [
      { id: 'sav', name: 'Savings', type: 'savings', typeLabel: 'Savings', currency: 'CAD', closed: false, location: 'Family' },
      { id: 'chq', name: 'Chequing', type: 'chequing', typeLabel: 'Chequing', currency: 'CAD', closed: false, location: '', accountNumber: '12-345678', bankId: '004' },
      { id: 'visa', name: 'Visa', type: 'creditCard', typeLabel: 'Credit card', currency: 'CAD', closed: false, location: '' }
    ],
    preselectedId: 'chq',
    options: {
      [CSV.id]: { amounts: 'signed', dates: 'iso', decimal: '.', encoding: 'utf-8', includeVoided: false, formulaGuard: true },
      [STATEMENT.id]: {}
    },
    range: { choice: 'lastMonth' },
    today: '2026-11-12',
    ...over
  }
}

const answer = (over: Partial<CheckResponse> = {}): CheckResponse => ({
  transactions: 5, accounts: 1, range: { from: '2026-10-01', to: '2026-10-31' }, archived: [], problems: [],
  warnings: ['1 voided transaction is left out.'], ...over
})

/** The dialog, with the plugin's side answering each check with `respond` and recording what it was asked. */
function setup(respond: (request: ExportRequest) => unknown = () => ({ ok: true, value: answer() }), over: Partial<ExportDialogInput> = {}) {
  const remote = createFakeRemote({})
  const requests: ExportRequest[] = []
  remote.bridge.invoke.mockImplementation(async (channel: string, request: ExportRequest) => {
    if (channel !== EXPORT_CHANNELS.check) throw new Error(`No answer for ${channel}`)
    requests.push(request)
    return respond(request)
  })
  ;(window as any).api = remote.bridge
  const close = vi.fn()
  render(<ExportDialog input={input(over)} close={close} setBusy={vi.fn()} />)
  return { close, requests, last: () => requests[requests.length - 1] }
}
const exportButton = () => screen.getByRole('button', { name: 'Export…' })
const accountsField = () => screen.getByRole('combobox', { name: 'Accounts' })
const optionsTab = () => userEvent.click(screen.getByRole('tab', { name: 'File options' }))
/** Clicks accounts in the list over the dialog, then closes it. */
async function chooseAccounts(...names: (string | RegExp)[]) {
  await userEvent.click(accountsField())
  const list = screen.getByRole('listbox')
  for (const name of names) await userEvent.click(within(list).getByRole('option', { name }))
  await userEvent.keyboard('{Escape}')
}

describe('the Export dialog', () => {
  it('starts on the account the user is looking at, and says what the file will hold', async () => {
    const { close, last } = setup()
    expect(await screen.findByText('Will export 5 transactions from 1 account, Oct 1, 2026 to Oct 31, 2026.')).toBeInTheDocument()
    expect(last()).toEqual({
      formatId: CSV.id, accountIds: ['chq'], range: { from: '2026-10-01', to: '2026-10-31' },
      options: { amounts: 'signed', dates: 'iso', decimal: '.', encoding: 'utf-8', includeVoided: false, formulaGuard: true }
    })
    expect(screen.getByRole('tab', { name: 'What to export' })).toHaveAttribute('aria-selected', 'true')
    expect(accountsField()).toHaveTextContent('Chequing')
    expect(screen.getByText('1 voided transaction is left out.')).toBeInTheDocument()

    await userEvent.click(exportButton())
    expect(close).toHaveBeenCalledWith({
      formatId: CSV.id, accountIds: ['chq'], range: { from: '2026-10-01', to: '2026-10-31' },
      options: expect.objectContaining({ amounts: 'signed' }), rangeState: { choice: 'lastMonth' }
    })
  })

  it('draws the format’s options on their own tab, and asks again as they change, the preview staying in view', async () => {
    const { last } = setup()
    await screen.findByText(/Will export 5 transactions/)
    // Until the tab is shown, its options are out of reach
    expect(screen.queryByRole('combobox', { name: 'Amounts' })).toBeNull()
    await optionsTab()
    // Each choice a list, showing what is chosen, with its description under it
    expect(screen.getByRole('combobox', { name: 'Amounts' })).toHaveTextContent('One column, money out negative')
    expect(screen.getByRole('combobox', { name: 'Date format' })).toHaveTextContent('Year-month-day (2026-10-05)')
    expect(screen.getByText('Read as a date by every spreadsheet, whatever its language.')).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'Protect against spreadsheet formulas' })).toBeChecked()

    await userEvent.click(screen.getByRole('combobox', { name: 'Amounts' }))
    expect(screen.getAllByRole('option').map(o => o.textContent)).toEqual(['One column, money out negative', 'Money out and Money in columns'])
    await userEvent.click(screen.getByRole('option', { name: 'Money out and Money in columns' }))
    await waitFor(() => expect(last().options.amounts).toBe('outIn'))
    // A choice's own description replaces the field's when it has one
    await userEvent.click(screen.getByRole('combobox', { name: 'Decimal separator' }))
    await userEvent.click(screen.getByRole('option', { name: 'Comma (1234,56)' }))
    expect(await screen.findByText(/Cells are then separated by semicolons/)).toBeInTheDocument()
    await waitFor(() => expect(last().options.decimal).toBe(','))
    await userEvent.click(screen.getByRole('checkbox', { name: 'Include voided transactions' }))
    await waitFor(() => expect(last().options.includeVoided).toBe(true))
    // The preview is below the tabs, so it is there on this one too
    expect(screen.getByText(/Will export 5 transactions/)).toBeVisible()
    expect(screen.getByRole('tab', { name: 'What to export' })).toHaveAttribute('aria-selected', 'false')
  })

  it('keeps both tabs’ panels in the dialog, so changing tab doesn’t change its height', async () => {
    setup()
    await screen.findByText(/Will export/)
    const panels = document.querySelectorAll('[role="tabpanel"]')
    expect(panels).toHaveLength(2)
    expect(panels[0].parentElement).toBe(panels[1].parentElement)
    expect([...panels].map(p => p.getAttribute('aria-hidden'))).toEqual(['false', 'true'])
    await optionsTab()
    expect([...document.querySelectorAll('[role="tabpanel"]')].map(p => p.getAttribute('aria-hidden'))).toEqual(['true', 'false'])
  })

  it('chooses the accounts in a list that opens over the dialog, with All accounts first', async () => {
    const { last } = setup()
    await screen.findByText(/Will export 5 transactions/)
    await userEvent.click(accountsField())
    const list = screen.getByRole('listbox')
    expect(within(list).getAllByRole('option').map(o => o.textContent)).toEqual([
      'All accounts', 'SavingsFamily · Savings · CAD', 'ChequingChequing · CAD', 'VisaCredit card · CAD'
    ])
    // The list is over the dialog (in a layer of its own), not inside it
    expect(list.closest('form')).toBeNull()
    await userEvent.click(within(list).getByRole('option', { name: 'All accounts' }))
    await waitFor(() => expect(last().accountIds).toEqual(['sav', 'chq', 'visa']))
    await userEvent.click(within(list).getByRole('option', { name: /^Visa/ }))
    await waitFor(() => expect(last().accountIds).toEqual(['sav', 'chq']))
    await userEvent.keyboard('{Escape}')
    expect(accountsField()).toHaveTextContent('2 accounts: Savings, Chequing')

    // All of them, then none: the export can't go ahead
    await chooseAccounts(/^Visa/)
    expect(accountsField()).toHaveTextContent('All accounts (3)')
    await chooseAccounts('All accounts')
    expect(accountsField()).toHaveTextContent('None chosen')
    expect(await screen.findByText('Choose at least one account to export.')).toBeInTheDocument()
    expect(exportButton()).toBeDisabled()
  })

  it('lines the dates up: the Dates list, From and To are the same row’s own fields', async () => {
    setup()
    await screen.findByText(/Will export/)
    const fieldOf = (element: HTMLElement) => element.closest('.MuiFormControl-root')!
    const dates = fieldOf(screen.getByRole('combobox', { name: 'Dates' }))
    const from = fieldOf(screen.getByLabelText('From'))
    const to = fieldOf(screen.getByLabelText('To'))
    expect(from.parentElement).toBe(dates.parentElement)
    expect(to.parentElement).toBe(dates.parentElement)
  })

  it('shows the dates All dates works out to, and makes a typed date a custom range', async () => {
    const { last } = setup(() => ({ ok: true, value: answer({ range: { from: '2026-01-01', to: '2026-11-12' } }) }), { range: { choice: 'all' } })
    await screen.findByText(/Will export/)
    expect(last().range).toEqual({})
    expect(screen.getByLabelText('From')).toHaveValue('2026-01-01')
    expect(screen.getByLabelText('To')).toHaveValue('2026-11-12')

    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-10-15' } })
    await waitFor(() => expect(last().range).toEqual({ from: '2026-10-15' }))
    expect(screen.getByRole('combobox', { name: 'Dates' })).toHaveTextContent('Custom')
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-10-01' } })
    expect(await screen.findByText('The start date is after the end date.')).toBeInTheDocument()
    expect(exportButton()).toBeDisabled()
  })

  it('shows the problems, which keep Export… from going ahead, and a check that failed', async () => {
    let reply: unknown = { ok: true, value: answer({ transactions: 0, problems: ['There are no transactions to export in “Chequing” for these dates.'], warnings: [] }) }
    setup(() => reply)
    expect(await screen.findByText('There are no transactions to export in “Chequing” for these dates.')).toBeInTheDocument()
    expect(exportButton()).toBeDisabled()
    reply = { ok: false, error: { code: 'NOT_FOUND', message: 'An account chosen to export no longer exists. Choose the accounts again.' } }
    await chooseAccounts('All accounts')
    expect(await screen.findByText('An account chosen to export no longer exists. Choose the accounts again.')).toBeInTheDocument()
    expect(exportButton()).toBeDisabled()
  })

  it('says in one note which accounts’ earlier history is in an archive file, however many', async () => {
    setup(() => ({ ok: true, value: answer({ archived: ['Chequing', 'Savings', 'Visa'].map(account => ({ account, from: '2026-11-01' })) }) }))
    expect(await screen.findByText('“Chequing”, “Savings” and “Visa” start on Nov 1, 2026: their earlier transactions are in an archive file.')).toBeInTheDocument()
    expect(screen.getAllByRole('alert').filter(a => /archive file/.test(a.textContent ?? ''))).toHaveLength(1)
  })

  it('offers one account for a format that holds one, those it can’t hold disabled, and no options tab when it has none', async () => {
    const { last } = setup(undefined, { formatId: STATEMENT.id, preselectedId: 'visa' })
    // The card can't go in this format: the first account it can hold is offered instead
    await waitFor(() => expect(last()).toMatchObject({ formatId: STATEMENT.id, accountIds: ['sav'], options: {} }))
    expect(screen.getByText('This file type holds one account per file.')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'File options' })).toBeDisabled()
    await userEvent.click(screen.getByRole('combobox', { name: 'Account' }))
    const options = screen.getAllByRole('option')
    expect(options.map(o => o.textContent)).toEqual(['Savings', 'Chequing', 'Visa (credit card: not possible in this file type)'])
    expect(options[2]).toHaveAttribute('aria-disabled', 'true')
    await userEvent.click(options[1])
    await waitFor(() => expect(last().accountIds).toEqual(['chq']))
    // Back to CSV, with its own options as they were, and its tab
    await userEvent.click(screen.getByRole('combobox', { name: 'Format' }))
    await userEvent.click(screen.getByRole('option', { name: CSV.label }))
    await waitFor(() => expect(last()).toMatchObject({ formatId: CSV.id, accountIds: ['visa'], options: { amounts: 'signed' } }))
    expect(screen.getByRole('tab', { name: 'File options' })).toBeEnabled()
  })

  it('shows the account fields a format writes, from the account, and sends what is typed for this export only', async () => {
    const { last, close } = setup(undefined, { formatId: STATEMENT.id, preselectedId: 'chq' })
    await screen.findByText(/Will export/)
    const details = screen.getByRole('region', { name: 'Account details for this file' })
    expect(within(details).getByRole('textbox', { name: 'Account number' })).toHaveValue('12-345678')
    expect(within(details).getByRole('textbox', { name: 'Bank number' })).toHaveValue('004')
    expect(within(details).getByRole('textbox', { name: 'Bank number' })).toBeRequired()
    expect(within(details).getByText(/used for this export only: to keep a change, make it in Accounts › Edit Account…/)).toBeInTheDocument()
    expect(last().accountValues).toBeUndefined()

    await userEvent.clear(within(details).getByRole('textbox', { name: 'Bank number' }))
    await userEvent.type(within(details).getByRole('textbox', { name: 'Bank number' }), '999')
    await waitFor(() => expect(last().accountValues).toEqual({ chq: { bankId: '999' } }))
    await userEvent.click(exportButton())
    expect(close).toHaveBeenCalledWith(expect.objectContaining({ accountIds: ['chq'], accountValues: { chq: { bankId: '999' } } }))
  })

  it('shows only the fields a format writes for that kind of account, and none for a format that writes none', async () => {
    setup(undefined, { formatId: STATEMENT.id, preselectedId: 'sav' })
    await screen.findByText(/Will export/)
    const details = screen.getByRole('region', { name: 'Account details for this file' })
    // Savings: its account number only (this format writes a bank number for chequing accounts)
    expect(within(details).getAllByRole('textbox')).toHaveLength(1)
    expect(within(details).getByRole('textbox', { name: /^Account number/ })).toBeRequired()
    expect(within(details).queryByRole('textbox', { name: /^Bank number/ })).toBeNull()
    await userEvent.click(screen.getByRole('combobox', { name: 'Format' }))
    await userEvent.click(screen.getByRole('option', { name: CSV.label }))
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Account details for this file' })).toBeNull())
  })

  it('closes with nothing on Cancel', async () => {
    const { close } = setup()
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(close).toHaveBeenCalledWith()
  })
})
