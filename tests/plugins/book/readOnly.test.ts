// @vitest-environment node
// Books that declare themselves read-only (archives): how they open, what they refuse, and what they tell the
// shell. See docs/archive-design.md, "Opening an archive" (phase 0).
import { describe, expect, it, vi } from 'vitest'
import { BOOK_CONTEXT_KEYS, BOOK_META, isBookError, type ArchiveMarker } from '@tessera/book-api'
import { contributor, file, logger, memoryAppState, memoryBackupDisk, setupSession } from './harness'
import { pathBookId } from '../../../plugins/book/src/privileged/BookSessionImpl'
import { BookPublisher, archiveThroughText } from '../../../plugins/book/src/privileged/ipc'
import { Backups } from '../../../plugins/book/src/privileged/backups/Backups'
import { BackupLedger, LEDGER_KEY } from '../../../plugins/book/src/privileged/backups/BackupLedger'

const MARKER: ArchiveMarker = {
  of: '01JD3K5V8Q2W4E6R8T0Y2U4A6B',
  ofName: 'Home Finances',
  takenAt: '2026-11-20T10:14:02.771Z',
  through: '2026-01-01',
  app: 'book 0.1.0'
}

const failure = async (work: Promise<unknown>) => {
  const err = await work.then(() => undefined, e => e)
  expect(isBookError(err), String(err)).toBe(true)
  return err as { code: string, message: string }
}

/** Creates a book, closes it, and stamps it read-only (an archive when `marker` is given; `null` for the flag alone). */
async function frozen(env: ReturnType<typeof setupSession>, marker: ArchiveMarker | null = MARKER, name = 'Old.tessera') {
  const book = await env.session.create(file(name))
  if (!book) throw new Error('not created')
  await env.session.close()
  const meta = env.driver.databases.get(file(name))!.meta
  meta.set(BOOK_META.readOnly, true)
  if (marker) meta.set(BOOK_META.archive, marker)
  return file(name)
}

describe('opening a book that declares itself read-only', () => {
  it('opens it read-only, with the archive marker on BookInfo, and refuses writes', async () => {
    const env = setupSession()
    const target = await frozen(env)

    const book = await env.session.open(target)

    expect(book).toMatchObject({ path: target, name: 'Old', readOnly: true, archive: MARKER })
    const err = await env.session.createSubBook({ name: 'Rental', parentId: null }).then(() => undefined, e => e)
    expect(String(err)).toMatch(/read-only/i)
    expect((await env.session.tree()).subBooks).toEqual([])
  })

  it('is read-only with the flag alone: no marker means no archive', async () => {
    const env = setupSession()
    const target = await frozen(env, null)

    const book = await env.session.open(target)

    expect(book).toMatchObject({ readOnly: true })
    expect(book!.archive).toBeUndefined()
  })

  it('ignores an unusable archive marker, with a warning, and the book stays writable', async () => {
    const env = setupSession()
    const target = await frozen(env, null)
    env.driver.databases.get(target)!.meta.delete(BOOK_META.readOnly)
    env.driver.databases.get(target)!.meta.set(BOOK_META.archive, { through: 42 })

    const book = await env.session.open(target)

    expect(book).toMatchObject({ readOnly: false })
    expect(book!.archive).toBeUndefined()
    expect(env.log.warn).toHaveBeenCalledWith(expect.stringContaining('unusable archive marker'))
  })

  it('never writes a book id: one without an id is known by its path, and the file is untouched', async () => {
    const env = setupSession()
    const target = await frozen(env)
    env.driver.databases.get(target)!.meta.delete(BOOK_META.id)

    const book = await env.session.open(target)

    expect(book!.id).toBe(pathBookId(target))
    expect(env.driver.databases.get(target)!.meta.has(BOOK_META.id)).toBe(false)
  })

  it('keeps the id the archive carries', async () => {
    const env = setupSession()
    const target = await frozen(env)
    const stored = env.driver.databases.get(target)!.meta.get(BOOK_META.id)

    expect((await env.session.open(target))!.id).toBe(stored)
  })
})

describe('an archive and the contributors’ versions', () => {
  it('refuses an archive whose data needs a migration, before the open book closes', async () => {
    const env = setupSession()
    env.contribute(contributor('accounts', 2))
    const target = await frozen(env)
    env.driver.databases.get(target)!.meta.set(BOOK_META.schemaVersion('accounts'), 1)
    const home = await env.session.create(file('Home.tessera'))

    const err = await failure(env.session.open(target))

    expect(err.code).toBe('UNSUPPORTED_FILE')
    expect(err.message).toMatch(/archive made by an older version .* can’t be changed/i)
    expect(env.session.current).toEqual(home)
    expect(env.driver.databases.get(target)!.meta.get(BOOK_META.schemaVersion('accounts'))).toBe(1)
  })

  it('says “read-only”, not “archive”, for a flagged book that is not one', async () => {
    const env = setupSession()
    env.contribute(contributor('accounts', 2))
    const target = await frozen(env, null)
    env.driver.databases.get(target)!.meta.set(BOOK_META.schemaVersion('accounts'), 1)

    const err = await failure(env.session.open(target))
    expect(err.message).toMatch(/is read-only and was made by an older version/i)
  })

  it('opens when a newly installed plugin merely has nothing in it yet: seeding is skipped, not refused', async () => {
    const env = setupSession()
    const target = await frozen(env)
    const accounts = contributor('accounts', 1)
    env.contribute(accounts)

    const book = await env.session.open(target)

    expect(book).toMatchObject({ readOnly: true })
    expect(accounts.migrator.migrate).not.toHaveBeenCalled()
    expect(env.driver.databases.get(target)!.meta.has(BOOK_META.schemaVersion('accounts'))).toBe(false)
    expect(env.log.info).toHaveBeenCalledWith(expect.stringContaining('was not seeded'))
  })
})

describe('what the shell is told about an archive', () => {
  it('sets the archive context keys, with the cut-off as a person reads it', async () => {
    const env = setupSession()
    const keys = new Map<string, unknown>()
    const context = {
      contextKeys: { set: (key: string, value: unknown) => { keys.set(key, value) } },
      events: { emit: vi.fn() },
      logger: { ...logger(), log: vi.fn(), debug: vi.fn() }
    }
    const publisher = new BookPublisher(context as never, env.session, env.recent, env.disk.disk)
    await env.session.open(await frozen(env))

    publisher.publishState()

    expect(keys.get(BOOK_CONTEXT_KEYS.isReadOnly)).toBe(true)
    expect(keys.get(BOOK_CONTEXT_KEYS.isArchive)).toBe(true)
    expect(keys.get(BOOK_CONTEXT_KEYS.archiveThrough)).toMatch(/2026/)
    expect(keys.get(BOOK_CONTEXT_KEYS.name)).toBe('Old')
  })

  it('clears them for an ordinary book', async () => {
    const env = setupSession()
    const keys = new Map<string, unknown>()
    const context = {
      contextKeys: { set: (key: string, value: unknown) => { keys.set(key, value) } },
      events: { emit: vi.fn() },
      logger: logger()
    }
    const publisher = new BookPublisher(context as never, env.session, env.recent, env.disk.disk)
    await env.session.create(file('Home.tessera'))

    publisher.publishState()

    expect(keys.get(BOOK_CONTEXT_KEYS.isArchive)).toBe(false)
    expect(keys.get(BOOK_CONTEXT_KEYS.archiveThrough)).toBeUndefined()
  })

  it('reads the cut-off as a local date, never shifted a day by UTC', () => {
    expect(archiveThroughText('2026-01-01')).toMatch(/2026/)
    expect(archiveThroughText('2026-01-01')).not.toMatch(/Dec|12/)
    expect(archiveThroughText('not-a-date')).toBe('not-a-date')
  })
})

describe('an archive and automatic backups', () => {
  it('never takes one, even though the book has never been backed up', async () => {
    const env = setupSession()
    const target = await frozen(env)        // made before backups attach, so making it takes no backup
    const backupDisk = memoryBackupDisk()
    const state = memoryAppState()
    const backups = new Backups({
      disk: backupDisk.disk,
      ledger: new BackupLedger(state),
      files: { trash: vi.fn(), documentsPath: () => file('Documents') },
      options: () => ({ automatic: true, frequency: 'everyClose', folder: null, keep: 10 }),
      engineId: 'storage-memory',
      log: logger()
    })
    backups.attach(env.session)

    await env.session.open(target)
    await env.session.close()
    await backups.idle()

    expect(backupDisk.files.size).toBe(0)
    expect(backupDisk.writes).toEqual([])
    expect(state.values.get(LEDGER_KEY)).toBeUndefined()
  })
})
