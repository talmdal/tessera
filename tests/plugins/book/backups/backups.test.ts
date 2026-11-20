// @vitest-environment node
// Automatic backups as the session drives them: a real BookSessionImpl over the memory engine, the real Backups,
// an in-memory backup disk and a clock the test moves. See docs/backup-restore-design.md, "Automatic backups".
import { describe, expect, it, vi } from 'vitest'
import path from 'node:path'
import { Readable } from 'node:stream'
import { BOOK_META, BOOK_OPTIONS_DEFAULTS, type BackupTrigger, type BookBackupOptions } from '@tessera/book-api'
import { Backups } from '../../../../plugins/book/src/privileged/backups/Backups'
import { BackupLedger, LEDGER_KEY } from '../../../../plugins/book/src/privileged/backups/BackupLedger'
import { backupHeader, readBackup, readBackupHeader, writeBackup } from '../../../../plugins/book/src/privileged/backups/backupFile'
import { contributor, file, memoryAppState, memoryBackupDisk, setupSession } from '../harness'
import { collector } from './helpers'

const DOCUMENTS = path.resolve('/home/kim/Documents')
const DEFAULT_FOLDER = path.join(DOCUMENTS, 'Tessera Backups')

function setup(options: Partial<BookBackupOptions> = {}, extra: { budget?: number } = {}) {
  let now = new Date(2026, 10, 19, 18, 0, 0)
  const clock = {
    now: () => new Date(now),
    /** Moves the clock on: days, then minutes. */
    advance: (days: number, minutes = 0) => { now = new Date(now.getTime() + days * 86_400_000 + minutes * 60_000) }
  }
  const backupDisk = memoryBackupDisk()
  const backupState = memoryAppState()
  const ledger = new BackupLedger(backupState)
  const trashedBackups: string[] = []
  const files = {
    trash: vi.fn(async (f: string) => { trashedBackups.push(f); backupDisk.files.delete(f) }),
    documentsPath: () => DOCUMENTS
  }
  let settings: BookBackupOptions = { ...BOOK_OPTIONS_DEFAULTS.backups, ...options }
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const backups = new Backups({ disk: backupDisk.disk, ledger, files, options: () => settings, engineId: 'storage-memory', log, now: clock.now })
  const env = setupSession({ now: clock.now })
  backups.attach(env.session)      // as the plugin does: first, so its close listener runs last
  env.contribute(contributor('accounts', 1))

  /** One session: opens (or creates) a book, optionally writes to it, closes it, and waits for any backup. */
  const cycle = async (edit: string | null = 'an edit', name = 'Home.tessera') => {
    if (!env.driver.databases.has(file(name))) await env.session.create(file(name))
    else await env.session.open(file(name))
    if (edit !== null) await env.session.database('accounts').collection('accounts.things').insert({ name: `${edit} ${Math.random()}` })
    await env.session.close()
    await backups.idle()
  }
  const autoBackups = () => [...backupDisk.files.keys()].filter(f => f.endsWith('.tessera-backup')).sort()
  const read = (f: string) => readBackup(Readable.from([backupDisk.files.get(f)!.bytes]))
  /** The ledger entry of Home, by the id stored in the book: no opening, which would be a session of its own. */
  const entry = async () => ledger.entry(env.driver.databases.get(file('Home.tessera'))!.meta.get(BOOK_META.id) as string)
  /** Writes a real backup file straight into the folder, as if made earlier or by someone else. */
  const place = async (name: string, book: { id: string, name: string }, trigger: BackupTrigger, takenAt: Date) => {
    const snapshot = { collections: [], meta: { 'ledger.format': 1 } }
    const { out, bytes } = collector()
    await writeBackup(out, backupHeader({ book: { ...book, path: '/x' }, takenAt, trigger, app: 'book 0.1.0', engine: 'x' }, snapshot), snapshot)
    backupDisk.files.set(path.join(DEFAULT_FOLDER, name), { bytes: bytes(), modifiedAt: takenAt })
  }

  return {
    ...env, backups, backupDisk, backupState, ledger, files, trashedBackups, log, clock, cycle, autoBackups, read, entry, place,
    set: (patch: Partial<BookBackupOptions>) => { settings = { ...settings, ...patch } },
    folder: DEFAULT_FOLDER
  }
}

describe('an automatic backup when a book closes', () => {
  it('is taken the first time, into the default folder, which is made for it', async () => {
    const env = await Promise.resolve(setup())
    await env.cycle('the first entry')

    const [backup] = env.autoBackups()
    expect(env.autoBackups()).toHaveLength(1)
    expect(path.dirname(backup)).toBe(DEFAULT_FOLDER)
    expect(path.basename(backup)).toBe('Home 2026-11-19 18.00.00.tessera-backup')
    expect(env.backupDisk.folders.has(DEFAULT_FOLDER)).toBe(true)

    const { header, snapshot } = await env.read(backup)
    expect(header).toMatchObject({ trigger: 'auto', book: { name: 'Home', path: file('Home.tessera') }, engine: 'storage-memory' })
    const things = snapshot.collections.find(c => c.name === 'accounts.things')!
    expect(things.docs.map(d => String(d.name))).toEqual([expect.stringContaining('the first entry')])
    expect(await env.ledger.entry(header.book.id)).toEqual({
      lastBackupAt: env.clock.now().toISOString(), lastFile: backup, lastResult: 'ok', changed: false,
      name: 'Home', path: file('Home.tessera')       // as last seen, so the book can be found by path when closed
    })
    expect(env.log.info).toHaveBeenCalledWith(expect.stringContaining('Backed up “Home”'))
  })

  it('never makes closing wait: the book is closed while the backup is still being written', async () => {
    const env = setup()
    await env.session.create(file('Home.tessera'))
    env.backupDisk.hold()
    await env.session.close()

    expect(env.session.current).toBeUndefined()
    expect(env.autoBackups()).toEqual([])
    env.backupDisk.release()
    await env.backups.idle()
    expect(env.autoBackups()).toHaveLength(1)
  })

  it('holds what other plugins write as the book closes', async () => {
    const env = setup()
    await env.session.create(file('Home.tessera'))
    env.session.onWillClose(async () => {
      await env.session.database('accounts').collection('accounts.things').insert({ name: 'written while closing' })
    })
    await env.session.close()
    await env.backups.idle()

    const { snapshot } = await env.read(env.autoBackups()[0])
    expect(snapshot.collections.find(c => c.name === 'accounts.things')!.docs.map(d => d.name)).toEqual(['written while closing'])
  })

  it('is not taken when automatic backups are off', async () => {
    const env = setup({ automatic: false })
    await env.cycle()
    expect(env.autoBackups()).toEqual([])
    expect(env.backupState.values.has(LEDGER_KEY)).toBe(true)     // the change is still recorded, for when it is on again
  })
})

describe('how often', () => {
  it('daily: once a day however often it closes, then again on a later day if it changed', async () => {
    const env = setup({ frequency: 'daily' })
    await env.cycle()
    await env.cycle()
    env.clock.advance(0, 120)
    await env.cycle()
    expect(env.autoBackups()).toHaveLength(1)

    env.clock.advance(1)
    await env.cycle(null)      // looked at only, but the edits of yesterday are not backed up yet
    expect(env.autoBackups()).toHaveLength(2)

    env.clock.advance(1)
    await env.cycle(null)      // nothing changed since that one
    expect(env.autoBackups()).toHaveLength(2)
  })

  it('a week away gives one backup, not seven', async () => {
    const env = setup({ frequency: 'daily' })
    await env.cycle()
    await env.cycle('after the backup, the same day')
    env.clock.advance(7)
    await env.cycle(null)
    expect(env.autoBackups()).toHaveLength(2)
    await env.cycle('and again the same day')
    expect(env.autoBackups()).toHaveLength(2)
  })

  it('everyClose: at each close that follows a change, and never for an unchanged book', async () => {
    const env = setup({ frequency: 'everyClose' })
    await env.cycle()
    env.clock.advance(0, 1)
    await env.cycle()
    env.clock.advance(0, 1)
    await env.cycle(null)
    expect(env.autoBackups()).toHaveLength(2)
  })

  it('reads the options at each close, so a change applies from the next one', async () => {
    const env = setup({ frequency: 'monthly' })
    await env.cycle()
    env.clock.advance(0, 1)
    await env.cycle()
    expect(env.autoBackups()).toHaveLength(1)
    env.set({ frequency: 'everyClose' })
    env.clock.advance(0, 1)
    await env.cycle()
    expect(env.autoBackups()).toHaveLength(2)
  })

  it('a change made while the last backup is still being written is not forgotten', async () => {
    const env = setup({ frequency: 'monthly' })
    await env.session.create(file('Home.tessera'))
    env.backupDisk.hold()
    await env.session.close()
    await env.session.open(file('Home.tessera'))
    await env.session.database('accounts').collection('accounts.things').insert({ name: 'during the write' })
    env.backupDisk.release()
    await env.backups.idle()
    expect(await env.entry()).toMatchObject({ lastResult: 'ok', changed: true })
  })
})

describe('opening never starts a backup', () => {
  it('even when the last one failed: it waits for the next close', async () => {
    const env = setup({ folder: path.resolve('/media/kim/USB') })
    await env.cycle()
    expect(await env.entry()).toMatchObject({ lastResult: 'failed' })

    env.backupDisk.folders.add(path.resolve('/media/kim/USB'))
    await env.session.open(file('Home.tessera'))
    await env.backups.idle()
    expect(env.autoBackups()).toEqual([])

    await env.session.close()
    await env.backups.idle()
    expect(env.autoBackups()).toHaveLength(1)
  })
})

describe('when a backup fails', () => {
  it('a chosen folder that is missing is not created; the failure is logged, recorded, and retried at the next close', async () => {
    const usb = path.resolve('/media/kim/USB/Backups')
    const env = setup({ folder: usb, frequency: 'monthly' })
    await env.cycle()

    expect(env.backupDisk.folders.has(usb)).toBe(false)
    expect(env.autoBackups()).toEqual([])
    expect(env.log.warn).toHaveBeenCalledWith(expect.stringMatching(/Automatic backup of “Home” failed: The backup folder “.*Backups” can’t be found/))
    expect(await env.entry()).toMatchObject({ lastResult: 'failed', changed: true, lastError: expect.stringContaining('can’t be found') })

    env.backupDisk.folders.add(usb)
    env.clock.advance(0, 5)
    await env.cycle(null)       // the same day, no edits, monthly: retried anyway
    expect(env.autoBackups()).toEqual([expect.stringContaining(usb)])
    expect(await env.entry()).toMatchObject({ lastResult: 'ok', changed: false })
    expect((await env.entry())?.lastError).toBeUndefined()
  })

  it('a failed write leaves no file and no partial file behind', async () => {
    const env = setup()
    env.backupDisk.failWrites = new Error('ENOSPC: no space left on device')
    await env.cycle()
    expect([...env.backupDisk.files.keys()], String(env.log.warn.mock.calls)).toEqual([])
    expect(await env.entry()).toMatchObject({ lastResult: 'failed', lastError: expect.stringContaining('ENOSPC') })
  })

  it('a backup that does not read back is removed, and counts as failed', async () => {
    const env = setup()
    const open = env.backupDisk.disk.open
    env.backupDisk.disk.open = () => Readable.from([Buffer.from('not what was written')])
    await env.cycle()
    env.backupDisk.disk.open = open
    expect(env.autoBackups()).toEqual([])
    expect(await env.entry()).toMatchObject({ lastResult: 'failed', lastError: expect.stringContaining('could not be read back') })
  })

  it('never stops the book closing', async () => {
    const env = setup()
    env.backupDisk.failWrites = new Error('EIO')
    await env.cycle()
    expect(env.session.current).toBeUndefined()
    expect(env.log.error).not.toHaveBeenCalled()
  })
})

describe('keeping the newest automatic backups', () => {
  it('moves older automatic backups of this book to the Trash, and touches nothing else', async () => {
    const env = setup({ frequency: 'everyClose', keep: 3 })
    await env.cycle()
    const { header } = await env.read(env.autoBackups()[0])
    const me = header.book
    const long = new Date(2020, 0, 1)
    await env.place('Mine by hand.tessera-backup', me, 'manual', long)
    await env.place('Before a restore.tessera-backup', me, 'pre-restore', long)
    await env.place('Another book.tessera-backup', { id: 'another-book', name: 'Rental' }, 'auto', long)
    env.backupDisk.files.set(path.join(DEFAULT_FOLDER, 'Not a backup.tessera-backup'), { bytes: Buffer.from('?'), modifiedAt: long })

    for (let i = 0; i < 4; i++) {
      env.clock.advance(0, 1)
      await env.cycle()
    }

    const left = env.autoBackups().map(f => path.basename(f))
    expect(left).toEqual([
      'Another book.tessera-backup', 'Before a restore.tessera-backup',
      'Home 2026-11-19 18.02.00.tessera-backup', 'Home 2026-11-19 18.03.00.tessera-backup', 'Home 2026-11-19 18.04.00.tessera-backup',
      'Mine by hand.tessera-backup', 'Not a backup.tessera-backup'
    ])
    expect(env.trashedBackups.map(f => path.basename(f))).toEqual(['Home 2026-11-19 18.00.00.tessera-backup', 'Home 2026-11-19 18.01.00.tessera-backup'])
  })

  it('deletes them instead where the drive has no Trash, and says so', async () => {
    const env = setup({ frequency: 'everyClose', keep: 1 })
    env.files.trash.mockRejectedValue(new Error('Failed to move item to trash'))
    await env.cycle()
    env.clock.advance(0, 1)
    await env.cycle()
    expect(env.autoBackups().map(f => path.basename(f))).toEqual(['Home 2026-11-19 18.01.00.tessera-backup'])
    expect(env.log.info).toHaveBeenCalledWith('[book] The backup folder’s drive has no Trash; 1 old backup was of “Home” deleted instead')
  })

  it('removes a partial file left by a write that never finished, once it is an hour old', async () => {
    const env = setup({ frequency: 'everyClose' })
    env.backupDisk.folders.add(DEFAULT_FOLDER)
    const stale = path.join(DEFAULT_FOLDER, 'Home old.tessera-backup.aaaa1111.partial')
    const fresh = path.join(DEFAULT_FOLDER, 'Home new.tessera-backup.bbbb2222.partial')
    env.backupDisk.files.set(stale, { bytes: Buffer.from('x'), modifiedAt: new Date(env.clock.now().getTime() - 2 * 3_600_000) })
    env.backupDisk.files.set(fresh, { bytes: Buffer.from('x'), modifiedAt: new Date(env.clock.now().getTime() - 60_000) })
    await env.cycle()
    expect(env.backupDisk.files.has(stale)).toBe(false)
    expect(env.backupDisk.files.has(fresh)).toBe(true)
  })
})

describe('quitting', () => {
  it('waits for a backup being written, and finishes it without reading it back', async () => {
    const env = setup()
    await env.session.create(file('Home.tessera'))
    const open = vi.spyOn(env.backupDisk.disk, 'open')
    await env.session.shutdown()
    await env.backups.drain(1000)
    expect(env.autoBackups()).toHaveLength(1)
    expect(open).not.toHaveBeenCalled()
    expect(await readBackupHeader(Readable.from([env.backupDisk.files.get(env.autoBackups()[0])!.bytes]))).toMatchObject({ trigger: 'auto' })
  })

  it('abandons a backup that outlasts the budget: no file at all, recorded as interrupted, taken at the next close', async () => {
    const env = setup({ frequency: 'everyClose' })
    await env.cycle()
    env.clock.advance(0, 1)
    await env.session.open(file('Home.tessera'))
    await env.session.database('accounts').collection('accounts.things').insert({ name: 'the last edit before quitting' })
    env.backupDisk.hold()
    await env.session.shutdown()
    await env.backups.drain(30)

    expect(env.autoBackups()).toHaveLength(1)                         // only the earlier one
    expect([...env.backupDisk.files.keys()].filter(f => f.endsWith('.partial'))).toEqual([])
    expect(await env.entry()).toMatchObject({ lastResult: 'interrupted', changed: true })
    expect(env.log.warn).toHaveBeenCalledWith(expect.stringContaining('cut short when Tessera quit'))
    env.backupDisk.release()

    // Next run: a fresh Backups over the same ledger, as after a restart; the next close takes it, monthly or not
    const restarted = new Backups({
      disk: env.backupDisk.disk, ledger: env.ledger, files: env.files, options: () => ({ ...BOOK_OPTIONS_DEFAULTS.backups, frequency: 'monthly' }),
      engineId: 'storage-memory', log: env.log, now: env.clock.now
    })
    const next = setupSession({ now: env.clock.now })
    restarted.attach(next.session)
    next.contribute(contributor('accounts', 1))
    next.driver.databases.set(file('Home.tessera'), structuredClone(env.driver.databases.get(file('Home.tessera'))!))
    await next.session.open(file('Home.tessera'))
    await next.session.close()
    await restarted.idle()
    expect(env.autoBackups()).toHaveLength(2)
    const latest = await env.read(env.autoBackups()[1])
    expect(latest.snapshot.collections.find(c => c.name === 'accounts.things')!.docs.map(d => String(d.name)))
      .toContain('the last edit before quitting')
  })
})

describe('how backups hook into the session', () => {
  it('the opened event says when opening migrated the data, which counts as a change', async () => {
    const env = setupSession()
    const opened: unknown[] = []
    env.session.onDidChange(change => { if (change.type === 'opened') opened.push(change) })
    await env.session.create(file('Home.tessera'))
    await env.session.close()
    await env.session.open(file('Home.tessera'))
    await env.session.close()
    env.contribute(contributor('budgets', 1))
    await env.session.open(file('Home.tessera'))

    expect(opened).toEqual([
      expect.objectContaining({ created: true, migrated: false }),
      expect.objectContaining({ created: false, migrated: false }),
      expect.objectContaining({ created: false, migrated: true })
    ])
  })

  it('a migration on opening counts as a change: an unedited book is backed up again', async () => {
    const env = setup({ frequency: 'everyClose' })
    await env.cycle()
    env.clock.advance(0, 1)
    await env.cycle(null)                       // unchanged: no backup
    expect(env.autoBackups()).toHaveLength(1)

    env.contribute(contributor('budgets', 1))   // the next open migrates the book
    env.clock.advance(0, 1)
    await env.cycle(null)
    expect(env.autoBackups()).toHaveLength(2)
  })

  it('close listeners run last registered first', async () => {
    const env = setupSession()
    const order: string[] = []
    env.session.onWillClose(() => { order.push('registered first') })
    env.session.onWillClose(() => { order.push('registered second') })
    env.session.onWillClose(() => { order.push('registered last') })
    await env.session.create(file('Home.tessera'))
    await env.session.close()
    expect(order).toEqual(['registered last', 'registered second', 'registered first'])
  })

  it('the backup’s listener runs after every listener registered later, and one that fails never stops the close', async () => {
    const env = setup()
    const order: string[] = []
    env.session.onWillClose(async () => {
      order.push('another plugin')
      await env.session.database('accounts').collection('accounts.things').insert({ name: 'last word' })
    })
    env.session.onWillClose(() => { order.push('a failing plugin'); throw new Error('boom') })
    await env.session.create(file('Home.tessera'))
    await env.session.close()
    await env.backups.idle()

    expect(order).toEqual(['a failing plugin', 'another plugin'])
    expect(env.session.current).toBeUndefined()
    expect(env.log.error).not.toHaveBeenCalled()
    const { snapshot } = await env.read(env.autoBackups()[0])
    expect(snapshot.collections.find(c => c.name === 'accounts.things')!.docs.map(d => d.name)).toEqual(['last word'])
  })

  it('the unscoped database is the book plugin’s alone: book.session does not offer it', async () => {
    const { publicSession } = await import('../../../../plugins/book/src/privileged/index')
    const env = setupSession()
    expect('unscopedDatabase' in publicSession(env.session)).toBe(false)
    expect(() => env.session.unscopedDatabase()).toThrow('No book is open.')
  })
})

describe('backing up on demand', () => {
  /** Opens Home (creating it the first time) and leaves it open. */
  const openHome = async (env: ReturnType<typeof setup>) => {
    if (!env.driver.databases.has(file('Home.tessera'))) await env.session.create(file('Home.tessera'))
    else await env.session.open(file('Home.tessera'))
  }
  const edit = (env: ReturnType<typeof setup>, name = 'an edit') =>
    env.session.database('accounts').collection('accounts.things').insert({ name: `${name} ${Math.random()}` })

  it('writes a manual backup into the backup folder while the book stays open, and counts it as the last backup', async () => {
    const env = setup()
    await openHome(env)
    await edit(env)
    const written = await env.backups.backUpNow(env.session.unscopedDatabase(), env.session.current!)

    expect(env.session.current?.name).toBe('Home')
    expect(path.basename(written)).toBe('Home 2026-11-19 18.00.00 (manual).tessera-backup')
    expect(path.dirname(written)).toBe(DEFAULT_FOLDER)
    expect((await env.read(written)).header).toMatchObject({ trigger: 'manual' })
    expect(await env.entry()).toMatchObject({ lastBackupAt: env.clock.now().toISOString(), lastFile: written, lastResult: 'ok', changed: false })
  })

  it('ignores the frequency and whether anything changed', async () => {
    const env = setup({ automatic: false })
    await openHome(env)
    await env.backups.backUpNow(env.session.unscopedDatabase(), env.session.current!)
    env.clock.advance(0, 1)
    await env.backups.backUpNow(env.session.unscopedDatabase(), env.session.current!)
    expect(env.autoBackups()).toHaveLength(2)
  })

  it('makes the close after it take no backup if nothing changed since, and one if something did', async () => {
    const env = setup({ frequency: 'everyClose' })
    await openHome(env)
    await edit(env, 'before the manual backup')
    await env.backups.backUpNow(env.session.unscopedDatabase(), env.session.current!)
    await env.session.close()
    await env.backups.idle()
    expect(env.autoBackups()).toHaveLength(1)        // only the manual one

    await openHome(env)
    await env.backups.backUpNow(env.session.unscopedDatabase(), env.session.current!)
    await edit(env, 'after the manual backup')
    env.clock.advance(0, 1)
    await env.session.close()
    await env.backups.idle()
    expect(env.autoBackups()).toHaveLength(3)        // a second manual one, and the automatic one for the edit after it
  })

  it('does not forget a change made while it is being written', async () => {
    const env = setup()
    await openHome(env)
    await edit(env, 'before')
    env.backupDisk.hold()
    const writing = env.backups.backUpNow(env.session.unscopedDatabase(), env.session.current!)
    await new Promise(resolve => setTimeout(resolve, 0))
    await edit(env, 'during')
    env.backupDisk.release()
    await writing
    expect(await env.entry()).toMatchObject({ lastResult: 'ok', changed: true })
  })

  it('writes exactly the file asked for, and only counts it when that is in the backup folder', async () => {
    const env = setup()
    const usb = path.resolve('/media/kim/USB')
    env.backupDisk.folders.add(usb)
    await openHome(env)
    const elsewhere = await env.backups.backUpNow(env.session.unscopedDatabase(), env.session.current!, { to: path.join(usb, 'Copy.tessera-backup') })
    expect(elsewhere).toBe(path.join(usb, 'Copy.tessera-backup'))
    expect((await env.read(elsewhere)).header.trigger).toBe('manual')
    expect((await env.entry())?.lastBackupAt).toBeUndefined()     // Tessera manages only the backup folder

    env.backupDisk.folders.add(DEFAULT_FOLDER)
    const inFolder = await env.backups.backUpNow(env.session.unscopedDatabase(), env.session.current!, { to: path.join(DEFAULT_FOLDER, 'Mine.tessera-backup') })
    expect((await env.entry())?.lastFile).toBe(inFolder)
  })

  it('rejects with the reason it failed, leaving the ledger and the folder as they were', async () => {
    const env = setup()
    await openHome(env)
    env.backupDisk.failWrites = new Error('ENOSPC: no space left on device')
    await expect(env.backups.backUpNow(env.session.unscopedDatabase(), env.session.current!)).rejects.toThrow('ENOSPC')
    expect([...env.backupDisk.files.keys()]).toEqual([])
    expect((await env.entry())?.lastResult).toBeUndefined()
  })

  it('is never pruned', async () => {
    const env = setup({ frequency: 'everyClose', keep: 1 })
    await openHome(env)
    const manual = await env.backups.backUpNow(env.session.unscopedDatabase(), env.session.current!)
    for (let i = 0; i < 3; i++) {
      env.clock.advance(0, 1)
      await edit(env)
      await env.session.close()
      await env.backups.idle()
      await openHome(env)
    }
    expect(env.autoBackups()).toContain(manual)
    expect(env.autoBackups()).toHaveLength(2)        // the manual one, and the newest automatic one
  })
})
