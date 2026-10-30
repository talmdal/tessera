// core/storage/projection.ts
import type { Json, JsonObject, Projection } from '@tessera/types'
import { invalidArgument } from './errors'
import { cloneJson, deletePath, getPath, setPath } from './json'

export type Projector = (doc: JsonObject) => JsonObject

/**
 * Mongo's rules: all 1s (inclusion, id kept unless `id: 0`) or all 0s
 * (exclusion); mixing them is an error, except for `id`.
 */
export function compileProjection(projection: Projection | undefined): Projector {
  if (!projection || Object.keys(projection).length === 0) return doc => doc

  const entries = Object.entries(projection).filter(([field]) => field !== 'id')
  const included = entries.filter(([, v]) => v === 1).map(([f]) => f)
  const excluded = entries.filter(([, v]) => v === 0).map(([f]) => f)
  if (included.length && excluded.length) throw invalidArgument('A projection cannot mix inclusion and exclusion')
  const keepId = projection.id !== 0

  if (included.length) {
    const fields = keepId ? ['id', ...included] : included
    return doc => {
      const out: JsonObject = {}
      for (const field of fields) {
        const value = getPath(doc, field)
        if (value !== undefined) setPath(out, field, cloneJson(value as Json))
      }
      return out
    }
  }

  const dropped = keepId ? excluded : ['id', ...excluded]
  return doc => {
    const out = cloneJson(doc)
    for (const field of dropped) deletePath(out, field)
    return out
  }
}
