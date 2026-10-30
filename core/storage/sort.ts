// core/storage/sort.ts
import type { Json, Sort } from '@tessera/types'
import { invalidArgument } from './errors'
import { compareJson, getPath } from './json'

export type Comparator = (a: Json, b: Json) => number

/**
 * A comparator for a Sort spec, ending with `id` ascending unless the spec
 * names it, so the order is total and pagination cursors are unambiguous.
 */
export function compileSort(sort: Sort | undefined, tieBreak = 'id'): Comparator {
  const entries = Object.entries(sort ?? {})
  for (const [field, direction] of entries) {
    if (direction !== 1 && direction !== -1) throw invalidArgument(`Sort direction for ${field} must be 1 or -1`)
  }
  if (tieBreak && !entries.some(([field]) => field === tieBreak)) entries.push([tieBreak, 1])
  return (a, b) => {
    for (const [field, direction] of entries) {
      const result = compareJson(getPath(a, field), getPath(b, field))
      if (result !== 0) return result * direction
    }
    return 0
  }
}

export function sortFields(sort: Sort | undefined, tieBreak = 'id'): string[] {
  const fields = Object.keys(sort ?? {})
  if (tieBreak && !fields.includes(tieBreak)) fields.push(tieBreak)
  return fields
}
