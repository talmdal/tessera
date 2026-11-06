// @vitest-environment node
// The import's marks on register rows (import.annotator): what each kind of line shows, its buttons and their
// tooltips, the review bar's message and actions, and when the register is told to read them again. The marks come
// through accounts' own register.load, as the register view gets them.
import { describe, expect, it, vi } from 'vitest'
import type { LedgerSession } from '@tessera/ledger-api'
import { LEDGER_SESSION_SERVICE } from '@tessera/ledger-api'
import { ACCOUNTS_CHANNELS, ACCOUNTS_EVENTS, type RegisterView } from '@tessera/accounts-api'
import { IMPORT_COMMANDS, IMPORT_EVENTS } from '@tessera/import-api'
import { ImportAnnotator, acceptTooltip } from '../../../plugins/import/src/privileged/annotator'
import { PayeeAliases } from '../../../plugins/import/src/privileged/aliases'
import { FIT, typedThenImported } from './typed'

const text = (parts: { text: string, emphasis?: boolean }[]) => parts.map(p => p.emphasis ? `[${p.text}]` : p.text).join('')

describe('the marks on an imported account’s rows', () => {
  it('show each proposed match with the bank’s version under it, what differs emphasised, in the tone of its score', async () => {
    const { entered, mark } = await typedThenImported()
    const costco = (await mark(entered.costco.id))!
    expect(costco).toMatchObject({ review: true, tone: 'info', detail: { icon: 'CompareArrows' } })
    expect(text(costco.detail.parts)).toBe('Matched to bank line: [Oct 6] · POS PURCHASE COSTCO WHSE #0123 · [84.12]')
    const keg = (await mark(entered.keg.id))!
    expect(keg).toMatchObject({ review: true, tone: 'warning', detail: { icon: 'Warning' } })
    expect(text(keg.detail.parts)).toBe('Possible match: Oct 3 · THE KEG #12 · [57.50]')
    // The bank names the cheque, not the landlord: the payee is a difference too
    expect(text((await mark(entered.rent.id))!.detail.parts)).toBe('Possible match: [Oct 2] · [CHEQUE 101] · 1,200.00')
    expect(text((await mark(entered.hydro.id))!.detail.parts)).toBe('Matched to bank line: Oct 7 · HYDRO ONE NETWORKS · 80.00')
  })

  it('give matches and new rows the same two buttons, which run the review commands with the line', async () => {
    const { entered, mark, line, byBankId } = await typedThenImported()
    const costco = (await mark(entered.costco.id))!
    const costcoLine = await line(FIT.costco)
    expect(costco.actions).toEqual([
      { id: 'import.accept', label: 'Accept', icon: 'Check', placement: 'button', command: IMPORT_COMMANDS.accept, args: { lineIds: [costcoLine.id] },
        tooltip: 'Use the bank’s date, Oct 6, and amount, 84.12, and mark it electronically cleared' },
      { id: 'import.change', label: 'Change…', icon: 'CompareArrows', placement: 'button', command: IMPORT_COMMANDS.change, args: { lineId: costcoLine.id },
        tooltip: 'Match it to another transaction, unmatch it, or leave the bank line out' }
    ])
    const loblaws = (await mark((await byBankId(FIT.loblaws)).id))!
    expect(loblaws).toMatchObject({ review: true, tone: 'info', detail: { icon: 'NewReleases' } })
    expect(text(loblaws.detail.parts)).toBe('New from the bank: LOBLAWS #1001 · OTTAWA ON')
    expect(loblaws.actions.map(a => [a.label, a.placement, a.tooltip])).toEqual([
      ['Accept', 'button', 'Keep it as the bank sent it'], ['Change…', 'button', 'Match it to a transaction you entered, or leave it out']
    ])
  })

  it('say what Accept will change, and only that', async () => {
    const { entered, line } = await typedThenImported()
    const hydro = await line(FIT.hydro)
    expect(acceptTooltip(hydro as never, entered.hydro, 'CAD')).toBe('Link it to the bank line, and mark it electronically cleared')
    expect(acceptTooltip(hydro as never, { ...entered.hydro, status: 'cleared' }, 'CAD')).toBe('Link it to the bank line; nothing else changes')
    expect(acceptTooltip(await line(FIT.keg) as never, { ...entered.keg, status: 'electronic' }, 'CAD')).toBe('Use the bank’s amount, 57.50')
  })

  it('score a proposal again once the user edits the transaction', async () => {
    const { entered, mark, manager } = await typedThenImported()
    expect((await mark(entered.keg.id))!.tone).toBe('warning')
    await manager.update(entered.keg.id, { amount: -5750 })                      // the tip, added by hand
    expect((await mark(entered.keg.id))!).toMatchObject({ tone: 'info', review: true })
    expect(text((await mark(entered.keg.id))!.detail.parts)).toBe('Matched to bank line: Oct 3 · THE KEG #12 · 57.50')
  })

  it('sum up the rows to review in the review bar, with Accept All…', async () => {
    const { account, marks } = await typedThenImported()
    const { summary } = await marks()
    expect(summary).toEqual({
      message: '17 imported transactions to review (6 matches, 11 new), from maple-trust-chequing-2026-10.ofx.',
      actions: [{
        id: 'import.acceptAll', label: 'Accept All…', icon: 'Check', placement: 'button', command: IMPORT_COMMANDS.acceptAll,
        args: { accountId: account.id }, tooltip: 'Accept every imported transaction to review in this account'
      }],
      outstanding: 0
    })
  })

  it('count down as rows are reviewed, and say nothing once all are', async () => {
    const { env, account, marks, accept } = await typedThenImported()
    await accept(FIT.costco)
    await accept(FIT.loblaws)
    expect((await marks()).summary!.message).toBe('15 imported transactions to review (5 matches, 10 new), from maple-trust-chequing-2026-10.ofx.')
    env.prompts.confirm.mockResolvedValueOnce(true)
    await env.runtime.commands.execute(IMPORT_COMMANDS.acceptAll, { accountId: account.id })
    const { rows, summary } = await marks()
    expect(summary).toBeUndefined()
    expect(rows).toHaveLength(17)
    expect(rows.every(r => !r.review && r.actions.length === 1 && r.actions[0].label === 'Change Match…')).toBe(true)
  })

  it('say where rows to review came from when there are several imports', async () => {
    const { env, marks } = await typedThenImported()
    await env.manager.importStatements([{ account: { accountNumber: '8812345678' }, currency: 'CAD', lines: [{ date: '2026-11-01', amount: '-5.00', payee: 'X', externalId: 'X1' }] }], { label: 'Connected bank' })
    expect((await marks()).summary!.message).toBe('18 imported transactions to review (6 matches, 12 new), from 2 imports.')
  })

  it('mark nothing for lines left out, or whose transaction was deleted', async () => {
    const { entered, change, mark, marks, byBankId, manager } = await typedThenImported()
    await change(FIT.keg, { kind: 'skip' })
    expect(await mark(entered.keg.id)).toBeUndefined()
    const loblaws = await byBankId(FIT.loblaws)
    await manager.delete([loblaws.id])
    expect((await marks()).rows.some(r => r.transactionId === loblaws.id)).toBe(false)
    expect((await marks()).summary!.outstanding).toBe(0)                         // deleted by the user: gone, not lost
  })

  it('is empty for an account nothing was imported into', async () => {
    const { env, annotator } = await typedThenImported()
    const other = await env.accounts.createAccount({ name: 'Cash', type: 'cash', subLedgerId: null, currency: 'CAD', openingDate: '2026-01-01', openingBalance: 0 })
    expect(await annotator.annotate(other.id)).toEqual({ rows: [] })
    expect(await annotator.annotate('nope')).toEqual({ rows: [] })
  })

  it('show the marks but no buttons in a read-only ledger', async () => {
    const { env, account, entered } = await typedThenImported()
    const session = env.runtime.services.get<LedgerSession>(LEDGER_SESSION_SERVICE)
    const readOnly = { get current() { return { ...session.current!, readOnly: true } }, database: (id: string) => session.database(id) } as unknown as LedgerSession
    const annotator = new ImportAnnotator({ session: readOnly, accounts: env.accounts, aliases: new PayeeAliases(() => session.database('import'), () => '') })
    const { rows, summary } = await annotator.annotate(account.id)
    expect(rows.find(r => r.transactionId === entered.costco.id)).toMatchObject({ review: true, actions: [] })
    expect(summary!.actions).toEqual([])
  })

  it('reach the register through accounts’ register.load', async () => {
    const { env, account, entered } = await typedThenImported()
    const reply = await env.runtime.ipc.dispatch({ channel: ACCOUNTS_CHANNELS.loadRegister, data: { accountId: account.id } })
    if (!reply.ok) throw new Error(reply.error.message)
    const view = reply.data as RegisterView
    const costco = view.annotations!.rows.find(r => r.transactionId === entered.costco.id)!
    expect(costco.buttons.map(b => b.label)).toEqual(['Accept', 'Change…'])
    expect(view.annotations!.summaries).toEqual([expect.objectContaining({ contributor: 'import.review', message: expect.stringContaining('17 imported transactions') })])
  })
})

describe('telling the register to read the marks again', () => {
  it('happens after an import and after each review command, for the account concerned', async () => {
    const seen: string[][] = []
    const { account, annotator, accept, change } = await typedThenImported({
      beforeImport: async env => {
        const annotator = env.runtime.services.get<{ onDidChange(l: (c: { accounts: string[] }) => void): unknown }>('import.annotator')
        annotator.onDidChange(change => seen.push(change.accounts))
      }
    })
    expect(seen).toEqual([[account.id]])
    const listener = vi.fn()
    annotator.onDidChange(listener)
    await accept(FIT.costco)
    await change(FIT.keg, { kind: 'skip' })
    await change(FIT.hydro, undefined)                                            // cancelled: nothing changed, but it is harmless
    expect(listener.mock.calls.map(([c]) => c)).toEqual([{ accounts: [account.id] }, { accounts: [account.id] }])
  })

  it('reaches the register view as accounts:annotations.changed', async () => {
    const { env, account, accept } = await typedThenImported()
    const emitted: { name: string, data?: unknown }[] = []
    env.runtime.events.subscribe(event => emitted.push(event))
    await accept(FIT.costco)
    expect(emitted).toContainEqual({ name: ACCOUNTS_EVENTS.annotations, data: { accounts: [account.id] } })
    expect(emitted).toContainEqual({ name: IMPORT_EVENTS.batches, data: { accounts: [account.id] } })
  })
})
