// @vitest-environment node
// Matching at scale: 2,000 statement lines against 10,000 transactions, as a busy account's year might be. The design
// asks for under 500 ms. What is measured is the CPU time matching takes (it is synchronous), not the wall clock, which
// other test files running at the same time would stretch; and the bound is looser, for slower machines. The time is
// printed for the record.
import { expect, it } from 'vitest'
import { assign } from '../../../../plugins/import/src/privileged/matching/assign'
import { addDays, type MatchLine, type MatchTarget } from '../../../../plugins/import/src/privileged/matching/score'

const PAYEES = ['Costco', 'Loblaws', 'Tim Hortons', 'Shell', 'Hydro One', 'Bell Canada', 'Amazon', 'The Keg', 'Metro', 'Shoppers Drug Mart']

it('matches 2,000 lines against 10,000 transactions quickly', () => {
  let seed = 42
  const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31
  const targets: MatchTarget[] = Array.from({ length: 10_000 }, (_, i) => ({
    id: `t${String(i).padStart(5, '0')}`, date: addDays('2026-01-01', Math.floor(i / 27)),
    amount: -Math.round(500 + random() * 20_000), payeeName: PAYEES[Math.floor(random() * PAYEES.length)]
  }))
  // Every fifth transaction is on the statement, a day or two later, in the bank's words
  const lines: MatchLine[] = targets.filter((_, i) => i % 5 === 0).map(t => ({
    date: addDays(t.date, Math.floor(random() * 3)), amount: t.amount, payee: `POS PURCHASE ${t.payeeName!.toUpperCase()} #${Math.floor(random() * 9000) + 1000}`
  }))
  expect(lines).toHaveLength(2000)

  const started = process.cpuUsage()
  const proposals = assign(lines, targets, 'CAD')
  const used = process.cpuUsage(started)
  const took = (used.user + used.system) / 1000
  console.log(`[scale] ${lines.length} lines against ${targets.length} transactions: ${proposals.length} proposals in ${took.toFixed(0)} ms of CPU time`)
  expect(proposals.length).toBeGreaterThan(1900)
  expect(took).toBeLessThan(2000)
})
