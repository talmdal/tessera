// The import plugin's amounts are drawn in the Amounts and figures font role.
import { screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Account, Transaction } from '@tessera/accounts-api'
import { IMPORT_CHANNELS, type MatchCandidatesResponse } from '@tessera/import-api'
import { Amount } from '../../../../plugins/import/src/renderer/display'
import MatchDialog from '../../../../plugins/import/src/renderer/MatchDialog'
import { createFakeRemote } from '../../../helpers/fakeBridge'
import { isFigure, renderInShell } from '../../../helpers/fonts'

const account: Account = {
  id: 'c', rev: 1, name: 'Chequing', type: 'chequing', subLedgerId: null, currency: 'CAD', openingDate: '2026-01-01',
  openingBalance: 0, order: 0, closed: false
}
const costco: Transaction = { id: 'costco', rev: 1, accountId: 'c', date: '2026-10-05', amount: -8400, status: 'uncleared', voided: false, createdAt: '', updatedAt: '' }

afterEach(() => { delete (window as any).api })

describe('the import plugin and the font roles', () => {
  it('draws an amount as a figure, and in the error colour when negative', () => {
    renderInShell(<Amount minor={-1234} currency="CAD" />)

    const amount = screen.getByText('-12.34')
    expect(isFigure(amount)).toBe(true)
    // The shell theme's light error colour, #d32f2f: the role changes the font, not the colour
    expect(getComputedStyle(amount).color).toBe('rgb(211, 47, 47)')
  })

  it("draws the Change Match dialog's amounts as figures", async () => {
    const remote = createFakeRemote({})
    const response: MatchCandidatesResponse = {
      account, state: 'proposed', currentId: 'costco', bankName: 'COSTCO WHSE',
      line: { date: '2026-10-06', amount: -8412, payee: 'POS PURCHASE COSTCO WHSE #0123' },
      candidates: [{ transaction: costco, payeeName: 'Costco', categoryLabel: 'Food', score: 0.9, differences: [], payeeKnown: false }]
    }
    remote.bridge.invoke.mockImplementation(async (channel: string) => {
      if (channel !== IMPORT_CHANNELS.matchCandidates) throw new Error(`No answer for ${channel}`)
      return { ok: true, value: response }
    })
    ;(window as any).api = remote.bridge
    renderInShell(<MatchDialog input={{ lineId: 'line1' }} close={vi.fn()} setBusy={vi.fn()} />)

    const table = await screen.findByRole('table')
    expect(isFigure(within(table).getByText('84.00'))).toBe(true)
  })
})
