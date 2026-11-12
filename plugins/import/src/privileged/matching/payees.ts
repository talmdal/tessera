// Payees as banks write them ('POS PURCHASE COSTCO WHSE #0123 OTTAWA ON') and as people do ('Costco'): the bank's
// noise taken out, a tidy name for a new payee, and how alike two names are. See docs/import-manager-design.md,
// "Payee similarity". Used for new lines, and by matching.

/** Words banks add that say nothing about who was paid. */
const NOISE = new Set([
  'pos', 'purchase', 'debit', 'credit', 'visa', 'mc', 'interac', 'payment', 'pmt', 'ach', 'eft', 'online', 'www', 'com',
  'inc', 'ltd', 'llc', 'the'
])

/** Canadian provinces and territories, and US states: the place at the end of a card line ('OTTAWA ON'). */
const REGIONS = new Set([
  'ab', 'bc', 'mb', 'nb', 'nl', 'ns', 'nt', 'nu', 'on', 'pe', 'qc', 'sk', 'yt',
  'al', 'ak', 'az', 'ar', 'ca', 'co', 'ct', 'de', 'fl', 'ga', 'hi', 'id', 'il', 'in', 'ia', 'ks', 'ky', 'la', 'me', 'md',
  'ma', 'mi', 'mn', 'ms', 'mo', 'mt', 'ne', 'nv', 'nh', 'nj', 'nm', 'ny', 'nc', 'nd', 'oh', 'ok', 'or', 'pa', 'ri', 'sc',
  'sd', 'tn', 'tx', 'ut', 'vt', 'va', 'wa', 'wv', 'wi', 'wy', 'dc'
])

/**
 * Words a pending or pre-authorised card line adds before the merchant ('PENDING - CANADIAN TIRE #0385'), which the
 * posted line drops. Left out of a new payee's name and of the bank's name shown to the user, but not of the normalised
 * name, which fingerprints are made from: changing that would change the ids of lines already imported.
 */
const PENDING_WORDS = new Set(['pending', 'preauth', 'preauthorized', 'preauthorised'])

const fold = (text: string) => text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()

/**
 * The words of a name, as written (case and accents kept): `&` is a word, `#` stays on the word it starts (a store
 * number or reference), and other punctuation separates words.
 */
function words(text: string): string[] {
  return text.replace(/&/g, ' & ').split(/[^\p{L}\p{N}&'#]+/u).map(w => w.replace(/^'+|'+$/g, '')).filter(w => w !== '' && w !== '#')
}

/** A store number or reference: '#0123', '0123', or a code mixing letters and digits ('2K3L91'). */
function isReference(word: string): boolean {
  if (word.startsWith('#') || /\d{3,}/.test(word)) return true
  return word.length >= 5 && /\p{L}/u.test(word) && (word.match(/\d/g)?.length ?? 0) >= 2
}

/** The words that name the payee: no bank noise, no store numbers or references, no region at the end. */
function meaningful(all: string[]): string[] {
  const kept = all.filter(w => !NOISE.has(fold(w)) && !isReference(w)).map(w => w.replace(/#/g, ''))
  // A region ends a card line after a place ('OTTAWA ON'); after & it is part of a name ('Johnny & Co')
  const before = fold(kept[kept.length - 2] ?? '')
  if (kept.length > 1 && REGIONS.has(fold(kept[kept.length - 1])) && before !== '&' && before !== 'and') kept.pop()
  return kept.filter(w => w !== '')
}

/**
 * A name reduced for comparing: lower case, no accents, `&` as 'and', no bank noise, store numbers or trailing region.
 * If that leaves nothing, the name without punctuation, so a payee called 'Payment' still compares as itself.
 */
export function normalizePayee(text: string | undefined): string {
  const all = words(text ?? '')
  const kept = meaningful(all)
  return (kept.length > 0 ? kept : all.map(w => w.replace(/#/g, '')).filter(w => w !== '')).map(w => w === '&' ? 'and' : fold(w)).join(' ')
}

const titleCase = (word: string) => word === '&' ? '&' : word.charAt(0).toLocaleUpperCase() + word.slice(1).toLocaleLowerCase()

/**
 * A name for a new payee from the bank's text: the meaningful words in title case, accents kept
 * ('POS PURCHASE COSTCO WHSE #0123 OTTAWA ON' → 'Costco Whse Ottawa', 'CAFÉ DÉPÔT #204' → 'Café Dépôt').
 * The bank's text as it was if nothing is left.
 */
export function tidyPayee(text: string): string {
  const kept = meaningful(words(text)).filter(w => !PENDING_WORDS.has(fold(w)))
  return kept.length > 0 ? kept.map(titleCase).join(' ') : text.trim().replace(/\s+/g, ' ')
}

/** Text as the Change Match dialog's search compares it: lower case, without accents, spaces collapsed. */
export function normalizeSearch(text: string): string {
  return fold(text).replace(/\s+/g, ' ').trim()
}

/**
 * The bank's text without its noise, as written: what the user recognises in "Remember that … is Costco"
 * ('POS PURCHASE COSTCO WHSE #0123' → 'COSTCO WHSE'). The text as it was if nothing is left.
 */
export function bankName(text: string): string {
  const kept = meaningful(words(text)).filter(w => !PENDING_WORDS.has(fold(w)))
  return kept.length > 0 ? kept.join(' ') : text.trim().replace(/\s+/g, ' ')
}

/** Jaro–Winkler similarity, 0 to 1. */
export function jaroWinkler(a: string, b: string): number {
  if (a === b) return a === '' ? 0 : 1
  if (a === '' || b === '') return 0
  const range = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1)
  const aMatched = new Array<boolean>(a.length).fill(false)
  const bMatched = new Array<boolean>(b.length).fill(false)
  let matches = 0
  for (let i = 0; i < a.length; i++) {
    for (let j = Math.max(0, i - range); j < Math.min(b.length, i + range + 1); j++) {
      if (!bMatched[j] && a[i] === b[j]) { aMatched[i] = bMatched[j] = true; matches++; break }
    }
  }
  if (matches === 0) return 0
  let transpositions = 0
  for (let i = 0, k = 0; i < a.length; i++) {
    if (!aMatched[i]) continue
    while (!bMatched[k]) k++
    if (a[i] !== b[k]) transpositions++
    k++
  }
  const jaro = (matches / a.length + matches / b.length + (matches - transpositions / 2) / matches) / 3
  let prefix = 0
  while (prefix < 4 && prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++
  return jaro + prefix * 0.1 * (1 - jaro)
}

/**
 * How alike two payee names are, 0 to 1, after normalising both: 1 when the same; 0.9 when every word of the shorter
 * is in the longer (or starts one of its words); otherwise the best of their Jaro–Winkler similarity, that of their
 * first words times 0.9 (banks cut names short), and the share of the shorter's words found in the longer, times 0.9.
 */
export function payeeSimilarity(a: string | undefined, b: string | undefined): number {
  return normalizedSimilarity(normalizePayee(a), normalizePayee(b))
}

/** `payeeSimilarity` of two names already normalised, for the matcher, which normalises each name once. */
export function normalizedSimilarity(x: string, y: string): number {
  if (x === '' || y === '') return 0
  if (x === y) return 1
  const [short, long] = x.split(' ').length <= y.split(' ').length ? [x.split(' '), y.split(' ')] : [y.split(' '), x.split(' ')]
  const contained = short.every(word => long.some(other => other === word || other.startsWith(word)))
  // Capped below 1, as containment is: a name inside another isn't the same name
  const overlap = short.filter(word => long.includes(word)).length / short.length * 0.9
  return Math.max(contained ? 0.9 : 0, jaroWinkler(x, y), jaroWinkler(short[0], long[0]) * 0.9, overlap)
}
