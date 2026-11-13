// @vitest-environment node
// Duplicates across sources, the rule: which new lines look like lines imported before from another file. Each
// condition, each way; one to one; the order of pairing.
import { describe, expect, it } from 'vitest'
import { findDuplicates, type EarlierLine, type FreshLine } from '../../../../plugins/import/src/privileged/matching/duplicates'

const FP = 'fp:0123456789abcdef'
const fresh = (date: string, amount: number, payee?: string, importId = 'FITID1'): FreshLine =>
  ({ importId, bank: { date, amount, ...(payee !== undefined && { payee }) } })
let n = 0
const earlier = (date: string, amount: number, payee?: string, over: Partial<EarlierLine> = {}): EarlierLine =>
  ({ lineId: `L${++n}`, transactionId: `T${n}`, importId: `${FP}${n}`, formatId: 'format-csv.csv', bank: { date, amount, ...(payee !== undefined && { payee }) }, ...over })
const pairs = (lines: FreshLine[], before: EarlierLine[], formatId = 'format-ofx.ofx') =>
  findDuplicates(lines, formatId, before).map(p => [p.line, p.earlier.lineId])

describe('a line imported before from another file', () => {
  it('is found: the same amount, dates within 3 days, payees alike', () => {
    const costco = earlier('2026-10-05', -8412, 'COSTCO WHSE #0123')
    expect(pairs([fresh('2026-10-06', -8412, 'POS PURCHASE COSTCO WHSE #0456')], [costco])).toEqual([[0, costco.lineId]])
    expect(pairs([fresh('2026-10-08', -8412, 'COSTCO')], [costco])).toEqual([[0, costco.lineId]])          // 3 days
    expect(pairs([fresh('2026-10-02', -8412, 'COSTCO')], [costco])).toEqual([[0, costco.lineId]])          // either way
  })

  it('is not found for payees only somewhat alike, as unrelated names of the same length can be', () => {
    expect(pairs([fresh('2026-10-05', -2000, 'PINE HARDWARE')], [earlier('2026-10-05', -2000, 'CORNER BAKERY')])).toEqual([])   // 0.55
    expect(pairs([fresh('2026-10-05', -2000, 'HOME DEPOT #7011')], [earlier('2026-10-05', -2000, 'HYDRO ONE NETWORKS')])).toEqual([])   // 0.70
    const amazon = earlier('2026-10-27', -2399, 'AMAZON.CA*2K3L91')
    expect(pairs([fresh('2026-10-27', -2399, 'AMZN MKTP CA*2K3L91')], [amazon])).toEqual([[0, amazon.lineId]])                // 0.82
  })

  it('is not found when the amount differs at all, the dates are further apart, or the payees differ', () => {
    const costco = earlier('2026-10-05', -8412, 'COSTCO WHSE #0123')
    expect(pairs([fresh('2026-10-05', -8400, 'COSTCO')], [costco])).toEqual([])
    expect(pairs([fresh('2026-10-09', -8412, 'COSTCO')], [costco])).toEqual([])
    expect(pairs([fresh('2026-10-05', -8412, 'LOBLAWS #1001')], [costco])).toEqual([])
    expect(pairs([fresh('2026-10-05', 8412, 'COSTCO')], [costco])).toEqual([])                           // a refund
  })

  it('is found for a cheque by its number, whatever the payees, within 30 days; another number is another cheque', () => {
    const withNumber = <T extends FreshLine | EarlierLine>(line: T, number: string): T => ({ ...line, bank: { ...line.bank, number } })
    const money = withNumber(earlier('2026-10-02', -120000, 'Landlord'), '101')         // as a Money export names it
    expect(pairs([withNumber(fresh('2026-10-02', -120000, 'CHEQUE 101'), '101')], [money])).toEqual([[0, money.lineId]])
    expect(pairs([withNumber(fresh('2026-10-30', -120000, 'CHEQUE 101'), '0101')], [money])).toEqual([[0, money.lineId]])   // cleared late
    expect(pairs([withNumber(fresh('2026-11-02', -120000, 'CHEQUE 101'), '101')], [money])).toEqual([])                      // 31 days
    expect(pairs([withNumber(fresh('2026-10-02', -120000, 'Landlord'), '102')], [money])).toEqual([])                        // another cheque
    expect(pairs([withNumber(fresh('2026-10-02', -100000, 'CHEQUE 101'), '101')], [money])).toEqual([])                      // another amount
    // Without a number on one side, the payees must be alike, as for any line
    expect(pairs([fresh('2026-10-02', -120000, 'CHEQUE 101')], [money])).toEqual([])
  })

  it('takes a missing payee on either side as alike', () => {
    const fee = earlier('2026-10-31', -495)
    expect(pairs([fresh('2026-10-31', -495, 'MONTHLY ACCOUNT FEE')], [fee])).toEqual([[0, fee.lineId]])
    const named = earlier('2026-10-31', -495, 'MONTHLY ACCOUNT FEE')
    expect(pairs([fresh('2026-10-31', -495)], [named])).toEqual([[0, named.lineId]])
  })

  it('knows a pending line by its posted one: the words a pending line adds are ignored', () => {
    const pending = earlier('2026-10-03', -5750, 'PENDING - THE KEG #12')
    expect(pairs([fresh('2026-10-04', -5750, 'THE KEG #12')], [pending])).toEqual([[0, pending.lineId]])
    const preauth = earlier('2026-10-20', -4820, 'PREAUTH SHELL C12345')
    expect(pairs([fresh('2026-10-21', -4820, 'SHELL C12345 KANATA ON')], [preauth])).toEqual([[0, preauth.lineId]])
  })

  it('is never two bank ids from the same format, or from formats it can’t tell apart: those are two transactions', () => {
    const ofx = earlier('2026-10-05', -8412, 'COSTCO', { importId: 'FITID9', formatId: 'format-ofx.ofx' })
    expect(pairs([fresh('2026-10-05', -8412, 'COSTCO', 'FITID10')], [ofx], 'format-ofx.ofx')).toEqual([])
    const unknown = earlier('2026-10-05', -8412, 'COSTCO', { importId: 'FITID9', formatId: undefined })
    expect(pairs([fresh('2026-10-05', -8412, 'COSTCO', 'FITID10')], [unknown], 'format-ofx.ofx')).toEqual([])
    // From two formats, ids can't be compared: the bank's CSV with an id column, then its OFX
    const csvWithIds = earlier('2026-10-05', -8412, 'COSTCO', { importId: 'TXN-55', formatId: 'format-csv.csv' })
    expect(pairs([fresh('2026-10-05', -8412, 'COSTCO', 'FITID10')], [csvWithIds], 'format-ofx.ofx')).toEqual([[0, csvWithIds.lineId]])
  })

  it('may be a fingerprint on either side, even from the same format (a CSV export whose text changed)', () => {
    const byContent = earlier('2026-10-05', -8412, 'PENDING COSTCO', { formatId: 'format-csv.csv' })
    expect(pairs([fresh('2026-10-06', -8412, 'COSTCO WHSE', `${FP}x`)], [byContent], 'format-csv.csv')).toEqual([[0, byContent.lineId]])
    const ofx = earlier('2026-10-05', -8412, 'COSTCO', { importId: 'FITID9', formatId: 'format-ofx.ofx' })
    expect(pairs([fresh('2026-10-05', -8412, 'COSTCO', `${FP}y`)], [ofx], 'format-ofx.ofx')).toEqual([[0, ofx.lineId]])
  })
})

describe('pairing', () => {
  it('is one to one: two identical coffees pair with two, not both with one', () => {
    const a = earlier('2026-10-29', -475, 'TIM HORTONS #4021')
    const b = earlier('2026-10-29', -475, 'TIM HORTONS #4021')
    expect(pairs([fresh('2026-10-29', -475, 'TIM HORTONS #4021', 'F1'), fresh('2026-10-29', -475, 'TIM HORTONS #4021', 'F2')], [a, b]))
      .toEqual([[0, a.lineId], [1, b.lineId]])
    // A third coffee has no earlier line left: it goes on to matching, and is added
    expect(pairs([fresh('2026-10-29', -475, 'TIM HORTONS', 'F1'), fresh('2026-10-29', -475, 'TIM HORTONS', 'F2'), fresh('2026-10-29', -475, 'TIM HORTONS', 'F3')], [a, b]))
      .toHaveLength(2)
  })

  it('takes the payees most alike first, then the closest dates, then the line imported first', () => {
    const near = earlier('2026-10-05', -1000, 'SHOP A')
    const alike = earlier('2026-10-07', -1000, 'BRIGHT SHOP')
    expect(pairs([fresh('2026-10-06', -1000, 'BRIGHT SHOP')], [near, alike])).toEqual([[0, alike.lineId]])
    const later = earlier('2026-10-08', -1000, 'SHOP')
    const sooner = earlier('2026-10-06', -1000, 'SHOP')
    expect(pairs([fresh('2026-10-06', -1000, 'SHOP')], [later, sooner])).toEqual([[0, sooner.lineId]])
    const first = earlier('2026-10-06', -1000, 'SHOP')
    const second = earlier('2026-10-06', -1000, 'SHOP')
    expect(pairs([fresh('2026-10-06', -1000, 'SHOP')], [first, second])).toEqual([[0, first.lineId]])
  })

  it('gives the payees’ likeness as the pair’s score, 1 when either has none', () => {
    const [pair] = findDuplicates([fresh('2026-10-31', -495)], 'format-ofx.ofx', [earlier('2026-10-31', -495, 'FEE')])
    expect(pair.score).toBe(1)
    expect(findDuplicates([], 'x', [earlier('2026-10-31', -495)])).toEqual([])
  })
})
