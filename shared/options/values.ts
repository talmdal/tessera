// shared/options/values.ts — the value semantics of the options store, as pure functions.
//
// In shared/ because both sides need them: the service merges, diffs and compares in the main process, and the
// options dialog tracks dirtiness with the same equality in the renderer.
//
// Only what differs from a plugin's defaults is stored, so a new default in a plugin update reaches every user
// who never changed that setting. Merging and diffing are exact inverses over objects:
// `diff(merge(defaults, overrides), defaults)` is `overrides` again, minus anything equal to a default.
//
// Objects merge key by key; arrays and scalars replace wholesale. See docs/options-framework-design.md.
import type { Json } from '@tessera/types'

export type JsonObject = { [key: string]: Json }

/** A JSON object, as opposed to an array, a scalar or null — the only shape that merges key by key. */
export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Structural equality over JSON. Object key order is not significant. */
export function equalValues(a: Json, b: Json): boolean {
  if (a === b) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((item, index) => equalValues(item, b[index]))
  }
  if (isJsonObject(a) && isJsonObject(b)) {
    const keys = Object.keys(a)
    return keys.length === Object.keys(b).length
      && keys.every(key => Object.prototype.hasOwnProperty.call(b, key) && equalValues(a[key], b[key]))
  }
  return false
}

/** A deep copy, so a caller can never mutate what the service holds (and vice versa). */
export function cloneValue<T extends Json>(value: T): T {
  if (Array.isArray(value)) return value.map(item => cloneValue(item)) as T
  if (isJsonObject(value)) {
    const copy: JsonObject = {}
    for (const [key, item] of Object.entries(value)) copy[key] = cloneValue(item)
    return copy as T
  }
  return value
}

/**
 * The complete value: `overrides` laid over `defaults`.
 *
 * Objects merge key by key, so a key added in a newer plugin version appears without any migration. Arrays and
 * scalars replace wholesale, which means a plugin update cannot append a default element to a list the user has
 * customised. A key the overrides hold but the defaults do not is kept, so a value written by a newer version of
 * a plugin survives being read by an older one.
 */
export function mergeValues(defaults: Json, overrides: Json): Json {
  if (!isJsonObject(defaults) || !isJsonObject(overrides)) return cloneValue(overrides)

  const merged: JsonObject = {}
  for (const [key, value] of Object.entries(defaults)) merged[key] = cloneValue(value)
  for (const [key, value] of Object.entries(overrides)) {
    merged[key] = Object.prototype.hasOwnProperty.call(defaults, key)
      ? mergeValues(defaults[key], value)
      : cloneValue(value)
  }
  return merged
}

/**
 * What to store: the part of `value` that differs from `defaults`, or `undefined` when nothing does.
 *
 * Only keys present in `value` are considered: a default key the value omits is not an instruction to remove it,
 * since merging would restore it anyway.
 */
export function diffValues(value: Json, defaults: Json): Json | undefined {
  if (equalValues(value, defaults)) return undefined
  if (!isJsonObject(value) || !isJsonObject(defaults)) return cloneValue(value)

  const differences: JsonObject = {}
  for (const [key, item] of Object.entries(value)) {
    if (!Object.prototype.hasOwnProperty.call(defaults, key)) {
      differences[key] = cloneValue(item)
      continue
    }
    const difference = diffValues(item, defaults[key])
    if (difference !== undefined) differences[key] = difference
  }
  return Object.keys(differences).length === 0 ? undefined : differences
}
