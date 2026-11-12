// @vitest-environment node
// QIF's dates: Quicken's apostrophe years and padding spaces, two-digit years with the pivot, dots and dashes, ISO; and
// the file's order decided from all its dates together.
import { describe, expect, it } from 'vitest'
import { likeliestOrder, plainDate, qifDate, qifDateOrders } from '../../../plugins/import-qif/src/privileged/dates'

const PIVOT = 2036

describe('QIF dates', () => {
  it('reads Quicken’s apostrophe years as the 2000s, with or without padding', () => {
    expect(qifDate("10/05'26", 'MDY', PIVOT)).toBe('2026-10-05')
    expect(qifDate("10/ 5'26", 'MDY', PIVOT)).toBe('2026-10-05')
    expect(qifDate("1/ 5'2026", 'MDY', PIVOT)).toBe('2026-01-05')
    expect(qifDate("1/ 5' 6", 'MDY', PIVOT)).toBe('2006-01-05')
    expect(plainDate("10/ 5'26")).toBe('10/5/2026')
  })

  it('reads two-digit years with the pivot, four-digit years, dots and dashes, and ISO whatever the order', () => {
    expect(qifDate('10/05/26', 'MDY', PIVOT)).toBe('2026-10-05')
    expect(qifDate('10/05/98', 'MDY', PIVOT)).toBe('1998-10-05')
    expect(qifDate('05.10.2026', 'DMY', PIVOT)).toBe('2026-10-05')
    expect(qifDate('05-10-2026', 'DMY', PIVOT)).toBe('2026-10-05')
    expect(qifDate('2026-10-05', 'DMY', PIVOT)).toBe('2026-10-05')
    expect(qifDate('', 'MDY', PIVOT)).toBeUndefined()
    expect(qifDate('13/45/2026', 'MDY', PIVOT)).toBeUndefined()
  })

  it('decides the order from every date in the file: one day past 12 decides, none leaves it open', () => {
    expect(qifDateOrders(["10/05'26", "10/13'26"], PIVOT)).toEqual(['MDY'])
    expect(qifDateOrders(['05.10.2026', '13.10.2026'], PIVOT)).toEqual(['DMY'])
    expect(qifDateOrders(['01/08/2026', '12/08/2026'], PIVOT)).toEqual(['MDY', 'DMY'])
    expect(qifDateOrders(['2026-10-05'], PIVOT)).toEqual(['YMD'])
    expect(qifDateOrders(['10/13/2026', '13/10/2026'], PIVOT)).toEqual([])
    expect(qifDateOrders([], PIVOT)).toEqual([])
  })

  it('offers first the order whose dates span the shortest time', () => {
    expect(likeliestOrder(['01/08/2026', '05/08/2026', '12/08/2026'], ['MDY', 'DMY'], PIVOT)).toBe('DMY')   // Aug 1 to 12
    expect(likeliestOrder(['08/01/2026', '08/05/2026', '08/12/2026'], ['MDY', 'DMY'], PIVOT)).toBe('MDY')
  })
})
