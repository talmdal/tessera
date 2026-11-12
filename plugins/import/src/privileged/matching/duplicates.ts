// Duplicates across sources: a statement line that is a transaction already imported from another file. A line is a
// duplicate only when its own import id is known, and ids from different sources never agree: the bank's CSV knows a
// line by its content (a fingerprint), its OFX by the bank's id. So October imported from CSV and then from OFX would be
// added twice, and matching can't help, as it only looks at transactions no bank line has claimed.
//
// So each new line is compared with the lines imported before into the same account, bank text to bank text. A pair is
// proposed (Already imported?) when:
// - they aren't two bank ids from the same format (or from formats it can't tell apart), which would be two
//   transactions by the bank's own word;
// - the amounts are the same, exactly: both are what a bank reported;
// - the dates are at most 3 days apart: a CSV's transaction date against an OFX's posting date, or pending and posted;
// - the payees are alike (0.75 or more), or either has none. Words a pending line adds are ignored;
// - or, for cheques, both have the same number (and the same amount), dated at most 30 days apart, whatever their
//   payees: a Money or Quicken export names the person paid where the bank writes 'CHEQUE 101'. Two different numbers
//   are two cheques.
// Pairs are taken one to one, best first. Pure. See docs/import-formats-design.md, "Duplicates across sources".
import type { BankLine } from '@tessera/import-api'
import { payeeSimilarity } from './payees'

/** Dates at most this many days apart. */
export const DUPLICATE_DAYS = 3
/**
 * Payees at least this alike. The same payee written by two sources scored 0.82 and up in the cases measured
 * ('AMAZON.CA*2K3L91' and 'AMZN MKTP CA*2K3L91'); unrelated names up to 0.70 ('HYDRO ONE NETWORKS' and 'HOME DEPOT'),
 * with one at 0.87 ('CANADIAN TIRE' and 'CANADA POST', by their first words), which would also need the same amount
 * within 3 days. The matcher's 0.5 is too loose here: the payee is what tells two same-amount purchases apart.
 */
export const DUPLICATE_PAYEE = 0.75
/** A cheque with the same number and amount: at most this many days apart, as a bank posts it when it clears. */
export const DUPLICATE_CHEQUE_DAYS = 30

/** A line imported before, with the transaction that carries it. */
export interface EarlierLine {
  lineId: string
  transactionId: string
  importId: string
  /** The format it came through (its batch's), if known. */
  formatId?: string
  bank: Pick<BankLine, 'date' | 'amount' | 'payee' | 'number'>
}

/** A line of the statement being imported, not known by its own id. */
export interface FreshLine {
  importId: string
  bank: Pick<BankLine, 'date' | 'amount' | 'payee' | 'number'>
}

/** A cheque number as compared: its digits, without leading zeros; undefined for none. */
const chequeNumber = (number: string | undefined) => {
  const digits = number?.replace(/\D/g, '').replace(/^0+(?=\d)/, '')
  return digits ? digits : undefined
}

export interface DuplicatePair {
  /** Index into the fresh lines. */
  line: number
  earlier: EarlierLine
  /** How alike the payees are (1 when either has none): for ordering, and the record. */
  score: number
}

/** True for an import id made from a line's content rather than given by the bank. */
const isFingerprint = (id: string) => id.startsWith('fp:')

/** Words a pending or pre-authorised line adds to the bank's text ('PENDING - COSTCO'), which the posted one drops. */
const PENDING = /\b(?:pending|pend|pre-?auth(?:ori[sz](?:ed|ation))?|auth(?:ori[sz]ation)?|temp(?:orary)?|hold)\b/gi
const withoutPending = (text: string | undefined) => text?.replace(PENDING, ' ').replace(/\s+/g, ' ').trim() || undefined

const dayNumber = (date: string) => {
  const [y, m, d] = date.split('-').map(Number)
  return Date.UTC(y, m - 1, d) / 86_400_000
}

/** How alike two lines' payees are, or undefined when they aren't alike enough; 1 when either has none. */
function payees(a: string | undefined, b: string | undefined): number | undefined {
  const x = withoutPending(a)
  const y = withoutPending(b)
  if (x === undefined || y === undefined) return 1
  const similarity = payeeSimilarity(x, y)
  return similarity >= DUPLICATE_PAYEE ? similarity : undefined
}

/**
 * The fresh lines that look like earlier ones, one to one: each fresh line with at most one earlier line, and each
 * earlier line with at most one fresh line. `formatId` is the fresh statement's format. Best first: the payees most
 * alike, then the dates closest, then the earlier line first imported, then the fresh line first in the statement.
 */
export function findDuplicates(fresh: readonly FreshLine[], formatId: string | undefined, earlier: readonly EarlierLine[]): DuplicatePair[] {
  const candidates: (DuplicatePair & { days: number, order: number })[] = []
  fresh.forEach((line, i) => {
    earlier.forEach((before, order) => {
      // Two bank ids from the same format (or from formats not known to differ): different ids, different transactions
      const bothTrusted = !isFingerprint(line.importId) && !isFingerprint(before.importId)
      if (bothTrusted && (before.formatId === undefined || formatId === undefined || before.formatId === formatId)) return
      if (line.bank.amount !== before.bank.amount) return
      const days = Math.abs(dayNumber(line.bank.date) - dayNumber(before.bank.date))
      const numbers = [chequeNumber(line.bank.number), chequeNumber(before.bank.number)]
      if (numbers[0] !== undefined && numbers[1] !== undefined) {
        // Two cheques: the same one when their numbers are, whatever the payees; two when they aren't
        if (numbers[0] !== numbers[1] || days > DUPLICATE_CHEQUE_DAYS) return
        candidates.push({ line: i, earlier: before, score: 1, days, order })
        return
      }
      if (days > DUPLICATE_DAYS) return
      const score = payees(line.bank.payee, before.bank.payee)
      if (score === undefined) return
      candidates.push({ line: i, earlier: before, score, days, order })
    })
  })
  candidates.sort((a, b) => b.score - a.score || a.days - b.days || a.order - b.order || a.line - b.line)
  const usedLines = new Set<number>()
  const usedEarlier = new Set<string>()
  const pairs: DuplicatePair[] = []
  for (const { line, earlier: before, score } of candidates) {
    if (usedLines.has(line) || usedEarlier.has(before.lineId)) continue
    usedLines.add(line)
    usedEarlier.add(before.lineId)
    pairs.push({ line, earlier: before, score })
  }
  return pairs.sort((a, b) => a.line - b.line)
}
