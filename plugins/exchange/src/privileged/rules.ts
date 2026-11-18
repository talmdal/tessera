// Payee renaming rules: turning `SQ *THE DAILY GRIND 4471 OTTAWA ON` into `The Daily Grind`, and optionally
// picking the category too. Pure functions over the rules a book holds.
//
// Rules are applied in the pipeline, after reading and before matching — which is the point: last month's
// `THE DAILY GRIND` and this month's `SQ *THE DAILY GRIND 4471` both become the same payee, so they match each
// other instead of accumulating near-duplicates in the register.
import type { NewPayeeRule, PayeeRule } from '@tessera/exchange-api'

export interface RuleTarget {
  payee?: string
  memo?: string
  accountId: string
}

export interface RuleOutcome {
  payee?: string
  categoryId?: string
  /** The rule that fired, and what it fired on. */
  applied?: { id: string, from: string }
}

/** A regex rule's pattern, or undefined when it does not compile. A bad pattern never throws into an import. */
function patternOf(rule: PayeeRule): RegExp | undefined {
  try {
    return new RegExp(rule.match.value, rule.match.ignoreCase === false ? '' : 'i')
  } catch { return undefined }
}

function matches(rule: PayeeRule, text: string): { hit: boolean, groups?: RegExpMatchArray } {
  const ignoreCase = rule.match.ignoreCase !== false
  const subject = ignoreCase ? text.toLowerCase() : text
  const value = ignoreCase ? rule.match.value.toLowerCase() : rule.match.value

  switch (rule.match.kind) {
    case 'equals': return { hit: subject.trim() === value.trim() }
    case 'startsWith': return { hit: subject.startsWith(value) }
    case 'contains': return { hit: subject.includes(value) }
    case 'regex': {
      const pattern = patternOf(rule)
      if (pattern === undefined) return { hit: false }
      const found = text.match(pattern)
      return found === null ? { hit: false } : { hit: true, groups: found }
    }
    default: return { hit: false }
  }
}

/** `$1`…`$9` replaced by the regex's groups, `$&` by the whole match. */
function substitute(replacement: string, groups: RegExpMatchArray | undefined): string {
  if (groups === undefined) return replacement
  return replacement.replace(/\$(\d|&)/g, (whole, token: string) =>
    token === '&' ? groups[0] : groups[Number(token)] ?? whole)
}

/**
 * The first rule that fires wins, in `order`. Each is tried against the payee and then the memo, because a bank
 * that leaves the payee blank usually puts the merchant in the memo.
 */
export function applyPayeeRules(rules: readonly PayeeRule[], target: RuleTarget): RuleOutcome {
  const applicable = [...rules]
    .filter(rule => rule.enabled !== false && (rule.accountId === undefined || rule.accountId === target.accountId))
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))

  for (const rule of applicable) {
    for (const field of [target.payee, target.memo]) {
      if (field === undefined || field.trim() === '') continue
      const { hit, groups } = matches(rule, field)
      if (!hit) continue
      const payee = substitute(rule.payee, groups).trim()
      if (payee === '') continue
      return {
        payee,
        ...(rule.categoryId !== undefined && { categoryId: rule.categoryId }),
        applied: { id: rule.id, from: field }
      }
    }
  }
  return {}
}

/**
 * What a row's payee actually becomes, from the three things that can decide it, in order: the user's own
 * rename of this row, then the book's rules, then what the file said.
 *
 * Resolved **once** per row and then carried, because two things need the same answer and they must not
 * disagree: matching compares on it, and the draft is written with it. A renamed payee is the whole reason
 * rules exist — last month's `THE DAILY GRIND` and this month's `SQ *THE DAILY GRIND 4471` have to land on the
 * same name *before* the matcher looks at them, or the matcher sees two different merchants and the user gets
 * a duplicate beside the row they typed themselves.
 */
export function resolveRename(
  incoming: Pick<RuleTarget, 'payee' | 'memo'>,
  accountId: string,
  options: {
    rules: readonly PayeeRule[]
    applyRules: boolean
    userPayee?: string
    userCategoryId?: string
  }
): RuleOutcome {
  const typed = options.userPayee?.trim()
  // The user's own choices for this row win over every rule: they were looking at the row when they made them.
  const chosen = options.userCategoryId === undefined ? {} : { categoryId: options.userCategoryId }

  if (typed !== undefined && typed !== '') return { payee: typed, ...chosen }

  const fromRules = options.applyRules
    ? applyPayeeRules(options.rules, {
      accountId,
      ...(incoming.payee !== undefined && { payee: incoming.payee }),
      ...(incoming.memo !== undefined && { memo: incoming.memo })
    })
    : {}
  // A category the user picked still wins, even when the payee came from a rule.
  return { ...fromRules, ...chosen }
}

/** The payee a row ends up with: the rename, else what the file wrote, else nothing. */
export const payeeOf = (rename: RuleOutcome, incoming: { payee?: string }): string | undefined => {
  const chosen = rename.payee ?? incoming.payee
  return chosen === undefined || chosen.trim() === '' ? undefined : chosen.trim()
}

/**
 * The rule “always rename this” writes, from what the file said and what the user typed instead.
 *
 * The match is the longest leading run of the original that is not a digit — which is almost always the
 * merchant's name with the store number, date or terminal id stripped — so next month's
 * `SQ *THE DAILY GRIND 4472` fires the same rule as this month's `4471`.
 */
export function learnedRuleFrom(original: string, payee: string, options: { accountId?: string, order?: number } = {}): NewPayeeRule | undefined {
  const source = original.trim()
  const wanted = payee.trim()
  if (source === '' || wanted === '') return undefined

  const stem = (source.match(/^[^0-9]*/)?.[0] ?? '').trim().replace(/[\s*#:,\-/]+$/, '').trim()
  // Too short a stem would rename half the register; fall back to the whole string, matched exactly
  const useStem = stem.length >= 4 && stem.length < source.length

  return {
    order: options.order ?? 0,
    match: { kind: useStem ? 'startsWith' : 'equals', value: useStem ? stem : source, ignoreCase: true },
    payee: wanted,
    ...(options.accountId !== undefined && { accountId: options.accountId }),
    enabled: true,
    learned: true
  }
}
