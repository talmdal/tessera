// @vitest-environment node
// File › Back Up Ledger…, and retention after it, through the activated plugin on a memory engine.
// See docs/backup-restore-design.md, "Backing up" and "Retention".
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { LEDGER_BACKUP_META, LEDGER_COMMANDS, LEDGER_CONTEXT_KEYS as K, LEDGER_META } from '@tessera/ledger-api'
import { clockTime } from '../../../plugins/ledger/src/privileged/backup/naming'
import { DIR, errno, file } from './harness'
import { activateLedger, type LedgerPlugin } from './plugin'

const NOW = new Date(2026, 10, 9, 10, 14, 5)
const DAY = 86_400_000
const FOLDER = path.join(DIR, 'Documents', 'Tessera Backups')
const NAME = 'Home 2026-11-09 10-14-05.tesserabkp'
const in_ = (folder: string, name: string) => path.join(folder, name)

/** The plugin with a ledger open, holding a sub-ledger; the save dialog answers with what it suggests. */
async function withLedger(options: Parameters<typeof activateLedger>[0] = {}) {
  const env = await activateLedger({ now: () => NOW, ...options })
  const ledger = await env.newLedger('Home.tessera')
  await env.session.createSubLedger({ name: 'Personal', parentId: null })
  env.files.showSaveDialog.mockImplementation(async options => options?.defaultPath)
  const activity: unknown[] = []
  env.runtime.contextKeys.onDidChange(() => {
    const text = env.key(K.activity)
    if (activity.at(-1) !== text) activity.push(text)
  })
  return { ...env, ledger, activity }
}

/** An earlier backup of ledger `id`, taken `days` days before NOW, in `folder`. */
function earlier(env: LedgerPlugin, id: string, days: number, folder = FOLDER, name = `Home ${days}.tesserabkp`) {
  const at = in_(folder, name)
  env.driver.databases.set(at, {
    collections: new Map(),
    meta: new Map<string, never>([
      [LEDGER_META.format, 1 as never], [LEDGER_META.id, id as never],
      [LEDGER_BACKUP_META.takenAt, new Date(NOW.getTime() - days * DAY).toISOString() as never]
    ])
  })
  return at
}

const backups = (env: LedgerPlugin, folder = FOLDER) =>
  [...env.driver.databases.keys()].filter(f => path.dirname(f) === folder).map(f => path.basename(f)).sort()

describe('File › Back Up Ledger…', () => {
  it('suggests the default folder and a dated name, then writes a checked copy there while the ledger stays open', async () => {
    const env = await withLedger()

    const saved = await env.run<string>(LEDGER_COMMANDS.backup)

    expect(env.files.showSaveDialog).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Back Up Ledger', buttonLabel: 'Back Up',
      defaultPath: in_(FOLDER, NAME), filters: [{ name: 'Tessera backup', extensions: ['tesserabkp'] }]
    }))
    expect(saved).toBe(in_(FOLDER, NAME))
    expect(await env.engine.readMeta({ path: saved })).toMatchObject({
      [LEDGER_META.format]: 1, [LEDGER_META.id]: env.ledger.id,
      [LEDGER_BACKUP_META.takenAt]: NOW.toISOString(), [LEDGER_BACKUP_META.kind]: 'manual',
      [LEDGER_BACKUP_META.ledgerName]: 'Home', [LEDGER_BACKUP_META.ledgerPath]: file('Home.tessera'),
      [LEDGER_BACKUP_META.takenWith]: expect.stringMatching(/^ledger \d/)
    })
    const copy = await env.engine.open({ path: saved }, { readOnly: true })
    expect((await copy.collection<{ name: string }>('ledger.subledgers').find()).map(s => s.name)).toEqual(['Personal'])
    // The ledger: still open, and unchanged
    expect(env.session.current?.path).toBe(file('Home.tessera'))
    expect(await env.engine.readMeta({ path: file('Home.tessera') })).not.toHaveProperty(LEDGER_BACKUP_META.takenAt)
    expect([...env.driver.databases.keys()].filter(f => f.endsWith('.partial'))).toEqual([])
  })

  it('shows the result for a minute (nothing before it, for a backup this quick), and remembers it', async () => {
    const env = await withLedger()
    await env.run(LEDGER_COMMANDS.backup)
    expect(env.activity).toEqual([`Backed up “Home” at ${clockTime(NOW)}`])
    env.clock.advance(60_000)
    expect(env.key(K.activity)).toBeUndefined()
    expect(env.state.values.get('ledger.backup.last')).toEqual({ [env.ledger.id!]: { takenAt: NOW.toISOString(), path: in_(FOLDER, NAME) } })
  })

  it('adds the extension to a name typed without it, and numbers a suggested name that is taken', async () => {
    const env = await withLedger()
    earlier(env, 'someone', 0, FOLDER, NAME)
    env.files.showSaveDialog.mockImplementationOnce(async options => {
      expect(options?.defaultPath).toBe(in_(FOLDER, 'Home 2026-11-09 10-14-05 (2).tesserabkp'))
      return in_(DIR, 'Mine')
    })
    expect(await env.run(LEDGER_COMMANDS.backup)).toBe(in_(DIR, 'Mine.tesserabkp'))
  })

  it('does nothing when the dialog is cancelled, and frees the ledger', async () => {
    const env = await withLedger()
    env.files.showSaveDialog.mockResolvedValueOnce(undefined)
    expect(await env.run(LEDGER_COMMANDS.backup)).toBeUndefined()
    expect(backups(env)).toEqual([])
    expect(env.key(K.isBusy)).toBe(false)
  })

  it('replaces a file the user chose to replace, sending the old one to the trash', async () => {
    const env = await withLedger()
    const target = earlier(env, env.ledger.id!, 3, DIR, 'Keep.tesserabkp')
    env.files.showSaveDialog.mockResolvedValueOnce(target)
    await env.run(LEDGER_COMMANDS.backup)
    expect(env.trashed).toEqual([target])
    expect((await env.engine.readMeta({ path: target }))[LEDGER_BACKUP_META.takenAt]).toBe(NOW.toISOString())
  })

  it('backs up to a path given as its argument, without the dialog', async () => {
    const env = await withLedger()
    const dialogs = env.files.showSaveDialog.mock.calls.length      // New Ledger… used it
    expect(await env.run(LEDGER_COMMANDS.backup, { path: in_(DIR, 'Scripted') })).toBe(in_(DIR, 'Scripted.tesserabkp'))
    expect(env.files.showSaveDialog.mock.calls.length).toBe(dialogs)
  })

  it('holds the ledger while it runs: the file commands and other operations wait, editing carries on', async () => {
    const env = await withLedger()
    env.files.showSaveDialog.mockImplementationOnce(async options => {
      expect(env.key(K.isBusy)).toBe(true)
      expect(env.key(K.operation)).toBe('Backing up “Home”')
      for (const id of [LEDGER_COMMANDS.new, LEDGER_COMMANDS.open, LEDGER_COMMANDS.close, LEDGER_COMMANDS.delete, LEDGER_COMMANDS.backup]) {
        expect(env.enabled(id), id).toBe(false)
      }
      await expect(env.session.close()).rejects.toMatchObject({ code: 'BUSY', message: 'Wait for “Backing up “Home”” to finish.' })
      expect(() => env.session.beginOperation('Importing statements')).toThrow(expect.objectContaining({ code: 'BUSY' }))
      await env.session.createSubLedger({ name: 'Added meanwhile', parentId: null })
      return options?.defaultPath
    })
    await env.run(LEDGER_COMMANDS.backup)
    expect(env.key(K.isBusy)).toBe(false)
    expect(env.enabled(LEDGER_COMMANDS.close)).toBe(true)
  })

  it('is disabled with no ledger open, and while another operation runs', async () => {
    const env = await activateLedger({ now: () => NOW })
    expect(env.enabled(LEDGER_COMMANDS.backup)).toBe(false)
    await env.newLedger()
    expect(env.enabled(LEDGER_COMMANDS.backup)).toBe(true)
    const operation = env.session.beginOperation('Importing statements')
    expect(env.enabled(LEDGER_COMMANDS.backup)).toBe(false)
    operation.dispose()
    expect(env.enabled(LEDGER_COMMANDS.backup)).toBe(true)
  })
})

describe('when a backup fails', () => {
  async function failing(setup: (env: LedgerPlugin) => void) {
    const env = await withLedger()
    setup(env)
    const saved = await env.run(LEDGER_COMMANDS.backup)
    const leftovers = [...env.driver.databases.keys()].filter(f => f.endsWith('.partial') || f.endsWith('.tesserabkp'))
    return { env, saved, leftovers, reported: env.prompts.message.mock.calls.at(-1)?.[0] }
  }

  it('says a folder that isn\'t there (an unplugged drive) isn\'t available, and leaves nothing', async () => {
    const { env, saved, leftovers, reported } = await failing(env => { env.disk.hooks.mkdir = () => { throw errno('ENOENT') } })
    expect(saved).toBeUndefined()
    expect(reported).toEqual({ kind: 'error', message: 'Could not back up the ledger.', detail: `The folder “${FOLDER}” isn’t available.` })
    expect(leftovers).toEqual([])
    expect(env.key(K.activity)).toBeUndefined()
    expect(env.key(K.isBusy)).toBe(false)
    expect(env.log.error).not.toHaveBeenCalled()
  })

  it('says when there isn\'t enough space', async () => {
    const { reported, leftovers } = await failing(env => {
      const set = env.driver.databases.set.bind(env.driver.databases)
      env.driver.databases.set = (key, value) => { if (key.endsWith('.partial')) throw errno('ENOSPC'); return set(key, value) }
    })
    expect(reported?.detail).toBe(`There isn’t enough space for the backup in “${FOLDER}”.`)
    expect(leftovers).toEqual([])
  })

  it('refuses a copy that doesn\'t read back as this ledger\'s backup', async () => {
    const { reported, leftovers } = await failing(env => {
      const read = env.engine.readMeta.bind(env.engine)
      env.engine.readMeta = async target => ('path' in target && target.path.endsWith('.partial')) ? {} : read(target)
    })
    expect(reported?.detail).toBe('The backup couldn’t be written: the copy did not read back as a backup of this ledger')
    expect(leftovers).toEqual([])
  })

  it('waits for a file another program holds, saying so, then carries on', async () => {
    const env = await withLedger()
    let holds = 30
    env.disk.hooks.rename = () => { if (holds-- > 0) throw errno('EBUSY') }
    expect(await env.run(LEDGER_COMMANDS.backup)).toBe(in_(FOLDER, NAME))
    expect(env.activity).toEqual([`Waiting for another program to release “${NAME}”…`, `Backed up “Home” at ${clockTime(NOW)}`])
  })

  it('gives up on a file held for good, naming the likely cause', async () => {
    const { reported, leftovers, env } = await failing(env => { env.disk.hooks.rename = () => { throw errno('EBUSY') } })
    expect(reported?.detail).toBe(`Another program, such as a sync or antivirus program, is using “${NAME}”. Try again in a moment.`)
    expect(leftovers).toEqual([])
    expect(env.sleeps.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(10_000)
  })
})

describe('retention after a backup', () => {
  it('removes the expired backups of this ledger in the default folder: the newest five and the last 30 days stay', async () => {
    const env = await withLedger()
    for (let d = 1; d <= 35; d++) earlier(env, env.ledger.id!, d)
    const others = [40, 50, 60].map(d => earlier(env, 'another ledger', d, FOLDER, `Home other ${d}.tesserabkp`))

    await env.run(LEDGER_COMMANDS.backup)

    expect(env.trashed.map(f => path.basename(f))).toEqual(['Home 35.tesserabkp', 'Home 34.tesserabkp', 'Home 33.tesserabkp', 'Home 32.tesserabkp', 'Home 31.tesserabkp'])
    expect(backups(env)).toContain(NAME)
    for (const other of others) expect(env.driver.databases.has(other)).toBe(true)
  })

  it('leaves the default folder alone after a backup saved anywhere else, and never trims that one\'s folder', async () => {
    const env = await withLedger()
    const elsewhere = path.join(DIR, 'USB')
    for (const d of [40, 50, 60, 70, 80, 90]) { earlier(env, env.ledger.id!, d); earlier(env, env.ledger.id!, d, elsewhere) }
    env.files.showSaveDialog.mockResolvedValueOnce(in_(elsewhere, 'Year end.tesserabkp'))
    await env.run(LEDGER_COMMANDS.backup)
    expect(env.files.trash).not.toHaveBeenCalled()
  })

  it('deletes an expired backup the trash refuses (no trash in that folder)', async () => {
    const env = await withLedger()
    for (const d of [1, 2, 3, 4, 40]) earlier(env, env.ledger.id!, d)
    env.files.trash.mockRejectedValue(new Error('Trashing on system internal mounts is not supported'))
    await env.run(LEDGER_COMMANDS.backup)
    expect(backups(env)).toEqual(['Home 1.tesserabkp', 'Home 2.tesserabkp', 'Home 3.tesserabkp', 'Home 4.tesserabkp', NAME].sort())
  })

  it('follows the settings: the folder, trimming off, the period and how many are kept', async () => {
    const custom = path.join(DIR, 'Backups')
    const folder = await withLedger({ settings: { 'ledger.backup': { folder: custom } } })
    for (const d of [1, 2, 3, 4, 40]) earlier(folder, folder.ledger.id!, d, custom)
    expect(await folder.run(LEDGER_COMMANDS.backup)).toBe(in_(custom, NAME))
    expect(folder.trashed).toEqual([in_(custom, 'Home 40.tesserabkp')])

    const off = await withLedger({ settings: { 'ledger.backup': { trim: false } } })
    for (const d of [1, 2, 3, 4, 40]) earlier(off, off.ledger.id!, d)
    await off.run(LEDGER_COMMANDS.backup)
    expect(off.trashed).toEqual([])

    const tight = await withLedger({ settings: { 'ledger.backup': { retentionDays: 10, keepAtLeast: 3 } } })
    for (const d of [1, 2, 11, 12]) earlier(tight, tight.ledger.id!, d)
    await tight.run(LEDGER_COMMANDS.backup)
    // The three newest (today, 1 and 2 days) stay; 11 and 12 days are past 10
    expect(tight.trashed.map(f => path.basename(f))).toEqual(['Home 12.tesserabkp', 'Home 11.tesserabkp'])
  })

  it('is done after the result is shown, so a slow trash doesn\'t delay it', async () => {
    const env = await withLedger()
    for (const d of [1, 2, 3, 4, 40]) earlier(env, env.ledger.id!, d)
    // Recorded, not asserted, in the trash: retention would take a failed assertion for a trash that refused
    const shownWhileTrashing: unknown[] = []
    env.files.trash.mockImplementation(async () => { shownWhileTrashing.push(env.key(K.activity)) })
    await env.run(LEDGER_COMMANDS.backup)
    expect(shownWhileTrashing).toEqual([`Backed up “Home” at ${clockTime(NOW)}`])
  })
})

describe('a backup is not a ledger', () => {
  it('is refused by Open Ledger…', async () => {
    const env = await withLedger()
    const saved = await env.run<string>(LEDGER_COMMANDS.backup)
    const err = await env.session.open(saved).catch(e => e)
    expect(err).toMatchObject({ code: 'UNSUPPORTED_FILE', message: `“${NAME}” is a backup, not a ledger. Use File › Restore Ledger… to restore it.` })
    expect(env.session.current?.name).toBe('Home')
  })
})

