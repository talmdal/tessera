import { describe, it, expect } from 'vitest'
import { cloneValue, diffValues, equalValues, mergeValues } from '../../shared/options/values'

describe('option values: merging defaults with overrides', () => {
  it('fills in every key from the defaults', () => {
    expect(mergeValues({ a: 1, b: 2 }, {})).toEqual({ a: 1, b: 2 })
  })

  it('merges objects key by key, however deep', () => {
    const defaults = { backup: { count: 5, folder: null, nested: { on: true, keep: 3 } }, autoBackup: true }
    expect(mergeValues(defaults, { backup: { nested: { keep: 9 } } })).toEqual({
      autoBackup: true,
      backup: { count: 5, folder: null, nested: { on: true, keep: 9 } }
    })
  })

  it('replaces arrays and scalars wholesale rather than merging them', () => {
    expect(mergeValues({ list: [1, 2, 3] }, { list: [9] })).toEqual({ list: [9] })
    expect(mergeValues({ mode: 'system' }, { mode: 'dark' })).toEqual({ mode: 'dark' })
  })

  it('keeps a key the defaults do not have, so a value from a newer plugin version survives', () => {
    expect(mergeValues({ a: 1 }, { a: 2, future: 'kept' })).toEqual({ a: 2, future: 'kept' })
  })

  it('takes the override when the two sides are different kinds', () => {
    expect(mergeValues({ a: { deep: true } }, { a: 'flat' })).toEqual({ a: 'flat' })
    expect(mergeValues({ a: null }, { a: { deep: true } })).toEqual({ a: { deep: true } })
  })

  it('shares nothing with either input, so neither can be mutated through the result', () => {
    const defaults = { nested: { list: [1] } }
    const merged = mergeValues(defaults, {}) as { nested: { list: number[] } }
    merged.nested.list.push(2)
    expect(defaults.nested.list).toEqual([1])
  })
})

describe('option values: diffing a value against the defaults', () => {
  it('is undefined when nothing differs, so nothing is stored', () => {
    expect(diffValues({ a: 1, nested: { b: 2 } }, { a: 1, nested: { b: 2 } })).toBeUndefined()
  })

  it('keeps only the keys that differ, at the depth they differ', () => {
    const defaults = { autoBackup: true, backup: { count: 5, folder: null } }
    expect(diffValues({ autoBackup: true, backup: { count: 9, folder: null } }, defaults)).toEqual({ backup: { count: 9 } })
  })

  it('keeps a changed array or scalar whole', () => {
    expect(diffValues({ list: [1, 2] }, { list: [1] })).toEqual({ list: [1, 2] })
    expect(diffValues({ mode: 'dark' }, { mode: 'system' })).toEqual({ mode: 'dark' })
  })

  it('keeps a key the defaults do not have', () => {
    expect(diffValues({ a: 1, extra: true }, { a: 1 })).toEqual({ extra: true })
  })

  it('ignores a default key the value omits, since merging would restore it anyway', () => {
    expect(diffValues({ a: 1 }, { a: 1, b: 2 })).toBeUndefined()
  })

  it('round-trips: merging a diff back over the defaults gives the value again', () => {
    const defaults = { autoBackup: true, backup: { count: 5, folder: null }, list: [1, 2] }
    const value = { autoBackup: false, backup: { count: 5, folder: '/tmp' }, list: [3] }
    expect(mergeValues(defaults, diffValues(value, defaults) ?? {})).toEqual(value)
  })
})

describe('option values: equality and cloning', () => {
  it('compares JSON structurally, ignoring key order', () => {
    expect(equalValues({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBe(true)
    expect(equalValues({ a: 1 }, { a: 1, b: undefined as never })).toBe(false)
    expect(equalValues([1, 2], [2, 1])).toBe(false)
    expect(equalValues(null, {})).toBe(false)
  })

  it('clones deeply', () => {
    const value = { nested: { list: [{ deep: true }] } }
    const copy = cloneValue(value)
    expect(copy).toEqual(value)
    expect(copy.nested.list[0]).not.toBe(value.nested.list[0])
  })
})
