// Anonymising a QIF file: Quicken's and Money's line format, in either dialect. Every line is a one-letter
// field code and its value, `^` ends a record, `!` lines switch what the records mean. The file is kept line
// for line — its control lines, its record boundaries, its line endings — and each field is routed by its code
// and the block it is in. What the two dialects actually differ in is learnt from the file itself: a field
// whose values never pass fifteen characters is written capped at fifteen, so a "strict" export stays strict.
import {
  Deriver, avoiding, dateShiftDays, fakeAmountMinor, fakeMemo, fakeNumbers, fakePayee, isGenericBankingText,
  sameShape, type Avoid
} from './derive'
import { amountMinor, formatLike, shiftCsvDate } from './csv'
import type { PolicyCounts } from './ofx'

export interface QifAnonymized {
  output: Uint8Array
  text: string
  counts: PolicyCounts
  unrecognised: { tag: string, count: number }[]
  sensitive: Set<string>
  sensitiveTags: Map<string, string>
  shape: QifShape
  dateShiftDays: number
}

/** What a QIF file is made of, for the structure check: its control lines in order, and each block's records. */
export interface QifShape {
  controls: string[]
  /** Per block, the field codes of each record, in order. */
  blocks: string[][][]
}

interface Line { code: string, value: string, ending: string, raw: string }

const TRANSACTION_BLOCKS = /^!Type:(Bank|Cash|CCard|Oth A|Oth L)$/i
const DROPPED_BLOCKS = /^!Type:(Invst|Memorized|Memorised|Prices|Budget|Security|Tag)$/i
const CLEARED = new Set(['*', 'c', 'X', 'R'])

/** The starter chart, so a real category maps onto one the book will have. Copied, not imported: the accounts
 * plugin's schema would drag the whole plugin in. */
const CATEGORIES: { name: string, children: string[] }[] = [
  { name: 'Salary', children: [] }, { name: 'Interest', children: [] }, { name: 'Dividends', children: [] },
  { name: 'Gifts received', children: [] }, { name: 'Other income', children: [] },
  { name: 'Housing', children: ['Rent', 'Mortgage interest', 'Property tax', 'Home insurance', 'Maintenance'] },
  { name: 'Utilities', children: ['Electricity', 'Heating', 'Water', 'Internet', 'Phone'] },
  { name: 'Food', children: ['Groceries', 'Dining out'] },
  { name: 'Transportation', children: ['Fuel', 'Public transit', 'Car insurance', 'Car maintenance', 'Parking'] },
  { name: 'Health', children: ['Medical', 'Dental', 'Pharmacy'] },
  { name: 'Personal', children: ['Clothing', 'Personal care'] },
  { name: 'Entertainment', children: [] }, { name: 'Gifts and donations', children: [] }, { name: 'Education', children: [] },
  { name: 'Childcare', children: [] }, { name: 'Travel', children: [] }, { name: 'Bank fees', children: [] },
  { name: 'Interest paid', children: [] }, { name: 'Taxes', children: [] }, { name: 'Miscellaneous', children: [] }
]
const WITH_CHILDREN = CATEGORIES.filter(c => c.children.length > 0)
const CLASSES = ['Home', 'Work', 'Rental', 'Trip', 'Project', 'Shared']
const ACCOUNT_NAMES = [
  'Chequing', 'Savings', 'Visa', 'Joint Chequing', 'Line of Credit', 'TFSA', 'Mastercard', 'RRSP', 'Cash',
  'US Dollar', 'Mortgage', 'Car Loan', 'Business Chequing', 'Holiday Fund', 'Emergency Fund', 'Petty Cash'
]

export function splitLines(text: string): Line[] {
  const lines: Line[] = []
  for (const match of text.matchAll(/([^\r\n]*)(\r\n|\n|\r|$)/g)) {
    if (match[1] === '' && match[2] === '') break
    const body = match[1]
    lines.push({ code: body.slice(0, 1), value: body.slice(1), ending: match[2], raw: body + match[2] })
  }
  return lines
}

/** The file's control lines and the field codes of every record, block by block. */
export function qifShape(text: string): QifShape {
  const controls: string[] = []
  const blocks: string[][][] = []
  let record: string[] = []
  let current: string[][] | undefined
  for (const line of splitLines(text)) {
    const body = line.code + line.value
    if (body.trim() === '') continue
    if (body.startsWith('!')) { controls.push(body.trim()); current = []; blocks.push(current); continue }
    if (current === undefined) { current = []; blocks.push(current); controls.push('') }
    if (body.trim() === '^') { current.push(record); record = []; continue }
    record.push(line.code)
  }
  if (record.length > 0) current?.push(record)
  return { controls, blocks }
}

/** `M/D'YY` and `M/D/YYYY`, with Quicken's space padding, else the shapes a CSV uses (ISO among them). */
export function shiftQifDate(value: string, days: number, slash: 'dmy' | 'mdy'): string {
  const apostrophe = /^(\s*)(\d{1,2})\/(\s?)(\d{1,2})'(\s?)(\d{1,4})(\s*)$/.exec(value)
  if (apostrophe !== null) {
    const [, lead, a, padDay, b, padYear, yearText, trail] = apostrophe
    const year = yearText.length <= 2 ? 2000 + Number(yearText) : Number(yearText)
    const [month, day] = slash === 'dmy' ? [Number(b), Number(a)] : [Number(a), Number(b)]
    const at = new Date(Date.UTC(year, month - 1, day))
    if (isNaN(at.getTime())) return value
    at.setUTCDate(at.getUTCDate() + days)
    const [first, second] = slash === 'dmy' ? [at.getUTCDate(), at.getUTCMonth() + 1] : [at.getUTCMonth() + 1, at.getUTCDate()]
    const yy = yearText.length <= 2 ? String(at.getUTCFullYear()).slice(-2).padStart(yearText.length, '0') : String(at.getUTCFullYear())
    const dayText = padDay === ' ' ? String(second).padStart(2, ' ') : String(second)
    return `${lead}${first}/${dayText}'${padYear}${yy}${trail}`
  }
  return shiftCsvDate(value, days, slash)
}

/** Stable, distinct fake account names: assigned in order of first use from a starting point the seed picks. */
class AccountNames {
  private readonly names = new Map<string, string>()
  private next: number
  constructor(derive: Deriver, private readonly avoid: Avoid) { this.next = derive.pick('accounts', '', ACCOUNT_NAMES.length) }
  for(original: string): string {
    const key = original.trim().toLowerCase()
    const found = this.names.get(key)
    if (found !== undefined) return found
    // The clean names first — unused, containing nothing from the file — from where the seed's offset points;
    // a numbered name only once those run out
    const used = new Set(this.names.values())
    const clean = ACCOUNT_NAMES.filter(name => !used.has(name) && ![...this.avoid].some(v => name.toLowerCase().includes(v)))
    let name: string
    if (clean.length > 0) {
      name = clean[this.next % clean.length]
    } else {
      const round = Math.floor(this.next / ACCOUNT_NAMES.length) + 2
      name = `${ACCOUNT_NAMES[this.next % ACCOUNT_NAMES.length]} ${round}`
    }
    this.next += 1
    this.names.set(key, name)
    return name
  }
}

/**
 * A category path onto the starter chart, keeping its depth and any `/Class`: `Auto:Fuel/Work` becomes
 * something like `Transportation:Parking/Trip`. The same path always maps the same way.
 */
export function fakeCategory(derive: Deriver, value: string, cap: number | undefined, avoid?: Avoid): string {
  const slash = value.indexOf('/')
  const path = slash === -1 ? value : value.slice(0, slash)
  const klass = slash === -1 ? undefined : value.slice(slash + 1)
  const segments = path.split(':')
  const salted = (text: string, salt: number) => salt === 0 ? text : `${text}#${salt}`
  const mapped = avoiding(salt => {
    const out: string[] = []
    if (segments.length === 1) {
      out.push(CATEGORIES[derive.pick('category', salted(path, salt), CATEGORIES.length)].name)
    } else {
      const parent = WITH_CHILDREN[derive.pick('category-parent', salted(segments[0], salt), WITH_CHILDREN.length)]
      out.push(parent.name, parent.children[derive.pick('category-child', salted(path, salt), parent.children.length)])
      for (let depth = 2; depth < segments.length; depth += 1) out.push('Other')
    }
    return (cap === undefined ? out : out.map(s => s.slice(0, cap))).join(':')
  }, avoid)
  const fakeClass = klass === undefined ? '' : `/${avoiding(salt => CLASSES[derive.pick('class', salted(klass, salt), CLASSES.length)], avoid)}`
  return `${mapped}${fakeClass}`
}

export function anonymizeQif(data: Uint8Array, options: { seed: Uint8Array, keepAmounts?: boolean }): QifAnonymized {
  const derive = new Deriver(options.seed)
  const shift = dateShiftDays(derive)
  let utf8 = true
  let text: string
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(data) } catch { utf8 = false; text = new TextDecoder('windows-1252').decode(data) }
  const lines = splitLines(text)

  const counts: PolicyCounts = { structural: 0, enum: 0, synthetic: 0, shifted: 0, drop: 0 }
  const unrecognised = new Map<string, number>()
  const sensitive = new Set<string>()
  const sensitiveTags = new Map<string, string>()
  const bump = (key: string) => unrecognised.set(key, (unrecognised.get(key) ?? 0) + 1)
  const remember = (value: string, tag: string) => {
    const v = value.trim()
    if (v.length < 4) return
    sensitive.add(v)
    if (!sensitiveTags.has(v)) sensitiveTags.set(v, tag)
  }

  // What the dialect is, field by field: a code whose values never pass fifteen characters is capped there
  const longest = new Map<string, number>()
  for (const line of lines) {
    if (!/^[PMLSE]$/.test(line.code)) continue
    const segments = line.code === 'L' || line.code === 'S' ? line.value.replace(/\/.*$/, '').split(':') : [line.value]
    for (const segment of segments) longest.set(line.code, Math.max(longest.get(line.code) ?? 0, segment.trim().length))
  }
  const capFor = (code: string) => (longest.get(code) ?? 0) <= 15 ? 15 : undefined
  const capped = (code: string, value: string) => { const cap = capFor(code); return cap === undefined ? value : value.slice(0, cap) }

  const slash = (() => {
    for (const line of lines) {
      if (line.code !== 'D') continue
      const m = /^(\d{1,2})\/\s?(\d{1,2})['/]/.exec(line.value.trim())
      if (m === null) continue
      if (Number(m[1]) > 12) return 'dmy' as const
      if (Number(m[2]) > 12) return 'mdy' as const
    }
    return 'mdy' as const
  })()

  // Everything the file says in words, so no fake can contain any of it
  const avoid: Set<string> = new Set()
  for (const line of lines) {
    if (!/^[PMLSEAND]$/.test(line.code) || line.code === 'D') continue
    for (const piece of line.value.replace(/^\[|\]$/g, '').split(/[:/]/)) {
      const v = piece.trim().toLowerCase()
      if (v.length >= 4 && !isGenericBankingText(v)) avoid.add(v)
    }
  }
  const numbers = fakeNumbers(derive, lines.filter(l => l.code === 'N').map(l => l.value.trim()))
  const accounts = new AccountNames(derive, avoid)
  const money = (value: string, tag: string): { text: string, minor: number } => {
    const minor = amountMinor(value)
    if (minor === undefined) { remember(value, tag); counts.drop += 1; return { text: '0.00', minor: 0 } }
    counts.shifted += 1
    const fake = options.keepAmounts === true ? minor : fakeAmountMinor(derive, minor)
    return { text: formatLike(value, fake), minor: fake }
  }
  const categoryOrTransfer = (value: string, code: string): string => {
    const trimmed = value.trim()
    if (/^\[.*\]$/.test(trimmed)) {
      counts.synthetic += 1; remember(trimmed.slice(1, -1), code)
      return `[${capped(code, accounts.for(trimmed.slice(1, -1)))}]`
    }
    counts.synthetic += 1
    // A segment that is just chart or banking words identifies nobody; anything else must not survive
    for (const segment of trimmed.replace(/\/.*$/, '').split(':')) if (!isGenericBankingText(segment)) remember(segment, code)
    const klass = trimmed.includes('/') ? trimmed.slice(trimmed.indexOf('/') + 1) : ''
    if (klass !== '' && !isGenericBankingText(klass)) remember(klass, code)
    return fakeCategory(derive, trimmed, capFor(code), avoid)
  }

  const out: string[] = []
  let block = ''
  let dropBlock = false
  let record: Line[] = []

  const emitRecord = () => {
    const written: Line[] = []
    if (TRANSACTION_BLOCKS.test(block) || block === '') {
      // Splits first, so the total can be rebuilt from them
      const splits = record.filter(l => l.code === '$')
      let splitSum = 0
      const fakeSplits = new Map<Line, string>()
      for (const line of splits) {
        const m = money(line.value, '$')
        splitSum += m.minor
        fakeSplits.set(line, m.text)
      }
      for (const line of record) {
        switch (line.code) {
          case 'D': counts.shifted += 1; written.push({ ...line, value: shiftQifDate(line.value, shift, slash) }); break
          case 'T': case 'U': {
            if (splits.length > 0) {
              counts.shifted += 1
              written.push({ ...line, value: formatLike(line.value, splitSum) })
            } else {
              written.push({ ...line, value: money(line.value, line.code).text })
            }
            break
          }
          case '$': written.push({ ...line, value: fakeSplits.get(line) ?? '0.00' }); break
          case 'N': {
            const v = line.value.trim()
            if (v === '') { written.push(line); counts.structural += 1; break }
            if (/^\d+$/.test(v)) { counts.synthetic += 1; remember(v, 'N'); written.push({ ...line, value: numbers.get(v) ?? v }); break }
            // `EFT`, `DEP`, `ATM`, `TXFR`: a code, kept; anything wordier is text and goes
            if (/^[A-Za-z]{1,6}$/.test(v) || isGenericBankingText(v)) { counts.enum += 1; written.push(line); break }
            counts.synthetic += 1; remember(v, 'N')
            // `EFT12345678`: the code stays, the reference changes; free text takes a same-shape replacement
            written.push({ ...line, value: /\d/.test(v) ? v.replace(/\d+/g, run => derive.digits('reference', `${v}:${run}`, run.length)) : sameShape(derive, 'number-text', v) })
            break
          }
          case 'P': {
            const v = line.value.trim()
            if (v === '' || /^opening balance$/i.test(v) || isGenericBankingText(v)) { counts.enum += 1; written.push(line); break }
            counts.synthetic += 1; remember(v, 'P')
            written.push({ ...line, value: capped('P', fakePayee(derive, v, avoid)) })
            break
          }
          case 'M': case 'E': {
            const v = line.value.trim()
            if (v === '' || isGenericBankingText(v)) { counts.enum += 1; written.push(line); break }
            counts.synthetic += 1; remember(v, line.code)
            written.push({ ...line, value: capped(line.code, fakeMemo(derive, v, avoid)) })
            break
          }
          case 'L': case 'S': written.push({ ...line, value: line.value.trim() === '' ? line.value : categoryOrTransfer(line.value, line.code) }); break
          case 'C': {
            if (CLEARED.has(line.value.trim())) { counts.enum += 1; written.push(line) }
            else { counts.enum += 1; bump('C=…'); remember(line.value, 'C'); written.push({ ...line, value: '*' }) }
            break
          }
          case 'F': counts.structural += 1; written.push(line); break
          case 'A': counts.drop += 1; remember(line.value, 'A'); break
          case '^': counts.structural += 1; written.push(line); break
          default: bump(`${line.code} in ${block || 'transactions'}`); remember(line.value, line.code)
        }
      }
    } else if (/^!Account$/i.test(block)) {
      for (const line of record) {
        switch (line.code) {
          case 'N': counts.synthetic += 1; remember(line.value, 'Account N'); written.push({ ...line, value: accounts.for(line.value) }); break
          case 'T': counts.enum += 1; written.push({ ...line, value: /^(Bank|Cash|CCard|Oth A|Oth L|Invst|Port|401\(k\)\/403\(b\))$/i.test(line.value.trim()) ? line.value : 'Bank' }); break
          case 'D': counts.synthetic += 1; remember(line.value, 'Account D'); written.push({ ...line, value: 'Example account' }); break
          case 'L': case '$': case 'B': written.push({ ...line, value: money(line.value, `Account ${line.code}`).text }); break
          case '/': counts.shifted += 1; written.push({ ...line, value: shiftQifDate(line.value, shift, slash) }); break
          case '^': counts.structural += 1; written.push(line); break
          default: bump(`${line.code} in !Account`); remember(line.value, line.code)
        }
      }
    } else if (/^!Type:Cat$/i.test(block)) {
      for (const line of record) {
        switch (line.code) {
          case 'N': {
            counts.synthetic += 1
            for (const segment of line.value.trim().split(':')) if (!isGenericBankingText(segment)) remember(segment, 'Cat N')
            written.push({ ...line, value: fakeCategory(derive, line.value.trim(), capFor('L'), avoid) })
            break
          }
          case 'D': counts.drop += 1; remember(line.value, 'Cat D'); break
          case 'T': case 'I': case 'E': case 'R': counts.enum += 1; written.push(line); break
          case 'B': written.push({ ...line, value: money(line.value, 'Cat B').text }); break
          case '^': counts.structural += 1; written.push(line); break
          default: bump(`${line.code} in !Type:Cat`); remember(line.value, line.code)
        }
      }
    } else if (/^!Type:Class$/i.test(block)) {
      for (const line of record) {
        switch (line.code) {
          case 'N': counts.synthetic += 1; remember(line.value, 'Class N'); written.push({ ...line, value: avoiding(salt => CLASSES[derive.pick('class', `${line.value.trim()}${salt === 0 ? '' : `#${salt}`}`, CLASSES.length)], avoid) }); break
          case 'D': counts.drop += 1; remember(line.value, 'Class D'); break
          case '^': counts.structural += 1; written.push(line); break
          default: bump(`${line.code} in !Type:Class`); remember(line.value, line.code)
        }
      }
    }
    for (const line of written) out.push(line.code === '^' ? line.raw : `${line.code}${line.value}${line.ending}`)
    record = []
  }

  for (const line of lines) {
    const body = line.code + line.value
    if (body.startsWith('!')) {
      block = body.trim()
      counts.structural += 1
      if (DROPPED_BLOCKS.test(block)) { dropBlock = true; bump(block); continue }
      const known = TRANSACTION_BLOCKS.test(block) || /^!(Account|Type:Cat|Type:Class|Option:AutoSwitch|Clear:AutoSwitch)$/i.test(block)
      if (!known) { dropBlock = true; bump(block); continue }
      dropBlock = false
      out.push(line.raw)
      continue
    }
    if (dropBlock) { if (body.trim() !== '' && body.trim() !== '^') remember(line.value, `${block} ${line.code}`); if (body.trim() === '^') counts.drop += 1; continue }
    if (body.trim() === '') { out.push(line.raw); continue }
    record.push(line)
    if (body.trim() === '^') emitRecord()
  }
  if (record.length > 0) emitRecord()

  const rendered = out.join('')
  return {
    output: utf8 ? new TextEncoder().encode(rendered) : encodeCp1252(rendered),
    text: rendered,
    counts,
    unrecognised: [...unrecognised.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag)),
    sensitive,
    sensitiveTags,
    shape: qifShape(rendered),
    dateShiftDays: shift
  }
}

function encodeCp1252(text: string): Uint8Array {
  const decoder = new TextDecoder('windows-1252')
  const table = new Map<string, number>()
  for (let byte = 0; byte < 256; byte += 1) {
    const char = decoder.decode(new Uint8Array([byte]))
    if (!table.has(char)) table.set(char, byte)
  }
  const out = new Uint8Array(text.length)
  let at = 0
  for (const char of text) out[at++] = table.get(char) ?? 0x3f
  return out.subarray(0, at)
}

/** The field codes a block may lose: the policy's drops for that block, and whatever was unrecognised. */
export function droppedCodesFor(control: string, unrecognised: readonly { tag: string }[]): Set<string> {
  const codes = new Set<string>()
  if (TRANSACTION_BLOCKS.test(control) || control === '') codes.add('A')
  if (/^!Type:(Cat|Class)$/i.test(control)) codes.add('D')
  for (const { tag } of unrecognised) {
    const m = /^(.) in (.+)$/.exec(tag)
    if (m !== null && (m[2] === control || (m[2] === 'transactions' && (TRANSACTION_BLOCKS.test(control) || control === '')))) codes.add(m[1])
  }
  return codes
}

const KEPT_CONTROL = (c: string) => c === '' || TRANSACTION_BLOCKS.test(c) || /^!(Account|Type:Cat|Type:Class|Option:AutoSwitch|Clear:AutoSwitch)$/i.test(c)

/** Whether `after` has `before`'s structure once the codes the policy drops are set aside, block by block. */
export function sameQifStructure(before: QifShape, after: QifShape, unrecognised: readonly { tag: string }[]): string[] {
  const problems: string[] = []
  const kept = before.controls.map((c, i) => ({ c, i })).filter(({ c }) => KEPT_CONTROL(c))
  if (kept.map(k => k.c).join('|') !== after.controls.join('|')) problems.push('the control lines differ')
  if (kept.length !== after.blocks.length) { problems.push(`${after.blocks.length} blocks; the input had ${kept.length}`); return problems }
  for (const [b, { c, i }] of kept.entries()) {
    const block = before.blocks[i]
    const dropped = droppedCodesFor(c, unrecognised)
    if (block.length !== after.blocks[b].length) { problems.push(`block ${b + 1} has ${after.blocks[b].length} records; the input had ${block.length}`); continue }
    for (const [r, codes] of block.entries()) {
      const expected = codes.filter(code => !dropped.has(code)).join('')
      if (expected !== after.blocks[b][r].join('')) { problems.push(`record ${r + 1} of block ${b + 1} has different fields`); break }
    }
  }
  return problems
}
