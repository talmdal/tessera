// The Change Match dialog: the bank line, the transactions it could be (with what differs), searching and the whole
// account, and the options for a proposed match, an accepted one, a row added as new and a line that lost its match.
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Account, Transaction } from '@tessera/accounts-api'
import { IMPORT_CHANNELS, type MatchCandidate, type MatchCandidatesRequest, type MatchCandidatesResponse } from '@tessera/import-api'
import MatchDialog from '../../../../plugins/import/src/renderer/MatchDialog'
import { createFakeRemote } from '../../../helpers/fakeBridge'

const account: Account = {
  id: 'c', rev: 1, name: 'Chequing', type: 'chequing', subLedgerId: null, currency: 'CAD', openingDate: '2026-01-01',
  openingBalance: 0, order: 0, closed: false
}
const tx = (id: string, date: string, amount: number, over: Partial<Transaction> = {}): Transaction =>
  ({ id, rev: 1, accountId: 'c', date, amount, status: 'uncleared', voided: false, createdAt: '', updatedAt: '', ...over })
const candidate = (t: Transaction, payeeName: string, extra: Partial<MatchCandidate> = {}): MatchCandidate =>
  ({ transaction: t, payeeName, categoryLabel: 'Food : Groceries', score: 0.88, differences: [], payeeKnown: false, ...extra })

const NEAR = [
  candidate(tx('costco', '2026-10-05', -8400), 'Costco', { differences: ['1 day earlier', '0.12 less'] }),
  candidate(tx('costco2', '2026-10-06', -9140), 'Costco', { score: 0.7, differences: ['7.28 more'] }),
  candidate(tx('gas', '2026-09-29', -8412), 'Costco Gas', { score: 0.66, categoryLabel: 'Transportation', differences: ['7 days earlier', 'payee'], payeeKnown: true })
]
const FAR = [candidate(tx('old', '2026-08-20', -8412), 'Costco', { score: 0, differences: ['47 days earlier'] })]

function response(over: Partial<MatchCandidatesResponse> = {}): MatchCandidatesResponse {
  return {
    account, state: 'proposed', currentId: 'costco', bankName: 'COSTCO WHSE',
    line: { date: '2026-10-06', amount: -8412, payee: 'POS PURCHASE COSTCO WHSE #0123', memo: 'OTTAWA ON' },
    candidates: NEAR, ...over
  }
}

/** The plugin's side: the window's candidates, ±60 days when searching, the whole account when asked, filtered by the search. */
function setup(over: Partial<MatchCandidatesResponse> = {}, failure?: string) {
  const remote = createFakeRemote({})
  const requests: MatchCandidatesRequest[] = []
  remote.bridge.invoke.mockImplementation(async (channel: string, request: MatchCandidatesRequest) => {
    if (channel !== IMPORT_CHANNELS.matchCandidates) throw new Error(`No answer for ${channel}`)
    requests.push(request)
    if (failure) return { ok: false, error: { code: 'NOT_FOUND', message: failure } }
    const base = response(over)
    const all = request.range === 'all' ? [...base.candidates, ...FAR] : base.candidates
    const query = request.query?.toLowerCase()
    const shown = query ? all.filter(c => c.payeeName?.toLowerCase().includes(query) || String(Math.abs(c.transaction.amount) / 100).includes(query)) : all
    return { ok: true, value: { ...base, candidates: shown } }
  })
  ;(window as any).api = remote.bridge
  const close = vi.fn()
  render(<MatchDialog input={{ lineId: 'line1' }} close={close} setBusy={vi.fn()} />)
  return { close, requests }
}

afterEach(() => { delete (window as any).api })

const apply = () => userEvent.click(screen.getByRole('button', { name: 'Apply' }))

describe('the Change Match dialog', () => {
  it('shows the bank line, where it stands, and the transactions it could be, best first, with what differs', async () => {
    const { requests } = setup()
    expect(await screen.findByTestId('bank-line')).toHaveTextContent('Oct 6, 2026 · POS PURCHASE COSTCO WHSE #0123 · Payment 84.12 (OTTAWA ON)')
    expect(screen.getByText(/Proposed as a match/)).toBeInTheDocument()
    expect(requests[0]).toEqual({ lineId: 'line1', range: 'window' })
    const rows = screen.getAllByRole('row').slice(1)
    expect(rows.map(r => within(r).getAllByRole('cell').slice(1).map(c => c.textContent))).toEqual([
      ['Oct 5, 2026', 'Costcoproposed', 'Food : Groceries', '84.00', '1 day earlier · 0.12 less'],
      ['Oct 6, 2026', 'Costco', 'Food : Groceries', '91.40', '7.28 more'],
      ['Sep 29, 2026', 'Costco Gas', 'Transportation', '84.12', '7 days earlier · payee']
    ])
    // The current proposal is chosen to begin with
    expect(screen.getByRole('radio', { name: 'Oct 5, 2026 Costco 84.00 (current)' })).toBeChecked()
  })

  it('applies another transaction, remembering the payee unless told not to', async () => {
    const { close } = setup()
    await userEvent.click(await screen.findByRole('radio', { name: 'Oct 6, 2026 Costco 91.40' }))
    const remember = screen.getByRole('checkbox', { name: 'Remember that “COSTCO WHSE” is Costco' })
    expect(remember).toBeChecked()
    await userEvent.click(remember)
    await apply()
    expect(close).toHaveBeenCalledWith({ kind: 'match', transactionId: 'costco2', rememberPayee: false })
  })

  it('offers to remember the payee only when the bank’s text doesn’t already name it', async () => {
    const { close } = setup()
    await userEvent.click(await screen.findByText('Costco Gas'))                         // a click anywhere on the row
    expect(screen.getByRole('radio', { name: 'Sep 29, 2026 Costco Gas 84.12' })).toBeChecked()
    expect(screen.queryByRole('checkbox', { name: /Remember that/ })).not.toBeInTheDocument()
    await apply()
    expect(close).toHaveBeenCalledWith({ kind: 'match', transactionId: 'gas', rememberPayee: false })
  })

  it('searches beyond the matching window, and the whole account when asked', async () => {
    const { requests } = setup()
    await screen.findByTestId('bank-line')
    await userEvent.type(screen.getByRole('textbox', { name: 'Search payee or amount' }), 'gas')
    await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(2))
    expect(requests.at(-1)).toEqual({ lineId: 'line1', range: 'wide', query: 'gas' })
    await userEvent.clear(screen.getByRole('textbox', { name: 'Search payee or amount' }))
    await userEvent.click(screen.getByRole('checkbox', { name: 'Show transactions from the whole account' }))
    await waitFor(() => expect(screen.getByText('Aug 20, 2026')).toBeInTheDocument())
    expect(requests.at(-1)).toEqual({ lineId: 'line1', range: 'all' })
  })

  it('keeps the chosen transaction chosen while a search hides it', async () => {
    const { close } = setup()
    await userEvent.click(await screen.findByRole('radio', { name: 'Oct 6, 2026 Costco 91.40' }))
    await userEvent.type(screen.getByRole('textbox', { name: 'Search payee or amount' }), 'gas')
    await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(2))
    await apply()
    expect(close).toHaveBeenCalledWith({ kind: 'match', transactionId: 'costco2', rememberPayee: true })
  })

  it('says when nothing could be the bank line', async () => {
    setup({ candidates: [] })
    expect(await screen.findByText('No transaction near this date could be this bank line. Search, or show the whole account.')).toBeInTheDocument()
  })

  describe('for a proposed match', () => {
    it('offers Unmatch, keeping the transaction as it is, and leaving the line out', async () => {
      const { close } = setup()
      await userEvent.click(await screen.findByRole('radio', { name: 'Unmatch: keep my transaction as it is, and add the bank line as a new one' }))
      expect(screen.queryByRole('checkbox', { name: /Remember/ })).not.toBeInTheDocument()
      await apply()
      expect(close).toHaveBeenLastCalledWith({ kind: 'unmatch' })
    })

    it('applies the proposal itself, as Accept does', async () => {
      const { close } = setup()
      await screen.findByTestId('bank-line')
      await apply()
      expect(close).toHaveBeenCalledWith({ kind: 'match', transactionId: 'costco', rememberPayee: true })
    })
  })

  describe('for an accepted match', () => {
    it('says what Unmatch puts back, and has nothing to apply until something else is chosen', async () => {
      const { close } = setup({ state: 'accepted', restores: { date: '2026-10-05', amount: -8400 } })
      expect(await screen.findByText(/Matched to the transaction marked below/)).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled()
      expect(screen.queryByRole('checkbox', { name: /Remember/ })).not.toBeInTheDocument()
      await userEvent.click(screen.getByRole('radio', { name: 'Unmatch: put my transaction back as it was (Oct 5, 2026, 84.00), and add the bank line as a new one' }))
      await apply()
      expect(close).toHaveBeenCalledWith({ kind: 'unmatch' })
    })

    it('says the transaction stays as it is when the user has changed what Accept changed', async () => {
      setup({ state: 'accepted', restores: {} })
      expect(await screen.findByRole('radio', { name: 'Unmatch: keep my transaction as it is now, and add the bank line as a new one' })).toBeInTheDocument()
    })
  })

  describe('for a row added as new', () => {
    it('hides Unmatch, chooses nothing to begin with, and says leaving it out deletes the transaction', async () => {
      const { close } = setup({ state: 'new', currentId: 'added' })
      expect(await screen.findByText('Added as a new transaction.')).toBeInTheDocument()
      expect(screen.getByText('It is one I entered:')).toBeInTheDocument()
      expect(screen.queryByRole('radio', { name: /Unmatch/ })).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled()
      await userEvent.click(screen.getByRole('radio', { name: 'Don’t import this bank line (the transaction added for it is deleted)' }))
      await apply()
      expect(close).toHaveBeenCalledWith({ kind: 'skip' })
    })
  })

  describe('for a line that lost its match', () => {
    it('offers to add the bank line as a new transaction', async () => {
      const { close } = setup({ state: 'unresolved', currentId: undefined })
      expect(await screen.findByText(/It lost its match/)).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled()
      await userEvent.click(screen.getByRole('radio', { name: 'Add the bank line as a new transaction' }))
      await apply()
      expect(close).toHaveBeenCalledWith({ kind: 'unmatch' })
    })
  })

  it('says why when the list can’t be had, and closes with nothing', async () => {
    const { close } = setup({}, 'That bank line is no longer there.')
    expect(await screen.findByText('That bank line is no longer there.')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(close).toHaveBeenCalledWith()
  })

  it('Cancel closes with nothing', async () => {
    const { close } = setup()
    await screen.findByTestId('bank-line')
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(close).toHaveBeenCalledWith()
  })
})
