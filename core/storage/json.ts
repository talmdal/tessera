// core/storage/json.ts
//
// Helpers over the Json value model: validation, copying, dotted paths,
// equality and a total order used by sorting, comparisons and grouping.
import type { Json, JsonObject } from '@tessera/types'
import { invalidDocument } from './errors'

export const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)

export const isJsonObject = (value: Json | undefined): value is JsonObject => isPlainObject(value)

/**
 * Validates and copies a value into the Json model. `undefined` properties
 * are dropped (as JSON.stringify does) and `undefined` array elements become
 * null; anything else that isn't JSON (functions, Dates, class instances,
 * NaN, bigint) is INVALID_DOCUMENT rather than silently converted.
 */
export function toJson(value: unknown, path = ''): Json {
  if (value === null) return null
  switch (typeof value) {
    case 'boolean':
    case 'string':
      return value
    case 'number':
      if (!Number.isFinite(value)) throw invalidDocument(`${path || 'value'} is not a finite number`)
      return value
    case 'undefined':
      return null
  }
  if (Array.isArray(value)) return value.map((item, i) => toJson(item, `${path}[${i}]`))
  if (isPlainObject(value)) {
    const out: JsonObject = {}
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue
      out[key] = toJson(item, path ? `${path}.${key}` : key)
    }
    return out
  }
  throw invalidDocument(`${path || 'value'} is not JSON (${describeType(value)})`)
}

function describeType(value: unknown) {
  if (typeof value !== 'object' || value === null) return typeof value
  return (value as object).constructor?.name ?? 'object'
}

/** A deep copy of a Json value (which is plain data, so this is cheap and safe). */
export function cloneJson<T extends Json | undefined>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(cloneJson) as T
  const out: JsonObject = {}
  for (const key in value) out[key] = cloneJson((value as JsonObject)[key])
  return out as T
}

export function deepEqual(a: Json | undefined, b: Json | undefined): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) {
    return a.length === (b as Json[]).length && a.every((item, i) => deepEqual(item, (b as Json[])[i]))
  }
  const keysA = Object.keys(a)
  const keysB = Object.keys(b as JsonObject)
  return keysA.length === keysB.length && keysA.every(key => deepEqual(a[key], (b as JsonObject)[key]))
}

/** Reads a dotted path. Numeric segments index arrays. Missing anywhere yields undefined. */
export function getPath(doc: Json | undefined, path: string): Json | undefined {
  let current: Json | undefined = doc
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined
    if (Array.isArray(current)) {
      const index = Number(segment)
      current = Number.isInteger(index) ? current[index] : undefined
    } else {
      current = Object.prototype.hasOwnProperty.call(current, segment) ? current[segment] : undefined
    }
  }
  return current
}

/** Writes a dotted path into an object, creating intermediate objects. Mutates `doc`. */
export function setPath(doc: JsonObject, path: string, value: Json): void {
  const segments = path.split('.')
  let current: JsonObject = doc
  for (const segment of segments.slice(0, -1)) {
    const next = current[segment]
    if (!isJsonObject(next)) current[segment] = {}
    current = current[segment] as JsonObject
  }
  current[segments[segments.length - 1]] = value
}

/** Removes a dotted path. Mutates `doc`; a missing path is a no-op. */
export function deletePath(doc: JsonObject, path: string): void {
  const segments = path.split('.')
  let current: JsonObject = doc
  for (const segment of segments.slice(0, -1)) {
    const next = current[segment]
    if (!isJsonObject(next)) return
    current = next
  }
  delete current[segments[segments.length - 1]]
}

/**
 * A total order over Json values (and undefined), for sorting and range
 * comparisons: missing < null < boolean < number < string < array < object.
 * Arrays and objects compare by their canonical JSON text.
 */
export function compareJson(a: Json | undefined, b: Json | undefined): number {
  const rankA = rank(a)
  const rankB = rank(b)
  if (rankA !== rankB) return rankA - rankB
  switch (rankA) {
    case 2: return Number(a) - Number(b)
    case 3: return (a as number) < (b as number) ? -1 : a === b ? 0 : 1
    case 4: return (a as string) < (b as string) ? -1 : a === b ? 0 : 1
    case 5:
    case 6: {
      const textA = canonical(a as Json)
      const textB = canonical(b as Json)
      return textA < textB ? -1 : textA === textB ? 0 : 1
    }
    default: return 0
  }
}

function rank(value: Json | undefined): number {
  if (value === undefined) return 0
  if (value === null) return 1
  switch (typeof value) {
    case 'boolean': return 2
    case 'number': return 3
    case 'string': return 4
  }
  return Array.isArray(value) ? 5 : 6
}

/** Same value, same text: object keys sorted. Used for grouping keys and ordering. */
export function canonical(value: Json | undefined): string {
  if (value === undefined) return 'undefined'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
}

export function isComparable(value: Json | undefined): value is number | string {
  return typeof value === 'number' || typeof value === 'string'
}
