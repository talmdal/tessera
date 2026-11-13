import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import {
  RECURRING_CHANNELS, RECURRING_COMMANDS as C, RECURRING_EVENTS, type ForecastEntry, type RecurringSnapshot
} from '@tessera/recurring-api'
import UpcomingPanel, { byDay, netOf } from '../../../../plugins/recurring/src/renderer/UpcomingPanel'
import { createFakeRemote } from '../../../helpers/fakeBridge'

const EXECUTE = 'shell:commands.execute'

const snapshot = (overdue = 0): RecurringSnapshot => ({
  rows: [], today: '2026-11-13',
  summary: { overdueCount: overdue, overdueTotals: {}, dueSoonCount: 0, dueSoonTotals: {}, blockedCount: 0 }
})
const entry = (over: Partial<ForecastEntry>): ForecastEntry => ({
  seriesId: 's', accountId: 'c', name: 'Hydro', kind: 'payment', date: '2026-11-20', amount: -14200, currency: 'CAD', estimated: false, ...over
})
const ENTRIES: ForecastEntry[] = [
  entry({ seriesId: 'a', date: '2026-11-15', name: 'Rent', amount: -120000 }),
  entry({ seriesId: 'b', date: '2026-11-15', name: 'Pay', kind: 'deposit', amount: 300000 }),
  entry({ seriesId: 'c', date: '2026-11-20' }),
  entry({ seriesId: 'd', date: '2026-11-25', name: 'Save', kind: 'transfer', amount: -50000, transferAccountId: 'v' })
]

function setup(initial: RecurringSnapshot | null = snapshot(), entries: ForecastEntry[] = ENTRIES) {
  const remote = createFakeRemote({})
  remote.bridge.invoke.mockImplementation(async (channel: string, data?: any) => {
    if (channel === EXECUTE) return undefined
    if (channel === RECURRING_CHANNELS.snapshot) return initial
    if (channel === RECURRING_CHANNELS.forecast) return entries.filter(e => e.date >= data.from && e.date <= data.to)
    return undefined
  })
  ;(window as any).api = remote.bridge
  const calls = (channel: string) => remote.bridge.invoke.mock.calls.filter((c: unknown[]) => c[0] === channel).map((c: unknown[]) => c[1])
  render(<UpcomingPanel />)
  return { ...remote, calls }
}

afterEach(() => { delete (window as any).api })

describe('the Upcoming panel', () => {
  it('asks for the forecast from today over the default horizon, and groups what comes back by day', async () => {
    const b = setup()
    const list = await screen.findByRole('list', { name: 'Upcoming transactions' })
    expect(b.calls(RECURRING_CHANNELS.forecast)[0]).toEqual({ from: '2026-11-13', to: '2026-12-13' })
    const days = [...list.querySelectorAll('[data-upcoming-day]')].map(d => d.getAttribute('data-upcoming-day'))
    expect(days).toEqual(['2026-11-15', '2026-11-20', '2026-11-25'])
    expect(within(list).getAllByRole('listitem')).toHaveLength(4)
  })

  it('nets the window per currency, leaving transfers out since they are a wash across the book', async () => {
    setup()
    await screen.findByRole('list')
    // −1,200 + 3,000 − 142 = 1,658.00; the 500 transfer is not counted
    expect(document.querySelector('[data-upcoming="net"]')).toHaveTextContent(/1,658\.00/)
    expect(netOf(ENTRIES)).toEqual({ CAD: 165800 })
    expect(byDay(ENTRIES).map(d => d.entries.length)).toEqual([2, 1, 1])
  })

  it('changes the horizon, and asks again', async () => {
    const b = setup()
    await screen.findByRole('list')
    await userEvent.click(screen.getByRole('button', { name: '7d' }))
    await waitFor(() => expect(b.calls(RECURRING_CHANNELS.forecast).at(-1)).toEqual({ from: '2026-11-13', to: '2026-11-20' }))
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(3))
  })

  it('asks again when the snapshot moves', async () => {
    const b = setup()
    await screen.findByRole('list')
    const before = b.calls(RECURRING_CHANNELS.forecast).length
    act(() => { b.emit(RECURRING_EVENTS.snapshot, snapshot()) })
    await waitFor(() => expect(b.calls(RECURRING_CHANNELS.forecast).length).toBe(before + 1))
  })

  it('warns about what is overdue and opens the Recurring view from it, or from any entry', async () => {
    const b = setup(snapshot(2))
    await screen.findByRole('list')
    const note = document.querySelector('[data-note="overdue"]') as HTMLElement
    expect(note).toHaveTextContent('2 transactions are overdue')
    await userEvent.click(note)
    expect(b.calls(EXECUTE).at(-1)).toEqual({ id: C.open, args: [] })

    await userEvent.click(screen.getAllByRole('listitem')[0])
    expect(b.calls(EXECUTE)).toHaveLength(2)
  })

  it('says when nothing is coming, and when no book is open', async () => {
    setup(snapshot(), [])
    expect(await screen.findByText(/Nothing falls due in the next 30 days/)).toBeTruthy()
    ;(window as any).api = undefined
    setup(null)
    expect(await screen.findByText(/Open a book/)).toBeTruthy()
  })
})
