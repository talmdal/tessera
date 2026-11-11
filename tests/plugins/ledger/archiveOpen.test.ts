// @vitest-environment node
// Opening an archive file: File › Open Ledger… opens it read-only, to look at. Nothing can change it, it isn't backed
// up or deleted from Tessera, it doesn't join the recent list, and it shares no id with its ledger while open. Other
// backups are still refused. See docs/ledger-compaction-design.md, "Opening the archive file".
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  LEDGER_ARCHIVE_FILTER, LEDGER_ARCHIVES_FOLDER, LEDGER_BACKUP_META, LEDGER_COMMANDS, LEDGER_CONTEXT_KEYS as K,
  LEDGER_SCHEMA_POINT, displayDate, type LedgerInfo
} from '@tessera/ledger-api'
import type { Database } from '@tessera/types'
import { DIR, contributor, file, setupSession } from './harness'
import { activateLedger, type LedgerPlugin } from './plugin'

const NOW = new Date(2026, 10, 10, 12)
const FOLDER = path.join(DIR, 'Documents', 'Tessera Backups')
const ARCHIVE = path.join(FOLDER, LEDGER_ARCHIVES_FOLDER, 'Home (archive before 2026-01-01).tesserabkp')
const TAKEN = '2026-11-10T17:00:00.000Z'

/** The meta File › Archive Ledger… gives the archive file it makes (archiveCommand.test.ts checks it does). */
const archiveMeta = (ledger: string) => ({
  [LEDGER_BACKUP_META.takenAt]: TAKEN, [LEDGER_BACKUP_META.kind]: 'archive', [LEDGER_BACKUP_META.ledgerName]: 'Home',
  [LEDGER_BACKUP_META.ledgerPath]: ledger, [LEDGER_BACKUP_META.takenWith]: 'ledger test', [LEDGER_BACKUP_META.archiveBefore]: '2026-01-01'
})

/** The open ledger's own database (the engine hands back the one it has open), to snapshot as the ledger does. */
const rawDatabase = (env: { engine: { open(target: { path: string }): Promise<Database> } }, at: string) => env.engine.open({ path: at })

/** Home open, with a sub-ledger "Before"; its archive file made; then a sub-ledger "After", which the archive lacks. */
async function archived() {
  const env = await activateLedger({ now: () => NOW })
  const home = await env.newLedger('Home.tessera')
  await env.session.createSubLedger({ name: 'Before', parentId: null })
  await (await rawDatabase(env, home.path)).snapshot({ path: ARCHIVE }, { meta: archiveMeta(home.path) })
  await env.session.createSubLedger({ name: 'After', parentId: null })
  /** Opens a file with File › Open Ledger…, answering its dialog. */
  const openWithDialog = async (at: string) => {
    env.files.showOpenDialog.mockResolvedValueOnce(at)
    return env.run<LedgerInfo | undefined>(LEDGER_COMMANDS.open)
  }
  return { ...env, home, openWithDialog }
}

/** A file as the memory engine holds it, to compare before and after. */
const contents = (env: LedgerPlugin, at: string) => {
  const files = env.driver.databases.get(at)!
  return JSON.stringify({ collections: [...files.collections].map(([name, c]) => [name, [...c.docs.values()]]), meta: [...files.meta] })
}

const backupsIn = (env: LedgerPlugin) => [...env.driver.databases.keys()].filter(f => path.dirname(f) === FOLDER)

describe('opening an archive file', () => {
  it('opens it read-only from File › Open Ledger…, and says what it is', async () => {
    const { openWithDialog, key, session, files, enabled } = await archived()
    const opened = await openWithDialog(ARCHIVE)

    expect(opened).toEqual({
      path: ARCHIVE, name: 'Home (archive before 2026-01-01)', readOnly: true,
      archive: { before: '2026-01-01', takenAt: TAKEN, ledgerName: 'Home' }
    })
    // Its ledger's id isn't its own
    expect(session.current?.id).toBeUndefined()
    expect((await session.tree()).subLedgers.map(s => s.name)).toEqual(['Before'])
    expect([key(K.isOpen), key(K.isReadOnly), key(K.isArchive)]).toEqual([true, true, true])
    expect(key(K.archive)).toBe(`Archive of “Home”, before ${displayDate('2026-01-01')} · read-only`)
    // An archive file can't be archived, or backed up
    expect([enabled(LEDGER_COMMANDS.archive), enabled(LEDGER_COMMANDS.backup)]).toEqual([false, false])
    // The Open dialog offers archives
    const [options] = files.showOpenDialog.mock.calls[0] as unknown as [{ filters: unknown[] }]
    expect(options.filters).toContainEqual(LEDGER_ARCHIVE_FILTER)
  })

  it('changes nothing in it: every write is refused, and the file is as it was afterwards', async () => {
    const env = await archived()
    const before = contents(env, ARCHIVE)
    await env.openWithDialog(ARCHIVE)
    const [sub] = (await env.session.tree()).subLedgers

    await expect(env.session.createSubLedger({ name: 'New', parentId: null })).rejects.toMatchObject({ code: 'READ_ONLY' })
    await expect(env.session.renameSubLedger(sub.id, 'Renamed')).rejects.toMatchObject({ code: 'READ_ONLY' })
    await expect(env.session.deleteSubLedger(sub.id)).rejects.toMatchObject({ code: 'READ_ONLY' })
    await env.run(LEDGER_COMMANDS.close)

    expect(contents(env, ARCHIVE)).toBe(before)
  })

  it('stays out of the recent list, and the next start reopens the ledger, not the archive', async () => {
    const env = await archived()
    const recent = env.state.values.get('ledger.recent')
    await env.openWithDialog(ARCHIVE)
    expect(env.state.values.get('ledger.recent')).toEqual(recent)
    expect(env.state.values.get('ledger.last')).toBe(env.home.path)

    // Quitting with the archive open, and starting again
    expect(await env.runtime.lifecycle.requestShutdown('user')).toBe(true)
    const next = await activateLedger({ now: () => NOW, state: env.state })
    next.driver.databases.set(env.home.path, env.driver.databases.get(env.home.path)!)
    await next.runtime.lifecycle.markStarted()
    expect(next.session.current?.path).toBe(env.home.path)
  })

  it('is never backed up: not by Back Up Ledger…, nor as it closes, nor on quitting', async () => {
    const env = await archived()
    await env.run(LEDGER_COMMANDS.close)         // Home is backed up as it closes: it changed
    const made = backupsIn(env)
    expect(made).toHaveLength(1)

    await env.openWithDialog(ARCHIVE)
    expect(env.enabled(LEDGER_COMMANDS.backup)).toBe(false)
    expect(await env.runtime.lifecycle.askToQuit()).toEqual([])
    await env.run(LEDGER_COMMANDS.close)
    await env.openWithDialog(ARCHIVE)
    await env.openWithDialog(env.home.path)      // switching away from it

    expect(backupsIn(env)).toEqual(made)
  })

  it('can\'t be deleted from Tessera', async () => {
    const env = await archived()
    await env.openWithDialog(ARCHIVE)
    expect(env.enabled(LEDGER_COMMANDS.delete)).toBe(false)
    await expect(env.session.delete()).rejects.toMatchObject({ code: 'READ_ONLY' })
    expect(env.trashed).toEqual([])
    expect(env.driver.databases.has(ARCHIVE)).toBe(true)
  })

  it('gives way to the ledger when it is opened again', async () => {
    const env = await archived()
    await env.openWithDialog(ARCHIVE)
    const home = await env.openWithDialog(env.home.path)
    expect(home).toMatchObject({ path: env.home.path, readOnly: false, id: env.home.id })
    expect(home?.archive).toBeUndefined()
    expect([env.key(K.isArchive), env.key(K.archive), env.key(K.isReadOnly)]).toEqual([false, undefined, false])
    expect(env.enabled(LEDGER_COMMANDS.backup)).toBe(true)
  })

  it('still refuses every other kind of backup, pointing to Restore', async () => {
    const env = await archived()
    env.files.showSaveDialog.mockImplementationOnce(async options => options?.defaultPath)
    const backup = await env.run<string>(LEDGER_COMMANDS.backup)
    await expect(env.session.open(backup)).rejects.toMatchObject({
      code: 'UNSUPPORTED_FILE', message: expect.stringContaining('is a backup, not a ledger. Use File › Restore Ledger… to restore it.')
    })
    // An archive file whose meta lacks its archive date is a backup like any other
    const odd = path.join(FOLDER, 'Odd.tesserabkp')
    await (await rawDatabase(env, env.home.path)).snapshot({ path: odd }, { meta: { ...archiveMeta(env.home.path), [LEDGER_BACKUP_META.archiveBefore]: 'soon' } })
    await expect(env.session.open(odd)).rejects.toMatchObject({ code: 'UNSUPPORTED_FILE' })
    // Only the kind makes an archive: an ordinary backup carrying an archive date is still refused
    const manual = path.join(FOLDER, 'Manual with a date.tesserabkp')
    await (await rawDatabase(env, env.home.path)).snapshot({ path: manual }, { meta: { ...archiveMeta(env.home.path), [LEDGER_BACKUP_META.kind]: 'manual' } })
    await expect(env.session.open(manual)).rejects.toMatchObject({ code: 'UNSUPPORTED_FILE', message: expect.stringContaining('is a backup, not a ledger') })
  })
})

describe('an archive made by another version of Tessera', () => {
  /** A session whose `budget` plugin is at `version`, with an archive made while it was at 1 (or absent). */
  async function withBudget(archivedWith: 1 | 'none', openWith: 1 | 2) {
    const env = setupSession({ now: () => NOW })
    const made = archivedWith === 1 ? contributor('budget', 1) : undefined
    const joined = made && env.extensions.contribute('budget', LEDGER_SCHEMA_POINT, 'budget', made.contribution)
    if (made) env.services.provide('budget', made.contribution.migrator, made.migrator)
    const home = await env.created()
    if (made) await env.session.database('budget').collection('budget.things').insert({ name: 'Groceries' })
    await (await rawDatabase(env, home.path)).snapshot({ path: ARCHIVE }, { meta: archiveMeta(home.path) })
    await env.session.close()

    joined?.dispose()
    const now = contributor('budget', openWith)
    env.extensions.contribute('budget', LEDGER_SCHEMA_POINT, 'budget', now.contribution)
    if (!env.services.has(now.contribution.migrator)) env.services.provide('budget', now.contribution.migrator, now.migrator)
    return { ...env, migrator: now.migrator }
  }

  it('opens when a plugin has no data in it (installed since): its collections read as empty', async () => {
    const { session, migrator, driver } = await withBudget('none', 1)
    const before = JSON.stringify([...driver.databases.get(ARCHIVE)!.meta])
    await session.open(ARCHIVE)
    expect(await session.database('budget').collection('budget.things').find()).toEqual([])
    expect(migrator.migrate).not.toHaveBeenCalled()
    expect(JSON.stringify([...driver.databases.get(ARCHIVE)!.meta])).toBe(before)
  })

  it('refuses when a plugin\'s data in it is older, saying to restore it as a new ledger', async () => {
    const { session, migrator } = await withBudget(1, 2)
    await expect(session.open(ARCHIVE)).rejects.toMatchObject({
      code: 'UNSUPPORTED_FILE',
      message: '“Home (archive before 2026-01-01)” was made by an earlier version of Tessera, so it can’t be opened as it is. To open it, restore it as a new ledger with File › Restore Ledger….'
    })
    expect(migrator.migrate).not.toHaveBeenCalled()
    expect(session.current).toBeUndefined()
  })

  it('opens one another program switched to WAL mode, and notes the files that leaves beside it', async () => {
    const { session, disk, log } = await withBudget(1, 1)
    disk.wal.add(ARCHIVE)
    expect((await session.open(ARCHIVE))?.archive).toBeDefined()
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('is in WAL mode: another program changed it'))
  })
})
