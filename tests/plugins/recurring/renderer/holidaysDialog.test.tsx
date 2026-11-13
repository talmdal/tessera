import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RECURRING_CHANNELS, type Holiday } from '@tessera/recurring-api'
import HolidaysDialog from '../../../../plugins/recurring/src/renderer/HolidaysDialog'
import { createFakeRemote } from '../../../helpers/fakeBridge'

const holiday = (over: Partial<Holiday>): Holiday => ({ id: 'h', rev: 1, date: '2026-12-25', name: 'Christmas Day', ...over })

function bridge(answers: Record<string, (data: any) => unknown> = {}) {
  const remote = createFakeRemote({})
  remote.bridge.invoke.mockImplementation(async (channel: string, data?: any) => answers[channel]?.(data))
  ;(window as any).api = remote.bridge
  const calls = (channel: string) => remote.bridge.invoke.mock.calls.filter((c: unknown[]) => c[0] === channel).map((c: unknown[]) => c[1])
  return { ...remote, calls }
}

afterEach(() => { delete (window as any).api })

describe('the holidays dialog', () => {
  it('lists what the book has, in order, and removes one', async () => {
    const b = bridge({ [RECURRING_CHANNELS.removeHoliday]: () => ({ ok: true }) })
    render(<HolidaysDialog input={{ today: '2026-11-13', holidays: [holiday({ id: 'x' }), holiday({ id: 'b', date: '2026-12-26', name: 'Boxing Day' })] }} close={vi.fn()} />)
    const list = screen.getByRole('list', { name: 'Holidays' })
    expect(within(list).getAllByText(/Day/).map(e => e.textContent)).toEqual(['Christmas Day', 'Boxing Day'])

    await userEvent.click(screen.getByRole('button', { name: 'Remove Boxing Day' }))
    expect(b.calls(RECURRING_CHANNELS.removeHoliday)).toEqual([{ id: 'b' }])
    await waitFor(() => expect(within(list).queryByText('Boxing Day')).toBeNull())
  })

  it('adds one, saving at once, and shows the plugin\'s reason when it refuses', async () => {
    let fail = false
    const b = bridge({
      [RECURRING_CHANNELS.addHoliday]: ({ date, name }) => fail
        ? { ok: false, error: { code: 'INVALID', message: 'That date is already a holiday.', field: 'date' } }
        : { ok: true, value: holiday({ id: 'new', date, name: name || 'Holiday' }) }
    })
    render(<HolidaysDialog input={{ today: '2026-11-13', holidays: [] }} close={vi.fn()} />)
    expect(screen.getByText(/No holidays yet/)).toBeTruthy()

    // Today is the default date; nothing is typed for the name, so the plugin names it
    await userEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(b.calls(RECURRING_CHANNELS.addHoliday)).toEqual([{ date: '2026-11-13', name: '' }])
    expect(await screen.findByText('Holiday')).toBeTruthy()

    fail = true
    await userEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(await screen.findByText('That date is already a holiday.')).toBeTruthy()
  })

  it('closes with nothing', async () => {
    bridge()
    const close = vi.fn()
    render(<HolidaysDialog input={{ today: '2026-11-13', holidays: [] }} close={close} />)
    await userEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(close).toHaveBeenCalledWith(undefined)
  })
})
