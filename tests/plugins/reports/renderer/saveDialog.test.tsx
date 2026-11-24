// The name dialog (phase R4): Save Report As…, Rename… and Duplicate…. A name checked as it is typed (the ledger's
// rules, and unique ignoring case); the plugin's answer beside the field (a name taken meanwhile) or above it (a
// ledger open read-only, a change made elsewhere), the dialog staying open; each mode through its own channel.
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { REPORTS_CHANNELS, type SaveDialogInput } from '@tessera/reports-api'
import SaveDialog from '../../../../plugins/reports/src/renderer/SaveDialog'
import { renderInTheme, reportsBridge } from './fixtures'

const REPORT = { ref: { definitionId: 'reports.spendingByCategory' }, parameters: { period: { preset: 'thisYear' as const } }, options: { detail: 'all' }, view: { show: 'table' as const, collapsed: [] }, name: '' }
const saved = (id: string, name: string) => ({ ok: true, value: { id, name } })

function open(input: Partial<SaveDialogInput>, answers: Parameters<typeof reportsBridge>[0] = {}) {
  const close = vi.fn()
  const setBusy = vi.fn()
  const bridge = reportsBridge(answers)
  renderInTheme(<SaveDialog input={{ mode: 'saveAs', report: REPORT, name: 'Spending by Category', taken: [], ...input }} close={close} setBusy={setBusy} />)
  return { close, setBusy, bridge, field: () => screen.getByRole('textbox', { name: 'Name' }) }
}

describe('the name dialog', () => {
  it('saves the report as shown under the name given, and closes with the saved report', async () => {
    const { close, bridge, field, setBusy } = open({}, { [REPORTS_CHANNELS.save]: () => saved('s1', 'Spending in 2026') })
    await userEvent.clear(field())
    await userEvent.type(field(), '  Spending in 2026 ')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(close).toHaveBeenCalledWith({ id: 's1' }))
    expect(bridge.calls(REPORTS_CHANNELS.save)).toEqual([{ ...REPORT, name: 'Spending in 2026' }])
    expect(setBusy.mock.calls).toEqual([[true], [false]])
  })

  it('says a name is taken as it is typed, ignoring case, and won’t save it', async () => {
    const { close, field } = open({ taken: ['Groceries'] })
    await userEvent.clear(field())
    await userEvent.type(field(), 'GROCERIES')
    expect(screen.getByText('There is already a saved report named “Groceries”.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    await userEvent.clear(field())
    expect(screen.getByText('Enter a name.')).toBeInTheDocument()
    await userEvent.type(field(), 'a/b')
    expect(screen.getByText(/can’t contain/)).toBeInTheDocument()
    expect(close).not.toHaveBeenCalled()
  })

  it('shows the plugin’s answer beside the name, or above it, and stays open', async () => {
    let answer: unknown = { ok: false, error: { code: 'DUPLICATE_NAME', message: 'There is already a saved report named “Mine”.', field: 'name' } }
    const { close } = open({ name: 'Mine' }, { [REPORTS_CHANNELS.save]: () => answer })
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('There is already a saved report named “Mine”.')).toBeInTheDocument()
    answer = { ok: false, error: { code: 'READ_ONLY', message: 'This ledger is open read-only, so its saved reports can’t change.' } }
    await userEvent.type(screen.getByRole('textbox', { name: 'Name' }), ' 2')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('This ledger is open read-only, so its saved reports can’t change.')
    expect(close).not.toHaveBeenCalled()
  })

  it('renames with the revision it was opened at, and says so when it changed elsewhere meanwhile', async () => {
    const { close, bridge, field } = open({ mode: 'rename', id: 's1', rev: 3, name: 'Mine' }, {
      [REPORTS_CHANNELS.rename]: () => ({ ok: false, error: { code: 'CONFLICT', message: 'Changed.' } })
    })
    expect(screen.queryByText(/Saved in this ledger/)).not.toBeInTheDocument()
    await userEvent.type(field(), ' at home')
    await userEvent.click(screen.getByRole('button', { name: 'Rename' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('This report was changed elsewhere since it was opened. Close this and try again.')
    expect(bridge.calls(REPORTS_CHANNELS.rename)).toEqual([{ id: 's1', name: 'Mine at home', expectedRev: 3 }])
    expect(close).not.toHaveBeenCalled()
  })

  it('duplicates under the name given, and cancels with nothing', async () => {
    const first = open({ mode: 'duplicate', id: 's1', name: 'Mine (2)', taken: ['Mine'] }, { [REPORTS_CHANNELS.duplicate]: () => saved('s2', 'Mine (2)') })
    expect(screen.getByText('A copy, to change apart from the first.')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Duplicate' }))
    await waitFor(() => expect(first.close).toHaveBeenCalledWith({ id: 's2' }))
    expect(first.bridge.calls(REPORTS_CHANNELS.duplicate)).toEqual([{ id: 's1', name: 'Mine (2)' }])
  })

  it('closes with nothing when cancelled', async () => {
    const { close, bridge } = open({})
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(close).toHaveBeenCalledWith()
    expect(bridge.calls(REPORTS_CHANNELS.save)).toEqual([])
  })
})
