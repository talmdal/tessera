// File › Restore from Backup…: the dialog chooses a backup and where it goes. It restores nothing itself.
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BOOK_CHANNELS, type BackupInfo, type RestoreDialogInput } from '@tessera/book-api'
import RestoreDialog, { groupBackups, sizeText } from '../../../../plugins/book/src/renderer/RestoreDialog'
import { createFakeRemote } from '../../../helpers/fakeBridge'

const FOLDER = '/home/kim/Documents/Tessera Backups'
const HOME = '01JD3K5V8Q2W4E6R8T0Y2U4A6B'
const RENTAL = '01JD3K5V8Q2W4E6R8T0Y2U4RRR'

const backup = (file: string, bookId: string, bookName: string, takenAt: string, more: Partial<BackupInfo> = {}): BackupInfo => ({
  file: `${FOLDER}/${file}`, sizeBytes: 2_200_000,
  header: { bookId, bookName, bookPath: `/home/kim/${bookName}.tessera`, takenAt, trigger: 'auto', app: 'book 0.1.0', engine: 'storage-sqlite', documents: 48211 },
  ...more
})

const LISTED: BackupInfo[] = [
  backup('Rental new.tessera-backup', RENTAL, 'Rental Property', '2026-11-19T20:00:00Z'),
  backup('Home new.tessera-backup', HOME, 'Home Finances', '2026-11-19T18:42:00Z'),
  backup('Home old.tessera-backup', HOME, 'Home Finances', '2026-11-12T20:03:00Z', { header: { ...backup('', HOME, 'Home Finances', '2026-11-12T20:03:00Z').header!, trigger: 'manual' } }),
  backup('Home future.tessera-backup', HOME, 'Home Finances', '2026-11-10T10:00:00Z', { problem: 'It was made by a newer version of Tessera. Update Tessera to restore it.' }),
  { file: `${FOLDER}/Junk.tessera-backup`, sizeBytes: 3, problem: 'This is not a Tessera backup.' }
]

function setup(input: Partial<RestoreDialogInput> = {}, answers: { list?: () => unknown, choose?: () => unknown } = {}) {
  const remote = createFakeRemote({})
  remote.bridge.invoke.mockImplementation(async (channel: string) => {
    if (channel === BOOK_CHANNELS.backupsList) return (answers.list ?? (() => LISTED))()
    if (channel === BOOK_CHANNELS.backupsChoose) return answers.choose?.()
    throw new Error(`No answer for ${channel}`)
  })
  ;(window as any).api = remote.bridge
  const close = vi.fn()
  render(<RestoreDialog input={{ open: { id: HOME, name: 'Home Finances', readOnly: false }, folder: FOLDER, ...input }} close={close} setBusy={vi.fn()} />)
  const calls = (channel: string) => remote.bridge.invoke.mock.calls.filter((c: unknown[]) => c[0] === channel).map((c: unknown[]) => c[1])
  return { close, calls }
}

afterEach(() => { delete (window as any).api })

const restoreButton = () => screen.getByRole('button', { name: 'Restore…' })
const radio = (name: RegExp) => screen.getByRole('radio', { name })
/** A backup's row, by its file: each row shows its path when hovered. */
const row = (file: string) => screen.getByTitle(file.startsWith('/') ? file : `${FOLDER}/${file}`)

describe('the list', () => {
  it('asks for the backups in the backup folder, and says which folder it is', async () => {
    const { calls } = setup()
    expect(screen.getByTestId('restore-folder')).toHaveTextContent(`Backups in ${FOLDER}`)
    await screen.findByRole('group', { name: 'Home Finances' })
    expect(calls(BOOK_CHANNELS.backupsList)).toEqual([{ folder: FOLDER }])
  })

  it('groups backups by book, the open book first, then files that can’t be read', async () => {
    setup()
    await screen.findByRole('group', { name: 'Home Finances' })
    expect(screen.getAllByRole('group').map(g => g.getAttribute('aria-label'))).toEqual(['Home Finances', 'Rental Property', 'Files that can’t be read'])
    const home = within(screen.getByRole('group', { name: 'Home Finances' })).getAllByRole('button')
    expect(home).toHaveLength(3)
    expect(home[1]).toHaveTextContent('made by you')
  })

  it('shows a backup that can’t be restored, with why, but won’t let it be chosen', async () => {
    setup()
    await screen.findByRole('group', { name: 'Home Finances' })
    const future = row('Home future.tessera-backup')
    expect(future).toHaveTextContent('made by a newer version of Tessera')
    expect(future).toHaveAttribute('aria-disabled', 'true')
    expect(within(screen.getByRole('group', { name: 'Files that can’t be read' })).getByRole('button')).toHaveTextContent('This is not a Tessera backup.')
  })

  it('says so when the folder has no backups', async () => {
    setup({}, { list: () => [] })
    expect(await screen.findByText(/There are no backups in this folder/)).toBeInTheDocument()
  })

  it('says so when the backups can’t be listed', async () => {
    setup({}, { list: () => { throw new Error('EACCES: permission denied') } })
    expect(await screen.findByText('The backups couldn’t be listed: EACCES: permission denied')).toBeInTheDocument()
  })
})

describe('choosing', () => {
  it('waits for a backup to be chosen, then describes it', async () => {
    setup()
    await screen.findByRole('group', { name: 'Home Finances' })
    expect(restoreButton()).toBeDisabled()
    await userEvent.click(row('Home new.tessera-backup'))
    expect(screen.getByTestId('restore-selected')).toHaveTextContent(/^Home Finances, taken .* by book 0\.1\.0 \(SQLite\)$/)
    expect(restoreButton()).toBeEnabled()
  })

  it('restores as a new book unless told otherwise, closing with the choice', async () => {
    const { close } = setup()
    await screen.findByRole('group', { name: 'Home Finances' })
    expect(radio(/Restore as a new book/)).toBeChecked()
    await userEvent.click(row('Home new.tessera-backup'))
    await userEvent.click(restoreButton())
    expect(close).toHaveBeenCalledWith({ file: `${FOLDER}/Home new.tessera-backup`, target: 'new' })
  })

  it('replaces the open book when asked, warning when the backup is of another book', async () => {
    const { close } = setup()
    await screen.findByRole('group', { name: 'Rental Property' })
    await userEvent.click(radio(/Replace the open book, “Home Finances”/))
    await userEvent.click(row('Rental new.tessera-backup'))
    expect(screen.getByTestId('restore-other-book')).toHaveTextContent('This backup is of “Rental Property”, not “Home Finances”.')
    await userEvent.click(restoreButton())
    expect(close).toHaveBeenCalledWith({ file: `${FOLDER}/Rental new.tessera-backup`, target: 'replace' })
  })

  it('offers no replacing without an open book, or with a read-only one', async () => {
    setup({ open: undefined })
    await screen.findByRole('group', { name: 'Home Finances' })
    expect(radio(/Replace the open book/)).toBeDisabled()
    expect(screen.getByText('No book is open.')).toBeInTheDocument()
  })

  it('offers no replacing of a read-only book', async () => {
    setup({ open: { id: HOME, name: 'Home Finances', readOnly: true } })
    await screen.findByRole('group', { name: 'Home Finances' })
    expect(radio(/Replace the open book/)).toBeDisabled()
    expect(screen.getByText('It is read-only, so it can’t be replaced.')).toBeInTheDocument()
  })

  it('picks a backup from anywhere with Browse…, listing and selecting it first', async () => {
    const picked = backup('Elsewhere.tessera-backup', HOME, 'Home Finances', '2026-10-01T09:00:00Z', { file: '/media/usb/Elsewhere.tessera-backup' })
    const { close } = setup({}, { choose: () => picked })
    await screen.findByRole('group', { name: 'Home Finances' })
    await userEvent.click(screen.getByRole('button', { name: 'Browse…' }))
    expect(screen.getAllByRole('group')[0]).toHaveAttribute('aria-label', 'Chosen file')
    await userEvent.click(restoreButton())
    expect(close).toHaveBeenCalledWith({ file: '/media/usb/Elsewhere.tessera-backup', target: 'new' })
  })

  it('changes nothing when Browse… is cancelled, and says so when it fails', async () => {
    let fail = false
    setup({}, { choose: () => { if (fail) throw new Error('No window'); return undefined } })
    await screen.findByRole('group', { name: 'Home Finances' })
    await userEvent.click(screen.getByRole('button', { name: 'Browse…' }))
    expect(screen.queryByRole('group', { name: 'Chosen file' })).toBeNull()
    fail = true
    await userEvent.click(screen.getByRole('button', { name: 'Browse…' }))
    expect(await screen.findByText('The backup couldn’t be chosen: No window')).toBeInTheDocument()
  })

  it('cancels with nothing', async () => {
    const { close } = setup()
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(close).toHaveBeenCalledWith()
  })
})

describe('helpers', () => {
  it('give sizes people read', () => {
    expect(sizeText(2_200_000)).toBe('2.1 MB')
    expect(sizeText(640 * 1024)).toBe('640 KB')
    expect(sizeText(10)).toBe('1 KB')
  })

  it('put the open book first and other books by their newest backup', () => {
    const groups = groupBackups(LISTED, RENTAL, undefined)
    expect(groups.map(g => g.title)).toEqual(['Rental Property', 'Home Finances', 'Files that can’t be read'])
  })
})
