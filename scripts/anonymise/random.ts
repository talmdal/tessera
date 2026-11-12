// The anonymiser's randomness: one seeded generator per run, so a test can give the seed and get the same file every
// time, while a real run takes a fresh seed and nothing about the made-up values can be worked back.

export interface Random {
  /** A number in [0, 1). */
  next(): number
  /** An integer in [0, n). */
  below(n: number): number
  /** One of the characters of `from`. */
  pick(from: string): string
}

/** Mulberry32: small, fast and good enough for made-up names and numbers (not for secrets). */
export function seeded(seed: number): Random {
  let state = seed >>> 0
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const below = (n: number) => Math.floor(next() * n)
  return { next, below, pick: from => from[below(from.length)] }
}
