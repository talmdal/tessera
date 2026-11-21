import { useState } from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BOOK_CHANNELS, BOOK_OPTIONS_DEFAULTS,
  type ArchiveOptionsStatus, type BookArchiveOptions, type BookOptions, type BookState
} from '@tessera/book-api'
import ArchiveOptionsPage from '../../../../plugins/book/src/renderer/ArchiveOptionsPage'
import { createFakeRemote } from '../../../helpers/fakeBridge'

const DEFAULT_FOLDER = '/home/kim/Documents/Tessera Archives'
const STATUS: ArchiveOptionsStatus = { defaultFolder: DEFAULT_FOLDER }
const OPEN_BOOK: BookState = {
  isOpen: true,
  book: { id: 'b1', path: '/books/Home.tessera', name: 'Home Finances', readOnly: false }
}

function setup(over: Partial<BookArchiveOptions> = {}, options: {
  status?: ArchiveOptionsStatus, book?: BookState, choose?: (data: unknown) => unknown, disabled?: boolean
} = {}) {
  const remote = createFakeRemote({})
  remote.bridge.invoke.mockImplementation(async (channel: string, data?: unknown) => {
    if (channel === BOOK_CHANNELS.archiveStatus) return options.status ?? STATUS
    if (channel === BOOK_CHANNELS.state) return options.book ?? OPEN_BOOK
    if (channel === BOOK_CHANNELS.chooseFolder) return options.choose?.(data)
    throw new Error(`No answer for ${channel}`)
  })
  ;(window as any).api = remote.bridge
  const onChange = vi.fn()
  const onValidityChange = vi.fn()

  function Host() {
    const [value, setValue] = useState<BookOptions>({
      ...BOOK_OPTIONS_DEFAULTS, archive: { ...BOOK_OPTIONS_DEFAULTS.archive, ...over }
    })
    return (
      <ArchiveOptionsPage
        value={value} defaults={BOOK_OPTIONS_DEFAULTS} disabled={options.disabled ?? false}
        onChange={next => { onChange(next); setValue(next) }}
        onValidityChange={onValidityChange} />
    )
  }
  render(<Host />)
  const calls = (channel: string) => remote.bridge.invoke.mock.calls.filter((c: unknown[]) => c[0] === channel).map((c: unknown[]) => c[1])
  return { onChange, onValidityChange, calls }
}

const proposed = (onChange: ReturnType<typeof vi.fn>): BookArchiveOptions => onChange.mock.calls.at(-1)![0].archive

afterEach(() => { delete (window as any).api })

describe('the Archive options page', () => {
  it('previews the rule, the default folder and archive status', async () => {
    setup()
    expect(screen.getByRole('combobox', { name: 'Suggest archiving data before' })).toHaveTextContent('Start of this year')
    await waitFor(() => expect(screen.getByTestId('archive-folder')).toHaveTextContent(`${DEFAULT_FOLDER} (the default)`))
    expect(await screen.findByTestId('last-archived')).toHaveTextContent('“Home Finances” has never been archived.')
  })

  it('edits the suggestion as a draft rule and retains the other settings', async () => {
    const { onChange, onValidityChange } = setup({ removeReconciled: false })
    await userEvent.click(screen.getByRole('combobox', { name: 'Suggest archiving data before' }))
    await userEvent.click(screen.getByRole('option', { name: /Start of last year/ }))
    expect(proposed(onChange)).toEqual({
      suggest: 'startOfLastYear', folder: null, removeReconciled: false, removeVoided: true
    })
    expect(onValidityChange).toHaveBeenLastCalledWith(true)
  })

  it('shows copy-only guidance when neither removal option is selected', async () => {
    setup()
    await userEvent.click(screen.getByRole('checkbox', { name: 'Reconciled transactions' }))
    await userEvent.click(screen.getByRole('checkbox', { name: 'Voided transactions' }))
    expect(await screen.findByText('Archiving will copy the book without removing anything.')).toBeInTheDocument()
  })

  it('uses the generic folder picker with archive-specific defaults and drafts its result', async () => {
    const { onChange, calls } = setup({ folder: '/old/place' }, { choose: () => '/media/kim/Archives' })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Browse…' })).toBeEnabled())
    await userEvent.click(screen.getByRole('button', { name: 'Browse…' }))
    await waitFor(() => expect(calls(BOOK_CHANNELS.chooseFolder)).toEqual([{
      current: '/old/place', defaultPath: DEFAULT_FOLDER, title: 'Choose Archive Folder'
    }]))
    expect(proposed(onChange).folder).toBe('/media/kim/Archives')
  })

  it('offers the default folder again', async () => {
    const { onChange } = setup({ folder: '/media/kim/Archives' })
    await userEvent.click(screen.getByRole('button', { name: 'Use Default' }))
    expect(proposed(onChange).folder).toBeNull()
  })

  it('marks a folder returned by the picker invalid if it is not an absolute path', async () => {
    const { onValidityChange } = setup({}, { choose: () => 'relative/folder' })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Browse…' })).toBeEnabled())
    await userEvent.click(screen.getByRole('button', { name: 'Browse…' }))
    await waitFor(() => expect(onValidityChange).toHaveBeenLastCalledWith(false))
  })

  it('shows archive history from the active book, or prompts to open a book', async () => {
    setup({}, { book: { isOpen: true, book: { ...OPEN_BOOK.book!, archivedThrough: '2025-01-01' } } })
    expect(await screen.findByTestId('last-archived')).toHaveTextContent(/“Home Finances” was archived through .+ 2025\./)
  })

  it('prompts to open a book when there is no active book', async () => {
    setup({}, { book: { isOpen: false } })
    expect(await screen.findByTestId('last-archived')).toHaveTextContent('Open a book to see its archive history.')
  })
})
