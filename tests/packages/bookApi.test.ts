import { describe, expect, it } from 'vitest'
import {
  BookError, childrenOf, descendantIds, flattenTree, isBookError, nameKey, pathOf, toResult, uniqueName,
  validateBookName, type SubBook
} from '@tessera/book-api'

const sub = (id: string, parentId: string | null, name: string, order = 0): SubBook => ({ id, parentId, name, order, rev: 1 })
//  Personal
//    Rentals
//      Cottage
//  Business
const TREE = [sub('b', null, 'Business', 1), sub('p', null, 'Personal', 0), sub('r', 'p', 'Rentals'), sub('c', 'r', 'Cottage')]

describe('book names', () => {
  it('accepts ordinary names, trimmed', () => {
    for (const name of ['Home', '  Home Finances 2026 ', 'Café & Co.', 'Rentals (old)']) expect(validateBookName(name), name).toBeUndefined()
  })

  it('refuses empty, long, file-hostile and dot-only names, saying why', () => {
    expect(validateBookName('   ')).toBe('Enter a name.')
    expect(validateBookName('x'.repeat(101))).toBe('Use at most 100 characters.')
    for (const name of ['a/b', 'a\\b', 'a:b', 'a?', 'a*', 'a"b', '<a>', 'a|b', 'tab\there']) {
      expect(validateBookName(name), name).toContain('can’t contain')
    }
    expect(validateBookName('..')).toBe('Enter a name other than dots.')
  })

  it('compares names ignoring case and surrounding spaces, and finds a free one', () => {
    expect(nameKey(' Business ')).toBe(nameKey('business'))
    expect(uniqueName('Shop', new Set())).toBe('Shop')
    expect(uniqueName('Shop', new Set(['shop', 'shop (2)']))).toBe('Shop (3)')
  })
})

describe('book trees', () => {
  it('lists children in order, and every descendant', () => {
    expect(childrenOf(TREE, null).map(s => s.name)).toEqual(['Personal', 'Business'])
    expect([...descendantIds(TREE, 'p')].sort()).toEqual(['c', 'r'])
    expect(descendantIds(TREE, 'c').size).toBe(0)
  })

  it('flattens depth first with depths, honouring collapsed branches', () => {
    expect(flattenTree(TREE).map(r => `${r.depth}:${r.subBook.name}:${r.hasChildren}`))
      .toEqual(['0:Personal:true', '1:Rentals:true', '2:Cottage:false', '0:Business:false'])
    expect(flattenTree(TREE, { expanded: new Set(['p']) }).map(r => r.subBook.name)).toEqual(['Personal', 'Rentals', 'Business'])
  })

  it('names the path to a sub-book, and survives a cycle in bad data', () => {
    expect(pathOf(TREE, 'c')).toEqual(['Personal', 'Rentals', 'Cottage'])
    expect(pathOf(TREE, 'nope')).toEqual([])
    expect(pathOf([sub('x', 'y', 'X'), sub('y', 'x', 'Y')], 'x').length).toBeLessThanOrEqual(3)
  })
})

describe('book errors', () => {
  it('are recognised by shape, so a copy of the package in another plugin still recognises them', () => {
    const fromAnotherCopy = Object.assign(new Error('Taken'), { name: 'BookError', code: 'DUPLICATE_NAME' })
    expect(isBookError(new BookError('CYCLE', 'No'))).toBe(true)
    expect(isBookError(fromAnotherCopy)).toBe(true)
    expect(isBookError(new Error('plain'))).toBe(false)
    expect(isBookError({ code: 'X' })).toBe(false)
    expect(new BookError('INVALID', 'Enter a name.', 'name')).toMatchObject({ code: 'INVALID', field: 'name', message: 'Enter a name.' })
  })

  it('become results for views, while anything else is still thrown', async () => {
    expect(await toResult(async () => 3)).toEqual({ ok: true, value: 3 })
    expect(await toResult(async () => { throw new BookError('INVALID', 'Enter a name.', 'name') }))
      .toEqual({ ok: false, error: { code: 'INVALID', message: 'Enter a name.', field: 'name' } })
    await expect(toResult(async () => { throw new TypeError('bug') })).rejects.toThrow('bug')
  })
})
