// The import dialogs: which account a statement is for, which format a file is, and what an import did.
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { Account } from '@tessera/accounts-api'
import { displayDate } from '@tessera/ledger-api'
import type { AccountChoice, AccountDialogInput, ImportReport, StatementReport } from '@tessera/import-api'
import AccountDialog from '../../../../plugins/import/src/renderer/AccountDialog'
import FormatDialog from '../../../../plugins/import/src/renderer/FormatDialog'
import SummaryDialog, { describe as describeResult } from '../../../../plugins/import/src/renderer/SummaryDialog'

const account = (over: Partial<Account>): Account => ({
  id: 'x', rev: 1, name: 'X', type: 'chequing', subLedgerId: null, currency: 'CAD', openingDate: '2026-01-01', openingBalance: 0, order: 0, closed: false, ...over
})
const choice = (over: Partial<Account>, extra: Partial<AccountChoice> = {}): AccountChoice => ({ account: account(over), balance: 270000, ...extra })

const input = (over: Partial<AccountDialogInput> = {}): AccountDialogInput => ({
  fileName: 'October.ofx', formatLabel: 'OFX / QFX statement', statementIndex: 0, statementCount: 1,
  statement: { label: 'Maple Trust Bank •••• 5678', institution: 'Maple Trust Bank', accountNumber: '•••• 5678', typeLabel: 'Chequing', currency: 'CAD', lineCount: 17, period: { from: '2026-10-01', to: '2026-10-31' } },
  choices: [
    choice({ id: 'chq', name: 'Chequing', institution: 'Maple Trust Bank', accountNumber: '8812345678' }, { hint: 'Account number matches' }),
    choice({ id: 'sav', name: 'Savings', type: 'savings' }, { balance: -5400 }),
    choice({ id: 'usd', name: 'US Dollar', currency: 'USD' }, { disabledReason: 'Other currency' }),
    choice({ id: 'old', name: 'Old Chequing', closed: true }, { disabledReason: 'Closed' })
  ],
  preselectedId: 'chq',
  remember: { strength: 'strong', label: 'Remember this account for “Maple Trust Bank •••• 5678”', checked: true },
  ...over
})

function showAccountDialog(over: Partial<AccountDialogInput> = {}) {
  const close = vi.fn()
  render(<AccountDialog input={input(over)} close={close} setBusy={vi.fn()} />)
  return close
}
const radio = (name: string | RegExp) => screen.getByRole('radio', { name })

describe('the Account dialog', () => {
  it('says what the file is and what it says about its account', () => {
    showAccountDialog()
    expect(screen.getByText(/October\.ofx · OFX \/ QFX statement · 17 transactions, Oct 1\s*–\s*31, 2026/)).toBeInTheDocument()
    expect(screen.getByText('Maple Trust Bank · account ending 5678 · chequing · CAD')).toBeInTheDocument()
  })

  it('lists the accounts in the order given, with the likely one chosen, and those that can’t take it disabled', () => {
    showAccountDialog()
    const group = screen.getByRole('radiogroup', { name: 'Account' })
    expect(within(group).getAllByRole('radio').map(r => (r as HTMLInputElement).value)).toEqual(['chq', 'sav', 'usd', '(create)'])
    expect(radio(/^Chequing/)).toBeChecked()
    expect(radio(/^US Dollar/)).toBeDisabled()
    expect(screen.getByText('Account number matches')).toBeInTheDocument()
    expect(screen.getByText('Other currency')).toBeInTheDocument()
    // A negative balance in the theme's error colour, as everywhere; a positive one as text
    const colour = (text: string) => getComputedStyle(screen.getAllByText(text)[0]).color
    expect(colour('-54.00')).not.toBe(colour('2,700.00'))
  })

  it('shows closed accounts only when asked, and never lets them be chosen', async () => {
    showAccountDialog()
    expect(screen.queryByRole('radio', { name: /^Old Chequing/ })).toBeNull()
    await userEvent.click(screen.getByRole('checkbox', { name: 'Show closed accounts' }))
    expect(radio(/^Old Chequing/)).toBeDisabled()
  })

  it('imports into the chosen account, remembering it or not as ticked', async () => {
    const close = showAccountDialog()
    await userEvent.click(radio(/^Savings/))
    await userEvent.click(screen.getByRole('checkbox', { name: /Remember this account/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Import' }))
    expect(close).toHaveBeenCalledWith({ kind: 'account', accountId: 'sav', remember: false })
  })

  it('creates a new account, skips the file, or cancels the import', async () => {
    const close = showAccountDialog()
    await userEvent.click(radio('Create a new account…'))
    await userEvent.click(screen.getByRole('button', { name: 'Create…' }))
    expect(close).toHaveBeenLastCalledWith({ kind: 'create', remember: true })
    await userEvent.click(screen.getByRole('button', { name: 'Skip This File' }))
    expect(close).toHaveBeenLastCalledWith({ kind: 'skip' })
    await userEvent.click(screen.getByRole('button', { name: 'Cancel Import' }))
    expect(close).toHaveBeenLastCalledWith()
  })

  it('says why it is asking despite a saved match, offers Create when there is no account, and asks weakly for CSV-like files', () => {
    showAccountDialog({
      choices: [], preselectedId: undefined, note: 'Last time this went to “Old Chequing”, which is closed.',
      statement: { lineCount: 3 },
      remember: { strength: 'weak', label: 'Don\'t ask again for files like this one', checked: false }
    })
    expect(screen.getByRole('alert')).toHaveTextContent('which is closed')
    expect(screen.getByText("doesn't name its account")).toBeInTheDocument()
    expect(radio('Create a new account…')).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Don\'t ask again for files like this one' })).not.toBeChecked()
  })
})

describe('the Choose Format dialog', () => {
  it('asks which format a file is, and answers with it', async () => {
    const close = vi.fn()
    render(<FormatDialog input={{ fileName: 'x.ofx', formats: [{ id: 'a', label: 'OFX statement' }, { id: 'b', label: 'Other', description: 'Something else' }] }} close={close} setBusy={vi.fn()} />)
    expect(screen.getByText(/More than one kind of file could be x\.ofx/)).toBeInTheDocument()
    expect(screen.getByText('Something else')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('radio', { name: /Other/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Choose' }))
    expect(close).toHaveBeenCalledWith({ formatId: 'b' })
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(close).toHaveBeenLastCalledWith()
  })
})

describe('the summary', () => {
  const result = (over: Partial<StatementReport>): StatementReport => ({
    source: 'October.ofx', statementIndex: 0, outcome: 'imported', accountId: 'chq', accountName: 'Chequing',
    counts: { lines: 17, added: 12, matched: 0, possible: 0, duplicates: 5, invalid: 0 }, warnings: [], ...over
  })

  it('says what each statement did, in a sentence', () => {
    expect(describeResult(result({}))).toBe('12 transactions added to “Chequing”, 5 already imported.')
    expect(describeResult(result({ counts: { lines: 17, added: 0, matched: 0, possible: 0, duplicates: 17, invalid: 0 } })))
      .toBe('Nothing new for “Chequing”: all 17 transactions were already imported.')
    expect(describeResult(result({ counts: { lines: 3, added: 1, matched: 0, possible: 0, duplicates: 0, invalid: 2 } })))
      .toBe('1 transaction added to “Chequing”, 2 left out.')
    expect(describeResult(result({ outcome: 'failed', error: { code: 'TOO_LARGE', message: 'x is too large.' } }))).toBe('x is too large.')
    expect(describeResult(result({ outcome: 'needsAccount' }))).toBe('Not imported: no account could be found for it.')
    expect(describeResult(result({ outcome: 'skipped' }))).toBe('Skipped.')
  })

  it('counts matches to transactions already there, and the possible ones among them', () => {
    expect(describeResult(result({ counts: { lines: 17, added: 11, matched: 4, possible: 2, duplicates: 0, invalid: 0 } })))
      .toBe('11 transactions added to “Chequing”, 6 matched to ones already there (2 possible).')
    expect(describeResult(result({ counts: { lines: 5, added: 0, matched: 1, possible: 0, duplicates: 4, invalid: 0 } })))
      .toBe('1 transaction in “Chequing” matched to ones already there, 4 already imported.')
  })

  it('says how many lines were left out as dated before the account\'s last archival date', () => {
    const counts = { lines: 17, added: 12, matched: 0, possible: 0, duplicates: 2, invalid: 0, archived: 3 }
    expect(describeResult(result({ counts, lastArchiveDate: '2025-01-01' })))
      .toBe(`12 transactions added to “Chequing”, 2 already imported, 3 left out as dated before ${displayDate('2025-01-01')} (the last archival date).`)
    expect(describeResult(result({ counts: { ...counts, added: 0, duplicates: 0, archived: 17 }, lastArchiveDate: '2025-01-01' })))
      .toBe(`Nothing new for “Chequing”: 17 left out as dated before ${displayDate('2025-01-01')} (the last archival date).`)
    expect(describeResult(result({ counts: { ...counts, added: 0, duplicates: 5, archived: 5, invalid: 1 }, lastArchiveDate: '2025-01-01' })))
      .toBe(`Nothing new for “Chequing”: 5 already imported, 5 left out as dated before ${displayDate('2025-01-01')} (the last archival date), 1 left out.`)
    // Matched, with some left out
    expect(describeResult(result({ counts: { ...counts, added: 0, matched: 1, duplicates: 0, archived: 1 }, lastArchiveDate: '2025-01-01' })))
      .toBe(`1 transaction in “Chequing” matched to ones already there, 1 left out as dated before ${displayDate('2025-01-01')} (the last archival date).`)
  })

  it('offers the register when there are matches to review, even with nothing added', async () => {
    const close = vi.fn()
    render(<SummaryDialog input={{ results: [result({ counts: { lines: 2, added: 0, matched: 1, possible: 1, duplicates: 0, invalid: 0 } })] }} close={close} setBusy={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: 'Review in Register' }))
    expect(close).toHaveBeenCalledWith({ review: 'chq' })
  })

  it('lists every statement, its warnings (the first few), and the import’s notices; Review in Register opens the account', async () => {
    const close = vi.fn()
    const report: ImportReport = {
      notices: ['The import of September.ofx was interrupted, so nothing from it was added. Import the file again.'],
      results: [
        result({ source: 'Two.ofx', warnings: Array.from({ length: 7 }, (_, i) => `Line ${i + 1}: bad`) }),
        result({ source: 'Two.ofx', statementIndex: 1, outcome: 'skipped' }),
        result({ source: 'bad.ofx', outcome: 'failed', error: { code: 'UNREADABLE', message: "bad.ofx isn't an OFX statement." } })
      ]
    }
    render(<SummaryDialog input={report} close={close} setBusy={vi.fn()} />)
    expect(screen.getByRole('alert')).toHaveTextContent('September.ofx was interrupted')
    const items = within(screen.getByRole('list', { name: 'What was imported' })).getAllByRole('listitem').filter(li => li.hasAttribute('data-outcome'))
    expect(items.map(li => li.getAttribute('data-outcome'))).toEqual(['imported', 'skipped', 'failed'])
    expect(items[0]).toHaveTextContent('Two.ofx, statement 1')
    expect(within(items[0]).getByText('…and 2 more.')).toBeInTheDocument()
    expect(items[2]).toHaveTextContent("bad.ofx isn't an OFX statement.")

    await userEvent.click(screen.getByRole('button', { name: 'Review in Register' }))
    expect(close).toHaveBeenCalledWith({ review: 'chq' })
  })

  it('offers no register to review when nothing was added', async () => {
    const close = vi.fn()
    render(<SummaryDialog input={{ results: [result({ counts: { lines: 17, added: 0, matched: 0, possible: 0, duplicates: 17, invalid: 0 } })] }} close={close} setBusy={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'Review in Register' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(close).toHaveBeenCalledWith({})
  })
})
