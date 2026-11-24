// File › Ledger Properties…: the ledger's name and file, and its year start, which the dialog saves itself; read-only
// for an archive file. See docs/reporting-design.md, "The ledger's year start".
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { LEDGER_CHANNELS, displayDate, type LedgerPropertiesDialogInput } from '@tessera/ledger-api'
import PropertiesDialog from '../../../../plugins/ledger/src/renderer/PropertiesDialog'
import { createFakeRemote } from '../../../helpers/fakeBridge'

/** A month's name as the dialog shows it, in the test's locale. */
const monthName = (month: number) => new Date(Date.UTC(2001, month - 1, 1)).toLocaleDateString([], { month: 'long', timeZone: 'UTC' })

const INPUT: LedgerPropertiesDialogInput = { name: 'Home', path: '/l/Home.tessera', yearStart: { month: 1, day: 1 }, readOnly: false }

function setup(input: LedgerPropertiesDialogInput = INPUT, answer: (data: any) => unknown = data => ({ ok: true, value: { ...INPUT, yearStart: data.yearStart } })) {
  const remote = createFakeRemote({})
  remote.bridge.invoke.mockImplementation(async (channel: string, data?: any) => {
    if (channel !== LEDGER_CHANNELS.setYearStart) throw new Error(`No answer for ${channel}`)
    return answer(data)
  })
  ;(window as any).api = remote.bridge
  const calls = () => remote.bridge.invoke.mock.calls.filter((c: unknown[]) => c[0] === LEDGER_CHANNELS.setYearStart).map((c: unknown[]) => c[1])
  const close = vi.fn()
  const setBusy = vi.fn()
  render(<PropertiesDialog input={input} close={close} setBusy={setBusy} />)
  return { calls, close, setBusy }
}

describe('the Ledger Properties dialog', () => {
  it('shows the ledger\'s name, file and year start, and saves a new year start', async () => {
    const { calls, close } = setup()
    expect(screen.getByText('Home')).toBeInTheDocument()
    expect(screen.getByText('/l/Home.tessera')).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Year starts in' })).toHaveTextContent(monthName(1))

    await userEvent.click(screen.getByRole('combobox', { name: 'Year starts in' }))
    await userEvent.click(within(await screen.findByRole('listbox')).getByRole('option', { name: monthName(4) }))
    const day = screen.getByRole('spinbutton', { name: 'On day' })
    await userEvent.clear(day)
    await userEvent.type(day, '6')
    await userEvent.click(screen.getByRole('button', { name: 'OK' }))

    await waitFor(() => expect(close).toHaveBeenCalledWith(expect.objectContaining({ yearStart: { month: 4, day: 6 } })))
    expect(calls()).toEqual([{ yearStart: { month: 4, day: 6 } }])
  })

  it('closes without a request when nothing changed', async () => {
    const { calls, close } = setup()
    await userEvent.click(screen.getByRole('button', { name: 'OK' }))
    expect(calls()).toEqual([])
    expect(close).toHaveBeenCalledWith()
  })

  it('refuses 29 February before asking, and moves a day the new month hasn\'t to its last', async () => {
    const { calls } = setup({ ...INPUT, yearStart: { month: 1, day: 31 } })
    await userEvent.click(screen.getByRole('combobox', { name: 'Year starts in' }))
    await userEvent.click(within(await screen.findByRole('listbox')).getByRole('option', { name: monthName(4) }))
    expect(screen.getByRole('spinbutton', { name: 'On day' })).toHaveValue(30)

    await userEvent.click(screen.getByRole('combobox', { name: 'Year starts in' }))
    await userEvent.click(within(await screen.findByRole('listbox')).getByRole('option', { name: monthName(2) }))
    expect(screen.getByRole('spinbutton', { name: 'On day' })).toHaveValue(28)
    const day = screen.getByRole('spinbutton', { name: 'On day' })
    await userEvent.clear(day)
    await userEvent.type(day, '29')
    expect(screen.getByText('A year can’t start on 29 February: it isn’t there every year.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'OK' })).toBeDisabled()
    expect(calls()).toEqual([])
  })

  it('shows a refusal and stays open', async () => {
    const { close } = setup(INPUT, () => ({ ok: false, error: { code: 'READ_ONLY', message: 'This ledger is open read-only.' } }))
    const day = screen.getByRole('spinbutton', { name: 'On day' })
    await userEvent.clear(day)
    await userEvent.type(day, '2{Enter}')
    expect(await screen.findByRole('alert')).toHaveTextContent('This ledger is open read-only.')
    expect(close).not.toHaveBeenCalled()
  })

  it('shows an archive file read-only, saying what it is, with only Close', async () => {
    const { calls, close } = setup({
      name: 'Home (archive before 2026-01-01)', path: '/b/Home (archive before 2026-01-01).tesserabkp', yearStart: { month: 4, day: 6 }, readOnly: true,
      archive: { before: '2026-01-01', takenAt: '2026-11-10T17:00:00.000Z', ledgerName: 'Home' }
    })
    expect(screen.getByText(new RegExp(`An archive of “Home”: what was in it before ${displayDate('2026-01-01')}`))).toBeInTheDocument()
    expect(screen.getByRole('spinbutton', { name: 'On day' })).toBeDisabled()
    expect(screen.getByRole('spinbutton', { name: 'On day' })).toHaveValue(6)
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(close).toHaveBeenCalledWith()
    expect(calls()).toEqual([])
  })
})
