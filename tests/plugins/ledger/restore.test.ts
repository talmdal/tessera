// @vitest-environment node
// File › Restore Ledger…, through the activated plugin on a memory engine. The Restore dialog is played by the test:
// it makes the same requests the real dialog makes. The current file is never replaced, trashed or deleted.
// See docs/backup-restore-design.md, "Restoring".
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  LEDGER_BACKUP_META, LEDGER_CHANNELS, LEDGER_COMMANDS, LEDGER_CONTEXT_KEYS as K, LEDGER_DIALOGS, LEDGER_META,
  type BackupInfo, type LedgerInfo, type RestoreDialogInput, type RestoreDialogResult, type RestoreOutcome, type RestorePlan, type RestoreRequest, type Result
} from '@tessera/ledger-api'
import { DIR, errno, file } from './harness'
import { activateLedger, type LedgerPlugin } from './plugin'

const NOW = new Date(2026, 10, 9, 10, 14, 5)
const FOLDER = path.join(DIR, 'Documents', 'Tessera Backups')
const BACKUP = path.join(FOLDER, 'Home 2026-11-09 10-14-05.tesserabkp')
const KEPT = 'Home (before restore 2026-11-09 10-14)'

/** Home open, with a sub-ledger "Before", backed up; then a sub-ledger "After" added, which the backup doesn't have. */
async function backedUp() {
  const env = await activateLedger({ now: () => NOW })
  const home = await env.newLedger('Home.tessera')
  await env.session.createSubLedger({ name: 'Before', parentId: null })
  env.files.showSaveDialog.mockImplementationOnce(async options => options?.defaultPath)
  await env.run(LEDGER_COMMANDS.backup)
  await env.session.createSubLedger({ name: 'After', parentId: null })
  return { ...env, home }
}

/** The sub-ledgers in a ledger file, by name. */
async function subLedgersIn(env: LedgerPlugin, at: string) {
  const files = env.driver.databases.get(at)
  if (!files) return undefined
  return [...(files.collections.get('ledger.subledgers')?.docs.values() ?? [])].map(d => (d as unknown as { name: string }).name).sort()
}

/** The automatic backups in the default folder (the ledger closing), as their ledgers' sub-ledgers. */
const autoBackups = (env: LedgerPlugin) => Promise.all([...env.driver.databases.entries()]
  .filter(([f, files]) => path.dirname(f) === FOLDER && files.meta.get(LEDGER_BACKUP_META.kind) === 'auto')
  .map(([f]) => subLedgersIn(env, f)))

const meta = (env: LedgerPlugin, at: string) => Object.fromEntries(env.driver.databases.get(at)?.meta ?? [])

/** The dialog's requests, as the real dialog makes them. */
const dialogOf = (env: LedgerPlugin) => ({
  list: () => env.ask(LEDGER_CHANNELS.restoreList) as Promise<{ folder: string, backups: BackupInfo[] }>,
  plan: (at: string) => env.ask(LEDGER_CHANNELS.restorePlan, { path: at }) as Promise<Result<RestorePlan>>,
  browse: () => env.ask(LEDGER_CHANNELS.restoreBrowse) as Promise<Result<BackupInfo | undefined>>,
  run: (request: RestoreRequest) => env.ask(LEDGER_CHANNELS.restoreRun, request) as Promise<Result<RestoreOutcome>>
})
type Dialog = ReturnType<typeof dialogOf>

/**
 * Runs File › Restore Ledger… with the dialog played by `play`, which returns what the dialog closes with. Resolves
 * what the command resolved, and what `play` recorded.
 */
async function restoreWith<T>(env: LedgerPlugin, play: (dialog: Dialog, input: RestoreDialogInput) => Promise<{ result?: RestoreDialogResult, seen?: T }>, args?: object) {
  let seen: T | undefined
  env.prompts.show.mockImplementationOnce(async (...shown: unknown[]) => {
    if (shown[0] !== LEDGER_DIALOGS.restore) throw new Error(`Unexpected dialog ${String(shown[0])}`)
    const played = await play(dialogOf(env), shown[1] as RestoreDialogInput)
    seen = played.seen
    return played.result
  })
  const ledger = await env.run<LedgerInfo | undefined>(LEDGER_COMMANDS.restore, ...(args ? [args] : []))
  return { ledger, seen }
}

/** Plays the dialog: chooses `backup`, then restores it with `request`. */
const restoring = (backup: string, request: (plan: RestorePlan) => RestoreRequest) => async (dialog: Dialog) => {
  await dialog.list()
  const plan = await dialog.plan(backup)
  if (!plan.ok) return { seen: plan }
  const ran = await dialog.run(request(plan.value))
  return { result: ran.ok ? { ...ran.value, takenAt: plan.value.backup.takenAt } : undefined, seen: ran }
}

const steps = (env: LedgerPlugin) => env.events.filter(e => e.name === LEDGER_CHANNELS.restoreRun.replace('restore.run', 'restore.progress')).map(e => e.data.step)
  .filter((step, i, all) => step !== all[i - 1])

describe('the Restore dialog', () => {
  it('lists the backups in the default backup folder, newest first, saying what each is and which can\'t be restored', async () => {
    const env = await backedUp()
    const other = path.join(FOLDER, 'Old.tesserabkp')
    env.driver.databases.set(other, { collections: new Map(), meta: new Map<string, never>([
      [LEDGER_META.format, 1 as never], [LEDGER_BACKUP_META.takenAt, '2026-10-01T00:00:00.000Z' as never],
      [LEDGER_BACKUP_META.kind, 'auto' as never], [LEDGER_BACKUP_META.ledgerName, 'Old' as never]
    ]) })
    const future = path.join(FOLDER, 'Future.tesserabkp')
    env.driver.databases.set(future, { collections: new Map(), meta: new Map<string, never>([[LEDGER_META.format, 99 as never], [LEDGER_BACKUP_META.takenAt, '2026-11-01T00:00:00.000Z' as never]]) })
    env.disk.foreign.set(path.join(FOLDER, 'Notes.tesserabkp'), 'unknown')

    const { seen } = await restoreWith(env, async dialog => ({ seen: await dialog.list() }))

    expect(seen?.folder).toBe(FOLDER)
    expect(seen?.backups.map(b => [path.basename(b.path), b.ledgerName, b.kind, b.problem])).toEqual([
      ['Home 2026-11-09 10-14-05.tesserabkp', 'Home', 'manual', undefined],
      ['Old.tesserabkp', 'Old', 'auto', undefined],
      // Can't be read, so dated by the file (the epoch, here)
      ['Future.tesserabkp', 'Future', 'ledger', '“Future.tesserabkp” was saved by a newer version of Tessera. Update Tessera to open it.'],
      ['Notes.tesserabkp', 'Notes', 'ledger', '“Notes.tesserabkp” is not a Tessera ledger, or it is damaged.']
    ])
    expect(seen?.backups[0]).toMatchObject({ ledgerId: env.home.id, ledgerPath: file('Home.tessera'), takenAt: NOW.toISOString() })
  })

  it('answers only while File › Restore Ledger… has it open, and restores only what it was shown', async () => {
    const env = await backedUp()
    await expect(env.ask(LEDGER_CHANNELS.restoreList)).rejects.toThrow('File › Restore Ledger… isn’t open.')
    const { seen } = await restoreWith(env, async dialog => ({
      seen: await dialog.run({ backup: file('Elsewhere.tesserabkp'), mode: 'new', folder: DIR, name: 'X' })
    }))
    expect(seen).toEqual({ ok: false, error: { code: 'INVALID', message: 'Choose a backup from the list.' } })
  })

  it('plans a backup of the open ledger: as a new ledger beside it, or in its place, keeping the current file', async () => {
    const env = await backedUp()
    const { seen } = await restoreWith(env, async dialog => { await dialog.list(); return { seen: await dialog.plan(BACKUP) } })
    expect(seen).toEqual({ ok: true, value: {
      backup: expect.objectContaining({ path: BACKUP }),
      asNew: { folder: DIR, name: 'Home (restored 2026-11-09)' },
      inPlace: { path: file('Home.tessera'), name: 'Home', isOpen: true, keepAs: KEPT }
    } })
  })

  it('finds the ledger of a backup among the recent ledgers when it isn\'t open, and says when it isn\'t on this computer', async () => {
    const env = await backedUp()
    await env.session.create(file('Other.tessera'))
    const recent = await restoreWith(env, async dialog => { await dialog.list(); return { seen: await dialog.plan(BACKUP) } })
    expect((recent.seen as Result<RestorePlan>)).toMatchObject({ ok: true, value: { inPlace: { path: file('Home.tessera'), isOpen: false } } })

    // Home is gone: it can only be restored as a new ledger, under its own name in its own folder
    env.driver.databases.delete(file('Home.tessera'))
    const gone = await restoreWith(env, async dialog => { await dialog.list(); return { seen: await dialog.plan(BACKUP) } })
    expect(gone.seen).toMatchObject({ ok: true, value: {
      asNew: { folder: DIR, name: 'Home' },
      inPlace: { unavailable: '“Home” isn’t on this computer, or has been moved or deleted. Restore it as a new ledger.' }
    } })
  })

  it('finds a ledger that has moved since its backup, by its id in the recent list', async () => {
    const env = await backedUp()
    await env.session.create(file('Other.tessera'))
    // Home moves to another folder, and is opened there once: the backup still names its old place
    const moved = path.join(DIR, 'Moved', 'Home.tessera')
    env.driver.databases.set(moved, env.driver.databases.get(file('Home.tessera'))!)
    env.driver.databases.delete(file('Home.tessera'))
    await env.session.open(moved)
    await env.session.open(file('Other.tessera'))
    const { seen } = await restoreWith(env, async dialog => { await dialog.list(); return { seen: await dialog.plan(BACKUP) } })
    expect(seen).toMatchObject({ ok: true, value: { inPlace: { path: moved, isOpen: false } } })
  })

  it('offers a backup given to the command, and one chosen with Browse…', async () => {
    const env = await backedUp()
    const elsewhere = path.join(DIR, 'USB', 'Home copy.tesserabkp')
    env.driver.databases.set(elsewhere, structuredClone(env.driver.databases.get(BACKUP)!))
    const given = await restoreWith(env, async (dialog, input) => ({ seen: { input, plan: await dialog.plan(input.preselect!) } }), { path: elsewhere })
    expect(given.seen).toMatchObject({ input: { preselect: elsewhere }, plan: { ok: true } })

    env.files.showOpenDialog.mockResolvedValueOnce(elsewhere)
    const browsed = await restoreWith(env, async dialog => ({ seen: await dialog.browse() }))
    expect(browsed.seen).toMatchObject({ ok: true, value: { path: elsewhere, ledgerName: 'Home' } })
    expect(env.files.showOpenDialog).toHaveBeenCalledWith(expect.objectContaining({ title: 'Choose a Backup', defaultPath: FOLDER }))
  })

  it('holds the ledger while it is open: nothing else opens, closes, imports or backs up', async () => {
    const env = await backedUp()
    const { seen } = await restoreWith(env, async () => ({
      seen: { busy: env.key(K.isBusy), operation: env.key(K.operation), backup: env.enabled(LEDGER_COMMANDS.backup), close: env.enabled(LEDGER_COMMANDS.close) }
    }))
    expect(seen).toEqual({ busy: true, operation: 'Restoring a ledger', backup: false, close: false })
    expect(env.key(K.isBusy)).toBe(false)
    const importing = env.session.beginOperation('Importing statements')
    expect(env.enabled(LEDGER_COMMANDS.restore)).toBe(false)
    importing.dispose()
    expect(env.enabled(LEDGER_COMMANDS.restore)).toBe(true)
  })
})

describe('archive files', () => {
  const ARCHIVE = path.join(FOLDER, 'Archives', 'Home (archive before 2026-01-01).tesserabkp')

  /** Home, backed up as above; then its archive file made, holding "Before" and "After"; then a sub-ledger "Later". */
  async function archived() {
    const env = await backedUp()
    const db = await env.engine.open({ path: file('Home.tessera') })     // the open ledger's own database
    await db.snapshot({ path: ARCHIVE }, { meta: {
      // An hour after the backup, in every time zone (the test's clock is local)
      [LEDGER_BACKUP_META.takenAt]: new Date(NOW.getTime() + 3_600_000).toISOString(), [LEDGER_BACKUP_META.kind]: 'archive', [LEDGER_BACKUP_META.ledgerName]: 'Home',
      [LEDGER_BACKUP_META.ledgerPath]: file('Home.tessera'), [LEDGER_BACKUP_META.takenWith]: 'ledger test', [LEDGER_BACKUP_META.archiveBefore]: '2026-01-01'
    } })
    await env.session.createSubLedger({ name: 'Later', parentId: null })
    return env
  }

  it('are listed from the Archives folder, saying what they hold; nothing else there is', async () => {
    const env = await archived()
    // An ordinary backup someone moved into the Archives folder: neither an archive nor in the default folder
    env.driver.databases.set(path.join(FOLDER, 'Archives', 'Moved.tesserabkp'), structuredClone(env.driver.databases.get(BACKUP)!))

    const { seen } = await restoreWith(env, async dialog => ({ seen: await dialog.list() }))

    expect(seen?.backups.map(b => [path.basename(b.path), b.kind, b.archiveBefore, b.problem])).toEqual([
      ['Home (archive before 2026-01-01).tesserabkp', 'archive', '2026-01-01', undefined],
      ['Home 2026-11-09 10-14-05.tesserabkp', 'manual', undefined, undefined]
    ])
  })

  it('restore in place of their ledger, even while open for viewing: the ledger as it was before archiving', async () => {
    const env = await archived()
    env.files.showOpenDialog.mockResolvedValueOnce(ARCHIVE)
    await env.run(LEDGER_COMMANDS.open)
    expect(env.session.current?.archive).toBeDefined()

    const { ledger } = await restoreWith(env, restoring(ARCHIVE, plan => ({ backup: ARCHIVE, mode: 'inPlace', keepAs: (plan.inPlace as { keepAs: string }).keepAs })))

    expect(ledger).toMatchObject({ path: file('Home.tessera'), id: env.home.id })
    expect(ledger?.archive).toBeUndefined()
    expect(env.key(K.isArchive)).toBe(false)
    expect(await subLedgersIn(env, file('Home.tessera'))).toEqual(['After', 'Before'])
    expect(Object.keys(meta(env, file('Home.tessera'))).filter(k => k.startsWith('backup.'))).toEqual([])
    // What was added since is in the kept file; the archive file is as it was
    expect(await subLedgersIn(env, file(`${KEPT}.tessera`))).toEqual(['After', 'Before', 'Later'])
    expect(meta(env, ARCHIVE)[LEDGER_BACKUP_META.kind]).toBe('archive')
  })

  it('restore as a new ledger, a writable ledger of its own', async () => {
    const env = await archived()
    const { ledger } = await restoreWith(env, restoring(ARCHIVE, plan => ({ backup: ARCHIVE, mode: 'new', folder: plan.asNew.folder, name: plan.asNew.name })))
    expect(ledger).toMatchObject({ readOnly: false })
    expect(ledger?.archive).toBeUndefined()
    expect(ledger?.id).not.toBe(env.home.id)
    expect(await subLedgersIn(env, ledger!.path)).toEqual(['After', 'Before'])
  })
})

describe('restoring as a new ledger', () => {
  it('opens a ledger of its own, with the backup\'s contents and a new id, leaving the current one as it was', async () => {
    const env = await backedUp()
    const { ledger } = await restoreWith(env, restoring(BACKUP, plan => ({ backup: BACKUP, mode: 'new', ...plan.asNew })))

    const restored = file('Home (restored 2026-11-09).tessera')
    expect(ledger).toMatchObject({ path: restored, name: 'Home (restored 2026-11-09)' })
    expect(env.session.current?.path).toBe(restored)
    expect(await subLedgersIn(env, restored)).toEqual(['Before'])
    const m = meta(env, restored)
    expect(m[LEDGER_META.id]).toEqual(expect.any(String))
    expect(m[LEDGER_META.id]).not.toBe(env.home.id)
    expect(m[LEDGER_META.restoredFrom]).toEqual({ id: env.home.id, takenAt: NOW.toISOString() })
    expect(Object.keys(m).filter(k => k.startsWith('backup.'))).toEqual([])
    // Home: untouched, and the backup too
    expect(await subLedgersIn(env, file('Home.tessera'))).toEqual(['After', 'Before'])
    expect(env.driver.databases.has(BACKUP)).toBe(true)
    expect([...env.driver.databases.keys()].filter(f => f.includes('.restoring-'))).toEqual([])
    expect(env.key(K.activity)).toMatch(/^Restored “Home \(restored 2026-11-09\)” as it was on /)
    expect(env.key(K.isBusy)).toBe(false)
    // Said once it is done: what it is, and where
    const said = env.prompts.message.mock.calls.at(-1)?.[0]
    expect(said).toMatchObject({ kind: 'info', message: '“Home (restored 2026-11-09)” has been restored.' })
    expect(said?.detail).toMatch(/^It is as it was on .+\. /)
    expect(said?.detail).toContain(`It is “Home (restored 2026-11-09).tessera”, in “${DIR}”.`)
    // Home changed since its backup, and closed for the restored ledger to open: backed up as it closed
    expect(await autoBackups(env)).toEqual([['After', 'Before']])
  })

  it('refuses a name that is taken or can\'t be a file name, and a folder that isn\'t there, changing nothing', async () => {
    const env = await backedUp()
    const tries: RestoreRequest[] = [
      { backup: BACKUP, mode: 'new', folder: DIR, name: 'Home' },
      { backup: BACKUP, mode: 'new', folder: DIR, name: 'a/b' },
      { backup: BACKUP, mode: 'new', folder: DIR, name: 'CON' },
      { backup: BACKUP, mode: 'new', folder: path.join(DIR, 'Missing'), name: 'Fine' }
    ]
    const { seen } = await restoreWith(env, async dialog => {
      await dialog.list()
      const results = []
      for (const request of tries) results.push(await dialog.run(request))
      return { seen: results.map(r => !r.ok && [r.error.field, r.error.message]) }
    })
    expect(seen).toEqual([
      ['name', '“Home.tessera” is already in that folder. Choose another name.'],
      ['name', 'A name can’t contain < > : " / \\ | ? * or control characters.'],
      ['name', '“CON” is a name Windows keeps for itself. Choose another.'],
      ['folder', `The folder “${path.join(DIR, 'Missing')}” isn’t available. Choose another.`]
    ])
    expect(env.session.current?.name).toBe('Home')
    expect([...env.driver.databases.keys()].filter(f => f.includes('.restoring-'))).toEqual([])
  })
})

describe('restoring in place of a ledger', () => {
  it('keeps the current file under the name chosen, gives the backup its name, and reopens it, deleting nothing', async () => {
    const env = await backedUp()
    const { ledger } = await restoreWith(env, restoring(BACKUP, plan => ({ backup: BACKUP, mode: 'inPlace', keepAs: (plan.inPlace as { keepAs: string }).keepAs })))

    const kept = file(`${KEPT}.tessera`)
    expect(ledger).toMatchObject({ path: file('Home.tessera'), name: 'Home', id: env.home.id })
    expect(env.session.current?.path).toBe(file('Home.tessera'))
    expect(await subLedgersIn(env, file('Home.tessera'))).toEqual(['Before'])
    expect(Object.keys(meta(env, file('Home.tessera'))).filter(k => k.startsWith('backup.'))).toEqual([])
    // The current file: kept, as it was, as a ledger of its own
    expect(await subLedgersIn(env, kept)).toEqual(['After', 'Before'])
    expect(meta(env, kept)[LEDGER_META.id]).not.toBe(env.home.id)
    expect(env.trashed).toEqual([])
    expect(env.files.trash).not.toHaveBeenCalled()
    const said = env.prompts.message.mock.calls.at(-1)?.[0]
    expect(said?.message).toBe('“Home” has been restored.')
    expect(said?.detail).toContain(`The file you had before is kept as “${KEPT}.tessera”, in “${DIR}”.`)
    expect(steps(env)).toEqual(['Copying the backup', 'Closing “Home”', `Keeping the current “Home” as “${KEPT}”`, 'Opening “Home”'])
    // Not backed up as it closed: the current file is kept, so a backup of it would only be a second copy
    expect(await autoBackups(env)).toEqual([])
  })

  it('restores a ledger that isn\'t open, closing the one that is', async () => {
    const env = await backedUp()
    await env.session.create(file('Other.tessera'))
    await restoreWith(env, restoring(BACKUP, plan => ({ backup: BACKUP, mode: 'inPlace', keepAs: (plan.inPlace as { keepAs: string }).keepAs })))
    expect(env.session.current?.name).toBe('Home')
    expect(await subLedgersIn(env, file('Home.tessera'))).toEqual(['Before'])
    expect(steps(env)).not.toContain('Closing “Home”')
  })

  it('moves the current file\'s side files with it, so none is applied to the restored file', async () => {
    const env = await backedUp()
    await env.session.create(file('Other.tessera'))
    env.disk.sides.add(file('Home.tessera-wal'))           // as a crash leaves it
    await restoreWith(env, restoring(BACKUP, plan => ({ backup: BACKUP, mode: 'inPlace', keepAs: (plan.inPlace as { keepAs: string }).keepAs })))
    expect([...env.disk.sides]).toEqual([file(`${KEPT}.tessera-wal`)])
  })

  it('refuses a name to keep the current file under that is taken, or is its own, changing nothing', async () => {
    const env = await backedUp()
    env.driver.databases.set(file('Taken.tessera'), { collections: new Map(), meta: new Map() })
    const { seen } = await restoreWith(env, async dialog => {
      await dialog.list()
      const taken = await dialog.run({ backup: BACKUP, mode: 'inPlace', keepAs: 'Taken' })
      const own = await dialog.run({ backup: BACKUP, mode: 'inPlace', keepAs: 'Home' })
      const none = await dialog.run({ backup: BACKUP, mode: 'inPlace' })
      return { seen: [taken, own, none].map(r => !r.ok && [r.error.field, r.error.message]) }
    })
    expect(seen).toEqual([
      ['keepAs', '“Taken.tessera” is already there. Choose another name.'],
      ['keepAs', 'Choose a name other than “Home” to keep the current file under.'],
      ['keepAs', 'Enter a name.']
    ])
    expect(await subLedgersIn(env, file('Home.tessera'))).toEqual(['After', 'Before'])
    expect(env.session.current?.name).toBe('Home')
  })
})

describe('when a restore fails, the files are as they were', () => {
  const inPlace = (plan: RestorePlan): RestoreRequest => ({ backup: BACKUP, mode: 'inPlace', keepAs: (plan.inPlace as { keepAs: string }).keepAs })

  async function failing(setup: (env: LedgerPlugin) => void) {
    const env = await backedUp()
    setup(env)
    const { ledger, seen } = await restoreWith(env, restoring(BACKUP, inPlace))
    return { env, ledger, error: (seen as Result<RestoreOutcome>).ok ? undefined : (seen as { error: { code: string, message: string } }).error }
  }

  const unchanged = async (env: LedgerPlugin) => {
    expect(env.session.current?.path).toBe(file('Home.tessera'))
    expect(await subLedgersIn(env, file('Home.tessera'))).toEqual(['After', 'Before'])
    expect(env.driver.databases.has(file(`${KEPT}.tessera`))).toBe(false)
    expect([...env.driver.databases.keys()].filter(f => f.includes('.restoring-'))).toEqual([])
    expect(env.key(K.isBusy)).toBe(false)
  }

  it('when the copy fails (a full disk)', async () => {
    const { env, ledger, error } = await failing(env => { env.disk.hooks.copy = () => { throw errno('ENOSPC') } })
    expect(ledger).toBeUndefined()
    expect(error).toEqual({ code: 'RESTORE_FAILED', message: `There isn’t enough space in “${DIR}”.` })
    await unchanged(env)
  })

  it('when another program holds the current file for good: it is reopened as it was', async () => {
    const { env, error } = await failing(env => { env.disk.hooks.rename = from => { if (from === file('Home.tessera')) throw errno('EBUSY') } })
    expect(error).toEqual({ code: 'RESTORE_FAILED', message: 'Another program, such as a sync or antivirus program, is using “Home.tessera”. Try again in a moment.' })
    await unchanged(env)
  })

  it('when the copy can\'t take the ledger\'s name: the current file is put back', async () => {
    const { env, error } = await failing(env => { env.disk.hooks.rename = from => { if (from.includes('.restoring-')) throw errno('EBUSY') } })
    expect(error?.code).toBe('RESTORE_FAILED')
    await unchanged(env)
  })

  it('when the restored copy won\'t open: it goes, and the current file is put back and reopened', async () => {
    const { env, error } = await failing(env => {
      const open = env.engine.open.bind(env.engine)
      let restoredOpened = false
      env.engine.open = async (target, options) => {
        // The first open of Home after the copy has taken its name: the restored file
        if ('path' in target && target.path === file('Home.tessera') && !restoredOpened && env.driver.databases.get(file('Home.tessera'))?.meta.has(LEDGER_BACKUP_META.takenAt)) {
          restoredOpened = true
          throw new Error('damaged')
        }
        return open(target, options)
      }
    })
    expect(error).toEqual({ code: 'UNSUPPORTED_FILE', message: '“Home.tessera” is not a Tessera ledger, or it is damaged.' })
    await unchanged(env)
  })
})

describe('restoring with no ledger open, and when the dialog\'s window closes', () => {
  it('restores a ledger that won\'t open, from the start', async () => {
    const env = await backedUp()
    await env.session.close()
    env.driver.databases.get(file('Home.tessera'))!.meta.set(LEDGER_META.format, 'damaged' as never)
    await expect(env.session.open(file('Home.tessera'))).rejects.toMatchObject({ code: 'UNSUPPORTED_FILE' })

    await restoreWith(env, restoring(BACKUP, inPlace))
    expect(env.session.current?.name).toBe('Home')
    expect(await subLedgersIn(env, file('Home.tessera'))).toEqual(['Before'])
    expect(meta(env, file(`${KEPT}.tessera`))[LEDGER_META.format]).toBe('damaged')
  })

  it('restores a ledger file that isn\'t a backup (a copy made before an upgrade)', async () => {
    const env = await backedUp()
    const copy = file('Home.backup-2026-11-04_10-11-12.tessera')
    env.driver.databases.set(copy, structuredClone(env.driver.databases.get(file('Home.tessera'))!))
    env.files.showOpenDialog.mockResolvedValueOnce(copy)
    const { ledger } = await restoreWith(env, async dialog => {
      const browsed = await dialog.browse()
      const plan = await dialog.plan(copy)
      if (!browsed.ok || !plan.ok) throw new Error('not offered')
      const ran = await dialog.run({ backup: copy, mode: 'new', ...plan.value.asNew })
      return { result: ran.ok ? { ...ran.value, takenAt: plan.value.backup.takenAt } : undefined, seen: { kind: browsed.value?.kind } }
    })
    expect(ledger?.name).toBe('Home (restored 2026-11-09)')
  })

  it('lets the ledger go only once a restore that outlives its window has finished', async () => {
    const env = await backedUp()
    const ledger = await restoreWith(env, async dialog => {
      await dialog.list()
      const plan = await dialog.plan(BACKUP)
      if (!plan.ok) throw new Error('no plan')
      void dialog.run({ backup: BACKUP, mode: 'new', ...plan.value.asNew })       // not waited for: the window closed
      return {}
    })
    expect(ledger.ledger).toBeUndefined()
    // The command waited for the restore before it let the ledger go
    expect(env.session.current?.name).toBe('Home (restored 2026-11-09)')
    expect(env.key(K.isBusy)).toBe(false)
  })
})

const inPlace = (plan: RestorePlan): RestoreRequest => ({ backup: BACKUP, mode: 'inPlace', keepAs: (plan.inPlace as { keepAs: string }).keepAs })
