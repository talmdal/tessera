// @vitest-environment node
// The matcher's scores, table by table, and the worked examples of docs/import-manager-design.md ("Scores"), exactly.
import { describe, expect, it } from 'vitest'
import {
  addDays, amountScore, bestDate, chequeMatches, dateScore, dayNumber, differences, looseScore, payeeScore, prepareLine,
  prepareTarget, scorePair, type MatchLine, type MatchTarget
} from '../../../../plugins/import/src/privileged/matching/score'

const line = (over: Partial<MatchLine> = {}): MatchLine => ({ date: '2026-10-06', amount: -8412, payee: 'COSTCO WHSE #0123', ...over })
const target = (over: Partial<MatchTarget> = {}): MatchTarget => ({ id: 't', date: '2026-10-05', amount: -8412, payeeName: 'Costco', ...over })
const score = (l: Partial<MatchLine>, t: Partial<MatchTarget>, aliases?: Map<string, string>) =>
  scorePair(prepareLine(line(l), aliases), prepareTarget(target(t)), 'CAD')

describe('dates', () => {
  it('scores the days between the bank’s date and the transaction’s, as the table says', () => {
    const table: [number, number | undefined][] = [
      [0, 1], [1, 0.9], [3, 0.9], [4, 0.7], [7, 0.7], [8, 0.4], [14, 0.4], [15, undefined],
      [-1, 0.7], [-3, 0.7], [-4, undefined], [90, undefined]
    ]
    for (const [days, expected] of table) expect(dateScore(days, false), `${days} days`).toBe(expected)
  })

  it('lets a cheque whose number matches clear up to 90 days after it was written', () => {
    expect(dateScore(15, true)).toBe(0.6)
    expect(dateScore(90, true)).toBe(0.6)
    expect(dateScore(91, true)).toBeUndefined()
    expect(dateScore(10, true)).toBe(0.6)                              // never less for a cheque than for anything else
    expect(dateScore(2, true)).toBe(0.9)
    expect(dateScore(-4, true)).toBeUndefined()                        // written after it cleared: no
  })

  it('uses the date the user made the purchase when that is closer', () => {
    expect(bestDate({ date: '2026-10-06', userDate: '2026-10-05' }, '2026-10-05', false)).toEqual({ score: 1, days: 0 })
    expect(bestDate({ date: '2026-10-06' }, '2026-10-05', false)).toEqual({ score: 0.9, days: 1 })
    expect(bestDate({ date: '2026-10-30', userDate: '2026-10-28' }, '2026-10-01', false)).toBeUndefined()
  })

  it('counts days across months and years', () => {
    expect(dayNumber('2027-01-01') - dayNumber('2026-12-31')).toBe(1)
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
    expect(addDays('2024-03-01', -1)).toBe('2024-02-29')
  })
})

describe('amounts', () => {
  it('scores the difference, as the table says', () => {
    expect(amountScore(-8412, -8412, 'CAD')).toBe(1)
    expect(amountScore(-8412, -8400, 'CAD')).toBe(0.85)              // within a dollar
    expect(amountScore(-100000, -99100, 'CAD')).toBe(0.85)           // within 1%, though more than a dollar
    expect(amountScore(-10000, -9600, 'CAD')).toBe(0.7)              // within 5%
    expect(amountScore(-5750, -5000, 'CAD')).toBe(0.45)              // a tip: within 25%
    expect(amountScore(-5750, -4000, 'CAD')).toBeUndefined()         // too far apart
  })

  it('never pairs money in with money out', () => {
    expect(amountScore(-5000, 5000, 'CAD')).toBeUndefined()
    expect(amountScore(5000, -5000, 'CAD')).toBeUndefined()
  })

  it('takes one major unit in the currency’s own digits', () => {
    expect(amountScore(-5000, -4900, 'JPY')).toBe(0.7)               // 100 yen is not one yen
    expect(amountScore(-5000, -4999, 'JPY')).toBe(0.85)
  })
})

describe('payees', () => {
  it('scores how alike the names are, and is undefined without a payee on both sides', () => {
    expect(payeeScore(prepareLine(line()), prepareTarget(target()))).toBeCloseTo(0.909, 3)
    expect(payeeScore(prepareLine(line({ payee: undefined })), prepareTarget(target()))).toBeUndefined()
    expect(payeeScore(prepareLine(line()), prepareTarget(target({ payeeName: undefined })))).toBeUndefined()
  })

  it('scores 1 for the payee a saved alias names, whatever the names look like', () => {
    const aliases = new Map([['amzn mktp', 'Amazon']])
    expect(payeeScore(prepareLine(line({ payee: 'AMZN MKTP CA*2K3L91' }), aliases), prepareTarget(target({ payeeName: 'amazon' })))).toBe(1)
    expect(payeeScore(prepareLine(line({ payee: 'AMZN MKTP CA*2K3L91' }), aliases), prepareTarget(target({ payeeName: 'Costco' })))).toBeLessThan(0.5)
  })
})

describe('the combined score and the proposal rule', () => {
  it('weighs the amount, date and payee, or only the amount and date without a payee', () => {
    expect(score({}, {})!.score).toBeCloseTo(0.45 + 0.3 * 0.9 + 0.25 * 0.909091, 5)
    expect(score({ payee: undefined }, {})!.score).toBeCloseTo(0.6 + 0.4 * 0.9, 6)
  })

  it('adds the cheque bonus when the numbers match, up to 1', () => {
    expect(chequeMatches({ number: '000104' }, { number: '104' })).toBe(true)
    expect(chequeMatches({ number: '104' }, { number: undefined })).toBe(false)
    const plain = score({ date: '2026-10-05', payee: undefined, number: '104' }, { number: undefined })!
    const cheque = score({ date: '2026-10-05', payee: undefined, number: '104' }, { number: '104' })!
    expect(plain.score).toBe(1)
    expect(cheque.score).toBe(1)
    expect(score({ date: '2026-10-25', payee: 'CHQ 104', number: '104' }, { number: '104', payeeName: 'Landlord' })!.score).toBeCloseTo(0.45 + 0.3 * 0.6 + 0.15, 6)
  })

  it('proposes from 0.65, when the amount is exact or the payees agree', () => {
    // Different purchases of similar amounts in one week: a good enough score, but nothing says they are the same
    const unlike = score({ date: '2026-10-05', amount: -5000, payee: 'LOBLAWS #1001' }, { amount: -4990, payeeName: 'Shoppers Drug Mart' })!
    expect(unlike.score).toBeGreaterThanOrEqual(0.65)
    expect(unlike.proposed).toBe(false)
    // The same amount, though the payees differ
    expect(score({ date: '2026-10-05', payee: 'LOBLAWS #1001' }, { payeeName: 'Shoppers Drug Mart' })!.proposed).toBe(true)
    // The payees agree, though the amounts differ
    expect(score({ amount: -5750, payee: 'THE KEG #12' }, { amount: -5000, payeeName: 'The Keg' })!.proposed).toBe(true)
    // Too low, whatever else
    expect(score({ date: '2026-10-19', amount: -5750, payee: 'THE KEG' }, { amount: -5000, payeeName: 'The Keg' })!.proposed).toBe(false)
  })

  it('says when a transaction isn’t a candidate at all', () => {
    expect(score({ date: '2026-11-30' }, {})).toBeUndefined()
    expect(score({ amount: 8412 }, {})).toBeUndefined()
    expect(looseScore(prepareLine(line({ date: '2026-11-30' })), prepareTarget(target()), 'CAD')).toBe(0)
  })

  it('gives the worked examples of the design note', () => {
    const examples: [Partial<MatchLine>, Partial<MatchTarget>, { A: number, D: number, P?: number, score: number, proposed: boolean }][] = [
      [{ date: '2026-10-06', payee: 'COSTCO WHSE #0123', amount: -8412 }, { date: '2026-10-05', payeeName: 'Costco', amount: -8412 }, { A: 1, D: 0.9, P: 0.91, score: 0.95, proposed: true }],
      [{ date: '2026-10-06', payee: 'COSTCO WHSE #0123', amount: -8412 }, { date: '2026-10-05', payeeName: 'Costco', amount: -8400 }, { A: 0.85, D: 0.9, P: 0.91, score: 0.88, proposed: true }],
      [{ date: '2026-10-03', payee: 'THE KEG #12', amount: -5750 }, { date: '2026-10-03', payeeName: 'The Keg', amount: -5000 }, { A: 0.45, D: 1, P: 1, score: 0.75, proposed: true }],
      [{ date: '2026-10-03', payee: 'LOBLAWS #1001', amount: -5750 }, { date: '2026-10-03', payeeName: 'The Keg', amount: -5000 }, { A: 0.45, D: 1, P: 0, score: 0.5, proposed: false }],
      [{ date: '2026-10-09', payee: undefined, amount: -12000 }, { date: '2026-10-08', payeeName: 'Hydro One', amount: -12000 }, { A: 1, D: 0.9, score: 0.96, proposed: true }],
      [{ date: '2026-11-20', payee: 'CHQ 104', number: '104', amount: -30000 }, { date: '2026-10-02', payeeName: 'Landlord', number: '104', amount: -30000 }, { A: 1, D: 0.6, P: 0, score: 0.78, proposed: true }]
    ]
    for (const [l, t, expected] of examples) {
      const got = score(l, t)!
      const what = `${l.payee} / ${t.payeeName} ${t.amount}`
      expect(got.amount, what).toBe(expected.A)
      expect(got.date, what).toBe(expected.D)
      if (expected.P === undefined) expect(got.payee, what).toBeUndefined()
      else expect(got.payee, what).toBeCloseTo(expected.P, 2)
      expect(got.score, what).toBeCloseTo(expected.score, 2)
      expect(got.proposed, what).toBe(expected.proposed)
    }
  })
})

describe('differences, in words', () => {
  const words = (l: Partial<MatchLine>, t: Partial<MatchTarget>) => differences(prepareLine(line(l)), prepareTarget(target(t)), 'CAD')
  it('say what differs from the transaction’s side', () => {
    expect(words({}, { amount: -8400 })).toEqual(['1 day earlier', '0.12 less'])
    expect(words({ date: '2026-10-05' }, { amount: -9140 })).toEqual(['7.28 more'])
    expect(words({}, { date: '2026-10-08', payeeName: 'Shell' })).toEqual(['2 days later', 'payee'])
    expect(words({ date: '2026-10-05', number: '104' }, { number: '105' })).toEqual(['number'])
    expect(words({ date: '2026-10-05' }, {})).toEqual([])
    expect(words({ date: '2026-10-05' }, { amount: 8412 })).toEqual(['the other way'])
  })
})
