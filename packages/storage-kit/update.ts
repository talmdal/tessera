import type { Json, JsonObject, Update } from '@tessera/types'
import { StorageError } from './errors'
import { clone, equals, getPath, normalize, setPath, unsetPath } from './json'

const UPDATE_OPERATORS = ['$set', '$unset', '$inc', '$push', '$pull']
const invalid = (message: string) => new StorageError('INVALID_UPDATE', message)

const checkPath = (path: string) => {
  const top = path.split('.')[0]
  if (top === 'id' || top === 'rev') throw invalid(`"${top}" can't be changed by an update`)
  if (path.split('.').some(part => part === '' || part.startsWith('$'))) throw invalid(`bad field path "${path}"`)
}

/** Checks the shape of an update without a document, so a bad update fails even when nothing matches. */
export function validateUpdate(update: Update): void {
  if (typeof update !== 'object' || update === null || Array.isArray(update)) throw invalid('an update must be an object')
  const keys = Object.keys(update)
  if (keys.length === 0) throw invalid('an update needs at least one operator')
  for (const key of keys) {
    if (!UPDATE_OPERATORS.includes(key)) {
      throw invalid(key.startsWith('$')
        ? `unknown update operator ${key}`
        : `"${key}" is not an update operator; use $set to patch fields or replace() to replace the document`)
    }
    const spec = (update as Record<string, unknown>)[key]
    if (typeof spec !== 'object' || spec === null || Array.isArray(spec)) throw invalid(`${key} takes an object`)
    for (const path of Object.keys(spec)) checkPath(path)
  }
}

/** Applies an update to a copy of the document. `id` and `rev` are the caller's to handle. */
export function applyUpdate(doc: JsonObject, update: Update): JsonObject {
  const next = clone(doc)
  const fail = (path: string, why: string) => invalid(`${path}: ${why}`)

  for (const [path, value] of Object.entries(update.$set ?? {})) {
    if (!setPath(next, path, normalize(value, path))) throw fail(path, 'a parent of this path is not an object')
  }
  for (const path of Object.keys(update.$unset ?? {})) unsetPath(next, path)
  for (const [path, by] of Object.entries(update.$inc ?? {})) {
    if (typeof by !== 'number' || !Number.isFinite(by)) throw fail(path, '$inc takes a number')
    const current = getPath(next, path)
    if (current !== undefined && typeof current !== 'number') throw fail(path, '$inc on a field that is not a number')
    if (!setPath(next, path, (current ?? 0) + by)) throw fail(path, 'a parent of this path is not an object')
  }
  for (const [path, item] of Object.entries(update.$push ?? {})) {
    const current = getPath(next, path)
    if (current !== undefined && !Array.isArray(current)) throw fail(path, '$push on a field that is not an array')
    const list: Json[] = current === undefined ? [] : current as Json[]
    if (!setPath(next, path, [...list, normalize(item, path)])) throw fail(path, 'a parent of this path is not an object')
  }
  for (const [path, item] of Object.entries(update.$pull ?? {})) {
    const current = getPath(next, path)
    if (current === undefined) continue
    if (!Array.isArray(current)) throw fail(path, '$pull on a field that is not an array')
    setPath(next, path, current.filter(entry => !equals(entry, item as Json)))
  }
  return next
}
