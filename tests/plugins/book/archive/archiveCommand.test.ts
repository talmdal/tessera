// @vitest-environment node
// The headless `book.archive` command: it takes { before }, shows the plan as a confirmation, and runs the archiver.
import { describe, expect, it, vi } from 'vitest'
import { BOOK_COMMANDS, type ArchiveOutcome, type ArchivePlan, type BookInfo } from '@tessera/book-api'
import { registerArchiveCommands, confirmationDetail } from '../../../../plugins/book/src/privileged/archive/commands'
import type { Database } from '@tessera/types'
import { fakePrompts, logger } from '../harness'

const BOOK: BookInfo = { id: '01JD', path: '/books/Home.tessera', name: 'Home', readOnly: false }

const PLAN: ArchivePlan = {
  before: '2026-01-01', documents: 3, removedIds: ['t1', 't2'],
  parts: [
    { contributor: 'accounts', describe: '2 transactions in 1 account', documents: 2 },
    { contributor: 'recurring', describe: '1 recurring posting', documents: 1 },
    { contributor: 'exchange', describe: '0 import batches', documents: 0 }
  ],
  rows: [], warnings: [{ kind: 'unreconciled', message: 'Chequing: 1 transaction is not reconciled.' }]
}

function setup(plan: ArchivePlan = PLAN) {
  const commands = new Map<string, (args?: unknown) => Promise<unknown>>()
  const context = {
    commands: { register: (id: string, handler: (args?: unknown) => Promise<unknown>) => { commands.set(id, handler); return { dispose: () => {} } } },
    logger: logger()
  }
  const outcome: ArchiveOutcome = { file: '/archives/Home Archive through 2026-01-01.tessera', before: '2026-01-01', documents: 3 }
  const archiver = { plan: vi.fn(async () => plan), archive: vi.fn(async () => outcome) }
  const { prompts, answers } = fakePrompts()
  registerArchiveCommands(context as never, {
    session: { current: BOOK, unscopedDatabase: () => ({ meta: { get: async () => undefined } } as unknown as Database) },
    archiver, prompts,
    backups: { stale: vi.fn(async () => false) },
    folder: () => '/archives',
    defaultFolder: () => '/home/kim/Documents/Tessera Archives',
    archiveOptions: () => ({ suggest: 'startOfThisYear', folder: null, removeReconciled: true, removeVoided: true })
  })
  const run = (args?: unknown) => commands.get(BOOK_COMMANDS.archive)!(args)
  return { run, archiver, prompts, answers, outcome }
}

describe('the book.archive command', () => {
  it('confirms with the plan and the warnings, then archives and says where the copy went', async () => {
    const env = setup()

    const result = await env.run({ before: '2026-01-01' })

    expect(env.prompts.confirm).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringMatching(/Archive “Home” through .*2026\?/),
      destructive: true
    }))
    const detail = env.prompts.confirm.mock.calls[0][0].detail as string
    expect(detail).toContain('Removes 2 transactions in 1 account.')
    expect(detail).toContain('⚠ Chequing: 1 transaction is not reconciled.')
    expect(detail).not.toContain('0 import batches')
    expect(env.archiver.archive).toHaveBeenCalledWith({ before: '2026-01-01', removeReconciled: true, removeVoided: true }, {})
    expect(result).toEqual(env.outcome)
    expect(env.prompts.message).toHaveBeenCalledWith(expect.objectContaining({
      detail: expect.stringMatching(/3 records were removed .* No account’s balance changed\./)
    }))
  })

  it('does nothing when the user cancels', async () => {
    const env = setup()
    env.answers.push(false)

    expect(await env.run({ before: '2026-01-01' })).toBeUndefined()
    expect(env.archiver.archive).not.toHaveBeenCalled()
  })

  it('needs a usable date when given one at all', async () => {
    const env = setup()
    expect(await env.run({ before: 'January' })).toBeUndefined()
    expect(env.archiver.plan).not.toHaveBeenCalled()
    expect(env.prompts.message).toHaveBeenCalledWith(expect.objectContaining({ kind: 'error' }))
  })

  it('opens the Archive dialog when run with no arguments, with what it needs', async () => {
    const env = setup()
    env.prompts.show.mockResolvedValueOnce(env.outcome)

    const result = await env.run()

    expect(env.prompts.show).toHaveBeenCalledWith('book.dialog.archive', expect.objectContaining({
      book: { name: 'Home' }, folder: '/archives', backupStale: false,
      suggested: expect.stringMatching(/^\d{4}-01-01$/), today: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/)
    }))
    expect(result).toEqual(env.outcome)
    expect(env.archiver.archive).not.toHaveBeenCalled()      // the dialog runs it through its own channel
  })

  it('shows a blocker as the failure, without archiving', async () => {
    const env = setup({ ...PLAN, blocker: 'A reconciliation of “Chequing” is in progress.' })

    await env.run({ before: '2026-01-01' })

    expect(env.archiver.archive).not.toHaveBeenCalled()
    expect(env.prompts.message).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'error', detail: 'A reconciliation of “Chequing” is in progress.'
    }))
  })

  it('says plainly when there is nothing to archive', async () => {
    const env = setup({ ...PLAN, documents: 0, parts: [], warnings: [] })

    await env.run({ before: '2026-01-01' })

    expect(env.archiver.archive).not.toHaveBeenCalled()
    expect(env.prompts.confirm).not.toHaveBeenCalled()
    expect(env.prompts.message).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'info', message: expect.stringMatching(/nothing to archive before/)
    }))
  })
})

describe('the confirmation detail', () => {
  it('reads top to bottom: the promise, the parts, the warnings', () => {
    const detail = confirmationDetail(PLAN, 'Home')
    const lines = detail.split('\n')
    expect(lines[0]).toMatch(/complete copy of “Home” is saved first/)
    expect(detail.indexOf('Removes')).toBeLessThan(detail.indexOf('⚠'))
  })
})
