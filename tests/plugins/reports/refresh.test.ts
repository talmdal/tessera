// @vitest-environment node
// Keeping reports current (phase R3): figures that may have changed are gathered, with the sources they came from,
// into one `stale` event: a burst of changes (an import, typing in the register) is one; a new year start (File ›
// Ledger Properties…) and another ledger mark every source; a saved report is a catalog change, not a stale one.
// Whether the view then runs again (only while on screen) is the view's: tests/plugins/reports/renderer.
import { describe, expect, it, vi } from 'vitest'
import { REPORTS_EVENTS, type StaleEvent } from '@tessera/reports-api'
import { Refresher } from '../../../plugins/reports/src/privileged/refresh'
import { file } from '../ledger/harness'
import { setupApp, type App } from './app'

const staleEvents = (app: App) => app.named(REPORTS_EVENTS.stale).map(e => e.data as StaleEvent)

async function withAccount() {
  const app = await setupApp()
  await app.open()
  const account = await app.accounts.createAccount({ name: 'Chequing', type: 'chequing', subLedgerId: null, currency: 'CAD', openingDate: '2026-01-01', openingBalance: 0 })
  await app.idle()
  app.events.length = 0
  return { app, account }
}

describe('stale figures', () => {
  it('are one event for a burst of changes, naming the sources that read them', async () => {
    const { app, account } = await withAccount()
    for (let i = 1; i <= 20; i++) await app.accounts.transactions(account.id).create({ date: `2026-01-${String(i).padStart(2, '0')}`, amount: -100 * i })
    await app.idle()
    expect(staleEvents(app)).toEqual([{ sources: ['reports.balances', 'reports.flows'] }])
  })

  it('are one event for an import of many transactions', async () => {
    const { app, account } = await withAccount()
    await app.accounts.transactions(account.id).createMany(Array.from({ length: 300 }, (_, i) => ({ date: '2026-02-01', amount: -(i + 1) })))
    await app.idle()
    expect(staleEvents(app)).toHaveLength(1)
  })

  it('are every source after a new year start, so the shown report runs again with its new quarters and years', async () => {
    const { app } = await withAccount()
    await app.session.setYearStart({ month: 4, day: 1 })
    await app.idle()
    expect(staleEvents(app)).toEqual([{ sources: null }])
  })

  it('are every source after another ledger opens, sent after the catalogs (the old ledger closing, the new one opening)', async () => {
    const { app } = await withAccount()
    await app.session.create(file('Other.tessera'))
    await app.idle()
    const sent = app.events.filter(e => e.name === REPORTS_EVENTS.catalog || e.name === REPORTS_EVENTS.stale)
      .map(e => e.name === REPORTS_EVENTS.stale ? e.data : e.data?.ledgerName ?? null)
    expect(sent).toEqual([null, 'Other', { sources: null }])
  })

  it('aren’t sent for a saved report, or when nothing changed', async () => {
    const { app } = await withAccount()
    await app.reports.saveReport({ name: 'Mine', basis: { kind: 'definition', definitionId: 'reports.netWorth' }, parameters: {} })
    await app.idle()
    expect(staleEvents(app)).toEqual([])
    expect(app.named(REPORTS_EVENTS.catalog)).toHaveLength(1)
  })
})

describe('the refresher', () => {
  it('gathers sources until the debounce fires, then starts again', async () => {
    vi.useFakeTimers()
    try {
      const emit = vi.fn()
      const view = { refresh: vi.fn(async () => {}) }
      const refresher = new Refresher({ events: { emit } as never, logger: { error: vi.fn() } as never }, view as never, 250)
      refresher.stale(['reports.flows'])
      refresher.stale(['budget.status'])
      await vi.advanceTimersByTimeAsync(249)
      expect(emit).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(emit).toHaveBeenCalledWith('stale', { sources: ['budget.status', 'reports.flows'] })
      refresher.stale(['reports.flows'])
      refresher.stale()
      refresher.stale(['reports.balances'])
      await vi.advanceTimersByTimeAsync(250)
      expect(emit).toHaveBeenLastCalledWith('stale', { sources: null })
      expect(emit).toHaveBeenCalledTimes(2)
      refresher.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})
