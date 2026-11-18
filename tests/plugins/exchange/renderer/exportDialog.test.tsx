// The export dialog: what to write, over what period, in what format, and what to leave out — and the two
// things it refuses, which are a range that runs backwards and more accounts than the format can hold.
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { ExportDialogInput } from '@tessera/exchange-api'
import ExportDialog, { rangeOf } from '../../../../plugins/exchange/src/renderer/ExportDialog'

const INPUT: ExportDialogInput = {
  formats: [
    {
      id: 'exchange-qif.qif', label: 'Quicken Interchange Format (*.qif)', extensions: ['qif'], multiAccount: true,
      fields: [{
        kind: 'choice', key: 'flavour', label: 'QIF flavour',
        options: [{ value: 'microsoft', label: 'Microsoft Money' }, { value: 'standard', label: 'Quicken (standard)' }],
        default: 'microsoft'
      }]
    },
    {
      id: 'exchange-csv.csv', label: 'Comma-Separated Values (*.csv)', extensions: ['csv'], multiAccount: true,
      fields: [
        {
          kind: 'choice', key: 'delimiter', label: 'Separator',
          options: [{ value: ',', label: 'Comma' }, { value: ';', label: 'Semicolon' }],
          default: ','
        },
        { kind: 'boolean', key: 'bom', label: 'Add a byte-order mark', default: true }
      ]
    },
    // A format that asks nothing of its own, which is the normal case.
    { id: 'single.only', label: 'One Account Only (*.one)', extensions: ['one'], multiAccount: false, fields: [] }
  ],
  accounts: [
    { id: 'a1', name: 'Chequing', subBookId: 'personal' },
    { id: 'a2', name: 'Savings', subBookId: 'personal' },
    { id: 'a3', name: 'Business', subBookId: 'business', closed: true }
  ],
  subBooks: [{ id: 'personal', name: 'Personal' }, { id: 'business', name: 'Business' }],
  today: '2026-11-18'
}

function setup(input: Partial<ExportDialogInput> = {}) {
  const close = vi.fn()
  render(<ExportDialog input={{ ...INPUT, ...input }} close={close} setBusy={() => {}} />)
  return { close }
}

const ok = () => screen.getByRole('button', { name: 'Export…' })

describe('what to export', () => {
  it('defaults to the account it was opened on', async () => {
    const { close } = setup({ scope: { kind: 'account', accountId: 'a2' } })
    expect(screen.getByRole('radio', { name: 'One account' })).toBeChecked()
    await userEvent.click(ok())
    expect(close).toHaveBeenCalledWith(expect.objectContaining({
      scope: { kind: 'account', accountId: 'a2' }
    }))
  })

  it('marks a closed account as closed, since exporting one is reasonable but worth knowing', async () => {
    setup()
    await userEvent.click(screen.getByLabelText('Account to export'))
    expect(screen.getByRole('option', { name: 'Business (closed)' })).toBeInTheDocument()
  })

  it('closes with a sub-book scope, and whether to include the ones inside it', async () => {
    const { close } = setup()
    await userEvent.click(screen.getByRole('radio', { name: 'A sub-book' }))
    await userEvent.click(screen.getByLabelText('and those inside it'))
    await userEvent.click(ok())
    expect(close).toHaveBeenCalledWith(expect.objectContaining({
      scope: { kind: 'subBook', subBookId: 'personal', includeDescendants: false }
    }))
  })

  it('closes with the whole book', async () => {
    const { close } = setup()
    await userEvent.click(screen.getByRole('radio', { name: 'The whole book' }))
    await userEvent.click(ok())
    expect(close).toHaveBeenCalledWith(expect.objectContaining({ scope: { kind: 'book' } }))
  })
})

describe('when', () => {
  it('sends no range at all for All dates, rather than a very wide one', async () => {
    const { close } = setup()
    await userEvent.click(ok())
    expect(close.mock.calls[0][0].range).toBeUndefined()
  })

  it('offers this year and last year by name, from the book’s own clock', async () => {
    setup()
    expect(screen.getByRole('radio', { name: 'This year (2026)' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Last year (2025)' })).toBeInTheDocument()
  })

  it('closes with the whole of last year when that is chosen', async () => {
    const { close } = setup()
    await userEvent.click(screen.getByRole('radio', { name: 'Last year (2025)' }))
    await userEvent.click(ok())
    expect(close.mock.calls[0][0].range).toEqual({ from: '2025-01-01', to: '2025-12-31' })
  })

  it('refuses a range that runs backwards, and says so', async () => {
    setup()
    await userEvent.click(screen.getByRole('radio', { name: 'Chosen dates' }))
    const from = screen.getByLabelText('From')
    await userEvent.clear(from)
    await userEvent.type(from, '2026-12-01')

    expect(screen.getByText(/“from” date is after the “to” date/i)).toBeInTheDocument()
    expect(ok()).toBeDisabled()
  })
})

describe('the format', () => {
  it('closes with the chosen format', async () => {
    const { close } = setup()
    await userEvent.click(screen.getByLabelText('Format'))
    await userEvent.click(screen.getByRole('option', { name: /Comma-Separated/ }))
    await userEvent.click(ok())
    expect(close.mock.calls[0][0].formatId).toBe('exchange-csv.csv')
  })

  it('refuses to flatten several accounts into a format that holds one, rather than doing it silently', async () => {
    setup()
    await userEvent.click(screen.getByRole('radio', { name: 'The whole book' }))
    await userEvent.click(screen.getByLabelText('Format'))
    await userEvent.click(screen.getByRole('option', { name: /One Account Only/ }))

    expect(screen.getByText(/holds one account, and this would export 3/i)).toBeInTheDocument()
    expect(ok()).toBeDisabled()
  })

  it('allows that same format for a single account', async () => {
    setup()
    await userEvent.click(screen.getByLabelText('Format'))
    await userEvent.click(screen.getByRole('option', { name: /One Account Only/ }))
    expect(ok()).toBeEnabled()
  })
})

describe('what to include', () => {
  it('starts with categories in and voided rows out, and closes with what was ticked', async () => {
    const { close } = setup()
    expect(screen.getByRole('checkbox', { name: 'Categories' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Voided transactions' })).not.toBeChecked()

    await userEvent.click(screen.getByRole('checkbox', { name: 'Voided transactions' }))
    await userEvent.click(screen.getByRole('checkbox', { name: /Cleared and reconciled/ }))
    await userEvent.click(ok())

    expect(close).toHaveBeenCalledWith(expect.objectContaining({
      includeCategories: true, includeVoided: true, clearedOnly: true
    }))
  })
})

describe('a book with nothing in it', () => {
  it('says so and will not export', () => {
    setup({ accounts: [], subBooks: [] })
    expect(screen.getByText(/no accounts to export/i)).toBeInTheDocument()
    expect(ok()).toBeDisabled()
  })
})

describe('what the dialog is not', () => {
  it('says an export is not a backup, and offers no Back up button', () => {
    setup()
    expect(screen.getByText(/not a backup/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /back up/i })).not.toBeInTheDocument()
  })
})

describe('rangeOf', () => {
  it('turns each period into the range the service expects', () => {
    expect(rangeOf('all', 2026, '', '')).toBeUndefined()
    expect(rangeOf('thisYear', 2026, '', '')).toEqual({ from: '2026-01-01', to: '2026-12-31' })
    expect(rangeOf('lastYear', 2026, '', '')).toEqual({ from: '2025-01-01', to: '2025-12-31' })
    expect(rangeOf('custom', 2026, '2026-03-01', '2026-04-01')).toEqual({ from: '2026-03-01', to: '2026-04-01' })
  })

  it('leaves out an end the user did not give, which means “to the end”', () => {
    expect(rangeOf('custom', 2026, '2026-03-01', '')).toEqual({ from: '2026-03-01' })
    expect(rangeOf('custom', 2026, '', '2026-04-01')).toEqual({ to: '2026-04-01' })
  })
})

describe('a format’s own options', () => {
  it('shows what the chosen format asked for, and nothing for a format that asked nothing', async () => {
    setup()
    // QIF is first, so its flavour is showing.
    expect(screen.getByLabelText('QIF flavour')).toBeInTheDocument()
    expect(screen.queryByLabelText('Separator')).not.toBeInTheDocument()

    await userEvent.click(screen.getByLabelText('Format'))
    await userEvent.click(screen.getByRole('option', { name: /One Account Only/ }))

    expect(screen.queryByLabelText('QIF flavour')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Separator')).not.toBeInTheDocument()
  })

  it('swaps to the next format’s questions when the format changes', async () => {
    setup()
    await userEvent.click(screen.getByLabelText('Format'))
    await userEvent.click(screen.getByRole('option', { name: /Comma-Separated/ }))

    expect(screen.getByLabelText('Separator')).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: /byte-order mark/ })).toBeChecked()
    expect(screen.queryByLabelText('QIF flavour')).not.toBeInTheDocument()
  })

  it('sends the answers as formatOptions, defaults included', async () => {
    const { close } = setup()
    await userEvent.click(screen.getByLabelText('QIF flavour'))
    await userEvent.click(screen.getByRole('option', { name: 'Quicken (standard)' }))
    await userEvent.click(ok())

    expect(close.mock.calls[0][0].formatOptions).toEqual({ flavour: 'standard' })
  })

  it('sends a boolean a user switched off', async () => {
    const { close } = setup()
    await userEvent.click(screen.getByLabelText('Format'))
    await userEvent.click(screen.getByRole('option', { name: /Comma-Separated/ }))
    await userEvent.click(screen.getByRole('checkbox', { name: /byte-order mark/ }))
    await userEvent.click(ok())

    expect(close.mock.calls[0][0].formatOptions).toEqual({ delimiter: ',', bom: false })
  })

  it('sends no formatOptions at all for a format that asked nothing', async () => {
    const { close } = setup()
    await userEvent.click(screen.getByLabelText('Format'))
    await userEvent.click(screen.getByRole('option', { name: /One Account Only/ }))
    await userEvent.click(ok())

    expect(close.mock.calls[0][0].formatOptions).toBeUndefined()
  })

  it('remembers each format’s answers while the dialog is open', async () => {
    const { close } = setup()
    // Change QIF's flavour, wander off to CSV, and come back.
    await userEvent.click(screen.getByLabelText('QIF flavour'))
    await userEvent.click(screen.getByRole('option', { name: 'Quicken (standard)' }))

    await userEvent.click(screen.getByLabelText('Format'))
    await userEvent.click(screen.getByRole('option', { name: /Comma-Separated/ }))
    await userEvent.click(screen.getByLabelText('Format'))
    await userEvent.click(screen.getByRole('option', { name: /Quicken Interchange/ }))

    expect(screen.getByLabelText('QIF flavour')).toHaveTextContent('Quicken (standard)')
    await userEvent.click(ok())
    // The choice survived the detour rather than resetting to the default.
    expect(close.mock.calls[0][0].formatOptions).toEqual({ flavour: 'standard' })
  })
})
