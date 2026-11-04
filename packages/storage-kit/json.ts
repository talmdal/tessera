import type { Json, JsonObject } from '@tessera/types'
import { StorageError } from './errors'

const isPlainObject = (value: unknown): value is JsonObject => {
  if (typeof value !== 'object' || value === null) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * A validated deep copy. Properties holding `undefined` are dropped, as JSON would; anything else that
 * is not JSON (functions, NaN, Dates, class instances…) is INVALID_DOCUMENT. Field names may not start
 * with `$` or contain `.`, so they can't be mistaken for operators or paths.
 */
export function normalize(value: unknown, where = 'document'): Json {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new StorageError('INVALID_DOCUMENT', `${where}: ${value} is not JSON`)
    return value
  }
  if (Array.isArray(value)) return value.map((item, i) => item === undefined ? null : normalize(item, `${where}[${i}]`))
  if (isPlainObject(value)) {
    const copy: JsonObject = {}
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue
      if (key.startsWith('$') || key.includes('.')) {
        throw new StorageError('INVALID_DOCUMENT', `${where}: field name "${key}" may not start with "$" or contain "."`)
      }
      copy[key] = normalize(item, `${where}.${key}`)
    }
    return copy
  }
  throw new StorageError('INVALID_DOCUMENT', `${where}: a ${typeof value} is not JSON`)
}

export const clone = <T extends Json>(value: T): T => {
  if (typeof value !== 'object' || value === null) return value
  if (Array.isArray(value)) return value.map(clone) as T
  const copy: JsonObject = {}
  for (const key of Object.keys(value)) copy[key] = clone((value as JsonObject)[key])
  return copy as T
}

export function equals(a: Json | undefined, b: Json | undefined): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) {
    const other = b as Json[]
    return a.length === other.length && a.every((item, i) => equals(item, other[i]))
  }
  const left = a as JsonObject, right = b as JsonObject
  const keys = Object.keys(left)
  return keys.length === Object.keys(right).length && keys.every(k => k in right && equals(left[k], right[k]))
}

/** Type rank for ordering: missing < null < boolean < number < string < array < object. */
export function rank(value: Json | undefined): number {
  if (value === undefined) return 0
  if (value === null) return 1
  if (typeof value === 'boolean') return 2
  if (typeof value === 'number') return 3
  if (typeof value === 'string') return 4
  return Array.isArray(value) ? 5 : 6
}

/** Total order across types; within a type, natural order (arrays and objects by their JSON text). */
export function compare(a: Json | undefined, b: Json | undefined): number {
  const ra = rank(a), rb = rank(b)
  if (ra !== rb) return ra - rb
  switch (ra) {
    case 2: return Number(a) - Number(b)
    case 3: return (a as number) - (b as number)
    case 4: return (a as string) < (b as string) ? -1 : (a as string) > (b as string) ? 1 : 0
    case 5: case 6: {
      const sa = stableStringify(a as Json), sb = stableStringify(b as Json)
      return sa < sb ? -1 : sa > sb ? 1 : 0
    }
    default: return 0
  }
}

/** JSON text with object keys sorted, so equal values give equal text. */
export function stableStringify(value: Json | undefined): string {
  if (value === undefined) return 'undefined'
  if (typeof value !== 'object' || value === null) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const object = value as JsonObject
  return `{${Object.keys(object).sort().map(k => `${JSON.stringify(k)}:${stableStringify(object[k])}`).join(',')}}`
}

const isObject = (value: Json | undefined): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export function getPath(doc: Json | undefined, path: string): Json | undefined {
  if (!path.includes('.')) return isObject(doc) ? doc[path] : undefined
  let current: Json | undefined = doc
  for (const part of path.split('.')) {
    if (!isObject(current)) return undefined
    current = current[part]
  }
  return current
}

/** Sets a dotted path, creating objects on the way; false if something other than an object is in the way. */
export function setPath(doc: JsonObject, path: string, value: Json): boolean {
  const parts = path.split('.')
  let current: JsonObject = doc
  for (const part of parts.slice(0, -1)) {
    const next = current[part]
    if (next === undefined || next === null) current = current[part] = {}
    else if (isObject(next)) current = next
    else return false
  }
  current[parts[parts.length - 1]] = value
  return true
}

export function unsetPath(doc: JsonObject, path: string) {
  const parts = path.split('.')
  let current: Json | undefined = doc
  for (const part of parts.slice(0, -1)) {
    if (!isObject(current)) return
    current = current[part]
  }
  if (isObject(current)) delete current[parts[parts.length - 1]]
}
