// Writing CSV at scale (docs/export-design.md, "Risks": the main process stalls on a very large export): twenty years of
// a busy household, 100,000 transactions in 20 accounts, written in both encodings within a CPU-time budget. Measured
// on 2026-11-12 at about 0.25 s (UTF-8) and 0.15 s of encoding (Windows-1252); the budget leaves room for slower machines.
import { describe, expect, it } from 'vitest'
import { resolveOptions, type ExportAccount, type ExportData } from '@tessera/export-api'
import { CSV_EXPORT, csvExport } from '../../../plugins/format-csv/src/privileged/export'

const BUDGET_MS = 3000

function busyLedger(): ExportData {
  const accounts: ExportAccount[] = Array.from({ length: 20 }, (_, a) => ({
    id: `a${a}`, name: `Account ${a}`, type: 'chequing', currency: 'CAD', digits: 2, closed: false, location: [],
    opening: { date: '2006-01-01', balance: '0.00' }, closing: { date: '2026-12-31', balance: '0.00' },
    transactions: Array.from({ length: 5000 }, (_, i) => ({
      id: `t${a}-${i}`, date: '2020-01-01', amount: '-12.34', payee: `Café ${i % 300}`, category: ['Food', 'Groceries'],
      ...(i % 7 === 0 && { memo: 'memo, with a comma' }), status: 'cleared' as const, voided: false, balance: '100.00'
    }))
  }))
  return { ledger: { name: 'Busy' }, exportedAt: '2026-11-12T12:00:00Z', range: { from: '2006-01-01', to: '2026-12-31' }, accounts, categories: [] }
}

/** CPU time `work` takes, in milliseconds: unlike the clock, not stretched by other tests running alongside. */
function cpuMs(work: () => void): number {
  const start = process.cpuUsage()
  work()
  const used = process.cpuUsage(start)
  return (used.user + used.system) / 1000
}

describe('writing CSV at scale', () => {
  it.each(['utf-8', 'windows-1252'])('writes 100,000 transactions in %s within the budget', encoding => {
    const data = busyLedger()
    let size = 0
    const ms = cpuMs(() => { size = (csvExport.write(data, resolveOptions(CSV_EXPORT.options, { encoding }), CSV_EXPORT.id) as { bytes: Uint8Array }).bytes.length })
    console.log(`[scale] CSV, ${encoding}: 100,000 transactions, ${(size / 1e6).toFixed(1)} MB in ${ms.toFixed(0)} ms of CPU time`)
    expect(size).toBeGreaterThan(6_000_000)
    expect(ms).toBeLessThan(BUDGET_MS)
  })
})
