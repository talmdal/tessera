// Writing QIF at scale (docs/export-design.md, "Risks": the main process stalls on a very large export): twenty years
// of a busy household, 100,000 transactions in 20 accounts, as a whole-ledger QIF in Windows-1252, within a CPU-time
// budget. Measured on 2026-11-12: about 0.45 s in Node once warm (encoding 0.07 s of it), about 1.1 s of CPU here, where
// the code is cold. QIF writes nine or so lines per transaction where CSV writes one. The budget leaves room for slower
// machines.
import { describe, expect, it } from 'vitest'
import { resolveOptions, type ExportAccount, type ExportData } from '@tessera/export-api'
import { QIF_EXPORT, qifExport } from '../../../plugins/format-qif/src/privileged/export'

const BUDGET_MS = 3000

describe('writing QIF at scale', () => {
  it('writes 100,000 transactions in 20 accounts within the budget', () => {
    const accounts: ExportAccount[] = Array.from({ length: 20 }, (_, a) => ({
      id: `a${a}`, name: `Account ${a}`, type: 'chequing', currency: 'CAD', digits: 2, closed: false, location: [],
      opening: { date: '2006-01-01', balance: '0.00' }, closing: { date: '2026-12-31', balance: '0.00' },
      transactions: Array.from({ length: 5000 }, (_, i) => ({
        id: `t${a}-${i}`, date: '2020-01-15', amount: '-12.34', payee: i % 10 === 0 ? `A payee whose name runs well past thirty-two characters ${i}` : `Café ${i % 300}`,
        category: ['Food', 'Groceries'], status: 'cleared' as const, voided: false, balance: '100.00'
      }))
    }))
    const data: ExportData = { ledger: { name: 'Busy' }, exportedAt: '2026-11-12T12:00:00Z', range: { from: '2006-01-01', to: '2026-12-31' }, accounts, categories: [{ path: ['Food', 'Groceries'], kind: 'expense' }] }
    const start = process.cpuUsage()
    const { bytes } = qifExport.write(data, resolveOptions(QIF_EXPORT.options, {}), QIF_EXPORT.id) as { bytes: Uint8Array }
    const used = process.cpuUsage(start)
    const ms = (used.user + used.system) / 1000
    console.log(`[scale] QIF, windows-1252: 100,000 transactions, ${(bytes.length / 1e6).toFixed(1)} MB in ${ms.toFixed(0)} ms of CPU time`)
    expect(bytes.length).toBeGreaterThan(5_000_000)
    expect(ms).toBeLessThan(BUDGET_MS)
  })
})
