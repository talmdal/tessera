import type { Filter, Json, JsonObject, Stage } from '@tessera/types'
import { StorageError } from './errors'
import { compileFilter, Matcher } from './filter'
import { clone, compare, equals, getPath, setPath, stableStringify, unsetPath } from './json'
import { compareBy, sortKey } from './sort'

export type Lookup = (collection: string) => JsonObject[]

const unsupported = (message: string) => new StorageError('UNSUPPORTED_QUERY', message)
const argument = (message: string) => new StorageError('INVALID_ARGUMENT', message)

const EXPRESSION_OPERATORS = new Set([
  '$substr', '$concat', '$add', '$subtract', '$multiply', '$divide', '$abs', '$ifNull', '$cond', '$year', '$month'
])
const ACCUMULATORS = new Set(['$sum', '$avg', '$min', '$max', '$count', '$first', '$last', '$push'])

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const matchers = new WeakMap<object, Matcher>()
const matcherFor = (filter: Filter) => {
  let matcher = matchers.get(filter)
  if (!matcher) matchers.set(filter, matcher = compileFilter(filter))
  return matcher
}

/** `'$field'` reads a field; objects and arrays are evaluated member by member; anything else is a literal. */
export function evaluate(expr: unknown, doc: JsonObject): Json | undefined {
  if (typeof expr === 'string') return expr.startsWith('$') ? getPath(doc, expr.slice(1)) : expr
  if (Array.isArray(expr)) return expr.map(item => evaluate(item, doc) ?? null)
  if (!isObject(expr)) return expr as Json

  const keys = Object.keys(expr)
  if (keys.some(k => k.startsWith('$'))) {
    if (keys.length !== 1 || !EXPRESSION_OPERATORS.has(keys[0])) throw unsupported(`unsupported expression operator ${keys.find(k => k.startsWith('$'))}`)
    return operator(keys[0], expr[keys[0]], doc)
  }
  const result: JsonObject = {}
  for (const key of keys) {
    const value = evaluate(expr[key], doc)
    if (value !== undefined) result[key] = value
  }
  return result
}

const numbers = (args: unknown, doc: JsonObject, op: string): number[] | undefined => {
  if (!Array.isArray(args)) throw argument(`${op} takes an array`)
  const values = args.map(a => evaluate(a, doc))
  return values.every(v => typeof v === 'number') ? values as number[] : undefined
}

const datePart = (value: Json | undefined, from: number, to: number) => {
  if (typeof value !== 'string') return null
  const part = Number(value.slice(from, to))
  return Number.isInteger(part) ? part : null
}

function operator(op: string, args: unknown, doc: JsonObject): Json | undefined {
  switch (op) {
    case '$substr': {
      if (!Array.isArray(args) || args.length !== 3) throw argument('$substr takes [expression, start, length]')
      const text = evaluate(args[0], doc)
      return typeof text === 'string' ? text.substr(args[1] as number, args[2] as number) : null
    }
    case '$concat': {
      if (!Array.isArray(args)) throw argument('$concat takes an array')
      const parts = args.map(a => evaluate(a, doc))
      return parts.every(p => typeof p === 'string') ? parts.join('') : null
    }
    case '$add': { const n = numbers(args, doc, op); return n ? n.reduce((a, b) => a + b, 0) : null }
    case '$multiply': { const n = numbers(args, doc, op); return n ? n.reduce((a, b) => a * b, 1) : null }
    case '$subtract': { const n = numbers(args, doc, op); return n && n.length === 2 ? n[0] - n[1] : null }
    case '$divide': { const n = numbers(args, doc, op); return n && n.length === 2 && n[1] !== 0 ? n[0] / n[1] : null }
    case '$abs': { const v = evaluate(args, doc); return typeof v === 'number' ? Math.abs(v) : null }
    case '$ifNull': {
      if (!Array.isArray(args) || args.length !== 2) throw argument('$ifNull takes [expression, fallback]')
      const v = evaluate(args[0], doc)
      return v === undefined || v === null ? evaluate(args[1], doc) ?? null : v
    }
    case '$cond': {
      if (!Array.isArray(args) || args.length !== 3) throw argument('$cond takes [filter, then, else]')
      return evaluate(matcherFor(args[0] as Filter)(doc) ? args[1] : args[2], doc)
    }
    case '$year': return datePart(evaluate(args, doc), 0, 4)
    case '$month': return datePart(evaluate(args, doc), 5, 7)
  }
  throw unsupported(`unsupported expression operator ${op}`)
}

// ---- Accumulators --------------------------------------------------------------------------

function accumulate(spec: unknown, rows: JsonObject[]): Json {
  if (!isObject(spec) || Object.keys(spec).length !== 1 || !ACCUMULATORS.has(Object.keys(spec)[0])) {
    throw unsupported('a $group output must be one of $sum, $avg, $min, $max, $count, $first, $last, $push')
  }
  const op = Object.keys(spec)[0]
  if (op === '$count') return rows.length
  const values = rows.map(row => evaluate(spec[op], row))
  const defined = values.filter((v): v is Json => v !== undefined && v !== null)
  const nums = values.filter((v): v is number => typeof v === 'number')
  switch (op) {
    case '$sum': return nums.reduce((a, b) => a + b, 0)
    case '$avg': return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null
    case '$min': return defined.length ? defined.reduce((a, b) => compare(b, a) < 0 ? b : a) : null
    case '$max': return defined.length ? defined.reduce((a, b) => compare(b, a) > 0 ? b : a) : null
    case '$first': return values.length ? values[0] ?? null : null
    case '$last': return values.length ? values[values.length - 1] ?? null : null
    default: return values.filter((v): v is Json => v !== undefined)   // $push
  }
}

// ---- Stages --------------------------------------------------------------------------------

function project(docs: JsonObject[], spec: Record<string, unknown>): JsonObject[] {
  const entries = Object.entries(spec)
  const excludes = entries.filter(([, v]) => v === 0).map(([k]) => k)

  // All exclusions, or inclusions where only `id` / `_id` may be excluded.
  if (excludes.length > 0 && excludes.length === entries.length) {
    return docs.map(doc => { const copy = clone(doc); for (const path of excludes) unsetPath(copy, path); return copy })
  }
  if (excludes.some(k => k !== 'id' && k !== '_id')) {
    throw argument("$project can't mix exclusions with inclusions or expressions")
  }

  const dropped = new Set(excludes)
  return docs.map(doc => {
    const out: JsonObject = {}
    for (const key of ['id', '_id']) if (key in doc && !dropped.has(key)) out[key] = clone(doc[key])
    for (const [path, how] of entries) {
      if (how === 0) continue
      const value = how === 1 ? getPath(doc, path) : evaluate(how, doc)
      if (value !== undefined) setPath(out, path, clone(value))
    }
    return out
  })
}

function group(docs: JsonObject[], spec: Record<string, unknown>): JsonObject[] {
  if (!('_id' in spec)) throw argument('$group needs an _id')
  const buckets = new Map<string, { id: Json, rows: JsonObject[] }>()
  for (const doc of docs) {
    const id = spec._id === null ? null : evaluate(spec._id, doc) ?? null
    const key = stableStringify(id)
    const bucket = buckets.get(key)
    if (bucket) bucket.rows.push(doc)
    else buckets.set(key, { id, rows: [doc] })
  }
  const outputs = Object.entries(spec).filter(([k]) => k !== '_id')
  for (const [, accumulator] of outputs) accumulate(accumulator, [])   // reject bad specs even with no input
  return [...buckets.values()].map(({ id, rows }) => {
    const out: JsonObject = { _id: id }
    for (const [name, accumulator] of outputs) out[name] = accumulate(accumulator, rows)
    return out
  })
}

const count = (value: unknown, stage: string) => {
  if (!Number.isInteger(value) || (value as number) < 0) throw argument(`${stage} takes a non-negative integer`)
  return value as number
}

function runStage(docs: JsonObject[], stage: Stage, lookup: Lookup): JsonObject[] {
  const keys = Object.keys(stage)
  if (!isObject(stage) || keys.length !== 1) throw argument('each pipeline stage has exactly one operator')
  const op = keys[0]
  const spec = (stage as Record<string, unknown>)[op]

  switch (op) {
    case '$match': { const m = compileFilter(spec as Filter); return docs.filter(m) }
    case '$project': return project(docs, spec as Record<string, unknown>)
    case '$group': return group(docs, spec as Record<string, unknown>)
    case '$sort': { const key = sortKey(spec as never); return [...docs].sort((a, b) => compareBy(key, a, b)) }
    case '$skip': return docs.slice(count(spec, op))
    case '$limit': return docs.slice(0, count(spec, op))
    case '$count': {
      if (typeof spec !== 'string' || !spec) throw argument('$count takes an output field name')
      return [{ [spec]: docs.length }]
    }
    case '$unwind': {
      if (typeof spec !== 'string' || !spec.startsWith('$')) throw argument("$unwind takes a field reference like '$items'")
      const path = spec.slice(1)
      return docs.flatMap(doc => {
        const list = getPath(doc, path)
        if (!Array.isArray(list)) return []
        return list.map(item => { const copy = clone(doc); setPath(copy, path, item); return copy })
      })
    }
    case '$lookup': {
      const { from, localField, foreignField, as } = (spec ?? {}) as Record<string, string>
      if (![from, localField, foreignField, as].every(s => typeof s === 'string' && s)) {
        throw argument('$lookup needs from, localField, foreignField and as')
      }
      const foreign = lookup(from)
      return docs.map(doc => {
        const local = getPath(doc, localField)
        const matches = local === undefined ? [] : foreign.filter(f => equals(getPath(f, foreignField), local))
        const copy = { ...doc }
        copy[as] = matches.map(m => clone(m))
        return copy
      })
    }
  }
  throw unsupported(`unsupported pipeline stage ${op}`)
}

/** The shared interpreter: runs a pipeline over documents, with `lookup` supplying other collections for `$lookup`. */
export function runPipeline(docs: JsonObject[], pipeline: Stage[], lookup: Lookup): JsonObject[] {
  if (!Array.isArray(pipeline)) throw argument('a pipeline is an array of stages')
  let rows = docs
  for (const stage of pipeline) rows = runStage(rows, stage, lookup)
  return rows.map(row => clone(row))
}
