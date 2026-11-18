// Every synthetic value the anonymiser writes comes from here: HMAC-SHA256 over a secret seed and the field's
// kind and original value, mapped into the shape the field needs. Stable within a run and across runs with
// the same seed — so one payee is one fake payee everywhere, and next month's file agrees — and not reversible
// without the seed, which is never written anywhere.
import { createHmac } from 'node:crypto'

export class Deriver {
  constructor(private readonly seed: Uint8Array) {}

  /** 32 bytes for this field kind and value. */
  bytes(kind: string, value: string): Buffer {
    return createHmac('sha256', this.seed).update(`${kind}:${value}`).digest()
  }

  /** A non-negative integer below `below`, from the first bytes of the digest. */
  pick(kind: string, value: string, below: number): number {
    const digest = this.bytes(kind, value)
    return Number(digest.readBigUInt64BE(0) % BigInt(Math.max(1, below)))
  }

  /** A stream of digits, as many as asked, from successive digest bytes. */
  digits(kind: string, value: string, count: number): string {
    let out = ''
    let round = 0
    while (out.length < count) {
      for (const byte of this.bytes(kind, `${value}#${round}`)) {
        out += String(byte % 10)
        if (out.length >= count) break
      }
      round += 1
    }
    return out
  }
}

// ---- Shapes ------------------------------------------------------------------------------------

const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const LOWER = 'abcdefghijklmnopqrstuvwxyz'

/** Whether a run of digits passes the Luhn check, as card numbers do. */
export function luhnValid(digits: string): boolean {
  if (!/^\d+$/.test(digits) || digits.length < 2) return false
  let sum = 0
  let double = false
  for (let at = digits.length - 1; at >= 0; at -= 1) {
    let digit = Number(digits[at])
    if (double) { digit *= 2; if (digit > 9) digit -= 9 }
    sum += digit
    double = !double
  }
  return sum % 10 === 0
}

/**
 * Every 13–19 digit window of a long run made to fail the Luhn check, so nothing written can be a card number
 * — and the verification pass, which flags Luhn-valid runs, stays meaningful. Fixing one window can make a
 * neighbour valid, so it goes round until none is; a handful of passes at most.
 */
export function failLuhn(text: string): string {
  return text.replace(/\d{13,}/g, run => {
    let fixed = run
    for (let pass = 0; pass < 20; pass += 1) {
      let changed = false
      for (let start = 0; start + 13 <= fixed.length; start += 1) {
        for (let length = 13; length <= 19 && start + length <= fixed.length; length += 1) {
          if (!luhnValid(fixed.slice(start, start + length))) continue
          const at = start + length - 1
          fixed = `${fixed.slice(0, at)}${(Number(fixed[at]) + 1) % 10}${fixed.slice(at + 1)}`
          changed = true
        }
      }
      if (!changed) return fixed
    }
    return fixed
  })
}

/**
 * The same character classes in the same places: a digit for a digit, a capital for a capital, a lower-case
 * letter for a lower-case one, everything else (dashes, spaces, dots) kept. The length is the original's, and
 * no digit run in it is a valid card number.
 */
export function sameShape(derive: Deriver, kind: string, value: string): string {
  let pool = derive.bytes(kind, value)
  let at = 0
  const next = () => {
    if (at >= pool.length) pool = Buffer.concat([pool, derive.bytes(kind, `${value}#${at}`)])
    return pool[at++]
  }
  let out = ''
  for (const char of value) {
    if (/\d/.test(char)) out += String(next() % 10)
    else if (UPPER.includes(char)) out += UPPER[next() % 26]
    else if (LOWER.includes(char)) out += LOWER[next() % 26]
    else out += char
  }
  return failLuhn(out)
}

/** A nine-digit routing number from an obviously fictional range: `9999` and five derived digits. */
export function fakeRoutingNumber(derive: Deriver, value: string): string {
  return `9999${derive.digits('routing', value, 5)}`
}

// ---- Dates -------------------------------------------------------------------------------------

/** Whole weeks back, between one and fifty-two, so every date keeps its weekday and every interval its length. */
export function dateShiftDays(derive: Deriver): number {
  return -7 * (1 + derive.pick('dateShift', '', 52))
}

/** An OFX timestamp with its calendar date shifted and the rest — time, fraction, zone — left as written. */
export function shiftOfxDate(raw: string, days: number): string {
  const match = /^(\s*)(\d{4})(\d{2})(\d{2})(.*)$/s.exec(raw)
  if (match === null) return raw
  const [, lead, y, m, d, rest] = match
  const at = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)))
  if (isNaN(at.getTime())) return raw
  at.setUTCDate(at.getUTCDate() + days)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${lead}${at.getUTCFullYear()}${pad(at.getUTCMonth() + 1)}${pad(at.getUTCDate())}${rest}`
}

// ---- Amounts -----------------------------------------------------------------------------------

/** The magnitude buckets, in minor units: under 10, under 100, under 1,000, under 10,000, and the rest. */
const BUCKETS = [1_000, 10_000, 100_000, 1_000_000, 10_000_000]

/**
 * A stable synthetic amount in the same magnitude bucket as the original, sign preserved, cents derived — so a
 * $4.50 coffee stays a small purchase and a repeated charge stays repeated, while the real figure is gone.
 */
export function fakeAmountMinor(derive: Deriver, minor: number): number {
  if (minor === 0) return 0
  const magnitude = Math.abs(minor)
  let lower = 1
  let upper = BUCKETS[BUCKETS.length - 1]
  for (const bound of BUCKETS) {
    if (magnitude < bound) { upper = bound; break }
    lower = bound
  }
  const picked = lower + derive.pick('amount', String(minor), upper - lower)
  return minor < 0 ? -picked : picked
}

/** Minor units as OFX writes them: a sign, the whole part, a point, the minor digits. */
export function formatAmount(minor: number, digits = 2): string {
  const sign = minor < 0 ? '-' : ''
  const magnitude = Math.abs(minor)
  const scale = 10 ** digits
  const whole = Math.floor(magnitude / scale)
  const fraction = String(magnitude % scale).padStart(digits, '0')
  return digits === 0 ? `${sign}${whole}` : `${sign}${whole}.${fraction}`
}

// ---- Payees and memos --------------------------------------------------------------------------

const PLACES = [
  'Maple', 'Harbour', 'Cedar', 'Northgate', 'Riverside', 'Bluebird', 'Summit', 'Lakeview', 'Prairie', 'Granite',
  'Copper', 'Willow', 'Juniper', 'Beacon', 'Meadow', 'Orchard', 'Pioneer', 'Sterling', 'Aurora', 'Birch',
  'Elm Street', 'Westwind', 'Fairview', 'Highland', 'Bayside', 'Glenwood', 'Ironwood', 'Kingsway', 'Oakridge', 'Parkdale'
]
const TRADES = [
  'Grocer', 'Bakery', 'Pharmacy', 'Hardware', 'Market', 'Cafe', 'Bistro', 'Garage', 'Books', 'Cycles',
  'Dental', 'Optical', 'Cleaners', 'Florist', 'Fuel', 'Diner', 'Fitness', 'Pet Supply', 'Toys', 'Music',
  'Deli', 'Butcher', 'Cinema', 'Plumbing', 'Electric', 'Vet Clinic', 'Dairy', 'Sports', 'Nursery', 'Taxi'
]
const SHORT = [
  'Zephyr', 'Lumen', 'Orbit', 'Nimbus', 'Quill', 'Ember', 'Halo', 'Pebble', 'Tidal', 'Vista',
  'Acorn', 'Brisk', 'Cobalt', 'Dune', 'Fable', 'Gust', 'Hearth', 'Ivory', 'Jade', 'Kite'
]
const SUFFIXES = ['', ' Ltd']

/** Roughly 400 plausible merchant names, by length class, built once. */
function corpus(): { short: string[], medium: string[], long: string[] } {
  const short = [...SHORT, ...TRADES.filter(t => t.length <= 8)]
  const medium: string[] = []
  const long: string[] = []
  for (const place of PLACES) {
    for (const trade of TRADES) {
      for (const suffix of SUFFIXES) {
        const name = `${place} ${trade}${suffix}`
        if (name.length <= 16) medium.push(name)
        else long.push(name)
      }
    }
  }
  return { short, medium: [...new Set(medium)], long: [...new Set(long)] }
}
const NAMES = corpus()

/**
 * A stable fake payee with the original's *shape*: a `SQ *`-style processor prefix stays, a trailing store or
 * reference number stays a number of the same width (never a valid card number), ALL CAPS stays ALL CAPS, and
 * the length class is matched. Those quirks are what the payee rules and the matcher are tested against; the
 * name itself is what must go.
 */
/**
 * The input's own text, lower-cased, so no fake can contain it. A real payee that happens to be a word in the
 * corpus — a merchant called “Jade”, an account called “RRSP” — would otherwise come out as itself.
 */
export type Avoid = ReadonlySet<string>

const collides = (fake: string, avoid: Avoid | undefined) => {
  if (avoid === undefined) return false
  const lower = fake.toLowerCase()
  for (const value of avoid) if (lower.includes(value)) return true
  return false
}

/** `choose(salt)` until the result contains nothing from `avoid`; the first choice when nothing collides. */
export function avoiding(choose: (salt: number) => string, avoid: Avoid | undefined): string {
  let fake = choose(0)
  for (let salt = 1; salt < 40 && collides(fake, avoid); salt += 1) fake = choose(salt)
  return fake
}

export function fakePayee(derive: Deriver, original: string, avoid?: Avoid): string {
  const trimmed = original.trim()
  if (trimmed === '') return original
  const prefix = /^([A-Z]{2,7}\s?\*\s?|PAYPAL\s\*|AMZN\s(?:Mktp\s)?|TST\*\s?)/i.exec(trimmed)?.[1] ?? ''
  let core = trimmed.slice(prefix.length)
  const trailing = /(\s*#?\d{2,}[A-Z]?\s*)$/.exec(core)?.[1] ?? ''
  core = core.slice(0, core.length - trailing.length).trim()

  const allCaps = core !== '' && core === core.toUpperCase() && /[A-Z]/.test(core)
  const list = core.length <= 8 ? NAMES.short : core.length <= 16 ? NAMES.medium : NAMES.long
  let name = avoiding(salt => list[derive.pick('payee', `${trimmed}${salt === 0 ? '' : `#${salt}`}`, list.length)], avoid)
  if (allCaps) name = name.toUpperCase()

  const tail = trailing.replace(/\d+/g, run => failLuhn(derive.digits('payee-number', `${trimmed}:${run}`, run.length)))
  return `${prefix}${name}${tail}`
}

/**
 * Words banks print in a payee or memo that describe the transaction, not the person: a bare `WITHDRAWAL`, a
 * `BILL PAYMENT`, an `INTERAC E-TRANSFER`. A value made only of these identifies nobody and is kept as written,
 * because a reader will meet exactly these and should be tested against them.
 */
const GENERIC_WORDS = new Set((
  'withdrawal withdrawl deposit payment payments bill bills transfer transfers e-transfer etransfer interac purchase ' +
  'purchases fee fees service charge charges interest cheque check cheques checks atm abm pos debit credit card online ' +
  'banking mobile monthly plan overdraft nsf refund reversal adjustment correction cash pre-authorized preauthorized ' +
  'pre-authorised pad pap direct dep misc memo received sent from to the of and in out auto loan mortgage insurance ' +
  'premium balance opening closing statement account savings chequing checking rebate reward rewards cashback points ' +
  'tax gst hst pst visa mastercard amex paypal payroll salary pay cr dr wd dp txn transaction pmt pymt ins int svc chg ' +
  'funds fund branch teller cheq chq eft ach wire incoming outgoing recurring internet telephone phone bank ' +
  'retail sale sales return returned item items merchant customer foreign exchange fx currency conversion ' +
  // The starter chart's own words: a category named for what the money was for identifies nobody
  'salary dividends gifts received other income housing rent mortgage property home maintenance utilities ' +
  'electricity heating water internet groceries dining transportation public transit parking health medical ' +
  'dental pharmacy personal clothing care entertainment donations education childcare travel paid taxes ' +
  'miscellaneous expenses expense bills clothes gas hydro auto vehicle household kids children pets gift charity ' +
  'vacation holiday subscriptions subscription memberships membership ' +
  // Account and product words, which the fake account names reuse
  'rrsp tfsa resp rrif rif gic chequing savings line credit loan joint mastercard usd cad fund emergency petty'
).split(/\s+/))

/** Whether a value is only generic banking words (and punctuation), so it may be kept as written. */
export function isGenericBankingText(value: string): boolean {
  // A digit means a reference, an account or a store number: never generic, whatever the words around it
  if (/\d/.test(value)) return false
  const words = value.toLowerCase().split(/[^a-z-]+/).filter(w => w !== '' && w !== '-')
  return words.length > 0 && words.every(word => GENERIC_WORDS.has(word))
}

const MEMOS = [
  'Purchase', 'Point of sale purchase', 'Online payment', 'Monthly fee', 'E-transfer', 'Bill payment',
  'Card purchase', 'Pre-authorized debit', 'Interac purchase', 'Recurring payment', 'Transfer', 'Refund',
  'Service charge', 'Interest', 'Deposit', 'Withdrawal', 'Payment received', 'Subscription'
]

/** A memo from a small corpus, stable for the same original. */
export function fakeMemo(derive: Deriver, original: string, avoid?: Avoid): string {
  return avoiding(salt => MEMOS[derive.pick('memo', `${original.trim()}${salt === 0 ? '' : `#${salt}`}`, MEMOS.length)], avoid)
}

/**
 * Cheque numbers: different numbers of the same width, with the file's order preserved, so a test of the
 * register's "next number" still means something. The whole set is mapped at once.
 */
export function fakeNumbers(derive: Deriver, originals: readonly string[]): Map<string, string> {
  const numeric = [...new Set(originals.filter(n => /^\d+$/.test(n.trim())).map(n => n.trim()))]
    .sort((a, b) => Number(a) - Number(b))
  const mapping = new Map<string, string>()
  let next = 100 + derive.pick('cheque-base', numeric.join(','), 900)
  for (const original of numeric) {
    next += 1 + derive.pick('cheque-step', original, 3)
    mapping.set(original, String(next).padStart(original.length, '0').slice(-Math.max(original.length, String(next).length)))
  }
  for (const original of originals) {
    if (!mapping.has(original.trim())) mapping.set(original.trim(), sameShape(derive, 'reference', original.trim()))
  }
  return mapping
}
