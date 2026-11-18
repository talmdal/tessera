// Anonymising one OFX, QFX or QBO file: the layout token stream, each token routed by the policy table, the
// balances recomputed from the synthetic rows, and the result encoded as the input was.
import { codecFor, looksLikeXml, normaliseXmlCodec, readSgmlHeader, readXmlHeader, startsWithBom } from '../../plugins/exchange.ofx/src/privileged/encoding'
import { escapeValue, tokenizeLayout, type LayoutToken } from '../../plugins/exchange.ofx/src/privileged/layout'
import { decodeEntities } from '../../plugins/exchange.ofx/src/privileged/tokenizer'
import { parseAmount } from '../../plugins/exchange.ofx/src/privileged/values'
import {
  Deriver, dateShiftDays, fakeAmountMinor, fakeMemo, fakeNumbers, fakePayee, fakeRoutingNumber, formatAmount,
  isGenericBankingText, sameShape, shiftOfxDate
} from './derive'
import { HEADER_POLICIES, KNOWN_ELEMENTS, LEAF_POLICIES, STATEMENT_ELEMENTS, matches, type Policy } from './policy'

export interface PolicyCounts { structural: number, enum: number, synthetic: number, shifted: number, drop: number }

export interface AnonymizeOptions {
  seed: Uint8Array
  /** Leave amounts and balances as they are. For debugging a parser only; the caller must say so loudly. */
  keepAmounts?: boolean
  /**
   * Tags to pass through untouched, whatever their policy. Exists so the tests can prove the verification
   * pass catches a leak; the command line never sets it.
   */
  unsafePassThrough?: ReadonlySet<string>
}

export interface Anonymized {
  output: Uint8Array
  /** The output as text, for the verification pass. */
  text: string
  counts: PolicyCounts
  /** Tags met with no policy, with how often — never a value. */
  unrecognised: { tag: string, count: number }[]
  /** Values that must not survive into the output: everything synthetic, dropped or unrecognised, 4+ chars. */
  sensitive: Set<string>
  /** Where each sensitive value came from, by tag, so a leak can be named without being shown. */
  sensitiveTags: Map<string, string>
  /** Tags that reached the output, with counts, for the structure check. */
  tags: Map<string, number>
  /** The input's tags, with counts. */
  inputTags: Map<string, number>
  /** Per statement, the synthetic opening balance the ledger was built from. Not recorded in any report. */
  openingBalances: number[]
  /** The constant every date moved by. Not recorded in any report. */
  dateShiftDays: number
}

const BOM = new Uint8Array([0xef, 0xbb, 0xbf])

/** The whole file as text, header included, and the codec to write it back with. */
function decodeWhole(data: Uint8Array): { text: string, codec: string, bom: boolean } {
  const bom = startsWithBom(data)
  const bytes = bom ? data.subarray(3) : data
  const probe = new TextDecoder('latin1').decode(bytes.subarray(0, 2048))
  const header = looksLikeXml(probe) ? readXmlHeader(probe) : readSgmlHeader(bytes)
  const codec = header.syntax === 'xml' ? normaliseXmlCodec(header.encoding) : codecFor(header.encoding, header.charset)
  let text: string
  try { text = new TextDecoder(codec).decode(bytes) } catch { text = new TextDecoder('windows-1252').decode(bytes) }
  return { text, codec, bom }
}

/** Text as bytes in the file's own codec. `TextEncoder` only writes UTF-8, so the single-byte pages are built. */
function encode(text: string, codec: string, bom: boolean): Uint8Array {
  if (codec === 'utf-8') {
    const body = new TextEncoder().encode(text)
    if (!bom) return body
    const out = new Uint8Array(body.length + 3)
    out.set(BOM, 0)
    out.set(body, 3)
    return out
  }
  const table = singleByteTable(codec)
  const out = new Uint8Array(text.length)
  let at = 0
  for (const char of text) {
    const byte = table.get(char)
    out[at++] = byte ?? 0x3f   // '?' for a character the page cannot hold
  }
  return out.subarray(0, at)
}

const tables = new Map<string, Map<string, number>>()
function singleByteTable(codec: string): Map<string, number> {
  const found = tables.get(codec)
  if (found !== undefined) return found
  const decoder = new TextDecoder(codec)
  const table = new Map<string, number>()
  for (let byte = 0; byte < 256; byte += 1) {
    const char = decoder.decode(new Uint8Array([byte]))
    if (!table.has(char)) table.set(char, byte)
  }
  tables.set(codec, table)
  return table
}

/** Minor digits for a currency: the few with none, else two. Enough for a fixture's amounts. */
const digitsFor = (currency: string | undefined) =>
  ['JPY', 'KRW', 'VND', 'CLP', 'ISK', 'HUF'].includes((currency ?? '').toUpperCase()) ? 0 : 2

export function anonymizeOfx(data: Uint8Array, options: AnonymizeOptions): Anonymized {
  const derive = new Deriver(options.seed)
  const { text: source, codec, bom } = decodeWhole(data)
  const tokens = tokenizeLayout(source)
  const shift = dateShiftDays(derive)
  const passThrough = options.unsafePassThrough ?? new Set<string>()

  const counts: PolicyCounts = { structural: 0, enum: 0, synthetic: 0, shifted: 0, drop: 0 }
  const unrecognised = new Map<string, number>()
  const sensitive = new Set<string>()
  const sensitiveTags = new Map<string, string>()
  let currentTag = '#document'
  const inputTags = new Map<string, number>()
  const outputTags = new Map<string, number>()
  const bump = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) ?? 0) + 1)
  const sensitiveValue = (raw: string, tag = currentTag) => {
    const decoded = decodeEntities(raw).trim()
    if (decoded.length < 4) return
    sensitive.add(decoded)
    if (!sensitiveTags.has(decoded)) sensitiveTags.set(decoded, tag)
  }

  // Everything the file says in words, so no fake can contain any of it
  const avoid = new Set<string>()
  for (const token of tokens) {
    if (token.kind !== 'value') continue
    const v = decodeEntities(token.raw).trim().toLowerCase()
    if (v.length >= 4 && /[a-z]/.test(v) && !isGenericBankingText(v)) avoid.add(v)
  }

  // Cheque numbers are mapped as a set, so their order survives
  const numbers = fakeNumbers(derive, tokens
    .filter((t): t is Extract<LayoutToken, { kind: 'value' }> => t.kind === 'value' && (t.tag === 'CHECKNUM' || t.tag === 'REFNUM'))
    .map(t => decodeEntities(t.raw).trim()))

  // Each statement's rows and balances, for the recomputation after the walk
  interface StatementFigures { currency?: string, sum: number, balanceTokens: { at: number, tag: string, original?: number }[] }
  const statements: StatementFigures[] = []
  let statement: StatementFigures | undefined

  const out: LayoutToken[] = []
  let at = 0

  /** Drops tokens from `from` (an open tag) to the end of its subtree, and the line ending after it. */
  const skipSubtree = (from: number, tag: string): number => {
    // Find the matching close first: an element that never closes is dropped as one tag, not as the rest of the file
    let depth = 0
    let end = -1
    for (let index = from; index < tokens.length; index += 1) {
      const token = tokens[index]
      if (token.kind === 'open' && !token.selfClosing) depth += 1
      if (token.kind === 'close') {
        depth -= 1
        if (token.tag === tag && depth <= 0) { end = index + 1; break }
      }
    }
    if (end === -1) return skipLineEnding(from + 1)
    for (let index = from; index < end; index += 1) {
      const token = tokens[index]
      if (token.kind === 'value') sensitiveValue(token.raw, token.tag)
    }
    return skipLineEnding(end)
  }

  /** Drops a leaf: its open tag, value, closing tag if any, and the line ending after it. */
  const skipLeaf = (from: number, tag: string): number => {
    let index = from + 1
    // The value, and any spacing on the same line; a space holding the line ending is the line-ending fix's
    while (index < tokens.length) {
      const token = tokens[index]
      if (token.kind === 'value') { sensitiveValue(token.raw, tag); index += 1; continue }
      if (token.kind === 'space' && !token.raw.includes('\n')) { index += 1; continue }
      break
    }
    if (tokens[index]?.kind === 'close' && (tokens[index] as { tag: string }).tag === tag) index += 1
    return skipLineEnding(index)
  }

  /**
   * After a drop: the dropped line's ending goes with it, and the next line keeps its own indentation. The
   * whitespace before the dropped tag holds the previous line's ending plus the dropped line's indentation,
   * so it is trimmed to the ending and given the indentation that followed the drop.
   */
  const skipLineEnding = (index: number): number => {
    const trailing = tokens[index]
    if (trailing?.kind !== 'space' || !trailing.raw.includes('\n')) return index
    const after = trailing.raw.slice(trailing.raw.lastIndexOf('\n') + 1)
    const last = out[out.length - 1]
    if (last?.kind === 'space') {
      const newline = last.raw.lastIndexOf('\n')
      const kept = (newline === -1 ? '' : last.raw.slice(0, newline + 1)) + after
      if (kept === '') out.pop()
      else out[out.length - 1] = { kind: 'space', raw: kept }
    } else if (after !== '') {
      out.push({ kind: 'space', raw: after })
    }
    return index + 1
  }

  const apply = (policy: Policy, tag: string, raw: string): string | undefined => {
    currentTag = tag
    const value = decodeEntities(raw).trim()
    switch (policy.kind) {
      case 'structural':
        counts.structural += 1
        return raw
      case 'enum':
        counts.enum += 1
        if (matches(policy.allowed, value)) return raw
        bump(unrecognised, `${tag}=…`)
        sensitiveValue(raw)
        return policy.fallback
      case 'fixed':
        counts.synthetic += 1
        sensitiveValue(raw)
        return policy.value
      case 'synthetic': {
        if ((policy.as === 'payee' || policy.as === 'memo') && isGenericBankingText(value)) {
          // 'WITHDRAWAL', 'BILL PAYMENT': the transaction, not the person; kept as written
          counts.enum += 1
          return raw
        }
        counts.synthetic += 1
        sensitiveValue(raw)
        switch (policy.as) {
          case 'id': return sameShape(derive, 'id', value)
          case 'account': return sameShape(derive, 'account', value)
          case 'routing': return fakeRoutingNumber(derive, value)
          case 'payee': return escapeValue(fakePayee(derive, value, avoid))
          case 'memo': return escapeValue(fakeMemo(derive, value, avoid))
          case 'number': return numbers.get(value) ?? sameShape(derive, 'reference', value)
        }
        return raw
      }
      case 'shifted':
        counts.shifted += 1
        if (policy.as === 'date') return shiftOfxDate(raw, shift)
        if (options.keepAmounts === true) return raw
        if (policy.as === 'amount') {
          const parsed = parseAmount(value, digitsFor(statement?.currency))
          if (!parsed.ok) { sensitiveValue(raw); return '0.00' }
          const fake = fakeAmountMinor(derive, parsed.minor)
          if (statement !== undefined) statement.sum += fake
          return formatAmount(fake, digitsFor(statement?.currency))
        }
        // A balance: a placeholder now, recomputed once the statement's rows are known
        return raw
      case 'drop':
        counts.drop += 1
        sensitiveValue(raw)
        return undefined
    }
  }

  while (at < tokens.length) {
    const token = tokens[at]

    if (token.kind === 'header') {
      const policy = HEADER_POLICIES[token.key]
      if (policy === undefined) {
        bump(unrecognised, token.key)
        sensitiveValue(token.value, token.key)
        at = skipLineEnding(at + 1)
        continue
      }
      const value = apply(policy, token.key, token.value)
      out.push(value === undefined ? token : { ...token, value, raw: `${token.key}:${value}` })
      at += 1
      continue
    }

    if (token.kind === 'stray') {
      // Text the grammar has no place for: not understood, so not kept
      bump(unrecognised, '#text')
      sensitiveValue(token.raw, '#text')
      at += 1
      continue
    }

    if (token.kind !== 'open') {
      if (token.kind === 'close' && STATEMENT_ELEMENTS.has(token.tag)) statement = undefined
      out.push(token)
      at += 1
      continue
    }

    bump(inputTags, token.tag)
    const nextValue = tokens.slice(at + 1).find(t => t.kind !== 'space')
    const isLeaf = nextValue?.kind === 'value' && nextValue.tag === token.tag

    if (!isLeaf) {
      if (!token.selfClosing && LEAF_POLICIES[token.tag] !== undefined) {
        // A known leaf with nothing in it (`<ACCTTYPE>` on a line of its own): says nothing, kept as written
        counts.structural += 1
        bump(outputTags, token.tag)
        out.push(token)
        at += 1
        continue
      }
      if (token.selfClosing) {
        // An empty leaf says nothing; kept if the tag is known
        if (LEAF_POLICIES[token.tag] !== undefined) { out.push(token); bump(outputTags, token.tag); counts.structural += 1 }
        else bump(unrecognised, token.tag)
        at += 1
        continue
      }
      if (!KNOWN_ELEMENTS.has(token.tag)) {
        bump(unrecognised, token.tag)
        at = skipSubtree(at, token.tag)
        continue
      }
      if (STATEMENT_ELEMENTS.has(token.tag)) {
        statement = { sum: 0, balanceTokens: [] }
        statements.push(statement)
      }
      counts.structural += 1
      bump(outputTags, token.tag)
      out.push(token)
      at += 1
      continue
    }

    // A leaf
    const policy = LEAF_POLICIES[token.tag]
    const valueToken = nextValue as Extract<LayoutToken, { kind: 'value' }>
    if (policy === undefined) {
      bump(unrecognised, token.tag)
      at = skipLeaf(at, token.tag)
      continue
    }
    if (token.tag === 'CURDEF' && statement !== undefined) statement.currency = decodeEntities(valueToken.raw).trim().toUpperCase()

    // A pass-through still registers its value as sensitive: that is how the verification catches the leak
    if (passThrough.has(token.tag)) sensitiveValue(valueToken.raw, token.tag)
    const replaced = passThrough.has(token.tag) ? (counts.structural += 1, valueToken.raw) : apply(policy, token.tag, valueToken.raw)
    if (replaced === undefined) {
      at = skipLeaf(at, token.tag)
      continue
    }
    bump(outputTags, token.tag)
    out.push(token)
    at += 1
    // The spaces between the open tag and its value, then the value itself
    while (tokens[at].kind === 'space') { out.push(tokens[at]); at += 1 }
    const written: LayoutToken = { ...valueToken, raw: replaced }
    if (policy.kind === 'shifted' && policy.as === 'balance' && statement !== undefined) {
      const original = parseAmount(decodeEntities(valueToken.raw).trim(), digitsFor(statement.currency))
      statement.balanceTokens.push({ at: out.length, tag: valueToken.path[valueToken.path.length - 1] ?? 'BALAMT', ...(original.ok && { original: original.minor }) })
    }
    out.push(written)
    at += 1
  }

  // Balances: an opening figure derived from the real one's magnitude, plus the synthetic rows
  const openingBalances: number[] = []
  for (const figures of statements) {
    const ledger = figures.balanceTokens.find(b => b.tag === 'LEDGERBAL') ?? figures.balanceTokens[0]
    const digits = digitsFor(figures.currency)
    const opening = options.keepAmounts === true
      ? (ledger?.original ?? 0) - figures.sum
      : fakeAmountMinor(derive, (ledger?.original ?? 0) - figures.sum || 1)
    openingBalances.push(opening)
    for (const balance of figures.balanceTokens) {
      if (options.keepAmounts === true) continue
      const value = balance.tag === 'AVAILBAL' || balance.tag === 'LEDGERBAL' ? opening + figures.sum : opening + figures.sum
      out[balance.at] = { ...out[balance.at], raw: formatAmount(value, digits) } as LayoutToken
    }
  }

  const text = out.map(token => token.raw).join('')
  return {
    output: encode(text, codec, bom),
    text,
    counts,
    unrecognised: [...unrecognised.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag)),
    sensitive,
    sensitiveTags,
    tags: outputTags,
    inputTags,
    openingBalances,
    dateShiftDays: shift
  }
}
