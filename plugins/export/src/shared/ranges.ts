// The Export dialog's ready-made date ranges, worked out from today, and what is wrong with a range. Pure, and shared
// by both halves: the dialog shows the dates, and the export manager checks them again.
// See docs/export-design.md, "The Export dialog".
import { isIsoDate } from '@tessera/accounts-api'
import type { RangeChoice, RangeState } from '@tessera/export-api'

export const RANGE_LABELS: Readonly<Record<RangeChoice, string>> = {
  all: 'All dates',
  thisYear: 'This year',
  lastYear: 'Last year',
  thisMonth: 'This month',
  lastMonth: 'Last month',
  custom: 'Custom'
}

const pad = (n: number) => String(n).padStart(2, '0')
const lastDay = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate()
const month = (year: number, m: number) => ({ from: `${year}-${pad(m)}-01`, to: `${year}-${pad(m)}-${pad(lastDay(year, m))}` })

/**
 * The dates a choice stands for, given today (YYYY-MM-DD). 'all' leaves both ends open: the export manager fills them
 * in from the accounts (the earliest start, the latest transaction). 'custom' is the state's own dates, either of
 * which may be open.
 */
export function rangeOf(state: RangeState, today: string): { from?: string, to?: string } {
  const year = Number(today.slice(0, 4))
  const m = Number(today.slice(5, 7))
  switch (state.choice) {
    case 'all': return {}
    case 'thisYear': return { from: `${year}-01-01`, to: `${year}-12-31` }
    case 'lastYear': return { from: `${year - 1}-01-01`, to: `${year - 1}-12-31` }
    case 'thisMonth': return month(year, m)
    case 'lastMonth': return m === 1 ? month(year - 1, 12) : month(year, m - 1)
    case 'custom': return { ...(state.from && { from: state.from }), ...(state.to && { to: state.to }) }
  }
}

/** Why a range can't be used, in words; undefined when it can. Open ends are fine. */
export function rangeProblem(range: { from?: string, to?: string }): string | undefined {
  if (range.from !== undefined && !isIsoDate(range.from)) return 'The start date isn’t a date.'
  if (range.to !== undefined && !isIsoDate(range.to)) return 'The end date isn’t a date.'
  if (range.from !== undefined && range.to !== undefined && range.from > range.to) return 'The start date is after the end date.'
  return undefined
}
