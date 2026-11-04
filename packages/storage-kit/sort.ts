import type { Json, JsonObject, Sort } from '@tessera/types'
import { StorageError } from './errors'
import { compare, getPath, setPath, stableStringify } from './json'

export type SortKey = [field: string, direction: 1 | -1][]

/** The sort with `id` ascending appended as the tie-break, so results and cursors are deterministic. */
export function sortKey(sort: Sort | undefined): SortKey {
  const key: SortKey = []
  for (const [field, direction] of Object.entries(sort ?? {})) {
    if (direction !== 1 && direction !== -1) {
      throw new StorageError('INVALID_ARGUMENT', `sort direction for "${field}" must be 1 or -1`)
    }
    key.push([field, direction])
  }
  if (!key.some(([field]) => field === 'id')) key.push(['id', 1])
  return key
}

export function compareBy(key: SortKey, a: JsonObject, b: JsonObject): number {
  for (const [field, direction] of key) {
    const result = compare(getPath(a, field), getPath(b, field))
    if (result !== 0) return result * direction
  }
  return 0
}

export const sortDocs = <T extends JsonObject>(docs: T[], sort: Sort | undefined): T[] => {
  const key = sortKey(sort)
  return docs.sort((a, b) => compareBy(key, a, b))
}

// Documents can't hold `$` keys, so this marker can't be mistaken for a value.
const MISSING = { $missing: 1 }

const toBase64Url = (text: string) => {
  let binary = ''
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const fromBase64Url = (text: string) => {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'))
  return new TextDecoder().decode(Uint8Array.from(binary, c => c.charCodeAt(0)))
}

/** A cursor holds the sort it was made with and the sort-key values of the last item of a page. */
export function encodeCursor(key: SortKey, last: JsonObject): string {
  const values = key.map(([field]) => getPath(last, field) ?? MISSING)
  return toBase64Url(JSON.stringify({ s: key, v: values }))
}

/** A stand-in document holding the cursor's key values, to compare candidates against. */
export function decodeCursor(cursor: string, key: SortKey): JsonObject {
  let parsed: { s: SortKey, v: Json[] }
  try {
    parsed = JSON.parse(fromBase64Url(cursor))
  } catch {
    throw new StorageError('INVALID_ARGUMENT', 'malformed cursor')
  }
  if (!Array.isArray(parsed?.s) || !Array.isArray(parsed?.v)) throw new StorageError('INVALID_ARGUMENT', 'malformed cursor')
  if (stableStringify(parsed.s as unknown as Json) !== stableStringify(key as unknown as Json)) {
    throw new StorageError('INVALID_ARGUMENT', 'cursor was made with a different sort')
  }
  const stand: JsonObject = {}
  key.forEach(([field], i) => {
    if (stableStringify(parsed.v[i]) !== stableStringify(MISSING)) setPath(stand, field, parsed.v[i])
  })
  return stand
}
