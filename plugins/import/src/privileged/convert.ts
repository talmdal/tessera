// A statement's lines as the import manager keeps them: amounts in the account's currency's minor units, text cut to
// what a transaction holds, and each line's import id: the bank's own id, or a fingerprint of the line. A line that
// can't be read is left out with a warning; the rest of the statement imports. See docs/import-manager-design.md,
// "From statement lines to transactions".
import { createHash } from 'node:crypto'
import {
  EXTERNAL_ID_MAX_LENGTH, MEMO_MAX_LENGTH, PAYEE_NAME_MAX_LENGTH, TRANSACTION_NUMBER_MAX_LENGTH, isIsoDate, minorDigits,
  parseAmount
} from '@tessera/accounts-api'
import {
  FINGERPRINT_PREFIX, STATEMENT_LINE_KINDS, isCanonicalDecimal,
  type BankLine, type StatementLine, type StatementLineKind
} from '@tessera/import-api'
import { normalizePayee } from './matching/payees'

/** A line ready to import: its identity, and what the bank said, in minor units. */
export interface ConvertedLine {
  importId: string
  bank: BankLine
  /** Where it is in the statement, from 1, for warnings. */
  line: number
  /** The file's category for it, as given ('Food:Groceries'): a hint for its draft, not kept with the bank line. */
  category?: string
}

/** The longest category path kept as a hint: longer ones aren't categories. */
const CATEGORY_HINT_MAX_LENGTH = 200

export type Minor = { ok: true, value: number } | { ok: false, problem: string }

/**
 * A canonical decimal as minor units of `currency`. Trailing zeros past the currency's digits are dropped
 * ('-12.3400' is -1234 cents); any other extra digit is a problem, never rounded.
 */
export function toMinor(decimal: string, currency: string): Minor {
  if (!isCanonicalDecimal(decimal)) return { ok: false, problem: `“${decimal}” isn't an amount` }
  const digits = minorDigits(currency)
  const [whole, fraction = ''] = decimal.split('.')
  const extra = fraction.slice(digits)
  if (/[1-9]/.test(extra)) {
    return { ok: false, problem: `${decimal} has more decimals than ${currency} allows (${digits})` }
  }
  const kept = fraction.slice(0, digits)
  const parsed = parseAmount(kept === '' ? whole : `${whole}.${kept}`, currency, 'en-US')
  return parsed.ok ? { ok: true, value: parsed.value } : { ok: false, problem: `${decimal}: ${parsed.message}` }
}

/** Text collapsed to single spaces and cut to `max` characters, or undefined when empty. */
function cut(text: string | undefined, max: number): string | undefined {
  const collapsed = text?.replace(/\s+/g, ' ').trim()
  if (!collapsed) return undefined
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1)}…`
}

/** A line's fingerprint, for a line without a bank id: the same line gives the same one, in every file. */
export function fingerprint(line: Pick<BankLine, 'date' | 'amount' | 'payee' | 'memo'>): string {
  const basis = [line.date, String(line.amount), normalizePayee(line.payee), (line.memo ?? '').trim().toLowerCase()].join('|')
  return FINGERPRINT_PREFIX + createHash('sha256').update(basis).digest('hex').slice(0, 16)
}

export interface Converted {
  lines: ConvertedLine[]
  /** Lines left out, each with a warning. */
  invalid: number
  /** The same bank line twice in the statement: the second is a duplicate, not a second transaction. */
  repeated: number
  warnings: string[]
}

/** True for an import id made from a line's content, not given by the bank. */
export const isFingerprint = (importId: string) => importId.startsWith(FINGERPRINT_PREFIX)

/**
 * Converts a statement's lines. `stableIds` false means the format's bank ids may change between downloads, so lines
 * are known by fingerprint instead. `distrust` names bank ids not to use, as they named other transactions before
 * (see collisions.ts): those lines are known by fingerprint too.
 */
export function convertLines(lines: StatementLine[], currency: string, options: { stableIds?: boolean, distrust?: ReadonlySet<string> } = {}): Converted {
  const warnings: string[] = []
  let invalid = 0
  const bankLines: { bank: BankLine, externalId?: string, line: number, category?: string }[] = []
  lines.forEach((line, i) => {
    const where = `Line ${i + 1}`
    if (!isIsoDate(line.date)) { invalid++; warnings.push(`${where}: “${line.date}” isn't a date, so the line was left out.`); return }
    const amount = toMinor(line.amount, currency)
    if (!amount.ok) { invalid++; warnings.push(`${where}: ${amount.problem}, so the line was left out.`); return }
    if (amount.value === 0) { invalid++; warnings.push(`${where}: an amount of zero (usually a card authorisation) was left out.`); return }

    let memo = cut(line.memo, MEMO_MAX_LENGTH)
    let number = cut(line.number, MEMO_MAX_LENGTH)           // whole: one too long for a number moves to the memo
    if (number !== undefined && number.length > TRANSACTION_NUMBER_MAX_LENGTH) {
      memo = cut(memo ? `${memo} (${number})` : number, MEMO_MAX_LENGTH)   // too long for a cheque number: kept in the memo
      number = undefined
    }
    const payee = cut(line.payee, PAYEE_NAME_MAX_LENGTH)
    const kind = (STATEMENT_LINE_KINDS as readonly string[]).includes(line.kind ?? '') ? line.kind as StatementLineKind : undefined
    const bank: BankLine = {
      date: line.date, amount: amount.value,
      ...(line.userDate !== undefined && isIsoDate(line.userDate) && { userDate: line.userDate }),
      ...(payee !== undefined && { payee }),
      ...(memo !== undefined && { memo }),
      ...(number !== undefined && { number }),
      ...(kind !== undefined && { kind })
    }
    const id = typeof line.externalId === 'string' && line.externalId !== '' && line.externalId.length <= EXTERNAL_ID_MAX_LENGTH
      && !options.distrust?.has(line.externalId) ? line.externalId : undefined
    // A category hint: a path, never a transfer ('[Savings]'), and never so long it can't be one
    const category = typeof line.category === 'string' ? line.category.replace(/\s+/g, ' ').trim() : ''
    const hint = category !== '' && !category.startsWith('[') && category.length <= CATEGORY_HINT_MAX_LENGTH ? category : undefined
    bankLines.push({ bank, line: i + 1, ...(id !== undefined && { externalId: id }), ...(hint !== undefined && { category: hint }) })
  })

  // Identities: the bank's id when it can be trusted; otherwise a fingerprint, numbered when the same line repeats
  const useBankIds = options.stableIds !== false
  const prints = bankLines.map(({ bank, externalId }) => useBankIds && externalId !== undefined ? undefined : fingerprint(bank))
  const repeats = new Map<string, number>()
  for (const print of prints) if (print !== undefined) repeats.set(print, (repeats.get(print) ?? 0) + 1)
  const seen = new Map<string, number>()
  const ids = new Set<string>()
  const converted: ConvertedLine[] = []
  let repeated = 0
  bankLines.forEach(({ bank, externalId, line, category }, i) => {
    const print = prints[i]
    let importId: string
    if (print === undefined) importId = externalId!
    else {
      const n = (seen.get(print) ?? 0) + 1
      seen.set(print, n)
      importId = repeats.get(print)! > 1 ? `${print}#${n}` : print
    }
    if (ids.has(importId)) { repeated++; return }        // the bank sent the same id twice
    ids.add(importId)
    converted.push({ importId, bank, line, ...(category !== undefined && { category }) })
  })
  return { lines: converted, invalid, repeated, warnings }
}
