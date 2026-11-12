// @vitest-environment node
// Bank ids that collide: an id seen before that names a different transaction now. A date more than 3 days away, or
// both another amount and another payee, mean another transaction; otherwise it is the same one sent again.
import { describe, expect, it } from 'vitest'
import { disagreements, distrustsStatement, findCollisions, isCollision, type Prior } from '../../../plugins/import/src/privileged/collisions'
import type { ConvertedLine } from '../../../plugins/import/src/privileged/convert'

const bank = (date: string, amount: number, payee?: string) => ({ date, amount, ...(payee !== undefined && { payee }) })
const before = (date: string, amount: number, payee?: string): Prior => ({ kind: 'line', bank: bank(date, amount, payee) })
const line = (importId: string, date: string, amount: number, payee?: string, n = 1): ConvertedLine =>
  ({ importId, line: n, bank: bank(date, amount, payee) })

describe('disagreements', () => {
  it('finds none when a bank sends the same line again', () => {
    expect(disagreements(bank('2026-10-05', -8412, 'COSTCO WHSE #0123'), before('2026-10-05', -8412, 'COSTCO WHSE #0456'))).toEqual([])
  })

  it('counts an amount that differs at all, dates more than 3 days apart, and payees less than half alike', () => {
    expect(disagreements(bank('2026-10-05', -8412), before('2026-10-05', -8400))).toEqual(['amount'])
    expect(disagreements(bank('2026-10-08', -8412), before('2026-10-05', -8412))).toEqual([])        // 3 days: a re-dated line
    expect(disagreements(bank('2026-10-09', -8412), before('2026-10-05', -8412))).toEqual(['date'])
    expect(disagreements(bank('2026-10-01', -8412), before('2026-10-05', -8412))).toEqual(['date'])  // either way
    expect(disagreements(bank('2026-10-05', -8412, 'THE KEG'), before('2026-10-05', -8412, 'LOBLAWS'))).toEqual(['payee'])
    expect(disagreements(bank('2026-11-03', -5750, 'THE KEG #12'), before('2026-10-03', -1200, 'LANDLORD'))).toEqual(['amount', 'date', 'payee'])
  })

  it('counts payees as agreeing when either side has none, or when only the transaction is left to compare', () => {
    expect(disagreements(bank('2026-10-05', -100), before('2026-10-05', -100, 'SHOP'))).toEqual([])
    expect(disagreements(bank('2026-11-05', -100, 'SHOP'), { kind: 'transaction', date: '2026-10-05', amount: -100 })).toEqual(['date'])
    expect(disagreements(bank('2026-11-05', -999, 'SHOP'), { kind: 'transaction', date: '2026-10-05', amount: -100 })).toEqual(['amount', 'date'])
  })
})

describe('isCollision', () => {
  it('takes a date more than 3 days away as another transaction on its own: next month’s rent isn’t this month’s sent again', () => {
    expect(isCollision(['date'])).toBe(true)
    expect(isCollision(['amount', 'payee'])).toBe(true)
    expect(isCollision(['amount', 'date', 'payee'])).toBe(true)
  })

  it('takes a corrected amount, or a renamed line, as the same transaction sent again', () => {
    expect(isCollision([])).toBe(false)
    expect(isCollision(['amount'])).toBe(false)
    expect(isCollision(['payee'])).toBe(false)
  })
})

describe('findCollisions', () => {
  const known = new Map<string, Prior>([
    ['1', before('2026-10-01', -1200, 'LANDLORD')],
    ['2', before('2026-10-02', -500, 'COFFEE')],
    ['FITID9', before('2026-10-05', -8412, 'COSTCO')]
  ])

  it('finds the known ids that now name a different transaction, and only those', () => {
    const found = findCollisions([
      line('1', '2026-11-01', -4500, 'HYDRO', 1),          // another transaction entirely
      line('2', '2026-10-02', -525, 'COFFEE', 2),          // a corrected amount: the same line
      line('FITID9', '2026-10-06', -8412, 'COSTCO', 3),    // re-dated by a day: the same line
      line('NEW', '2026-11-01', -100, 'NEW', 4),           // never seen: not a collision
      line('1', '2026-11-01', -1200, 'LANDLORD', 5)        // next month's rent under the same id: another transaction
    ], known)
    expect(found.map(c => [c.line.importId, c.line.line, c.prior])).toEqual([['1', 1, known.get('1')], ['1', 5, known.get('1')]])
  })

  it('never checks a fingerprint: the same content is the same line', () => {
    const print = 'fp:0123456789abcdef'
    expect(findCollisions([line(print, '2026-12-31', -1, 'X')], new Map([[print, before('2026-01-01', -999, 'Y')]]))).toEqual([])
  })
})

describe('distrustsStatement', () => {
  it('gives up on a statement’s ids when more than half of those known collide', () => {
    expect(distrustsStatement(0, 0)).toBe(false)
    expect(distrustsStatement(1, 10)).toBe(false)
    expect(distrustsStatement(5, 10)).toBe(false)
    expect(distrustsStatement(6, 10)).toBe(true)
    expect(distrustsStatement(1, 1)).toBe(true)
  })
})
