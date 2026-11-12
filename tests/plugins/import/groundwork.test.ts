// @vitest-environment node
// The groundwork for more formats (docs/import-formats-design.md, phase F0), with the ledger, accounts and import
// plugins activated together and fixture formats:
// - a format can ask the user, and the time it has to read a file stops while they answer;
// - Cancel Import in a format's dialog stops the import;
// - a statement can say its bank ids can't be trusted;
// - a bank id seen before that names another transaction is no longer taken as a duplicate;
// - the categories a file gives are never used until the user says so for its source.
import { describe, expect, it } from 'vitest'
import { categoryLabel, type AccountInput } from '@tessera/accounts-api'
import { displayDate } from '@tessera/ledger-api'
import {
  IMPORT_DIALOGS, IMPORT_FORMATS_POINT, ImportError,
  type CategoriesDialogInput, type ImportFile, type ParseContext, type ParseResult, type ParsedStatement, type StatementLine
} from '@tessera/import-api'
import { createPluginContext } from '../../../core/plugins/PluginContext'
import { sample, setupImport, type ImportEnv } from './harness'

const chequing = (over: Partial<AccountInput> = {}): AccountInput =>
  ({ name: 'Chequing', type: 'chequing', subLedgerId: null, currency: 'CAD', openingDate: '2026-01-01', openingBalance: 100000, accountNumber: '5555', ...over })

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** Files read from memory: every path exists, and a fixture format decides what each one holds. */
const reader = { size: async () => 10, read: async () => new Uint8Array(10) }

type Parse = (file: ImportFile, context: ParseContext) => Promise<ParseResult | undefined>

/** A format for '.fix' files, whose parse the test gives; its own dialog is 'fixfmt.dialog.ask'. */
function fixtureFormat(env: ImportEnv, parse: Parse) {
  const fmt = createPluginContext('fixfmt', env.runtime).context
  fmt.services.provide('fixfmt', 'fixfmt.format', { parse })
  fmt.extensions.contribute('fixfmt', IMPORT_FORMATS_POINT, 'fixfmt.fix', { id: 'fixfmt.fix', label: 'Fixture', extensions: ['fix'], service: 'fixfmt.format' })
}

/** A statement for the account numbered 5555 (found by its number, so no Account dialog), from the source 'fix:5555'. */
const statement = (lines: StatementLine[], over: Partial<ParsedStatement> = {}): ParsedStatement =>
  ({ account: { key: 'fix:5555', label: 'Fixture •••• 5555', accountNumber: '5555' }, currency: 'CAD', lines, ...over })

describe('a format asking the user', () => {
  it('gets as long as the user needs: only its own work counts against the time to read a file', async () => {
    const env = await setupImport({ reader, parseTimeoutMs: 100 })
    const mine = await env.accounts.createAccount(chequing())
    fixtureFormat(env, async (_file, context) => {
      const answer = await context.prompt<{ ok: boolean }>('fixfmt.dialog.ask', { question: 'Columns?' }, { title: 'Fixture Columns' })
      return answer?.ok ? { statements: [statement([{ date: '2026-10-05', amount: '-1.00', payee: 'SHOP', externalId: 'A' }])] } : undefined
    })
    env.answer('fixfmt.dialog.ask', async () => { await sleep(400); return { ok: true } })     // four times the limit
    const report = await env.manager.importFiles(['/x/october.fix'])
    expect(report!.results[0]).toMatchObject({ outcome: 'imported', counts: { added: 1 } })
    expect(env.dialogs('fixfmt.dialog.ask')).toEqual([{ id: 'fixfmt.dialog.ask', input: { question: 'Columns?' }, options: { title: 'Fixture Columns' } }])
    expect(await env.transactions(mine.id)).toHaveLength(1)
  })

  it('still has its limit for its own work, before and after a dialog together', async () => {
    const env = await setupImport({ reader, parseTimeoutMs: 100 })
    fixtureFormat(env, async (_file, context) => {
      await sleep(70)
      await context.prompt('fixfmt.dialog.ask', {})
      await sleep(70)                                                            // 140 of its own: too long
      return { statements: [statement([{ date: '2026-10-05', amount: '-1.00' }])] }
    })
    env.answer('fixfmt.dialog.ask', async () => { await sleep(50); return {} })
    const report = await env.manager.importFiles(['/x/october.fix'])
    expect(report!.results[0]).toMatchObject({ outcome: 'failed', error: { code: 'UNREADABLE', message: 'october.fix took too long to read (more than 0.1 seconds).' } })
  })

  it('opens nothing once its time is up', async () => {
    const env = await setupImport({ reader, parseTimeoutMs: 30 })
    let asked: (answer: unknown) => void = () => {}
    const afterwards = new Promise(resolve => { asked = resolve })
    fixtureFormat(env, async (_file, context) => {
      await sleep(80)
      asked(await context.prompt('fixfmt.dialog.ask', {}))
      return undefined
    })
    const report = await env.manager.importFiles(['/x/october.fix'])
    expect(report!.results[0]).toMatchObject({ outcome: 'failed', error: { code: 'UNREADABLE' } })
    expect(await afterwards).toBeUndefined()
    expect(env.dialogs('fixfmt.dialog.ask')).toEqual([])
  })

  it('skips the file when it resolves undefined (Skip This File), and stops the import when it throws CANCELLED (Cancel Import)', async () => {
    const env = await setupImport({ reader })
    const mine = await env.accounts.createAccount(chequing())
    const read: string[] = []
    fixtureFormat(env, async (file, context) => {
      read.push(file.name)
      const answer = await context.prompt<'import' | 'skip'>('fixfmt.dialog.ask', { file: file.name })
      if (answer === 'skip') return undefined
      if (answer === undefined) throw new ImportError('CANCELLED', 'The import was cancelled.')
      return { statements: [statement([{ date: '2026-10-05', amount: '-1.00', payee: file.name, externalId: file.name }])] }
    })
    env.answer('fixfmt.dialog.ask', 'skip', 'import', undefined)
    const report = await env.manager.importFiles(['/x/a.fix', '/x/b.fix', '/x/c.fix', '/x/d.fix'])
    expect(report!.results.map(r => [r.source, r.outcome])).toEqual([['a.fix', 'skipped'], ['b.fix', 'imported'], ['c.fix', 'cancelled']])
    expect(read).toEqual(['a.fix', 'b.fix', 'c.fix'])                           // d.fix never read
    expect(await env.transactions(mine.id)).toHaveLength(1)
  })
})

describe('bank ids that collide', () => {
  /** Two files from a conversion tool that numbers every file's lines 1, 2, 3, 4. */
  const october: StatementLine[] = [
    { date: '2026-10-01', amount: '-1200.00', payee: 'LANDLORD', externalId: '1' },
    { date: '2026-10-03', amount: '-57.50', payee: 'THE KEG #12', externalId: '2' },
    { date: '2026-10-05', amount: '-84.12', payee: 'COSTCO WHSE #0123', externalId: '3' },
    { date: '2026-10-09', amount: '3000.00', payee: 'NORTHERN LIGHTS PAYROLL', externalId: '4' }
  ]
  const november: StatementLine[] = [
    { date: '2026-11-01', amount: '-1200.00', payee: 'LANDLORD', externalId: '1' },
    { date: '2026-11-04', amount: '-45.00', payee: 'HYDRO ONE', externalId: '2' },
    { date: '2026-11-06', amount: '-91.30', payee: 'COSTCO WHSE #0123', externalId: '3' },
    { date: '2026-11-09', amount: '3000.00', payee: 'NORTHERN LIGHTS PAYROLL', externalId: '4' }
  ]

  async function converted(files: Record<string, StatementLine[]>, over: Partial<ParsedStatement> = {}) {
    const env = await setupImport({ reader })
    const mine = await env.accounts.createAccount(chequing())
    fixtureFormat(env, async file => ({ statements: [statement(files[file.name], over)] }))
    return { env, mine }
  }

  it('are no longer duplicates: every line of the second file is added, known by its content, with one warning', async () => {
    const { env, mine } = await converted({ 'october.fix': october, 'november.fix': november })
    await env.manager.importFiles(['/x/october.fix'])
    const report = await env.manager.importFiles(['/x/november.fix'])
    const [result] = report!.results
    expect(result).toMatchObject({ outcome: 'imported', counts: { lines: 4, added: 4, duplicates: 0, idConflicts: 4 } })
    // All four of its known ids collide, so none of its ids is trusted
    expect(result.warnings).toEqual(['4 of the bank’s ids in this statement had been used before for other transactions, so none of its ids are trusted: its lines are recognised by their content instead.'])
    const all = await env.transactions(mine.id)
    expect(all).toHaveLength(8)
    expect(all.filter(t => t.date >= '2026-11-01').every(t => t.externalId?.startsWith('fp:'))).toBe(true)
    // Importing it again adds nothing: its lines are known by their content now
    const again = await env.manager.importFiles(['/x/november.fix'])
    expect(again!.results[0]).toMatchObject({ counts: { added: 0, duplicates: 4 } })
    expect(await env.transactions(mine.id)).toHaveLength(8)
  })

  it('are named one by one when only a few of a statement’s ids collide, and the rest stay duplicates', async () => {
    // The bank sends October again, with its last line's id reused for a new transaction
    const resent = [...october.slice(0, 3), { date: '2026-11-02', amount: '-45.00', payee: 'HYDRO ONE', externalId: '4' }]
    const { env, mine } = await converted({ 'october.fix': october, 'resent.fix': resent })
    await env.manager.importFiles(['/x/october.fix'])
    const report = await env.manager.importFiles(['/x/resent.fix'])
    const [result] = report!.results
    expect(result).toMatchObject({ counts: { added: 1, duplicates: 3, idConflicts: 1 } })
    expect(result.warnings).toEqual([
      `Line 4: the bank’s id “4” was used before for a different transaction (${displayDate('2026-10-09')}, NORTHERN LIGHTS PAYROLL, 3,000.00), so this line is recognised by its content instead.`
    ])
    expect((await env.transactions(mine.id)).map(t => t.date)).toContain('2026-11-02')
  })

  it('still recognise a line the bank sends again with a corrected amount or date', async () => {
    const corrected = [{ ...october[2], amount: '-84.21' }, { ...october[3], date: '2026-10-10' }]
    const { env, mine } = await converted({ 'october.fix': october, 'corrected.fix': corrected })
    await env.manager.importFiles(['/x/october.fix'])
    const report = await env.manager.importFiles(['/x/corrected.fix'])
    expect(report!.results[0]).toMatchObject({ counts: { added: 0, duplicates: 2 } })
    expect(report!.results[0].counts).not.toHaveProperty('idConflicts')
    expect(await env.transactions(mine.id)).toHaveLength(4)
  })

  it("are caught in the Cedar Credit Union samples, whose bank restarts its ids every month (samples/statements)", async () => {
    const env = await setupImport()
    env.answer(IMPORT_DIALOGS.account, { kind: 'create', remember: true })
    await env.manager.importFiles([sample('cedar-savings-2026-09.ofx')])
    const report = await env.manager.importFiles([sample('cedar-savings-2026-10.ofx')])
    const [result] = report!.results
    expect(result).toMatchObject({ outcome: 'imported', accountName: 'Cedar Credit Union 3301', counts: { lines: 5, added: 5, duplicates: 0, idConflicts: 5 } })
    expect(result.warnings).toHaveLength(1)
    const account = await env.account('Cedar Credit Union 3301')
    expect(await env.transactions(account.id)).toHaveLength(10)
    const [{ balances }] = (await env.accounts.chart()).accounts.filter(s => s.account.id === account.id)
    expect(balances.current).toBe(344995)                                        // the bank's balance on Oct 31
  })

  it('can be ruled out by the statement itself: ids it says are unstable are never used', async () => {
    const { env, mine } = await converted({ 'october.fix': october, 'november.fix': november }, { stableIds: false })
    await env.manager.importFiles(['/x/october.fix'])
    const report = await env.manager.importFiles(['/x/november.fix'])
    expect(report!.results[0]).toMatchObject({ counts: { added: 4, duplicates: 0 }, warnings: [] })
    expect(report!.results[0].counts).not.toHaveProperty('idConflicts')
    const all = await env.transactions(mine.id)
    expect(all).toHaveLength(8)
    expect(all.every(t => t.externalId?.startsWith('fp:'))).toBe(true)
  })
})

describe('categories a file gives', () => {
  const lines: StatementLine[] = [
    { date: '2026-10-05', amount: '-84.12', payee: 'COSTCO', category: 'Food:Groceries', externalId: 'C1' },
    { date: '2026-10-06', amount: '-40.00', payee: 'SHELL', category: 'Transportation:Fuel', externalId: 'C2' },
    { date: '2026-10-07', amount: '-12.00', payee: 'NEW SHOP', category: 'Shopping', externalId: 'C3' },
    { date: '2026-10-08', amount: '-5.00', payee: 'COFFEE', externalId: 'C4' }
  ]

  /** A ledger where Costco is usually Housing : Maintenance (in another account, so nothing is matched to it). */
  async function ledger() {
    const env = await setupImport({ reader })
    const mine = await env.accounts.createAccount(chequing())
    const other = await env.accounts.createAccount(chequing({ name: 'Other', accountNumber: '9999' }))
    const categories = await env.accounts.categories.list()
    const id = (label: string) => categories.find(c => categoryLabel(categories, c.id) === label)!.id
    await env.accounts.transactions(other.id).create({ date: '2026-09-01', amount: -2000, payee: 'Costco', categoryId: id('Housing : Maintenance') })
    const files: Record<string, ParsedStatement> = {}
    fixtureFormat(env, async file => ({ statements: [files[file.name]] }))
    const labels = async () => {
      const payees = await env.accounts.payees.search('', 1000)
      return (await env.transactions(mine.id)).map(t => [payees.find(p => p.id === t.payeeId)?.name, categoryLabel(categories, t.categoryId)])
    }
    return { env, mine, files, labels }
  }

  it('are not used, and nothing is asked, when the file gives none the ledger has', async () => {
    const { env, files, labels } = await ledger()
    files['a.fix'] = statement([lines[2], lines[3]])
    const report = await env.manager.importFiles(['/x/a.fix'])
    expect(env.dialogs(IMPORT_DIALOGS.categories)).toEqual([])
    expect(report!.results[0]).not.toHaveProperty('categories')
    expect(await labels()).toEqual([['New Shop', undefined], ['Coffee', undefined]])
  })

  it('are used only once the user says so, asked once for the source, with nothing decided for them', async () => {
    const { env, files, labels } = await ledger()
    files['october.fix'] = statement(lines)
    env.answer(IMPORT_DIALOGS.categories, { source: 'file', remember: true })
    const report = await env.manager.importFiles(['/x/october.fix'])
    const [asked] = env.dialogs(IMPORT_DIALOGS.categories)
    expect(asked.input as CategoriesDialogInput).toEqual({
      fileName: 'october.fix', sourceLabel: 'Fixture •••• 5555', accountName: 'Chequing', offered: 2, differing: 1,
      examples: [{ payee: 'Costco', file: 'Food : Groceries', usual: 'Housing : Maintenance' }, { payee: 'Shell', file: 'Transportation : Fuel' }]
    })
    expect(await labels()).toEqual([['Costco', 'Food : Groceries'], ['Shell', 'Transportation : Fuel'], ['New Shop', undefined], ['Coffee', undefined]])
    expect(report!.results[0].categories).toEqual({
      offered: 2, differing: 1, source: 'file', decidedBy: 'asked', remembered: true, key: 'fix:5555', sourceLabel: 'Fixture •••• 5555',
      examples: asked.input.examples
    })
    // The next file from the source isn't asked about
    files['november.fix'] = statement([{ ...lines[0], date: '2026-11-05', externalId: 'N1' }])
    const next = await env.manager.importFiles(['/x/november.fix'])
    expect(env.dialogs(IMPORT_DIALOGS.categories)).toHaveLength(1)
    expect(next!.results[0].categories).toMatchObject({ source: 'file', decidedBy: 'remembered', remembered: true })
    expect((await labels())[4]).toEqual(['Costco', 'Food : Groceries'])
  })

  it("keep the payee's usual category when the user says so, and ask again next time when not to remember", async () => {
    const { env, files, labels } = await ledger()
    files['october.fix'] = statement(lines.slice(0, 2))
    env.answer(IMPORT_DIALOGS.categories, { source: 'payee', remember: false })
    await env.manager.importFiles(['/x/october.fix'])
    expect(await labels()).toEqual([['Costco', 'Housing : Maintenance'], ['Shell', undefined]])
    files['november.fix'] = statement([{ ...lines[1], date: '2026-11-06', externalId: 'N2' }])
    env.answer(IMPORT_DIALOGS.categories, { source: 'file', remember: false })
    await env.manager.importFiles(['/x/november.fix'])
    expect(env.dialogs(IMPORT_DIALOGS.categories)).toHaveLength(2)
  })

  it('ask each source for itself', async () => {
    const { env, files } = await ledger()
    files['a.fix'] = statement(lines.slice(0, 1))
    files['b.fix'] = statement([{ ...lines[1], externalId: 'B1' }], { account: { key: 'fix:other', label: 'Another source', accountNumber: '5555' } })
    env.answer(IMPORT_DIALOGS.categories, { source: 'file', remember: true }, { source: 'payee', remember: true })
    await env.manager.importFiles(['/x/a.fix', '/x/b.fix'])
    expect(env.dialogs(IMPORT_DIALOGS.categories).map(d => d.input.sourceLabel)).toEqual(['Fixture •••• 5555', 'Another source'])
  })

  it('stop the import at Cancel Import: nothing of the statement is added, and later files are left', async () => {
    const { env, mine, files } = await ledger()
    files['a.fix'] = statement(lines)
    files['b.fix'] = statement([{ ...lines[3], externalId: 'B1' }])
    env.answer(IMPORT_DIALOGS.categories, undefined)
    const report = await env.manager.importFiles(['/x/a.fix', '/x/b.fix'])
    expect(report!.results.map(r => [r.source, r.outcome])).toEqual([['a.fix', 'cancelled']])
    expect(await env.transactions(mine.id)).toEqual([])
  })

  it('are not used by an import that may not ask, which says how many were left unused', async () => {
    const { env, labels } = await ledger()
    const report = await env.manager.importStatements([statement(lines.slice(0, 2))], { label: 'Bank connection' }, { interactive: false })
    expect(env.dialogs(IMPORT_DIALOGS.categories)).toEqual([])
    expect(report.results[0].categories).toMatchObject({ offered: 2, source: 'payee', decidedBy: 'default', remembered: false })
    expect(await labels()).toEqual([['Costco', 'Housing : Maintenance'], ['Shell', undefined]])
  })

  it("can be changed from the summary's Change…, for the next import, or forgotten so the next one asks", async () => {
    const { env, files, labels } = await ledger()
    files['october.fix'] = statement(lines.slice(0, 1))
    env.answer(IMPORT_DIALOGS.categories, { source: 'file', remember: true }, { source: 'payee', remember: true })
    env.answer(IMPORT_DIALOGS.summary, { changeCategories: 0 })
    await env.manager.importFiles(['/x/october.fix'])
    const [, changing] = env.dialogs(IMPORT_DIALOGS.categories)
    expect(changing.input).toMatchObject({ current: 'file', sourceLabel: 'Fixture •••• 5555', offered: 1 })
    expect((await labels())[0]).toEqual(['Costco', 'Food : Groceries'])          // what was imported stays as it was
    // The next import follows the new answer, without asking
    files['november.fix'] = statement([{ ...lines[0], date: '2026-11-05', externalId: 'N1' }])
    env.answer(IMPORT_DIALOGS.summary, { changeCategories: 0 })
    env.answer(IMPORT_DIALOGS.categories, { source: 'payee', remember: false })    // …and then forget it
    const next = await env.manager.importFiles(['/x/november.fix'])
    expect(next!.results[0].categories).toMatchObject({ source: 'payee', decidedBy: 'remembered' })
    expect((await labels())[1]).toEqual(['Costco', 'Food : Groceries'])           // Costco's usual category is now the file's
    files['december.fix'] = statement([{ ...lines[0], date: '2026-12-05', externalId: 'D1' }])
    env.answer(IMPORT_DIALOGS.categories, { source: 'payee', remember: false })
    await env.manager.importFiles(['/x/december.fix'])
    expect(env.dialogs(IMPORT_DIALOGS.categories)).toHaveLength(4)                // asked again, as it was forgotten
  })
})
