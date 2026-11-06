// @vitest-environment node
// The matching walkthrough of samples/statements/README.md ("Matching and review"), step by step, so what it says
// stays true: what the summary, the review bar, the rows and the Change Match dialog say, and where the balance ends.
import { describe, expect, it } from 'vitest'
import { LEDGER_SESSION_SERVICE, type LedgerSession } from '@tessera/ledger-api'
import type { RegisterAnnotator } from '@tessera/accounts-api'
import {
  IMPORT_ANNOTATOR_SERVICE, IMPORT_CHANNELS, IMPORT_COMMANDS, IMPORT_DIALOGS,
  type ImportResult, type MatchCandidatesResponse, type SummaryDialogInput
} from '@tessera/import-api'
import { describe as summaryOf } from '../../../plugins/import/src/renderer/SummaryDialog'
import { collectionsOf } from '../../../plugins/import/src/privileged/store'
import { sample, setupImport } from './harness'

const text = (parts: { text: string, emphasis?: boolean }[]) => parts.map(p => p.emphasis ? `[${p.text}]` : p.text).join('')

describe('the matching walkthrough of the samples’ README', () => {
  it('does what it says, step by step', async () => {
    const env = await setupImport()
    // 1 and 2: the account, and six transactions typed by hand
    const chequing = await env.accounts.createAccount({
      name: 'Chequing', type: 'chequing', subLedgerId: null, currency: 'CAD', openingDate: '2026-09-01', openingBalance: 100000, accountNumber: '8812345678'
    })
    const register = env.accounts.transactions(chequing.id)
    const landlord = await register.create({ date: '2026-09-28', number: '101', amount: -120000, payee: 'Landlord' })
    const keg = await register.create({ date: '2026-10-03', amount: -5000, payee: 'The Keg' })
    const costco = await register.create({ date: '2026-10-05', amount: -8400, payee: 'Costco' })
    const hydro = await register.create({ date: '2026-10-07', amount: -8000, payee: 'Hydro One' })
    await register.create({ date: '2026-10-25', amount: -2399, payee: 'Amazon' })
    await register.create({ date: '2026-10-29', amount: -475, payee: 'Tim Hortons' })

    // 3: imported without a dialog; the summary
    const report = await env.manager.importFiles([sample('maple-trust-chequing-2026-10.ofx')])
    expect(env.dialogs(IMPORT_DIALOGS.account)).toEqual([])
    expect(summaryOf((env.dialogs(IMPORT_DIALOGS.summary)[0].input as SummaryDialogInput).results[0]))
      .toBe('11 transactions added to “Chequing”, 6 matched to ones already there (2 possible).')
    expect(report!.results[0].counts).toMatchObject({ added: 11, matched: 4, possible: 2 })

    // 4: the register's marks
    const annotator = env.runtime.services.get<RegisterAnnotator>(IMPORT_ANNOTATOR_SERVICE)
    const marks = () => annotator.annotate(chequing.id)
    const mark = async (id: string) => (await marks()).rows.find(r => r.transactionId === id)!
    expect((await marks()).summary!.message).toBe('17 imported transactions to review (6 matches, 11 new), from maple-trust-chequing-2026-10.ofx.')
    expect(text((await mark(costco.id)).detail.parts)).toBe('Matched to bank line: [Oct 6] · POS PURCHASE COSTCO WHSE #0123 · [84.12]')
    expect(await mark(keg.id)).toMatchObject({ tone: 'warning', detail: { parts: expect.arrayContaining([{ text: '57.50', emphasis: true }]) } })
    expect(text((await mark(landlord.id)).detail.parts)).toContain('Possible match:')
    expect((await mark(landlord.id)).detail.parts.map(p => p.text)).toContain('CHEQUE 101')
    const rows = (await marks()).rows.filter(r => r.review)
    expect(rows.filter(r => text(r.detail.parts).startsWith('New from the bank'))).toHaveLength(11)
    expect(await register.get(costco.id)).toMatchObject({ date: '2026-10-05', amount: -8400, status: 'uncleared' })

    const run = (command: string, args: unknown) => env.runtime.commands.execute(command, args) as Promise<ImportResult<unknown>>
    const press = async (transactionId: string, label: string) => {
      const action = (await mark(transactionId)).actions.find(a => a.label === label)!
      return run(action.command, action.args)
    }

    // 5: Accept on Costco, as its tooltip says
    expect((await mark(costco.id)).actions[0].tooltip).toBe('Use the bank’s date, Oct 6, and amount, 84.12, and mark it electronically cleared')
    await press(costco.id, 'Accept')
    expect(await register.get(costco.id)).toMatchObject({ date: '2026-10-06', amount: -8412, status: 'electronic' })

    // 6: Change… on The Keg, Unmatch
    env.answer(IMPORT_DIALOGS.match, { kind: 'unmatch' })
    await press(keg.id, 'Change…')
    expect(await register.get(keg.id)).toMatchObject({ amount: -5000 })
    expect((await register.get(keg.id))!.externalId).toBeUndefined()
    expect((await register.findByExternalIds(['MT2026100301']))[0]).toMatchObject({ amount: -5750 })

    // 7: Superstore, entered by hand, chosen for the new Loblaws row, remembering the bank's name for it
    const superstore = await register.create({ date: '2026-10-14', amount: -14000, payee: 'Superstore' })
    const loblaws = (await register.findByExternalIds(['MT2026101501']))[0]
    const line = (await collectionsOf(env.runtime.services.get<LedgerSession>(LEDGER_SESSION_SERVICE).database('import')).lines.findOne({ importId: 'MT2026101501' }))!
    const reply = await env.runtime.ipc.dispatch({ channel: IMPORT_CHANNELS.matchCandidates, data: { lineId: line.id } })
    const dialog = (reply as { ok: true, data: ImportResult<MatchCandidatesResponse> }).data
    if (!dialog.ok) throw new Error(dialog.error.message)
    const listed = dialog.value.candidates.find(c => c.transaction.id === superstore.id)!
    expect(listed.differences).toEqual(['1 day earlier', '2.87 less', 'payee'])
    expect(listed.payeeKnown).toBe(false)
    expect(dialog.value.bankName).toBe('LOBLAWS')
    env.answer(IMPORT_DIALOGS.match, { kind: 'match', transactionId: superstore.id, rememberPayee: true })
    await press(loblaws.id, 'Change…')
    expect(await register.get(loblaws.id)).toBeUndefined()
    expect(await register.get(superstore.id)).toMatchObject({ date: '2026-10-15', amount: -14287 })

    // 8: Hydro One deleted: its bank line lost its match, and Resolve… adds it
    await register.delete([hydro.id])
    const { summary } = await marks()
    expect(summary!.message).toContain('1 bank line lost its match')
    const resolve = summary!.actions.find(a => a.label === 'Resolve…')!
    env.answer(IMPORT_DIALOGS.match, { kind: 'unmatch' })
    await run(resolve.command, resolve.args)
    expect((await register.findByExternalIds(['MT2026100701']))[0]).toMatchObject({ amount: -8000, status: 'electronic' })

    // 9: Accept All…, which asks first
    env.prompts.confirm.mockResolvedValueOnce(true)
    const acceptAll = (await marks()).summary!.actions.find(a => a.label === 'Accept All…')!
    await run(acceptAll.command, acceptAll.args)
    expect(env.prompts.confirm).toHaveBeenLastCalledWith(expect.objectContaining({ detail: expect.stringContaining('change a date or an amount') }))
    expect((await marks()).summary).toBeUndefined()

    // 10: Change Match… in Costco's row menu, Unmatch, which says what goes back
    const costcoLine = (await collectionsOf(env.runtime.services.get<LedgerSession>(LEDGER_SESSION_SERVICE).database('import')).lines.findOne({ importId: 'MT2026100601' }))!
    const again = await env.runtime.ipc.dispatch({ channel: IMPORT_CHANNELS.matchCandidates, data: { lineId: costcoLine.id } })
    expect((again as { data: ImportResult<MatchCandidatesResponse> }).data).toMatchObject({ ok: true, value: { state: 'accepted', restores: { date: '2026-10-05', amount: -8400 } } })
    env.answer(IMPORT_DIALOGS.match, { kind: 'unmatch' })
    await press(costco.id, 'Change Match…')
    expect(await register.get(costco.id)).toMatchObject({ date: '2026-10-05', amount: -8400, status: 'uncleared' })
    expect((await register.findByExternalIds(['MT2026100601']))[0]).toMatchObject({ date: '2026-10-06', amount: -8412 })

    // 11: with your own Keg and Costco deleted, the balance is the bank's
    await register.delete([keg.id, costco.id])
    expect((await env.accounts.balances(chequing.id)).current).toBe(467780)

    // And importing the file again adds nothing
    const repeat = await env.manager.importFiles([sample('maple-trust-chequing-2026-10.ofx')])
    expect(repeat!.results[0].counts).toMatchObject({ added: 0, matched: 0, possible: 0, duplicates: 17 })
  })
})
