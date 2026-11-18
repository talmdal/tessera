// Change Transaction Matching: the bank entry pinned at the top, then the Money pair of choices — keep the
// transaction unmatched, or match it to exactly one item in the register. An unmatched row opens on the first,
// a matched row on the second with its current match ticked.
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MatchingCandidate, MatchingDialogInput } from '@tessera/exchange-api'
import MatchingDialog from '../../../../plugins/exchange/src/renderer/MatchingDialog'

const candidate = (id: string, over: Partial<MatchingCandidate> = {}): MatchingCandidate =>
  ({ id, date: '2026-10-01', amount: -14_200, payee: `Payee ${id}`, status: 'uncleared', ...over })

const CANDIDATES = [
  candidate('t1', { date: '2026-10-01', payee: 'Hydro' }),
  candidate('t2', { date: '2026-10-02', payee: 'Rogers', amount: -8_999 }),
  candidate('t3', { date: '2026-10-05', payee: 'Grocer', amount: -5_000, categoryLabel: 'Food : Groceries' })
]

function setup(over: Partial<MatchingDialogInput> = {}) {
  const close = vi.fn()
  const input: MatchingDialogInput = {
    // As the file wrote it: the user is deciding whether two things are the same thing
    entry: { date: '2026-10-03', amount: -14_200, payee: 'SQ *HYDRO OTTAWA 4471', number: '0144' },
    currency: 'CAD',
    candidates: CANDIDATES,
    ...over
  }
  render(<MatchingDialog input={input} close={close} setBusy={() => {}} />)
  return { close }
}

const box = (id: string) => within(document.querySelector(`[data-line="${id}"]`) as HTMLElement).getByRole('checkbox')
const choice = (name: RegExp) => screen.getByRole('radio', { name })

afterEach(() => { vi.restoreAllMocks() })

describe('what the dialog shows', () => {
  it('pins the bank entry as the file wrote it', () => {
    setup()
    const pinned = document.querySelector('[data-matching="bank-entry"]')!
    expect(pinned.textContent).toContain('SQ *HYDRO OTTAWA 4471')
    expect(pinned.textContent).toContain('0144')
  })

  it('opens an unmatched row on Keep Unmatched, with nothing ticked', () => {
    setup()
    expect(choice(/Keep this transaction unmatched/)).toBeChecked()
    expect(screen.getAllByRole('checkbox').filter(el => (el as HTMLInputElement).checked)).toHaveLength(0)
  })

  it('opens a matched row on Match, with the current match ticked and marked', () => {
    setup({ currentId: 't2' })
    expect(choice(/Match this transaction to an item/)).toBeChecked()
    expect(box('t2')).toBeChecked()
    expect(document.querySelector('[data-line="t2"]')?.textContent).toContain('current match')
  })

  it('lists the candidates in date order, with the category by name', () => {
    setup()
    expect([...document.querySelectorAll('[data-line]')].map(el => el.getAttribute('data-line'))).toEqual(['t1', 't2', 't3'])
    expect(document.querySelector('[data-line="t3"]')?.textContent).toContain('Food : Groceries')
  })
})

describe('choosing', () => {
  it('allows exactly one tick: ticking another moves it, and ticking selects the match choice', async () => {
    setup()
    await userEvent.click(box('t1'))
    expect(choice(/Match this transaction/)).toBeChecked()
    await userEvent.click(box('t3'))
    expect(box('t1')).not.toBeChecked()
    expect(box('t3')).toBeChecked()
  })

  it('closes with the ticked item on Done', async () => {
    const { close } = setup()
    await userEvent.click(box('t2'))
    await userEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(close).toHaveBeenCalledWith({ matchTo: 't2' })
  })

  it('closes with null when the user keeps the row unmatched, which unmatches a matched one', async () => {
    const { close } = setup({ currentId: 't2' })
    await userEvent.click(choice(/Keep this transaction unmatched/))
    await userEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(close).toHaveBeenCalledWith({ matchTo: null })
  })

  it('will not finish the match choice with nothing ticked', async () => {
    setup({ currentId: 't2' })
    await userEvent.click(box('t2'))   // untick the current match
    expect(screen.getByRole('button', { name: 'Done' })).toBeDisabled()
  })

  it('closes with nothing on Cancel', async () => {
    const { close } = setup()
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(close).toHaveBeenCalledWith()
  })

  it('says what accepting a match will do before the user confirms', async () => {
    setup()
    expect(document.querySelector('[data-matching="outcome"]')?.textContent).toMatch(/new item/)
    await userEvent.click(box('t1'))
    expect(document.querySelector('[data-matching="outcome"]')?.textContent).toMatch(/takes its date, amount and payee/)
  })
})
