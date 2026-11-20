// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { BackupFrequency } from '@tessera/book-api'
import { isBackupDue, type BackupHistory } from '../../../../plugins/book/src/privileged/backups/schedule'

/** Local time, as the schedule reads it. */
const at = (y: number, m: number, d: number, h = 12, min = 0) => new Date(y, m - 1, d, h, min)
const backedUp = (when: Date, more: Partial<BackupHistory> = {}): BackupHistory => ({ lastBackupAt: when.toISOString(), lastResult: 'ok', changed: true, ...more })
const due = (history: BackupHistory | undefined, frequency: BackupFrequency, now: Date, automatic = true) =>
  isBackupDue(history, { automatic, frequency }, now)

describe('when an automatic backup is due', () => {
  it('never, when automatic backups are off', () => {
    expect(due(undefined, 'everyClose', at(2026, 11, 19), false)).toBe(false)
    expect(due(backedUp(at(2020, 1, 1), { lastResult: 'failed' }), 'everyClose', at(2026, 11, 19), false)).toBe(false)
  })

  it('always, for a book never backed up on this machine, changed or not', () => {
    for (const frequency of ['everyClose', 'daily', 'weekly', 'monthly'] as const) {
      expect(due(undefined, frequency, at(2026, 11, 19))).toBe(true)
      expect(due({ changed: false }, frequency, at(2026, 11, 19))).toBe(true)
    }
  })

  it('never, for a book unchanged since its last backup, however long ago', () => {
    for (const frequency of ['everyClose', 'daily', 'weekly', 'monthly'] as const) {
      expect(due(backedUp(at(2020, 1, 1), { changed: false }), frequency, at(2026, 11, 19))).toBe(false)
    }
  })

  it('at every close that follows a change, for everyClose', () => {
    expect(due(backedUp(at(2026, 11, 19, 18, 0)), 'everyClose', at(2026, 11, 19, 18, 1))).toBe(true)
  })

  it('daily: on a later local calendar day, not 24 hours later', () => {
    const last = backedUp(at(2026, 11, 16, 21, 0))
    expect(due(last, 'daily', at(2026, 11, 16, 23, 59))).toBe(false)
    expect(due(last, 'daily', at(2026, 11, 17, 8, 0))).toBe(true)      // 11 hours later, but Tuesday
  })

  it('weekly: from seven calendar days on', () => {
    const last = backedUp(at(2026, 11, 2, 22, 0))
    expect(due(last, 'weekly', at(2026, 11, 8, 23, 59))).toBe(false)
    expect(due(last, 'weekly', at(2026, 11, 9, 0, 1))).toBe(true)
  })

  it('monthly: from the same day next month', () => {
    const last = backedUp(at(2026, 3, 15, 20, 0))
    expect(due(last, 'monthly', at(2026, 4, 14, 23, 0))).toBe(false)
    expect(due(last, 'monthly', at(2026, 4, 15, 6, 0))).toBe(true)
  })

  it('monthly: a day the next month lacks is clamped to its last day', () => {
    const lastOfJanuary = backedUp(at(2026, 1, 31))
    expect(due(lastOfJanuary, 'monthly', at(2026, 2, 27))).toBe(false)
    expect(due(lastOfJanuary, 'monthly', at(2026, 2, 28))).toBe(true)
    expect(due(backedUp(at(2028, 1, 31)), 'monthly', at(2028, 2, 29))).toBe(true)    // a leap year
    expect(due(backedUp(at(2026, 12, 31)), 'monthly', at(2027, 1, 30))).toBe(false)  // across the year end
    expect(due(backedUp(at(2026, 12, 31)), 'monthly', at(2027, 1, 31))).toBe(true)
  })

  it('counts days by the calendar across a daylight-saving change', () => {
    // Most of North America and Europe change clocks in March; the day count must not care
    expect(due(backedUp(at(2026, 3, 1, 23, 30)), 'weekly', at(2026, 3, 8, 0, 30))).toBe(true)
    expect(due(backedUp(at(2026, 3, 28, 23, 30)), 'daily', at(2026, 3, 29, 0, 30))).toBe(true)
  })

  it('is a minimum gap, not a quota: a week away is one due backup, gone once it is taken', () => {
    const now = at(2026, 11, 8, 9, 0)
    expect(due(backedUp(at(2026, 11, 1)), 'daily', now)).toBe(true)
    // Taken at that close: the next close the same day has nothing owed for the six other days
    expect(due(backedUp(now), 'daily', at(2026, 11, 8, 17, 0))).toBe(false)
  })

  it('at the next close after a failed or interrupted attempt, whatever the frequency', () => {
    for (const lastResult of ['failed', 'interrupted'] as const) {
      expect(due(backedUp(at(2026, 11, 19, 9, 0), { lastResult }), 'monthly', at(2026, 11, 19, 9, 5))).toBe(true)
    }
  })

  it('still, when the clock has been set back before the last backup', () => {
    expect(due(backedUp(at(2026, 11, 19)), 'daily', at(2026, 11, 18))).toBe(true)
  })

  it('treats an unreadable last backup time as never backed up', () => {
    expect(due({ lastBackupAt: 'not a date', changed: false }, 'monthly', at(2026, 11, 19))).toBe(true)
  })
})
