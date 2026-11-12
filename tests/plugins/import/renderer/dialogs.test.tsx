// The import dialogs: which account a statement is for, which format a file is, what an import did, and whether a
// file's categories are used.
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { Account } from '@tessera/accounts-api'
import { displayDate } from '@tessera/ledger-api'
import type { AccountChoice, AccountDialogInput, CategoriesDialogInput, ImportReport, SignsDialogInput, StatementCategories, StatementReport } from '@tessera/import-api'
import AccountDialog from '../../../../plugins/import/src/renderer/AccountDialog'
import CategoriesDialog, { describeOffer } from '../../../../plugins/import/src/renderer/CategoriesDialog'
import SignsDialog, { inColumn } from '../../../../plugins/import/src/renderer/SignsDialog'
import FormatDialog from '../../../../plugins/import/src/renderer/FormatDialog'
import SummaryDialog, { describe as describeResult, describeCategories, describeReversed } from '../../../../plugins/import/src/renderer/SummaryDialog'

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

  it('says how many lines looked already imported from another file, and offers the register for them', async () => {
    expect(describeResult(result({ counts: { lines: 10, added: 5, matched: 0, possible: 0, duplicates: 0, invalid: 0, alreadyImported: 5 } })))
      .toBe('5 transactions added to “Chequing”, 5 looked like transactions imported before from another file and weren’t added: check them in the register.')
    expect(describeResult(result({ counts: { lines: 3, added: 0, matched: 0, possible: 0, duplicates: 2, invalid: 0, alreadyImported: 1 } })))
      .toBe('Nothing added to “Chequing”, 2 already imported, 1 looked like a transaction imported before from another file and wasn’t added: check it in the register.')
    const close = vi.fn()
    render(<SummaryDialog input={{ results: [result({ counts: { lines: 1, added: 0, matched: 0, possible: 0, duplicates: 0, invalid: 0, alreadyImported: 1 } })] }} close={close} setBusy={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: 'Review in Register' }))
    expect(close).toHaveBeenCalledWith({ review: 'chq' })
  })

  it('says when lines were recognised by their content because the bank had used their ids before', () => {
    expect(describeResult(result({ counts: { lines: 4, added: 4, matched: 0, possible: 0, duplicates: 0, invalid: 0, idConflicts: 4 } })))
      .toBe('4 transactions added to “Chequing”, 4 recognised by their content, as the bank had used their ids before for other transactions.')
    expect(describeResult(result({ counts: { lines: 4, added: 1, matched: 0, possible: 0, duplicates: 3, invalid: 0, idConflicts: 1 } })))
      .toBe('1 transaction added to “Chequing”, 3 already imported, 1 recognised by its content, as the bank had used its id before for other transactions.')
  })

  const categories = (over: Partial<StatementCategories> = {}): StatementCategories => ({
    offered: 12, differing: 3, source: 'file', decidedBy: 'remembered', remembered: true, key: 'fix:5555', sourceLabel: 'Maple Chequing', examples: [], ...over
  })

  it('says what the categories a file gave did, and how that was decided', () => {
    expect(describeCategories(categories())).toBe('12 new transactions took their categories from the file, as you chose for “Maple Chequing”.')
    expect(describeCategories(categories({ offered: 1 }))).toBe('1 new transaction took its category from the file, as you chose for “Maple Chequing”.')
    expect(describeCategories(categories({ decidedBy: 'asked', remembered: false }))).toBe('12 new transactions took their categories from the file, this time.')
    expect(describeCategories(categories({ source: 'payee' }))).toBe('The file gave categories for 12 new transactions, which weren’t used, as you chose for “Maple Chequing”.')
    expect(describeCategories(categories({ source: 'payee', decidedBy: 'asked', remembered: false }))).toBe('The file gave categories for 12 new transactions, which weren’t used, this time.')
    expect(describeCategories(categories({ source: 'payee', decidedBy: 'default', remembered: false })))
      .toBe('The file gave categories for 12 new transactions, which weren’t used: this import didn’t ask.')
  })

  it("offers Change… beside a remembered answer about a file's categories, and not beside one for this time only", async () => {
    const close = vi.fn()
    render(<SummaryDialog input={{ results: [result({ source: 'A.qif' }), result({ source: 'B.qif', categories: categories() }), result({ source: 'C.qif', categories: categories({ sourceLabel: 'Other', remembered: false, decidedBy: 'asked' }) })] }}
      close={close} setBusy={vi.fn()} />)
    expect(screen.getAllByRole('button', { name: /^Change/ })).toHaveLength(1)
    await userEvent.click(screen.getByRole('button', { name: 'Change how files from “Maple Chequing” give categories' }))
    expect(close).toHaveBeenCalledWith({ changeCategories: 1 })
  })

  it('offers no register to review when nothing was added', async () => {
    const close = vi.fn()
    render(<SummaryDialog input={{ results: [result({ counts: { lines: 17, added: 0, matched: 0, possible: 0, duplicates: 17, invalid: 0 } })] }} close={close} setBusy={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'Review in Register' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(close).toHaveBeenCalledWith({})
  })
})

describe('the Categories from the File dialog', () => {
  const input = (over: Partial<CategoriesDialogInput> = {}): CategoriesDialogInput => ({
    fileName: 'Checking.qif', sourceLabel: 'Maple Chequing', accountName: 'Chequing', offered: 42, differing: 9,
    examples: [
      { payee: 'Costco', file: 'Food : Groceries', usual: 'Housing : Maintenance' },
      { payee: 'Shell', file: 'Transportation : Fuel' }
    ],
    ...over
  })
  function show(over: Partial<CategoriesDialogInput> = {}) {
    const close = vi.fn()
    render(<CategoriesDialog input={input(over)} close={close} setBusy={vi.fn()} />)
    return close
  }

  it('says what the file gives, and shows some of its categories beside the payees’ usual ones', () => {
    show()
    expect(screen.getByText('Checking.qif gives a category for 42 new transactions, and your ledger has them. For 9 of them, you usually use a different category for the payee.')).toBeInTheDocument()
    const rows = within(screen.getByRole('table', { name: 'Categories in the file' })).getAllByRole('row').map(row => row.textContent)
    expect(rows).toEqual(['PayeeThe file saysYou usually use', 'CostcoFood : GroceriesHousing : Maintenance', 'ShellTransportation : FuelNothing yet'])
  })

  it('words the offer for one transaction, and for all of them', () => {
    expect(describeOffer(input({ offered: 1, differing: 0 }))).toBe('Checking.qif gives a category for one of its new transactions, and your ledger has it.')
    expect(describeOffer(input({ offered: 1, differing: 1 }))).toBe('Checking.qif gives a category for one of its new transactions, and your ledger has it. You usually use a different category for its payee.')
    expect(describeOffer(input({ offered: 3, differing: 3 }))).toBe('Checking.qif gives a category for 3 new transactions, and your ledger has them. For all of them, you usually use a different category for the payee.')
  })

  it('decides nothing for the user: Continue waits for a choice', async () => {
    const close = vi.fn()
    render(<CategoriesDialog input={input()} close={close} setBusy={vi.fn()} />)
    const group = screen.getByRole('radiogroup', { name: 'For new transactions, use:' })
    expect(within(group).getAllByRole('radio').map(r => (r as HTMLInputElement).checked)).toEqual([false, false])
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled()
    await userEvent.click(screen.getByRole('radio', { name: /^The file’s categories/ }))
    expect(screen.getByRole('checkbox', { name: 'Remember this for files from “Maple Chequing”' })).toBeChecked()
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(close).toHaveBeenCalledWith({ source: 'file', remember: true })
  })

  it('can keep the payees’ categories for this file only, or cancel the import', async () => {
    const close = show()
    await userEvent.click(screen.getByRole('radio', { name: /My usual category for each payee/ }))
    await userEvent.click(screen.getByRole('checkbox', { name: /Remember this/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(close).toHaveBeenCalledWith({ source: 'payee', remember: false })
    await userEvent.click(screen.getByRole('button', { name: 'Cancel Import' }))
    expect(close).toHaveBeenLastCalledWith()
  })

  it('starts from the answer kept when changing it from the summary, and saves or cancels', async () => {
    const close = show({ current: 'file' })
    expect(screen.getByRole('radio', { name: /^The file’s categories/ })).toBeChecked()
    expect(screen.queryByRole('button', { name: 'Cancel Import' })).toBeNull()
    await userEvent.click(screen.getByRole('radio', { name: /My usual category/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(close).toHaveBeenCalledWith({ source: 'payee', remember: true })
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(close).toHaveBeenLastCalledWith()
  })
})

describe('the Amounts Reversed? dialog', () => {
  const input = (over: Partial<SignsDialogInput> = {}): SignsDialogInput => ({
    fileName: 'northwind-visa-2026-10-reversed.qfx', accountName: 'Visa', accountTypeLabel: 'Credit card', currency: 'CAD',
    columns: { decrease: 'Charge', increase: 'Payment' },
    reasons: ['Reversed, 3 lines match transactions you entered; as they are, none do.', '6 of its 8 lines would lower what you owe, and only 2 would add to it.'],
    examples: [{ date: '2026-10-14', payee: 'PAYMENT - THANK YOU', amount: -54000 }, { date: '2026-10-03', payee: 'AIR CANADA', amount: 12844 }],
    rememberLabel: 'Remember for files like this one going into “Visa”', ...over
  })
  function show(over: Partial<SignsDialogInput> = {}) {
    const close = vi.fn()
    render(<SignsDialog input={input(over)} close={close} setBusy={vi.fn()} />)
    return close
  }

  it('says why the amounts look the wrong way round, and shows lines both ways in the account’s own terms', () => {
    show()
    expect(screen.getByText('The amounts in northwind-visa-2026-10-reversed.qfx may be the wrong way round for “Visa” (credit card):')).toBeInTheDocument()
    expect(within(screen.getByRole('list')).getAllByRole('listitem').map(li => li.textContent)).toEqual(input().reasons)
    const rows = within(screen.getByRole('table', { name: 'Lines both ways' })).getAllByRole('row').map(r => r.textContent)
    expect(rows).toEqual(['DatePayeeAs they areReversed', 'Oct 14, 2026PAYMENT - THANK YOUCharge 540.00Payment 540.00', 'Oct 3, 2026AIR CANADAPayment 128.44Charge 128.44'])
    expect(inColumn({ columns: { decrease: 'Payment', increase: 'Deposit' }, currency: 'CAD' }, -120000)).toBe('Payment 1,200.00')
  })

  it('has Reverse chosen, and Remember ticked, to begin with; Continue answers', async () => {
    const close = show()
    expect(screen.getByRole('radio', { name: 'Reverse the amounts' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Remember for files like this one going into “Visa”' })).toBeChecked()
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(close).toHaveBeenCalledWith({ reverse: true, remember: true })
  })

  it('can import them as they are, this time only, or cancel the import', async () => {
    const close = show()
    await userEvent.click(screen.getByRole('radio', { name: 'Import them as they are' }))
    await userEvent.click(screen.getByRole('checkbox', { name: /Remember/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(close).toHaveBeenCalledWith({ reverse: false, remember: false })
    await userEvent.click(screen.getByRole('button', { name: 'Cancel Import' }))
    expect(close).toHaveBeenLastCalledWith()
  })

  it('says so when a kept correction already reverses this source’s files', () => {
    show({ correctedSince: 'These amounts are shown reversed already, as you chose on Nov 6, 2026. Reversing them again reads them as the file writes them.' })
    expect(screen.getByRole('alert')).toHaveTextContent('shown reversed already')
  })
})

describe('the summary, on signs', () => {
  it('says when amounts were reversed, and how it was decided', () => {
    expect(describeReversed({ decidedBy: 'asked', remembered: true })).toBe('Amounts reversed, as you chose; files like this one will be too.')
    expect(describeReversed({ decidedBy: 'asked', remembered: false })).toBe('Amounts reversed, this time.')
    expect(describeReversed({ decidedBy: 'remembered', remembered: true })).toBe('Amounts reversed, as you chose for files like this one.')
  })

  it('shows the line under the statement’s sentence, and a statement that couldn’t be asked about as a warning', async () => {
    const base: StatementReport = {
      source: 'card.qfx', statementIndex: 0, outcome: 'imported', accountId: 'v', accountName: 'Visa',
      counts: { lines: 8, added: 8, matched: 0, possible: 0, duplicates: 0, invalid: 0 }, warnings: []
    }
    render(<SummaryDialog input={{ results: [{ ...base, reversed: { decidedBy: 'asked', remembered: true } }, { ...base, source: 'conn', outcome: 'needsConfirmation', counts: { ...base.counts, added: 0 } }] }} close={vi.fn()} setBusy={vi.fn()} />)
    expect(screen.getByText('Amounts reversed, as you chose; files like this one will be too.')).toBeInTheDocument()
    expect(screen.getByText('Not imported: its amounts may be the wrong way round for “Visa”, and this import couldn’t ask.')).toBeInTheDocument()
    const items = within(screen.getByRole('list', { name: 'What was imported' })).getAllByRole('listitem').filter(li => li.hasAttribute('data-outcome'))
    expect(items.map(li => li.getAttribute('data-outcome'))).toEqual(['imported', 'needsConfirmation'])
    await userEvent.click(screen.getByRole('button', { name: 'Close' }))           // (Review in Register takes the focus as it opens)
  })
})
