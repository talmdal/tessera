// Made-up words and numbers in place of real ones, consistently: the same payee gets the same made-up name everywhere
// in a run (and in later runs given the same mapping), so overlapping statements still overlap, and a payee the
// matcher should recognise is still recognisable. The shape is kept: case, length, digits for digits, letters for
// letters, separators and the words banks add ('POS PURCHASE', 'E-TRANSFER', a province at the end). Everything else
// is replaced: a merchant's name and an e-transfer recipient's can't be told apart reliably.
// See docs/import-formats-design.md, "Anonymising real statement files".
import type { Random } from './random'

/**
 * Words that say what kind of line it is, not who it was with: kept. Lower case, without accents. The payee noise
 * words (matching/payees.ts), the words of bank statements in English and French, and a few connecting words.
 */
export const VOCABULARY: ReadonlySet<string> = new Set([
  // The matcher's noise words
  'pos', 'purchase', 'debit', 'credit', 'visa', 'mc', 'interac', 'payment', 'pmt', 'ach', 'eft', 'online', 'www', 'com',
  'inc', 'ltd', 'llc', 'the',
  // Statements, in English
  'e', 'etransfer', 'transfer', 'transfers', 'xfer', 'to', 'from', 'withdrawal', 'withdrawals', 'deposit', 'deposits',
  'atm', 'branch', 'cheque', 'cheques', 'chq', 'check', 'checks', 'fee', 'fees', 'monthly', 'annual', 'service', 'charge',
  'charges', 'interest', 'paid', 'bank', 'banking', 'account', 'acct', 'bill', 'bills', 'payroll', 'pay', 'direct',
  'card', 'cash', 'refund', 'return', 'returned', 'reversal', 'nsf', 'overdraft', 'mobile', 'telephone', 'internet',
  'wire', 'pre', 'preauthorized', 'preauthorised', 'authorized', 'authorised', 'pad', 'recurring', 'mortgage', 'loan',
  'loc', 'line', 'of', 'for', 'and', 'on', 'at', 'in', 'by', 'a', 'an', 'ref', 'reference', 'no', 'number', 'memo',
  'inv', 'invoice', 'balance', 'opening', 'closing', 'adjustment', 'correction', 'tax', 'gst', 'hst', 'pst', 'usd',
  'cad', 'eur', 'gbp', 'fx', 'foreign', 'exchange', 'conversion', 'international', 'thank', 'you', 'thankyou',
  'client', 'customer', 'supplier', 'rent', 'office', 'supplies', 'business', 'personal', 'savings', 'chequing',
  'checking', 'run', 'sale', 'store', 'shop', 'contactless', 'tap', 'chip', 'bill', 'payments',
  // The words of a CSV export's totals and balance rows, which the CSV format leaves out by them
  'transaction', 'transactions', 'total', 'totals', 'subtotal', 'sub', 'grand', 'forward', 'previous', 'beginning', 'ending', 'pending', 'posted',
  // Statements, in French
  'virement', 'virements', 'retrait', 'retraits', 'depot', 'depots', 'frais', 'mensuel', 'mensuels', 'interets',
  'interet', 'paiement', 'paiements', 'achat', 'achats', 'solde', 'au', 'du', 'de', 'la', 'le', 'les', 'des', 'et', 'par',
  'pour', 'guichet', 'automatique', 'carte', 'facture', 'remboursement', 'transfert', 'preautorise', 'en', 'ligne',
  'compte', 'service', 'paie', 'sous', 'ouverture', 'cloture', 'reporte', 'precedent', 'initial', 'final', 'attente'
])

/** Canadian provinces and territories, and US states: the place at the end of a card line ('OTTAWA ON'). Kept. */
export const REGIONS: ReadonlySet<string> = new Set([
  'ab', 'bc', 'mb', 'nb', 'nl', 'ns', 'nt', 'nu', 'on', 'pe', 'qc', 'sk', 'yt',
  'al', 'ak', 'az', 'ar', 'ca', 'co', 'ct', 'de', 'fl', 'ga', 'hi', 'id', 'il', 'in', 'ia', 'ks', 'ky', 'la', 'me', 'md',
  'ma', 'mi', 'mn', 'ms', 'mo', 'mt', 'ne', 'nv', 'nh', 'nj', 'nm', 'ny', 'nc', 'nd', 'oh', 'ok', 'or', 'pa', 'ri', 'sc',
  'sd', 'tn', 'tx', 'ut', 'vt', 'va', 'wa', 'wv', 'wi', 'wy', 'dc'
])

/** Lower case, without accents: how words are compared. */
export const fold = (text: string) => text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()

/** The run's made-up values, kept so a later run can use the same ones (`--map`). Holds the originals: never commit it. */
export interface WordMapping {
  /** A word (folded) → its made-up word (lower case; the original's case is applied each time). */
  words: Record<string, string>
  /** A run of digits → another of the same length. */
  digits: Record<string, string>
  /** A code, id or account number → one of the same shape. */
  shapes: Record<string, string>
}

export const emptyWords = (): WordMapping => ({ words: {}, digits: {}, shapes: {} })

/** Text that was replaced, and for each character whether it was copied from the original unvetted (see scan.ts). */
export interface Replaced {
  text: string
  /** 1 where the character is the original's and might be personal: a word the user asked to keep. */
  original: Uint8Array
}

const CONSONANTS = 'bcdfghjklmnprstvwz'
const VOWELS = 'aeiou'
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
const LOWER = 'abcdefghjkmnpqrstuvwxyz'
/** Characters that mask part of an account number ('XXXXXXXX3456', '****3456'): kept. */
const MASK = /[Xx*#•]/

/** The original's case on a made-up word: UPPER, Title, or lower. */
function withCase(word: string, like: string): string {
  if (like === like.toUpperCase() && like !== like.toLowerCase()) return word.toUpperCase()
  if (like[0] === like[0].toUpperCase() && like.slice(1) === like.slice(1).toLowerCase()) return word[0].toUpperCase() + word.slice(1)
  if (like === like.toLowerCase()) return word
  return word[0].toUpperCase() + word.slice(1)
}

export class Pseudonyms {
  /** Every original value replaced (words of 4 letters or more, digit runs of 4 or more, codes), for the scan. */
  readonly replaced = new Set<string>()
  private readonly avoid = new Set<string>()
  private readonly used = new Set<string>()
  private readonly keep: ReadonlySet<string>
  private readonly structural = new Set<string>()

  constructor(private readonly random: Random, readonly mapping: WordMapping = emptyWords(), keepWords: readonly string[] = []) {
    this.keep = new Set(keepWords.map(w => fold(w.trim())).filter(w => w !== ''))
    for (const made of [...Object.values(mapping.words), ...Object.values(mapping.digits), ...Object.values(mapping.shapes)]) this.used.add(made.toLowerCase())
  }

  /**
   * Notes the words, digit runs and codes of a value before anything is made up, so no made-up value is one of the
   * run's originals (the scan would then find it, and refuse the file).
   */
  note(value: string) {
    for (const token of value.match(/[\p{L}\p{N}]+/gu) ?? []) this.avoid.add(fold(token))
    this.avoid.add(fold(value))
  }

  /**
   * Words of the file's own structure, kept wherever they appear: a CSV file's header names ('Description', 'Balance'),
   * which the file keeps as they are, so a payee using one mustn't have it replaced (the scan would find the header).
   */
  addVocabulary(text: string) {
    for (const token of text.match(/\p{L}+/gu) ?? []) this.structural.add(fold(token))
  }

  /** A word kept as it is: the statement's vocabulary, a region, or one the user asked to keep. */
  kept(word: string): 'vocabulary' | 'user' | undefined {
    const folded = fold(word)
    if (this.keep.has(folded)) return 'user'
    if (VOCABULARY.has(folded) || REGIONS.has(folded) || this.structural.has(folded)) return 'vocabulary'
    return undefined
  }

  private fresh(make: () => string): string {
    for (let attempt = 0; ; attempt++) {
      const made = make()
      const key = made.toLowerCase()
      if (attempt < 200 && (this.avoid.has(key) || this.used.has(key) || VOCABULARY.has(key) || REGIONS.has(key))) continue
      this.used.add(key)
      return made
    }
  }

  /** A made-up word for `word`, the same every time, in its case. */
  word(word: string): string {
    const folded = fold(word)
    if (word.length >= 4) this.replaced.add(folded)
    let made = this.mapping.words[folded]
    if (made === undefined) {
      const length = Math.min(12, Math.max(3, [...word].length))
      made = this.fresh(() => {
        let out = ''
        let vowel = this.random.below(3) === 0
        while (out.length < length) { out += this.random.pick(vowel ? VOWELS : CONSONANTS); vowel = !vowel }
        return out
      })
      this.mapping.words[folded] = made
    }
    return withCase(made, word)
  }

  /** Other digits of the same length, the same every time. A single digit may repeat; longer runs never do. */
  digits(run: string): string {
    if (run.length >= 4) this.replaced.add(run)
    let made = this.mapping.digits[run]
    if (made === undefined) {
      const random = () => Array.from(run, () => this.random.pick('0123456789')).join('')
      made = run.length <= 2 ? random() : this.fresh(random)
      this.mapping.digits[run] = made
    }
    return made
  }

  /**
   * A value of the same shape, the same every time: digits for digits, letters for letters in the same case, and
   * everything else kept (separators; with `masks`, the X's and *'s hiding part of an account number).
   */
  shape(value: string, options: { masks?: boolean } = {}): string {
    const key = `${options.masks ? 'm' : 's'}:${value}`
    if (value.length >= 4) this.replaced.add(fold(value))
    let made = this.mapping.shapes[key]
    if (made === undefined) {
      made = this.fresh(() => Array.from(value, ch => {
        if (options.masks && MASK.test(ch)) return ch
        if (/\d/.test(ch)) return this.random.pick('0123456789')
        if (/\p{Lu}/u.test(ch)) return this.random.pick(UPPER)
        if (/\p{Ll}/u.test(ch)) return this.random.pick(LOWER)
        return ch
      }).join(''))
      this.mapping.shapes[key] = made
    }
    return made
  }

  /**
   * Free text (a payee, a memo, an address) with every word replaced except the statement's vocabulary, regions and
   * the words the user asked to keep; digit runs become other digits, and codes mixing both keep their shape.
   */
  text(value: string): Replaced {
    let text = ''
    const original: number[] = []
    for (const part of value.split(/([\p{L}\p{N}]+)/u)) {
      if (part === '') continue
      let made: string
      let fromOriginal = false
      if (!/^[\p{L}\p{N}]+$/u.test(part)) made = part                         // separators
      else {
        const kept = this.kept(part)
        if (kept) { made = part; fromOriginal = kept === 'user' }
        else if (/^\d+$/.test(part)) made = this.digits(part)
        else if (/^\p{L}+$/u.test(part)) made = this.word(part)
        else made = this.shape(part)
      }
      text += made
      for (let i = 0; i < made.length; i++) original.push(fromOriginal ? 1 : 0)
    }
    return { text, original: Uint8Array.from(original) }
  }
}
