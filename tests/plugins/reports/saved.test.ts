// @vitest-environment node
// Saved reports, in the ledger: names, both kinds (a definition customised, and a spec of its own, which only the
// report designer will make), a definition's version moving on, a definition gone, sub-ledger deletes (and one rolled
// back), a read-only ledger, and conflicts. See docs/reporting-design.md, "Customising and saving reports".
import { describe, expect, it } from 'vitest'
import { REPORT_DEFINITIONS_POINT, FLOWS_SOURCE, type ReportSpec, type SavedReportInput } from '@tessera/reports-api'
import { SPENDING_BY_CATEGORY } from '../../../plugins/reports/src/privileged/definitions/spendingByCategory'
import { household, proprietor } from './examples'
import { setupReports, table } from './harness'

const YEAR_2026 = { period: { from: '2026-01-01', to: '2026-12-31' } }
const byCategory = (over: Partial<SavedReportInput> = {}): SavedReportInput => ({
  name: 'Groceries this year', basis: { kind: 'definition', definitionId: 'reports.spendingByCategory', options: { detail: 'all' } }, parameters: YEAR_2026, ...over
})
const failure = (work: Promise<unknown>) => work.then(() => { throw new Error('expected a failure') }, err => err as { code: string, field?: string, message: string })

describe('saving a report', () => {
  it('keeps a definition, its option values and its version, with the parameters, and runs it as saved', async () => {
    const env = await setupReports()
    await household(env)
    const saved = await env.reports.saveReport(byCategory({ view: { show: 'table' }, notes: '  For the tax return  ' }))
    expect(saved).toEqual({
      id: expect.any(String), name: 'Groceries this year', rev: 1, createdAt: '2027-01-15T17:00:00.000Z', updatedAt: '2027-01-15T17:00:00.000Z',
      basis: { kind: 'definition', definitionId: 'reports.spendingByCategory', definitionVersion: 1, options: { detail: 'all', refunds: false } },
      parameters: YEAR_2026, view: { show: 'table' }, notes: 'For the tax return'
    })
    expect(await env.reports.saved()).toEqual([saved])
    expect(env.changes.some(c => c.catalog)).toBe(true)
    const result = await env.reports.run({ savedId: saved.id })
    expect(result.title).toBe('Groceries this year')
    expect(result.subtitle).toBe('2026 · Whole ledger · CAD')
    expect(table(result).slice(0, 3).map(r => r[0])).toEqual(['Housing', '  Rent', '  Maintenance'])
    // What the heading changes now is over what was saved; the saved report is unchanged
    const march = await env.reports.run({ savedId: saved.id }, { period: { from: '2026-03-01', to: '2026-03-31' } }, { detail: 'top' })
    expect(march.rows.map(r => r.label)).toEqual(['Housing', 'Food', 'Transportation', 'Uncategorised', 'Total'])
    expect((await env.reports.open({ savedId: saved.id })).options).toEqual({ detail: 'all', refunds: false })
  })

  it('keeps a preset period a preset, so Last 12 months stays the last twelve', async () => {
    const env = await setupReports()
    const saved = await env.reports.saveReport(byCategory({ parameters: { period: { preset: 'last12Months' } } }))
    expect((await env.reports.run({ savedId: saved.id })).period).toEqual({ from: '2026-02-01', to: '2027-01-31' })
  })

  it('shows the new twelve months of a saved Last 12 months a month later (R4)', async () => {
    let today = '2027-01-15'
    const env = await setupReports({ today: () => today })
    const saved = await env.reports.saveReport(byCategory({ parameters: { period: { preset: 'last12Months' } } }))
    expect((await env.reports.run({ savedId: saved.id })).period).toEqual({ from: '2026-02-01', to: '2027-01-31' })
    today = '2027-02-16'
    expect((await env.reports.run({ savedId: saved.id })).period).toEqual({ from: '2026-03-01', to: '2027-02-28' })
    expect((await env.reports.saved())[0].parameters).toEqual({ period: { preset: 'last12Months' } })
  })

  it('keeps Show the top with the options, and refuses one that isn’t a number of rows (R4)', async () => {
    const env = await setupReports()
    await household(env)
    const byPayee = (options: Record<string, string>): SavedReportInput => ({ name: `Payees ${Object.values(options).join()}`, basis: { kind: 'definition', definitionId: 'reports.spendingByPayee', options }, parameters: YEAR_2026 })
    const saved = await env.reports.saveReport(byPayee({ '@top': '3' }))
    expect(saved.basis).toMatchObject({ definitionVersion: 2, options: { what: 'spending', '@top': '3' } })
    expect((await env.reports.run({ savedId: saved.id })).rows.filter(r => r.kind === 'member')).toHaveLength(3)
    for (const top of ['0', '501', 'many', '1.5']) {
      expect(await failure(env.reports.saveReport(byPayee({ '@top': top }))), top).toMatchObject({ code: 'INVALID', field: 'basis.options.@top' })
    }
  })

  it('keeps a spec of its own, checked against its source, and runs it', async () => {
    const env = await setupReports()
    await household(env)
    const spec: ReportSpec = {
      specVersion: 1, source: FLOWS_SOURCE,
      parameters: { period: { preset: 'thisYear' }, scope: { kind: 'ledger' } },
      query: { filters: [{ dimension: 'group', in: ['expense'] }], rows: { dimension: 'payee', sort: 'valueDesc', top: 2 }, columns: { dimension: 'month', grain: 'quarter' }, measures: [{ measure: 'amount' }] },
      presentation: { show: 'table', table: { totals: { row: true, column: true } } }
    }
    const saved = await env.reports.saveReport({ name: 'Top two by quarter', basis: { kind: 'spec', spec }, parameters: YEAR_2026 })
    expect(saved.basis).toEqual({ kind: 'spec', spec })
    expect(table(await env.reports.run({ savedId: saved.id })).map(r => r[0])).toEqual(['Riverside Properties', 'FreshCo', 'Other payees (146)', 'No payee', 'Total'])
    expect(await failure(env.reports.saveReport({ name: 'Broken', basis: { kind: 'spec', spec: { ...spec, query: { ...spec.query, rows: { dimension: 'weather' } } } }, parameters: {} })))
      .toMatchObject({ code: 'INVALID', field: 'basis.spec.query.rows.dimension' })
    expect(await failure(env.reports.saveReport({ name: 'Elsewhere', basis: { kind: 'spec', spec: { ...spec, source: 'garden.harvest' } }, parameters: {} })))
      .toMatchObject({ code: 'NO_SOURCE', field: 'basis.spec.source' })
    expect(await failure(env.reports.saveReport({ name: 'Newer', basis: { kind: 'spec', spec: { ...spec, specVersion: 9 } }, parameters: {} })))
      .toMatchObject({ code: 'INVALID', field: 'specVersion' })
  })

  it('checks names, options and parameters, naming the part at fault', async () => {
    const env = await setupReports()
    await env.reports.saveReport(byCategory())
    expect(await failure(env.reports.saveReport(byCategory({ name: '  GROCERIES THIS YEAR ' })))).toMatchObject({ code: 'DUPLICATE_NAME', field: 'name', message: 'There is already a saved report named “Groceries this year”.' })
    expect(await failure(env.reports.saveReport(byCategory({ name: ' ' })))).toMatchObject({ code: 'INVALID', field: 'name' })
    expect(await failure(env.reports.saveReport(byCategory({ name: 'x'.repeat(101) })))).toMatchObject({ code: 'INVALID', field: 'name' })
    expect(await failure(env.reports.saveReport(byCategory({ name: 'A', basis: { kind: 'definition', definitionId: 'reports.nope' } })))).toMatchObject({ code: 'NOT_FOUND', field: 'basis.definitionId' })
    expect(await failure(env.reports.saveReport(byCategory({ name: 'A', basis: { kind: 'definition', definitionId: 'reports.spendingByCategory', options: { detail: 'some' } } }))))
      .toMatchObject({ code: 'INVALID', field: 'basis.options.detail' })
    expect(await failure(env.reports.saveReport(byCategory({ name: 'A', parameters: { period: { from: '2026-05-01', to: '2026-04-01' } } })))).toMatchObject({ code: 'INVALID', field: 'parameters.period' })
    expect(await failure(env.reports.saveReport(byCategory({ name: 'A', parameters: { asOf: { at: 'today' } } })))).toMatchObject({ code: 'INVALID', field: 'parameters.asOf' })
    expect(await failure(env.reports.saveReport(byCategory({ name: 'A', view: { show: 'pie' as never } })))).toMatchObject({ code: 'INVALID', field: 'view' })
    expect(await failure(env.reports.saveReport(byCategory({ name: 'A', notes: 'x'.repeat(2001) })))).toMatchObject({ code: 'INVALID', field: 'notes' })
  })

  it('renames, duplicates and deletes, refusing a change made from an old revision', async () => {
    const env = await setupReports()
    const saved = await env.reports.saveReport(byCategory())
    const renamed = await env.reports.updateReport(saved.id, { name: 'Food 2026' }, { expectedRev: saved.rev })
    expect(renamed).toMatchObject({ name: 'Food 2026', rev: 2, basis: saved.basis, parameters: saved.parameters, createdAt: saved.createdAt })
    expect(await failure(env.reports.updateReport(saved.id, { name: 'Again' }, { expectedRev: saved.rev }))).toMatchObject({ code: 'CONFLICT' })
    const copy = await env.reports.duplicateReport(saved.id, 'Food 2026 (copy)')
    expect(copy).toMatchObject({ name: 'Food 2026 (copy)', basis: saved.basis, rev: 1 })
    expect(await failure(env.reports.duplicateReport(saved.id, 'food 2026'))).toMatchObject({ code: 'DUPLICATE_NAME' })
    const changed = await env.reports.updateReport(copy.id, { parameters: { period: { preset: 'lastYear' } }, basis: { kind: 'definition', definitionId: 'reports.spendingByCategory', options: { refunds: true } } })
    expect(changed.basis).toEqual({ kind: 'definition', definitionId: 'reports.spendingByCategory', definitionVersion: 1, options: { detail: 'top', refunds: true } })
    await env.reports.deleteReport(saved.id)
    expect((await env.reports.saved()).map(s => s.name)).toEqual(['Food 2026 (copy)'])
    expect(await failure(env.reports.deleteReport(saved.id))).toMatchObject({ code: 'NOT_FOUND' })
    expect(await failure(env.reports.run({ savedId: saved.id }))).toMatchObject({ code: 'NOT_FOUND' })
  })

  it('falls back to an option\'s default when the definition no longer offers the value saved, and says so', async () => {
    const env = await setupReports()
    const saved = await env.reports.saveReport(byCategory())
    // A new version of Spending by Category, without the detail option
    const next = { ...SPENDING_BY_CATEGORY, version: 2, options: SPENDING_BY_CATEGORY.options!.filter(o => o.key !== 'detail') }
    // The contribution replaced, as a plugin update would: the old one gone, the new one there
    env.contributions.get(SPENDING_BY_CATEGORY.id)!.dispose()
    env.extensions.contribute('reports', REPORT_DEFINITIONS_POINT, next.id, next)
    const opened = await env.reports.open({ savedId: saved.id })
    expect(opened.options).toEqual({ refunds: false })
    expect(opened.notes).toEqual(['A choice this report was saved with is no longer offered by “Spending by Category”, so it shows its default.'])
    expect((await env.reports.run({ savedId: saved.id })).notes).toContainEqual({ tone: 'info', text: opened.notes[0] })
  })

  it('keeps a saved report whose definition is gone, says which plugin it needs, and can still rename it', async () => {
    const env = await setupReports()
    const saved = await env.reports.saveReport(byCategory({ basis: { kind: 'definition', definitionId: 'reports.spendingByCategory' } }))
    const raw = env.session.database('reports').collection('reports.saved')
    await raw.updateOne({ id: saved.id }, { $set: { 'basis.definitionId': 'budget.vsActual' } })
    expect(await failure(env.reports.run({ savedId: saved.id }))).toMatchObject({ code: 'NOT_FOUND', message: 'That report isn’t offered: it needs the “budget” plugin, or it is no longer there.' })
    expect((await env.reports.saved()).map(s => s.name)).toEqual(['Groceries this year'])
    expect(await env.reports.updateReport(saved.id, { name: 'Budget, kept' })).toMatchObject({ name: 'Budget, kept', basis: { definitionId: 'budget.vsActual' } })
  })
})

describe('saved reports and sub-ledgers', () => {
  it('move a saved report over a deleted sub-ledger to its parent, the whole ledger at the top, and say so once committed', async () => {
    const env = await setupReports()
    const { personal } = await proprietor(env)
    const kids = await env.session.createSubLedger({ name: 'Kids', parentId: personal.id })
    const overKids = await env.reports.saveReport(byCategory({ name: 'Kids', parameters: { ...YEAR_2026, scope: { kind: 'subLedger', subLedgerId: kids.id } } }))
    const everyday = await env.reports.saveReport({
      name: 'Cash in Kids', basis: { kind: 'definition', definitionId: 'reports.cashFlow' },
      parameters: { scope: { kind: 'types', types: ['chequing', 'savings'], subLedgerId: kids.id } }
    })
    const overPersonal = await env.reports.saveReport(byCategory({ name: 'Personal', parameters: { scope: { kind: 'subLedger', subLedgerId: personal.id } } }))
    expect(await env.session.describeContents(kids.id)).toContain('2 saved reports')
    env.changes.length = 0
    await env.session.deleteSubLedger(kids.id)
    const now = new Map((await env.reports.saved()).map(s => [s.id, s.parameters.scope]))
    expect(now.get(overKids.id)).toEqual({ kind: 'subLedger', subLedgerId: personal.id })
    expect(now.get(everyday.id)).toEqual({ kind: 'types', types: ['chequing', 'savings'], subLedgerId: personal.id })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(env.changes.some(c => c.catalog)).toBe(true)
    await env.session.deleteSubLedger(personal.id)
    const top = new Map((await env.reports.saved()).map(s => [s.id, s.parameters.scope]))
    expect(top.get(overPersonal.id)).toEqual({ kind: 'ledger' })
    expect(top.get(everyday.id)).toEqual({ kind: 'types', types: ['chequing', 'savings'] })
  })

  it('leave them as they were when the delete rolls back', async () => {
    const env = await setupReports()
    const { business } = await proprietor(env)
    const saved = await env.reports.saveReport(byCategory({ parameters: { scope: { kind: 'subLedger', subLedgerId: business.id } } }))
    env.session.participate('zzz', { describe: async () => undefined, reparent: async () => { throw new Error('no') } })
    await expect(env.session.deleteSubLedger(business.id)).rejects.toThrow()
    expect((await env.reports.saved())[0].parameters.scope).toEqual({ kind: 'subLedger', subLedgerId: business.id })
    expect((await env.reports.saved())[0].rev).toBe(saved.rev)
  })
})

describe('saved reports and read-only ledgers', () => {
  it('are listed and run, but not changed, on a ledger open read-only', async () => {
    const env = await setupReports()
    await household(env)
    const saved = await env.reports.saveReport(byCategory())
    // An archive file opens read-only: it holds the ledger's saved reports too
    await env.session.open(await env.archiveFile())
    expect(env.session.current?.readOnly).toBe(true)
    expect((await env.reports.saved()).map(s => s.name)).toEqual([saved.name])
    expect((await env.reports.run({ savedId: saved.id })).rows.length).toBeGreaterThan(0)
    expect(await failure(env.reports.saveReport(byCategory({ name: 'Another' })))).toMatchObject({ code: 'READ_ONLY' })
    expect(await failure(env.reports.updateReport(saved.id, { name: 'Renamed' }))).toMatchObject({ code: 'READ_ONLY' })
    expect(await failure(env.reports.deleteReport(saved.id))).toMatchObject({ code: 'READ_ONLY' })
  })

  it('need a ledger', async () => {
    const env = await setupReports({ open: false })
    expect(await failure(env.reports.saved())).toMatchObject({ code: 'NO_LEDGER' })
    expect(await failure(env.reports.run({ definitionId: 'reports.netWorth' }))).toMatchObject({ code: 'NO_LEDGER' })
    expect(env.reports.definitions()).toHaveLength(7)
  })
})
