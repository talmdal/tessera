// @vitest-environment node
// Restoring a backup, over the open book or as a new book: a real session over the memory engine, the real Backups
// and Restorer, and backup files written by the real writer. See docs/backup-restore-design.md, "Restore".
import { describe, expect, it, vi } from 'vitest'
import path from 'node:path'
import { Readable } from 'node:stream'
import { BOOK_META, BOOK_OPTIONS_DEFAULTS, type BookBackupOptions, type Migrator } from '@tessera/book-api'
import { Backups } from '../../../../plugins/book/src/privileged/backups/Backups'
import { BackupLedger } from '../../../../plugins/book/src/privileged/backups/BackupLedger'
import { readBackup } from '../../../../plugins/book/src/privileged/backups/backupFile'
import { Restorer } from '../../../../plugins/book/src/privileged/backups/Restorer'
import { contributor, file, memoryAppState, memoryBackupDisk, setupSession } from '../harness'

const DOCUMENTS = path.resolve('/home/kim/Documents')
const FOLDER = path.join(DOCUMENTS, 'Tessera Backups')

/** A session with backups and restore wired as the plugin wires them, with `accounts` at data version `version`. */
function setup(options: { version?: number, migrate?: Migrator['migrate'], backups?: Partial<BookBackupOptions> } = {}) {
  let now = new Date(2026, 10, 19, 18, 0, 0)
  const clock = { now: () => new Date(now), advance: (minutes: number) => { now = new Date(now.getTime() + minutes * 60_000) } }
  const backupDisk = memoryBackupDisk()
  const ledger = new BackupLedger(memoryAppState())
  const files = { trash: vi.fn(async (f: string) => { backupDisk.files.delete(f) }), documentsPath: () => DOCUMENTS }
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const settings: BookBackupOptions = { ...BOOK_OPTIONS_DEFAULTS.backups, ...options.backups }
  const backups = new Backups({ disk: backupDisk.disk, ledger, files, options: () => settings, engineId: 'storage-memory', log, now: clock.now })
  const env = setupSession({ now: clock.now })
  backups.attach(env.session)
  const accounts = contributor('accounts', options.version ?? 1, options.migrate)
  env.contribute(accounts)
  const restorer = new Restorer({
    session: env.session, engine: env.engine, backupDisk: backupDisk.disk, bookDisk: env.disk.disk, backups,
    contributions: () => env.schema.contributions(), log, trashName: 'Trash'
  })

  const things = () => env.session.database('accounts').collection<{ name: string }>('accounts.things')
  const names = async () => (await things().find()).map(d => d.name).sort()
  const add = (...items: string[]) => things().insertMany(items.map(name => ({ name })))
  /** Opens Home (creating it the first time). */
  const openHome = async () => {
    if (env.driver.databases.has(file('Home.tessera'))) return env.session.open(file('Home.tessera'))
    return env.session.create(file('Home.tessera'))
  }
  /** A manual backup of the open book now; its path. */
  const backUp = async () => {
    clock.advance(1)
    return backups.backUpNow(env.session.unscopedDatabase(), env.session.current!)
  }
  const backupFiles = () => [...backupDisk.files.keys()].filter(f => f.endsWith('.tessera-backup'))
  const stagingFiles = () => [...env.driver.databases.keys()].filter(f => path.basename(f).includes('.restoring-'))
  const read = (f: string) => readBackup(Readable.from([backupDisk.files.get(f)!.bytes]))

  return { ...env, accounts, backups, backupDisk, ledger, files, log, clock, restorer, names, add, openHome, backUp, backupFiles, stagingFiles, read }
}

/** The error a promise rejects with. */
const failure = (work: Promise<unknown>) => work.then(() => { throw new Error('expected a failure') }, (err: { code: string, message: string }) => err)

describe('replacing the open book', () => {
  it('puts the book back as it was in the backup, keeping its id, after a safety copy of it as it is now', async () => {
    const env = setup()
    const home = (await env.openHome())!
    await env.add('kept')
    const backup = await env.backUp()
    await env.add('added after the backup')

    const outcome = await env.restorer.restore(backup, { kind: 'replace' })

    expect(outcome.book).toMatchObject({ id: home.id, path: file('Home.tessera'), name: 'Home' })
    expect(env.session.current?.path).toBe(file('Home.tessera'))
    expect(await env.names()).toEqual(['kept'])
    // The book as it was a moment ago is safe: a pre-restore backup, and the old file in the Trash
    expect(path.basename(outcome.safetyBackup!)).toMatch(/^Home .* \(before restore\)\.tessera-backup$/)
    const safety = await env.read(outcome.safetyBackup!)
    expect(safety.header.trigger).toBe('pre-restore')
    expect(safety.snapshot.collections.find(c => c.name === 'accounts.things')!.docs.map(d => d.name).sort()).toEqual(['added after the backup', 'kept'])
    expect(env.trashed).toContain(file('Home.tessera'))
    expect(env.stagingFiles()).toEqual([])
  })

  it('records the restored book as changed, so its next due close backs it up', async () => {
    const env = setup({ backups: { frequency: 'everyClose' } })
    const home = (await env.openHome())!
    await env.add('kept')
    const backup = await env.backUp()
    await env.restorer.restore(backup, { kind: 'replace' })
    expect(await env.ledger.entry(home.id)).toMatchObject({ changed: true })

    await env.session.close()
    await env.backups.idle()
    // The manual backup, the safety copy, and the automatic backup of the restored book, though nothing was edited
    expect(env.backupFiles()).toHaveLength(3)
  })

  it('takes no safety copy of a book with nothing in it', async () => {
    const env = setup()
    await env.openHome()
    await env.add('in the backup')
    const backup = await env.backUp()
    await env.session.create(file('Empty.tessera'))
    const outcome = await env.restorer.restore(backup, { kind: 'replace' })

    expect(outcome.safetyBackup).toBeUndefined()
    expect(env.session.current?.path).toBe(file('Empty.tessera'))
    expect(await env.names()).toEqual(['in the backup'])
  })

  it('needs an open book, and one that can be written', async () => {
    const env = setup()
    await env.openHome()
    const backup = await env.backUp()
    await env.session.close()
    expect(await failure(env.restorer.restore(backup, { kind: 'replace' }))).toMatchObject({ code: 'NO_BOOK' })
  })

  it('changes nothing when the safety copy can’t be made', async () => {
    const env = setup()
    await env.openHome()
    await env.add('kept')
    const backup = await env.backUp()
    await env.add('not lost')
    env.backupDisk.failWrites = new Error('ENOSPC: no space left on device')

    const err = await failure(env.restorer.restore(backup, { kind: 'replace' }))
    expect(err.message).toMatch(/couldn’t be made first, so nothing was changed\. ENOSPC/)
    expect(env.session.current?.path).toBe(file('Home.tessera'))
    expect(await env.names()).toEqual(['kept', 'not lost'])
    expect(env.trashed).toEqual([])
    expect(env.stagingFiles()).toEqual([])
  })
})

describe('restoring as a new book', () => {
  it('makes a new book of its own at the chosen path, and leaves the open one untouched', async () => {
    const env = setup()
    const home = (await env.openHome())!
    await env.add('kept')
    const backup = await env.backUp()
    await env.add('only in Home')

    const outcome = await env.restorer.restore(backup, { kind: 'new', path: file('Restored.tessera') })

    expect(outcome.book).toMatchObject({ path: file('Restored.tessera'), name: 'Restored' })
    expect(outcome.book.id).not.toBe(home.id)
    expect(outcome.safetyBackup).toBeUndefined()
    expect(await env.names()).toEqual(['kept'])
    const meta = env.driver.databases.get(file('Restored.tessera'))!.meta
    expect(meta.get(BOOK_META.restoredFrom)).toEqual({ bookId: home.id, takenAt: outcome.header.takenAt })

    await env.session.open(file('Home.tessera'))
    expect(await env.names()).toEqual(['kept', 'only in Home'])
    expect(env.trashed).toEqual([])
  })

  it('works with no book open at all', async () => {
    const env = setup()
    await env.openHome()
    await env.add('kept')
    const backup = await env.backUp()
    await env.session.close()
    await env.restorer.restore(backup, { kind: 'new', path: file('Restored.tessera') })
    expect(await env.names()).toEqual(['kept'])
  })

  it('moves a file already at the chosen path to the Trash, as the save dialog warned', async () => {
    const env = setup()
    await env.openHome()
    const backup = await env.backUp()
    await env.session.create(file('Old.tessera'))
    await env.session.close()
    await env.restorer.restore(backup, { kind: 'new', path: file('Old.tessera') })
    expect(env.trashed).toContain(file('Old.tessera'))
    expect(env.session.current?.path).toBe(file('Old.tessera'))
  })

  it('refuses the open book’s own file: that is what Replace is for', async () => {
    const env = setup()
    await env.openHome()
    await env.add('kept')
    const backup = await env.backUp()
    const err = await failure(env.restorer.restore(backup, { kind: 'new', path: file('Home.tessera') }))
    expect(err).toMatchObject({ code: 'INVALID', message: expect.stringContaining('choose Replace the open book') })
    expect(env.trashed).toEqual([])
  })
})

describe('a backup from another version', () => {
  /** A backup written where `accounts` is at `version`, copied into `into`'s backup folder. */
  const backupAt = async (version: number, into: ReturnType<typeof setup>) => {
    const from = setup({ version })
    await from.openHome()
    await from.add('from the other version')
    const written = await from.backUp()
    into.backupDisk.folders.add(FOLDER)
    into.backupDisk.files.set(written, from.backupDisk.files.get(written)!)
    return written
  }

  it('an older one is restored, then brought up to date by the usual migrations', async () => {
    const env = setup({ version: 2 })
    const backup = await backupAt(1, env)
    await env.restorer.restore(backup, { kind: 'new', path: file('Restored.tessera') })
    expect(env.accounts.migrator.migrate.mock.calls.map(call => call[1])).toEqual([1])
    expect(await env.names()).toEqual(['from the other version'])
  })

  it('a newer one is refused before anything is changed', async () => {
    const env = setup({ version: 2 })
    await env.openHome()
    await env.add('mine')
    const backup = await backupAt(3, env)
    const err = await failure(env.restorer.restore(backup, { kind: 'replace' }))
    expect(err).toMatchObject({ code: 'UNSUPPORTED_FILE', message: expect.stringContaining('needs a newer version of the “accounts” plugin') })
    expect(await env.names()).toEqual(['mine'])
    expect(env.stagingFiles()).toEqual([])
  })

  it('when its migration fails after the swap, the message says where everything is', async () => {
    let failing = false      // only once the test's own book exists: creating it migrates through version 1 too
    const env = setup({ version: 2, migrate: async (_db, from) => { if (failing && from === 1) throw new Error('the data is not what I expected') } })
    await env.openHome()
    await env.add('mine')
    const backup = await backupAt(1, env)
    failing = true
    const err = await failure(env.restorer.restore(backup, { kind: 'replace' }))
    expect(err.message).toMatch(/^The restored book was saved as “Home\.tessera” but couldn’t be opened: .*the data is not what I expected/)
    expect(err.message).toMatch(/Your previous “Home” is in the Trash, and a backup of it was saved as “Home .* \(before restore\)\.tessera-backup” in /)
    expect(env.backupFiles().some(f => f.includes('(before restore)'))).toBe(true)
  })
})

describe('a damaged backup', () => {
  it('is refused before anything is changed', async () => {
    const env = setup()
    await env.openHome()
    await env.add('mine')
    const backup = await env.backUp()
    const stored = env.backupDisk.files.get(backup)!
    const damaged = Buffer.from(stored.bytes)
    damaged[Math.floor(damaged.length / 2)] ^= 0xff
    env.backupDisk.files.set(backup, { ...stored, bytes: damaged })

    expect(await failure(env.restorer.restore(backup, { kind: 'replace' }))).toMatchObject({ code: 'DAMAGED' })
    expect(await env.names()).toEqual(['mine'])
    expect(env.trashed).toEqual([])
    expect(env.stagingFiles()).toEqual([])
    expect(env.backupFiles()).toEqual([backup])      // no safety copy either: it never got that far
  })
})

describe('what the Restore dialog lists', () => {
  it('every backup in a folder, newest first, then what can’t be read, each with why it can’t be restored', async () => {
    const env = setup({ version: 2 })
    await env.openHome()
    const first = await env.backUp()
    const second = await env.backUp()
    env.backupDisk.files.set(path.join(FOLDER, 'Not a backup.tessera-backup'), { bytes: Buffer.from('?'), modifiedAt: new Date() })
    const newer = setup({ version: 3 })
    newer.clock.advance(10)          // its own clock: taken after both of the others
    await newer.openHome()
    const fromNewer = await newer.backUp()
    env.backupDisk.files.set(path.join(FOLDER, 'From newer.tessera-backup'), newer.backupDisk.files.get(fromNewer)!)

    const listed = await env.restorer.list(FOLDER)
    // Newest first, by when each was taken; the unreadable file last
    expect(listed.map(i => path.basename(i.file))).toEqual([
      'From newer.tessera-backup', path.basename(second), path.basename(first), 'Not a backup.tessera-backup'
    ])
    expect(listed[1]).toMatchObject({
      sizeBytes: expect.any(Number), header: { bookName: 'Home', trigger: 'manual', bookPath: file('Home.tessera'), engine: 'storage-memory' }
    })
    expect(listed[1].problem).toBeUndefined()
    expect(listed[0].problem).toContain('needs a newer version of the “accounts” plugin')
    expect(listed[3].header).toBeUndefined()
    expect(listed[3].problem).toBe('This is not a Tessera backup.')
  })

  it('nothing for a folder that isn’t there', async () => {
    const env = setup()
    expect(await env.restorer.list(path.resolve('/media/unplugged'))).toEqual([])
  })
})
