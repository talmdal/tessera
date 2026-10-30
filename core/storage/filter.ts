// core/storage/filter.ts
//
// Compiles a Filter (plain data) into a predicate. Validation is strict: an
// operator outside the contract is UNSUPPORTED_QUERY, never ignored, so a
// misspelt `$gte` can't silently match everything.
import type { FieldOperators, Filter, Json } from '@tessera/types'
import { compareJson, deepEqual, getPath, isPlainObject } from './json'
import { invalidArgument, unsupported } from './errors'

export type Predicate = (doc: Json) => boolean

const FIELD_OPERATORS = new Set(['$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$in', '$nin', '$exists', '$regex', '$options', '$contains'])
const LOGICAL_OPERATORS = new Set(['$and', '$or', '$not', '$text'])

export const isOperatorObject = (value: unknown): value is Record<string, unknown> =>
  isPlainObject(value) && Object.keys(value).some(key => key.startsWith('$'))

/** The field paths a filter mentions (for index selection and explain). */
export function filterFields(filter: Filter | undefined): string[] {
  const fields = new Set<string>()
  const visit = (f: Filter) => {
    for (const [key, value] of Object.entries(f)) {
      if (key === '$and' || key === '$or') (value as Filter[]).forEach(visit)
      else if (key === '$not') visit(value as Filter)
      else if (key === '$text') (value as { $fields: string[] }).$fields.forEach(field => fields.add(field))
      else fields.add(key)
    }
  }
  if (filter) visit(filter)
  return [...fields]
}

/**
 * Top-level equalities of a filter (`{ a: 1, 'b.c': 'x' }`), used to build
 * the document an upsert inserts. Operators and logical keys contribute
 * nothing, except `$eq`.
 */
export function filterEqualities(filter: Filter): Record<string, Json> {
  const out: Record<string, Json> = {}
  for (const [key, value] of Object.entries(filter)) {
    if (key === '$and') for (const inner of value as Filter[]) Object.assign(out, filterEqualities(inner))
    else if (key.startsWith('$')) continue
    else if (isOperatorObject(value)) { if ('$eq' in value) out[key] = value.$eq as Json }
    else out[key] = value as Json
  }
  return out
}

export function compileFilter(filter: Filter | undefined): Predicate {
  if (filter === undefined) return () => true
  if (!isPlainObject(filter)) throw invalidArgument('A filter must be an object')

  const clauses: Predicate[] = []
  for (const [key, value] of Object.entries(filter)) {
    if (key.startsWith('$')) clauses.push(compileLogical(key, value))
    else clauses.push(compileField(key, value as Json | FieldOperators))
  }
  if (clauses.length === 0) return () => true
  if (clauses.length === 1) return clauses[0]
  return doc => clauses.every(clause => clause(doc))
}

function compileLogical(key: string, value: unknown): Predicate {
  if (!LOGICAL_OPERATORS.has(key)) throw unsupported(`operator ${key}`, { operator: key })
  switch (key) {
    case '$and':
    case '$or': {
      if (!Array.isArray(value) || value.length === 0) throw invalidArgument(`${key} needs a non-empty array of filters`)
      const inner = value.map(item => compileFilter(item as Filter))
      return key === '$and' ? doc => inner.every(p => p(doc)) : doc => inner.some(p => p(doc))
    }
    case '$not': {
      const inner = compileFilter(value as Filter)
      return doc => !inner(doc)
    }
    default:
      return compileText(value)
  }
}

function compileField(path: string, condition: Json | FieldOperators): Predicate {
  if (!isOperatorObject(condition)) {
    const expected = condition as Json
    return doc => deepEqual(getPath(doc, path), expected)
  }

  const tests: ((actual: Json | undefined) => boolean)[] = []
  for (const [op, arg] of Object.entries(condition)) {
    if (!FIELD_OPERATORS.has(op)) throw unsupported(`operator ${op} on field ${path}`, { operator: op, field: path })
    switch (op) {
      case '$eq': tests.push(actual => deepEqual(actual, arg as Json)); break
      case '$ne': tests.push(actual => !deepEqual(actual, arg as Json)); break
      case '$gt': tests.push(comparison(arg as Json, result => result > 0)); break
      case '$gte': tests.push(comparison(arg as Json, result => result >= 0)); break
      case '$lt': tests.push(comparison(arg as Json, result => result < 0)); break
      case '$lte': tests.push(comparison(arg as Json, result => result <= 0)); break
      case '$in':
      case '$nin': {
        if (!Array.isArray(arg)) throw invalidArgument(`${op} needs an array`)
        const members = arg as Json[]
        const contains = (actual: Json | undefined) => members.some(member => deepEqual(actual, member))
        tests.push(op === '$in' ? contains : actual => !contains(actual))
        break
      }
      case '$exists': tests.push(actual => (actual !== undefined) === Boolean(arg)); break
      case '$regex': {
        if (typeof arg !== 'string') throw invalidArgument('$regex needs a string pattern')
        const options = (condition as FieldOperators).$options
        let regex: RegExp
        try {
          regex = new RegExp(arg, options ?? '')
        } catch (err) {
          throw invalidArgument(`Invalid $regex: ${(err as Error).message}`)
        }
        tests.push(actual => typeof actual === 'string' && regex.test(actual))
        break
      }
      case '$options':
        if (!('$regex' in condition)) throw invalidArgument('$options needs $regex')
        break
      case '$contains': tests.push(actual => Array.isArray(actual) && actual.some(item => deepEqual(item, arg as Json))); break
    }
  }
  return doc => {
    const actual = getPath(doc, path)
    return tests.every(test => test(actual))
  }
}

/** Ordered comparison between values of the same JSON type only; `null`, arrays and objects never compare. */
function comparison(expected: Json, accept: (result: number) => boolean) {
  const kind = typeof expected
  if (kind !== 'number' && kind !== 'string' && kind !== 'boolean') {
    throw invalidArgument('Comparison operators need a number, string or boolean')
  }
  return (actual: Json | undefined) => typeof actual === kind && accept(compareJson(actual, expected))
}

// ---------------------------------------------------------------------------
// $text

const WORD = /[\p{L}\p{N}]+/gu

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(WORD) ?? [])
}

function compileText(spec: unknown): Predicate {
  if (!isPlainObject(spec) || typeof spec.$search !== 'string' || !Array.isArray(spec.$fields) || spec.$fields.length === 0) {
    throw invalidArgument('$text needs { $search: string, $fields: [string, ...] }')
  }
  const terms = tokenize(spec.$search)
  const fields = spec.$fields as string[]
  if (terms.length === 0) return () => false
  return doc => {
    const words = new Set<string>()
    for (const field of fields) {
      const value = getPath(doc, field)
      if (typeof value === 'string') for (const word of tokenize(value)) words.add(word)
    }
    return terms.every(term => words.has(term))
  }
}
