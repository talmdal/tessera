// @vitest-environment node
// Customising and saving reports, from the privileged side (phase R4): Customise Report…'s input and what applying it
// does; Save Report As… (the report as shown, in the ledger, then shown), Save Report (refused when changed elsewhere),
// Rename…, Duplicate… and Delete…; `reports.changed`; nothing that writes on a ledger open read-only; and the choices
// made last for a report not saved, remembered per ledger, to open as it was left. The name dialog is played by the
// test, calling the channels as the dialog does.
import { describe, expect, it } from 'vitest'
import {
  REPORTS_CHANNELS, REPORTS_COMMANDS as C, REPORTS_CONTEXT_KEYS as K, REPORTS_DIALOGS, REPORTS_EVENTS,
  type CustomiseDialogInput, type OpenedView, type ReportsCatalog, type RunArgs, type SaveDialogInput
} from '@tessera/reports-api'
import { LAST_KEY } from '../../../plugins/reports/src/privileged/viewState'
import { household } from './examples'
import { setupApp, type App } from './app'

const YEAR = { period: { from: '2026-01-01', to: '2026-12-31' } }
const byCategory = { definitionId: 'reports.spendingByCategory' }
const last = <T>(list: T[]) => list[list.length - 1]
const catalog = async (app: App): Promise<ReportsCatalog> => app.ask(REPORTS_CHANNELS.catalog)
const opened = async (app: App, ref: object): Promise<OpenedView> => (await app.ask(REPORTS_CHANNELS.open, { ref })).value

/** The name dialog, played by the test: it saves, renames or copies through the channels the dialog uses, with `name`. */
function nameDialog(app: App, name: string) {
  const seen: SaveDialogInput[] = []
  app.prompts.show.mockImplementation(async (id: unknown, input: unknown) => {
    if (id !== REPORTS_DIALOGS.save) return undefined
    const i = input as SaveDialogInput
    seen.push(i)
    const reply = i.mode === 'saveAs' ? await app.ask(REPORTS_CHANNELS.save, { ...i.report, name })
      : i.mode === 'rename' ? await app.ask(REPORTS_CHANNELS.rename, { id: i.id, name, expectedRev: i.rev })
        : await app.ask(REPORTS_CHANNELS.duplicate, { id: i.id, name })
    return reply.ok ? { id: reply.value.id } : undefined
  })
  return seen
}

/** Shows a report and says, as its view would, what it shows. */
async function shows(app: App, args: RunArgs) {
  await app.run(C.show, args.ref)
  await app.ask(REPORTS_CHANNELS.select, args)
  await app.idle()
}

async function withHousehold() {
  const app = await setupApp()
  await app.open()
  await household(app.env)
  await app.idle()
  return app
}

describe('Save Report As…', () => {
  it('saves the report as shown (its parameters, options, chart or table, rows folded) in the ledger, then shows it', async () => {
    const app = await withHousehold()
    const dialogs = nameDialog(app, 'Spending in 2026')
    await shows(app, { ref: byCategory, parameters: YEAR, options: { detail: 'all' }, view: { show: 'table', collapsed: ['food'] } })
    const created = await app.run(C.saveAs) as { id: string }
    expect(dialogs[0]).toMatchObject({ mode: 'saveAs', name: 'Spending by Category', taken: [] })
    const [saved] = await app.reports.saved()
    expect(saved).toMatchObject({
      id: created.id, name: 'Spending in 2026', basis: { kind: 'definition', definitionId: 'reports.spendingByCategory', definitionVersion: 1, options: { detail: 'all', refunds: false } },
      parameters: YEAR, view: { show: 'table', collapsed: ['food'] }
    })
    await app.idle()
    expect((await catalog(app)).shown?.ref).toEqual({ savedId: created.id })
    expect((await catalog(app)).saved.map(s => s.name)).toEqual(['Spending in 2026'])
    // Opened as saved
    expect(await opened(app, { savedId: created.id })).toMatchObject({ title: 'Spending in 2026', show: 'table', collapsed: ['food'], options: { detail: 'all' } })
  })

  it('suggests a name not taken, and saves a saved report again as another, keeping its basis', async () => {
    const app = await withHousehold()
    nameDialog(app, 'First')
    await shows(app, { ref: byCategory, parameters: YEAR, options: {} })
    const first = await app.run(C.saveAs) as { id: string }
    const dialogs = nameDialog(app, 'Second')
    await shows(app, { ref: { savedId: first.id }, parameters: { ...YEAR, compare: 'previousYear' }, options: { detail: 'top', refunds: true } })
    await app.run(C.saveAs)
    expect(dialogs[0]).toMatchObject({ name: 'First (2)', taken: ['First'] })
    const second = (await app.reports.saved()).find(s => s.name === 'Second')!
    expect(second).toMatchObject({ basis: { kind: 'definition', definitionId: 'reports.spendingByCategory', options: { refunds: true } }, parameters: { compare: 'previousYear' } })
  })

  it('takes a name only once in a ledger, ignoring case, and leaves the view as it was when cancelled', async () => {
    const app = await withHousehold()
    await app.reports.saveReport({ name: 'Mine', basis: { kind: 'definition', definitionId: 'reports.netWorth' }, parameters: {} })
    await shows(app, { ref: byCategory, parameters: YEAR, options: {} })
    const reply = await app.ask(REPORTS_CHANNELS.save, { ref: byCategory, parameters: YEAR, options: {}, name: 'MINE' })
    expect(reply).toMatchObject({ ok: false, error: { code: 'DUPLICATE_NAME', field: 'name' } })
    app.prompts.show.mockResolvedValueOnce(undefined)
    expect(await app.run(C.saveAs)).toBeUndefined()
    expect((await catalog(app)).shown?.ref).toEqual(byCategory)
  })
})

describe('Save Report and reports.changed', () => {
  it('says a saved report shown has changed once its view differs from what was saved, and saves it so', async () => {
    const app = await withHousehold()
    const saved = await app.reports.saveReport({ name: 'Mine', basis: { kind: 'definition', definitionId: 'reports.spendingByCategory' }, parameters: YEAR })
    const ref = { savedId: saved.id }
    const asSaved = await opened(app, ref)
    await shows(app, { ref, parameters: asSaved.parameters, options: asSaved.options, view: { show: asSaved.show, collapsed: [] } })
    expect(app.key(K.changed)).toBe(false)
    expect(app.enabled(C.save)).toBe(false)
    // Another period
    await app.ask(REPORTS_CHANNELS.select, { ref, parameters: { ...asSaved.parameters, period: { preset: 'lastYear' } }, options: asSaved.options, view: { show: asSaved.show, collapsed: [] } })
    await app.idle()
    expect(app.key(K.changed)).toBe(true)
    expect((await catalog(app)).changed).toBe(true)
    expect(app.enabled(C.save)).toBe(true)
    expect(await app.run(C.save)).toBe(true)
    await app.idle()
    expect((await app.reports.saved())[0]).toMatchObject({ parameters: { period: { preset: 'lastYear' } }, rev: saved.rev + 1 })
    expect(app.key(K.changed)).toBe(false)
    expect((await catalog(app)).changed).toBe(false)
    // Chart or table, and rows folded, are part of it too
    await app.ask(REPORTS_CHANNELS.select, { ref, parameters: { ...asSaved.parameters, period: { preset: 'lastYear' } }, options: asSaved.options, view: { show: 'chart', collapsed: [] } })
    await app.idle()
    expect(app.key(K.changed)).toBe(true)
  })

  it('refuses to save over a change made elsewhere since it was opened, and says so', async () => {
    const app = await withHousehold()
    const saved = await app.reports.saveReport({ name: 'Mine', basis: { kind: 'definition', definitionId: 'reports.spendingByCategory' }, parameters: YEAR })
    const ref = { savedId: saved.id }
    await app.run(C.show, ref)
    // Another window, or another plugin, changes it once it is shown
    await app.reports.updateReport(saved.id, { notes: 'Changed elsewhere' })
    await app.ask(REPORTS_CHANNELS.select, { ref, parameters: { period: { preset: 'lastYear' } }, options: {} })
    await app.idle()
    expect(app.enabled(C.save)).toBe(true)
    expect(await app.run(C.save)).toBe(false)
    expect(app.prompts.message).toHaveBeenCalledWith(expect.objectContaining({ kind: 'warning', message: '“Mine” was changed elsewhere since it was opened.' }))
    expect((await app.reports.saved())[0]).toMatchObject({ parameters: YEAR, notes: 'Changed elsewhere' })
  })

  it('saves after a rename made here, which is no change made elsewhere', async () => {
    const app = await withHousehold()
    const saved = await app.reports.saveReport({ name: 'Mine', basis: { kind: 'definition', definitionId: 'reports.spendingByCategory' }, parameters: YEAR })
    const ref = { savedId: saved.id }
    await app.run(C.show, ref)
    nameDialog(app, 'Renamed')
    await app.run(C.rename)
    await app.ask(REPORTS_CHANNELS.select, { ref, parameters: { period: { preset: 'lastYear' } }, options: {} })
    await app.idle()
    expect(await app.run(C.save)).toBe(true)
    expect((await app.reports.saved())[0]).toMatchObject({ name: 'Renamed', parameters: { period: { preset: 'lastYear' } } })
  })

  it('is never changed for a report not saved', async () => {
    const app = await withHousehold()
    await shows(app, { ref: byCategory, parameters: { period: { preset: 'lastYear' } }, options: {} })
    expect(app.key(K.changed)).toBe(false)
    expect(app.enabled(C.save)).toBe(false)
  })
})

describe('Rename…, Duplicate… and Delete…', () => {
  it('rename the saved report named, or the one shown; duplicate it under a name not taken, and show the copy', async () => {
    const app = await withHousehold()
    const saved = await app.reports.saveReport({ name: 'Mine', basis: { kind: 'definition', definitionId: 'reports.netWorth' }, parameters: {} })
    let dialogs = nameDialog(app, 'Net worth at home')
    await app.run(C.rename, { id: saved.id })
    expect(dialogs[0]).toMatchObject({ mode: 'rename', id: saved.id, rev: saved.rev, name: 'Mine', taken: [] })
    expect((await app.reports.saved())[0].name).toBe('Net worth at home')
    dialogs = nameDialog(app, 'A copy')
    const copy = await app.run(C.duplicate, { id: saved.id }) as { id: string }
    expect(dialogs[0]).toMatchObject({ mode: 'duplicate', name: 'Net worth at home (2)' })
    await app.idle()
    expect((await catalog(app)).shown?.ref).toEqual({ savedId: copy.id })
    expect((await app.reports.saved()).map(s => s.name)).toEqual(['A copy', 'Net worth at home'])
    // The one shown, with no argument
    nameDialog(app, 'The copy')
    await app.run(C.rename)
    expect((await app.reports.saved()).map(s => s.name)).toEqual(['Net worth at home', 'The copy'])
  })

  it('deletes after asking, and not when the answer is no', async () => {
    const app = await withHousehold()
    const saved = await app.reports.saveReport({ name: 'Mine', basis: { kind: 'definition', definitionId: 'reports.netWorth' }, parameters: {} })
    app.answers.push(false)
    expect(await app.run(C.deleteSaved, { id: saved.id })).toBe(false)
    expect(await app.reports.saved()).toHaveLength(1)
    expect(await app.run(C.deleteSaved, { id: saved.id })).toBe(true)
    expect(app.prompts.confirm).toHaveBeenLastCalledWith(expect.objectContaining({ message: 'Delete the saved report “Mine”?', destructive: true }))
    expect(await app.reports.saved()).toEqual([])
  })
})

describe('a ledger open read-only', () => {
  it('lists and shows its saved reports, and offers nothing that writes; Customise Report… still works', async () => {
    const app = await withHousehold()
    const saved = await app.reports.saveReport({ name: 'Mine', basis: { kind: 'definition', definitionId: 'reports.spendingByCategory' }, parameters: YEAR })
    await app.session.open(await app.archiveFile())
    await app.idle()
    expect(app.session.current?.readOnly).toBe(true)
    expect((await catalog(app)).saved.map(s => s.name)).toEqual(['Mine'])
    await shows(app, { ref: { savedId: saved.id }, parameters: { period: { preset: 'lastYear' } }, options: {} })
    for (const command of [C.save, C.saveAs, C.rename, C.duplicate, C.deleteSaved]) expect(app.enabled(command), command).toBe(false)
    expect(app.enabled(C.customise)).toBe(true)
  })
})

describe('Customise Report…', () => {
  it('offers the report’s own options with their values, Show the top from the Reports page, and Open on; applying shows it so', async () => {
    const app = await withHousehold()
    await shows(app, { ref: { definitionId: 'reports.spendingByPayee' }, parameters: YEAR, options: { what: 'spending' }, view: { show: 'both', collapsed: [] } })
    app.prompts.show.mockImplementationOnce(async (_id: unknown, input: unknown) => {
      const i = input as CustomiseDialogInput
      expect(i).toEqual({
        title: 'Spending by Payee',
        options: [{ key: 'what', label: 'Spending or income', kind: 'choice', choices: [{ value: 'spending', label: 'Spending: who you paid' }, { value: 'income', label: 'Income: who paid you' }], default: 'spending', value: 'spending' }],
        top: { value: 25, default: 25 }, show: 'both'
      })
      return { options: { what: 'income', '@top': '10' }, show: 'table' }
    })
    expect(await app.run(C.customise)).toBe(true)
    await app.idle()
    const shown = (await catalog(app)).shown!
    expect(shown).toMatchObject({ ref: { definitionId: 'reports.spendingByPayee' }, options: { what: 'income', '@top': '10' }, show: 'table' })
    // As the view then runs it: ten payees, and who paid
    const result = (await app.ask(REPORTS_CHANNELS.run, { ref: shown.ref, parameters: YEAR, options: shown.options })).value
    expect(result.rows.filter((r: { kind: string }) => r.kind === 'member').length).toBeLessThanOrEqual(10)
    expect(result.columns[0].label).toBe('Income')
  })

  it('offers no Show the top for a report whose rows keep none, and no Open on without a chart', async () => {
    const app = await withHousehold()
    await shows(app, { ref: { definitionId: 'reports.accountBalances' }, parameters: {}, options: {} })
    let input: CustomiseDialogInput | undefined
    app.prompts.show.mockImplementationOnce(async (_id: unknown, i: unknown) => { input = i as CustomiseDialogInput; return undefined })
    expect(await app.run(C.customise)).toBe(false)
    expect(input!.top).toBeUndefined()
    expect(input!.show).toBeUndefined()
    expect(input!.options.map(o => o.key)).toEqual(['groupBy', 'includeClosed', 'chart'])
  })
})

describe('the choices made last', () => {
  it('open a report not saved as it was left, in this ledger, with Accounts still carried from the last report', async () => {
    const app = await withHousehold()
    await shows(app, { ref: byCategory, parameters: { period: { preset: 'lastYear' }, currency: 'CAD', compare: 'previousYear' }, options: { detail: 'all' }, view: { show: 'table', collapsed: ['food'] } })
    await shows(app, { ref: { definitionId: 'reports.netWorth' }, parameters: {}, options: {} })
    const again = await opened(app, byCategory)
    expect(again).toMatchObject({ parameters: { period: { preset: 'lastYear' }, compare: 'previousYear' }, options: { detail: 'all' }, show: 'table', collapsed: ['food'] })
    // Kept for the ledger, in the app's state (under the plugin's own key)
    const kept = [...app.state.values].find(([key]) => key.startsWith('reports') && key.endsWith(LAST_KEY))
    expect(kept).toBeDefined()
    expect(Object.values(kept![1] as object)).toEqual([expect.objectContaining({ 'reports.spendingByCategory': expect.objectContaining({ options: { detail: 'all' } }) })])
  })

  it('leave out what no longer fits (an option, a sub-ledger gone, a period malformed), and are never taken from a saved report', async () => {
    const app = await withHousehold()
    const sub = await app.session.createSubLedger({ name: 'Gone', parentId: null })
    await shows(app, { ref: byCategory, parameters: { period: { preset: 'lastYear' }, scope: { kind: 'subLedger', subLedgerId: sub.id } }, options: { detail: 'sideways' } })
    await app.session.deleteSubLedger(sub.id)
    await app.idle()
    const again = await opened(app, byCategory)
    expect(again.parameters).toMatchObject({ period: { preset: 'lastYear' }, scope: { kind: 'ledger' } })
    expect(again.options).toMatchObject({ detail: 'top' })
    await shows(app, { ref: byCategory, parameters: { period: { preset: 'someday' } as never }, options: {} })
    expect((await opened(app, byCategory)).parameters.period).toEqual({ preset: 'thisYear' })
    const saved = await app.reports.saveReport({ name: 'Mine', basis: { kind: 'definition', definitionId: 'reports.spendingByCategory' }, parameters: YEAR })
    expect((await opened(app, { savedId: saved.id })).parameters.period).toEqual(YEAR.period)
    expect(sub).toBeDefined()
  })

  it('are not kept from an archive file, which isn’t the ledger', async () => {
    const app = await withHousehold()
    await app.session.open(await app.archiveFile())
    await app.idle()
    await shows(app, { ref: byCategory, parameters: { period: { preset: 'lastYear' } }, options: {} })
    expect(JSON.stringify([...app.state.values])).not.toContain('lastYear')
    expect(app.named(REPORTS_EVENTS.catalog).length).toBeGreaterThan(0)
  })
})
