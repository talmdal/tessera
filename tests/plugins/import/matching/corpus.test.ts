// @vitest-environment node
// The matcher against the fixture corpus (tests/fixtures/import/corpus): registers as users type them, statements as
// banks send them, and the pairing a person would make. It reports precision (how many proposals are right) and
// recall (how many right pairings are proposed), and fails if either falls below the figures here. A regression in
// the matcher or its tuning shows here first.
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { assign } from '../../../../plugins/import/src/privileged/matching/assign'
import { toMinor } from '../../../../plugins/import/src/privileged/convert'

const CORPUS = path.resolve(__dirname, '../../../fixtures/import/corpus')
const PRECISION = 0.95
const RECALL = 0.95

interface Case {
  about: string
  currency: string
  register: { id: string, date: string, amount: string, payee?: string, number?: string }[]
  statement: { date: string, userDate?: string, amount: string, payee?: string, number?: string, expect: string | null }[]
}

const minor = (amount: string, currency: string) => {
  const converted = toMinor(amount, currency)
  if (!converted.ok) throw new Error(converted.problem)
  return converted.value
}

const cases = fs.readdirSync(CORPUS).filter(f => f.endsWith('.json')).sort()
  .map(file => ({ file, corpus: JSON.parse(fs.readFileSync(path.join(CORPUS, file), 'utf8')) as Case }))

/** The matcher's pairing for a case, line by line: the transaction's id, or null for a line added as new. */
function run({ corpus }: typeof cases[number]): (string | null)[] {
  const targets = corpus.register.map(t => ({ id: t.id, date: t.date, amount: minor(t.amount, corpus.currency), ...(t.payee && { payeeName: t.payee }), ...(t.number && { number: t.number }) }))
  const lines = corpus.statement.map(l => ({
    date: l.date, amount: minor(l.amount, corpus.currency),
    ...(l.userDate && { userDate: l.userDate }), ...(l.payee && { payee: l.payee }), ...(l.number && { number: l.number })
  }))
  const got: (string | null)[] = lines.map(() => null)
  for (const proposal of assign(lines, targets, corpus.currency)) got[proposal.line] = proposal.transactionId
  return got
}

describe('the matching corpus', () => {
  it('has cases', () => expect(cases.length).toBeGreaterThanOrEqual(12))

  it(`proposes with precision ≥ ${PRECISION} and recall ≥ ${RECALL}`, () => {
    let right = 0
    let wrong = 0
    let missed = 0
    const mistakes: string[] = []
    for (const c of cases) {
      const got = run(c)
      c.corpus.statement.forEach((line, i) => {
        const expected = line.expect
        const proposed = got[i]
        const where = `${c.file}, line ${i + 1} (${line.date} ${line.payee ?? '(no payee)'} ${line.amount})`
        if (proposed !== null && proposed === expected) right++
        else {
          if (proposed !== null) { wrong++; mistakes.push(`${where}: proposed ${proposed}, expected ${expected ?? 'none'}`) }
          if (expected !== null) { missed++; if (proposed === null) mistakes.push(`${where}: expected ${expected}, proposed none`) }
        }
      })
    }
    const precision = right / Math.max(1, right + wrong)
    const recall = right / Math.max(1, right + missed)
    console.log(`[corpus] ${cases.length} cases: precision ${precision.toFixed(3)}, recall ${recall.toFixed(3)} (${right} right, ${wrong} wrong, ${missed} missed)`)
    for (const mistake of mistakes) console.log(`[corpus]   ${mistake}`)
    expect(precision, mistakes.join('\n')).toBeGreaterThanOrEqual(PRECISION)
    expect(recall, mistakes.join('\n')).toBeGreaterThanOrEqual(RECALL)
  })

  for (const c of cases) {
    it(`${c.file}: ${c.corpus.about}`, () => {
      // Every file is well formed, so a typo doesn't quietly make a case say nothing
      const ids = new Set(c.corpus.register.map(t => t.id))
      expect(ids.size).toBe(c.corpus.register.length)
      for (const line of c.corpus.statement) if (line.expect !== null) expect(ids.has(line.expect), `unknown id ${line.expect}`).toBe(true)
      const expected = c.corpus.statement.map(l => l.expect).filter(e => e !== null)
      expect(new Set(expected).size, 'a transaction expected for two lines').toBe(expected.length)
    })
  }
})
