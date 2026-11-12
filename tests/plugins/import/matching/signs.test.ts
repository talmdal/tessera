// @vitest-environment node
// The sign cross-check's evidence and decision (matching/signs.ts): each piece, each way, at its thresholds; when to
// ask; the words; and the source's profile (signRecords.ts).
import { describe, expect, it } from 'vitest'
import {
  balanceSays, bothWays, describeEvidence, outShare, profileSays, shouldAsk, typeSays, type SignEvidence
} from '../../../../plugins/import/src/privileged/matching/signs'
import { PROFILE_CAP, addToProfile } from '../../../../plugins/import/src/privileged/signRecords'

const money = (minor: number) => (minor / 100).toFixed(2)
const date = (iso: string) => iso

describe('matching and earlier imports, each way', () => {
  it('say reversed with 3 or more pairs reversed, three times as many as as read; 2 is not enough', () => {
    expect(bothWays(0, 3)).toBe('reversed')
    expect(bothWays(1, 3)).toBe('reversed')
    expect(bothWays(0, 2)).toBeUndefined()
    expect(bothWays(2, 5)).toBeUndefined()                                      // not three times as many
    expect(bothWays(2, 6)).toBe('reversed')
  })

  it('say as read the other way round, and nothing when there is nothing', () => {
    expect(bothWays(6, 0)).toBe('asRead')
    expect(bothWays(6, 2)).toBe('asRead')
    expect(bothWays(0, 0)).toBeUndefined()
  })
})

describe('the bank’s balance', () => {
  it('says as read when the lines bring the account to it, and reversed when only the reversed lines do', () => {
    expect(balanceSays(467780, 156394, 624174)).toBe('asRead')
    expect(balanceSays(467780, -156394, -624174)).toBe('reversed')                // a format that reads one way reads both
  })

  it('says nothing unless it is exact: an account whose history is incomplete, or a balance that fits both', () => {
    expect(balanceSays(467780, 156394, 624175)).toBeUndefined()
    expect(balanceSays(0, 0, 0)).toBeUndefined()
  })
})

describe('the account’s type', () => {
  const charges = (n: number) => Array(n).fill(-1000)
  const payments = (n: number) => Array(n).fill(5000)

  it('says reversed for a card whose lines are more than two thirds payments', () => {
    expect(typeSays('creditCard', [...payments(6), ...charges(2)])).toMatchObject({ kind: 'type', says: 'reversed', strength: 'weak', raising: 6, lines: 8, liability: true })
    expect(typeSays('lineOfCredit', [...payments(3), ...charges(1)])).toMatchObject({ says: 'reversed' })
    expect(typeSays('creditCard', [...payments(2), ...charges(1)])).toBeUndefined()   // exactly two thirds
    expect(typeSays('creditCard', [...charges(6), ...payments(2)])).toBeUndefined()
  })

  it('says reversed for a chequing or cash account more than 80% money in', () => {
    expect(typeSays('chequing', [...payments(14), ...charges(3)])).toMatchObject({ says: 'reversed', liability: false })
    expect(typeSays('cash', [...payments(9), ...charges(1)])).toMatchObject({ says: 'reversed' })
    expect(typeSays('chequing', [...payments(8), ...charges(2)])).toBeUndefined()     // exactly 80%
  })

  it('says nothing for savings, investments, loans and the rest, where mostly one way is normal, nor for fewer than 3 lines', () => {
    for (const type of ['savings', 'investment', 'retirement', 'loan', 'mortgage', 'otherAsset', 'otherLiability'] as const) {
      expect(typeSays(type, payments(10)), type).toBeUndefined()
    }
    expect(typeSays('creditCard', payments(2))).toBeUndefined()
    expect(typeSays('creditCard', [...payments(2), 0, 0])).toBeUndefined()             // zeros don't count
  })
})

describe('the source’s profile', () => {
  it('says reversed when files were mostly money out and this one is mostly money in, or the other way round', () => {
    expect(profileSays({ outShare: 0.82, lines: 17 }, [...Array(8).fill(100), -1, -1])).toMatchObject({ kind: 'profile', says: 'reversed', wasOut: 0.82, isOut: 0.2 })
    expect(profileSays({ outShare: 0.2, lines: 10 }, [-1, -1, -1, 1])).toMatchObject({ says: 'reversed' })
  })

  it('says nothing for a mixed source, a mixed file, few lines seen, or a file too short', () => {
    expect(profileSays({ outShare: 0.6, lines: 40 }, [1, 1, 1, 1])).toBeUndefined()
    expect(profileSays({ outShare: 0.9, lines: 40 }, [1, 1, -1, -1])).toBeUndefined()
    expect(profileSays({ outShare: 0.9, lines: 4 }, [1, 1, 1, 1])).toBeUndefined()
    expect(profileSays({ outShare: 0.9, lines: 40 }, [1, 1])).toBeUndefined()
    expect(profileSays(undefined, [1, 1, 1])).toBeUndefined()
    expect(outShare([-1, -1, 1, 0])).toBeCloseTo(2 / 3)
  })

  it('is kept as a share weighted by lines, the older lines counting less past the cap', () => {
    expect(addToProfile(undefined, 14, 17)).toEqual({ outShare: 14 / 17, lines: 17 })
    expect(addToProfile({ outShare: 0.5, lines: 10 }, 10, 10)).toEqual({ outShare: 0.75, lines: 20 })
    const full = addToProfile({ outShare: 1, lines: PROFILE_CAP }, 0, 100)
    expect(full).toEqual({ outShare: (PROFILE_CAP - 100) / PROFILE_CAP, lines: PROFILE_CAP })
    expect(addToProfile({ outShare: 0.3, lines: 7 }, 0, 0)).toEqual({ outShare: 0.3, lines: 7 })
  })
})

describe('deciding', () => {
  const strong = (says: 'asRead' | 'reversed'): SignEvidence => ({ kind: 'matching', says, strength: 'strong', asRead: says === 'asRead' ? 3 : 0, reversed: says === 'reversed' ? 3 : 0 })
  const weak: SignEvidence = { kind: 'type', says: 'reversed', strength: 'weak', raising: 6, lines: 8, liability: true }

  it('asks on strong evidence for reversed, whatever else there is', () => {
    expect(shouldAsk([strong('reversed')])).toBe(true)
    expect(shouldAsk([strong('reversed'), strong('asRead')])).toBe(true)
  })

  it('asks on weak evidence for reversed, unless strong evidence says as read', () => {
    expect(shouldAsk([weak])).toBe(true)
    expect(shouldAsk([weak, strong('asRead')])).toBe(false)
  })

  it('imports as read on nothing, or on evidence for as read only', () => {
    expect(shouldAsk([])).toBe(false)
    expect(shouldAsk([strong('asRead')])).toBe(false)
  })
})

describe('the evidence in words', () => {
  it('says why, for the dialog', () => {
    expect(describeEvidence({ kind: 'matching', says: 'reversed', strength: 'strong', asRead: 0, reversed: 3 }, money, date))
      .toBe('Reversed, 3 lines match transactions you entered; as they are, none do.')
    expect(describeEvidence({ kind: 'earlier', says: 'reversed', strength: 'strong', asRead: 1, reversed: 4 }, money, date))
      .toBe('Reversed, 4 lines look like lines imported before; as they are, only 1 does.')
    expect(describeEvidence({ kind: 'balance', says: 'reversed', strength: 'strong', balance: 624174, asOf: '2026-11-10' }, money, date))
      .toBe('Reversed, they bring the account to the bank’s balance on 2026-11-10 (6241.74); as they are, they don’t.')
    expect(describeEvidence({ kind: 'type', says: 'reversed', strength: 'weak', raising: 6, lines: 8, liability: true }, money, date))
      .toBe('6 of its 8 lines would lower what you owe, and only 2 would add to it.')
    expect(describeEvidence({ kind: 'type', says: 'reversed', strength: 'weak', raising: 14, lines: 17, liability: false }, money, date))
      .toBe('14 of its 17 lines would be money in, and only 3 money out.')
    expect(describeEvidence({ kind: 'profile', says: 'reversed', strength: 'weak', wasOut: 0.82, isOut: 0.2 }, money, date))
      .toBe('Files from this source have been 82% money out; this one is 20%.')
  })
})
