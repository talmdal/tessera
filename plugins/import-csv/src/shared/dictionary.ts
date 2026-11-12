// The names banks give their CSV columns, by role, in English and French, and the words their cells use for
// pending rows and for debits and credits. A header cell is looked up normalised: lower case, without accents, and
// with punctuation as spaces ('Withdrawal(s)' → 'withdrawals', 'Date de l'opération' → 'date de l operation').
// See docs/import-formats-design.md, "Guessing the layout".
import type { Role } from './layout'

/** A header cell as it is looked up. */
export function normalise(text: string): string {
  return text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/\(s\)/g, 's')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/** Header names by role, normalised. `userDate` names are `date` when the file has no posting date. */
const NAMES: Record<Exclude<Role, 'direction'>, string[]> = {
  date: [
    'date', 'posted date', 'posting date', 'date posted', 'value date', 'effective date', 'booking date', 'post date',
    'transaction posted date', 'date de l operation', 'date de valeur', 'date d inscription', 'date comptabilisee',
    'date de comptabilisation', 'date d operation', 'date operation'
  ],
  userDate: [
    'transaction date', 'trans date', 'txn date', 'purchase date', 'date of transaction', 'date de transaction',
    'date d achat', 'date de la transaction'
  ],
  payee: [
    'description', 'payee', 'merchant', 'merchant name', 'name', 'details', 'transaction details', 'description 1',
    'transaction description', 'narrative', 'particulars', 'payee name', 'libelle', 'beneficiaire', 'description de l operation',
    'nom', 'marchand'
  ],
  memo: [
    'memo', 'notes', 'note', 'description 2', 'additional info', 'additional information', 'remarque', 'remarques',
    'details 2', 'memo description', 'libelle 2', 'information supplementaire', 'sub description', 'subdescription',
    'description detail', 'extended description'
  ],
  amount: [
    'amount', 'transaction amount', 'value', 'montant', 'amount cad', 'amount usd', 'cad', 'usd', 'net amount',
    'montant de l operation', 'montant cad', 'amt'
  ],
  debit: [
    'debit', 'debits', 'withdrawal', 'withdrawals', 'money out', 'paid out', 'charges', 'charge', 'debit amount',
    'withdrawal amount', 'retrait', 'retraits', 'montant du retrait', 'debit cad', 'out'
  ],
  credit: [
    'credit', 'credits', 'deposit', 'deposits', 'money in', 'paid in', 'payments', 'payment', 'credit amount',
    'deposit amount', 'depot', 'depots', 'montant du depot', 'credit cad', 'in'
  ],
  balance: ['balance', 'running balance', 'account balance', 'solde', 'balance cad', 'solde cad', 'available balance'],
  number: [
    'cheque number', 'check number', 'cheque', 'cheque no', 'check no', 'chq no', 'chq', 'cheque num', 'check num',
    'numero de cheque', 'no de cheque', 'no cheque', 'cheque'
  ],
  status: ['status', 'etat', 'transaction status', 'statut'],
  currency: ['currency', 'devise', 'currency code', 'ccy'],
  account: [
    'account number', 'account', 'account no', 'card number', 'card no', 'card', 'numero de compte', 'no de compte',
    'numero de carte', 'compte'
  ],
  category: ['category', 'categorie', 'transaction category', 'spending category'],
  id: ['transaction id', 'fitid', 'unique id', 'transaction identifier', 'id de transaction']
}

/** Names of a column that may say whether each amount is a debit or a credit, when its values only do that. */
const DIRECTION_NAMES = ['type', 'dr cr', 'cr dr', 'debit credit', 'credit debit', 'transaction type', 'sens', 'd c', 'c d']

const BY_NAME = new Map<string, Role>()
for (const [role, names] of Object.entries(NAMES) as [Role, string[]][]) for (const name of names) if (!BY_NAME.has(name)) BY_NAME.set(name, role)

/** The role a header name suggests, or undefined. 'direction' only when `values` are debit and credit words. */
export function roleNamed(header: string, values: readonly string[] = []): Role | undefined {
  const name = normalise(header)
  if (DIRECTION_NAMES.includes(name) && isDirection(values)) return 'direction'
  // 'CAD$', 'USD $', 'Amount ($)': a currency's column is an amount
  return BY_NAME.get(name) ?? (/^(?:amount )?(?:cad|usd|eur|gbp)$/.test(name) ? 'amount' : undefined)
}

/** Words for a debit and for a credit, in a direction column. Compared in upper case. */
export const DEBIT_WORDS = ['DR', 'D', 'DEBIT', 'DB', 'DEB', 'DÉBIT', 'DEBIT']
export const CREDIT_WORDS = ['CR', 'C', 'CREDIT', 'CRED', 'CRÉDIT']

const upper = (value: string) => value.trim().toUpperCase()

/** True when every non-empty value is a debit or credit word, and there is at least one. */
export function isDirection(values: readonly string[]): boolean {
  const filled = values.map(upper).filter(v => v !== '')
  return filled.length > 0 && filled.every(v => DEBIT_WORDS.includes(v) || CREDIT_WORDS.includes(v))
}

/** The debit and credit words a direction column uses, as written. */
export function directionWords(values: readonly string[]): { debit: string[], credit: string[] } {
  const distinct = [...new Set(values.map(v => v.trim()).filter(v => v !== ''))]
  const debit = distinct.filter(v => DEBIT_WORDS.includes(upper(v)))
  const credit = distinct.filter(v => CREDIT_WORDS.includes(upper(v)))
  return { debit: debit.length > 0 ? debit : ['DR'], credit: credit.length > 0 ? credit : ['CR'] }
}

/** Words a status column uses for a row the bank hasn't posted yet. */
const PENDING = ['pending', 'en attente', 'authorized', 'authorised', 'authorization', 'hold', 'on hold', 'unposted', 'not posted', 'memo', 'temporary', 'non compense', 'en cours']

/** True for a status value that means pending. */
export const isPending = (value: string) => PENDING.includes(normalise(value))

/** The values of a status column that mean pending, as written. */
export function pendingWords(values: readonly string[]): string[] {
  const found = [...new Set(values.map(v => v.trim()).filter(v => v !== '' && isPending(v)))]
  return found.length > 0 ? found : ['Pending']
}

/** Three-letter currency codes a currency column may hold without a header to say so. */
export const CURRENCIES = new Set(['CAD', 'USD', 'EUR', 'GBP', 'AUD', 'NZD', 'JPY', 'CHF', 'MXN', 'CNY', 'HKD', 'INR', 'SEK', 'NOK', 'DKK'])
