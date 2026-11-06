// Every number matching uses: the date window, the score tables, the weights and the thresholds. Nothing else in the
// matcher holds a number, so tuning it against the fixture corpus (tests/fixtures/import/corpus) means changing this
// file only. They move to a settings page once there is a settings framework. See docs/import-manager-design.md,
// "Matching".

/** How far a transaction's date may be from the bank line's, in days: the line minus the transaction. */
export const WINDOW = {
  /** The bank posts after the purchase: a transaction up to this many days before the line. */
  before: 14,
  /** The user dated it later than the bank: up to this many days after. */
  after: 3,
  /** A cheque whose number matches clears weeks after it is written. */
  chequeBefore: 90
} as const

/** `D`, by days between the line and the transaction (line minus transaction), in the order they are tried. */
export const DATE_SCORES: readonly { from: number, to: number, score: number }[] = [
  { from: 0, to: 0, score: 1 },
  { from: 1, to: 3, score: 0.9 },
  { from: 4, to: 7, score: 0.7 },
  { from: 8, to: 14, score: 0.4 },
  { from: -3, to: -1, score: 0.7 }
]

/** `D` for a cheque whose number matches, from 4 days to `WINDOW.chequeBefore` (or the table's, if higher). */
export const CHEQUE_DATE_SCORE = 0.6

/** `A`, by the difference between the amounts, in the order they are tried. */
export const AMOUNT_SCORES = {
  exact: 1,
  /** Within 1% of the line, or within one major unit (a dollar): rounding, exchange rates. */
  close: { ratio: 0.01, majorUnits: 1, score: 0.85 },
  /** Within 5%: a fuel pre-authorisation, a slip. */
  near: { ratio: 0.05, score: 0.7 },
  /** Within 25%: a tip. Further apart is not a candidate. */
  far: { ratio: 0.25, score: 0.45 }
} as const

/** How the three scores combine, with and without a payee on both sides. */
export const WEIGHTS = {
  withPayee: { amount: 0.45, date: 0.3, payee: 0.25 },
  withoutPayee: { amount: 0.6, date: 0.4 }
} as const

/** Added (up to 1) when the line's cheque number equals the transaction's number. */
export const CHEQUE_BONUS = 0.15

/** A pair is proposed from this score, if the amount is exact or the payees agree. */
export const PROPOSE_AT = 0.65

/** How much the payees must agree to propose a pair whose amounts differ. */
export const PAYEES_AGREE_AT = 0.5

/** From this score a proposal is shown as *Matched* (info); below it as *Possible match* (warning). */
export const MATCHED_AT = 0.85

/** A payee scoring below this is emphasised in a row's second line, as a difference. */
export const PAYEE_DIFFERS_BELOW = 0.5

/** The Change Match dialog's wider search: this many days either side of the line. */
export const WIDE_DAYS = 60

/** At most this many candidates in the Change Match dialog. */
export const MAX_CANDIDATES = 200
