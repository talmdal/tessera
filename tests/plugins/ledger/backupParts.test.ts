// @vitest-environment node
// The parts of a backup that need no ledger: names, renaming a held file, the status text, the settings.
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Activity } from '../../../plugins/ledger/src/privileged/backup/activity'
import { backupFileName, unusedPath, withBackupExtension } from '../../../plugins/ledger/src/privileged/backup/naming'
import { renameWithRetry } from '../../../plugins/ledger/src/privileged/backup/rename'
import { BACKUP_SETTINGS, backupFolder } from '../../../plugins/ledger/src/privileged/backup/settings'
import { errno } from './harness'
import { manualTimers } from './plugin'

describe('backup names', () => {
  it('is the ledger\'s name and the local date and time, sorting by date, with no colons', () => {
    expect(backupFileName('Home', new Date(2026, 10, 9, 10, 14, 5))).toBe('Home 2026-11-09 10-14-05.tesserabkp')
    expect(backupFileName('My Finances', new Date(2027, 0, 2, 3, 4, 5))).toBe('My Finances 2027-01-02 03-04-05.tesserabkp')
  })

  it('adds the extension when it was typed without it, in any case', () => {
    expect(withBackupExtension('/b/Home')).toBe('/b/Home.tesserabkp')
    expect(withBackupExtension('/b/Home.TesseraBkp')).toBe('/b/Home.TesseraBkp')
    expect(withBackupExtension('/b/Home.tessera')).toBe('/b/Home.tessera.tesserabkp')
  })

  it('numbers a name that is taken: (2), (3)…', async () => {
    const taken = new Set(['/b/Home.tesserabkp', '/b/Home (2).tesserabkp'])
    const exists = async (f: string) => taken.has(f)
    expect(await unusedPath('/b/Other.tesserabkp', exists)).toBe('/b/Other.tesserabkp')
    expect(await unusedPath('/b/Home.tesserabkp', exists)).toBe('/b/Home (3).tesserabkp')
  })
})

describe('renaming a file another program holds', () => {
  /** A disk whose rename fails with `code` for the first `times` attempts. */
  function held(code: string, times: number, destinationExists = false) {
    let attempts = 0
    let clock = 0
    const disk = {
      rename: vi.fn(async () => { if (++attempts <= times) throw errno(code) }),
      exists: vi.fn(async () => destinationExists)
    }
    const onWaiting = vi.fn()
    const options = { onWaiting, now: () => clock, sleep: async (ms: number) => { clock += ms } }
    return { disk, onWaiting, options, attempts: () => attempts, clock: () => clock }
  }

  it('waits for a brief hold (antivirus scanning the new file), without telling the user', async () => {
    const env = held('EBUSY', 5)
    await renameWithRetry(env.disk, '/b/x.partial', '/b/x', env.options)
    expect(env.attempts()).toBe(6)
    expect(env.onWaiting).not.toHaveBeenCalled()
  })

  it('says what it is waiting for after a second, once, and carries on', async () => {
    const env = held('EBUSY', 20)
    await renameWithRetry(env.disk, '/b/x.partial', '/b/x', env.options)
    expect(env.clock()).toBeGreaterThan(1000)
    expect(env.onWaiting).toHaveBeenCalledTimes(1)
  })

  it('gives up after ten seconds with the original error (another copy of Tessera has it open)', async () => {
    const env = held('EBUSY', Number.POSITIVE_INFINITY)
    await expect(renameWithRetry(env.disk, '/b/x.partial', '/b/x', env.options)).rejects.toMatchObject({ code: 'EBUSY' })
    expect(env.clock()).toBeGreaterThanOrEqual(10_000)
    expect(env.clock()).toBeLessThan(10_200)
  })

  it('retries EPERM and EACCES too, as graceful-fs does', async () => {
    for (const code of ['EPERM', 'EACCES']) {
      const env = held(code, 3)
      await renameWithRetry(env.disk, '/b/x.partial', '/b/x', env.options)
      expect(env.attempts()).toBe(4)
    }
  })

  it('doesn\'t retry another error, or onto a name that exists (that is not a held source)', async () => {
    const other = held('ENOENT', 1)
    await expect(renameWithRetry(other.disk, '/b/x.partial', '/b/x', other.options)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(other.attempts()).toBe(1)
    const onto = held('EBUSY', 1, true)
    await expect(renameWithRetry(onto.disk, '/b/x.partial', '/b/x', onto.options)).rejects.toMatchObject({ code: 'EBUSY' })
    expect(onto.attempts()).toBe(1)
  })

  it('stops waiting once its signal is aborted (an OS shutdown\'s budget is spent)', async () => {
    const env = held('EBUSY', Number.POSITIVE_INFINITY)
    const controller = new AbortController()
    const sleep = env.options.sleep
    const options = { ...env.options, signal: controller.signal, sleep: async (ms: number) => { await sleep(ms); if (env.clock() >= 500) controller.abort() } }
    await expect(renameWithRetry(env.disk, '/b/x.partial', '/b/x', options)).rejects.toMatchObject({ code: 'EBUSY' })
    expect(env.clock()).toBeLessThan(700)
  })
})

describe('the status text', () => {
  function setup() {
    const clock = manualTimers()
    const shown: (string | undefined)[] = []
    const activity = new Activity(text => shown.push(text), clock.timers)
    return { clock, shown, activity, last: () => shown.at(-1) }
  }

  it('shows nothing for work over in under half a second, only its result, for a minute', () => {
    const env = setup()
    const work = env.activity.start('Backing up “Home”')
    env.clock.advance(200)
    work.progress(0.5)
    work.done('Backed up “Home” at 10:14')
    expect(env.shown).toEqual(['Backed up “Home” at 10:14'])
    env.clock.advance(59_000)
    expect(env.last()).toBe('Backed up “Home” at 10:14')
    env.clock.advance(1000)
    expect(env.last()).toBeUndefined()
  })

  it('shows longer work after half a second, with its percentage, redrawn at most four times a second', () => {
    const env = setup()
    const work = env.activity.start('Backing up “Home”')
    work.progress(0.1)
    env.clock.advance(500)
    expect(env.last()).toBe('Backing up “Home”… 10%')
    work.progress(0.2)
    expect(env.last()).toBe('Backing up “Home”… 10%')     // too soon to redraw
    env.clock.advance(250)
    work.progress(0.456)
    expect(env.last()).toBe('Backing up “Home”… 45%')
  })

  it('shows a note at once, and clears on a failure (reported elsewhere)', () => {
    const env = setup()
    const work = env.activity.start('Backing up “Home”')
    work.note('Waiting for another program to release “Home.tesserabkp”…')
    expect(env.last()).toBe('Waiting for another program to release “Home.tesserabkp”…')
    work.done()
    expect(env.last()).toBeUndefined()
    env.clock.advance(120_000)
    expect(env.shown).toEqual(['Waiting for another program to release “Home.tesserabkp”…', undefined])
  })

  it('lets newer work replace older: the older one\'s result and timers no longer show', () => {
    const env = setup()
    const first = env.activity.start('First')
    first.done('First done')
    const second = env.activity.start('Second')
    first.done('First again')
    env.clock.advance(60_000)        // the first result's clearing is cancelled; the second shows after 500 ms
    expect(env.shown).toEqual(['First done', 'Second…'])
    second.done('Second done')
    expect(env.last()).toBe('Second done')
  })
})

describe('the backup settings', () => {
  const check = (values: object) => BACKUP_SETTINGS.validate!({ ...BACKUP_SETTINGS.defaults, ...values }) ?? []

  it('accept the defaults, and a full path for the folder', () => {
    expect(check({})).toEqual([])
    expect(check({ folder: path.resolve('/backups') })).toEqual([])
  })

  it('refuse a relative folder, and numbers out of range or not whole', () => {
    expect(check({ folder: 'backups' })).toEqual(['Choose the backup folder as a full path, or leave it empty for the default.'])
    expect(check({ retentionDays: 0 })).toEqual(['Keep backups for 1 to 3650 days.'])
    expect(check({ retentionDays: 2.5 })).toEqual(['Keep backups for 1 to 3650 days.'])
    expect(check({ keepAtLeast: 101 })).toEqual(['Always keep from 1 to 100 backups.'])
    expect(check({ onClose: 'yes' })).toEqual(['Say whether to back up the ledger when it closes.'])
  })

  it('default to Tessera Backups in the documents folder', () => {
    expect(backupFolder(BACKUP_SETTINGS.defaults, path.resolve('/home/me/Documents'))).toBe(path.join(path.resolve('/home/me/Documents'), 'Tessera Backups'))
    expect(backupFolder({ ...BACKUP_SETTINGS.defaults, folder: path.resolve('/mnt/usb/Backups') }, '/ignored')).toBe(path.resolve('/mnt/usb/Backups'))
  })
})
