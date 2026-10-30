// core/storage/cursor.ts
//
// Page cursors: the sort-key values (ending with id) of the last item on a
// page, as URL-safe base64 of JSON. Opaque to callers; any backend that uses
// the shared sort order can decode another's cursor.
import type { Json, Sort } from '@tessera/types'
import { invalidArgument } from './errors'
import { compareJson, getPath } from './json'
import { sortFields } from './sort'

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

function encode(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const chunk = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    out += B64[chunk >> 18] + B64[(chunk >> 12) & 63]
    out += i + 1 < bytes.length ? B64[(chunk >> 6) & 63] : ''
    out += i + 2 < bytes.length ? B64[chunk & 63] : ''
  }
  return out
}

function decode(text: string): string {
  const bytes: number[] = []
  for (let i = 0; i < text.length; i += 4) {
    const digits = [...text.slice(i, i + 4)].map(c => B64.indexOf(c))
    if (digits.some(d => d < 0)) throw new Error('bad character')
    const chunk = (digits[0] << 18) | (digits[1] << 12) | ((digits[2] ?? 0) << 6) | (digits[3] ?? 0)
    bytes.push(chunk >> 16)
    if (digits.length > 2) bytes.push((chunk >> 8) & 255)
    if (digits.length > 3) bytes.push(chunk & 255)
  }
  return new TextDecoder().decode(new Uint8Array(bytes))
}

export function encodeCursor(doc: Json, sort: Sort | undefined): string {
  const keys = sortFields(sort).map(field => getPath(doc, field) ?? null)
  return encode(JSON.stringify(keys))
}

export function decodeCursor(cursor: string, sort: Sort | undefined): (Json | null)[] {
  let keys: unknown
  try {
    keys = JSON.parse(decode(cursor))
  } catch {
    throw invalidArgument('Malformed page cursor')
  }
  if (!Array.isArray(keys) || keys.length !== sortFields(sort).length) {
    throw invalidArgument('The page cursor does not match the sort')
  }
  return keys as (Json | null)[]
}

/** Compares a document's sort keys with a decoded cursor: negative if the document comes first. */
export function compareToCursor(doc: Json, keys: (Json | null)[], sort: Sort | undefined): number {
  const entries = Object.entries(sort ?? {})
  if (!entries.some(([field]) => field === 'id')) entries.push(['id', 1])
  for (let i = 0; i < entries.length; i++) {
    const [field, direction] = entries[i]
    const result = compareJson(getPath(doc, field) ?? null, keys[i])
    if (result !== 0) return result * direction
  }
  return 0
}
