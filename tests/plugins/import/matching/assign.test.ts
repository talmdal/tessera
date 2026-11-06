// @vitest-environment node
// One line, one transaction: which transactions may be proposed, and how lines and transactions are paired, best
// pair first, the same way every time.
import { describe, expect, it } from 'vitest'
import type { Transaction } from '@tessera/accounts-api'
import { assign, isCandidate, windowOf } from '../../../../plugins/import/src/privileged/matching/assign'
import type { MatchLine, MatchTarget } from '../../../../plugins/import/src/privileged/matching/score'

const line = (date: string, amount: number, payee?: string, extra: Partial<MatchLine> = {}): MatchLine => ({ date, amount, ...(payee && { payee }), ...extra })
const target = (id: string, date: string, amount: number, payeeName?: string, extra: Partial<MatchTarget> = {}): MatchTarget =>
  ({ id, date, amount, ...(payeeName && { payeeName }), ...extra })
const pairs = (lines: MatchLine[], targets: MatchTarget[], aliases?: Map<string, string>) =>
  assign(lines, targets, 'CAD', aliases).map(p => [p.line, p.transactionId])

describe('candidates', () => {
  const tx = (over: Partial<Transaction>) => ({ id: 't', voided: false, status: 'uncleared' as const, ...over })
  it('are open, unlinked transactions no earlier import is waiting on', () => {
    expect(isCandidate(tx({}), new Set())).toBe(true)
    expect(isCandidate(tx({ status: 'cleared' }), new Set())).toBe(true)
    expect(isCandidate(tx({ status: 'electronic' }), new Set())).toBe(true)
    expect(isCandidate(tx({ voided: true }), new Set())).toBe(false)
    expect(isCandidate(tx({ status: 'reconciled' }), new Set())).toBe(false)
    expect(isCandidate(tx({ externalId: 'FIT1' }), new Set())).toBe(false)
    expect(isCandidate(tx({}), new Set(['t']))).toBe(false)
  })

  it('are read once, over a window wide enough for every line, cheques included', () => {
    expect(windowOf([line('2026-10-06', -1), line('2026-10-31', -1, undefined, { userDate: '2026-10-29' })]))
      .toEqual({ from: '2026-07-08', to: '2026-11-03' })
    expect(windowOf([])).toBeUndefined()
  })
})

describe('assigning', () => {
  it('pairs each line with at most one transaction, and each transaction with at most one line', () => {
    // Both lines want the Costco entry; the better pair wins it, and the other line goes to the next best
    const lines = [line('2026-10-06', -8412, 'COSTCO WHSE #0123'), line('2026-10-05', -8412, 'COSTCO WHSE #0456')]
    const targets = [target('costco', '2026-10-05', -8412, 'Costco'), target('costco2', '2026-10-02', -8412, 'Costco')]
    expect(pairs(lines, targets)).toEqual([[0, 'costco2'], [1, 'costco']])
  })

  it('gives a transaction wanted by two lines to the better one, and adds the other as new', () => {
    const lines = [line('2026-10-03', -5750, 'THE KEG #12'), line('2026-10-03', -5000, 'THE KEG #12')]
    expect(pairs(lines, [target('keg', '2026-10-03', -5000, 'The Keg')])).toEqual([[1, 'keg']])
  })

  it('pairs identical lines with identical entries in order, not both with the first', () => {
    const coffee = () => line('2026-10-29', -475, 'TIM HORTONS #4021')
    const targets = [target('first', '2026-10-29', -475, 'Tim Hortons'), target('second', '2026-10-29', -475, 'Tim Hortons')]
    expect(pairs([coffee(), coffee()], targets)).toEqual([[0, 'first'], [1, 'second']])
    // One coffee on the statement, two entered: the first entered is taken
    expect(pairs([coffee()], targets)).toEqual([[0, 'first']])
  })

  it('breaks ties the same way every run, whatever order the pairs are found in', () => {
    const lines = [line('2026-10-10', -2000, 'SHOP'), line('2026-10-10', -2000, 'SHOP'), line('2026-10-10', -2000, 'SHOP')]
    const targets = ['a', 'b', 'c'].map(id => target(id, '2026-10-10', -2000, 'Shop'))
    const first = pairs(lines, targets)
    for (let i = 0; i < 5; i++) expect(pairs(lines, targets)).toEqual(first)
    expect(first).toEqual([[0, 'a'], [1, 'b'], [2, 'c']])
  })

  it('prefers the closer date when scores tie', () => {
    // Without payees, two days and three days apart both score D = 0.9: the two-day one wins
    const lines = [line('2026-10-10', -2000)]
    expect(pairs(lines, [target('three', '2026-10-07', -2000), target('two', '2026-10-08', -2000)])).toEqual([[0, 'two']])
  })

  it('only looks inside the window, widened for a cheque whose number matches', () => {
    const cheque = line('2026-11-20', -30000, 'CHQ 104', { number: '104' })
    expect(pairs([cheque], [target('rent', '2026-10-02', -30000, 'Landlord', { number: '104' })])).toEqual([[0, 'rent']])
    expect(pairs([cheque], [target('rent', '2026-10-02', -30000, 'Landlord', { number: '105' })])).toEqual([])
    expect(pairs([line('2026-11-20', -30000, 'RENT')], [target('rent', '2026-10-02', -30000, 'Rent')])).toEqual([])
  })

  it('uses saved payee aliases', () => {
    // A 10% difference needs the payees to agree, which only the alias says
    const lines = [line('2026-10-27', -2640, 'AMZN MKTP CA*2K3L91')]
    const targets = [target('amazon', '2026-10-25', -2399, 'Online shopping')]
    expect(pairs(lines, targets)).toEqual([])
    expect(pairs(lines, targets, new Map([['amzn mktp', 'Online shopping']]))).toEqual([[0, 'amazon']])
  })

  it('returns proposals in line order, with their scores', () => {
    const proposals = assign([line('2026-10-07', -8000, 'HYDRO ONE NETWORKS'), line('2026-10-01', -100, 'NOTHING')],
      [target('hydro', '2026-10-07', -8000, 'Hydro One')], 'CAD')
    expect(proposals).toEqual([{ line: 0, transactionId: 'hydro', score: expect.any(Number) }])
    expect(proposals[0].score).toBeGreaterThan(0.85)
  })
})
