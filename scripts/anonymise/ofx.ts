// OFX, QFX and QBO files, anonymised in place. The OFX plugin's own reader (plugins/format-ofx/…/sgml.ts) says what
// each value is and where it is written; only the values are rewritten, and every other byte (tags, header, spacing)
// is kept, so the file is still the dialect the bank wrote.
//
// What each value becomes:
// - account numbers (ACCTID, BANKID, BRANCHID, ACCTKEY): other digits, the masks (XXXX) kept;
// - ids (FITID, TRNUID, cookies, user ids): the same shape, except FITIDs of 6 digits or fewer, which are the counters
//   a conversion tool makes, and not personal;
// - amounts: changed (see amounts.ts), and balances worked out again from the changed lines;
// - dates, codes, types, cheque numbers, currency: kept; dates moved by whole weeks if asked;
// - the bank (ORG, FID, INTU.BID): kept, unless asked to hide it;
// - every other value (payees, memos, addresses, messages, tags it doesn't know): its words replaced.
// See docs/import-formats-design.md, "What is replaced, by format".
import { declaredEncoding, findAll, parseOfx, valueOf, type OfxNode } from '../../plugins/format-ofx/src/privileged/sgml'
import { Amounts, SCALE, readAmount, rewrite, writeSigned } from './amounts'
import type { Scannable } from './scan'
import type { Pseudonyms, Replaced } from './words'

/**
 * Values kept as they are: codes, types, languages, currencies, cheque numbers (CHECKNUM of 6 digits at most; a longer
 * one is a reference, given another of its shape). Dates (DT…) are kept too.
 */
const KEEP = new Set(['CODE', 'SEVERITY', 'LANGUAGE', 'CURDEF', 'CURSYM', 'CURRATE', 'ACCTTYPE', 'TRNTYPE', 'CHECKNUM', 'SIC', 'BALTYPE'])
const CHEQUE_NUMBER = /^\d{1,6}$/
/** The bank: kept unless asked to hide it. */
const INSTITUTION = new Set(['ORG', 'FID', 'INTU.BID'])
/** Ids and keys: replaced by ones of the same shape. */
const IDS = new Set([
  'FITID', 'CORRECTFITID', 'SRVRTID', 'REFNUM', 'PAYEEID', 'PAYEELSTID', 'TRNUID', 'CLTCOOKIE', 'SESSCOOKIE', 'USERID',
  'USERKEY', 'ACCESSKEY', 'TOKEN', 'INTU.USERID'
])
/** Account numbers: other digits, masks kept. */
const ACCOUNTS = new Set(['ACCTID', 'BANKID', 'BRANCHID', 'ACCTKEY'])
/** FITIDs this short are counters (1, 2, 3…), not personal: kept, so the made-up-id check still sees them. */
const COUNTER = /^\d{1,6}$/

export interface OfxCounts {
  accountNumbers: number
  ids: number
  payees: number
  memos: number
  otherText: number
  amounts: number
  balances: number
  dates: number
}

export const noCounts = (): OfxCounts => ({ accountNumbers: 0, ids: 0, payees: 0, memos: 0, otherText: 0, amounts: 0, balances: 0, dates: 0 })

export interface OfxOptions {
  /** Days to move every date by (whole weeks). */
  shiftDays: number
  hideInstitution: boolean
  keepAmounts: boolean
}

/** What a run knows of each account's lines, across its files, to work balances out again. Holds originals. */
export interface BalanceMapping {
  [account: string]: {
    /** How much every balance of the account moves, besides its lines' changes. */
    offset: number
    /** Each line (id, date and amount) → its date (YYYYMMDD) and how much its amount changed, at SCALE. */
    lines: Record<string, [string, number]>
  }
}

export interface OfxRun {
  words: Pseudonyms
  amounts: Amounts
  balances: BalanceMapping
  options: OfxOptions
}

/** An OFX file read, ready to be rewritten once every file of the run has been read. */
export interface PreparedOfx {
  text: string
  root: OfxNode
  /** Where the header ends and <OFX> begins. */
  bodyStart: number
}

/** True when the text is OFX (either version): the OFX plugin's own test. */
export const isOfx = (text: string) => /OFXHEADER|<OFX>/i.test(text.slice(0, 4096))

/** The encoding an OFX file's header declares. */
export const ofxEncoding = (bytes: Uint8Array) => declaredEncoding(new TextDecoder('latin1').decode(bytes.subarray(0, 2048)))

const statementsOf = (root: OfxNode) => [...findAll(root, 'STMTRS'), ...findAll(root, 'CCSTMTRS')]
const accountOf = (rs: OfxNode) => {
  const from = findAll(rs, 'BANKACCTFROM')[0] ?? findAll(rs, 'CCACCTFROM')[0]
  return `${valueOf(from, 'BANKID') ?? ''}:${valueOf(from, 'ACCTID') ?? ''}`
}
const day = (date: string | undefined) => date?.trim().slice(0, 8) ?? ''

/** Every value node under `node`, with its parent's name. */
function values(node: OfxNode, parent = '', out: { node: OfxNode, parent: string }[] = []) {
  for (const child of node.children) {
    if (child.span) out.push({ node: child, parent })
    values(child, child.name, out)
  }
  return out
}

/**
 * The first pass over a file: reads it, notes its originals (so nothing made up is one of them), and records how each
 * line's amount changes, for the balances of every file in the run.
 */
export function prepareOfx(text: string, run: OfxRun): PreparedOfx {
  const document = parseOfx(text)
  if (!document) throw new Error('it has no <OFX> section, so it is not an OFX file')
  for (const { node } of values(document.root)) run.words.note(node.text ?? '')
  for (const rs of statementsOf(document.root)) {
    const account = accountOf(rs)
    const known = run.balances[account] ??= { offset: 0, lines: {} }
    for (const trn of findAll(rs, 'STMTTRN')) {
      const written = readAmount(valueOf(trn, 'TRNAMT') ?? '')
      if (!written) continue
      const changed = run.amounts.change(written.value, written.decimals)
      known.lines[`${valueOf(trn, 'FITID') ?? ''}|${day(valueOf(trn, 'DTPOSTED'))}|${written.value}`] = [day(valueOf(trn, 'DTPOSTED')), changed - written.value]
    }
  }
  return { text, root: document.root, bodyStart: text.search(/<OFX>/i) }
}

interface Edit {
  start: number
  end: number
  text: string
  /** 1 where a character is the original's and not vetted: what the scan looks for. */
  original: Uint8Array
  /** A known-harmless value (a date, a code): the scan doesn't look at it. */
  hidden: boolean
}

/**
 * A value as OFX writes it: '&', '<' and '>' as entities, and, when the original wrote its accented letters as
 * character references (`CAF&#201;`), those too, so the file keeps its dialect (and an ASCII file stays ASCII).
 */
const escapeOfx = (replaced: Replaced, raw = ''): Replaced => {
  const references = /&#/.test(raw)
  let text = ''
  const original: number[] = []
  replaced.text.split('').forEach((ch, i) => {
    const code = ch.charCodeAt(0)
    const out = ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;'
      : references && code > 0x7e && (code < 0xd800 || code > 0xdfff) ? `&#${code};` : ch
    text += out
    for (let k = 0; k < out.length; k++) original.push(out.length === 1 ? replaced.original[i] : 0)
  })
  return { text, original: Uint8Array.from(original) }
}

const made = (text: string): Replaced => ({ text, original: new Uint8Array(text.length) })

/** A date moved by whole days, in the same form: '20261005120000[-5:EST]' → '20261012120000[-5:EST]'. */
function shiftDate(text: string, days: number): string {
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(text)
  if (!m || days === 0) return text
  const moved = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days))
  const ymd = `${moved.getUTCFullYear()}${String(moved.getUTCMonth() + 1).padStart(2, '0')}${String(moved.getUTCDate()).padStart(2, '0')}`
  return ymd + text.slice(8)
}

/** The second pass: the file with its values replaced, and what the scan needs to know about each character. */
export function rewriteOfx(prepared: PreparedOfx, run: OfxRun, counts: OfxCounts): Scannable {
  const { text, root, bodyStart } = prepared
  const { words, amounts, options } = run
  const edits: Edit[] = []
  const keepAs = (node: OfxNode) => edits.push({ start: node.span!.start, end: node.span!.end, text: text.slice(node.span!.start, node.span!.end), original: new Uint8Array(node.span!.end - node.span!.start), hidden: true })
  const replace = (node: OfxNode, replaced: Replaced, hidden = false) => edits.push({ start: node.span!.start, end: node.span!.end, text: replaced.text, original: replaced.original, hidden })
  const raw = (node: OfxNode) => text.slice(node.span!.start, node.span!.end)
  const done = new Set<OfxNode>()

  // The header: kept, except the file ids a bank may make unique to the download
  const header = text.slice(0, Math.max(0, bodyStart))
  for (const m of header.matchAll(/(^|\n)\s*((?:NEW|OLD)FILEUID)\s*:\s*(\S+)/g)) {
    if (m[3].toUpperCase() === 'NONE') continue
    const at = m.index! + m[0].length - m[3].length
    edits.push({ start: at, end: at + m[3].length, ...made(words.shape(m[3])), hidden: false }); counts.ids++
  }
  for (const m of header.matchAll(/((?:NEW|OLD)FILEUID)\s*=\s*"([^"]*)"/g)) {
    if (m[2].toUpperCase() === 'NONE' || m[2] === '') continue
    const at = m.index! + m[0].length - 1 - m[2].length
    edits.push({ start: at, end: at + m[2].length, ...made(words.shape(m[2])), hidden: false }); counts.ids++
  }

  // Balances: the old balance, the account's offset, and the changes of its lines up to the balance's date
  for (const rs of statementsOf(root)) {
    const known = run.balances[accountOf(rs)] ?? { offset: 0, lines: {} }
    for (const name of ['LEDGERBAL', 'AVAILBAL']) {
      const bal = findAll(rs, name)[0]
      const amount = bal?.children.find(c => c.name === 'BALAMT')
      const written = amount?.text !== undefined ? readAmount(amount.text) : undefined
      if (!amount?.span || !written) continue
      done.add(amount)
      if (options.keepAmounts) { keepAs(amount); continue }
      if (known.offset === 0) known.offset = amounts.change(written.value, written.decimals) - written.value || 10 ** (SCALE - written.decimals)
      const asOf = day(valueOf(bal, 'DTASOF')) || '99999999'
      const changes = Object.values(known.lines).filter(([date]) => date <= asOf).reduce((sum, [, change]) => sum + change, 0)
      const decimals = Math.max(written.decimals, ...findAll(rs, 'TRNAMT').map(t => readAmount(t.text ?? '')?.decimals ?? 0))
      replace(amount, made(writeSigned(written.value + known.offset + changes, { ...written, decimals })))
      counts.balances++
    }
  }

  for (const { node, parent } of values(root)) {
    if (done.has(node)) continue
    const name = node.name
    const value = node.text ?? ''
    if (name.startsWith('DT')) {
      if (options.shiftDays === 0) keepAs(node)
      else { replace(node, made(shiftDate(text.slice(node.span!.start, node.span!.end), options.shiftDays)), true); counts.dates++ }
    } else if (name === 'CHECKNUM' && !CHEQUE_NUMBER.test(value.trim())) {
      replace(node, escapeOfx(made(words.shape(value)), raw(node)))
      counts.ids++
    } else if (KEEP.has(name) || (INSTITUTION.has(name) && !options.hideInstitution)) {
      keepAs(node)
    } else if (INSTITUTION.has(name)) {
      replace(node, escapeOfx(name === 'ORG' ? words.text(value) : made(words.shape(value)), raw(node)))
    } else if (name === 'TRNAMT' || name === 'BALAMT' || name.endsWith('AMT') || (name === 'VALUE' && parent === 'BAL')) {
      const written = readAmount(value)
      if (!written || options.keepAmounts) { keepAs(node); continue }
      replace(node, made(rewrite(written, amounts.change(written.value, written.decimals))))
      counts.amounts++
    } else if (ACCOUNTS.has(name)) {
      replace(node, escapeOfx(made(words.shape(value, { masks: true })), raw(node)))
      if (name === 'ACCTID') counts.accountNumbers++
    } else if (IDS.has(name)) {
      if ((name === 'FITID' || name === 'CORRECTFITID') && COUNTER.test(value)) { keepAs(node); continue }
      replace(node, escapeOfx(made(words.shape(value)), raw(node)))
      counts.ids++
    } else {
      replace(node, escapeOfx(words.text(value), raw(node)))
      if (name === 'NAME' && (parent === 'STMTTRN' || parent === 'PAYEE')) counts.payees++
      else if (name === 'MEMO') counts.memos++
      else counts.otherText++
    }
  }

  return build(text, edits, header.length)
}

/** Tags, and the XML declaration and processing instructions: structure, not looked at by the scan. */
const TAG = /<\/?[A-Za-z][\w.]*(?:\s[^<>]*)?\/?>|<\?[^<>]*\?>/g

/** Applies the edits, keeping every other character, and marks each character for the scan. */
function build(source: string, edits: Edit[], headerLength: number): Scannable {
  edits.sort((a, b) => a.start - b.start)
  let text = ''
  const original: number[] = []
  const hidden: number[] = []
  const keep = (from: number, to: number) => {
    const chunk = source.slice(from, to)
    const tags = new Uint8Array(chunk.length)
    for (const m of chunk.matchAll(TAG)) tags.fill(1, m.index!, m.index! + m[0].length)
    for (let i = 0; i < chunk.length; i++) {
      text += chunk[i]
      original.push(1)
      // The header (apart from the file ids edited above) and the tags are structure
      hidden.push(from + i < headerLength || tags[i] || /\s/.test(chunk[i]) ? 1 : 0)
    }
  }
  let at = 0
  for (const edit of edits) {
    if (edit.start < at) continue                    // (never: values don't overlap)
    keep(at, edit.start)
    text += edit.text
    for (let i = 0; i < edit.text.length; i++) { original.push(edit.original[i] ?? 0); hidden.push(edit.hidden ? 1 : 0) }
    at = edit.end
  }
  keep(at, source.length)
  return { text, original: Uint8Array.from(original), hidden: Uint8Array.from(hidden) }
}

/**
 * A file as the scan sees it when checking, not anonymising: every character the original's, with the structure and
 * the values that can't be personal (dates, amounts, codes, ids) hidden. For `--check`, and the fixtures' privacy test.
 *
 * `anonymised`: the file is the anonymiser's own output ('*.anon.*'). Its payees, memos, account numbers, ids and
 * amounts are then its own made-up values, replaced by construction, which a scan of the file can't tell from real ones
 * (a made-up reference number is a long number too). What can still hold the original's data is only what the
 * anonymiser keeps as it was: codes, the bank, cheque numbers, and any text outside the values. Those are looked at.
 */
export function checkableOfx(text: string, options: { anonymised?: boolean } = {}): Scannable {
  const document = parseOfx(text)
  const edits: Edit[] = []
  const bodyStart = Math.max(0, text.search(/<OFX>/i))
  if (document) {
    for (const { node, parent } of values(document.root)) {
      const name = node.name
      // A CHECKNUM longer than a cheque number is the anonymiser's own, as a reference is replaced
      const kept = (KEEP.has(name) && !(name === 'CHECKNUM' && !CHEQUE_NUMBER.test((node.text ?? '').trim()))) || INSTITUTION.has(name)
      const harmless = name.startsWith('DT') || kept || IDS.has(name) ||
        name === 'TRNAMT' || name.endsWith('AMT') || (name === 'VALUE' && parent === 'BAL')
      const raw = text.slice(node.span!.start, node.span!.end)
      const hidden = options.anonymised ? name.startsWith('DT') || !kept : harmless
      edits.push({ start: node.span!.start, end: node.span!.end, text: raw, original: new Uint8Array(raw.length).fill(1), hidden })
    }
  }
  return build(text, edits, bodyStart)
}
