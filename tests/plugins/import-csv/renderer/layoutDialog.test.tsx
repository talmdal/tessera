// The CSV Columns dialog: the layout it starts from, the role pickers, the options, the live preview (made by the same
// code the format imports with), what can't be confirmed, where focus starts, and its three answers.
import fs from 'node:fs'
import path from 'node:path'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import LayoutDialog, { showAmount } from '../../../../plugins/import-csv/src/renderer/LayoutDialog'
import { readCsv, valuesOf } from '../../../../plugins/import-csv/src/shared/csv'
import type { LayoutDialogInput } from '../../../../plugins/import-csv/src/shared/dialog'
import { guessLayout } from '../../../../plugins/import-csv/src/shared/guess'
import { SAMPLES } from '../../../helpers/importFile'

const PIVOT = 2036
const textOf = (name: string) => fs.readFileSync(path.join(SAMPLES, name), 'utf8')

/** The dialog's input for a sample, as the format makes it the first time: the guess. */
function inputFor(name: string, over: Partial<LayoutDialogInput> = {}): LayoutDialogInput {
  const text = textOf(name)
  const { delimiter, rows } = readCsv(text)
  const guess = guessLayout(rows.map(valuesOf), { delimiter, pivot: PIVOT })
  return {
    fileName: name, text, truncated: false, layout: guess.layout, uncertain: guess.uncertain, pivot: PIVOT,
    start: guess.uncertain.length === 0 ? 'recognised' : 'guessed', ...over
  }
}

/** Shows the dialog, once it has put focus where it starts (and MUI has settled the focused control). */
async function show(input: LayoutDialogInput) {
  const close = vi.fn()
  render(<LayoutDialog input={input} close={close} setBusy={vi.fn()} />)
  await waitFor(() => expect(document.activeElement).not.toBe(document.body))
  return close
}
const role = (column: number, name?: string) => screen.getByLabelText(`Role for column ${column}${name ? `, ${name}` : ''}`)
/**
 * Opens a select's menu and chooses an option: a press on the select, as MUI opens it, and a click on the option. Fired
 * rather than typed with userEvent, whose pointer steps on a dialog this size made a full run near the time limit.
 */
async function choose(select: HTMLElement, option: string | RegExp) {
  fireEvent.mouseDown(select)
  fireEvent.click(within(await screen.findByRole('listbox')).getByText(option))
  await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument())
}
const summary = () => screen.getByLabelText('Summary of what will be imported').textContent
// Found by their labels and text rather than by role and accessible name: the dialog is large, and computing every
// element's accessible name made these tests slow enough to time out under a full run
const preview = () => within(screen.getByLabelText('What will be imported')).getAllByRole('row').map(r => r.textContent)
const importButton = () => screen.getByText('Import', { selector: 'button' })

describe('the CSV Columns dialog', () => {
  it('shows the columns it starts from over the file’s rows, and what will be imported', async () => {
    await show(inputFor('maple-trust-chequing-2026-10.csv'))
    expect(screen.getByText(/^Tessera recognised these columns/)).toBeInTheDocument()
    expect(role(1, 'Date')).toHaveTextContent(/^Date$/)
    expect(role(3, 'Withdrawals')).toHaveTextContent(/^Money out$/)
    expect(role(4, 'Deposits')).toHaveTextContent(/^Money in$/)
    expect(role(6, 'Status')).toHaveTextContent(/^Status$/)
    expect(screen.getByRole('table', { name: 'The file\'s columns' })).toHaveTextContent('10/02/2026')
    expect(preview()[0]).toMatch(/^Oct 2, 2026CHEQUE 101−1,200\.00$/)
    expect(summary()).toMatch(/^17 lines · Oct 2\s*–\s*31, 2026 · closing balance 4,677\.80$/)
    // A negative amount in the theme's error colour
    const table = within(screen.getByRole('table', { name: 'What will be imported' }))
    expect(getComputedStyle(table.getByText('−1,200.00')).color).not.toBe(getComputedStyle(table.getByText('3,000.00')).color)
  })

  it('lists the rows left out and why, on request', async () => {
    await show(inputFor('maple-trust-chequing-2026-10.csv'))
    const toggle = screen.getByRole('button', { name: /^1 row left out/ })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await userEvent.click(toggle)
    expect(screen.getByRole('list', { name: 'Rows left out' })).toHaveTextContent('Row 19: It is pending: it will come with a later export, once the bank posts it.')
  })

  it('says where its layout came from, as its first line', () => {
    const base = inputFor('maple-trust-chequing-2026-10.csv')
    const lines = {
      remembered: /^Same columns as last time \(files like this one, last imported 5 Nov 2026\)/,
      misfit: /^These columns worked last time, but not for this file: column 4 is missing\./,
      dateOrderChanged: /^The dates in this file are month first; last time they were read day first\./
    }
    for (const [start, line] of Object.entries(lines)) {
      const { unmount } = render(<LayoutDialog input={{ ...base, start: start as LayoutDialogInput['start'], lastUsed: '2026-11-05', misfit: 'column 4 is missing.', previousDateOrder: 'DMY' }} close={vi.fn()} setBusy={vi.fn()} />)
      expect(screen.getByText(line)).toBeInTheDocument()
      unmount()
    }
  })

  it('gives a role to a column, taking it from the column that had it, and won’t import without a date', async () => {
    await show(inputFor('maple-trust-chequing-2026-10.csv'))
    await choose(role(1, 'Date'), 'Payee')
    expect(role(1, 'Date')).toHaveTextContent(/^Payee$/)
    expect(role(2, 'Description')).toHaveTextContent(/^Ignore$/)
    expect(screen.getByRole('alert')).toHaveTextContent('Choose the column that holds the date.')
    expect(importButton()).toBeDisabled()
    // The descriptions as dates: a layout, but one that reads nothing
    await choose(role(2, 'Description'), 'Date')
    expect(summary()).toBe('No lines: nothing would be imported.')
    expect(importButton()).toBeDisabled()
  })

  it('imports the roles chosen', async () => {
    const close = await show(inputFor('maple-trust-chequing-2026-10.csv'))
    await choose(role(2, 'Description'), 'Memo')
    await choose(role(6, 'Status'), 'Payee')
    expect(role(2, 'Description')).toHaveTextContent(/^Memo$/)
    expect(preview()[0]).toMatch(/^Oct 2, 2026Posted · CHEQUE 101−1,200\.00$/)
    await userEvent.click(importButton())
    expect(close).toHaveBeenCalledWith({ kind: 'layout', layout: expect.objectContaining({ columns: expect.objectContaining({ date: 0, memo: [1], payee: 5 }) }) })
  })

  it('makes Money out and Money in a pair, excluding one amount column', async () => {
    await show(inputFor('maple-trust-chequing-2026-10.csv'))
    await choose(role(3, 'Withdrawals'), 'Amount')
    expect(role(4, 'Deposits')).toHaveTextContent(/^Ignore$/)
    expect(importButton()).toBeEnabled()
    await choose(role(4, 'Deposits'), 'Money in')
    expect(role(3, 'Withdrawals')).toHaveTextContent(/^Ignore$/)
    expect(screen.getByRole('alert')).toHaveTextContent('Choose the Money out column too.')
    expect(importButton()).toBeDisabled()
  })

  it('shows the guesses, highlighted and explained, until they are changed; and reverses amounts in the preview', async () => {
    await show(inputFor('northwind-visa-2026-10.csv'))
    expect(screen.getByText(/^Tessera guessed these columns/)).toBeInTheDocument()
    expect(screen.getByRole('list', { name: 'Guesses to check' })).toHaveTextContent(/6 of the 8 amounts are positive/)
    const reversed = screen.getByRole('checkbox', { name: 'Money out is shown as positive (amounts are reversed)' })
    expect(reversed).toBeChecked()
    expect(preview()[0]).toMatch(/AIR CANADA 0142325781−128\.44$/)
    await userEvent.click(reversed)
    expect(preview()[0]).toMatch(/AIR CANADA 0142325781128\.44$/)
    expect(screen.queryByRole('list', { name: 'Guesses to check' })).not.toBeInTheDocument()
  })

  it('reads the dates in the order chosen, and says so when they can’t be', async () => {
    await show(inputFor('maple-trust-chequing-2026-10.csv'))
    await choose(screen.getByRole('combobox', { name: 'Dates' }), 'Day/Month/Year')
    expect(screen.getByRole('table', { name: 'What will be imported' })).toHaveTextContent('Feb 10, 2026')
    expect(summary()).toMatch(/^7 lines/)
    expect(screen.getByRole('button', { name: /^11 rows left out/ })).toBeInTheDocument()
  })

  it('splits the file again on another separator', async () => {
    await show(inputFor('maple-trust-cheques-2026-10-fr.csv'))
    expect(summary()).toMatch(/^8 lines/)
    expect(preview()[0]).toMatch(/LOYER OCTOBRE−1,250\.00$/)
    await choose(screen.getByRole('combobox', { name: 'Separator' }), 'Comma')
    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(importButton()).toBeDisabled()
  })

  it('starts at the row chosen, and takes it as the header when ticked', async () => {
    await show(inputFor('maple-trust-cheques-2026-10-fr.csv'))
    await choose(screen.getByRole('combobox', { name: 'Start at' }), /^Row 1:/)
    expect(screen.getByRole('checkbox', { name: 'Row 1 is the header' })).toBeChecked()
    expect(summary()).toMatch(/^8 lines/)                       // the rows above the data are left out quietly
  })

  it('won’t import a layout that reads no lines', async () => {
    await show(inputFor('maple-trust-chequing-2026-10.csv'))
    await choose(role(3, 'Withdrawals'), 'Payee')
    await choose(role(4, 'Deposits'), 'Amount')
    await choose(screen.getByRole('combobox', { name: 'Decimal' }), '1.234,56')
    expect(summary()).toBe('No lines: nothing would be imported.')
    expect(importButton()).toBeDisabled()
  })

  it('starts on Import when the layout was remembered, so Enter confirms it', async () => {
    const close = await show(inputFor('maple-trust-chequing-2026-10.csv', { start: 'remembered', lastUsed: '2026-11-05' }))
    expect(importButton()).toHaveFocus()
    await userEvent.keyboard('{Enter}')
    expect(close).toHaveBeenCalledWith({ kind: 'layout', layout: inputFor('maple-trust-chequing-2026-10.csv').layout })
  })

  it('starts on the first uncertain choice otherwise', async () => {
    await show(inputFor('maple-trust-chequing-2026-10.csv', { uncertain: [{ field: 'dateOrder', why: 'The dates could be day/month or month/day.' }], start: 'guessed' }))
    expect(screen.getByRole('combobox', { name: 'Dates' })).toHaveFocus()
    expect(screen.getByText('A guess: check it')).toBeInTheDocument()
  })

  it('starts on an uncertain column’s role picker', async () => {
    await show(inputFor('maple-trust-chequing-2026-10.csv', { uncertain: [{ field: 'column', column: 2, why: 'The left one is taken as money out.' }], start: 'guessed' }))
    expect(role(3, 'Withdrawals')).toHaveFocus()
    expect(screen.getByText('Column 3: The left one is taken as money out.')).toBeInTheDocument()
  })

  it('skips the file, or cancels the import', async () => {
    const skip = await show(inputFor('harbour-bank-2026-10.csv'))
    await userEvent.click(screen.getByRole('button', { name: 'Skip This File' }))
    expect(skip).toHaveBeenCalledWith({ kind: 'skip' })
    const cancel = vi.fn()
    render(<LayoutDialog input={inputFor('harbour-bank-2026-10.csv')} close={cancel} setBusy={vi.fn()} />)
    await userEvent.click(screen.getAllByRole('button', { name: 'Cancel Import' })[1])
    expect(cancel).toHaveBeenCalledWith()
  })

  it('counts the accounts of a file with an account column', async () => {
    await show(inputFor('harbour-bank-2026-10.csv'))
    expect(summary()).toMatch(/^7 lines in 2 accounts · Oct 1\s*–\s*31, 2026$/)
  })

  it('writes amounts as the register does', () => {
    expect(showAmount('-1234567.8')).toBe('−1,234,567.8')
    expect(showAmount('0.38')).toBe('0.38')
    expect(showAmount('3000')).toBe('3,000')
  })
})
