// QIF's dates. Quicken marks years of the 2000s with an apostrophe ('10/05'26', and '1/ 5' 6' for 2006) and pads
// with spaces; others write '10/05/26', '10/05/2026', '05.10.2026' or ISO. The file rarely says which order its days
// and months are in, so the order is decided once, from every date in the file together, never date by date.
// See docs/import-formats-design.md, "QIF dates".
import { guessDateOrder, isoDate, type DateOrder } from '@tessera/import-api'

/**
 * A QIF date in a form `isoDate` reads: spaces taken out, and an apostrophe year made a four-digit year of the 2000s
 * ('10/ 5'26' → '10/5/2026'). Undefined for the empty string.
 */
export function plainDate(text: string): string | undefined {
  const s = text.replace(/\s+/g, '')
  if (s === '') return undefined
  const quoted = /^(\d{1,2})([/.-])(\d{1,2})'(\d{1,4})$/.exec(s)
  if (quoted) {
    const year = quoted[4].length === 4 ? quoted[4] : String(2000 + Number(quoted[4]))
    return `${quoted[1]}/${quoted[3]}/${year}`
  }
  return s
}

/** A QIF date as YYYY-MM-DD in `order`, or undefined. ISO dates are read as such whatever the order. */
export function qifDate(text: string, order: DateOrder, pivot: number): string | undefined {
  const plain = plainDate(text)
  if (plain === undefined) return undefined
  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(plain)) return isoDate(plain, 'YMD')
  return isoDate(plain, order, { pivot })
}

/** The orders in which every one of a file's dates reads (ISO dates fit any). */
export function qifDateOrders(texts: readonly string[], pivot: number): DateOrder[] {
  const plain = texts.map(plainDate).filter((d): d is string => d !== undefined && !/^\d{4}-\d{1,2}-\d{1,2}$/.test(d))
  if (plain.length === 0) return texts.some(t => plainDate(t) !== undefined) ? ['YMD'] : []
  return guessDateOrder(plain, { pivot })
}

/** Of several orders that read every date, the one whose dates span the shortest time, to offer first. */
export function likeliestOrder(texts: readonly string[], orders: readonly DateOrder[], pivot: number): DateOrder {
  const span = (order: DateOrder) => {
    const dates = texts.map(t => qifDate(t, order, pivot)).filter((d): d is string => d !== undefined).sort()
    return dates.length < 2 ? 0 : Date.parse(dates[dates.length - 1]) - Date.parse(dates[0])
  }
  return [...orders].sort((a, b) => span(a) - span(b))[0] ?? 'MDY'
}
