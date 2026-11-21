// File › Archive…: the dialog gathers the cut-off and shows the plan; the main process runs the archive.
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { BOOK_CHANNELS, ok, fail, type ArchiveDialogInput, type ArchiveOutcome, type ArchivePlan } from '@tessera/book-api'
import ArchiveDialog, { dateProblem } from '../../../../plugins/book/src/renderer/ArchiveDialog'
import { createFakeRemote } from '../../../helpers/fakeBridge'

const INPUT: ArchiveDialogInput = {
  book: { name: 'Home Finances' },
  suggested: '2026-01-01',
  folder: '/home/kim/Documents/Tessera Archives',
  today: '2026-11-20',
  backupStale: true
}

const PLAN: ArchivePlan = {
  before: '2026-01-01', documents: 8625, removedIds: [],
  parts: [
    { contributor: 'recurring', describe: '213 recurring postings', documents: 213 },
    { contributor: 'exchange', describe: '0 import batches', documents: 0 },
    { contributor: 'accounts', describe: '8,412 transactions in 6 accounts', documents: 8412 }
  ],
  rows: [{ contributor: 'accounts', id: 'chq', label: 'Chequing', removed: 120, detail: 'Opening balance $1,234.56 as of 1 Jan 2026' }],
  warnings: [{ kind: 'unreconciled', message: 'Chequing: 14 transactions are not reconciled. They stay in the book.' }]
}

const OUTCOME: ArchiveOutcome = { file: '/a/Home Finances Archive through 2026-01-01.tessera', before: '2026-01-01', documents: 8625 }

function setup(input: Partial<ArchiveDialogInput> = {}, answers: { plan?: (args: unknown) => unknown, run?: (args: unknown) => unknown } = {}) {
  const remote = createFakeRemote({})
  remote.bridge.invoke.mockImplementation(async (channel: string, args?: unknown) => {
    if (channel === BOOK_CHANNELS.archivePlan) return (answers.plan ?? (() => ok(PLAN)))(args)
    if (channel === BOOK_CHANNELS.archiveRun) return (answers.run ?? (() => ok(OUTCOME)))(args)
    if (channel === BOOK_CHANNELS.chooseFolder) return '/mnt/elsewhere'
    throw new Error(`No answer for ${channel}`)
  })
  ;(window as any).api = remote.bridge
  const close = vi.fn()
  render(<ArchiveDialog input={{ ...INPUT, ...input }} close={close} setBusy={vi.fn()} />)
  const calls = (channel: string) => remote.bridge.invoke.mock.calls.filter((c: unknown[]) => c[0] === channel).map((c: unknown[]) => c[1])
  return { close, calls }
}

describe('the Archive dialog', () => {
  it('prefills the suggestion, shows the plan and the warnings, and runs with what was chosen', async () => {
    const env = setup()

    expect(screen.getByTestId('archive-before')).toHaveValue('2026-01-01')
    await waitFor(() => expect(screen.getByTestId('archive-plan')).toBeInTheDocument())
    expect(screen.getByTestId('archive-plan')).toHaveTextContent('213 recurring postings, 8,412 transactions in 6 accounts will be removed')
    expect(screen.getByText(/14 transactions are not reconciled/)).toBeInTheDocument()
    expect(screen.getByTestId('archive-file')).toHaveTextContent('Home Finances Archive through 2026-01-01.tessera')

    await userEvent.click(screen.getByRole('button', { name: 'Archive' }))

    await waitFor(() => expect(env.close).toHaveBeenCalledWith(OUTCOME))
    expect(env.calls(BOOK_CHANNELS.archiveRun)).toEqual([{ before: '2026-01-01', folder: INPUT.folder, backupFirst: true }])
  })

  it('shows the Details rows behind a disclosure, closed by default', async () => {
    setup()
    await waitFor(() => expect(screen.getByTestId('archive-plan')).toBeInTheDocument())
    expect(screen.queryByText('Opening balance $1,234.56 as of 1 Jan 2026')).not.toBeVisible()

    await userEvent.click(screen.getByRole('button', { name: 'Details…' }))

    expect(screen.getByText('Opening balance $1,234.56 as of 1 Jan 2026')).toBeVisible()
    expect(screen.getByText('Chequing')).toBeVisible()
  })

  it('disables Archive with the reason for a date out of range, and asks for no plan', async () => {
    const env = setup()
    await waitFor(() => expect(screen.getByTestId('archive-plan')).toBeInTheDocument())
    const planCalls = env.calls(BOOK_CHANNELS.archivePlan).length

    await userEvent.clear(screen.getByTestId('archive-before'))
    await userEvent.type(screen.getByTestId('archive-before'), '2027-01-01')

    expect(screen.getByText(/in the future/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Archive' })).toBeDisabled()
    expect(env.calls(BOOK_CHANNELS.archivePlan).length).toBe(planCalls)
  })

  it('shows a blocker and disables Archive', async () => {
    setup({}, { plan: () => ok({ ...PLAN, blocker: 'A reconciliation of “Chequing” is in progress.' }) })

    await waitFor(() => expect(screen.getByTestId('archive-blocker')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Archive' })).toBeDisabled()
  })

  it('stays open when the confirmation was cancelled, and when the run fails', async () => {
    const env = setup({}, { run: vi.fn().mockResolvedValueOnce(ok(null)).mockResolvedValueOnce(fail('ARCHIVE_CHANGED', 'The book changed. Try again.')) })
    await waitFor(() => expect(screen.getByTestId('archive-plan')).toBeInTheDocument())

    await userEvent.click(screen.getByRole('button', { name: 'Archive' }))
    expect(env.close).not.toHaveBeenCalled()

    await userEvent.click(screen.getByRole('button', { name: 'Archive' }))
    await waitFor(() => expect(screen.getByText('The book changed. Try again.')).toBeInTheDocument())
    expect(env.close).not.toHaveBeenCalled()
  })

  it('offers the backup checkbox only when the last backup is stale', async () => {
    setup({ backupStale: false }, {})
    await waitFor(() => expect(screen.getByTestId('archive-plan')).toBeInTheDocument())
    expect(screen.queryByText(/Back up “Home Finances” first/)).not.toBeInTheDocument()
  })

  it('browses to another folder and sends it with the run', async () => {
    const env = setup()
    await waitFor(() => expect(screen.getByTestId('archive-plan')).toBeInTheDocument())

    await userEvent.click(screen.getByRole('button', { name: 'Browse…' }))
    await waitFor(() => expect(screen.getByTestId('archive-file')).toHaveTextContent('/mnt/elsewhere'))
    expect(env.calls(BOOK_CHANNELS.chooseFolder)).toEqual([{
      current: INPUT.folder, defaultPath: INPUT.folder, title: 'Choose Archive Folder'
    }])

    await userEvent.click(screen.getByRole('button', { name: 'Archive' }))
    await waitFor(() => expect(env.calls(BOOK_CHANNELS.archiveRun)).toEqual([expect.objectContaining({ folder: '/mnt/elsewhere' })]))
  })

  it('says plainly when there is nothing to archive', async () => {
    setup({}, { plan: () => ok({ ...PLAN, documents: 0, parts: [], rows: [], warnings: [] }) })
    await waitFor(() => expect(screen.getByText(/nothing to archive before/)).toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Archive' })).toBeDisabled()
  })
})

describe('what counts as a usable date', () => {
  it('matches the main process’ rules', () => {
    const input = { today: '2026-11-20', lastArchivedThrough: '2025-01-01' }
    expect(dateProblem('2026-01-01', input)).toBeUndefined()
    expect(dateProblem('2026-11-21', input)).toMatch(/future/)
    expect(dateProblem('2025-01-01', input)).toMatch(/Already archived through/)
    expect(dateProblem('2024-06-01', input)).toMatch(/Already archived through/)
    expect(dateProblem('nonsense', input)).toBe('Enter a date.')
  })
})
