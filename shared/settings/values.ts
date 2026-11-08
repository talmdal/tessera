// shared/settings/values.ts — settings values are JSON: checking, comparing, merging over defaults, and reaching into
// them by dotted path. Pure functions, so the main process and the Options dialog treat values exactly alike.
import type { Json, JsonObject } from '@tessera/types'

/** A plain object (not an array, null, or a class instance such as a Date). */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * Why `value` is not JSON (a function, `undefined`, NaN, a Date, a cycle…), naming where, or undefined when it is.
 * `at` is the path shown in the message.
 */
export function jsonProblem(value: unknown, at = 'the value', seen = new Set<unknown>()): string | undefined {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return undefined
  if (typeof value === 'number') return Number.isFinite(value) ? undefined : `${at} is not a finite number`
  if (typeof value !== 'object') return `${at} is ${typeof value === 'undefined' ? 'undefined' : `a ${typeof value}`}, which is not JSON`
  if (seen.has(value)) return `${at} refers to itself`
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        const problem = jsonProblem(value[i], `${at}[${i}]`, seen)
        if (problem) return problem
      }
      return undefined
    }
    if (!isPlainObject(value)) return `${at} is not a plain object`
    for (const [key, item] of Object.entries(value)) {
      const problem = jsonProblem(item, `${at}.${key}`, seen)
      if (problem) return problem
    }
    return undefined
  } finally {
    seen.delete(value)
  }
}

export const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))

/** Equal as JSON: the order of an object's keys doesn't matter, an array's order does. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((item, i) => deepEqual(item, b[i]))
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = Object.keys(a)
    if (keys.length !== Object.keys(b).length) return false
    return keys.every(key => Object.prototype.hasOwnProperty.call(b, key) && deepEqual(a[key], b[key]))
  }
  return false
}

/**
 * `overrides` merged over `defaults`: objects merge key by key, arrays and everything else replace wholesale. Keys the
 * defaults don't have are kept (a map the user fills, or a key from a newer version). Neither argument is changed.
 */
export function mergeOverDefaults(defaults: JsonObject, overrides: JsonObject): JsonObject {
  const result: JsonObject = clone(defaults)
  for (const [key, value] of Object.entries(overrides)) {
    const base = result[key]
    result[key] = isPlainObject(base) && isPlainObject(value)
      ? mergeOverDefaults(base as JsonObject, value as JsonObject)
      : clone(value)
  }
  return result
}

/**
 * What of `value` differs from `defaults`: the smallest overrides that `mergeOverDefaults` turns back into `value`.
 * A key of the defaults that `value` lacks can't be expressed, and is left at its default.
 */
export function diffFromDefaults(defaults: JsonObject, value: JsonObject): JsonObject {
  const result: JsonObject = {}
  for (const [key, item] of Object.entries(value)) {
    const base = defaults[key]
    if (isPlainObject(base) && isPlainObject(item)) {
      const inner = diffFromDefaults(base as JsonObject, item as JsonObject)
      if (Object.keys(inner).length > 0) result[key] = inner
    } else if (!Object.prototype.hasOwnProperty.call(defaults, key) || !deepEqual(base, item)) {
      result[key] = clone(item)
    }
  }
  return result
}

const kindOf = (value: unknown) =>
  value === null ? 'null' : Array.isArray(value) ? 'a list' : isPlainObject(value) ? 'an object' : `a ${typeof value}`

/**
 * Keys of `value` whose JSON type differs from their default's: a number where the default is a number must stay a
 * number. A default of `null` accepts anything, objects are checked key by key, and keys the defaults don't have are
 * not checked. Returns the dotted paths and what is wrong, for messages and for dropping bad keys.
 */
export function shapeProblems(defaults: JsonObject, value: JsonObject, prefix = ''): { path: string, problem: string }[] {
  const problems: { path: string, problem: string }[] = []
  for (const [key, base] of Object.entries(defaults)) {
    if (!Object.prototype.hasOwnProperty.call(value, key) || base === null) continue
    const item = value[key]
    const path = prefix + key
    if (isPlainObject(base)) {
      if (!isPlainObject(item)) problems.push({ path, problem: `"${path}" must be an object, not ${kindOf(item)}` })
      else problems.push(...shapeProblems(base as JsonObject, item as JsonObject, `${path}.`))
    } else if (kindOf(base) !== kindOf(item)) {
      problems.push({ path, problem: `"${path}" must be ${kindOf(base)}, not ${kindOf(item)}` })
    }
  }
  return problems
}

/**
 * The settings that differ between two values, as dotted paths to their keys: objects are compared key by key, anything
 * else (a list included) as a whole. A key present in only one of them has changed.
 */
export function changedPaths(before: JsonObject, after: JsonObject, prefix = ''): string[] {
  const has = (value: JsonObject, key: string) => Object.prototype.hasOwnProperty.call(value, key)
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].flatMap(key => {
    const a = before[key]
    const b = after[key]
    if (isPlainObject(a) && isPlainObject(b)) return changedPaths(a as JsonObject, b as JsonObject, `${prefix}${key}.`)
    return has(before, key) === has(after, key) && deepEqual(a, b) ? [] : [`${prefix}${key}`]
  })
}

/** Path segments that would reach an object's prototype rather than its own data. */
const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

/** True for a dotted path of non-empty keys, none of which reaches a prototype. */
export function isValidPath(path: unknown): path is string {
  return typeof path === 'string' && path.length > 0 && path.split('.').every(key => key.length > 0 && !UNSAFE_KEYS.has(key))
}

/** The value at a dotted path, or undefined when a key on the way is missing. */
export function getAtPath(value: unknown, path: string): Json | undefined {
  let current: unknown = value
  for (const key of path.split('.')) {
    if (!isPlainObject(current) || !Object.prototype.hasOwnProperty.call(current, key)) return undefined
    current = current[key]
  }
  return current as Json
}

/** A copy of `value` with the dotted path set, creating objects on the way. */
export function setAtPath(value: JsonObject, path: string, item: Json): JsonObject {
  if (!isValidPath(path)) throw new Error(`Invalid settings path "${String(path)}"`)
  const result = clone(value)
  const keys = path.split('.')
  let target: Record<string, unknown> = result
  for (const key of keys.slice(0, -1)) {
    if (!isPlainObject(target[key])) target[key] = {}
    target = target[key] as Record<string, unknown>
  }
  target[keys[keys.length - 1]] = clone(item)
  return result
}

/** Freezes a JSON value and everything in it, so a reader can't change what others read. */
export function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const item of Object.values(value)) deepFreeze(item)
  }
  return value
}
