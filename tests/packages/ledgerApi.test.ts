import { describe, expect, it } from 'vitest'
import {
  LedgerError, childrenOf, descendantIds, displayDate, displaySize, flattenTree, isLedgerError, nameKey, pathOf, toResult, uniqueName,
  validateLedgerName, type SubLedger
} from '@tessera/ledger-api'

const sub = (id: string, parentId: string | null, name: string, order = 0): SubLedger => ({ id, parentId, name, order, rev: 1 })
//  Personal
//    Rentals
//      Cottage
//  Business
const TREE = [sub('b', null, 'Business', 1), sub('p', null, 'Personal', 0), sub('r', 'p', 'Rentals'), sub('c', 'r', 'Cottage')]

describe('ledger names', () => {
  it('accepts ordinary names, trimmed', () => {
    for (const name of ['Home', '  Home Finances 2026 ', 'Café & Co.', 'Rentals (old)']) expect(validateLedgerName(name), name).toBeUndefined()
  })

  it('refuses empty, long, file-hostile and dot-only names, saying why', () => {
    expect(validateLedgerName('   ')).toBe('Enter a name.')
    expect(validateLedgerName('x'.repeat(101))).toBe('Use at most 100 characters.')
    for (const name of ['a/b', 'a\\b', 'a:b', 'a?', 'a*', 'a"b', '<a>', 'a|b', 'tab\there']) {
      expect(validateLedgerName(name), name).toContain('can’t contain')
    }
    expect(validateLedgerName('..')).toBe('Enter a name other than dots.')
  })

  it('compares names ignoring case and surrounding spaces, and finds a free one', () => {
    expect(nameKey(' Business ')).toBe(nameKey('business'))
    expect(uniqueName('Shop', new Set())).toBe('Shop')
    expect(uniqueName('Shop', new Set(['shop', 'shop (2)']))).toBe('Shop (3)')
  })
})

describe('file sizes for people', () => {
  it('are in KB below a megabyte, never 0, and in MB with one decimal above', () => {
    expect(displaySize(0)).toBe('1 KB')
    expect(displaySize(600 * 1024)).toBe('600 KB')
    expect(displaySize(1024 * 1024 - 1)).toBe('1024 KB')
    expect(displaySize(7.6 * 1024 * 1024)).toBe('7.6 MB')
  })
})

describe('dates for people', () => {
  it('show a calendar date in the locale, as the same day in every time zone', () => {
    const zone = process.env.TZ
    const shown = new Set<string>()
    try {
      // UTC+14 and UTC-11: a local midnight would be the day before in one of them
      for (const tz of ['Pacific/Kiritimati', 'UTC', 'Pacific/Pago_Pago']) {
        process.env.TZ = tz
        const date = displayDate('2026-01-01')
        expect(date, tz).toMatch(/2026/)
        expect(date, tz).not.toMatch(/2025|31|Dec/)
        shown.add(date)
      }
      expect(shown.size).toBe(1)
    } finally {
      if (zone === undefined) delete process.env.TZ
      else process.env.TZ = zone
    }
  })
})

describe('ledger trees', () => {
  it('lists children in order, and every descendant', () => {
    expect(childrenOf(TREE, null).map(s => s.name)).toEqual(['Personal', 'Business'])
    expect([...descendantIds(TREE, 'p')].sort()).toEqual(['c', 'r'])
    expect(descendantIds(TREE, 'c').size).toBe(0)
  })

  it('flattens depth first with depths, honouring collapsed branches', () => {
    expect(flattenTree(TREE).map(r => `${r.depth}:${r.subLedger.name}:${r.hasChildren}`))
      .toEqual(['0:Personal:true', '1:Rentals:true', '2:Cottage:false', '0:Business:false'])
    expect(flattenTree(TREE, { expanded: new Set(['p']) }).map(r => r.subLedger.name)).toEqual(['Personal', 'Rentals', 'Business'])
  })

  it('names the path to a sub-ledger, and survives a cycle in bad data', () => {
    expect(pathOf(TREE, 'c')).toEqual(['Personal', 'Rentals', 'Cottage'])
    expect(pathOf(TREE, 'nope')).toEqual([])
    expect(pathOf([sub('x', 'y', 'X'), sub('y', 'x', 'Y')], 'x').length).toBeLessThanOrEqual(3)
  })
})

describe('ledger errors', () => {
  it('are recognised by shape, so a copy of the package in another plugin still recognises them', () => {
    const fromAnotherCopy = Object.assign(new Error('Taken'), { name: 'LedgerError', code: 'DUPLICATE_NAME' })
    expect(isLedgerError(new LedgerError('CYCLE', 'No'))).toBe(true)
    expect(isLedgerError(fromAnotherCopy)).toBe(true)
    expect(isLedgerError(new Error('plain'))).toBe(false)
    expect(isLedgerError({ code: 'X' })).toBe(false)
    expect(new LedgerError('INVALID', 'Enter a name.', 'name')).toMatchObject({ code: 'INVALID', field: 'name', message: 'Enter a name.' })
  })

  it('become results for views, while anything else is still thrown', async () => {
    expect(await toResult(async () => 3)).toEqual({ ok: true, value: 3 })
    expect(await toResult(async () => { throw new LedgerError('INVALID', 'Enter a name.', 'name') }))
      .toEqual({ ok: false, error: { code: 'INVALID', message: 'Enter a name.', field: 'name' } })
    await expect(toResult(async () => { throw new TypeError('bug') })).rejects.toThrow('bug')
  })
})
