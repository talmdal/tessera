// @vitest-environment node
// The matching presets: each is a consistent set of tolerances (tuningProblems), they form a ladder (Strict never
// proposes what Balanced wouldn't, Balanced never what Lenient wouldn't), and each keeps its promise on the corpus.
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { assign } from '../../../../plugins/import/src/privileged/matching/assign'
import { dateScore, prepareLine, prepareTarget, scorePair } from '../../../../plugins/import/src/privileged/matching/score'
import {
  BALANCED, LENIENT, MATCHING_PRESETS, MATCHING_PRESET_IDS, STRICT, tuningProblems, type MatchTuning, type MatchingPreset
} from '../../../../plugins/import/src/privileged/matching/tuning'
import { toMinor } from '../../../../plugins/import/src/privileged/convert'

const FIXTURES = path.resolve(__dirname, '../../../fixtures/import')

interface Case {
  about: string
  currency: string
  register: { id: string, date: string, amount: string, payee?: string, number?: string }[]
  statement: { date: string, userDate?: string, amount: string, payee?: string, number?: string, expect: string | null, from?: MatchingPreset }[]
}

const minor = (amount: string, currency: string) => {
  const converted = toMinor(amount, currency)
  if (!converted.ok) throw new Error(converted.problem)
  return converted.value
}

const load = (folder: string) => fs.readdirSync(path.join(FIXTURES, folder)).filter(f => f.endsWith('.json')).sort()
  .map(file => ({ file, corpus: JSON.parse(fs.readFileSync(path.join(FIXTURES, folder, file), 'utf8')) as Case }))

const targetsOf = (c: Case) => c.register.map(t => ({
  id: t.id, date: t.date, amount: minor(t.amount, c.currency), ...(t.payee && { payeeName: t.payee }), ...(t.number && { number: t.number })
}))
const linesOf = (c: Case) => c.statement.map(l => ({
  date: l.date, amount: minor(l.amount, c.currency),
  ...(l.userDate && { userDate: l.userDate }), ...(l.payee && { payee: l.payee }), ...(l.number && { number: l.number })
}))

/** Each line's proposal under a preset: the transaction and the score, or null. */
function run(c: Case, tuning: MatchTuning) {
  const got: ({ id: string, score: number } | null)[] = c.statement.map(() => null)
  for (const p of assign(linesOf(c), targetsOf(c), c.currency, new Map(), tuning)) got[p.line] = { id: p.transactionId, score: p.score }
  return got
}

/** Precision and recall over the corpus, and the wrong proposals with their scores. */
function measure(tuning: MatchTuning) {
  let right = 0, wrong = 0, missed = 0
  const mistakes: { where: string, score: number }[] = []
  for (const { file, corpus } of load('corpus')) {
    run(corpus, tuning).forEach((got, i) => {
      const expected = corpus.statement[i].expect
      if (got && got.id === expected) right++
      else {
        if (got) { wrong++; mistakes.push({ where: `${file} line ${i + 1}`, score: got.score }) }
        if (expected !== null) missed++
      }
    })
  }
  return { precision: right / Math.max(1, right + wrong), recall: right / Math.max(1, right + missed), mistakes }
}

describe('matching presets: each is consistent', () => {
  it.each(MATCHING_PRESET_IDS)('%s passes every consistency rule', id => {
    expect(tuningProblems(MATCHING_PRESETS[id])).toEqual([])
  })

  it('keeps Balanced as the set tuned against the corpus, the numbers the design documents', () => {
    expect(BALANCED.window).toEqual({ before: 14, after: 3, chequeBefore: 90 })
    expect(BALANCED.amountScores.far).toEqual({ ratio: 0.25, score: 0.45 })
    expect([BALANCED.proposeAt, BALANCED.payeesAgreeAt, BALANCED.matchedAt]).toEqual([0.65, 0.5, 0.85])
  })

  /** The date table of a copy, to break: the presets' own is read-only. */
  const rows = (t: MatchTuning) => t.dateScores as unknown as { from: number, to: number, score: number }[]
  const broken = (change: (t: MatchTuning) => void) => {
    const t = structuredClone(BALANCED) as MatchTuning
    change(t)
    return tuningProblems(t)
  }

  it('says what is wrong with a set that is not consistent', () => {
    expect(broken(t => { t.window.before = 21 })).toContain('day 15 is in the window but has no date score')
    expect(broken(t => { rows(t)[3].from = 7 })).toContain('day 7 is in two date rows')
    expect(broken(t => { t.window.after = 1 })).toContain('day -3 has a date score but is outside the window')
    expect(broken(t => { rows(t)[3].score = 0.8 })).toContain('day 8 scores better than day 7')
    expect(broken(t => { rows(t)[0].score = 0.95 })).toContain('the same day does not score 1')
    expect(broken(t => { t.window.chequeBefore = 10 })).toContain('the cheque window is shorter than the ordinary one')
    expect(broken(t => { t.amountScores.near.ratio = 0.3 })).toContain('the amount tiers do not widen from close to far')
    expect(broken(t => { t.amountScores.far.score = 0.75 })).toContain('the amount scores do not fall from exact to far')
    expect(broken(t => { t.weights.withPayee.payee = 0.3 })).toContain('the weights do not sum to 1')
    expect(broken(t => { t.proposeAt = 0.9 })).toContain('a proposal does not need less than a match')
  })
})

describe('matching presets: a ladder', () => {
  // A grid of bank lines against one transaction: dates from a week after to four months before, amounts from
  // exact to half again, payees the same, alike, different and missing, with and without a matching cheque number.
  const payees: [string | undefined, string | undefined][] = [
    ['COSTCO WHSE #0123', 'Costco'], ['AMZN MKTP CA*2K3L91', 'Amazon'], ['SOBEYS #773', 'The Keg'], [undefined, 'Hydro One'], ['CHQ 104', undefined]
  ]
  const pairs = function* () {
    for (let days = -7; days <= 130; days += days < 30 ? 1 : 5) {
      for (const ratio of [0, 0.004, 0.008, 0.015, 0.02, 0.03, 0.045, 0.06, 0.08, 0.1, 0.15, 0.25, 0.3, 0.35, 0.5]) {
        for (const [linePayee, name] of payees) {
          for (const cheque of [false, true]) {
            const date = new Date(Date.UTC(2026, 9, 1) + days * 86_400_000).toISOString().slice(0, 10)
            const line = prepareLine({ date, amount: -Math.round(10_000 * (1 + ratio)), ...(linePayee && { payee: linePayee }), ...(cheque && { number: '104' }) })
            const target = prepareTarget({ id: 't', date: '2026-10-01', amount: -10_000, ...(name && { payeeName: name }), ...(cheque && { number: '104' }) })
            yield { days, ratio, linePayee, cheque, line, target }
          }
        }
      }
    }
  }

  const ladder: [string, string, MatchTuning, MatchTuning][] = [['Strict', 'Balanced', STRICT, BALANCED], ['Balanced', 'Lenient', BALANCED, LENIENT]]

  it.each(ladder)('%s never scores a pair higher, or proposes one, that %s would not', (_stricter, _looser, stricter, looser) => {
    let compared = 0
    for (const { days, ratio, linePayee, cheque, line, target } of pairs()) {
      const tight = scorePair(line, target, 'CAD', undefined, stricter)
      const loose = scorePair(line, target, 'CAD', undefined, looser)
      const where = `${days} days, ${ratio * 100}% apart, ${linePayee ?? 'no payee'}${cheque ? ', cheque' : ''}`
      if (tight) {
        expect(loose, where).toBeDefined()
        expect(loose!.score, where).toBeGreaterThanOrEqual(tight.score)
        if (tight.proposed) expect(loose!.proposed, where).toBe(true)
        compared++
      }
    }
    expect(compared).toBeGreaterThan(1000)
  })

  it('widens the windows, and lowers the bar to propose, from Strict to Lenient', () => {
    const [strict, balanced, lenient] = [STRICT, BALANCED, LENIENT]
    for (const key of ['before', 'after', 'chequeBefore'] as const) {
      expect(strict.window[key]).toBeLessThanOrEqual(balanced.window[key])
      expect(balanced.window[key]).toBeLessThanOrEqual(lenient.window[key])
    }
    expect(strict.proposeAt).toBeGreaterThanOrEqual(balanced.proposeAt)
    expect(balanced.proposeAt).toBeGreaterThanOrEqual(lenient.proposeAt)
  })

  it('scores a matching cheque number at least the cheque score from the same day, in every preset', () => {
    for (const tuning of Object.values(MATCHING_PRESETS)) {
      expect(dateScore(0, true, tuning)).toBe(1)
      expect(dateScore(tuning.window.chequeBefore, true, tuning)).toBe(tuning.chequeDateScore)
      expect(dateScore(tuning.window.chequeBefore + 1, true, tuning)).toBeUndefined()
    }
  })
})

describe('matching presets: their promises on the corpus', () => {
  const balanced = measure(BALANCED)

  it('Balanced: every proposal right, and every pairing found', () => {
    expect(balanced.mistakes).toEqual([])
    expect(balanced.recall).toBe(1)
  })

  it('Strict: never less precise than Balanced, and still finds most pairings', () => {
    const strict = measure(STRICT)
    expect(strict.precision).toBeGreaterThanOrEqual(balanced.precision)
    expect(strict.recall).toBeGreaterThanOrEqual(0.85)
  })

  it('Lenient: finds everything Balanced does, and shows any wrong proposal as a possible match, never as matched', () => {
    const lenient = measure(LENIENT)
    expect(lenient.recall).toBeGreaterThanOrEqual(balanced.recall)
    expect(lenient.precision).toBeGreaterThanOrEqual(0.9)
    for (const { where, score } of lenient.mistakes) expect(score, where).toBeLessThan(LENIENT.matchedAt)
  })
})

describe('matching presets: where they part ways (tests/fixtures/import/presets)', () => {
  const rank: Record<MatchingPreset, number> = { strict: 0, balanced: 1, lenient: 2 }

  for (const { file, corpus } of load('presets')) {
    it.each(MATCHING_PRESET_IDS)(`${file}: %s proposes exactly the lines at or above it, each rightly`, id => {
      const got = run(corpus, MATCHING_PRESETS[id])
      const summary = corpus.statement.map((line, i) => ({
        line: `${line.date} ${line.payee} ${line.amount}`,
        proposed: got[i]?.id ?? null,
        expected: rank[line.from!] <= rank[id] ? line.expect : null
      }))
      expect(summary.map(s => s.proposed)).toEqual(summary.map(s => s.expected))
    })
  }
})
