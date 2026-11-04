import type { Filter, Json, JsonObject } from '@tessera/types'
import { StorageError } from './errors'
import { compare, equals, getPath, rank } from './json'

export type Matcher = (doc: JsonObject) => boolean

const OPERATORS = new Set([
  '$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$in', '$nin', '$exists', '$regex', '$options', '$contains'
])

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const unsupported = (message: string) => new StorageError('UNSUPPORTED_QUERY', message)

/** Comparison operators apply only between values of the same type, so `$lt: 100` never matches a string. */
const ordered = (a: Json | undefined, b: Json): number | undefined =>
  rank(a) === rank(b) && rank(b) >= 2 && rank(b) <= 4 ? compare(a, b) : undefined

const words = (text: string) => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)

/** Compiles a filter, rejecting anything outside the supported operators even if no document is ever tested. */
export function compileFilter(filter: Filter | undefined): Matcher {
  if (filter === undefined) return () => true
  if (!isObject(filter)) throw new StorageError('INVALID_ARGUMENT', 'a filter must be an object')

  const parts: Matcher[] = []
  for (const [key, value] of Object.entries(filter)) {
    if (key === '$and' || key === '$or') {
      if (!Array.isArray(value)) throw new StorageError('INVALID_ARGUMENT', `${key} takes an array of filters`)
      const inner = value.map(f => compileFilter(f as Filter))
      parts.push(key === '$and' ? doc => inner.every(m => m(doc)) : doc => inner.some(m => m(doc)))
    } else if (key === '$not') {
      const inner = compileFilter(value as Filter)
      parts.push(doc => !inner(doc))
    } else if (key === '$text') {
      parts.push(compileText(value))
    } else if (key.startsWith('$')) {
      throw unsupported(`unsupported filter operator ${key}`)
    } else {
      parts.push(compileField(key, value as Json | Record<string, unknown> | undefined))
    }
  }
  return parts.length === 1 ? parts[0] : doc => parts.every(m => m(doc))
}

function compileText(spec: unknown): Matcher {
  const { $search, $fields } = (spec ?? {}) as { $search?: unknown, $fields?: unknown }
  if (typeof $search !== 'string' || !Array.isArray($fields) || $fields.some(f => typeof f !== 'string')) {
    throw new StorageError('INVALID_ARGUMENT', '$text needs a string $search and an array of $fields')
  }
  const terms = words($search)
  const fields = $fields as string[]
  return doc => {
    if (terms.length === 0) return true
    const present = new Set<string>()
    for (const field of fields) {
      const value = getPath(doc, field)
      for (const text of Array.isArray(value) ? value : [value]) {
        if (typeof text === 'string') for (const word of words(text)) present.add(word)
      }
    }
    return terms.every(term => present.has(term))
  }
}

function compileField(field: string, spec: Json | Record<string, unknown> | undefined): Matcher {
  if (spec === undefined) return doc => getPath(doc, field) === undefined
  if (!isObject(spec)) return doc => equals(getPath(doc, field), spec as Json)

  const keys = Object.keys(spec)
  const operatorKeys = keys.filter(k => k.startsWith('$'))
  if (operatorKeys.length === 0) return doc => equals(getPath(doc, field), spec as Json)
  if (operatorKeys.length !== keys.length) {
    throw new StorageError('INVALID_ARGUMENT', `"${field}" mixes operators with plain fields`)
  }

  const tests: ((value: Json | undefined) => boolean)[] = []
  for (const [op, arg] of Object.entries(spec)) {
    if (!OPERATORS.has(op)) throw unsupported(`unsupported operator ${op} on "${field}"`)
    const value = arg as Json
    switch (op) {
      case '$eq': tests.push(v => equals(v, value)); break
      case '$ne': tests.push(v => !equals(v, value)); break
      case '$gt': tests.push(v => (ordered(v, value) ?? NaN) > 0); break
      case '$gte': tests.push(v => (ordered(v, value) ?? NaN) >= 0); break
      case '$lt': tests.push(v => (ordered(v, value) ?? NaN) < 0); break
      case '$lte': tests.push(v => (ordered(v, value) ?? NaN) <= 0); break
      case '$in': case '$nin': {
        if (!Array.isArray(value)) throw new StorageError('INVALID_ARGUMENT', `${op} takes an array`)
        const list = value
        tests.push(op === '$in' ? v => list.some(x => equals(v, x)) : v => !list.some(x => equals(v, x)))
        break
      }
      case '$exists': tests.push(v => (v !== undefined) === Boolean(value)); break
      case '$regex': {
        if (typeof value !== 'string') throw new StorageError('INVALID_ARGUMENT', '$regex takes a string pattern')
        const flags = typeof spec.$options === 'string' ? spec.$options : ''
        let pattern: RegExp
        try { pattern = new RegExp(value, flags.replace(/[gy]/g, '')) } catch (err) {
          throw new StorageError('INVALID_ARGUMENT', `bad $regex: ${(err as Error).message}`)
        }
        tests.push(v => typeof v === 'string' && pattern.test(v))
        break
      }
      case '$options':
        if (!('$regex' in spec)) throw new StorageError('INVALID_ARGUMENT', '$options needs $regex')
        break
      case '$contains': tests.push(v => Array.isArray(v) && v.some(item => equals(item, value))); break
    }
  }
  return doc => { const value = getPath(doc, field); return tests.every(test => test(value)) }
}

/** The top-level `field: value` equalities of a filter (including `$eq`), which an upsert builds its document from. */
export function equalities(filter: Filter | undefined): Record<string, Json> {
  const found: Record<string, Json> = {}
  for (const [key, value] of Object.entries(filter ?? {})) {
    if (key.startsWith('$')) continue
    if (isObject(value) && Object.keys(value).some(k => k.startsWith('$'))) {
      if ('$eq' in value) found[key] = value.$eq as Json
    } else if (value !== undefined) found[key] = value as Json
  }
  return found
}
