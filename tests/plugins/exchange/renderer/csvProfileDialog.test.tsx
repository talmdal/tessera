// The CSV mapping dialog. Most of these tests are about the live preview, because the preview is the whole
// reason this dialog exists: a user cannot reason about `dateFormat: 'MDY'`, but they can see that the preview
// says 5 March when their statement says 3 May.
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { CsvProfile, QuestionDialogInput } from '@tessera/exchange-api'
import CsvProfileDialog, { previewOf } from '../../../../plugins/exchange/src/renderer/CsvProfileDialog'

const SUGGESTED: CsvProfile = {
  name: 'personal savings', delimiter: ',', quote: '"', skip: 1, header: true, encoding: 'utf-8',
  columns: { date: 'Date', payee: 'Description', debit: 'Debit', credit: 'Credit', balance: 'Balance' },
  dateFormat: 'DMY', decimal: '.'
}

const SAMPLE = [
  ['Date', 'Description', 'Debit', 'Credit', 'Balance'],
  ['03/05/2026', 'Month-end saving', '', '1441.43', '132811.51'],
  ['04/05/2026', 'Coffee', '4.50', '', '132807.01']
]

function setup(suggested: CsvProfile = SUGGESTED, sample = SAMPLE) {
  const close = vi.fn()
  const input: QuestionDialogInput = {
    question: {
      kind: 'csvProfile', id: 'exchange-csv.profile:abc12345', title: 'Match the columns',
      detail: 'Tessera needs to know what each column of savings.csv holds.',
      sample, suggested: suggested as never
    }
  }
  render(<CsvProfileDialog input={input} close={close} setBusy={() => {}} />)
  return { close }
}

/** The preview table's rows as [date, payee, amount]. */
const previewRows = () => {
  const table = screen.getByRole('table', { name: 'Preview' })
  return within(table).getAllByRole('row').slice(1)
    .map(row => within(row).getAllByRole('cell').map(cell => cell.textContent))
}

describe('the dialog', () => {
  it('starts from the suggested mapping, with each column’s drop-down already set', () => {
    setup()
    expect(screen.getByLabelText('What column 1 holds')).toHaveTextContent('Date')
    expect(screen.getByLabelText('What column 3 holds')).toHaveTextContent('Debit / money out')
    expect(screen.getByLabelText('What column 5 holds')).toHaveTextContent('Balance')
  })

  it('shows the file’s own rows above the preview, so the two can be compared', () => {
    setup()
    const grid = screen.getByRole('table', { name: 'File columns' })
    expect(within(grid).getByText('Month-end saving')).toBeInTheDocument()
    expect(within(grid).getByText('1441.43')).toBeInTheDocument()
  })

  it('closes with the profile it has built, or with nothing on Cancel', async () => {
    const { close } = setup()
    await userEvent.click(screen.getByRole('button', { name: 'OK' }))
    expect(close).toHaveBeenCalledWith(expect.objectContaining({
      name: 'personal savings',
      dateFormat: 'DMY',
      columns: expect.objectContaining({ date: 'Date', debit: 'Debit', credit: 'Credit' })
    }))

    const other = setup()
    await userEvent.click(screen.getAllByRole('button', { name: 'Cancel' }).at(-1)!)
    expect(other.close).toHaveBeenCalledWith()
  })
})

describe('the live preview', () => {
  it('reads the rows as the import would: a credit positive and a debit negative', () => {
    setup()
    expect(previewRows()).toEqual([
      ['2026-05-03', 'Month-end saving', '1,441.43'],
      ['2026-05-04', 'Coffee', '-4.50']
    ])
  })

  it('changes the dates the moment the date order changes, which is how a user catches a wrong one', async () => {
    setup()
    expect(previewRows()[0][0]).toBe('2026-05-03')

    await userEvent.click(screen.getByLabelText('Dates'))
    await userEvent.click(screen.getByRole('option', { name: /Month first/ }))

    // The same text, read the other way round, is a different day — and the preview says so.
    expect(previewRows()[0][0]).toBe('2026-03-05')
  })

  it('follows a column being remapped', async () => {
    setup()
    expect(previewRows()[0][1]).toBe('Month-end saving')

    await userEvent.click(screen.getByLabelText('What column 2 holds'))
    await userEvent.click(screen.getByRole('option', { name: 'Memo' }))

    // The payee has no column now, so the preview shows none rather than the old one.
    expect(previewRows()[0][1]).toBe('')
  })

  it('says plainly when a cell is not a date or not an amount, rather than showing a wrong figure', () => {
    setup({ ...SUGGESTED, columns: { ...SUGGESTED.columns, date: 'Description' } })
    expect(previewRows()[0][0]).toBe('Not a date')
  })
})

describe('what the dialog will not accept', () => {
  it('refuses a mapping with no date column, and says what is missing', async () => {
    setup({ ...SUGGESTED, columns: { date: 'Date', amount: 'Balance' } })
    await userEvent.click(screen.getByLabelText('What column 1 holds'))
    await userEvent.click(screen.getByRole('option', { name: 'Ignore' }))

    expect(screen.getByRole('button', { name: 'OK' })).toBeDisabled()
    expect(screen.getByText(/which column holds the date/i)).toBeInTheDocument()
  })

  it('refuses both a signed amount and a debit/credit pair, which would double-count every row', async () => {
    setup()
    await userEvent.click(screen.getByLabelText('What column 5 holds'))
    await userEvent.click(screen.getByRole('option', { name: 'Amount (signed)' }))

    expect(screen.getByRole('button', { name: 'OK' })).toBeDisabled()
    expect(screen.getByText(/either one amount column or a debit and credit pair/i)).toBeInTheDocument()
  })

  it('takes a field off the column that held it, so two columns cannot both be the date', async () => {
    setup()
    await userEvent.click(screen.getByLabelText('What column 2 holds'))
    await userEvent.click(screen.getByRole('option', { name: 'Date' }))

    expect(screen.getByLabelText('What column 1 holds')).toHaveTextContent('Ignore')
    expect(screen.getByLabelText('What column 2 holds')).toHaveTextContent('Date')
  })
})

describe('a file whose bank supplies a reference', () => {
  it('says that duplicates will be exact rather than guessed at', async () => {
    setup()
    expect(screen.queryByText(/tell a repeated import apart exactly/i)).not.toBeInTheDocument()

    await userEvent.click(screen.getByLabelText('What column 5 holds'))
    await userEvent.click(screen.getByRole('option', { name: 'Reference ID' }))

    expect(screen.getByText(/tell a repeated import apart exactly/i)).toBeInTheDocument()
  })
})

describe('previewOf', () => {
  const header = ['Date', 'Description', 'Amount']
  const rows = [['2026-10-15', 'Coffee', '-4.50'], ['2026-10-16', 'Books', '-9.99']]
  const profile: CsvProfile = {
    name: 'x', delimiter: ',', quote: '"', skip: 0, header: true, encoding: 'utf-8',
    columns: { date: 'Date', payee: 'Description', amount: 'Amount' }, dateFormat: 'ISO', decimal: '.'
  }

  it('shows at most the first three rows, which is enough to see an error', () => {
    const many = Array.from({ length: 10 }, (_, at) => [`2026-10-${at + 10}`, 'A', '-1.00'])
    expect(previewOf(many, header, profile)).toHaveLength(3)
  })

  it('skips the rows the profile skips, so a Total line does not become the preview', () => {
    const withTotal = [['Closing balance', '', '100.00'], ...rows]
    const previewed = previewOf(withTotal, header, { ...profile, skipRows: 'Closing' })
    expect(previewed[0]).toEqual({ date: '2026-10-15', payee: 'Coffee', amount: -450 })
  })

  it('flips the sign when money out is written as a positive number', () => {
    expect(previewOf(rows, header, { ...profile, debitsArePositive: true })[0].amount).toBe(450)
  })
})
