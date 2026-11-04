const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

let lastTime = -1
let lastRandom: number[] = []

function randomDigits(): number[] {
  const bytes = new Uint8Array(16)
  globalThis.crypto.getRandomValues(bytes)
  return Array.from(bytes, b => b % 32)
}

/** A ULID: 48 bits of millisecond time then 80 bits of randomness, increasing within one process. */
export function ulid(now = Date.now()): string {
  let time = now
  if (now <= lastTime) {
    // Same millisecond (or a clock step back): count up so ids stay increasing.
    time = lastTime
    for (let i = lastRandom.length - 1; i >= 0; i--) {
      if (lastRandom[i] < 31) { lastRandom[i]++; break }
      lastRandom[i] = 0
    }
  } else {
    lastTime = now
    lastRandom = randomDigits()
  }

  let head = ''
  for (let t = time, i = 0; i < 10; i++, t = Math.floor(t / 32)) head = ALPHABET[t % 32] + head
  return head + lastRandom.slice(0, 16).map(d => ALPHABET[d]).join('')
}
