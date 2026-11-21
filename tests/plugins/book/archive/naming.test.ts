// @vitest-environment node
// Archive file names and the suggested cut-off. See docs/archive-design.md, "The archive file" and "Options".
import { describe, expect, it } from 'vitest'
import { archiveFileName, archiveStagingName, isIsoDate, isoDay, suggestedCutoff } from '../../../../plugins/book/src/privileged/archive/naming'

describe('the suggested cut-off', () => {
  it('offers the first day of the current year by default', () => {
    expect(suggestedCutoff('startOfThisYear', new Date(2026, 10, 20))).toBe('2026-01-01')
    expect(suggestedCutoff('startOfLastYear', new Date(2026, 10, 20))).toBe('2025-01-01')
  })

  it('is right on the first and last days of a year', () => {
    expect(suggestedCutoff('startOfThisYear', new Date(2026, 0, 1))).toBe('2026-01-01')
    expect(suggestedCutoff('startOfThisYear', new Date(2026, 11, 31))).toBe('2026-01-01')
    expect(suggestedCutoff('startOfLastYear', new Date(2026, 0, 1))).toBe('2025-01-01')
  })

  it('counts back whole years for the rolling rules', () => {
    expect(suggestedCutoff('oneYearAgo', new Date(2026, 10, 20))).toBe('2025-11-20')
    expect(suggestedCutoff('twoYearsAgo', new Date(2026, 10, 20))).toBe('2024-11-20')
  })

  it('clamps 29 February back to a common year', () => {
    expect(suggestedCutoff('oneYearAgo', new Date(2024, 1, 29))).toBe('2023-02-28')
    expect(suggestedCutoff('twoYearsAgo', new Date(2026, 1, 28))).toBe('2024-02-28')
    // Four years back from a leap day is a leap day again
    expect(suggestedCutoff('oneYearAgo', new Date(2025, 1, 28))).toBe('2024-02-28')
  })

  it('reads a local date, never shifted a day by UTC', () => {
    expect(isoDay(new Date(2026, 0, 1, 0, 30))).toBe('2026-01-01')
    expect(isoDay(new Date(2026, 11, 31, 23, 30))).toBe('2026-12-31')
  })
})

describe('what counts as a date', () => {
  it('takes a real YYYY-MM-DD and nothing else', () => {
    expect(isIsoDate('2026-01-01')).toBe(true)
    expect(isIsoDate('2024-02-29')).toBe(true)
    expect(isIsoDate('2023-02-29')).toBe(false)
    expect(isIsoDate('2026-02-30')).toBe(false)
    expect(isIsoDate('2026-13-01')).toBe(false)
    expect(isIsoDate('2026-00-10')).toBe(false)
    expect(isIsoDate('2026-1-1')).toBe(false)
    expect(isIsoDate('1 Jan 2026')).toBe(false)
    expect(isIsoDate(undefined)).toBe(false)
  })
})

describe('the archive file name', () => {
  it('names the book and the cut-off', () => {
    expect(archiveFileName('Home Finances', '2026-01-01')).toBe('Home Finances Archive through 2026-01-01.tessera')
  })

  it('counts up when the name is taken', () => {
    expect(archiveFileName('Home', '2026-01-01', 1)).toBe('Home Archive through 2026-01-01.tessera')
    expect(archiveFileName('Home', '2026-01-01', 2)).toBe('Home Archive through 2026-01-01 (2).tessera')
  })

  it('never contains a character Windows rejects, and never ends in a dot or space', () => {
    expect(archiveFileName('Q1/Q2: "work" <2026>', '2026-01-01')).toBe('Q1_Q2_ _work_ _2026_ Archive through 2026-01-01.tessera')
    expect(archiveFileName('Accounts. ', '2026-01-01')).toBe('Accounts Archive through 2026-01-01.tessera')
    expect(archiveFileName('', '2026-01-01')).toBe('Book Archive through 2026-01-01.tessera')
    expect(archiveFileName('con', '2026-01-01')).toBe('con_ Archive through 2026-01-01.tessera')
  })

  it('stages under a name of its own, out of the way and never mistakable for the archive', () => {
    const staging = archiveStagingName('Home Finances', '01JE4')
    expect(staging).toBe('.Home Finances.archiving-01JE4.tessera')
    expect(staging).not.toBe(archiveFileName('Home Finances', '2026-01-01'))
  })
})
