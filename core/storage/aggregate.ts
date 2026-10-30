// core/storage/aggregate.ts
//
// The shared aggregation interpreter: runs a pipeline over an array of
// documents. Backends without native aggregation use it as is; backends with
// it (SQLite) can use it for stages they can't translate. Validation is
// strict, as for filters: an unknown stage or expression operator is
// UNSUPPORTED_QUERY.
import type { Accumulator, Expression, Filter, GroupStage, Json, JsonObject, Sort, Stage } from '@tessera/types'
import { invalidArgument, unsupported } from './errors'
import { compileFilter, isOperatorObject, type Predicate } from './filter'
import { canonical, cloneJson, compareJson, getPath, isPlainObject, setPath } from './json'
import { compileSort } from './sort'

/** Supplies the documents of another collection for $lookup. */
export type CollectionResolver = (name: string) => Promise<JsonObject[]>

type Evaluator = (doc: JsonObject) => Json | undefined

// ---------------------------------------------------------------------------
// Expressions

const EXPRESSION_OPERATORS = new Set(['$substr', '$concat', '$add', '$subtract', '$multiply', '$divide', '$abs', '$ifNull', '$cond', '$year', '$month'])

export function compileExpression(expression: Expression): Evaluator {
  if (typeof expression === 'string' && expression.startsWith('$')) {
    const path = expression.slice(1)
    return doc => getPath(doc, path)
  }
  if (!isOperatorObject(expression)) {
    if (Array.isArray(expression)) {
      const items = expression.map(item => compileExpression(item as Expression))
      return doc => items.map(item => item(doc) ?? null)
    }
    if (isPlainObject(expression)) {
      const entries = Object.entries(expression).map(([key, value]) => [key, compileExpression(value as Expression)] as const)
      return doc => {
        const out: JsonObject = {}
        for (const [key, item] of entries) {
          const value = item(doc)
          if (value !== undefined) out[key] = value
        }
        return out
      }
    }
    const literal = expression as Json
    return () => literal
  }

  const keys = Object.keys(expression)
  if (keys.length !== 1) throw invalidArgument(`An expression holds one operator, got ${keys.join(', ')}`)
  const op = keys[0]
  if (!EXPRESSION_OPERATORS.has(op)) throw unsupported(`expression operator ${op}`, { operator: op })
  const arg = (expression as Record<string, unknown>)[op]
  const list = (count?: number) => {
    if (!Array.isArray(arg) || (count !== undefined && arg.length !== count)) {
      throw invalidArgument(`${op} needs an array of ${count ?? 'expressions'}`)
    }
    return (arg as Expression[]).map(compileExpression)
  }

  switch (op) {
    case '$substr': {
      if (!Array.isArray(arg) || arg.length !== 3 || typeof arg[1] !== 'number' || typeof arg[2] !== 'number') {
        throw invalidArgument('$substr needs [expression, start, length]')
      }
      const text = compileExpression(arg[0] as Expression)
      const [, start, length] = arg as [unknown, number, number]
      return doc => {
        const value = text(doc)
        return typeof value === 'string' ? value.substr(start, length) : null
      }
    }
    case '$concat': {
      const parts = list()
      return doc => {
        const values = parts.map(part => part(doc))
        return values.every(value => typeof value === 'string') ? (values as string[]).join('') : null
      }
    }
    case '$add':
    case '$multiply': {
      const parts = list()
      const identity = op === '$add' ? 0 : 1
      return doc => {
        let result = identity
        for (const part of parts) {
          const value = part(doc)
          if (typeof value !== 'number') return null
          result = op === '$add' ? result + value : result * value
        }
        return result
      }
    }
    case '$subtract':
    case '$divide': {
      const [left, right] = list(2)
      return doc => {
        const a = left(doc)
        const b = right(doc)
        if (typeof a !== 'number' || typeof b !== 'number') return null
        if (op === '$subtract') return a - b
        return b === 0 ? null : a / b
      }
    }
    case '$abs': {
      const inner = compileExpression(arg as Expression)
      return doc => {
        const value = inner(doc)
        return typeof value === 'number' ? Math.abs(value) : null
      }
    }
    case '$ifNull': {
      const [value, fallback] = list(2)
      return doc => {
        const result = value(doc)
        return result === undefined || result === null ? fallback(doc) : result
      }
    }
    case '$cond': {
      if (!Array.isArray(arg) || arg.length !== 3) throw invalidArgument('$cond needs [filter, then, else]')
      const test = compileFilter(arg[0] as Filter)
      const then = compileExpression(arg[1] as Expression)
      const otherwise = compileExpression(arg[2] as Expression)
      return doc => (test(doc) ? then(doc) : otherwise(doc))
    }
    case '$year':
    case '$month': {
      const inner = compileExpression(arg as Expression)
      return doc => {
        const value = inner(doc)
        const match = typeof value === 'string' ? /^(\d{4})-(\d{2})/.exec(value) : null
        if (!match) return null
        return Number(op === '$year' ? match[1] : match[2])
      }
    }
  }
  throw unsupported(`expression operator ${op}`)
}

// ---------------------------------------------------------------------------
// Stages

type StageRunner = (docs: JsonObject[]) => Promise<JsonObject[]> | JsonObject[]

const STAGES = new Set(['$match', '$project', '$group', '$sort', '$skip', '$limit', '$unwind', '$lookup', '$count'])

export function compilePipeline(pipeline: Stage[], resolve: CollectionResolver): StageRunner[] {
  if (!Array.isArray(pipeline)) throw invalidArgument('A pipeline is an array of stages')
  return pipeline.map((stage, index) => {
    if (!isPlainObject(stage) || Object.keys(stage).length !== 1) {
      throw invalidArgument(`Stage ${index} must be an object with one key`)
    }
    const [name, spec] = Object.entries(stage)[0]
    if (!STAGES.has(name)) throw unsupported(`stage ${name}`, { stage: name })
    return compileStage(name, spec, resolve)
  })
}

export async function runPipeline(docs: JsonObject[], pipeline: Stage[], resolve: CollectionResolver): Promise<JsonObject[]> {
  let current = docs
  for (const stage of compilePipeline(pipeline, resolve)) current = await stage(current)
  return current
}

function compileStage(name: string, spec: unknown, resolve: CollectionResolver): StageRunner {
  switch (name) {
    case '$match': {
      const predicate: Predicate = compileFilter(spec as Filter)
      return docs => docs.filter(predicate)
    }
    case '$sort': {
      const compare = compileSort(spec as Sort, '')
      return docs => [...docs].sort(compare)
    }
    case '$skip':
    case '$limit': {
      if (typeof spec !== 'number' || !Number.isInteger(spec) || spec < 0) throw invalidArgument(`${name} needs a non-negative integer`)
      return docs => (name === '$skip' ? docs.slice(spec) : docs.slice(0, spec))
    }
    case '$count': {
      if (typeof spec !== 'string' || !spec) throw invalidArgument('$count needs a field name')
      return docs => [{ [spec]: docs.length }]
    }
    case '$unwind': {
      if (typeof spec !== 'string' || !spec.startsWith('$')) throw invalidArgument('$unwind needs a field reference like "$items"')
      const path = spec.slice(1)
      return docs => docs.flatMap(doc => {
        const items = getPath(doc, path)
        if (!Array.isArray(items)) return []
        return items.map(item => {
          const out = cloneJson(doc)
          setPath(out, path, item)
          return out
        })
      })
    }
    case '$project': return compileProject(spec)
    case '$group': return compileGroup(spec as GroupStage)
    case '$lookup': return compileLookup(spec, resolve)
  }
  throw unsupported(`stage ${name}`)
}

function compileProject(spec: unknown): StageRunner {
  if (!isPlainObject(spec) || Object.keys(spec).length === 0) throw invalidArgument('$project needs an object of fields')
  const computed: [string, Evaluator][] = []
  const included: string[] = []
  const excluded: string[] = []
  for (const [field, value] of Object.entries(spec)) {
    if (value === 1 || value === true) included.push(field)
    else if (value === 0 || value === false) excluded.push(field)
    else computed.push([field, compileExpression(value as Expression)])
  }
  // `id` (a document) and `_id` (a group) are kept by inclusion projections
  // unless excluded, and are the only fields that may be excluded alongside
  // inclusions, as in MongoDB.
  const identity = ['id', '_id']
  const otherExcluded = excluded.filter(field => !identity.includes(field))
  if (otherExcluded.length && (included.length || computed.length)) {
    throw invalidArgument('$project cannot mix exclusion with inclusion or computed fields')
  }

  if (!included.length && !computed.length) {
    return docs => docs.map(doc => {
      const out = cloneJson(doc)
      for (const field of excluded) delete out[field]
      return out
    })
  }
  const kept = identity.filter(field => !excluded.includes(field) && !included.includes(field))
  return docs => docs.map(doc => {
    const out: JsonObject = {}
    for (const field of kept) if (doc[field] !== undefined) out[field] = cloneJson(doc[field])
    for (const field of included) {
      const value = getPath(doc, field)
      if (value !== undefined) setPath(out, field, cloneJson(value))
    }
    for (const [field, evaluate] of computed) {
      const value = evaluate(doc)
      if (value !== undefined) setPath(out, field, value)
    }
    return out
  })
}

const ACCUMULATORS = new Set(['$sum', '$avg', '$min', '$max', '$count', '$first', '$last', '$push'])

interface Group { key: Json, docs: JsonObject[] }

function compileGroup(spec: GroupStage): StageRunner {
  if (!isPlainObject(spec) || !('_id' in spec)) throw invalidArgument('$group needs an _id (an expression or null)')
  const key: Evaluator = spec._id === null ? () => null : compileExpression(spec._id)

  const outputs: [string, (group: Group) => Json][] = []
  for (const [field, value] of Object.entries(spec)) {
    if (field === '_id') continue
    if (field.startsWith('$') || field.includes('.')) throw invalidArgument(`"${field}" is not a valid $group output name`)
    outputs.push([field, compileAccumulator(field, value)])
  }

  return docs => {
    const groups = new Map<string, Group>()
    for (const doc of docs) {
      const value = key(doc) ?? null
      const id = canonical(value)
      let group = groups.get(id)
      if (!group) groups.set(id, group = { key: value, docs: [] })
      group.docs.push(doc)
    }
    return [...groups.values()].map(group => {
      const out: JsonObject = { _id: group.key }
      for (const [field, accumulate] of outputs) out[field] = accumulate(group)
      return out
    })
  }
}

function compileAccumulator(field: string, spec: Accumulator | Expression | null): (group: Group) => Json {
  if (!isOperatorObject(spec) || !ACCUMULATORS.has(Object.keys(spec)[0]) || Object.keys(spec).length !== 1) {
    throw invalidArgument(`$group output "${field}" needs an accumulator such as { $sum: '$amount' }`)
  }
  const op = Object.keys(spec)[0]
  const arg = (spec as Record<string, unknown>)[op]
  if (op === '$count') {
    if (!isPlainObject(arg) || Object.keys(arg).length) throw invalidArgument('$count takes {}')
    return group => group.docs.length
  }
  const evaluate = compileExpression(arg as Expression)
  const values = (group: Group) => group.docs.map(evaluate)
  const numbers = (group: Group) => values(group).filter((v): v is number => typeof v === 'number')

  switch (op) {
    case '$sum': return group => numbers(group).reduce((sum, n) => sum + n, 0)
    case '$avg': return group => {
      const list = numbers(group)
      return list.length ? list.reduce((sum, n) => sum + n, 0) / list.length : null
    }
    case '$min':
    case '$max': return group => {
      const present = values(group).filter((v): v is Json => v !== undefined && v !== null)
      if (!present.length) return null
      return present.reduce((best, v) => (op === '$min' ? compareJson(v, best) < 0 : compareJson(v, best) > 0) ? v : best)
    }
    case '$first': return group => evaluate(group.docs[0]) ?? null
    case '$last': return group => evaluate(group.docs[group.docs.length - 1]) ?? null
    case '$push': return group => values(group).map(v => v ?? null)
  }
  throw unsupported(`accumulator ${op}`)
}

function compileLookup(spec: unknown, resolve: CollectionResolver): StageRunner {
  if (!isPlainObject(spec) || ['from', 'localField', 'foreignField', 'as'].some(key => typeof spec[key] !== 'string' || !spec[key])) {
    throw invalidArgument('$lookup needs { from, localField, foreignField, as } as strings')
  }
  const { from, localField, foreignField, as } = spec as { from: string, localField: string, foreignField: string, as: string }
  return async docs => {
    const foreign = await resolve(from)
    const byKey = new Map<string, JsonObject[]>()
    for (const doc of foreign) {
      const key = canonical(getPath(doc, foreignField) ?? null)
      const bucket = byKey.get(key)
      if (bucket) bucket.push(doc)
      else byKey.set(key, [doc])
    }
    return docs.map(doc => {
      const out = cloneJson(doc)
      const matches = byKey.get(canonical(getPath(doc, localField) ?? null)) ?? []
      setPath(out, as, matches.map(match => cloneJson(match)))
      return out
    })
  }
}

/** Exposed for backends that translate expressions themselves and need the list of operators. */
export const SUPPORTED = {
  stages: [...STAGES],
  expressions: [...EXPRESSION_OPERATORS],
  accumulators: [...ACCUMULATORS]
}
