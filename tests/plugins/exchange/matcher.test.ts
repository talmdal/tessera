// @vitest-environment node
// The matcher, as a pure function: the four tiers, the scoring, and the transfer pairing. No book, no service.
import { describe, expect, it } from 'vitest'
import type { Transaction } from '@tessera/accounts-api'
import {
  daysBetween, matchStatement, pairTransfers, payeesCompatible, rankCandidates, scoreCandidate, shiftDate,
  type ExistingRow, type MatchOptions
} from '../../../plugins/exchange/src/privileged/matcher'
import { row } from './harness'

const options = (over: Partial<MatchOptions> = {}): MatchOptions =>
  ({ dateWindow: 3, mergeManualEntries: true, transactionIds: true, ...over })

let counter = 0
function existing(over: Partial<ExistingRow> = {}): ExistingRow {
  counter += 1
  const base: Transaction = {
    id: `t${counter}`, accountId: 'acc', date: '2026-11-03', amount: -14200,
    status: 'uncleared', voided: false,
    createdAt: '2026-11-03T00:00:00.000Z', updatedAt: '2026-11-03T00:00:00.000Z', rev: 1
  }
  return { ...base, payeeName: 'Hydro Ottawa', ...over }
}

describe('dates', () => {
  it('counts whole calendar days, in both directions, across a month end', () => {
    expect(daysBetween('2026-11-03', '2026-11-03')).toBe(0)
    expect(daysBetween('2026-11-03', '2026-10-31')).toBe(3)
    expect(daysBetween('2026-10-31', '2026-11-03')).toBe(-3)
    expect(shiftDate('2026-02-28', 1)).toBe('2026-03-01')
    expect(shiftDate('2026-01-01', -1)).toBe('2025-12-31')
  })
})

describe('payee compatibility', () => {
  it('ignores case and punctuation', () => {
    expect(payeesCompatible('HYDRO OTTAWA', 'Hydro Ottawa')).toBe('exact')
    expect(payeesCompatible('SQ *Daily Grind', 'SQ Daily Grind')).toBe('exact')
  })

  it('treats a missing payee on either side as compatible', () => {
    expect(payeesCompatible(undefined, 'Hydro')).toBe('empty')
    expect(payeesCompatible('Hydro', '')).toBe('empty')
  })

  it('matches a truncated name by prefix only when the source truncates at that length', () => {
    // 'Canadian Tire S' is exactly 15 characters: a standard-QIF writer could not have produced a longer one
    expect(payeesCompatible('Canadian Tire S', 'Canadian Tire Store', 15)).toBe('prefix')
    // The same pair from a format that does not truncate is two different payees
    expect(payeesCompatible('Canadian Tire S', 'Canadian Tire Store')).toBe(false)
    // And a short name is never a prefix, however the file was written: "Hydro" must not absorb "Hydro Ottawa"
    expect(payeesCompatible('Hydro', 'Hydro Ottawa', 15)).toBe(false)
  })
})

describe('scoring a candidate', () => {
  it('does not hold a transfer’s payee against it: the other side named it, not the bank', () => {
    const incoming = { date: '2026-11-10', amount: 50000, payee: 'From chequing' }
    const transfer = { date: '2026-11-10', amount: 50000, payeeName: 'To savings', transferAccountId: 'chq' }
    const plain = { date: '2026-11-10', amount: 50000, payeeName: 'To savings' }
    expect(scoreCandidate(incoming, transfer, { dateWindow: 3 })).toBeDefined()
    expect(scoreCandidate(incoming, plain, { dateWindow: 3 })).toBeUndefined()
  })

  it('refuses anything whose amount differs, however close everything else is', () => {
    expect(scoreCandidate(row({ amount: -14201 }), existing(), options())).toBeUndefined()
  })

  it('refuses anything outside the window, and allows the edge', () => {
    expect(scoreCandidate(row({ date: '2026-11-06' }), existing(), options())).toBeDefined()
    expect(scoreCandidate(row({ date: '2026-11-07' }), existing(), options())).toBeUndefined()
    expect(scoreCandidate(row({ date: '2026-11-04' }), existing(), options({ dateWindow: 0 }))).toBeUndefined()
  })

  it('prefers an exact date and payee, and says why in the user’s words', () => {
    const exact = scoreCandidate(row(), existing(), options())!
    const nearby = scoreCandidate(row({ date: '2026-11-05' }), existing(), options())!
    const nameless = scoreCandidate(row({ payee: undefined }), existing(), options())!

    expect(exact.score).toBeGreaterThan(nearby.score)
    expect(exact.score).toBeGreaterThan(nameless.score)
    expect(exact.reason).toBe('Same amount and payee, the same day')
    expect(nearby.reason).toBe('Same amount and payee, 2 days apart')
  })

  it('counts a shared cheque number towards the match', () => {
    const withNumber = scoreCandidate(row({ number: '1042' }), existing({ number: '1042' }), options())!
    const without = scoreCandidate(row(), existing(), options())!
    expect(withNumber.score).toBeGreaterThan(without.score)
    expect(withNumber.reason).toMatch(/Same amount and number/)
  })
})

describe('tier 1: the source’s own reference', () => {
  it('calls an identical reference a duplicate, and a restated one a conflict', () => {
    const book = [existing({ externalId: 'FIT-1' }), existing({ externalId: 'FIT-2', amount: -500 })]
    const { proposals } = matchStatement(
      [row({ externalId: 'FIT-1' }), row({ externalId: 'FIT-2', amount: -600 })],
      book, options())

    expect(proposals[0]).toMatchObject({ disposition: 'duplicate', existingId: book[0].id, matchedBy: 'externalId' })
    expect(proposals[1]).toMatchObject({ disposition: 'conflict', existingId: book[1].id, matchedBy: 'externalId' })
    expect(proposals[1].reason).toMatch(/amount or date has changed/)
  })

  it('keeps only the first of two rows sharing a reference, and says so', () => {
    const { proposals, duplicateIdWarnings } = matchStatement(
      [row({ externalId: 'FIT-1' }), row({ externalId: 'FIT-1', date: '2026-11-04' })], [], options())

    expect(proposals[0].disposition).toBe('new')
    expect(proposals[1].disposition).toBe('duplicate')
    expect(duplicateIdWarnings).toEqual([{ index: 1, externalId: 'FIT-1' }])
  })

  it('resolves a correction to the transaction it names', () => {
    const book = [existing({ externalId: 'FIT-1' })]
    const { proposals } = matchStatement([
      row({ externalId: 'FIT-9', corrects: { externalId: 'FIT-1', action: 'replace' }, amount: -15000 }),
      row({ externalId: 'FIT-8', corrects: { externalId: 'FIT-1', action: 'delete' } })
    ], book, options())

    expect(proposals[0]).toMatchObject({ disposition: 'conflict', existingId: book[0].id })
    expect(proposals[1].reason).toMatch(/voids it/)
  })

  it('does not use references at all for a format that carries none', () => {
    const book = [existing({ externalId: 'FIT-1' })]
    // The same reference, but the format says its rows have no stable ids, so tier 1 is skipped — and the
    // candidate is excluded from the heuristic too, because it already belongs to some source
    const { proposals } = matchStatement([row({ externalId: 'FIT-1' })], book, options({ transactionIds: false }))
    expect(proposals[0].disposition).toBe('new')
  })
})

describe('tiers 2 and 3: near matches and the merge', () => {
  it('merges a bank row into the uncleared one the user typed days earlier', () => {
    const book = [existing({ date: '2026-11-01' })]
    const { proposals } = matchStatement([row({ date: '2026-11-03', externalId: 'FIT-1' })], book, options())

    expect(proposals[0]).toMatchObject({ disposition: 'merge', existingId: book[0].id, matchedBy: 'heuristic' })
    expect(proposals[0].reason).toBe('Same amount and payee, 2 days apart')
  })

  it('leaves a row outside the window as new', () => {
    const { proposals } = matchStatement([row({ date: '2026-11-30' })], [existing()], options())
    expect(proposals[0]).toMatchObject({ disposition: 'new', matchedBy: 'none' })
  })

  it('declines to choose between two equally good candidates, and says why', () => {
    const { proposals } = matchStatement([row()], [existing(), existing()], options())
    expect(proposals[0].disposition).toBe('new')
    expect(proposals[0].reason).toMatch(/equally like this one/)
  })

  it('never merges into a reconciled transaction: that is a conflict to look at', () => {
    const book = [existing({ status: 'reconciled' })]
    const { proposals } = matchStatement([row()], book, options())
    expect(proposals[0]).toMatchObject({ disposition: 'conflict', existingId: book[0].id })
    expect(proposals[0].reason).toMatch(/reconciled/)
  })

  it('skips voided transactions, which are not in any balance', () => {
    const { proposals } = matchStatement([row()], [existing({ voided: true })], options())
    expect(proposals[0].disposition).toBe('new')
  })

  it('gives each row its own candidate rather than letting two claim one', () => {
    const book = [existing()]
    const { proposals } = matchStatement([row(), row({ date: '2026-11-04' })], book, options())
    const merged = proposals.filter(p => p.disposition === 'merge')
    expect(merged).toHaveLength(1)
    expect(proposals.filter(p => p.disposition === 'new')).toHaveLength(1)
  })

  it('enters a row as new, rather than merging, when merging is switched off', () => {
    const { proposals } = matchStatement([row()], [existing()], options({ mergeManualEntries: false }))
    expect(proposals[0].disposition).toBe('new')
  })

  it('matches a truncated payee by prefix when the source truncates', () => {
    const book = [existing({ payeeName: 'Canadian Tire Store' })]
    const incoming = [row({ payee: 'Canadian Tire S' })]
    expect(matchStatement(incoming, book, options({ transactionIds: false })).proposals[0].disposition).toBe('new')
    expect(matchStatement(incoming, book, options({ transactionIds: false, truncatedAt: 15 })).proposals[0].disposition).toBe('merge')
  })
})

describe('candidates for the Change… dialog', () => {
  it('ranks the current match first, and flags one whose amount differs', () => {
    const book = [
      existing({ id: 'far', date: '2026-10-01', amount: -999 }),
      existing({ id: 'typo', amount: -14220 }),
      existing({ id: 'exact' })
    ]
    const ranked = rankCandidates(row(), book, { dateWindow: 30, currentId: 'typo' })

    expect(ranked[0].transaction.id).toBe('typo')
    expect(ranked[0].current).toBe(true)
    expect(ranked[0].caution).toBe('amountDiffers')
    expect(ranked[1].transaction.id).toBe('exact')
    expect(ranked[1].caution).toBeUndefined()
  })

  it('offers a reconciled transaction, with the caution that matching it needs care', () => {
    const ranked = rankCandidates(row(), [existing({ status: 'reconciled' })], { dateWindow: 30 })
    expect(ranked[0].caution).toBe('reconciled')
  })

  it('offers transactions the matcher would have refused, which is the point of matching by hand', () => {
    const ranked = rankCandidates(row(), [existing({ amount: -14202, payeeName: 'Something else' })], { dateWindow: 30 })
    expect(ranked).toHaveLength(1)
    expect(ranked[0].reason).toMatch(/same day/)
  })
})

describe('pairing transfers', () => {
  const pairable = (key: string, accountId: string, amount: number, over: Record<string, unknown> = {}) =>
    ({ key, accountId, date: '2026-11-03', amount, ...over })

  it('pairs the two sides the file named, across accounts', () => {
    const pairs = pairTransfers([
      pairable('a', 'chq', -50000, { transferAccountId: 'sav' }),
      pairable('b', 'sav', 50000, { transferAccountId: 'chq' })
    ], 3)
    expect(pairs.get('a')).toBe('b')
    expect(pairs.get('b')).toBe('a')
  })

  it('pairs within the date window, since the two sides post on different days', () => {
    const pairs = pairTransfers([
      pairable('a', 'chq', -50000, { transferAccountId: 'sav' }),
      pairable('b', 'sav', 50000, { date: '2026-11-05' })
    ], 3)
    expect(pairs.get('a')).toBe('b')
  })

  it('declines an ambiguous pair rather than guessing', () => {
    const pairs = pairTransfers([
      pairable('a', 'chq', -50000, { transferAccountId: 'sav' }),
      pairable('b', 'sav', 50000),
      pairable('c', 'sav', 50000)
    ], 3)
    expect(pairs.size).toBe(0)
  })

  it('does not pair a row with itself, or with one in the same account', () => {
    const pairs = pairTransfers([
      pairable('a', 'chq', -50000, { transferAccountId: 'chq' }),
      pairable('b', 'chq', 50000)
    ], 3)
    expect(pairs.size).toBe(0)
  })
})
