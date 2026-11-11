import { describe, expect, it } from 'vitest'
import {
  changedPaths, deepEqual, deepFreeze, diffFromDefaults, getAtPath, isPlainObject, isValidPath, jsonProblem, mergeOverDefaults, setAtPath, shapeProblems
} from '../../shared/settings/values'

describe('settings values: JSON', () => {
  it('accepts JSON and names where a value is not', () => {
    expect(jsonProblem({ a: [1, 'x', null, true, { b: {} }] })).toBeUndefined()
    expect(jsonProblem({ a: { b: undefined } })).toBe('the value.a.b is undefined, which is not JSON')
    expect(jsonProblem({ a: [1, NaN] })).toBe('the value.a[1] is not a finite number')
    expect(jsonProblem({ f: () => 1 })).toBe('the value.f is a function, which is not JSON')
    expect(jsonProblem({ when: new Date() })).toBe('the value.when is not a plain object')
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    expect(jsonProblem(cycle)).toBe('the value.self refers to itself')
  })

  it('allows the same object twice when it is not a cycle', () => {
    const shared = { x: 1 }
    expect(jsonProblem({ a: shared, b: shared })).toBeUndefined()
  })

  it('knows a plain object from arrays, null and class instances', () => {
    expect(isPlainObject({})).toBe(true)
    expect(isPlainObject(Object.create(null))).toBe(true)
    expect(isPlainObject([])).toBe(false)
    expect(isPlainObject(null)).toBe(false)
    expect(isPlainObject(new Map())).toBe(false)
  })

  it('compares as JSON: key order does not matter, array order does', () => {
    expect(deepEqual({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBe(true)
    expect(deepEqual([1, 2], [2, 1])).toBe(false)
    expect(deepEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false)
    expect(deepEqual({ a: null }, { a: {} })).toBe(false)
  })
})

describe('settings values: overrides over defaults', () => {
  const defaults = { reopen: true, limit: 10, matching: { before: 14, after: 3 }, folders: ['a'], extra: null }

  it('merges objects key by key, and replaces arrays and scalars', () => {
    expect(mergeOverDefaults(defaults, { limit: 5, matching: { after: 7 }, folders: ['b', 'c'] })).toEqual({
      reopen: true, limit: 5, matching: { before: 14, after: 7 }, folders: ['b', 'c'], extra: null
    })
  })

  it('keeps keys the defaults do not have', () => {
    expect(mergeOverDefaults({ a: 1 }, { b: 2 })).toEqual({ a: 1, b: 2 })
  })

  it('changes neither argument', () => {
    const overrides = { matching: { after: 7 } }
    const merged = mergeOverDefaults(defaults, overrides)
    ;(merged.matching as Record<string, number>).before = 0
    expect(defaults.matching.before).toBe(14)
    expect(overrides).toEqual({ matching: { after: 7 } })
  })

  it('stores only what differs, and the difference merges back to the value', () => {
    const value = { reopen: true, limit: 5, matching: { before: 14, after: 7 }, folders: ['a'], extra: 'x' }
    const overrides = diffFromDefaults(defaults, value)

    expect(overrides).toEqual({ limit: 5, matching: { after: 7 }, extra: 'x' })
    expect(mergeOverDefaults(defaults, overrides)).toEqual(value)
    expect(diffFromDefaults(defaults, mergeOverDefaults(defaults, {}))).toEqual({})
  })
})

describe('settings values: shape', () => {
  const defaults = { reopen: true, limit: 10, name: '', matching: { before: 14 }, folders: [], anything: null }

  it('accepts a value whose keys keep their default types', () => {
    expect(shapeProblems(defaults, { reopen: false, limit: 3, name: 'x', matching: { before: 1, added: 'ok' }, folders: ['x'], anything: { a: 1 } })).toEqual([])
  })

  it('reports each key whose type changed, by path', () => {
    expect(shapeProblems(defaults, { reopen: 'yes', limit: null, matching: { before: '14' }, folders: {} } as never)).toEqual([
      { path: 'reopen', problem: '"reopen" must be a boolean, not a string' },
      { path: 'limit', problem: '"limit" must be a number, not null' },
      { path: 'matching.before', problem: '"matching.before" must be a number, not a string' },
      { path: 'folders', problem: '"folders" must be a list, not an object' }
    ])
    expect(shapeProblems(defaults, { matching: [] } as never)).toEqual([{ path: 'matching', problem: '"matching" must be an object, not a list' }])
  })
})

describe('settings values: paths', () => {
  it('reads and writes by dotted path, without changing the original', () => {
    const value = { a: { b: { c: 1 } }, d: 2 }
    expect(getAtPath(value, 'a.b.c')).toBe(1)
    expect(getAtPath(value, 'a.x.c')).toBeUndefined()
    expect(getAtPath(value, 'd.e')).toBeUndefined()

    const next = setAtPath(value, 'a.b.c', 5)
    expect(next).toEqual({ a: { b: { c: 5 } }, d: 2 })
    expect(value.a.b.c).toBe(1)
    expect(setAtPath({}, 'x.y', true)).toEqual({ x: { y: true } })
  })

  it('refuses paths that would reach a prototype', () => {
    expect(isValidPath('a.b')).toBe(true)
    expect(isValidPath('__proto__.polluted')).toBe(false)
    expect(isValidPath('a..b')).toBe(false)
    expect(isValidPath('')).toBe(false)
    expect(() => setAtPath({}, '__proto__.polluted', true)).toThrow('Invalid settings path')
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(getAtPath({}, 'constructor')).toBeUndefined()
  })

  it('freezes a value all the way down', () => {
    const value = deepFreeze({ a: { b: [1, { c: 2 }] } })
    expect(Object.isFrozen(value.a.b[1])).toBe(true)
  })
})

describe('settings values: what changed', () => {
  it('names each setting that differs, nested ones by dotted path, a list as a whole', () => {
    const before = { reopen: true, limit: 10, matching: { before: 14, after: 3 }, folders: ['a'] }
    expect(changedPaths(before, { reopen: true, limit: 5, matching: { before: 14, after: 7 }, folders: ['a', 'b'] }))
      .toEqual(['limit', 'matching.after', 'folders'])
    expect(changedPaths(before, before)).toEqual([])
  })

  it('counts a key that appears or goes as changed', () => {
    expect(changedPaths({ a: 1, gone: null }, { a: 1, added: false })).toEqual(['gone', 'added'])
    expect(changedPaths({ map: {} }, { map: { x: 1 } })).toEqual(['map.x'])
  })
})
