// The Export dialog's date ranges (docs/export-design.md, "The Export dialog"), worked out from today.
import { describe, expect, it } from 'vitest'
import { RANGE_CHOICES } from '@tessera/export-api'
import { RANGE_LABELS, rangeOf, rangeProblem } from '../../../plugins/export/src/shared/ranges'

describe('export date ranges', () => {
  it('works each choice out from today', () => {
    const today = '2026-11-12'
    expect(rangeOf({ choice: 'all' }, today)).toEqual({})
    expect(rangeOf({ choice: 'thisYear' }, today)).toEqual({ from: '2026-01-01', to: '2026-12-31' })
    expect(rangeOf({ choice: 'lastYear' }, today)).toEqual({ from: '2025-01-01', to: '2025-12-31' })
    expect(rangeOf({ choice: 'thisMonth' }, today)).toEqual({ from: '2026-11-01', to: '2026-11-30' })
    expect(rangeOf({ choice: 'lastMonth' }, today)).toEqual({ from: '2026-10-01', to: '2026-10-31' })
    expect(rangeOf({ choice: 'lastMonth' }, '2026-01-15')).toEqual({ from: '2025-12-01', to: '2025-12-31' })
    expect(rangeOf({ choice: 'thisMonth' }, '2028-02-10')).toEqual({ from: '2028-02-01', to: '2028-02-29' })
    expect(rangeOf({ choice: 'custom', from: '2026-03-01' }, today)).toEqual({ from: '2026-03-01' })
    expect(Object.keys(RANGE_LABELS)).toEqual([...RANGE_CHOICES])
  })

  it('says what is wrong with a range', () => {
    expect(rangeProblem({})).toBeUndefined()
    expect(rangeProblem({ from: '2026-10-01', to: '2026-10-01' })).toBeUndefined()
    expect(rangeProblem({ from: '2026-10-02', to: '2026-10-01' })).toBe('The start date is after the end date.')
    expect(rangeProblem({ from: '2026-13-01' })).toBe('The start date isn’t a date.')
    expect(rangeProblem({ to: 'soon' })).toBe('The end date isn’t a date.')
  })
})
