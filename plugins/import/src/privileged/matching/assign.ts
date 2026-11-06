// Which transactions a statement's lines may be, and which line gets which: the candidates (open, unlinked, of the
// same sign, inside the date window), every pair good enough to propose, and a one-to-one assignment, taken greedily
// from the best pair down. Deterministic: the same statement and register always pair the same way. Pure.
// See docs/import-manager-design.md, "Candidates" and "One line, one transaction".
import type { Transaction } from '@tessera/accounts-api'
import { WINDOW } from './tuning'
import { dayNumber, prepareLine, prepareTarget, rememberingSimilarity, scorePair, type AliasMap, type MatchLine, type MatchTarget } from './score'

/**
 * A transaction matching may propose: not void, not reconciled (it was on an earlier statement), not linked to a bank
 * line already, and not waiting on a proposal from an earlier import (`proposed`).
 */
export function isCandidate(t: Pick<Transaction, 'id' | 'voided' | 'status' | 'externalId'>, proposed: ReadonlySet<string>): boolean {
  return !t.voided && t.status !== 'reconciled' && t.externalId === undefined && !proposed.has(t.id)
}

/** The dates a statement's candidates can have: the earliest line less the cheque window, to the latest plus a few days. */
export function windowOf(lines: Pick<MatchLine, 'date' | 'userDate'>[]): { from: string, to: string } | undefined {
  if (lines.length === 0) return undefined
  const days = lines.flatMap(l => l.userDate !== undefined ? [dayNumber(l.date), dayNumber(l.userDate)] : [dayNumber(l.date)])
  const iso = (n: number) => new Date(n * 86_400_000).toISOString().slice(0, 10)
  return { from: iso(Math.min(...days) - WINDOW.chequeBefore), to: iso(Math.max(...days) + WINDOW.after) }
}

export interface Proposal {
  /** Index into the lines given. */
  line: number
  transactionId: string
  score: number
}

interface Pair {
  line: number
  target: number
  score: number
  days: number
}

/**
 * The proposals for `lines` among `targets` (already filtered with `isCandidate`, in register order): each line at most
 * once, each transaction at most once. Pairs are taken best first: by score, then the fewest days apart, then the
 * transaction entered first, then the line first in the statement. So two identical coffees pair with two identical
 * entries in order, rather than both with the first.
 */
export function assign(lines: MatchLine[], targets: MatchTarget[], currency: string, aliases: AliasMap = new Map()): Proposal[] {
  const prepared = lines.map(line => prepareLine(line, aliases))
  const similarity = rememberingSimilarity()
  // By date, keeping register order within a day, so each line looks only at the transactions in its window
  const byDate = targets.map((target, order) => {
    const prepared = prepareTarget(target)
    return { prepared, order, day: prepared.day }
  }).sort((a, b) => a.day - b.day || a.order - b.order)
  const days = byDate.map(t => t.day)
  const firstFrom = (day: number) => {
    let lo = 0
    let hi = days.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (days[mid] < day) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  const pairs: Pair[] = []
  prepared.forEach((line, i) => {
    const before = line.line.number !== undefined ? WINDOW.chequeBefore : WINDOW.before
    const from = Math.min(...line.days) - before
    const to = Math.max(...line.days) + WINDOW.after
    for (let j = firstFrom(from); j < byDate.length && byDate[j].day <= to; j++) {
      const score = scorePair(line, byDate[j].prepared, currency, similarity)
      if (score?.proposed) pairs.push({ line: i, target: byDate[j].order, score: score.score, days: Math.abs(score.days) })
    }
  })

  pairs.sort((a, b) => b.score - a.score || a.days - b.days || a.target - b.target || a.line - b.line)
  const usedLines = new Set<number>()
  const usedTargets = new Set<number>()
  const proposals: Proposal[] = []
  for (const pair of pairs) {
    if (usedLines.has(pair.line) || usedTargets.has(pair.target)) continue
    usedLines.add(pair.line)
    usedTargets.add(pair.target)
    proposals.push({ line: pair.line, transactionId: targets[pair.target].id, score: pair.score })
  }
  return proposals.sort((a, b) => a.line - b.line)
}
