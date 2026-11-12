// The Restore dialog: choosing a backup, how to restore it, and the restore's progress. The privileged side is faked by
// channel. Text is pasted rather than typed key by key: these tests check values, not keystrokes, and each key
// re-renders the whole dialog.
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import {
  LEDGER_CHANNELS, LEDGER_EVENTS, displayDate, type BackupInfo, type RestorePlan, type RestoreRequest
} from '@tessera/ledger-api'
import RestoreDialog, { when } from '../../../../plugins/ledger/src/renderer/RestoreDialog'
import { createFakeRemote } from '../../../helpers/fakeBridge'

const FOLDER = '/home/me/Documents/Tessera Backups'
const HOME: BackupInfo = { path: `${FOLDER}/Home 2026-11-09 10-14-05.tesserabkp`, ledgerName: 'Home', ledgerId: 'L1', ledgerPath: '/l/Home.tessera', takenAt: '2026-11-09T15:14:05.000Z', kind: 'manual', size: 24 * 1024 }
const OLD: BackupInfo = { path: `${FOLDER}/Home old.tesserabkp`, ledgerName: 'Home', ledgerId: 'L1', takenAt: '2026-10-01T12:00:00.000Z', kind: 'auto', size: 3 * 1024 * 1024 }
const BAD: BackupInfo = { path: `${FOLDER}/Future.tesserabkp`, ledgerName: 'Future', takenAt: '2026-11-01T00:00:00.000Z', kind: 'ledger', size: 10, problem: '“Future.tesserabkp” was saved by a newer version of Tessera. Update Tessera to open it.' }

const planFor = (backup: BackupInfo, inPlace: RestorePlan['inPlace'] = { path: '/l/Home.tessera', name: 'Home', isOpen: true, keepAs: 'Home (before restore 2026-11-09 10-14)' }): RestorePlan =>
  ({ backup, asNew: { folder: '/l', name: 'Home (restored 2026-11-09)' }, inPlace })

function setup(options: { backups?: BackupInfo[], plans?: Record<string, RestorePlan>, run?: (request: RestoreRequest) => unknown, preselect?: string } = {}) {
  const backups = options.backups ?? [HOME, OLD]
  const plans = options.plans ?? { [HOME.path]: planFor(HOME), [OLD.path]: planFor(OLD) }
  const remote = createFakeRemote({})
  const answers: Record<string, (data: any) => unknown> = {
    [LEDGER_CHANNELS.restoreList]: () => ({ folder: FOLDER, backups }),
    [LEDGER_CHANNELS.restorePlan]: ({ path }) => plans[path] ? { ok: true, value: plans[path] } : { ok: false, error: { code: 'RESTORE_FAILED', message: 'No plan' } },
    [LEDGER_CHANNELS.restoreRun]: options.run ?? (() => ({ ok: true, value: { ledger: { path: '/l/Restored.tessera', name: 'Restored', readOnly: false }, kept: '/l/Kept.tessera' } })),
    [LEDGER_CHANNELS.restoreBrowse]: () => ({ ok: true, value: undefined }),
    [LEDGER_CHANNELS.restoreFolder]: () => undefined
  }
  remote.bridge.invoke.mockImplementation(async (channel: string, data?: any) => {
    const answer = answers[channel]
    if (!answer) throw new Error(`No answer for ${channel}`)
    return answer(data)
  })
  ;(window as any).api = remote.bridge
  const close = vi.fn()
  const setBusy = vi.fn()
  render(<RestoreDialog input={options.preselect ? { preselect: options.preselect } : {}} close={close} setBusy={setBusy} />)
  const calls = (channel: string) => remote.bridge.invoke.mock.calls.filter((c: unknown[]) => c[0] === channel).map((c: unknown[]) => c[1])
  return { ...remote, answers, close, setBusy, calls }
}

/**
 * For waits on what the fake privileged side answers. Testing Library's default is 1 s, which the whole suite's load
 * can exceed (the list, then the chosen backup's plan), as other renderer tests found.
 */
const LOADED = { timeout: 5_000 }

const rows = () => within(screen.getByRole('list', { name: 'Backups' })).getAllByRole('button')
const restoreButton = () => screen.getByRole('button', { name: 'Restore' })
/** Replaces a field's text as a paste would. */
async function replaceText(field: HTMLElement, text: string) {
  await userEvent.clear(field)
  field.focus()
  await userEvent.paste(text)
}

describe('the Restore dialog', () => {
  it('says what an archive file holds: everything before its archive date', async () => {
    const archive: BackupInfo = { path: `${FOLDER}/Archives/Home (archive before 2026-01-01).tesserabkp`, ledgerName: 'Home', ledgerId: 'L1', takenAt: '2026-11-10T17:00:00.000Z', kind: 'archive', archiveBefore: '2026-01-01', size: 600 * 1024 }
    setup({ backups: [archive, HOME], plans: { [archive.path]: planFor(archive), [HOME.path]: planFor(HOME) } })
    await screen.findByText(`In “${FOLDER}”, newest first.`, {}, LOADED)
    expect(rows()[0].textContent).toBe(`“Home” — ${when(archive.takenAt)}Archive file: everything before ${displayDate('2026-01-01')} · 600 KB`)
    // The date alone, whatever the time zone: 1 January, not 31 December
    expect(displayDate('2026-01-01')).toMatch(/2026/)
    expect(displayDate('2026-01-01')).not.toMatch(/2025|31/)
  })

  it('lists the backups in the backup folder, newest first, with when, how and how big, and chooses the newest', async () => {
    setup({ backups: [HOME, OLD, BAD] })           // out of order: the dialog keeps its list newest first
    await screen.findByText(`In “${FOLDER}”, newest first.`, {}, LOADED)
    expect(rows().map(r => r.textContent)).toEqual([
      `“Home” — ${when(HOME.takenAt)}Backed up by hand · 24 KB`,
      `“Future” — ${when(BAD.takenAt)}${BAD.problem}`,
      `“Home” — ${when(OLD.takenAt)}Backed up automatically · 3.0 MB`
    ])
    await waitFor(() => expect(rows()[0]).toHaveClass('Mui-selected'), LOADED)
    expect(await screen.findByRole('textbox', { name: 'Name' }, LOADED)).toHaveValue('Home (restored 2026-11-09)')
    expect(screen.getByRole('textbox', { name: 'Folder' })).toHaveValue('/l')
  })

  it('restores as a new ledger by default, with the name given, and closes with the ledger and when the backup was taken', async () => {
    const { close, calls } = setup()
    const name = await screen.findByRole('textbox', { name: 'Name' }, LOADED)
    await replaceText(name, 'Home again')
    expect(screen.getByText('Saved as “Home again.tessera”.')).toBeInTheDocument()
    await userEvent.click(restoreButton())
    expect(calls(LEDGER_CHANNELS.restoreRun)).toEqual([{ backup: HOME.path, mode: 'new', folder: '/l', name: 'Home again' }])
    expect(close).toHaveBeenCalledWith({ ledger: expect.objectContaining({ name: 'Restored' }), kept: '/l/Kept.tessera', takenAt: HOME.takenAt })
  })

  it('restores in place of the ledger, keeping the current file under the name given, and says what happens', async () => {
    const { calls } = setup()
    await userEvent.click(await screen.findByRole('radio', { name: 'In place of “Home”' }, LOADED))
    const keepAs = screen.getByRole('textbox', { name: 'Keep the current file as' })
    expect(keepAs).toHaveValue('Home (before restore 2026-11-09 10-14)')
    expect(screen.getByText('“Home.tessera” is renamed to “Home (before restore 2026-11-09 10-14).tessera”, and the backup takes its name. Nothing is deleted.')).toBeInTheDocument()
    expect(screen.getByText('“Home” is open: it closes, and opens again as it was in this backup.')).toBeInTheDocument()
    await replaceText(keepAs, 'Home as it was')
    await userEvent.click(restoreButton())
    expect(calls(LEDGER_CHANNELS.restoreRun)).toEqual([{ backup: HOME.path, mode: 'inPlace', keepAs: 'Home as it was' }])
  })

  it('says why a backup can\'t be restored in place, and can\'t be restored at all', async () => {
    setup({ backups: [HOME, BAD], plans: { [HOME.path]: planFor(HOME, { unavailable: '“Home” isn’t on this computer, or has been moved or deleted. Restore it as a new ledger.' }) } })
    expect(await screen.findByRole('radio', { name: 'In place of “Home”' }, LOADED)).toBeDisabled()
    expect(screen.getByText('“Home” isn’t on this computer, or has been moved or deleted. Restore it as a new ledger.')).toBeInTheDocument()
    await userEvent.click(rows()[1])
    await waitFor(() => expect(restoreButton()).toBeDisabled(), LOADED)
    expect(screen.queryByRole('radio')).not.toBeInTheDocument()
  })

  it('shows a refused name on its field, and any other failure above the buttons', async () => {
    let answer: unknown = { ok: false, error: { code: 'INVALID', message: '“Home.tessera” is already in that folder. Choose another name.', field: 'name' } }
    const { close } = setup({ run: () => answer })
    await screen.findByRole('textbox', { name: 'Name' }, LOADED)
    await userEvent.click(restoreButton())
    expect(await screen.findByText('“Home.tessera” is already in that folder. Choose another name.', {}, LOADED)).toBeInTheDocument()
    answer = { ok: false, error: { code: 'RESTORE_FAILED', message: 'There isn’t enough space in “/l”.' } }
    await userEvent.click(restoreButton())
    expect(await screen.findByRole('alert', {}, LOADED)).toHaveTextContent('There isn’t enough space in “/l”.')
    expect(close).not.toHaveBeenCalled()
  })

  it('checks a name before sending it', async () => {
    const { calls } = setup()
    await replaceText(await screen.findByRole('textbox', { name: 'Name' }, LOADED), 'CON')
    await userEvent.click(restoreButton())
    expect(screen.getByText('“CON” is a name Windows keeps for itself. Choose another.')).toBeInTheDocument()
    expect(calls(LEDGER_CHANNELS.restoreRun)).toEqual([])
  })

  it('shows each step while it restores, busy, and lets nothing else be done meanwhile', async () => {
    const remote = setup({ run: () => new Promise(() => {}) })
    await screen.findByRole('textbox', { name: 'Name' }, LOADED)
    await userEvent.click(restoreButton())
    act(() => remote.emit(LEDGER_EVENTS.restoreProgress, { step: 'Copying the backup', done: 0.4 }))
    expect(screen.getByRole('status')).toHaveTextContent('Copying the backup…')
    expect(within(screen.getByRole('status')).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '40')
    act(() => remote.emit(LEDGER_EVENTS.restoreProgress, { step: 'Opening “Home”' }))
    expect(screen.getByRole('status')).toHaveTextContent('Opening “Home”…')
    expect(remote.setBusy).toHaveBeenCalledWith(true)
    expect(restoreButton()).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
  })

  it('adds a backup chosen with Browse…, and takes a folder chosen with Change…', async () => {
    const elsewhere: BackupInfo = { ...HOME, path: '/usb/Home copy.tesserabkp', takenAt: '2026-11-10T09:00:00.000Z' }
    const remote = setup({ plans: { [HOME.path]: planFor(HOME), [elsewhere.path]: planFor(elsewhere) } })
    remote.answers[LEDGER_CHANNELS.restoreBrowse] = () => ({ ok: true, value: elsewhere })
    remote.answers[LEDGER_CHANNELS.restoreFolder] = () => '/chosen'
    await screen.findByRole('textbox', { name: 'Name' }, LOADED)
    await userEvent.click(screen.getByRole('button', { name: 'Browse…' }))
    await waitFor(() => expect(rows()[0]).toHaveClass('Mui-selected'), LOADED)
    expect(rows()[0]).toHaveTextContent(when(elsewhere.takenAt))
    await userEvent.click(screen.getByRole('button', { name: 'Change…' }))
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Folder' })).toHaveValue('/chosen'), LOADED)
  })

  it('starts on the backup it was given', async () => {
    const { calls } = setup({ preselect: OLD.path })
    await waitFor(() => expect(rows()[1]).toHaveClass('Mui-selected'), LOADED)
    expect(calls(LEDGER_CHANNELS.restorePlan)[0]).toEqual({ path: OLD.path })
  })

  it('says when the folder has no backups', async () => {
    setup({ backups: [] })
    expect(await screen.findByText('There are no backups here. Choose one somewhere else with Browse….', {}, LOADED)).toBeInTheDocument()
  })
})
