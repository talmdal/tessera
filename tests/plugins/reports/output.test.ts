// @vitest-environment node
// Print Report…, Save Report as PDF… and Export Report… from the privileged side (phase R6). Printing: the plugin asks
// the view to draw the report, and prints the window the view answers from, on the page it says; a cancelled print is
// no error; a failed one, a view that can't draw the report, or one that never answers, each says why. The PDF and the
// CSV: the Save dialog suggests "<report> <period>" in the folder used last; the CSV is the table as shown, written
// whole. All three only while the report view is in front, and on a ledger open read-only too. The view is played by
// the test, answering on the channel as the view does.
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { MAIN_ACTIVE_VIEW_KEY } from '@tessera/types'
import {
  REPORTS_CHANNELS, REPORTS_COMMANDS as C, REPORTS_EVENTS, REPORTS_VIEWS, type PrintReady, type PrintRequest, type RunArgs
} from '@tessera/reports-api'
import { FOLDER_KEY, fileNameFor } from '../../../plugins/reports/src/privileged/output'
import { household } from './examples'
import { setupApp, type App } from './app'

const YEAR = { period: { from: '2026-01-01', to: '2026-12-31' } }
const byCategory = { definitionId: 'reports.spendingByCategory' }
const DOCUMENTS = (app: App) => app.files.documentsPath()

/** Shows a report, says what the view shows, and puts the report view in front. */
async function shows(app: App, args: RunArgs) {
  await app.run(C.show, args.ref)
  await app.ask(REPORTS_CHANNELS.select, args)
  app.runtime.contextKeys.set(MAIN_ACTIVE_VIEW_KEY, REPORTS_VIEWS.view)
  await app.idle()
}

async function withHousehold(options: Parameters<typeof setupApp>[0] = {}) {
  const app = await setupApp(options)
  await app.open()
  await household(app.env)
  await app.idle()
  return app
}

/** The print requests the plugin sent to the view. */
const requests = (app: App) => app.named(REPORTS_EVENTS.print).map(e => e.data as PrintRequest)

/** The view's answer, from window 7. */
const answer = async (app: App, ready: PrintReady) => {
  const reply = await app.runtime.ipc.dispatch({ channel: REPORTS_CHANNELS.printReady, data: ready }, { windowId: 7 })
  if (!reply.ok) throw new Error(reply.error.message)
  return reply.data as { ok: boolean, value?: boolean, error?: { code: string } }
}

/** Waits until the plugin has asked the view to print. */
async function asked(app: App, count = 1) {
  for (let i = 0; i < 100 && requests(app).length < count; i++) await new Promise(resolve => setTimeout(resolve, 5))
  return requests(app)[count - 1]
}

describe('when the three are offered', () => {
  it('only while a report is shown and the report view is in front; on a ledger open read-only too', async () => {
    const app = await withHousehold()
    const offered = () => [C.exportCsv, C.print, C.savePdf].map(id => app.enabled(id))
    expect(offered()).toEqual([false, false, false])
    await shows(app, { ref: byCategory, parameters: YEAR, options: {} })
    expect(offered()).toEqual([true, true, true])
    // The register in front: Ctrl+P doesn't print the report behind it
    app.runtime.contextKeys.set(MAIN_ACTIVE_VIEW_KEY, 'accounts.register')
    expect(offered()).toEqual([false, false, false])
    // An archive file, read-only: printing and exporting write nothing into it
    await app.session.open(await app.archiveFile())
    await shows(app, { ref: byCategory, parameters: YEAR, options: {} })
    expect(app.session.current?.readOnly).toBe(true)
    expect(offered()).toEqual([true, true, true])
  })
})

describe('Print Report…', () => {
  it('asks the view to draw the report, then prints the window it answered from, on the page it said', async () => {
    const app = await withHousehold()
    await shows(app, { ref: byCategory, parameters: YEAR, options: {} })
    const printed = app.run(C.print)
    const request = await asked(app)
    expect(request).toEqual({ request: 1, output: 'print' })
    expect(app.print.print).not.toHaveBeenCalled()
    expect(await answer(app, { request: request.request, landscape: true })).toEqual({ ok: true, value: true })
    expect(app.print.print).toHaveBeenCalledWith({ windowId: 7, landscape: true })
    expect(await printed).toBe(true)
    expect(app.prompts.message).not.toHaveBeenCalled()
  })

  it('is no error when the user cancels the print dialog', async () => {
    const app = await withHousehold()
    await shows(app, { ref: byCategory, parameters: YEAR, options: {} })
    app.print.print.mockResolvedValueOnce(false)
    const printed = app.run(C.print)
    expect(await answer(app, { request: (await asked(app)).request, landscape: false })).toEqual({ ok: true, value: false })
    expect(await printed).toBe(false)
    expect(app.prompts.message).not.toHaveBeenCalled()
  })

  it('says why, when printing failed, or the view couldn\'t draw the report', async () => {
    const app = await withHousehold()
    await shows(app, { ref: byCategory, parameters: YEAR, options: {} })
    app.print.print.mockRejectedValueOnce(new Error('The report couldn’t be printed: Print job failed.'))
    const first = app.run(C.print)
    await answer(app, { request: (await asked(app)).request, landscape: false })
    expect(await first).toBe(false)
    expect(app.prompts.message).toHaveBeenLastCalledWith({ kind: 'error', message: 'Could not print the report.', detail: 'The report couldn’t be printed: Print job failed.' })
    const second = app.run(C.print)
    await answer(app, { request: (await asked(app, 2)).request, problem: 'The source took too long.' })
    expect(await second).toBe(false)
    expect(app.prompts.message).toHaveBeenLastCalledWith({ kind: 'error', message: 'Could not print the report.', detail: 'The source took too long.' })
    expect(app.print.print).toHaveBeenCalledTimes(1)
  })

  it('gives up, saying so, when no view answers in time; a late answer prints nothing', async () => {
    const app = await withHousehold({ printWaitMs: 30 })
    await shows(app, { ref: byCategory, parameters: YEAR, options: {} })
    expect(await app.run(C.print)).toBe(false)
    expect(app.prompts.message).toHaveBeenCalledWith({ kind: 'error', message: 'Could not print the report.', detail: 'The report wasn’t ready in time. Show it, then try again.' })
    expect(await answer(app, { request: requests(app)[0].request, landscape: false })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    expect(app.print.print).not.toHaveBeenCalled()
  })
})

describe('Save Report as PDF…', () => {
  it('asks where, suggesting the report and its period in Documents, then writes the PDF of the window the view answered from', async () => {
    const app = await withHousehold()
    await shows(app, { ref: byCategory, parameters: YEAR, options: {} })
    const file = path.join(DOCUMENTS(app), 'Reports', 'Spending 2026.pdf')
    app.files.showSaveDialog.mockResolvedValueOnce(file)
    const saved = app.run(C.savePdf)
    const request = await asked(app)
    expect(request.output).toBe('pdf')
    expect(app.files.showSaveDialog).toHaveBeenCalledWith({
      title: 'Save Report as PDF', defaultPath: path.join(DOCUMENTS(app), 'Spending by Category 2026.pdf'),
      filters: [{ name: 'PDF document', extensions: ['pdf'] }], buttonLabel: 'Save'
    })
    await answer(app, { request: request.request, landscape: false })
    expect(app.print.savePdf).toHaveBeenCalledWith({ windowId: 7, path: file, landscape: false })
    expect(await saved).toBe(true)
    // The folder is remembered, for the next PDF or CSV
    expect([...app.state.values].find(([key]) => key.startsWith('reports') && key.endsWith(FOLDER_KEY))?.[1]).toBe(path.dirname(file))
    app.files.showSaveDialog.mockResolvedValueOnce(undefined)
    expect(await app.run(C.savePdf)).toBe(false)
    expect(app.files.showSaveDialog).toHaveBeenLastCalledWith(expect.objectContaining({ defaultPath: path.join(path.dirname(file), 'Spending by Category 2026.pdf') }))
    // Cancelled: the view isn't asked
    expect(requests(app)).toHaveLength(1)
  })

  it('says why, when the PDF couldn\'t be written', async () => {
    const app = await withHousehold()
    await shows(app, { ref: byCategory, parameters: YEAR, options: {} })
    app.files.showSaveDialog.mockResolvedValueOnce(path.join(DOCUMENTS(app), 'x.pdf'))
    app.print.savePdf.mockRejectedValueOnce(new Error('x.pdf couldn’t be saved: another program may have it open.'))
    const saved = app.run(C.savePdf)
    await answer(app, { request: (await asked(app)).request, landscape: true })
    expect(await saved).toBe(false)
    expect(app.prompts.message).toHaveBeenCalledWith({ kind: 'error', message: 'Could not save the report as PDF.', detail: 'x.pdf couldn’t be saved: another program may have it open.' })
  })
})

describe('Export Report…', () => {
  it('writes the table as shown to the CSV file chosen, rows folded left out, figures the report\'s', async () => {
    const app = await withHousehold()
    const result = await app.reports.run(byCategory, YEAR, { detail: 'all' })
    const food = result.rows.find(r => r.label === 'Food')!
    expect(result.rows.filter(r => r.parentId === food.id).length).toBeGreaterThan(0)
    await shows(app, { ref: byCategory, parameters: YEAR, options: { detail: 'all' }, view: { show: 'both', collapsed: [food.id] } })
    const file = path.join(DOCUMENTS(app), 'Spending.csv')
    app.files.showSaveDialog.mockResolvedValueOnce(file)
    expect(await app.run(C.exportCsv)).toBe(true)
    expect(app.files.showSaveDialog).toHaveBeenCalledWith({
      title: 'Export Report', defaultPath: path.join(DOCUMENTS(app), 'Spending by Category 2026.csv'),
      filters: [{ name: 'CSV (comma-separated values)', extensions: ['csv'] }], buttonLabel: 'Export'
    })
    const bytes = app.written.get(file)!
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    const lines = new TextDecoder().decode(bytes.slice(3)).split('\r\n').filter(Boolean)
    expect(lines[0]).toBe(`Category,${result.columns.map(c => c.label).join(',')}`)
    // Food is folded: its categories aren't written; it is, and everything else is
    expect(lines.some(l => l.startsWith('Food : '))).toBe(false)
    expect(lines.filter(l => l.startsWith('Food,'))).toHaveLength(1)
    expect(lines.length - 1).toBe(result.rows.filter(r => r.parentId !== food.id).length)
    expect(lines.at(-1)).toBe(`Total,${result.rows.at(-1)!.values.map(v => ((v as number) / 100).toFixed(2)).join(',')}`)
    // Nothing is printed for a CSV
    expect(requests(app)).toEqual([])
  })

  it('writes nothing when cancelled, and says why when the file couldn\'t be written', async () => {
    const app = await withHousehold()
    await shows(app, { ref: byCategory, parameters: YEAR, options: {} })
    expect(await app.run(C.exportCsv)).toBe(false)
    expect(app.files.writeFile).not.toHaveBeenCalled()
    app.files.showSaveDialog.mockResolvedValueOnce(path.join(DOCUMENTS(app), 'Spending.csv'))
    app.files.writeFile.mockRejectedValueOnce(new Error('Spending.csv couldn’t be saved: another program may have it open.'))
    expect(await app.run(C.exportCsv)).toBe(false)
    expect(app.prompts.message).toHaveBeenCalledWith({ kind: 'error', message: 'Could not export the report.', detail: 'Spending.csv couldn’t be saved: another program may have it open.' })
  })
})

describe('the name suggested', () => {
  it('is the report\'s name and its period, safe as a file name', () => {
    expect(fileNameFor({ title: 'Income vs Expenses', subtitle: 'January – March 2026 · Whole ledger · CAD' }, 'csv')).toBe('Income vs Expenses January – March 2026.csv')
    expect(fileNameFor({ title: 'Budget: Q1/Q2 <draft>', subtitle: 'March 2027 · Household · CAD' }, 'pdf')).toBe('Budget- Q1-Q2 -draft- March 2027.pdf')
    expect(fileNameFor({ title: 'Net Worth', subtitle: '' }, 'pdf')).toBe('Net Worth.pdf')
  })
})
