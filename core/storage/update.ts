// core/storage/update.ts
//
// Applies an Update (operators only) to a document, returning a new one.
import type { Json, JsonObject, Update } from '@tessera/types'
import { invalidUpdate } from './errors'
import { cloneJson, deepEqual, getPath, isPlainObject, setPath, deletePath, toJson } from './json'

const OPERATORS = new Set(['$set', '$unset', '$inc', '$push', '$pull'])
const PROTECTED = new Set(['id', 'rev'])

export function validateUpdate(update: Update): void {
  if (!isPlainObject(update)) throw invalidUpdate('an update must be an object of operators')
  const keys = Object.keys(update)
  if (keys.length === 0) throw invalidUpdate('an update needs at least one operator')
  for (const key of keys) {
    if (!key.startsWith('$')) throw invalidUpdate(`"${key}" is not an operator; use $set to assign fields or replace() for a whole document`)
    if (!OPERATORS.has(key)) throw invalidUpdate(`unknown operator ${key}`)
    const fields = (update as Record<string, unknown>)[key]
    if (!isPlainObject(fields)) throw invalidUpdate(`${key} needs an object of fields`)
    for (const field of Object.keys(fields)) {
      const head = field.split('.')[0]
      if (PROTECTED.has(head)) throw invalidUpdate(`${field} is maintained by the engine and cannot be changed`)
      if (field === '' || field.startsWith('$')) throw invalidUpdate(`"${field}" is not a valid field path`)
    }
  }
}

/** A new document with the update applied; `changed` is false if nothing differs. */
export function applyUpdate(doc: JsonObject, update: Update): { doc: JsonObject, changed: boolean } {
  validateUpdate(update)
  const next = cloneJson(doc)

  for (const [field, value] of Object.entries(update.$set ?? {})) setPath(next, field, toJson(value, field))
  for (const field of Object.keys(update.$unset ?? {})) deletePath(next, field)
  for (const [field, amount] of Object.entries(update.$inc ?? {})) {
    if (typeof amount !== 'number' || !Number.isFinite(amount)) throw invalidUpdate(`$inc ${field} needs a finite number`)
    const current = getPath(next, field) ?? 0
    if (typeof current !== 'number') throw invalidUpdate(`$inc ${field}: the field is not a number`)
    setPath(next, field, current + amount)
  }
  for (const [field, value] of Object.entries(update.$push ?? {})) {
    const current = getPath(next, field)
    if (current !== undefined && !Array.isArray(current)) throw invalidUpdate(`$push ${field}: the field is not an array`)
    setPath(next, field, [...(current ?? []), toJson(value, field)])
  }
  for (const [field, value] of Object.entries(update.$pull ?? {})) {
    const current = getPath(next, field)
    if (current === undefined) continue
    if (!Array.isArray(current)) throw invalidUpdate(`$pull ${field}: the field is not an array`)
    setPath(next, field, current.filter(item => !deepEqual(item, value as Json)))
  }

  return { doc: next, changed: !deepEqual(next, doc) }
}
