// @vitest-environment node
// File › Archive Ledger…, through the activated plugin on a memory engine. The Archive dialog is played by the test:
// it makes the same requests the real dialog makes. The participant is a fake over its own collection (the accounts
// and import participants are tested with their plugins, and together in tests/plugins/ledger/sampleArchive.test.ts).
// See docs/ledger-compaction-design.md, "The archive, step by step".
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Transaction } from '@tessera/types'
import { StorageError } from '@tessera/storage-kit'
import {
  LEDGER_BACKUP_META, LEDGER_CHANNELS, LEDGER_COLLECTIONS, LEDGER_COMMANDS, LEDGER_CONTEXT_KEYS as K, LEDGER_DIALOGS, LEDGER_EVENTS, LEDGER_META,
  LEDGER_SCHEMA_POINT, displayDate,
  type ArchiveDialogInput, type ArchiveDialogResult, type ArchiveOutcome, type ArchiveParticipant, type ArchivePreview,
  type ArchiveRecord, type ArchiveRunRequest, type Result
} from '@tessera/ledger-api'
import { ArchiveService, archiveFileName } from '../../../plugins/ledger/src/privileged/archive/ArchiveService'
import { archivedMessage } from '../../../plugins/ledger/src/privileged/archive/command'
import { DIR, contributor, file } from './harness'
import { activateLedger, type LedgerPlugin, type PluginOptions } from './plugin'

/** Noon on 10 November 2026, local time. */
const NOW = new Date(2026, 10, 10, 12)
const FOLDER = path.join(DIR, 'Documents', 'Tessera Backups')
const ARCHIVES = path.join(FOLDER, 'Archives')
const COPY = path.join(ARCHIVES, 'Home (archive before 2026-01-01).tesserabkp')
const TIDY = 'things.tidy'

interface Thing { name: string, date: string }
/** Stands in for the database's snapshot; `real` makes the copy. */
type Snapshotting = (real: () => Promise<void>) => Promise<void>

/**
 * The plugin with "Home" open and a participant, "things": three things, dated 2024, 2025 and 2026. It archives the
 * things dated before the archive date, and offers one option, which it records.
 */
async function archiving(options: PluginOptions = {}, over: Partial<ArchiveParticipant> = {}, snapshot?: Snapshotting, compact?: () => Promise<void>) {
  const env = await activateLedger({ now: () => NOW, ...options })
  if (snapshot || compact) {
    // The ledger's database copies and compacts itself through its backend: wrapped before the ledger opens
    const open = env.driver.open.bind(env.driver)
    env.driver.open = async (target, how) => {
      const db = await open(target, how)
      const real = db.snapshot.bind(db)
      return Object.assign(db, {
        ...(snapshot && { snapshot: (...args: Parameters<typeof real>) => snapshot(() => real(...args)) }),
        ...(compact && { compact })
      })
    }
  }
  const made = contributor('things', 1)
  env.runtime.extensions.contribute('things', LEDGER_SCHEMA_POINT, 'things', made.contribution)
  env.runtime.services.provide('things', made.contribution.migrator, made.migrator)
  const home = await env.newLedger('Home.tessera')
  const things = () => env.session.database('things').collection<Thing>('things.things')
  for (const [name, date] of [['old', '2024-05-01'], ['last year', '2025-03-01'], ['this year', '2026-02-01']]) await things().insert({ name, date })

  const tidied: boolean[] = []
  const committed = vi.fn()
  const participant: ArchiveParticipant = {
    describe: async (before, chosen) => {
      const count = await things().count({ date: { $lt: before } })
      return {
        count, summary: `${count} ${count === 1 ? 'thing' : 'things'}`,
        ...(count === 2 && { warnings: [{ message: 'Two things go.', details: ['Both of them'] }] }),
        options: [{ id: TIDY, label: 'Tidy up too', default: chosen[TIDY] ?? false }]
      }
    },
    archive: async (tx: Transaction, request) => {
      tidied.push(request.options[TIDY] ?? false)
      const { deleted } = await tx.collection('things.things').deleteMany({ date: { $lt: request.before } })
      return { count: deleted, summary: `${deleted} ${deleted === 1 ? 'thing' : 'things'}` }
    },
    committed,
    ...over
  }
  env.session.participateInArchive('things', participant)

  const activity: unknown[] = []
  env.runtime.contextKeys.onDidChange(() => {
    const text = env.key(K.activity)
    if (activity.at(-1) !== text) activity.push(text)
  })
  const names = async () => (await things().find()).map(t => t.name).sort()
  /** The archives the ledger records, as stored. */
  const records = () => [...(env.driver.databases.get(file('Home.tessera'))?.collections.get(LEDGER_COLLECTIONS.archives)?.docs.values() ?? [])] as unknown as ArchiveRecord[]
  return { ...env, home, things, names, records, tidied, committed, activity }
}

/** The dialog's requests, as the real dialog makes them. */
const dialogOf = (env: LedgerPlugin) => ({
  preview: (request: ArchiveRunRequest) => env.ask(LEDGER_CHANNELS.archivePreview, request) as Promise<Result<ArchivePreview>>,
  run: (request: ArchiveRunRequest) => env.ask(LEDGER_CHANNELS.archiveRun, request) as Promise<Result<ArchiveOutcome>>
})
type Dialog = ReturnType<typeof dialogOf>

/**
 * Runs File › Archive Ledger… with the dialog played by `play`, which returns what the dialog closes with. Resolves what
 * the command resolved, the dialog's input, and what `play` recorded.
 */
async function archiveWith<T>(env: LedgerPlugin, play: (dialog: Dialog, input: ArchiveDialogInput) => Promise<{ result?: ArchiveDialogResult, seen?: T }>) {
  let seen: T | undefined
  let input: ArchiveDialogInput | undefined
  env.prompts.show.mockImplementationOnce(async (...shown: unknown[]) => {
    if (shown[0] !== LEDGER_DIALOGS.archive) throw new Error(`Unexpected dialog ${String(shown[0])}`)
    input = shown[1] as ArchiveDialogInput
    const played = await play(dialogOf(env), input)
    seen = played.seen
    return played.result
  })
  const outcome = await env.run<ArchiveOutcome | undefined>(LEDGER_COMMANDS.archive)
  return { outcome, input: input!, seen }
}

/** Plays the dialog as a user who accepts the suggested date: it looks, then archives. */
const accepting = (options: Record<string, boolean> = {}) => async (dialog: Dialog, input: ArchiveDialogInput) => {
  const preview = await dialog.preview({ before: input.suggestedBefore, options })
  const ran = await dialog.run({ before: input.suggestedBefore, options })
  return { result: ran.ok ? ran.value : undefined, seen: { preview, ran } }
}

const steps = (env: LedgerPlugin) => env.events.filter(e => e.name === LEDGER_EVENTS.archiveProgress).map(e => e.data.step as string)
  .filter((step, i, all) => step !== all[i - 1])

const filesIn = (env: LedgerPlugin, folder: string) =>
  [...env.driver.databases.keys()].filter(f => path.dirname(f) === folder).map(f => path.basename(f)).sort()

const metaOf = (env: LedgerPlugin, at: string) => Object.fromEntries(env.driver.databases.get(at)?.meta ?? [])

/** What a file's `things.things` holds, by name. */
const thingsIn = (env: LedgerPlugin, at: string) =>
  [...(env.driver.databases.get(at)?.collections.get('things.things')?.docs.values() ?? [])].map(d => (d as unknown as Thing).name).sort()

describe('File › Archive Ledger…', () => {
  it('opens the dialog on the suggested date, then copies the ledger into Archives and removes what went before', async () => {
    const env = await archiving()

    const { outcome, input, seen } = await archiveWith(env, accepting())

    expect(input).toEqual({ ledgerName: 'Home', suggestedBefore: '2026-01-01', today: '2026-11-10' })
    expect(seen?.preview).toEqual({ ok: true, value: {
      before: '2026-01-01', count: 2,
      parts: [{ contributor: 'things', count: 2, summary: '2 things', warnings: [{ message: 'Two things go.', details: ['Both of them'] }], options: [{ id: TIDY, label: 'Tidy up too', default: false }] }],
      copy: { name: 'Home (archive before 2026-01-01)', folder: ARCHIVES }
    } })
    expect(outcome).toEqual({
      before: '2026-01-01', archivedAt: NOW.toISOString(), copy: { path: COPY, takenAt: NOW.toISOString() }, count: 2, summaries: ['2 things'],
      compaction: { before: expect.any(Number), after: expect.any(Number) }
    })
    // The ledger keeps what is on or after the date; the archive file has everything
    expect(await env.names()).toEqual(['this year'])
    expect(thingsIn(env, COPY)).toEqual(['last year', 'old', 'this year'])
    expect(env.committed).toHaveBeenCalledOnce()
    expect(env.records()).toEqual([expect.objectContaining({ before: '2026-01-01', copy: outcome!.copy, count: 2 })])
    expect(steps(env)).toEqual(['copying', 'checking', 'removing', 'compacting'])
    // The ledger stays open, and the operation is over
    expect(env.session.current?.path).toBe(file('Home.tessera'))
    expect(env.session.operation).toBeUndefined()
  })

  it('makes the archive file as a checked backup of kind archive, saying what it holds', async () => {
    const env = await archiving()
    await archiveWith(env, accepting())

    expect(metaOf(env, COPY)).toMatchObject({
      [LEDGER_META.id]: env.home.id, [LEDGER_BACKUP_META.kind]: 'archive', [LEDGER_BACKUP_META.archiveBefore]: '2026-01-01',
      [LEDGER_BACKUP_META.takenAt]: NOW.toISOString(), [LEDGER_BACKUP_META.ledgerName]: 'Home', [LEDGER_BACKUP_META.ledgerPath]: file('Home.tessera')
    })
    // The ledger itself is no backup
    expect(metaOf(env, file('Home.tessera'))).not.toHaveProperty(LEDGER_BACKUP_META.kind)
    expect(filesIn(env, ARCHIVES)).toEqual(['Home (archive before 2026-01-01).tesserabkp'])
    expect([...env.driver.databases.keys()].filter(f => f.endsWith('.partial'))).toEqual([])
  })

  it('names a second archive file with the same date “(2)”, keeping the first', async () => {
    const env = await archiving()
    await archiveWith(env, accepting())
    await env.things().insert({ name: 'late entry', date: '2025-12-31' })

    const { outcome, seen } = await archiveWith(env, accepting())

    expect((seen?.preview as Result<ArchivePreview>)).toMatchObject({ ok: true, value: { count: 1, copy: { name: 'Home (archive before 2026-01-01) (2)', folder: ARCHIVES } } })
    expect(outcome?.copy.path).toBe(path.join(ARCHIVES, 'Home (archive before 2026-01-01) (2).tesserabkp'))
    expect(filesIn(env, ARCHIVES)).toEqual(['Home (archive before 2026-01-01) (2).tesserabkp', 'Home (archive before 2026-01-01).tesserabkp'])
    expect(thingsIn(env, COPY)).toEqual(['last year', 'old', 'this year'])
  })

  it('tells the user what was archived and where the archive file is, and shows it in the status bar', async () => {
    const env = await archiving()
    await archiveWith(env, accepting())

    expect(env.prompts.message).toHaveBeenCalledWith({
      kind: 'info', title: 'Archive Ledger', message: '“Home” has been archived.',
      detail: `Removed, all dated before ${displayDate('2026-01-01')}: 2 things. Each account’s balance was carried into its opening balance, so every balance is as it was. ` +
        `The archived transactions are in the archive file “Home (archive before 2026-01-01).tesserabkp”, in “${ARCHIVES}”. To see them, open that file with File › Open Ledger….`
    })
    expect(env.activity.at(-1)).toBe(`Archived “Home” before ${displayDate('2026-01-01')}`)
  })

  it('puts the last archive in the dialog, and suggests the date the settings give', async () => {
    const env = await archiving({ settings: { 'ledger.archive': { yearStartMonth: 4, yearStartDay: 6, keepYears: 1 } } })
    await env.run(LEDGER_COMMANDS.archive, { before: '2025-01-01' })

    const { input } = await archiveWith(env, async () => ({}))

    expect(input).toEqual({
      ledgerName: 'Home', suggestedBefore: '2025-04-06', today: '2026-11-10',
      lastArchive: { before: '2025-01-01', archivedAt: NOW.toISOString() }
    })
  })

  it('sends the options the user chose, and refuses any the participants don\'t offer', async () => {
    const env = await archiving()
    const { seen } = await archiveWith(env, async (dialog, input) => {
      const unknown = await dialog.preview({ before: input.suggestedBefore, options: { 'accounts.nope': true } })
      const notBoolean = await dialog.run({ before: input.suggestedBefore, options: { [TIDY]: 'yes' as never } })
      const ran = await dialog.run({ before: input.suggestedBefore, options: { [TIDY]: true } })
      return { result: ran.ok ? ran.value : undefined, seen: { unknown, notBoolean } }
    })
    expect(seen?.unknown).toEqual({ ok: false, error: { code: 'INVALID', field: 'options', message: 'The archive has no option “accounts.nope”.' } })
    expect(seen?.notBoolean).toEqual({ ok: false, error: { code: 'INVALID', field: 'options', message: 'The archive’s options must each be on or off.' } })
    expect(env.tidied).toEqual([true])
  })

  it('refuses a date after today, a date that isn\'t one, and a date with nothing to archive, making nothing', async () => {
    const env = await archiving()
    const { seen } = await archiveWith(env, async dialog => ({
      seen: [
        await dialog.preview({ before: '2026-11-11' }), await dialog.run({ before: '2026-11-11' }),
        await dialog.preview({ before: '2026-02-30' }), await dialog.run({ before: '2024-01-01' }),
        // Today itself is a date to archive before
        await dialog.preview({ before: '2026-11-10' })
      ]
    }))
    expect(seen).toEqual([
      { ok: false, error: { code: 'INVALID', field: 'before', message: 'The date to archive before can’t be after today.' } },
      { ok: false, error: { code: 'INVALID', field: 'before', message: 'The date to archive before can’t be after today.' } },
      { ok: false, error: { code: 'INVALID', field: 'before', message: 'Enter the date to archive before.' } },
      { ok: false, error: { code: 'INVALID', field: 'before', message: `There is nothing to archive before ${displayDate('2024-01-01')}.` } },
      { ok: true, value: expect.objectContaining({ before: '2026-11-10', count: 3 }) }
    ])
    // Refused before anything was copied
    expect(steps(env)).toEqual([])
    expect(await env.names()).toEqual(['last year', 'old', 'this year'])
    expect(filesIn(env, ARCHIVES)).toEqual([])
    expect(env.prompts.message).not.toHaveBeenCalled()
  })

  it('does nothing when the dialog is cancelled', async () => {
    const env = await archiving()
    const { outcome } = await archiveWith(env, async (dialog, input) => {
      await dialog.preview({ before: input.suggestedBefore })
      return {}
    })
    expect(outcome).toBeUndefined()
    expect(await env.names()).toEqual(['last year', 'old', 'this year'])
    expect(filesIn(env, ARCHIVES)).toEqual([])
    expect(env.prompts.message).not.toHaveBeenCalled()
    expect(env.session.operation).toBeUndefined()
  })

  it('still reports an archive that finished after the dialog\'s window closed', async () => {
    const env = await archiving()
    let finished!: Promise<Result<ArchiveOutcome>>
    const { outcome } = await archiveWith(env, async (dialog, input) => {
      finished = dialog.run({ before: input.suggestedBefore })
      return {}                       // the window closes at once
    })
    expect(await finished).toMatchObject({ ok: true })
    expect(outcome).toMatchObject({ before: '2026-01-01', count: 2 })
    expect(env.prompts.message).toHaveBeenCalledWith(expect.objectContaining({ message: '“Home” has been archived.' }))
    expect(await env.names()).toEqual(['this year'])
  })
})

describe('the Archive dialog\'s requests', () => {
  it('are answered only while File › Archive Ledger… has the dialog open', async () => {
    const env = await archiving()
    const closed = { ok: false, error: { code: 'INVALID', message: 'File › Archive Ledger… isn’t open.' } }
    expect(await env.ask(LEDGER_CHANNELS.archivePreview, { before: '2026-01-01' })).toEqual(closed)
    expect(await env.ask(LEDGER_CHANNELS.archiveRun, { before: '2026-01-01' })).toEqual(closed)
    await archiveWith(env, async () => ({}))
    expect(await env.ask(LEDGER_CHANNELS.archiveRun, { before: '2026-01-01' })).toEqual(closed)
    expect(await env.names()).toEqual(['last year', 'old', 'this year'])
  })

  it('run one archive at a time', async () => {
    const env = await archiving()
    const { seen } = await archiveWith(env, async (dialog, input) => {
      const [first, second] = await Promise.all([dialog.run({ before: input.suggestedBefore }), dialog.run({ before: input.suggestedBefore })])
      return { result: first.ok ? first.value : undefined, seen: second }
    })
    expect(seen).toEqual({ ok: false, error: { code: 'BUSY', message: 'An archive is already being made.' } })
    expect(filesIn(env, ARCHIVES)).toEqual(['Home (archive before 2026-01-01).tesserabkp'])
  })
})

describe('when archiving fails', () => {
  it('deletes the archive file when the removal fails, leaving the ledger as it was', async () => {
    const env = await archiving({}, { archive: async () => { throw new Error('boom') } })

    const { outcome, seen } = await archiveWith(env, accepting())

    expect(outcome).toBeUndefined()
    expect((seen as { ran: unknown }).ran).toEqual({ ok: false, error: { code: 'ARCHIVE_FAILED', message: 'Nothing was archived. boom' } })
    expect(await env.names()).toEqual(['last year', 'old', 'this year'])
    expect(filesIn(env, ARCHIVES)).toEqual([])
    expect(env.records()).toEqual([])
  })

  it('removes nothing when the archive file can\'t be made', async () => {
    const env = await archiving({}, {}, async () => { throw new Error('the disk is full') })

    const { seen } = await archiveWith(env, accepting())

    expect((seen as { ran: Result<unknown> }).ran).toMatchObject({ ok: false, error: { code: 'ARCHIVE_FAILED', message: expect.stringMatching(/^The archive file couldn’t be made, so nothing was archived\. .*the disk is full/) } })
    expect(await env.names()).toEqual(['last year', 'old', 'this year'])
    expect(filesIn(env, ARCHIVES)).toEqual([])
  })

  it('copies the ledger again, once, if it changed while it was being copied', async () => {
    let copies = 0
    const env: Awaited<ReturnType<typeof archiving>> = await archiving({}, {}, async real => {
      await real()
      // Something else writes while the first copy is made: that copy doesn't have it
      if (++copies === 1) await env.things().insert({ name: 'written meanwhile', date: '2024-12-01' })
    })

    const { outcome } = await archiveWith(env, accepting())

    expect(copies).toBe(2)
    expect(outcome).toMatchObject({ count: 3, copy: { path: COPY } })
    expect(thingsIn(env, COPY)).toEqual(['last year', 'old', 'this year', 'written meanwhile'])
    expect(filesIn(env, ARCHIVES)).toEqual(['Home (archive before 2026-01-01).tesserabkp'])
    expect(env.log.info).toHaveBeenCalledWith(expect.stringContaining('changed while it was being copied'))
  })

  it('gives up if the ledger changes while it is copied a second time, leaving no archive file', async () => {
    let copies = 0
    const env: Awaited<ReturnType<typeof archiving>> = await archiving({}, {}, async real => {
      await real()
      await env.things().insert({ name: `written meanwhile ${++copies}`, date: '2024-12-01' })
    })

    const { seen } = await archiveWith(env, accepting())

    expect(copies).toBe(2)
    expect((seen as { ran: Result<unknown> }).ran).toMatchObject({ ok: false, error: { code: 'CONFLICT' } })
    expect(filesIn(env, ARCHIVES)).toEqual([])
    expect(await env.names()).toEqual(['last year', 'old', 'this year', 'written meanwhile 1', 'written meanwhile 2'])
  })
})

describe('compacting the ledger\'s file', () => {
  it('is the last step, after the removal, with the ledger\'s size on disk before and after', async () => {
    const order: string[] = []
    const env: Awaited<ReturnType<typeof archiving>> = await archiving({}, {}, undefined, async () => { order.push(`compacted, ${(await env.names()).length} left`) })
    const { outcome } = await archiveWith(env, accepting())
    expect(order).toEqual(['compacted, 1 left'])
    // The memory disk's size is its contents', which the removal already made smaller
    expect(outcome?.compaction).toEqual({ before: expect.any(Number), after: expect.any(Number) })
    expect(env.log.info).toHaveBeenCalledWith(expect.stringMatching(/^\[ledger\] Compacted .*Home\.tessera: \d+ bytes before, \d+ after$/))
  })

  it('never fails the archive: the problem is logged and said, and everything stays archived', async () => {
    const env = await archiving({}, {}, undefined, async () => {
      // As the SQLite driver refuses it, before touching the file
      throw new StorageError('IO', 'there isn’t enough free space on the disk to compact it (about 72 MB is needed, and 40 MB is free)')
    })

    const { outcome } = await archiveWith(env, accepting())

    expect(outcome).toMatchObject({ count: 2, compaction: { problem: 'there isn’t enough free space on the disk to compact it (about 72 MB is needed, and 40 MB is free)' } })
    expect(await env.names()).toEqual(['this year'])
    expect(env.records()).toHaveLength(1)
    expect(filesIn(env, ARCHIVES)).toEqual(['Home (archive before 2026-01-01).tesserabkp'])
    expect(env.log.warn).toHaveBeenCalledWith(expect.stringContaining('Could not compact'))
    expect(env.prompts.message).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'info',
      detail: expect.stringMatching(/The ledger’s file couldn’t be made smaller: there isn’t enough free space on the disk to compact it \(about 72 MB is needed, and 40 MB is free\)\. Everything was archived all the same\.$/)
    }))
  })

  it('says how much smaller the file is, when it is', () => {
    const outcome: ArchiveOutcome = { before: '2025-01-01', archivedAt: NOW.toISOString(), copy: { path: COPY, takenAt: NOW.toISOString() }, count: 7, summaries: ['7 things'] }
    const detail = (compaction?: ArchiveOutcome['compaction']) => archivedMessage('Home', { ...outcome, ...(compaction && { compaction }) }).detail
    expect(detail({ before: 79.1 * 1024 * 1024, after: 7.6 * 1024 * 1024 })).toMatch(/ The ledger’s file is now 7\.6 MB, down from 79\.1 MB\.$/)
    expect(detail({ before: 600 * 1024, after: 600 * 1024 })).toMatch(/File › Open Ledger…\.$/)
    expect(detail()).toMatch(/File › Open Ledger…\.$/)
  })
})

describe('the archive file and backups', () => {
  it('isn\'t the ledger\'s latest backup, so closing the ledger still backs it up', async () => {
    const env = await archiving()
    env.files.showSaveDialog.mockImplementation(async options => options?.defaultPath)
    const manual = await env.run<string>(LEDGER_COMMANDS.backup)
    const last = env.state.values.get('ledger.backup.last')

    await archiveWith(env, accepting())

    expect(env.state.values.get('ledger.backup.last')).toEqual(last)
    expect((last as Record<string, { path: string }>)[env.home.id!].path).toBe(manual)
    await env.run(LEDGER_COMMANDS.close)
    const auto = filesIn(env, FOLDER).filter(f => f !== path.basename(manual))
    expect(auto).toHaveLength(1)
    expect(metaOf(env, path.join(FOLDER, auto[0]))).toMatchObject({ [LEDGER_BACKUP_META.kind]: 'auto' })
    // The archive file is untouched by retention and by the backup
    expect(filesIn(env, ARCHIVES)).toEqual(['Home (archive before 2026-01-01).tesserabkp'])
  })
})

describe('the command', () => {
  it('archives without the dialog when given a date, with the participants\' default options', async () => {
    const env = await archiving()

    const outcome = await env.run<ArchiveOutcome>(LEDGER_COMMANDS.archive, { before: '2025-01-01' })

    expect(env.prompts.show).not.toHaveBeenCalled()
    expect(outcome).toMatchObject({ before: '2025-01-01', count: 1, copy: { path: path.join(ARCHIVES, 'Home (archive before 2025-01-01).tesserabkp') } })
    expect(env.tidied).toEqual([false])
    expect(await env.names()).toEqual(['last year', 'this year'])
    expect(env.prompts.message).toHaveBeenCalledWith(expect.objectContaining({ kind: 'info', message: '“Home” has been archived.' }))
  })

  it('says why when given a date it can\'t archive before, and refuses an argument that isn\'t one', async () => {
    const env = await archiving()
    expect(await env.run(LEDGER_COMMANDS.archive, { before: '2027-01-01' })).toBeUndefined()
    expect(env.prompts.message).toHaveBeenCalledWith({ kind: 'error', message: 'Could not archive the ledger.', detail: 'The date to archive before can’t be after today.' })
    await expect(env.run(LEDGER_COMMANDS.archive, { date: '2025-01-01' })).rejects.toThrow('ledger.archive needs { before }')
    expect(env.log.error).not.toHaveBeenCalled()
  })

  it('is enabled with a ledger open that can change and nothing else running', async () => {
    const env = await activateLedger({ now: () => NOW })
    expect(env.enabled(LEDGER_COMMANDS.archive)).toBe(false)
    await env.newLedger('Home.tessera')
    expect(env.enabled(LEDGER_COMMANDS.archive)).toBe(true)
    const importing = env.session.beginOperation('Importing statements')
    expect(env.enabled(LEDGER_COMMANDS.archive)).toBe(false)
    importing.dispose()
    expect(env.enabled(LEDGER_COMMANDS.archive)).toBe(true)
  })

  it('holds the ledger while the dialog is open, so nothing else opens, closes or backs it up', async () => {
    const env = await archiving()
    const { seen } = await archiveWith(env, async () => ({
      seen: { busy: env.key(K.isBusy), operation: env.session.operation, backUp: env.enabled(LEDGER_COMMANDS.backup), close: env.enabled(LEDGER_COMMANDS.close) }
    }))
    expect(seen).toEqual({ busy: true, operation: 'Archiving “Home”', backUp: false, close: false })
    expect(env.key(K.isBusy)).toBe(false)
  })
})

describe('the archive service', () => {
  it('names archive files by ledger and date, sortable and the same in every locale', () => {
    expect(archiveFileName('Home', '2026-01-01')).toBe('Home (archive before 2026-01-01)')
  })

  it('says what the archive did in the words of the message', () => {
    const outcome: ArchiveOutcome = { before: '2025-01-01', archivedAt: NOW.toISOString(), copy: { path: path.join(ARCHIVES, 'Home (archive before 2025-01-01).tesserabkp'), takenAt: NOW.toISOString() }, count: 7, summaries: ['5 transactions from 2 accounts', '2 import records'] }
    expect(archivedMessage('Home', outcome).detail).toContain(`Removed, all dated before ${displayDate('2025-01-01')}: 5 transactions from 2 accounts; 2 import records.`)
  })

  it('refuses to archive a ledger open read-only, or none', async () => {
    const service = (current: unknown) => new ArchiveService({
      session: { current } as never, backups: { folder: () => FOLDER } as never, disk: {} as never,
      settings: () => ({ yearStartMonth: 1, yearStartDay: 1, keepYears: 0 }), log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, now: () => NOW
    })
    await expect(service(undefined).dialogInput()).rejects.toMatchObject({ code: 'NO_LEDGER' })
    await expect(service({ name: 'Old', readOnly: true }).run('2026-01-01', {})).rejects.toMatchObject({ code: 'READ_ONLY', message: '“Old” is open read-only, so it can’t be archived.' })
  })
})
