import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import {
  RECURRING_CHANNELS, RECURRING_COMMANDS as C, RECURRING_EVENTS,
  type DueState, type RecurringRow, type RecurringSnapshot, type Series
} from '@tessera/recurring-api'
import RecurringView, { dueNow } from '../../../../plugins/recurring/src/renderer/RecurringView'
import { createFakeRemote } from '../../../helpers/fakeBridge'

const EXECUTE = 'shell:commands.execute'

const series = (over: Partial<Series> = {}): Series => ({
  id: 's1', rev: 1, accountId: 'c', name: 'Hydro',
  template: { amount: -14200, payee: 'Hydro', autoNumber: false, estimated: false },
  schedule: { frequency: 'monthly', interval: 1, startDate: '2026-09-01' },
  remindDays: 3, autoEnter: false, paused: false, nextIndex: 0, nextDate: '2026-09-01',
  enteredCount: 0, skippedCount: 0, createdAt: '', updatedAt: '', ...over
})

const row = (over: Partial<RecurringRow> & { state: DueState }, seriesOver: Partial<Series> = {}): RecurringRow => ({
  series: series(seriesOver),
  kind: 'payment',
  occurrence: { index: 0, date: seriesOver.nextDate ?? '2026-09-01' },
  dueCount: 1,
  account: { id: 'c', name: 'Chequing', type: 'chequing', currency: 'CAD', closed: false },
  payeeName: 'Hydro',
  categoryLabel: 'Utilities : Electricity',
  scheduleLabel: 'Monthly on the 1st',
  ...over
})

const snapshot = (rows: RecurringRow[], over: Partial<RecurringSnapshot['summary']> = {}): RecurringSnapshot => ({
  rows,
  summary: { overdueCount: 0, overdueTotals: {}, dueSoonCount: 0, dueSoonTotals: {}, blockedCount: 0, ...over },
  today: '2026-11-13'
})

/** Three rows: one overdue three times, one due today, one later. */
const BOOK = snapshot([
  row({ state: 'overdue', dueCount: 3 }, { id: 's1', name: 'Hydro', nextDate: '2026-09-01' }),
  row({ state: 'dueToday', dueCount: 1 }, { id: 's2', name: 'Rent', nextDate: '2026-11-13' }),
  row({ state: 'upcoming', dueCount: 0 }, { id: 's3', name: 'Insurance', nextDate: '2026-12-20' })
], { overdueCount: 1, overdueTotals: { CAD: -42600 }, dueSoonCount: 1, dueSoonTotals: { CAD: -14200 } })

function setup(initial: RecurringSnapshot | null = BOOK, answers: Record<string, (data: any) => unknown> = {}) {
  const remote = createFakeRemote({})
  remote.bridge.invoke.mockImplementation(async (channel: string, data?: any) => {
    if (channel === EXECUTE) return answers[EXECUTE]?.(data) ?? undefined
    if (channel === RECURRING_CHANNELS.snapshot) return answers[channel]?.(data) ?? initial
    return answers[channel]?.(data)
  })
  ;(window as any).api = remote.bridge
  const calls = (channel: string) => remote.bridge.invoke.mock.calls.filter((c: unknown[]) => c[0] === channel).map((c: unknown[]) => c[1])
  render(<RecurringView />)
  return { ...remote, calls, executed: () => calls(EXECUTE) as { id: string, args: unknown[] }[] }
}

const line = (name: string) => screen.getByRole('row', { name: new RegExp(name) })

afterEach(() => { delete (window as any).api })

describe('the list', () => {
  it('shows one row per series, in the order the plugin gave them', async () => {
    setup()
    const table = await screen.findByRole('table')
    const names = within(table).getAllByRole('row').slice(1).map(r => r.getAttribute('data-row'))
    expect(names).toEqual(['s1', 's2', 's3'])
    expect(within(line('Hydro')).getByText('Utilities : Electricity')).toBeTruthy()
    expect(within(line('Hydro')).getByText('Chequing')).toBeTruthy()
  })

  it('marks what is overdue with an icon as well as a colour, and counts the rest', async () => {
    setup()
    await screen.findByRole('table')
    const overdue = line('Hydro')
    expect(overdue).toHaveAttribute('data-state', 'overdue')
    // The count of occurrences behind this one row
    expect(within(overdue).getByText('3')).toBeTruthy()
    expect(line('Insurance')).toHaveAttribute('data-state', 'upcoming')
  })

  it('warns about what is overdue, naming the oldest', async () => {
    setup()
    const note = await waitFor(() => {
      const found = document.querySelector('[data-note="overdue"]') as HTMLElement | null
      expect(found).not.toBeNull()
      return found!
    })
    expect(note).toHaveTextContent(/1 transaction is overdue, the oldest due/)
    expect(within(note).getByRole('button', { name: 'Enter All Overdue' })).toBeTruthy()
  })

  it('says when something is due soon only while nothing is overdue', async () => {
    setup(snapshot([row({ state: 'dueSoon' })], { dueSoonCount: 1 }))
    await waitFor(() => expect(document.querySelector('[data-note="dueSoon"]')).not.toBeNull())
    expect(document.querySelector('[data-note="overdue"]')).toBeNull()
  })

  it('invites the first one when there is nothing yet', async () => {
    const b = setup(snapshot([]))
    await screen.findByText('Nothing repeats yet')
    expect(screen.queryByRole('table')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'New Recurring Transaction' }))
    expect(b.executed()).toEqual([{ id: C.new, args: [] }])
  })

  it('describes the selected one underneath, so the dialog need not be opened', async () => {
    setup()
    await screen.findByRole('table')
    const detail = document.querySelector('[data-recurring-detail]') as HTMLElement
    expect(detail).toHaveTextContent('Monthly on the 1st')
    expect(detail).toHaveTextContent('never entered')

    await userEvent.click(line('Insurance'))
    await waitFor(() => expect(document.querySelector('[data-recurring-detail="s3"]')).not.toBeNull())
  })
})

describe('choosing what to enter', () => {
  it('enters the row under the pointer when nothing is ticked', async () => {
    const b = setup()
    await screen.findByRole('table')
    await userEvent.click(line('Rent'))
    await userEvent.click(screen.getByRole('button', { name: /Enter in Register/ }))
    expect(b.executed().at(-1)).toEqual({ id: C.enter, args: [{ ids: ['s2'] }] })
  })

  it('enters every ticked row, and says how many', async () => {
    const b = setup(BOOK, { [EXECUTE]: () => ({ entered: [{}, {}], failed: [] }) })
    await screen.findByRole('table')
    await userEvent.click(within(line('Hydro')).getByRole('checkbox'))
    await userEvent.click(within(line('Rent')).getByRole('checkbox'))
    expect(screen.getByRole('button', { name: /Enter in Register \(2\)/ })).toBeTruthy()

    await userEvent.click(screen.getByRole('button', { name: /Enter in Register/ }))
    expect(b.executed().at(-1)).toEqual({ id: C.enter, args: [{ ids: ['s1', 's2'] }] })
    await waitFor(() => expect(document.querySelector('[data-note="result"]')).toHaveTextContent('2 transactions entered.'))
  })

  it('reports a partial failure with the reason', async () => {
    const b = setup(BOOK, {
      [EXECUTE]: () => ({ entered: [{}], failed: [{ seriesId: 's2', code: 'ACCOUNT_CLOSED', message: '“Savings” is closed.' }] })
    })
    await screen.findByRole('table')
    await userEvent.click(screen.getByRole('button', { name: /Enter in Register/ }))
    await waitFor(() => {
      const note = document.querySelector('[data-note="result"]')!
      expect(note).toHaveTextContent('1 of 2 entered. “Savings” is closed.')
    })
    expect(b.executed()).toHaveLength(1)
  })

  it('says nothing when the dialog was cancelled', async () => {
    setup(BOOK, { [EXECUTE]: () => undefined })
    await screen.findByRole('table')
    await userEvent.click(screen.getByRole('button', { name: /Enter in Register/ }))
    await waitFor(() => expect(screen.queryByRole('button', { name: /Enter in Register/ })).toBeEnabled())
    expect(document.querySelector('[data-note="result"]')).toBeNull()
  })

  it('ticks every enterable row at once, and leaves blocked ones alone', async () => {
    const b = setup(snapshot([
      row({ state: 'overdue' }, { id: 's1' }),
      row({ state: 'upcoming', blockedReason: '“Savings” is closed.' }, { id: 's2', name: 'Blocked' })
    ], { overdueCount: 1, blockedCount: 1 }))
    await screen.findByRole('table')

    expect(within(line('Blocked')).getByRole('checkbox')).toBeDisabled()
    await userEvent.click(screen.getByRole('checkbox', { name: 'Tick every transaction that can be entered' }))
    await userEvent.click(screen.getByRole('button', { name: /Enter in Register/ }))
    expect(b.executed().at(-1)).toEqual({ id: C.enter, args: [{ ids: ['s1'] }] })
  })

  it('enters everything due when the menu asks it to', async () => {
    const b = setup()
    await screen.findByRole('table')
    act(() => { b.emit(RECURRING_EVENTS.enterDue, {}) })
    // Overdue and due today, never the upcoming one
    await waitFor(() => expect(b.executed().at(-1)).toEqual({ id: C.enter, args: [{ ids: ['s1', 's2'] }] }))
  })

  it('works out what is due the same way the view shows it', () => {
    expect(dueNow(BOOK.rows)).toEqual(['s1', 's2'])
    expect(dueNow([row({ state: 'overdue', blockedReason: 'gone' })])).toEqual([])
    expect(dueNow([row({ state: 'paused' })])).toEqual([])
  })
})

describe('the row context menu', () => {
  it('offers Edit, which is the view\'s own item rather than a contribution', async () => {
    const b = setup()
    await screen.findByRole('table')
    await userEvent.pointer({ keys: '[MouseRight]', target: line('Rent') })
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Edit…' }))
    expect(b.executed().at(-1)).toEqual({ id: C.edit, args: [{ ids: ['s2'] }] })
  })

  it('offers to skip everything that has piled up, only when more than one is due', async () => {
    const b = setup()
    await screen.findByRole('table')
    await userEvent.pointer({ keys: '[MouseRight]', target: line('Hydro') })
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Skip All 3 Due…' }))
    expect(b.executed().at(-1)).toEqual({ id: C.skip, args: [{ ids: ['s1'], count: 3 }] })

    await userEvent.pointer({ keys: '[MouseRight]', target: line('Rent') })
    await screen.findByRole('menuitem', { name: 'Skip This One…' })
    expect(screen.queryByRole('menuitem', { name: /Skip All/ })).toBeNull()
  })

  it('pauses a live series and resumes a paused one', async () => {
    const b = setup(snapshot([row({ state: 'paused' }, { paused: true, pausedReason: 'user' })]))
    await screen.findByRole('table')
    await userEvent.pointer({ keys: '[MouseRight]', target: line('Hydro') })
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Resume' }))
    expect(b.executed().at(-1)).toEqual({ id: C.resume, args: [{ ids: ['s1'] }] })
  })
})

describe('the keyboard', () => {
  it('moves, ticks, enters and edits without the mouse', async () => {
    const b = setup()
    const table = await screen.findByRole('table')
    const container = table.parentElement as HTMLElement
    container.focus()

    await userEvent.keyboard('{ArrowDown}')          // Rent
    await userEvent.keyboard(' ')                    // tick it
    await waitFor(() => expect(within(line('Rent')).getByRole('checkbox')).toBeChecked())

    await userEvent.keyboard('{Enter}')
    expect(b.executed().at(-1)).toEqual({ id: C.enter, args: [{ ids: ['s2'] }] })

    await userEvent.keyboard('{F2}')
    expect(b.executed().at(-1)).toEqual({ id: C.edit, args: [{ ids: ['s2'] }] })

    await userEvent.keyboard('{Insert}')
    expect(b.executed().at(-1)).toEqual({ id: C.new, args: [] })
  })
})

describe('paused and finished series', () => {
  it('asks the plugin for them only when the box is ticked', async () => {
    const b = setup()
    await screen.findByRole('table')
    expect(b.calls(RECURRING_CHANNELS.snapshot).at(-1)).toBeUndefined()

    await userEvent.click(screen.getByRole('checkbox', { name: 'Show paused' }))
    await waitFor(() => expect(b.calls(RECURRING_CHANNELS.snapshot).at(-1)).toEqual({ includePaused: true, includeEnded: false }))

    await userEvent.click(screen.getByRole('checkbox', { name: 'Show finished' }))
    await waitFor(() => expect(b.calls(RECURRING_CHANNELS.snapshot).at(-1)).toEqual({ includePaused: true, includeEnded: true }))
  })
})
