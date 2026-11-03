// tessera-ui/mergeThemeOptions.ts — layers theme options: a theme over the shell's base, a scheme over a theme's common options.

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/** A plain data object: the only kind that is merged into rather than replaced. React elements are not. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false
  const proto = Object.getPrototypeOf(value)
  return (proto === Object.prototype || proto === null) && !('$$typeof' in value)
}

/**
 * Deep-merges `layers` left to right and returns a new object; the inputs are
 * not changed. Plain objects merge key by key; arrays, scalars, functions and
 * anything else replace what was there. Keys that could alter a prototype are
 * never copied, since a layer may have come from a theme plugin's JSON.
 */
export function mergeThemeOptions<T extends object>(...layers: (T | undefined)[]): T {
  return layers.reduce<Record<string, unknown>>((merged, layer) => mergeInto(merged, layer), {}) as T
}

function mergeInto(target: Record<string, unknown>, source: unknown): Record<string, unknown> {
  if (!isPlainObject(source)) return target
  for (const key of Object.keys(source)) {
    if (UNSAFE_KEYS.has(key)) continue
    const value = source[key]
    const current = target[key]
    target[key] = isPlainObject(value)
      ? mergeInto(isPlainObject(current) ? { ...current } : {}, value)
      : value
  }
  return target
}
