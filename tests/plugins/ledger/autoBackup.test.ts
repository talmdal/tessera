// @vitest-environment node
// Backing up when the ledger closes, through the activated plugin on a memory engine: on each way of closing, only
// when there is something new, in pass 1 of a user quit, and within a budget on an OS shutdown.
// See docs/backup-restore-design.md, "Backing up when the ledger closes".
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { LEDGER_BACKUP_META, LEDGER_COMMANDS, LEDGER_CONTEXT_KEYS as K, LEDGER_META } from '@tessera/ledger-api'
import { SETTINGS_OPEN_COMMAND } from '@tessera/types'
import { OPERATION_WAIT_MS, SHUTDOWN_BUDGET_MS } from '../../../plugins/ledger/src/privileged/backup/autoBackup'
import { dateTime } from '../../../plugins/ledger/src/privileged/backup/naming'
import { DIR, errno, file, memoryAppState } from './harness'
import { activateLedger, type LedgerPlugin, type PluginOptions } from './plugin'

const START = new Date(2026, 10, 9, 10, 14, 5)
const FOLDER = path.join(DIR, 'Documents', 'Tessera Backups')

/** The plugin on a clock that moves a minute each time it is read, so each backup has a name of its own. */
async function plugin(options: PluginOptions = {}) {
  let minutes = 0
  const env = await activateLedger({ now: () => new Date(START.getTime() + 60_000 * minutes++), ...options })
  const activity: unknown[] = []
  env.runtime.contextKeys.onDidChange(() => {
    const text = env.key(K.activity)
    if (activity.at(-1) !== text) activity.push(text)
  })
  return { ...env, activity }
}

/** The backups in the default folder, as [name, kind, sub-ledgers]. */
function backups(env: LedgerPlugin) {
  return [...env.driver.databases.entries()].filter(([f]) => path.dirname(f) === FOLDER).sort(([a], [b]) => a.localeCompare(b)).map(([f, files]) => ({
    name: path.basename(f),
    kind: files.meta.get(LEDGER_BACKUP_META.kind),
    id: files.meta.get(LEDGER_META.id),
    subLedgers: [...(files.collections.get('ledger.subledgers')?.docs.values() ?? [])].map(d => (d as unknown as { name: string }).name).sort()
  }))
}

/** Lets promise chains and queued work run (no timers move: they are the test's). */
const turns = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise(resolve => setImmediate(resolve)) }

const partials = (env: LedgerPlugin) => [...env.driver.databases.keys()].filter(f => f.endsWith('.partial'))

/** Home, opened afresh (so it starts unchanged), already backed up once by hand. */
async function homeBackedUp(options: PluginOptions = {}) {
  const env = await plugin(options)
  await env.newLedger('Home.tessera')
  await env.session.createSubLedger({ name: 'Personal', parentId: null })
  env.files.showSaveDialog.mockImplementation(async o => o?.defaultPath)
  await env.run(LEDGER_COMMANDS.backup)
  expect(backups(env)).toHaveLength(1)
  return env
}

describe('backing up as the ledger closes', () => {
  it('backs up on Close Ledger after a change, in the default folder, and shows it in the status bar', async () => {
    const env = await homeBackedUp()
    await env.session.createSubLedger({ name: 'Savings', parentId: null })

    await env.run(LEDGER_COMMANDS.close)

    expect(env.session.current).toBeUndefined()
    const made = backups(env).filter(b => b.kind === 'auto')
    expect(made).toEqual([expect.objectContaining({ kind: 'auto', subLedgers: ['Personal', 'Savings'] })])
    expect(made[0].name).toMatch(/^Home 2026-11-09 10-\d\d-05\.tesserabkp$/)
    expect(env.activity.at(-1)).toMatch(/^Backed up “Home” at /)
    expect(partials(env)).toEqual([])
  })

  it('makes no backup when nothing changed since the last one, so retention keeps the meaningful ones', async () => {
    const env = await homeBackedUp()
    await env.run(LEDGER_COMMANDS.close)
    await env.session.open(file('Home.tessera'))
    await env.run(LEDGER_COMMANDS.close)
    expect(backups(env).map(b => b.kind)).toEqual(['manual'])
  })

  it('backs up a ledger never backed up, even unchanged; then, unchanged, not again', async () => {
    const env = await plugin()
    await env.newLedger('Home.tessera')
    await env.run(LEDGER_COMMANDS.close)
    expect(backups(env).map(b => b.kind)).toEqual(['auto'])

    await env.session.open(file('Home.tessera'))
    await env.run(LEDGER_COMMANDS.close)
    expect(backups(env)).toHaveLength(1)

    await env.session.open(file('Home.tessera'))
    await env.session.createSubLedger({ name: 'Changed', parentId: null })
    await env.run(LEDGER_COMMANDS.close)
    expect(backups(env)).toHaveLength(2)

    // Its backups forgotten (another computer's state): unchanged, but backed up again
    env.state.values.delete('ledger.backup.last')
    await env.session.open(file('Home.tessera'))
    await env.run(LEDGER_COMMANDS.close)
    expect(backups(env)).toHaveLength(3)
  })

  it('backs up the open ledger before another opens, or a new one is created', async () => {
    const env = await homeBackedUp()
    await env.session.createSubLedger({ name: 'Savings', parentId: null })
    await env.session.create(file('Work.tessera'))
    expect(backups(env).filter(b => b.kind === 'auto').map(b => b.subLedgers)).toEqual([['Personal', 'Savings']])

    await env.session.createSubLedger({ name: 'Clients', parentId: null })
    await env.session.open(file('Home.tessera'))
    const auto = backups(env).filter(b => b.kind === 'auto')
    expect(auto.map(b => b.name.split(' ')[0])).toEqual(['Home', 'Work'])
    expect(auto[1].subLedgers).toEqual(['Clients'])
    expect(env.session.current?.name).toBe('Home')
  })

  it('includes what plugins write as the ledger closes', async () => {
    const env = await homeBackedUp()
    env.session.onWillClose(async () => { await env.session.createSubLedger({ name: 'Written while closing', parentId: null }) })
    await env.run(LEDGER_COMMANDS.close)
    expect(backups(env).find(b => b.kind === 'auto')?.subLedgers).toEqual(['Personal', 'Written while closing'])
  })

  it('does not back up a ledger being deleted', async () => {
    const env = await homeBackedUp()
    await env.session.createSubLedger({ name: 'Savings', parentId: null })
    expect(await env.session.delete()).toBe(true)
    expect(backups(env).map(b => b.kind)).toEqual(['manual'])
  })

  it('does not back up when the setting is off', async () => {
    const env = await plugin({ settings: { 'ledger.backup': { onClose: false } } })
    await env.newLedger('Home.tessera')
    await env.session.createSubLedger({ name: 'Savings', parentId: null })
    await env.run(LEDGER_COMMANDS.close)
    expect(backups(env)).toEqual([])
  })

  it('goes to the folder chosen on the Backups page, where retention trims it', async () => {
    const elsewhere = path.join(DIR, 'Backup drive')
    const env = await plugin({ settings: { 'ledger.backup': { folder: elsewhere, keepAtLeast: 1, retentionDays: 1 } } })
    await env.newLedger('Home.tessera')
    await env.run(LEDGER_COMMANDS.close)
    const first = [...env.driver.databases.keys()].filter(f => path.dirname(f) === elsewhere)
    expect(first).toHaveLength(1)
    // A backup two days older, of the same ledger, is trimmed after the next automatic one
    const old = path.join(elsewhere, 'Home old.tesserabkp')
    env.driver.databases.set(old, structuredClone(env.driver.databases.get(first[0])!))
    env.driver.databases.get(old)!.meta.set(LEDGER_BACKUP_META.takenAt, new Date(START.getTime() - 2 * 86_400_000).toISOString() as never)
    await env.session.open(file('Home.tessera'))
    await env.session.createSubLedger({ name: 'Savings', parentId: null })
    await env.run(LEDGER_COMMANDS.close)
    expect(env.trashed).toEqual([old])
  })

  it('backs up changes a manual backup failed to save', async () => {
    const env = await homeBackedUp()
    await env.session.createSubLedger({ name: 'Savings', parentId: null })
    env.disk.hooks.mkdir = () => { throw errno('ENOENT') }
    expect(await env.run(LEDGER_COMMANDS.backup)).toBeUndefined()
    env.disk.hooks.mkdir = undefined
    await env.run(LEDGER_COMMANDS.close)
    expect(backups(env).find(b => b.kind === 'auto')?.subLedgers).toEqual(['Personal', 'Savings'])
  })

  it('counts a manual backup: closing unchanged after it makes none', async () => {
    const env = await plugin()
    await env.newLedger('Home.tessera')
    await env.session.createSubLedger({ name: 'Savings', parentId: null })
    env.files.showSaveDialog.mockImplementation(async o => o?.defaultPath)
    await env.run(LEDGER_COMMANDS.backup)
    await env.run(LEDGER_COMMANDS.close)
    expect(backups(env).map(b => b.kind)).toEqual(['manual'])
  })
})

describe('when the backup on close fails', () => {
  async function unplugged() {
    const env = await homeBackedUp()
    await env.session.createSubLedger({ name: 'Savings', parentId: null })
    env.disk.hooks.mkdir = () => { throw errno('ENOENT') }
    return env
  }

  it('closes the ledger anyway, and says so in the status bar until a backup of it succeeds', async () => {
    const env = await unplugged()

    await env.run(LEDGER_COMMANDS.close)

    expect(env.session.current).toBeUndefined()
    expect(backups(env).map(b => b.kind)).toEqual(['manual'])
    expect(partials(env)).toEqual([])
    const problem = env.key(K.backupProblem) as string
    expect(problem).toMatch(new RegExp(`^“Home” wasn’t backed up when it closed \\(.+\\)\\. The folder “${FOLDER.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}” isn’t available\\.$`))
    expect(env.state.values.get('ledger.backup.lastAutoError')).toMatchObject({ ledger: expect.any(String), ledgerName: 'Home', message: `The folder “${FOLDER}” isn’t available.` })
    expect(env.prompts.message).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'error' }))

    // The changes weren't backed up, so the next close tries again, and its success clears the problem
    env.disk.hooks.mkdir = undefined
    await env.session.open(file('Home.tessera'))
    await env.run(LEDGER_COMMANDS.close)
    expect(backups(env).map(b => b.kind).sort()).toEqual(['auto', 'manual'])
    expect(backups(env).find(b => b.kind === 'auto')?.subLedgers).toEqual(['Personal', 'Savings'])
    expect(env.key(K.backupProblem)).toBeUndefined()
    expect(env.state.values.has('ledger.backup.lastAutoError')).toBe(false)
  })

  it('shows the problem at the next start, and clicking it opens the Backups page', async () => {
    const state = memoryAppState()
    const first = await homeBackedUp({ state })
    await first.session.createSubLedger({ name: 'Savings', parentId: null })
    first.disk.hooks.mkdir = () => { throw errno('ENOENT') }
    await first.run(LEDGER_COMMANDS.close)
    const at = (state.values.get('ledger.backup.lastAutoError') as { at: string }).at

    const next = await plugin({ state })
    expect(next.key(K.backupProblem)).toBe(`“Home” wasn’t backed up when it closed (${dateTime(new Date(at))}). The folder “${FOLDER}” isn’t available.`)
    const opened: unknown[] = []
    next.runtime.commands.register(SETTINGS_OPEN_COMMAND, (page?: unknown) => { opened.push(page) })
    await next.run(LEDGER_COMMANDS.backupSettings)
    expect(opened).toEqual(['ledger.backup.settings'])
  })

  it('keeps another ledger\'s problem when this one backs up', async () => {
    const env = await unplugged()
    await env.run(LEDGER_COMMANDS.close)
    env.disk.hooks.mkdir = undefined
    await env.session.create(file('Work.tessera'))
    await env.run(LEDGER_COMMANDS.close)
    expect(backups(env).filter(b => b.kind === 'auto').map(b => b.name.split(' ')[0])).toEqual(['Work'])
    expect(env.key(K.backupProblem)).toMatch(/^“Home” wasn’t backed up/)
  })
})

describe('backing up on a user quit (pass 1)', () => {
  it('backs up in pass 1, with its progress in the status bar; pass 2 then closes without backing up again', async () => {
    const env = await homeBackedUp()
    await env.session.createSubLedger({ name: 'Savings', parentId: null })

    expect(await env.runtime.lifecycle.askToQuit()).toEqual([])
    const made = backups(env).filter(b => b.kind === 'auto')
    expect(made.map(b => b.subLedgers)).toEqual([['Personal', 'Savings']])
    expect(env.key(K.isBusy)).toBe(false)
    expect(env.activity.at(-1)).toMatch(/^Backed up “Home” at /)

    expect(await env.runtime.lifecycle.requestShutdown('user')).toBe(true)
    expect(env.session.current).toBeUndefined()
    expect(backups(env).filter(b => b.kind === 'auto')).toHaveLength(1)
  })

  it('makes no backup when nothing changed, and gives no reason', async () => {
    const env = await homeBackedUp()
    expect(await env.runtime.lifecycle.askToQuit()).toEqual([])
    expect(backups(env).map(b => b.kind)).toEqual(['manual'])
  })

  it('gives a failure as its reason, so the user can Retry once the drive is back', async () => {
    const env = await homeBackedUp()
    await env.session.createSubLedger({ name: 'Savings', parentId: null })
    env.disk.hooks.mkdir = () => { throw errno('ENOENT') }

    expect(await env.runtime.lifecycle.askToQuit()).toEqual([`“Home” couldn’t be backed up. The folder “${FOLDER}” isn’t available.`])
    expect(env.session.current?.name).toBe('Home')
    expect(env.key(K.isBusy)).toBe(false)
    expect(env.key(K.backupProblem)).toMatch(/^“Home” wasn’t backed up/)

    env.disk.hooks.mkdir = undefined
    expect(await env.runtime.lifecycle.askToQuit()).toEqual([])
    expect(backups(env).filter(b => b.kind === 'auto')).toHaveLength(1)
    expect(env.key(K.backupProblem)).toBeUndefined()
  })

  it('after Quit Anyway, closes without trying again in pass 2', async () => {
    const env = await homeBackedUp()
    await env.session.createSubLedger({ name: 'Savings', parentId: null })
    env.disk.hooks.mkdir = () => { throw errno('ENOENT') }
    expect(await env.runtime.lifecycle.askToQuit()).toHaveLength(1)

    env.disk.hooks.mkdir = undefined              // even if the drive came back meanwhile: the user chose to go
    expect(await env.runtime.lifecycle.requestShutdown('user')).toBe(true)
    expect(env.session.current).toBeUndefined()
    expect(backups(env).map(b => b.kind)).toEqual(['manual'])
    expect(env.state.values.get('ledger.backup.lastAutoError')).toMatchObject({ ledgerName: 'Home' })
  })

  it('gives a running operation as its reason, and backs nothing up meanwhile', async () => {
    const env = await homeBackedUp()
    await env.session.createSubLedger({ name: 'Savings', parentId: null })
    const importing = env.session.beginOperation('Importing statements')
    expect(await env.runtime.lifecycle.askToQuit()).toEqual(['“Importing statements” is still running.'])
    expect(backups(env).map(b => b.kind)).toEqual(['manual'])
    importing.dispose()
    expect(await env.runtime.lifecycle.askToQuit()).toEqual([])
  })

  it('gives a running operation as its reason even with nothing to back up, or no ledger open', async () => {
    const env = await homeBackedUp()
    const importing = env.session.beginOperation('Importing statements')
    expect(await env.runtime.lifecycle.askToQuit()).toEqual(['“Importing statements” is still running.'])
    importing.dispose()
    await env.run(LEDGER_COMMANDS.close)
    const restoring = env.session.beginOperation('Restoring a ledger')
    expect(await env.runtime.lifecycle.askToQuit()).toEqual(['“Restoring a ledger” is still running.'])
    restoring.dispose()
  })

  it('gives no reason with no ledger open, or with the setting off', async () => {
    const none = await plugin()
    expect(await none.runtime.lifecycle.askToQuit()).toEqual([])
    const off = await plugin({ settings: { 'ledger.backup': { onClose: false } } })
    await off.newLedger('Home.tessera')
    expect(await off.runtime.lifecycle.askToQuit()).toEqual([])
    expect(backups(off)).toEqual([])
  })
})

describe('backing up on an OS shutdown', () => {
  it('backs up as the ledger closes, then trims, remembering the ledger for the next start', async () => {
    const env = await homeBackedUp({ settings: { 'ledger.backup': { keepAtLeast: 1 } } })
    await env.session.createSubLedger({ name: 'Savings', parentId: null })
    // The manual backup, made 40 days ago: expired once a newer one is there
    const manual = [...env.driver.databases.keys()].find(f => path.dirname(f) === FOLDER)!
    env.driver.databases.get(manual)!.meta.set(LEDGER_BACKUP_META.takenAt, new Date(START.getTime() - 40 * 86_400_000).toISOString() as never)

    expect(await env.runtime.lifecycle.requestShutdown('system')).toBe(true)

    expect(env.session.current).toBeUndefined()
    expect(backups(env).map(b => [b.kind, b.subLedgers])).toEqual([['auto', ['Personal', 'Savings']]])
    expect(env.trashed).toEqual([manual])
    expect(env.state.values.get('ledger.recent')).toBeDefined()
  })

  it('abandons a backup still running at its budget, leaving nothing, and records why', async () => {
    const env = await plugin()
    // A snapshot that only ends when it is abandoned: a very large ledger on a slow disk
    const open = env.driver.open.bind(env.driver)
    let snapshotting!: () => void
    const started = new Promise<void>(resolve => { snapshotting = resolve })
    env.driver.open = async (target, options) => Object.assign(await open(target, options), {
      snapshot: async (_file: string, options: { signal?: AbortSignal }) => {
        snapshotting()
        await new Promise((_resolve, reject) => options.signal?.addEventListener('abort', () => reject(new Error('abandoned'))))
      }
    })
    await env.newLedger('Home.tessera')          // never backed up: closing needs a backup

    const shutdown = env.runtime.lifecycle.requestShutdown('system')
    await started
    env.clock.advance(SHUTDOWN_BUDGET_MS - 1)
    await turns()
    expect(env.session.current?.name).toBe('Home')     // still waiting for the snapshot
    env.clock.advance(1)

    expect(await shutdown).toBe(true)
    expect(env.session.current).toBeUndefined()
    expect(backups(env)).toEqual([])
    expect(partials(env)).toEqual([])
    expect(env.state.values.get('ledger.backup.lastAutoError')).toMatchObject({
      ledgerName: 'Home', message: 'There wasn’t time to finish the backup before the computer shut down.'
    })
  })

  it('waits a moment for a running operation to end (an import unwinding), then backs up', async () => {
    const env = await homeBackedUp()
    await env.session.createSubLedger({ name: 'Savings', parentId: null })
    const importing = env.session.beginOperation('Importing statements')

    const shutdown = env.runtime.lifecycle.requestShutdown('system')
    await turns()
    env.clock.advance(OPERATION_WAIT_MS - 1)
    expect(env.session.current?.name).toBe('Home')
    importing.dispose()

    expect(await shutdown).toBe(true)
    expect(backups(env).filter(b => b.kind === 'auto').map(b => b.subLedgers)).toEqual([['Personal', 'Savings']])
  })

  it('skips the backup, saying why, when a running operation doesn\'t end in time, rather than copy half an import', async () => {
    const env = await homeBackedUp()
    await env.session.createSubLedger({ name: 'Savings', parentId: null })
    env.session.beginOperation('Importing statements')

    const shutdown = env.runtime.lifecycle.requestShutdown('system')
    await turns()
    env.clock.advance(OPERATION_WAIT_MS)

    expect(await shutdown).toBe(true)
    expect(env.session.current).toBeUndefined()
    expect(backups(env).map(b => b.kind)).toEqual(['manual'])
    expect(env.state.values.get('ledger.backup.lastAutoError')).toMatchObject({ ledgerName: 'Home', message: '“Importing statements” was still running.' })
  })

  it('makes no backup when nothing changed', async () => {
    const env = await homeBackedUp()
    expect(await env.runtime.lifecycle.requestShutdown('system')).toBe(true)
    expect(backups(env).map(b => b.kind)).toEqual(['manual'])
  })
})
