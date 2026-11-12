// The sign cross-check: are a statement's amounts the wrong way round for its account? A format reads signs as the
// file writes them, and decides before the account is known; a chequing export with money out as positive just looks
// like a month of deposits. Once the account is known, the evidence is here: its type, its entries, its earlier imports,
// its balance, and what this source's files have been like. Each piece says 'asRead', 'reversed', or nothing, and is
// strong or weak. Strong evidence for reversed asks; weak evidence for reversed asks unless strong evidence says as
// read; anything else imports as read. Pure. See docs/import-formats-design.md, "Sign cross-check".
import type { AccountType } from '@tessera/accounts-api'

export type Says = 'asRead' | 'reversed'

export type SignEvidence =
  /** Lines that match transactions the user entered, read each way. */
  | { kind: 'matching', says: Says, strength: 'strong', asRead: number, reversed: number }
  /** Lines that look like lines imported before from another file, read each way. */
  | { kind: 'earlier', says: Says, strength: 'strong', asRead: number, reversed: number }
  /** The account's balance before, plus the lines, is the bank's balance: read as they are, or reversed. */
  | { kind: 'balance', says: Says, strength: 'strong', balance: number, asOf: string }
  /** Most lines would raise a card's balance (payments), or a chequing account's (deposits). First import only. */
  | { kind: 'type', says: 'reversed', strength: 'weak', raising: number, lines: number, liability: boolean }
  /** This source's files have been mostly one way, and this one is mostly the other. */
  | { kind: 'profile', says: 'reversed', strength: 'weak', wasOut: number, isOut: number }

/** Pairs needed, and how many times more one way than the other, for matching or earlier imports to say anything. */
export const BOTH_WAYS_AT_LEAST = 3
export const BOTH_WAYS_TIMES = 3
/** The most lines the two "both ways" passes look at. */
export const BOTH_WAYS_LINES = 500
/** A card or line of credit: more than this share of lines raising its balance (payments) looks reversed. */
export const LIABILITY_RAISING = 2 / 3
/** A chequing or cash account: more than this share of lines raising it (deposits) looks reversed. */
export const ASSET_RAISING = 0.8
/** Fewer lines than this say nothing about a statement's direction. */
export const DIRECTION_LINES = 3
/** A source's profile: at least this many lines seen, and a share of money out this far from even. */
export const PROFILE_LINES = 5
export const PROFILE_MOSTLY = 0.7

/** What counting pairs each way says: at least 3, and three times as many as the other way. */
export function bothWays(asRead: number, reversed: number): Says | undefined {
  if (reversed >= BOTH_WAYS_AT_LEAST && reversed >= BOTH_WAYS_TIMES * asRead) return 'reversed'
  if (asRead >= BOTH_WAYS_AT_LEAST && asRead >= BOTH_WAYS_TIMES * reversed) return 'asRead'
  return undefined
}

/**
 * What the bank's balance says. `before` is the account's balance on the balance's date before this import, `lines`
 * the sum of the statement's new lines dated on or before it, and `balance` the bank's balance as read. A format that
 * reads the amounts the wrong way reads the balance the same way, so reversed means before − lines = −balance. Only
 * exact equality counts: an account whose history is incomplete says nothing.
 */
export function balanceSays(before: number, lines: number, balance: number): Says | undefined {
  const asRead = before + lines === balance
  const reversed = before - lines === -balance
  if (asRead && !reversed) return 'asRead'
  if (reversed && !asRead) return 'reversed'
  return undefined
}

const LIABILITIES: ReadonlySet<AccountType> = new Set(['creditCard', 'lineOfCredit'])
const SPENDING: ReadonlySet<AccountType> = new Set(['chequing', 'cash'])

/**
 * What the account's type says of a statement's amounts as read: a card where payments outnumber charges by two to one,
 * or a chequing account whose lines are almost all deposits, looks reversed. Savings, investments, loans and the rest
 * say nothing: mostly deposits (or mostly payments) is normal for them.
 */
export function typeSays(type: AccountType, amounts: readonly number[]): SignEvidence | undefined {
  const moving = amounts.filter(a => a !== 0)
  if (moving.length < DIRECTION_LINES) return undefined
  const raising = moving.filter(a => a > 0).length
  const share = raising / moving.length
  if (LIABILITIES.has(type) && share > LIABILITY_RAISING) return { kind: 'type', says: 'reversed', strength: 'weak', raising, lines: moving.length, liability: true }
  if (SPENDING.has(type) && share > ASSET_RAISING) return { kind: 'type', says: 'reversed', strength: 'weak', raising, lines: moving.length, liability: false }
  return undefined
}

/** The share of lines that are money out. */
export const outShare = (amounts: readonly number[]) => {
  const moving = amounts.filter(a => a !== 0)
  return moving.length === 0 ? 0 : moving.filter(a => a < 0).length / moving.length
}

/** What this source's profile says: mostly money out before and mostly money in now, or the other way round. */
export function profileSays(profile: { outShare: number, lines: number } | undefined, amounts: readonly number[]): SignEvidence | undefined {
  if (!profile || profile.lines < PROFILE_LINES || amounts.filter(a => a !== 0).length < DIRECTION_LINES) return undefined
  const now = outShare(amounts)
  const flipped = (profile.outShare >= PROFILE_MOSTLY && now <= 1 - PROFILE_MOSTLY) || (profile.outShare <= 1 - PROFILE_MOSTLY && now >= PROFILE_MOSTLY)
  return flipped ? { kind: 'profile', says: 'reversed', strength: 'weak', wasOut: profile.outShare, isOut: now } : undefined
}

/** Whether to ask: strong evidence for reversed, or weak evidence for reversed that no strong evidence contradicts. */
export function shouldAsk(evidence: readonly SignEvidence[]): boolean {
  const reversed = evidence.filter(e => e.says === 'reversed')
  if (reversed.some(e => e.strength === 'strong')) return true
  return reversed.length > 0 && !evidence.some(e => e.strength === 'strong' && e.says === 'asRead')
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`
const percent = (share: number) => `${Math.round(share * 100)}%`

/**
 * A piece of evidence that points at reversed amounts, in words for the dialog. `money` writes a balance as the user
 * reads it (for a card, what they owe); `date` a date.
 */
export function describeEvidence(e: SignEvidence, money: (minor: number) => string, date: (iso: string) => string): string {
  switch (e.kind) {
    case 'matching':
      return `Reversed, ${plural(e.reversed, 'line')} ${e.reversed === 1 ? 'matches a transaction' : 'match transactions'} you entered; as they are, ${e.asRead === 0 ? 'none do' : `only ${e.asRead.toLocaleString()} ${e.asRead === 1 ? 'does' : 'do'}`}.`
    case 'earlier':
      return `Reversed, ${plural(e.reversed, 'line')} ${e.reversed === 1 ? 'looks' : 'look'} like lines imported before; as they are, ${e.asRead === 0 ? 'none do' : `only ${e.asRead.toLocaleString()} ${e.asRead === 1 ? 'does' : 'do'}`}.`
    case 'balance':
      return `Reversed, they bring the account to the bank’s balance on ${date(e.asOf)} (${money(e.balance)}); as they are, they don’t.`
    case 'type':
      return e.liability
        ? `${e.raising.toLocaleString()} of its ${plural(e.lines, 'line')} would lower what you owe, and only ${(e.lines - e.raising).toLocaleString()} would add to it.`
        : `${e.raising.toLocaleString()} of its ${plural(e.lines, 'line')} would be money in, and only ${(e.lines - e.raising).toLocaleString()} money out.`
    case 'profile':
      return `Files from this source have been ${percent(e.wasOut)} money out; this one is ${percent(e.isOut)}.`
  }
}
