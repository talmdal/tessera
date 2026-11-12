// @vitest-environment node
// The sign cross-check (docs/import-formats-design.md, phase F3), with the ledger, accounts, import and OFX plugins
// activated together, on the sample statements: a statement whose amounts look the wrong way round for its account is
// asked about (Amounts Reversed?), reversing it imports it right, and the answer is kept, by the format when it can
// keep it, by the import manager otherwise.
import { describe, expect, it } from 'vitest'
import type { LedgerSession } from '@tessera/ledger-api'
import { LEDGER_SESSION_SERVICE } from '@tessera/ledger-api'
import type { AccountInput } from '@tessera/accounts-api'
import {
  IMPORT_DIALOGS, IMPORT_FORMATS_POINT,
  type FormatCorrection, type FormatMemory, type ImportFile, type ParseContext, type ParsedStatement, type SignsDialogInput, type StatementLine
} from '@tessera/import-api'
import { createPluginContext } from '../../../core/plugins/PluginContext'
import { reversedStatement } from '../../../plugins/import/src/privileged/run'
import { collectionsOf } from '../../../plugins/import/src/privileged/store'
import { describe as describeResult, describeReversed } from '../../../plugins/import/src/renderer/SummaryDialog'
import { sample, setupImport, type ImportEnv } from './harness'

const CARD = sample('northwind-visa-2026-10.qfx')
const CARD_REVERSED = sample('northwind-visa-2026-10-reversed.qfx')
const OCTOBER = sample('maple-trust-chequing-2026-10.ofx')
const NOVEMBER_REVERSED = sample('maple-trust-chequing-2026-11-reversed.ofx')

const balanceOf = async (env: ImportEnv, accountId: string) => (await env.accounts.chart()).accounts.find(s => s.account.id === accountId)!.balances.current
const memory = (env: ImportEnv) => collectionsOf(env.runtime.services.get<LedgerSession>(LEDGER_SESSION_SERVICE).database('import')).memory
const signRecords = async (env: ImportEnv) => (await memory(env).find({ formatId: 'import' })).filter(m => m.key.startsWith('signs:'))

describe('a statement the right way round', () => {
  it('is imported without a question: the card’s own statement into a new card account', async () => {
    const env = await setupImport()
    env.answer(IMPORT_DIALOGS.account, { kind: 'create', remember: true })
    const report = await env.manager.importFiles([CARD])
    expect(env.dialogs(IMPORT_DIALOGS.signs)).toEqual([])
    expect(report!.results[0]).toMatchObject({ outcome: 'imported', counts: { added: 8 } })
    expect(report!.results[0]).not.toHaveProperty('reversed')
  })

  it('is imported without a question when mostly deposits is normal: a savings account', async () => {
    const env = await setupImport()
    env.answer(IMPORT_DIALOGS.account, { kind: 'create', remember: true })
    await env.manager.importFiles([sample('cedar-savings-2026-09.ofx'), sample('cedar-savings-2026-10.ofx')])
    expect(env.dialogs(IMPORT_DIALOGS.signs)).toEqual([])
  })
})

describe('a statement the wrong way round', () => {
  it('is asked about on the account’s type alone, on its first import into a new card account', async () => {
    const env = await setupImport()
    env.answer(IMPORT_DIALOGS.account, { kind: 'create', remember: true })
    env.answer(IMPORT_DIALOGS.signs, { reverse: true, remember: true })
    const report = await env.manager.importFiles([CARD_REVERSED])
    const [asked] = env.dialogs(IMPORT_DIALOGS.signs)
    expect(asked.input as SignsDialogInput).toEqual({
      fileName: 'northwind-visa-2026-10-reversed.qfx', accountName: 'Northwind Card Services 3456', accountTypeLabel: 'Credit card', currency: 'CAD',
      columns: { decrease: 'Charge', increase: 'Payment' },
      reasons: ['6 of its 8 lines would lower what you owe, and only 2 would add to it.'],
      examples: [{ date: '2026-10-14', payee: 'PAYMENT - THANK YOU', amount: -54000 }, { date: '2026-10-03', payee: 'AIR CANADA 0142325781', amount: 12844 }],
      rememberLabel: 'Remember for files like this one going into “Northwind Card Services 3456”'
    })
    // Reversed: charges are charges, and the card, made from this statement, opens owing what it owed
    const card = await env.account('Northwind Card Services 3456')
    expect(card.openingBalance).toBe(-54000)
    expect(await balanceOf(env, card.id)).toBe(-46477)
    expect(report!.results[0]).toMatchObject({ counts: { added: 8 }, reversed: { decidedBy: 'asked', remembered: true } })
    expect(describeReversed(report!.results[0].reversed!)).toBe('Amounts reversed, as you chose; files like this one will be too.')
  })

  it('is reversed the next time without a question: the import manager keeps the correction, as OFX can’t', async () => {
    const env = await setupImport()
    env.answer(IMPORT_DIALOGS.account, { kind: 'create', remember: true })
    env.answer(IMPORT_DIALOGS.signs, { reverse: true, remember: true })
    await env.manager.importFiles([CARD_REVERSED])
    const again = await env.manager.importFiles([CARD_REVERSED])
    expect(env.dialogs(IMPORT_DIALOGS.signs)).toHaveLength(1)
    expect(again!.results[0]).toMatchObject({ counts: { added: 0, duplicates: 8 }, reversed: { decidedBy: 'remembered', remembered: true } })
    expect((await signRecords(env)).map(r => r.value)).toEqual([expect.objectContaining({ reverse: true, lines: 8 })])
  })

  it('is asked about on matching too, into a card with charges typed in: reversed, they match', async () => {
    const env = await setupImport()
    const card = await env.accounts.createAccount({ name: 'Visa', type: 'creditCard', subLedgerId: null, currency: 'CAD', openingDate: '2026-09-30', openingBalance: -54000 } as AccountInput)
    const typed = env.accounts.transactions(card.id)
    for (const [date, amount, payee] of [['2026-10-01', -12844, 'Air Canada'], ['2026-10-05', -3680, 'Netflix'], ['2026-10-10', -21467, 'Canadian Tire']] as const) {
      await typed.create({ date, amount, payee })
    }
    env.answer(IMPORT_DIALOGS.account, { kind: 'account', accountId: card.id, remember: true })
    env.answer(IMPORT_DIALOGS.signs, { reverse: true, remember: true })
    const report = await env.manager.importFiles([CARD_REVERSED])
    expect(env.dialogs(IMPORT_DIALOGS.signs)[0].input.reasons).toEqual([
      'Reversed, 3 lines match transactions you entered; as they are, none do.',
      '6 of its 8 lines would lower what you owe, and only 2 would add to it.'
    ])
    expect(report!.results[0].counts).toMatchObject({ added: 5, matched: 3 })
    expect(await balanceOf(env, card.id)).toBe(-46477)                         // the bank's: owing 464.77
  })

  it('is asked about on the bank’s balance and the source’s history, a month later: November reversed after October', async () => {
    const env = await setupImport()
    env.answer(IMPORT_DIALOGS.account, { kind: 'create', remember: true })
    await env.manager.importFiles([OCTOBER])
    env.answer(IMPORT_DIALOGS.signs, { reverse: true, remember: true })
    const report = await env.manager.importFiles([NOVEMBER_REVERSED])
    expect(env.dialogs(IMPORT_DIALOGS.signs)[0].input.reasons).toEqual([
      expect.stringMatching(/^Reversed, they bring the account to the bank’s balance on .* \(6,241\.74\); as they are, they don’t\.$/),
      'Files from this source have been 82% money out; this one is 20%.'
    ])
    expect(report!.results[0].counts).toMatchObject({ added: 5, duplicates: 5 })
    const account = await env.account('Maple Trust Bank 5678')
    expect(await balanceOf(env, account.id)).toBe(624174)
  })

  it('is imported as it is when the user says so, and the answer shapes what the source is known to be like', async () => {
    const env = await setupImport()
    env.answer(IMPORT_DIALOGS.account, { kind: 'create', remember: true })
    env.answer(IMPORT_DIALOGS.signs, { reverse: false, remember: true })
    const report = await env.manager.importFiles([CARD_REVERSED])
    expect(report!.results[0]).not.toHaveProperty('reversed')
    const card = await env.account('Northwind Card Services 3456')
    expect(await balanceOf(env, card.id)).toBe(46477)                          // as the file says
    expect((await signRecords(env)).map(r => r.value)).toEqual([expect.objectContaining({ reverse: false, outShare: 0.25, lines: 8 })])
  })

  it('is reversed this time only when Remember is unticked: the next such file is asked about again', async () => {
    const env = await setupImport()
    env.answer(IMPORT_DIALOGS.account, { kind: 'create', remember: true })
    env.answer(IMPORT_DIALOGS.signs, { reverse: true, remember: false })
    const report = await env.manager.importFiles([CARD_REVERSED])
    expect(report!.results[0].reversed).toEqual({ decidedBy: 'asked', remembered: false })
    expect(describeReversed(report!.results[0].reversed!)).toBe('Amounts reversed, this time.')
    expect((await signRecords(env)).map(r => r.value)).toEqual([expect.objectContaining({ reverse: false })])
  })

  it('stops the import at Cancel Import: nothing of it is added, and later files are left', async () => {
    const env = await setupImport()
    env.answer(IMPORT_DIALOGS.account, { kind: 'create', remember: true })
    env.answer(IMPORT_DIALOGS.signs, undefined)
    const report = await env.manager.importFiles([CARD_REVERSED, OCTOBER])
    expect(report!.results.map(r => [r.source, r.outcome])).toEqual([['northwind-visa-2026-10-reversed.qfx', 'cancelled']])
    expect(await env.transactions((await env.account('Northwind Card Services 3456')).id)).toEqual([])
  })

  it('is never imported by an import that can’t ask: it is reported, with why', async () => {
    const env = await setupImport()
    const card = await env.accounts.createAccount({ name: 'Visa', type: 'creditCard', subLedgerId: null, currency: 'CAD', openingDate: '2026-09-30', openingBalance: -54000, accountNumber: '4444' } as AccountInput)
    const lines: StatementLine[] = [
      { date: '2026-10-03', amount: '128.44', payee: 'AIR CANADA', externalId: 'A' }, { date: '2026-10-05', amount: '36.80', payee: 'NETFLIX', externalId: 'B' },
      { date: '2026-10-11', amount: '214.67', payee: 'CANADIAN TIRE', externalId: 'C' }, { date: '2026-10-14', amount: '-540.00', payee: 'PAYMENT', externalId: 'D' }
    ]
    const report = await env.manager.importStatements([{ account: { key: 'conn:4444', accountNumber: '4444' }, currency: 'CAD', lines }], { label: 'Bank connection' }, { interactive: false })
    expect(report.results[0]).toMatchObject({ outcome: 'needsConfirmation', counts: { lines: 4, added: 0 } })
    expect(report.results[0].warnings).toEqual(['The amounts may be the wrong way round for “Visa”, so nothing was imported:', '3 of its 4 lines would lower what you owe, and only 1 would add to it.'])
    expect(describeResult(report.results[0])).toBe('Not imported: its amounts may be the wrong way round for “Visa”, and this import couldn’t ask.')
    expect(await env.transactions(card.id)).toEqual([])
  })
})

describe('who keeps the correction', () => {
  /** A format for '.fix' files that can remember a reversal per key, as CSV's layout does: it reads those files reversed. */
  function correctingFormat(env: ImportEnv, files: Record<string, ParsedStatement>) {
    const corrections: FormatCorrection[] = []
    const fmt = createPluginContext('fixfmt', env.runtime).context
    fmt.services.provide('fixfmt', 'fixfmt.format', {
      async parse(file: ImportFile, context: ParseContext) {
        const statement = files[file.name]
        const flipped = await context.memory.get<boolean>(`reversed:${statement.account.key}`)
        return { statements: [flipped ? reversedStatement(statement) : statement] }
      },
      async correct(correction: FormatCorrection, context: { memory: FormatMemory }) {
        corrections.push(correction)
        const now = await context.memory.get<boolean>(`reversed:${correction.key}`)
        await context.memory.set(`reversed:${correction.key}`, !now)
        return true
      }
    })
    fmt.extensions.contribute('fixfmt', IMPORT_FORMATS_POINT, 'fixfmt.fix', { id: 'fixfmt.fix', label: 'Fixture', extensions: ['fix'], service: 'fixfmt.format' })
    return corrections
  }
  const reader = { size: async () => 10, read: async () => new Uint8Array(10) }
  /** A chequing statement whose money out is written as positive: five of six lines look like deposits. */
  const backwards = (day: string, id: string): ParsedStatement => ({
    account: { key: 'fix:5555', label: 'Fixture 5555', accountNumber: '5555' }, currency: 'CAD',
    lines: ['12.00', '40.00', '9.50', '120.00', '33.10', '-2000.00'].map((amount, i) => ({ date: `2026-${day}-0${i + 1}`, amount, payee: `SHOP ${i}`, externalId: `${id}${i}` }))
  })

  it('is the format, when it can keep it: it is told, and reads the next file the right way round itself', async () => {
    const env = await setupImport({ reader })
    await env.accounts.createAccount({ name: 'Chequing', type: 'chequing', subLedgerId: null, currency: 'CAD', openingDate: '2026-01-01', openingBalance: 0, accountNumber: '5555' } as AccountInput)
    const corrections = correctingFormat(env, { 'oct.fix': backwards('10', 'O'), 'nov.fix': backwards('11', 'N') })
    env.answer(IMPORT_DIALOGS.signs, { reverse: true, remember: true })
    await env.manager.importFiles(['/x/oct.fix'])
    expect(corrections).toEqual([{ kind: 'signsReversed', key: 'fix:5555' }])
    const november = await env.manager.importFiles(['/x/nov.fix'])
    expect(env.dialogs(IMPORT_DIALOGS.signs)).toHaveLength(1)                    // November came the right way round
    expect(november!.results[0]).not.toHaveProperty('reversed')
    expect((await signRecords(env)).map(r => r.value)).toEqual([expect.objectContaining({ reverse: false })])
  })

  it('is the import manager otherwise, until the bank’s files come the right way round: then the question takes it off', async () => {
    const env = await setupImport()
    env.answer(IMPORT_DIALOGS.account, { kind: 'create', remember: true })
    env.answer(IMPORT_DIALOGS.signs, { reverse: true, remember: true })
    await env.manager.importFiles([CARD_REVERSED])
    // The bank fixes its files: the kept correction now turns them the wrong way, and the profile says so
    env.answer(IMPORT_DIALOGS.signs, { reverse: true, remember: true })
    const fixed = sample('northwind-visa-2026-11.qfx')
    const report = await env.manager.importFiles([fixed])
    const [, second] = env.dialogs(IMPORT_DIALOGS.signs)
    expect(second.input.reasons[0]).toMatch(/^Reversed, they bring the account to the bank’s balance on .* \(you owe 163\.26\); as they are, they don’t\.$/)
    expect(second.input.correctedSince).toMatch(/^These amounts are shown reversed already, as you chose on .*\. Reversing them again reads them as the file writes them\.$/)
    expect(report!.results[0]).not.toHaveProperty('reversed')
    expect((await signRecords(env)).map(r => r.value)).toEqual([expect.objectContaining({ reverse: false })])
    const card = await env.account('Northwind Card Services 3456')
    expect(await balanceOf(env, card.id)).toBe(-16326)                       // November's closing, as the bank wrote it
  })

  it('is forgotten with its account', async () => {
    const env = await setupImport()
    env.answer(IMPORT_DIALOGS.account, { kind: 'create', remember: true })
    env.answer(IMPORT_DIALOGS.signs, { reverse: true, remember: true })
    await env.manager.importFiles([CARD_REVERSED])
    const card = await env.account('Northwind Card Services 3456')
    expect(await signRecords(env)).toHaveLength(1)
    await env.accounts.deleteAccount(card.id)
    await new Promise(resolve => setTimeout(resolve, 20))                       // the import plugin follows accounts' change
    expect(await signRecords(env)).toEqual([])
  })
})
