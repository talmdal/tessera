// The Archive dialog: the agreed text, the date to archive before, what that would archive (asked a moment after the
// date or an option last changes), and the archive's steps. The privileged side is faked by channel.
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  LEDGER_CHANNELS, LEDGER_EVENTS, displayDate,
  type ArchiveDialogInput, type ArchiveOutcome, type ArchivePreview, type ArchivePreviewPart, type ArchiveRunRequest
} from '@tessera/ledger-api'
import ArchiveDialog, { PREVIEW_AFTER_MS, stepText } from '../../../../plugins/ledger/src/renderer/ArchiveDialog'
import { createFakeRemote } from '../../../helpers/fakeBridge'

const ARCHIVES = '/home/me/Documents/Tessera Backups/Archives'
const INPUT: ArchiveDialogInput = { ledgerName: 'Home', suggestedBefore: '2026-01-01', today: '2026-11-10' }
const LABEL = 'Tessera will archive transactions that occurred before'
/** Waits on the fake privileged side, with room for the whole suite's load (see restoreDialog.test.tsx). */
const LOADED = { timeout: 5_000 }

const ACCOUNTS: ArchivePreviewPart = {
  contributor: 'accounts', count: 1204, summary: '1,204 transactions from 5 accounts',
  notes: ['Each account’s balance is carried into its opening balance, so every balance stays as it is.'],
  warnings: [{ message: '3 transactions before Jan 1, 2026 aren’t reconciled, so they stay in the ledger.', details: ['Chequing 3', 'To archive them too, cancel, reconcile those accounts, and archive again.'] }],
  options: [{ id: 'accounts.removeClosedAccounts', label: 'Remove closed accounts left with nothing', default: true }]
}
const IMPORTS: ArchivePreviewPart = { contributor: 'import', count: 60, summary: '60 import records' }

const previewOf = (before: string, parts: ArchivePreviewPart[] = [ACCOUNTS, IMPORTS]): ArchivePreview => ({
  before, parts, count: parts.reduce((sum, p) => sum + p.count, 0), copy: { name: `Home (archive before ${before})`, folder: ARCHIVES }
})

const OUTCOME: ArchiveOutcome = {
  before: '2026-01-01', archivedAt: '2026-11-10T17:00:00.000Z', count: 1264, summaries: ['1,204 transactions from 5 accounts', '60 import records'],
  copy: { path: `${ARCHIVES}/Home (archive before 2026-01-01).tesserabkp`, takenAt: '2026-11-10T17:00:00.000Z' }
}

function setup(options: { input?: Partial<ArchiveDialogInput>, preview?: (request: ArchiveRunRequest) => unknown, run?: (request: ArchiveRunRequest) => unknown } = {}) {
  const remote = createFakeRemote({})
  const answers: Record<string, (data: any) => unknown> = {
    [LEDGER_CHANNELS.archivePreview]: options.preview ?? (({ before }) => ({ ok: true, value: previewOf(before) })),
    [LEDGER_CHANNELS.archiveRun]: options.run ?? (() => ({ ok: true, value: OUTCOME }))
  }
  remote.bridge.invoke.mockImplementation(async (channel: string, data?: any) => {
    const answer = answers[channel]
    if (!answer) throw new Error(`No answer for ${channel}`)
    return answer(data)
  })
  ;(window as any).api = remote.bridge
  const close = vi.fn()
  const setBusy = vi.fn()
  render(<ArchiveDialog input={{ ...INPUT, ...options.input }} close={close} setBusy={setBusy} />)
  const calls = (channel: string) => remote.bridge.invoke.mock.calls.filter((c: unknown[]) => c[0] === channel).map((c: unknown[]) => c[1])
  return { ...remote, answers, close, setBusy, calls }
}

afterEach(() => { delete (window as any).api })

const dateField = () => screen.getByLabelText(LABEL) as HTMLInputElement
const archiveButton = () => screen.getByRole('button', { name: 'Archive' })
const region = () => screen.getByRole('region', { name: 'What will be archived' })
const shown = () => screen.findByText('1,204 transactions from 5 accounts; 60 import records will be archived.', {}, LOADED)

describe('the Archive dialog', () => {
  it('says what archiving does, in the agreed words', async () => {
    setup()
    expect(screen.getByText(
      'During the archival process, Tessera makes a copy of your current ledger. Then within the current ledger, Tessera removes transactions that are no longer required.',
      { normalizer: text => text.replace(/\s+/g, ' ').trim() }
    )).toBeInTheDocument()
    expect(screen.getByText('To access the archived transactions later, you can open the archive file.')).toBeInTheDocument()
    expect(screen.getByText(LABEL)).toBeInTheDocument()
    await shown()
  })

  it('starts on the suggested date, which can\'t go past today', async () => {
    setup()
    expect(dateField()).toHaveValue('2026-01-01')
    expect(dateField()).toHaveAttribute('type', 'date')
    expect(dateField()).toHaveAttribute('max', '2026-11-10')
    await shown()
  })

  it('shows what the date would archive, the notes, the warnings and where the archive file goes', async () => {
    const { calls } = setup()
    await shown()
    const what = region()
    expect(within(what).getByText('Each account’s balance is carried into its opening balance, so every balance stays as it is.')).toBeInTheDocument()
    const alert = within(what).getByRole('alert')
    expect(alert).toHaveTextContent('3 transactions before Jan 1, 2026 aren’t reconciled, so they stay in the ledger.')
    expect(alert).toHaveTextContent('Chequing 3')
    expect(within(what).getByRole('checkbox', { name: 'Remove closed accounts left with nothing' })).toBeChecked()
    expect(within(what).getByText(`The archive file is saved as “Home (archive before 2026-01-01)” in “${ARCHIVES}”.`)).toBeInTheDocument()
    expect(archiveButton()).toBeEnabled()
    expect(calls(LEDGER_CHANNELS.archivePreview)).toEqual([{ before: '2026-01-01', options: {} }])
  })

  it('says when the ledger was last archived', async () => {
    setup({ input: { lastArchive: { before: '2025-01-01', archivedAt: '2026-01-15T12:00:00.000Z' } } })
    const last = new Date('2026-01-15T12:00:00.000Z').toLocaleDateString([], { dateStyle: 'medium' })
    expect(screen.getByText(`Last archived on ${last}, before ${displayDate('2025-01-01')}.`)).toBeInTheDocument()
    await shown()
  })

  it('asks again a moment after the date last changes, not at every change', async () => {
    const { calls } = setup()
    await shown()
    fireEvent.change(dateField(), { target: { value: '2025-06-01' } })
    fireEvent.change(dateField(), { target: { value: '2025-03-01' } })
    fireEvent.change(dateField(), { target: { value: '2025-01-01' } })
    await screen.findByText(`The archive file is saved as “Home (archive before 2025-01-01)” in “${ARCHIVES}”.`, {}, LOADED)
    expect(calls(LEDGER_CHANNELS.archivePreview)).toEqual([{ before: '2026-01-01', options: {} }, { before: '2025-01-01', options: {} }])
    expect(PREVIEW_AFTER_MS).toBeGreaterThanOrEqual(200)
  })

  it('refuses a date after today, or none, without asking', async () => {
    const { calls } = setup()
    await shown()
    fireEvent.change(dateField(), { target: { value: '2026-11-11' } })
    expect(screen.getByText('Choose today or a date before it.')).toBeInTheDocument()
    expect(archiveButton()).toBeDisabled()
    fireEvent.change(dateField(), { target: { value: '' } })
    expect(screen.getByText('Enter a date.')).toBeInTheDocument()
    await new Promise(resolve => setTimeout(resolve, PREVIEW_AFTER_MS + 100))
    expect(calls(LEDGER_CHANNELS.archivePreview)).toHaveLength(1)
  })

  it('says when there is nothing to archive before the date, and won\'t archive', async () => {
    setup({ preview: ({ before }) => ({ ok: true, value: previewOf(before, [{ ...IMPORTS, count: 0, summary: 'nothing' }]) }) })
    expect(await screen.findByText(`Nothing to archive before ${displayDate('2026-01-01')}.`, {}, LOADED)).toBeInTheDocument()
    expect(archiveButton()).toBeDisabled()
    expect(screen.queryByText(/The archive file is saved as/)).not.toBeInTheDocument()
  })

  it('shows the date\'s problem under the date when the privileged side refuses it', async () => {
    setup({ preview: () => ({ ok: false, error: { code: 'INVALID', field: 'before', message: 'The date to archive before can’t be after today.' } }) })
    expect(await screen.findByText('The date to archive before can’t be after today.', {}, LOADED)).toBeInTheDocument()
    expect(archiveButton()).toBeDisabled()
  })

  it('sends the options as the user left them, asking again when one changes', async () => {
    const { calls } = setup({ preview: ({ before, options }) => ({ ok: true, value: previewOf(before, [{ ...ACCOUNTS, options: [{ ...ACCOUNTS.options![0], default: options?.['accounts.removeClosedAccounts'] ?? true }] }, IMPORTS]) }) })
    await shown()
    await userEvent.click(screen.getByRole('checkbox', { name: 'Remove closed accounts left with nothing' }))
    expect(screen.getByRole('checkbox', { name: 'Remove closed accounts left with nothing' })).not.toBeChecked()
    await waitFor(() => expect(calls(LEDGER_CHANNELS.archivePreview)).toHaveLength(2), LOADED)
    expect(calls(LEDGER_CHANNELS.archivePreview)[1]).toEqual({ before: '2026-01-01', options: { 'accounts.removeClosedAccounts': false } })
    await userEvent.click(archiveButton())
    expect(calls(LEDGER_CHANNELS.archiveRun)).toEqual([{ before: '2026-01-01', options: { 'accounts.removeClosedAccounts': false } }])
  })

  it('archives with every option offered, at its default when left alone, and closes with what was done', async () => {
    const { calls, close, setBusy } = setup()
    await shown()
    await userEvent.click(archiveButton())
    expect(calls(LEDGER_CHANNELS.archiveRun)).toEqual([{ before: '2026-01-01', options: { 'accounts.removeClosedAccounts': true } }])
    await waitFor(() => expect(close).toHaveBeenCalledWith(OUTCOME), LOADED)
    expect(setBusy).toHaveBeenCalledWith(true)
  })

  it('shows each step while it archives, busy, and lets nothing else be done meanwhile', async () => {
    const remote = setup({ run: () => new Promise(() => {}) })
    await shown()
    await userEvent.click(archiveButton())
    act(() => remote.emit(LEDGER_EVENTS.archiveProgress, { step: 'copying', done: 0.4 }))
    expect(screen.getByRole('status')).toHaveTextContent('Copying “Home”… 40%')
    expect(within(screen.getByRole('status')).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '40')
    act(() => remote.emit(LEDGER_EVENTS.archiveProgress, { step: 'checking' }))
    expect(screen.getByRole('status')).toHaveTextContent('Checking the copy…')
    act(() => remote.emit(LEDGER_EVENTS.archiveProgress, { step: 'removing' }))
    expect(screen.getByRole('status')).toHaveTextContent('Removing archived transactions…')
    expect(remote.setBusy).toHaveBeenCalledWith(true)
    expect(archiveButton()).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
    expect(dateField()).toBeDisabled()
    expect(screen.getByRole('checkbox', { name: 'Remove closed accounts left with nothing' })).toBeDisabled()
  })

  it('shows why an archive failed, and stays open to try again', async () => {
    const { close, setBusy } = setup({ run: () => ({ ok: false, error: { code: 'ARCHIVE_FAILED', message: 'Nothing was archived. The disk is full.' } }) })
    await shown()
    await userEvent.click(archiveButton())
    expect(await screen.findByText('Nothing was archived. The disk is full.', {}, LOADED)).toBeInTheDocument()
    expect(close).not.toHaveBeenCalled()
    expect(setBusy).toHaveBeenLastCalledWith(false)
    expect(archiveButton()).toBeEnabled()
  })

  it('closes with nothing on Cancel', async () => {
    const { close, calls } = setup()
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(close).toHaveBeenCalledWith()
    expect(calls(LEDGER_CHANNELS.archiveRun)).toEqual([])
  })
})

describe('the steps, in words', () => {
  it('name the ledger while it is copied and compacted', () => {
    expect(stepText({ step: 'copying' }, 'Home')).toBe('Copying “Home”…')
    expect(stepText({ step: 'copying', done: 0 }, 'Home')).toBe('Copying “Home”…')
    expect(stepText({ step: 'copying', done: 0.123 }, 'Home')).toBe('Copying “Home”… 12%')
    expect(stepText({ step: 'compacting' }, 'Home')).toBe('Compacting “Home”…')
    expect(stepText(undefined, 'Home')).toBe('Archiving…')
  })
})
