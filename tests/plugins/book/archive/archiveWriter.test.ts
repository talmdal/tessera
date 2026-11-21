// @vitest-environment node
// Writing an archive: a complete frozen copy of the open book, verified by being read back, with the working book
// left exactly as it was. See docs/archive-design.md, "The archive file".
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { BOOK_META, isBookError, type BookInfo } from '@tessera/book-api'
import { DIR, contributor, file, logger, memoryBackupDisk, setupSession } from '../harness'
import { ArchiveWriter } from '../../../../plugins/book/src/privileged/archive/ArchiveWriter'

const FOLDER = path.join(DIR, 'Documents', 'Tessera Archives')
const BEFORE = '2026-01-01'

const failure = async (work: Promise<unknown>) => {
  const err = await work.then(() => undefined, e => e)
  expect(isBookError(err), String(err)).toBe(true)
  return err as { code: string, message: string }
}

/** A session with a book open, some data in it, and a writer over the same memory engine. */
async function setup(options: { folderExists?: boolean } = {}) {
  const env = setupSession({ now: () => new Date('2026-11-20T10:14:02.771Z') })
  env.contribute(contributor('accounts', 1))
  const book = await env.session.create(file('Home Finances.tessera'))
  if (!book) throw new Error('not created')

  const things = env.session.database('accounts').collection<{ name: string, amount: number }>('accounts.things')
  for (let n = 0; n < 5; n++) await things.insert({ name: `thing ${n}`, amount: n * 100 })

  const folders = memoryBackupDisk()
  if (options.folderExists !== false) await folders.disk.makeFolder(FOLDER)

  const bookDisk = {
    exists: vi.fn(env.disk.disk.exists),
    renameWithSideFiles: vi.fn(env.disk.disk.renameWithSideFiles),
    removeWithSideFiles: vi.fn(env.disk.disk.removeWithSideFiles)
  }
  const probe = vi.fn(async (f: string) => { await env.session.exclusive(inside => inside.probe(f)) })
  const log = logger()
  const writer = new ArchiveWriter({
    engine: env.engine, bookDisk, folders: folders.disk, probe, log,
    now: () => new Date('2026-11-20T10:14:02.771Z'), app: 'book 0.1.0'
  })

  const write = (patch: Partial<{ before: string, folder: string, createFolder: boolean }> = {}) =>
    writer.write(env.session.unscopedDatabase(), env.session.current as BookInfo, { before: BEFORE, folder: FOLDER, ...patch })

  /** Everything in a stored "file", for comparing a book before and after. */
  const stored = (f: string) => structuredClone(env.driver.databases.get(f))
  const staged = () => [...env.driver.databases.keys()].filter(f => path.basename(f).includes('.archiving-'))

  return { ...env, book, writer, write, probe, bookDisk, folders, log, stored, staged }
}

describe('writing an archive', () => {
  it('writes a complete frozen copy, named for the book and the cut-off, and says what is in it', async () => {
    const env = await setup()

    const outcome = await env.write()

    expect(outcome.file).toBe(path.join(FOLDER, 'Home Finances Archive through 2026-01-01.tessera'))
    expect(outcome.marker).toEqual({
      of: env.book.id, ofName: 'Home Finances', takenAt: '2026-11-20T10:14:02.771Z', through: BEFORE, app: 'book 0.1.0'
    })
    expect(outcome.documents).toBe(5)

    const archive = env.driver.databases.get(outcome.file)!
    expect(archive.meta.get(BOOK_META.readOnly)).toBe(true)
    expect(archive.meta.get(BOOK_META.archive)).toEqual(outcome.marker)
    expect(archive.meta.get(BOOK_META.format)).toBe(1)
    expect(archive.meta.get(BOOK_META.schemaVersion('accounts'))).toBe(1)
  })

  it('gives the archive an id of its own, so it is never mistaken for the book it came from', async () => {
    const env = await setup()
    const outcome = await env.write()
    const id = env.driver.databases.get(outcome.file)!.meta.get(BOOK_META.id)

    expect(id).toEqual(expect.any(String))
    expect(id).not.toBe(env.book.id)
    expect(env.driver.databases.get(env.book.path)!.meta.get(BOOK_META.id)).toBe(env.book.id)
  })

  it('holds every document the book held, through the session’s own probe', async () => {
    const env = await setup()
    const before = await env.session.unscopedDatabase().snapshot()

    const outcome = await env.write()

    expect(env.probe).toHaveBeenCalledWith(outcome.file)
    // Opened as any book is opened: phase 0 makes it read-only, with its marker
    const opened = await env.session.open(outcome.file)
    expect(opened).toMatchObject({ readOnly: true, archive: outcome.marker })
    const archived = await env.session.unscopedDatabase().snapshot()
    expect(archived.collections).toEqual(before.collections)
  })

  it('leaves the working book exactly as it was', async () => {
    const env = await setup()
    const before = env.stored(env.book.path)

    await env.write()

    expect(env.stored(env.book.path)).toEqual(before)
    expect(env.session.current).toEqual(env.book)
  })

  it('counts up rather than overwriting an archive already there', async () => {
    const env = await setup()

    const first = await env.write()
    const second = await env.write()

    expect(path.basename(first.file)).toBe('Home Finances Archive through 2026-01-01.tessera')
    expect(path.basename(second.file)).toBe('Home Finances Archive through 2026-01-01 (2).tessera')
    expect(env.driver.databases.has(first.file)).toBe(true)
  })

  it('leaves no staging file behind', async () => {
    const env = await setup()
    await env.write()
    expect(env.staged()).toEqual([])
  })
})

describe('when an archive can’t be written', () => {
  it('refuses a cut-off that is not a date, before taking any copy', async () => {
    const env = await setup()
    const err = await failure(env.write({ before: '1 Jan 2026' }))
    expect(err.code).toBe('INVALID')
    expect(err.message).toMatch(/is not a date/)
    expect(env.folders.files.size).toBe(0)
    expect(env.staged()).toEqual([])
  })

  it('refuses a missing folder rather than inventing it, unless it is the default one', async () => {
    const env = await setup({ folderExists: false })

    const err = await failure(env.write())
    expect(err.message).toMatch(/isn’t there/)
    expect(env.staged()).toEqual([])

    const outcome = await env.write({ createFolder: true })
    expect(env.driver.databases.has(outcome.file)).toBe(true)
  })

  it('removes the staging file when it can’t be put in place, and changes nothing else', async () => {
    const env = await setup()
    const before = env.stored(env.book.path)
    env.bookDisk.renameWithSideFiles.mockRejectedValueOnce(new Error('EXDEV: cross-device link'))

    const err = await failure(env.write())

    expect(err.message).toMatch(/couldn’t be put in place.*EXDEV/)
    expect(env.staged()).toEqual([])
    expect(env.stored(env.book.path)).toEqual(before)
  })

  it('deletes an archive it cannot read back, and says nothing was removed from the book', async () => {
    const env = await setup()
    env.probe.mockRejectedValueOnce(new Error('“Home Finances Archive through 2026-01-01” is not a Tessera book.'))

    const err = await failure(env.write())

    expect(err.message).toMatch(/couldn’t be verified after writing, so it was deleted and nothing was removed/)
    expect(env.driver.databases.has(path.join(FOLDER, 'Home Finances Archive through 2026-01-01.tessera'))).toBe(false)
    expect(env.staged()).toEqual([])
  })

  it('deletes an archive whose contents don’t match what was copied', async () => {
    const env = await setup()
    // A drive that quietly loses a write: the file is a book, but not the one that was written
    env.probe.mockImplementationOnce(async (f: string) => {
      const docs = env.driver.databases.get(f)!.collections.get('accounts.things')!.docs
      for (const id of [...docs.keys()].slice(0, 2)) docs.delete(id)
    })

    const err = await failure(env.write())

    expect(err.message).toMatch(/holds 3 documents, not 5/)
    expect(env.driver.databases.has(path.join(FOLDER, 'Home Finances Archive through 2026-01-01.tessera'))).toBe(false)
  })
})
