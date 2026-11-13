// Turning stored series into what the Recurring view shows: the next occurrence of each, resolved for display and
// sorted, with the figures the warnings are built from. Pure, given the accounts and categories to resolve against.
import { categoryLabel, transferLabel, type Account, type Category, type CurrencyTotals } from '@tessera/accounts-api'
import {
  countThrough, describeSchedule, dueStateOf, occurrenceAt, seriesKind,
  type BusinessCalendar, type DueState, type RecurringRow, type RecurringSnapshot, type Series
} from '@tessera/recurring-api'

/** Where a row sorts: live series first, then ones the user paused, then ones that have finished. */
const GROUPS: Readonly<Record<DueState, number>> = {
  overdue: 0, dueToday: 0, dueSoon: 0, upcoming: 0, paused: 1, ended: 2
}

/** Why a series can't be entered right now, or undefined. */
export function blockedReason(series: Series, byId: ReadonlyMap<string, Account>): string | undefined {
  const account = byId.get(series.accountId)
  if (!account) return 'Its account no longer exists.'
  if (account.closed) return `“${account.name}” is closed. Reopen it to enter this.`

  const transferId = series.template.transferAccountId
  if (transferId !== undefined) {
    const other = byId.get(transferId)
    if (!other) return 'The account it transfers to no longer exists.'
    if (other.closed) return `“${other.name}” is closed. Reopen it to enter this.`
    if (other.currency !== account.currency) return `“${other.name}” is in another currency.`
  }
  return undefined
}

/** One series as the view shows it. `account` is absent only when the account has gone, which `blocked` reports. */
export function rowOf(
  series: Series, accounts: ReadonlyMap<string, Account>, categories: readonly Category[], today: string, calendar?: BusinessCalendar
): RecurringRow {
  const account = accounts.get(series.accountId)
  const state = dueStateOf(series, today)
  const occurrence = series.nextDate === null ? undefined : occurrenceAt(series.schedule, series.nextIndex, calendar)
  const blocked = blockedReason(series, accounts)

  const transferId = series.template.transferAccountId
  const label = transferId !== undefined
    ? transferLabel(series.template.amount, accounts.get(transferId)?.name ?? 'a deleted account')
    : categoryLabel(categories, series.template.categoryId)

  return {
    series,
    kind: seriesKind(series.template),
    ...(occurrence && { occurrence }),
    state,
    // A paused or finished series has nothing due, whatever its dates say
    dueCount: state === 'paused' || state === 'ended' ? 0 : countThrough(series.schedule, series.nextIndex, today, calendar),
    account: account
      ? { id: account.id, name: account.name, type: account.type, currency: account.currency, closed: account.closed }
      : { id: series.accountId, name: 'A deleted account', type: 'chequing', currency: 'CAD', closed: true },
    ...(series.template.payee !== undefined && { payeeName: series.template.payee }),
    ...(label !== undefined && { categoryLabel: label }),
    scheduleLabel: describeSchedule(series.schedule),
    ...(blocked !== undefined && { blockedReason: blocked })
  }
}

const add = (totals: CurrencyTotals, currency: string, amount: number) => {
  totals[currency] = (totals[currency] ?? 0) + amount
}

/**
 * Everything the Recurring view shows. Rows are ascending by the date their occurrence falls on — which puts
 * overdue ones, whose dates are in the past, at the top without a sort of their own.
 *
 * The overdue figures count *every* occurrence a series has missed, not just the next one, since that is what is
 * actually outstanding: three months of a £142 bill is £426.
 */
export function buildSnapshot(
  series: readonly Series[], accountList: readonly Account[], categories: readonly Category[], today: string, calendar?: BusinessCalendar
): RecurringSnapshot {
  const accounts = new Map(accountList.map(account => [account.id, account]))
  const rows = series.map(one => rowOf(one, accounts, categories, today, calendar))

  rows.sort((a, b) => {
    const group = GROUPS[a.state] - GROUPS[b.state]
    if (group !== 0) return group
    const left = a.occurrence?.date ?? ''
    const right = b.occurrence?.date ?? ''
    return left.localeCompare(right) || a.series.name.localeCompare(b.series.name)
  })

  const overdueTotals: CurrencyTotals = {}
  const dueSoonTotals: CurrencyTotals = {}
  let overdueCount = 0
  let dueSoonCount = 0
  let blockedCount = 0
  for (const row of rows) {
    if (row.blockedReason !== undefined) blockedCount++
    const outstanding = row.series.template.amount * Math.max(row.dueCount, 1)
    if (row.state === 'overdue') {
      overdueCount++
      add(overdueTotals, row.account.currency, outstanding)
    } else if (row.state === 'dueToday' || row.state === 'dueSoon') {
      dueSoonCount++
      add(dueSoonTotals, row.account.currency, outstanding)
    }
  }

  return { rows, summary: { overdueCount, overdueTotals, dueSoonCount, dueSoonTotals, blockedCount }, today }
}

/** "3 transactions overdue" — the bar item interpolates a context key but can't pluralise. */
export function overdueSummary(count: number): string {
  return count === 1 ? '1 transaction overdue' : `${count} transactions overdue`
}
