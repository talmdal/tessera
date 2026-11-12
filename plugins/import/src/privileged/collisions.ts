// Bank ids that collide: an id seen before that now names a different transaction. Some sources, most often files
// made by conversion tools, number their lines 1, 2, 3… in every file, so the next file's line 1 isn't last file's
// line 1. Taking it as a duplicate would drop a real transaction without a word, the worst thing an import can do.
// A bank that sends a line again keeps its date within a few days, and keeps its amount or its payee (a corrected
// amount keeps the payee; a renamed line keeps the amount). So a date more than 3 days away is another transaction on
// its own: next month's rent, with the same payee and amount, is not this month's sent again. So is a line whose
// amount and payee both changed. It is then known by its content instead. The rule leans towards importing: a line
// wrongly kept is seen in the register; one wrongly dropped is lost. Pure.
// See docs/import-formats-design.md, "Bank ids that collide".
import type { BankLine } from '@tessera/import-api'
import { isFingerprint, type ConvertedLine } from './convert'
import { payeeSimilarity } from './matching/payees'

/** Dates more than this many days apart disagree. */
export const COLLISION_DAYS = 3
/** Payees less alike than this disagree. */
export const COLLISION_PAYEE = 0.5

/**
 * What an import id named before: the bank's version of the line (kept in `import.lines`), or, when that record has
 * gone (an archive prunes some), the transaction carrying the id, whose payee is the user's, so it isn't compared.
 */
export type Prior =
  | { kind: 'line', bank: Pick<BankLine, 'date' | 'amount' | 'payee'> }
  | { kind: 'transaction', date: string, amount: number }

export type Field = 'date' | 'amount' | 'payee'

const dayNumber = (date: string) => {
  const [y, m, d] = date.split('-').map(Number)
  return Date.UTC(y, m - 1, d) / 86_400_000
}

/** The fields on which a line and what its id named before disagree. */
export function disagreements(line: Pick<BankLine, 'date' | 'amount' | 'payee'>, prior: Prior): Field[] {
  const before = prior.kind === 'line' ? prior.bank : { date: prior.date, amount: prior.amount, payee: undefined }
  const fields: Field[] = []
  if (line.amount !== before.amount) fields.push('amount')
  if (Math.abs(dayNumber(line.date) - dayNumber(before.date)) > COLLISION_DAYS) fields.push('date')
  if (line.payee !== undefined && before.payee !== undefined && payeeSimilarity(line.payee, before.payee) < COLLISION_PAYEE) fields.push('payee')
  return fields
}

export interface Collision {
  line: ConvertedLine
  prior: Prior
}

/** Whether fields that disagree mean a different transaction: dates too far apart, or both amount and payee changed. */
export const isCollision = (fields: readonly Field[]) =>
  fields.includes('date') || (fields.includes('amount') && fields.includes('payee'))

/**
 * The lines whose bank id is already known (`known`: import id → what it named) but names a different transaction
 * (`isCollision`). Fingerprints are never checked: a fingerprint is the line's content, so the same fingerprint is
 * the same line.
 */
export function findCollisions(lines: readonly ConvertedLine[], known: ReadonlyMap<string, Prior>): Collision[] {
  const found: Collision[] = []
  for (const line of lines) {
    if (isFingerprint(line.importId)) continue
    const prior = known.get(line.importId)
    if (prior && isCollision(disagreements(line.bank, prior))) found.push({ line, prior })
  }
  return found
}

/**
 * Whether so many of a statement's known bank ids collide that none of its ids can be trusted: more than half of
 * them. Then every line is known by its content, with one warning rather than one per line.
 */
export const distrustsStatement = (collisions: number, knownBankIds: number) => collisions > 0 && collisions * 2 > knownBankIds
