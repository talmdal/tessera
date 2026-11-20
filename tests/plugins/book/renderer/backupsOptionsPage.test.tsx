// Tools ▸ Options ▸ Book ▸ Backups. The page edits the draft the options dialog owns, and shows the last backup's
// status, which it follows from the book but never puts in the draft.
import { useState } from 'react'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BOOK_CHANNELS, BOOK_EVENTS, BOOK_OPTIONS_DEFAULTS, type BackupStatus, type BookBackupOptions, type BookOptions
} from '@tessera/book-api'
import BackupsOptionsPage, { whenText } from '../../../../plugins/book/src/renderer/BackupsOptionsPage'
import { createFakeRemote } from '../../../helpers/fakeBridge'

const DEFAULT_FOLDER = '/home/kim/Documents/Tessera Backups'
const NEVER: BackupStatus = { book: { id: 'b1', name: 'Home Finances' }, defaultFolder: DEFAULT_FOLDER }

/**
 * The page is controlled: the dialog owns the draft and hands it back on every change, so the harness does the
 * same. `status` answers the status request; `choose` answers the folder picker.
 */
function setup(over: Partial<BookBackupOptions> = {}, options: {
  status?: BackupStatus, choose?: (data: any) => unknown, disabled?: boolean
} = {}) {
  const remote = createFakeRemote({})
  remote.bridge.invoke.mockImplementation(async (channel: string, data?: any) => {
    if (channel === BOOK_CHANNELS.backupsStatus) return options.status ?? NEVER
    if (channel === BOOK_CHANNELS.backupsChooseFolder) return options.choose?.(data)
    throw new Error(`No answer for ${channel}`)
  })
  ;(window as any).api = remote.bridge
  const onChange = vi.fn()
  const onValidityChange = vi.fn()

  function Host() {
    const [value, setValue] = useState<BookOptions>({ backups: { ...BOOK_OPTIONS_DEFAULTS.backups, ...over } })
    return (
      <BackupsOptionsPage
        value={value} defaults={BOOK_OPTIONS_DEFAULTS} disabled={options.disabled ?? false}
        onChange={next => { onChange(next); setValue(next) }}
        onValidityChange={onValidityChange} />
    )
  }
  render(<Host />)
  const calls = (channel: string) => remote.bridge.invoke.mock.calls.filter((c: unknown[]) => c[0] === channel).map((c: unknown[]) => c[1])
  return { onChange, onValidityChange, remote, calls }
}

/** The last value the page proposed. */
const proposed = (onChange: ReturnType<typeof vi.fn>): BookBackupOptions => onChange.mock.calls.at(-1)![0].backups

afterEach(() => { delete (window as any).api })

describe('what it shows', () => {
  it('opens on the stored values', async () => {
    setup({ automatic: true, frequency: 'weekly', keep: 25, folder: '/media/kim/USB/Backups' })
    expect(screen.getByRole('checkbox', { name: /Back up automatically when a book closes/ })).toBeChecked()
    expect(screen.getByRole('combobox', { name: 'How often' })).toHaveTextContent('Once a week')
    expect(screen.getByLabelText('Automatic backups to keep')).toHaveValue('25')
    expect(screen.getByTestId('backup-folder')).toHaveTextContent('/media/kim/USB/Backups')
    expect(screen.getByTestId('backup-folder')).not.toHaveTextContent('(the default)')
  })

  it('shows the default folder by its real path, once the book has said where that is', async () => {
    setup({ folder: null })
    await waitFor(() => expect(screen.getByTestId('backup-folder')).toHaveTextContent(`${DEFAULT_FOLDER} (the default)`))
    expect(screen.getByRole('button', { name: 'Use Default' })).toBeDisabled()
  })

  it('offers the four frequencies, and never "never": that is the checkbox', async () => {
    setup()
    await userEvent.click(screen.getByRole('combobox', { name: 'How often' }))
    expect(screen.getAllByRole('option').map(o => o.textContent)).toEqual([
      'Every time the book closes', 'Once a day', 'Once a week', 'Once a month'
    ])
  })

  it('disables the schedule, but not the folder, while automatic backups are off', () => {
    setup({ automatic: false })
    expect(screen.getByRole('combobox', { name: 'How often' })).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByLabelText('Automatic backups to keep')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Browse…' })).toBeEnabled()
  })

  it('disables everything while a commit is in flight', () => {
    setup({ folder: '/somewhere' }, { disabled: true })
    expect(screen.getByRole('checkbox', { name: /Back up automatically/ })).toBeDisabled()
    expect(screen.getByLabelText('Automatic backups to keep')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Browse…' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Use Default' })).toBeDisabled()
  })
})

describe('changing a setting', () => {
  it('proposes each change without applying it, keeping the rest of the value', async () => {
    const { onChange, calls, remote } = setup({ keep: 7, folder: '/x' })
    await userEvent.click(screen.getByRole('checkbox', { name: /Back up automatically/ }))
    expect(proposed(onChange)).toEqual({ automatic: false, frequency: 'daily', keep: 7, folder: '/x' })
    // Nothing but the status ever goes to the book here: the dialog commits options, not the page
    expect(calls(BOOK_CHANNELS.backupsStatus).length).toBeGreaterThan(0)
    expect(new Set(remote.bridge.invoke.mock.calls.map((c: unknown[]) => c[0]))).toEqual(new Set([BOOK_CHANNELS.backupsStatus]))
  })

  it('changes how often', async () => {
    const { onChange } = setup()
    await userEvent.click(screen.getByRole('combobox', { name: 'How often' }))
    await userEvent.click(screen.getByRole('option', { name: 'Every time the book closes' }))
    expect(proposed(onChange).frequency).toBe('everyClose')
  })

  it('takes a whole number to keep, showing exactly what was typed, and is invalid until it is in range', async () => {
    const { onChange, onValidityChange } = setup()
    const keep = screen.getByLabelText('Automatic backups to keep')
    await userEvent.clear(keep)
    expect(keep).toHaveValue('')
    expect(onValidityChange).toHaveBeenLastCalledWith(false)

    await userEvent.type(keep, '1.5')
    expect(keep).toHaveValue('1.5')
    expect(Number.isNaN(proposed(onChange).keep)).toBe(true)
    expect(onValidityChange).toHaveBeenLastCalledWith(false)

    await userEvent.clear(keep)
    await userEvent.type(keep, '0')
    expect(screen.getByText('Keep between 1 and 999.')).toBeInTheDocument()
    expect(onValidityChange).toHaveBeenLastCalledWith(false)

    await userEvent.clear(keep)
    await userEvent.type(keep, '30')
    expect(proposed(onChange).keep).toBe(30)
    expect(onValidityChange).toHaveBeenLastCalledWith(true)
  })
})

describe('choosing the folder', () => {
  it('asks the book to show the folder picker, starting in the current folder, and drafts the answer', async () => {
    const { onChange, calls } = setup({ folder: '/old/place' }, { choose: () => '/media/kim/USB/Backups' })
    await userEvent.click(screen.getByRole('button', { name: 'Browse…' }))
    expect(calls(BOOK_CHANNELS.backupsChooseFolder)).toEqual([{ current: '/old/place' }])
    expect(proposed(onChange).folder).toBe('/media/kim/USB/Backups')
    expect(screen.getByTestId('backup-folder')).toHaveTextContent('/media/kim/USB/Backups')
  })

  it('changes nothing when the picker is cancelled', async () => {
    const { onChange } = setup({ folder: null }, { choose: () => undefined })
    await userEvent.click(screen.getByRole('button', { name: 'Browse…' }))
    expect(onChange).not.toHaveBeenCalled()
  })

  it('says so when the picker fails, and changes nothing', async () => {
    const { onChange } = setup({}, { choose: () => { throw new Error('No window to show it in') } })
    await userEvent.click(screen.getByRole('button', { name: 'Browse…' }))
    expect(await screen.findByText(/The folder could not be chosen: No window to show it in/)).toBeInTheDocument()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('goes back to the default folder', async () => {
    const { onChange } = setup({ folder: '/media/kim/USB/Backups' })
    await userEvent.click(screen.getByRole('button', { name: 'Use Default' }))
    expect(proposed(onChange).folder).toBeNull()
    await waitFor(() => expect(screen.getByTestId('backup-folder')).toHaveTextContent(`${DEFAULT_FOLDER} (the default)`))
  })
})

describe('the last backup', () => {
  it('names the book, when it was backed up and the file', async () => {
    setup({}, { status: { ...NEVER, lastBackupAt: new Date().toISOString(), lastFile: `${DEFAULT_FOLDER}/Home Finances 2026-11-19 18.42.10.tessera-backup`, lastResult: 'ok' } })
    const line = await screen.findByTestId('last-backup')
    expect(line).toHaveTextContent(/^“Home Finances”: today at .+ · Home Finances 2026-11-19 18\.42\.10\.tessera-backup$/)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('says when a book has never been backed up, and when no book has been opened', async () => {
    setup()
    expect(await screen.findByText('“Home Finances” hasn’t been backed up yet.')).toBeInTheDocument()
  })

  it('says when no book has been opened at all', async () => {
    setup({}, { status: { defaultFolder: DEFAULT_FOLDER } })
    expect(await screen.findByText('No book has been opened yet.')).toBeInTheDocument()
  })

  it('warns when the last automatic backup failed, saying why', async () => {
    setup({}, { status: { ...NEVER, lastResult: 'failed', lastError: 'The backup folder “/media/kim/USB” can’t be found.' } })
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The last automatic backup failed: The backup folder “/media/kim/USB” can’t be found. It will be tried again the next time the book closes.')
  })

  it('reads as sentences even when the reason has no full stop of its own', async () => {
    setup({}, { status: { ...NEVER, lastResult: 'failed', lastError: 'ENOSPC: no space left on device' } })
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The last automatic backup failed: ENOSPC: no space left on device. It will be tried again the next time the book closes.')
  })

  it('warns when the last one was cut short at quit', async () => {
    setup({}, { status: { ...NEVER, lastResult: 'interrupted' } })
    expect(await screen.findByRole('alert')).toHaveTextContent(/cut short when Tessera quit/)
  })

  it('follows the book: a backup made while the page is open shows at once', async () => {
    const { remote } = setup()
    await screen.findByText('“Home Finances” hasn’t been backed up yet.')
    act(() => remote.emit(BOOK_EVENTS.backups, { ...NEVER, lastBackupAt: new Date().toISOString(), lastFile: '/b/Home.tessera-backup', lastResult: 'ok' }))
    expect(screen.getByTestId('last-backup')).toHaveTextContent(/today at .+ · Home\.tessera-backup/)
  })
})

describe('when a backup was', () => {
  const now = new Date(2026, 10, 19, 18, 50)
  it('says today and yesterday by name, and gives the date otherwise', () => {
    expect(whenText(new Date(2026, 10, 19, 9, 5).toISOString(), now)).toMatch(/^today at /)
    expect(whenText(new Date(2026, 10, 18, 23, 59).toISOString(), now)).toMatch(/^yesterday at /)
    expect(whenText(new Date(2026, 10, 12, 20, 3).toISOString(), now)).toMatch(/2026 at /)
    expect(whenText(new Date(2026, 0, 1, 0, 0).toISOString(), new Date(2026, 0, 1, 23, 0))).toMatch(/^today at /)
  })
})
