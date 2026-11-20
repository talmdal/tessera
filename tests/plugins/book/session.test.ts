// @vitest-environment node
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { BOOK_META, isBookError, type BookChange } from '@tessera/book-api'
import { DIR, contributor, file, setupSession } from './harness'
import { pathBookId } from '../../../plugins/book/src/privileged/BookSessionImpl'

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/

const failure = async (work: Promise<unknown>) => {
  const err = await work.then(() => undefined, e => e)
  expect(isBookError(err), String(err)).toBe(true)
  return err as { code: string, message: string }
}

describe('creating a book', () => {
  it('asks where to save it, suggesting the name in the documents folder, and opens it', async () => {
    const { session, files, driver } = setupSession()
    files.showSaveDialog.mockResolvedValueOnce(path.join(DIR, 'Home Finances'))   // typed without the extension

    const book = await session.create(undefined, { name: 'Home Finances' })

    expect(files.showSaveDialog).toHaveBeenCalledWith(expect.objectContaining({
      defaultPath: path.join(DIR, 'Documents', 'Home Finances.tessera'),
      filters: [{ name: 'Tessera book', extensions: ['tessera'] }]
    }))
    expect(book).toEqual({ id: expect.stringMatching(ULID), path: file('Home Finances.tessera'), name: 'Home Finances', readOnly: false })
    expect(session.current).toEqual(book)
    expect(driver.databases.has(file('Home Finances.tessera'))).toBe(true)
  })

  it('marks the file as a book and seeds every contributor (a migration from 0)', async () => {
    const { session, contribute, driver } = setupSession({ now: () => new Date('2026-11-04T10:00:00Z') })
    const accounts = contributor('accounts', 2)
    contribute(accounts)

    await session.create(file('Home.tessera'))

    expect(accounts.migrator.migrate.mock.calls.map(call => call[1])).toEqual([0, 1])
    const meta = driver.databases.get(file('Home.tessera'))!.meta
    expect(meta.get(BOOK_META.format)).toBe(1)
    expect(meta.get(BOOK_META.createdAt)).toBe('2026-11-04T10:00:00.000Z')
    expect(meta.get(BOOK_META.schemaVersion('accounts'))).toBe(2)
  })

  it('does nothing when the save dialog is cancelled', async () => {
    const { session, files, driver } = setupSession()
    expect(await session.create()).toBeUndefined()
    expect(files.showSaveDialog).toHaveBeenCalled()
    expect(driver.databases.size).toBe(0)
  })

  it('asks to close the open book first; Cancel leaves it open and asks nothing else', async () => {
    const { session, created, prompts, answers, files } = setupSession()
    const home = await created()
    answers.push(false)

    expect(await session.create()).toBeUndefined()

    expect(prompts.confirm).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Close “Home” and create a new book?', confirmLabel: 'Close and Create'
    }))
    expect(files.showSaveDialog).not.toHaveBeenCalled()
    expect(session.current).toEqual(home)
  })

  it('closes the open book only once the new file is chosen', async () => {
    const { session, created, files } = setupSession()
    await created()
    files.showSaveDialog.mockResolvedValueOnce(undefined)
    await session.create()
    expect(session.current?.name).toBe('Home')      // cancelled in the save dialog: still open

    files.showSaveDialog.mockResolvedValueOnce(file('Other.tessera'))
    await session.create()
    expect(session.current?.name).toBe('Other')
  })

  it('sends a file it replaces to the trash, side files included, rather than deleting it', async () => {
    const { session, disk, trashed } = setupSession()
    disk.foreign.set(file('Old.tessera'), 'sqlite')
    disk.sides.add(file('Old.tessera-wal'))

    await session.create(file('Old.tessera'))

    expect(trashed).toEqual([file('Old.tessera-wal'), file('Old.tessera')])
    expect(session.current?.name).toBe('Old')
  })

  it('leaves nothing open when a contributor cannot seed it', async () => {
    const { session, contribute } = setupSession()
    contribute(contributor('accounts', 1, async () => { throw new Error('no categories') }))
    const err = await failure(session.create(file('Home.tessera')))
    expect(err.code).toBe('MIGRATION_FAILED')
    expect(err.message).toContain('no categories')
    expect(session.current).toBeUndefined()
  })
})

describe('opening a book', () => {
  async function saved(setup = setupSession()) {
    await setup.created('Home.tessera')
    await setup.session.close()
    return setup
  }

  it('asks which file, starting in the last book\'s folder, and opens it', async () => {
    const env = await saved()
    env.files.showOpenDialog.mockResolvedValueOnce(file('Home.tessera'))

    const book = await env.session.open()

    expect(env.files.showOpenDialog).toHaveBeenCalledWith(expect.objectContaining({ defaultPath: DIR }))
    expect(book?.name).toBe('Home')
  })

  it('does nothing when the dialog is cancelled, or the file is already open', async () => {
    const env = await saved()
    expect(await env.session.open()).toBeUndefined()
    const changes: BookChange[] = []
    await env.session.open(file('Home.tessera'))
    env.session.onDidChange(change => changes.push(change))
    await env.session.open(file('Home.tessera'))
    expect(changes).toEqual([])
  })

  it('refuses a missing file without creating one, and keeps the open book open', async () => {
    const env = await saved()
    await env.session.open(file('Home.tessera'))
    const err = await failure(env.session.open(file('Gone.tessera')))
    expect(err.code).toBe('FILE_NOT_FOUND')
    expect(env.driver.databases.has(file('Gone.tessera'))).toBe(false)
    expect(env.session.current?.name).toBe('Home')
  })

  it('refuses a database that is not a book, and one from a newer book format', async () => {
    const env = setupSession()
    await env.engine.open({ path: file('Stranger.tessera') }).then(db => db.close())
    expect((await failure(env.session.open(file('Stranger.tessera')))).message).toBe('“Stranger.tessera” is not a Tessera book.')

    await env.engine.open({ path: file('Future.tessera') }).then(async db => { await db.meta.set(BOOK_META.format, 99); await db.close() })
    expect((await failure(env.session.open(file('Future.tessera')))).message).toContain('newer version of Tessera')
  })

  it("refuses a file newer than a contributor's plugin, without touching it", async () => {
    const env = setupSession()
    env.contribute(contributor('accounts', 1))
    await env.created()
    await env.session.close()
    env.driver.databases.get(file('Home.tessera'))!.meta.set(BOOK_META.schemaVersion('accounts'), 3)

    const err = await failure(env.session.open(file('Home.tessera')))
    expect(err.code).toBe('UNSUPPORTED_FILE')
    expect(err.message).toContain('newer version of the “accounts” plugin')
    expect(env.disk.copies).toEqual([])
  })

  it('backs the file up, then upgrades each contributor one version at a time', async () => {
    const env = setupSession({ now: () => new Date('2026-11-04T10:11:12Z') })
    const v1 = contributor('accounts', 1)
    env.contribute(v1)
    await env.created()
    await env.session.close()

    // The plugin is updated: its schema is now version 3
    const v3 = contributor('accounts', 3)
    env.extensions.getContributions('book.schema')[0].impl = v3.contribution
    ;(env.services.get('accounts.migrator') as any).migrate = v3.migrator.migrate

    await env.session.open(file('Home.tessera'))

    expect(env.disk.copies).toEqual([[file('Home.tessera'), file('Home.backup-2026-11-04_10-11-12.tessera')]])
    expect(v3.migrator.migrate.mock.calls.map(call => call[1])).toEqual([1, 2])
    expect(env.driver.databases.get(file('Home.tessera'))!.meta.get(BOOK_META.schemaVersion('accounts'))).toBe(3)
  })

  it('seeds a contributor added after the book was made, without a backup', async () => {
    const env = await saved()
    const budgets = contributor('budgets', 1)
    env.contribute(budgets)

    await env.session.open(file('Home.tessera'))

    expect(budgets.migrator.migrate).toHaveBeenCalledTimes(1)
    expect(env.disk.copies).toEqual([])
  })

  it('names the backup when an upgrade fails, and leaves the book closed', async () => {
    const env = setupSession({ now: () => new Date('2026-11-04T10:11:12Z') })
    env.contribute(contributor('accounts', 1))
    await env.created()
    await env.session.close()
    env.extensions.getContributions('book.schema')[0].impl = contributor('accounts', 2).contribution
    ;(env.services.get('accounts.migrator') as any).migrate = async () => { throw new Error('bad data') }

    const err = await failure(env.session.open(file('Home.tessera')))
    expect(err.code).toBe('MIGRATION_FAILED')
    expect(err.message).toContain('“Home.backup-2026-11-04_10-11-12.tessera”')
    expect(env.session.current).toBeUndefined()
  })

  it('fails clearly when a contributor\'s migrator service is missing', async () => {
    const env = setupSession()
    env.extensions.contribute('ghost', 'book.schema', 'ghost', contributor('ghost', 1).contribution)
    const err = await failure(env.session.create(file('Home.tessera')))
    expect(err).toMatchObject({ code: 'MIGRATION_FAILED', message: expect.stringContaining('"ghost.migrator" isn’t available') })
  })
})

describe('closing and deleting', () => {
  it('runs the close listeners while the book can still be written, then announces it', async () => {
    const { session, created } = setupSession()
    await created()
    const order: string[] = []
    session.onWillClose(async book => {
      await session.database('accounts').meta.set('accounts.note', 'flushed')
      order.push(`will close ${book.name}`)
    })
    session.onDidChange(change => order.push(change.type))

    await session.close()

    expect(order).toEqual(['will close Home', 'closed'])
    expect(session.current).toBeUndefined()
  })

  it('forgets the last book on Close, but remembers it on quit', async () => {
    const { session, created, recent } = setupSession()
    await created()
    await session.shutdown()
    expect(await recent.last()).toBe(file('Home.tessera'))

    await session.open(file('Home.tessera'))
    await session.close()
    expect(await recent.last()).toBeUndefined()
  })

  it('confirms, closes and sends the open book to the trash; Cancel changes nothing', async () => {
    const { session, created, prompts, answers, trashed, recent } = setupSession()
    await created()
    answers.push(false)
    expect(await session.delete()).toBe(false)
    expect(session.current?.name).toBe('Home')

    expect(await session.delete()).toBe(true)
    expect(prompts.confirm).toHaveBeenLastCalledWith(expect.objectContaining({
      message: 'Move “Home” to the Trash?', confirmLabel: 'Delete', destructive: true,
      detail: expect.stringContaining('You can restore the file from the Trash')
    }))
    expect(session.current).toBeUndefined()
    expect(trashed).toEqual([file('Home.tessera')])
    expect(await recent.list()).toEqual([])
  })

  it('deletes a book that is not open, from the recent list', async () => {
    const { session, created, trashed } = setupSession()
    await created('Old.tessera')
    await created('Home.tessera')
    expect(await session.delete(file('Old.tessera'))).toBe(true)
    expect(trashed).toEqual([file('Old.tessera')])
    expect(session.current?.name).toBe('Home')
  })
})

describe('the recent list', () => {
  it('lists books most recently opened first, once each', async () => {
    const { session, created, recent } = setupSession()
    await created('A.tessera')
    await created('B.tessera')
    await session.open(file('A.tessera'))
    expect((await recent.list()).map(r => r.name)).toEqual(['A', 'B'])
  })

  it('reads a damaged list as empty rather than failing', async () => {
    const { state, recent } = setupSession()
    state.values.set('ledger.recent', [{ path: 3 }, 'x', null, { path: '/a', name: 'A', openedAt: 'now' }])
    expect(await recent.list()).toEqual([{ path: '/a', name: 'A', openedAt: 'now' }])
    state.values.set('ledger.recent', 'nonsense')
    expect(await recent.list()).toEqual([])
  })
})

describe("the book's id", () => {
  /** The id stored in a book's file, as the memory driver holds it. */
  const storedId = (driver: ReturnType<typeof setupSession>['driver'], name = 'Home.tessera') =>
    driver.databases.get(file(name))!.meta.get(BOOK_META.id)

  /** Makes a book look like one from before ids existed. */
  const forgetId = (driver: ReturnType<typeof setupSession>['driver'], name = 'Home.tessera') =>
    driver.databases.get(file(name))!.meta.delete(BOOK_META.id)

  it('is a new ULID written into the file when the book is created, different for every book', async () => {
    const { session, driver, created } = setupSession()
    const home = await created('Home.tessera')
    const rental = await created('Rental.tessera')

    expect(home.id).toMatch(ULID)
    expect(storedId(driver, 'Home.tessera')).toBe(home.id)
    expect(storedId(driver, 'Rental.tessera')).toBe(rental.id)
    expect(rental.id).not.toBe(home.id)
    expect(session.current?.id).toBe(rental.id)
  })

  it('stays the same when the book is closed and reopened', async () => {
    const { session, created } = setupSession()
    const book = await created()
    await session.close()
    expect((await session.open(file('Home.tessera')))?.id).toBe(book.id)
  })

  it('stays the same when the file is renamed or moved', async () => {
    const { session, driver, created } = setupSession()
    const book = await created()
    await session.close()
    driver.databases.set(file('Elsewhere/Our Money.tessera'), structuredClone(driver.databases.get(file('Home.tessera'))!))
    driver.databases.delete(file('Home.tessera'))

    const moved = await session.open(file('Elsewhere/Our Money.tessera'))
    expect(moved).toMatchObject({ id: book.id, name: 'Our Money' })
  })

  it('is given to a book from before ids existed, once, without a pre-migration copy', async () => {
    const { session, driver, disk, log, created } = setupSession()
    await created()
    await session.close()
    forgetId(driver)

    const opened = await session.open(file('Home.tessera'))
    expect(opened?.id).toMatch(ULID)
    expect(storedId(driver)).toBe(opened?.id)
    expect(disk.copies).toEqual([])
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('a book id'))

    await session.close()
    expect((await session.open(file('Home.tessera')))?.id).toBe(opened?.id)
  })

  it.each([['an empty string', ''], ['blanks', '   '], ['a number', 42], ['an object', { id: 'x' }]])(
    'replaces an unusable stored id (%s), with a warning', async (_what, unusable) => {
      const { session, driver, log, created } = setupSession()
      await created()
      await session.close()
      driver.databases.get(file('Home.tessera'))!.meta.set(BOOK_META.id, unusable as never)

      const opened = await session.open(file('Home.tessera'))
      expect(opened?.id).toMatch(ULID)
      expect(storedId(driver)).toBe(opened?.id)
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('unusable book id'))
    })

  it('keeps a stored id that is not a ULID, as a restored book may carry', async () => {
    const { session, driver, created } = setupSession()
    await created()
    await session.close()
    driver.databases.get(file('Home.tessera'))!.meta.set(BOOK_META.id, 'from-a-backup')
    expect((await session.open(file('Home.tessera')))?.id).toBe('from-a-backup')
  })

  describe('of a read-only book', () => {
    /** Every database the session opens comes back read-only, as a locked or read-only file would. */
    const readOnly = (setup: ReturnType<typeof setupSession>) => {
      const open = setup.engine.open.bind(setup.engine)
      setup.engine.open = (target, options = {}) => open(target, { ...options, readOnly: true })
    }

    it('is the one stored, when there is one', async () => {
      const setup = setupSession()
      const book = await setup.created()
      await setup.session.close()
      readOnly(setup)

      expect(await setup.session.open(file('Home.tessera'))).toMatchObject({ id: book.id, readOnly: true })
    })

    it('is derived from the path when there is none, and nothing is written', async () => {
      const setup = setupSession()
      await setup.created()
      await setup.session.close()
      forgetId(setup.driver)
      readOnly(setup)

      const opened = await setup.session.open(file('Home.tessera'))
      expect(opened).toMatchObject({ id: pathBookId(file('Home.tessera')), readOnly: true })
      expect(storedId(setup.driver)).toBeUndefined()
    })
  })

  it('derives the same path id for the same path, and a different one for another', () => {
    expect(pathBookId(file('Home.tessera'))).toBe(pathBookId(file('Home.tessera')))
    expect(pathBookId(file('Home.tessera'))).toMatch(/^path-[0-9a-f]{32}$/)
    expect(pathBookId(file('Home.tessera'))).not.toBe(pathBookId(file('Rental.tessera')))
    // Case matters only where the file system usually cares about it
    const folded = process.platform === 'win32' || process.platform === 'darwin'
    expect(pathBookId(file('HOME.tessera')) === pathBookId(file('Home.tessera'))).toBe(folded)
  })
})

describe('what a contributor can reach', () => {
  it('is its own collections and meta keys only, and never closing the book', async () => {
    const { session, contribute, created } = setupSession()
    contribute(contributor('accounts', 1))
    await created()
    const db = session.database('accounts')

    await db.collection('accounts.things').insert({ name: 'kept' })
    expect(() => db.collection('ledger.subledgers')).toThrow('may only use names starting with "accounts."')
    expect(() => db.collection('budgets.things')).toThrow()
    await expect(db.meta.set('ledger.format', 2)).rejects.toThrow()
    expect(await db.listCollections()).toEqual(['accounts.things'])
    await expect(db.close()).rejects.toThrow('The book closes its database')
    await db.transaction(async tx => { expect(() => tx.collection('ledger.subledgers')).toThrow() })
  })

  it('can never copy or replace the whole book', async () => {
    const { session, contribute, created } = setupSession()
    contribute(contributor('accounts', 1))
    await created()
    const db = session.database('accounts')
    await db.collection('accounts.things').insert({ name: 'kept' })

    expect(await failure(db.snapshot())).toMatchObject({ code: 'INVALID', message: expect.stringContaining('Only the book can copy') })
    expect(await failure(db.load({ collections: [], meta: {} })))
      .toMatchObject({ code: 'INVALID', message: expect.stringContaining('Only the book can replace') })
    // Refused even when it would have done nothing: the empty snapshot above left the book as it was
    expect(await db.listCollections()).toEqual(['accounts.things'])
  })

  it('hears only about changes to its own collections', async () => {
    const { session, contribute, created } = setupSession()
    contribute(contributor('accounts', 1))
    await created()
    const seen: string[] = []
    session.database('accounts').onDidChange(event => seen.push(...event.changes.map(c => c.collection)))

    await session.createSubBook({ name: 'Personal', parentId: null })
    await session.database('accounts').collection('accounts.things').insert({ name: 'x' })

    expect(seen).toEqual(['accounts.things'])
  })

  it('is nothing while no book is open', () => {
    const { session } = setupSession()
    expect(() => session.database('accounts')).toThrow('No book is open.')
  })
})

describe('running one file operation at a time', () => {
  it('lets a second open wait for the first, so two dialogs never race', async () => {
    const env = setupSession()
    await env.created('A.tessera')
    await env.created('B.tessera')
    const opened = await Promise.all([env.session.open(file('A.tessera')), env.session.open(file('B.tessera'))])
    expect(opened.map(l => l?.name)).toEqual(['A', 'B'])
    expect(env.session.current?.name).toBe('B')
  })
})
