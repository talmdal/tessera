// core/storage/ulid.ts
//
// ULIDs: 26 characters of Crockford base32, the first 10 the millisecond
// timestamp, the last 16 random. Lexical order is creation order, which is
// what makes them good document ids. Ids made in the same millisecond are
// made increasing by incrementing the random part, as the spec suggests.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

let lastTime = 0
let lastRandom: number[] = []

function randomBytes(count: number): number[] {
  const bytes = new Uint8Array(count)
  const crypto = (globalThis as { crypto?: { getRandomValues?: (array: Uint8Array) => Uint8Array } }).crypto
  if (crypto?.getRandomValues) {
    crypto.getRandomValues(bytes)
  } else {
    for (let i = 0; i < count; i++) bytes[i] = Math.floor(Math.random() * 256)
  }
  return [...bytes]
}

export function ulid(now: number = Date.now()): string {
  let time = ''
  let remaining = now
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[remaining % 32] + time
    remaining = Math.floor(remaining / 32)
  }

  if (now === lastTime) {
    // Increment the 80-bit random part, carrying from the low end.
    for (let i = lastRandom.length - 1; i >= 0; i--) {
      if (lastRandom[i] < 31) { lastRandom[i]++; break }
      lastRandom[i] = 0
    }
  } else {
    lastTime = now
    lastRandom = randomBytes(16).map(byte => byte % 32)
  }

  return time + lastRandom.map(digit => ALPHABET[digit]).join('')
}
