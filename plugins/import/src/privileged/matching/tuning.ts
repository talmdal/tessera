// Every number matching uses: the date window, the score tables, the weights and the thresholds. Nothing else in the
// matcher holds a number. They depend on one another (the date table must cover the window, the thresholds assume the
// weights), so they are never changed one at a time: a *preset* is a whole, consistent set, and the user chooses a
// preset (the `import` setting `matching`, on the Options dialog's Import page). Balanced is the set tuned against the
// fixture corpus (tests/fixtures/import/corpus); Strict and Lenient are the same shape, stricter and looser at every
// step, so they form a ladder: whatever Strict proposes, Balanced does, and whatever Balanced proposes, Lenient does.
// `tuningProblems` states what "consistent" means, and tests hold every preset to it. See docs/import-manager-design.md,
// "Matching tolerances".

/** The numbers one preset gives matching. */
export interface MatchTuning {
  /** How far a transaction's date may be from the bank line's, in days: the line minus the transaction. */
  window: {
    /** The bank posts after the purchase: a transaction up to this many days before the line. */
    before: number
    /** The user dated it later than the bank: up to this many days after. */
    after: number
    /** A cheque whose number matches clears weeks after it is written: up to this many days before. */
    chequeBefore: number
  }
  /** `D`, by days between the line and the transaction (line minus transaction). Covers exactly `-after` to `before`. */
  dateScores: readonly { from: number, to: number, score: number }[]
  /** `D` for a cheque whose number matches, from the same day to `window.chequeBefore` (or the table's, if higher). */
  chequeDateScore: number
  /** `A`, by the difference between the amounts, in the order they are tried. Further apart is not a candidate. */
  amountScores: {
    exact: 1
    /** Within `ratio` of the line, or within `majorUnits` major units (dollars): rounding, exchange rates. */
    close: { ratio: number, majorUnits: number, score: number }
    /** A fuel pre-authorisation, a slip. */
    near: { ratio: number, score: number }
    /** A tip. */
    far: { ratio: number, score: number }
  }
  /** How the three scores combine, with and without a payee on both sides. Each sums to 1. */
  weights: {
    withPayee: { amount: number, date: number, payee: number }
    withoutPayee: { amount: number, date: number }
  }
  /** Added (up to 1) when the line's cheque number equals the transaction's number. */
  chequeBonus: number
  /** A pair is proposed from this score, if the amount is exact or the payees agree. */
  proposeAt: number
  /** How much the payees must agree to propose a pair whose amounts differ. */
  payeesAgreeAt: number
  /** From this score a proposal is shown as *Matched* (info); below it as *Possible match* (warning). */
  matchedAt: number
  /** A payee scoring below this is emphasised in a row's second line, as a difference. */
  payeeDiffersBelow: number
}

/** The presets, strictest first. */
export const MATCHING_PRESET_IDS = ['strict', 'balanced', 'lenient'] as const
export type MatchingPreset = typeof MATCHING_PRESET_IDS[number]

/** The set tuned against the corpus, and the default. */
export const BALANCED: MatchTuning = {
  window: { before: 14, after: 3, chequeBefore: 90 },
  dateScores: [
    { from: 0, to: 0, score: 1 },
    { from: 1, to: 3, score: 0.9 },
    { from: 4, to: 7, score: 0.7 },
    { from: 8, to: 14, score: 0.4 },
    { from: -3, to: -1, score: 0.7 }
  ],
  chequeDateScore: 0.6,
  amountScores: {
    exact: 1,
    close: { ratio: 0.01, majorUnits: 1, score: 0.85 },
    near: { ratio: 0.05, score: 0.7 },
    far: { ratio: 0.25, score: 0.45 }
  },
  weights: {
    withPayee: { amount: 0.45, date: 0.3, payee: 0.25 },
    withoutPayee: { amount: 0.6, date: 0.4 }
  },
  chequeBonus: 0.15,
  proposeAt: 0.65,
  payeesAgreeAt: 0.5,
  matchedAt: 0.85,
  payeeDiffersBelow: 0.5
}

/**
 * Fewer, surer proposals: the bank posts within a week, amounts differ by rounding or a few percent (no tips), and a
 * pair needs a higher score and closer payees. More lines are added as new, for the user to match by hand.
 */
export const STRICT: MatchTuning = {
  window: { before: 7, after: 2, chequeBefore: 60 },
  dateScores: [
    { from: 0, to: 0, score: 1 },
    { from: 1, to: 3, score: 0.9 },
    { from: 4, to: 7, score: 0.6 },
    { from: -2, to: -1, score: 0.7 }
  ],
  chequeDateScore: 0.6,
  amountScores: {
    exact: 1,
    close: { ratio: 0.01, majorUnits: 1, score: 0.85 },
    near: { ratio: 0.03, score: 0.6 },
    far: { ratio: 0.1, score: 0.35 }
  },
  weights: BALANCED.weights,
  chequeBonus: 0.15,
  proposeAt: 0.75,
  payeesAgreeAt: 0.6,
  matchedAt: 0.9,
  payeeDiffersBelow: 0.5
}

/**
 * More proposals, for banks that post late and bills with large tips or estimates: three weeks back, bigger amount
 * differences, and a lower score to propose. More of them are *Possible match*, for the user to accept or change.
 */
export const LENIENT: MatchTuning = {
  window: { before: 21, after: 5, chequeBefore: 120 },
  dateScores: [
    { from: 0, to: 0, score: 1 },
    { from: 1, to: 3, score: 0.9 },
    { from: 4, to: 7, score: 0.75 },
    { from: 8, to: 14, score: 0.5 },
    { from: 15, to: 21, score: 0.3 },
    { from: -3, to: -1, score: 0.7 },
    { from: -5, to: -4, score: 0.5 }
  ],
  chequeDateScore: 0.6,
  amountScores: {
    exact: 1,
    close: { ratio: 0.02, majorUnits: 2, score: 0.85 },
    near: { ratio: 0.08, score: 0.7 },
    far: { ratio: 0.35, score: 0.5 }
  },
  weights: BALANCED.weights,
  chequeBonus: 0.15,
  proposeAt: 0.6,
  payeesAgreeAt: 0.45,
  matchedAt: 0.85,
  payeeDiffersBelow: 0.5
}

export const MATCHING_PRESETS: Readonly<Record<MatchingPreset, MatchTuning>> = { strict: STRICT, balanced: BALANCED, lenient: LENIENT }

export const isMatchingPreset = (value: unknown): value is MatchingPreset => (MATCHING_PRESET_IDS as readonly unknown[]).includes(value)

/** The Change Match dialog's wider search: this many days either side of the line. Not a tolerance: a search range. */
export const WIDE_DAYS = 60

/** At most this many candidates in the Change Match dialog. */
export const MAX_CANDIDATES = 200

const inUnit = (n: number) => n > 0 && n <= 1
const sumsToOne = (weights: Record<string, number>) => Math.abs(Object.values(weights).reduce((a, b) => a + b, 0) - 1) < 1e-9

/**
 * What makes a set of numbers inconsistent, in words, or nothing when it is consistent. Every preset is checked
 * by a test; a new preset must pass too.
 */
export function tuningProblems(t: MatchTuning): string[] {
  const problems: string[] = []
  const { before, after, chequeBefore } = t.window
  if (![before, after, chequeBefore].every(n => Number.isInteger(n) && n >= 0)) problems.push('the window is not whole days')
  if (chequeBefore < before) problems.push('the cheque window is shorter than the ordinary one')

  // The date table covers every day of the window exactly once, and no day outside it
  const covered = new Map<number, number>()
  for (const { from, to, score } of t.dateScores) {
    if (!Number.isInteger(from) || !Number.isInteger(to) || from > to) problems.push(`the date row ${from} to ${to} is not a range of days`)
    if (!inUnit(score)) problems.push(`the date row ${from} to ${to} has a score outside 0 to 1`)
    for (let d = from; d <= to; d++) {
      if (covered.has(d)) problems.push(`day ${d} is in two date rows`)
      covered.set(d, score)
    }
  }
  for (let d = -after; d <= before; d++) if (!covered.has(d)) problems.push(`day ${d} is in the window but has no date score`)
  for (const d of covered.keys()) if (d < -after || d > before) problems.push(`day ${d} has a date score but is outside the window`)

  // The same day scores best, and a date further away never scores better than a nearer one
  if (covered.get(0) !== 1) problems.push('the same day does not score 1')
  for (let d = 1; d <= before; d++) if ((covered.get(d) ?? 0) > (covered.get(d - 1) ?? 0)) problems.push(`day ${d} scores better than day ${d - 1}`)
  for (let d = -1; d >= -after; d--) if ((covered.get(d) ?? 0) > (covered.get(d + 1) ?? 0)) problems.push(`day ${d} scores better than day ${d + 1}`)
  if (!inUnit(t.chequeDateScore)) problems.push('the cheque date score is outside 0 to 1')

  // Amount tiers widen as their scores fall
  const { exact, close, near, far } = t.amountScores
  if (exact !== 1) problems.push('an exact amount does not score 1')
  if (!(close.ratio > 0 && close.ratio < near.ratio && near.ratio < far.ratio && far.ratio < 1)) problems.push('the amount tiers do not widen from close to far')
  if (!(exact > close.score && close.score > near.score && near.score > far.score && far.score > 0)) problems.push('the amount scores do not fall from exact to far')
  if (!(close.majorUnits >= 0)) problems.push('the close amount allowance is negative')

  if (!sumsToOne(t.weights.withPayee) || !sumsToOne(t.weights.withoutPayee)) problems.push('the weights do not sum to 1')
  if (![...Object.values(t.weights.withPayee), ...Object.values(t.weights.withoutPayee)].every(inUnit)) problems.push('a weight is outside 0 to 1')

  if (!(t.chequeBonus >= 0 && t.chequeBonus < 1)) problems.push('the cheque bonus is outside 0 to 1')
  if (!(inUnit(t.proposeAt) && t.proposeAt < t.matchedAt && t.matchedAt <= 1)) problems.push('a proposal does not need less than a match')
  if (!inUnit(t.payeesAgreeAt) || !inUnit(t.payeeDiffersBelow)) problems.push('a payee threshold is outside 0 to 1')
  return problems
}
