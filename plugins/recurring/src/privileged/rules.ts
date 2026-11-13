// What a series must look like, checked in one place. Pure: whether the account exists and is open is the
// service's business, since only it can ask the account manager.
import {
  MEMO_MAX_LENGTH, PAYEE_NAME_MAX_LENGTH, TRANSACTION_NUMBER_MAX_LENGTH, isAmount
} from '@tessera/accounts-api'
import {
  DEFAULT_REMIND_DAYS, MAX_REMIND_DAYS, SERIES_NAME_MAX_LENGTH, SERIES_NOTES_MAX_LENGTH, validateSchedule,
  type Schedule, type SeriesInput, type SeriesPatch, type SeriesTemplate
} from '@tessera/recurring-api'
import { invalid, optionalText } from './store'

/** The fields a patch clears with `null`. */
const CLEARABLE: ReadonlySet<string> = new Set(['notes'])

/** A series' fields, checked and normalised. What the service stores, less the state it works out itself. */
export interface CheckedSeries {
  accountId: string
  name: string
  template: SeriesTemplate
  schedule: Schedule
  remindDays: number
  autoEnter: boolean
  notes?: string
}

function checkTemplate(raw: unknown): SeriesTemplate {
  if (typeof raw !== 'object' || raw === null) throw invalid('amount', 'Enter what it pays or deposits.')
  const template = raw as Record<string, unknown>

  if (!isAmount(template.amount)) throw invalid('amount', 'Enter an amount.')
  const estimated = template.estimated === true
  if (template.estimated !== undefined && typeof template.estimated !== 'boolean') {
    throw invalid('estimated', 'Choose whether the amount varies.')
  }
  // Only a series whose amount varies may be left at zero: it is an estimate nobody has made yet
  if (template.amount === 0 && !estimated) throw invalid('amount', 'Enter an amount, or say that it varies.')

  const autoNumber = template.autoNumber === true
  if (template.autoNumber !== undefined && typeof template.autoNumber !== 'boolean') {
    throw invalid('autoNumber', 'Choose whether to take the next cheque number.')
  }

  const categoryId = optionalText(template.categoryId, 'categoryId', 100)
  const transferAccountId = optionalText(template.transferAccountId, 'transferAccountId', 100)
  if (categoryId !== undefined && transferAccountId !== undefined) {
    throw invalid('categoryId', 'Choose a category or a transfer, not both.')
  }

  const payee = optionalText(template.payee, 'payee', PAYEE_NAME_MAX_LENGTH)
  const memo = optionalText(template.memo, 'memo', MEMO_MAX_LENGTH)
  const number = autoNumber ? undefined : optionalText(template.number, 'number', TRANSACTION_NUMBER_MAX_LENGTH)

  return {
    amount: template.amount, autoNumber, estimated,
    ...(payee !== undefined && { payee }),
    ...(memo !== undefined && { memo }),
    ...(number !== undefined && { number }),
    ...(categoryId !== undefined && { categoryId }),
    ...(transferAccountId !== undefined && { transferAccountId })
  }
}

/**
 * Checks and normalises every field of a series, with `name` already settled by the caller (which knows the
 * transfer's other account). Throws INVALID naming the field at fault.
 */
export function checkSeriesInput(input: SeriesInput & { name: string }): CheckedSeries {
  if (typeof input !== 'object' || input === null) throw invalid('name', 'Enter the recurring transaction’s details.')
  if (typeof input.accountId !== 'string' || input.accountId.trim() === '') throw invalid('accountId', 'Choose an account.')

  // The template first: an unnamed series takes its name from the payee, so a payee at fault must be reported as
  // the payee rather than as the name the caller derived from it
  const template = checkTemplate(input.template)

  const name = typeof input.name === 'string' ? input.name.trim() : ''
  if (name === '') throw invalid('name', 'Enter a name.')
  if (name.length > SERIES_NAME_MAX_LENGTH) throw invalid('name', `Use at most ${SERIES_NAME_MAX_LENGTH} characters.`)
  if (/[\u0000-\u001f\u007f]/.test(name)) throw invalid('name', 'Remove the control characters.')

  const scheduleProblem = validateSchedule(input.schedule)
  if (scheduleProblem) throw invalid('schedule', scheduleProblem)

  const remindDays = input.remindDays ?? DEFAULT_REMIND_DAYS
  if (!Number.isInteger(remindDays) || remindDays < 0 || remindDays > MAX_REMIND_DAYS) {
    throw invalid('remindDays', `Remind between 0 and ${MAX_REMIND_DAYS} days ahead.`)
  }
  if (input.autoEnter !== undefined && typeof input.autoEnter !== 'boolean') {
    throw invalid('autoEnter', 'Choose whether to enter it automatically.')
  }

  const notes = optionalText(input.notes, 'notes', SERIES_NOTES_MAX_LENGTH, true)
  return {
    accountId: input.accountId,
    name,
    template,
    schedule: input.schedule,
    remindDays,
    autoEnter: input.autoEnter === true,
    ...(notes !== undefined && { notes })
  }
}

/** The input a series was made from, with a patch applied; `null` clears an optional field. */
export function applyPatch(current: CheckedSeries, patch: SeriesPatch): SeriesInput & { name: string } {
  if (typeof patch !== 'object' || patch === null) throw invalid('name', 'Nothing to change.')
  const merged: Record<string, unknown> = {
    accountId: current.accountId, name: current.name, template: current.template, schedule: current.schedule,
    remindDays: current.remindDays, autoEnter: current.autoEnter, notes: current.notes
  }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    merged[key] = value === null && CLEARABLE.has(key) ? undefined : value
  }
  return merged as unknown as SeriesInput & { name: string }
}

/** Whether two schedules would generate the same dates, so an edit knows when to place the next occurrence again. */
export function sameSchedule(a: Schedule, b: Schedule): boolean {
  const key = (s: Schedule) => JSON.stringify([
    s.frequency, s.interval, s.startDate, s.monthlyRule ?? null, s.semiMonthlyDays ?? null,
    s.month ?? null, s.weekendRule ?? 'none', s.end ?? { kind: 'never' }
  ])
  return key(a) === key(b)
}
