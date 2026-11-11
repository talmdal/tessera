// @vitest-environment node
// One long operation at a time on the ledger (an import, a backup, a restore), and the ledger's identity.
// See docs/backup-restore-design.md, "One thing at a time" and "Ledger identity".
import { describe, expect, it } from 'vitest'
import { LEDGER_CHANNELS, LEDGER_COMMANDS, LEDGER_CONTEXT_KEYS as K, LEDGER_META } from '@tessera/ledger-api'
import { file } from './harness'
import { activateLedger } from './plugin'

describe('one long operation at a time', () => {
  it('refuses a second operation, naming the one running, until the first ends', async () => {
    const env = await activateLedger()
    const importing = env.session.beginOperation('Importing statements')
    expect(env.session.operation).toBe('Importing statements')
    expect(() => env.session.beginOperation('Backing up “Home”')).toThrow(expect.objectContaining({
      code: 'BUSY', message: 'Wait for “Importing statements” to finish.'
    }))
    importing.dispose()
    importing.dispose()                       // a second dispose does nothing, and ends nobody else's operation
    const backingUp = env.session.beginOperation('Backing up “Home”')
    importing.dispose()
    expect(env.session.operation).toBe('Backing up “Home”')
    backingUp.dispose()
    expect(env.session.operation).toBeUndefined()
  })

  it('needs a label to show the user', async () => {
    const env = await activateLedger()
    expect(() => env.session.beginOperation('  ')).toThrow(expect.objectContaining({ code: 'INVALID' }))
  })

  it('disables the file commands while one runs, and their methods refuse, also from the start view', async () => {
    const env = await activateLedger()
    await env.newLedger('Home.tessera')
    await env.session.create(file('Other.tessera'))     // with a ledger open, New Ledger… asks about a sub-ledger first
    const operation = env.session.beginOperation('Importing statements')

    expect([env.key(K.isBusy), env.key(K.operation)]).toEqual([true, 'Importing statements'])
    for (const id of [LEDGER_COMMANDS.new, LEDGER_COMMANDS.open, LEDGER_COMMANDS.close, LEDGER_COMMANDS.delete]) expect(env.enabled(id), id).toBe(false)
    const busy = { code: 'BUSY', message: 'Wait for “Importing statements” to finish.' }
    await expect(env.session.create(file('New.tessera'))).rejects.toMatchObject(busy)
    await expect(env.session.open(file('Home.tessera'))).rejects.toMatchObject(busy)
    await expect(env.session.close()).rejects.toMatchObject(busy)
    await expect(env.session.delete(file('Home.tessera'))).rejects.toMatchObject(busy)
    expect(await env.ask(LEDGER_CHANNELS.open, { path: file('Home.tessera') })).toEqual({ ok: false, error: busy })
    expect(env.session.current?.name).toBe('Other')

    operation.dispose()
    expect([env.key(K.isBusy), env.key(K.operation)]).toEqual([false, undefined])
    expect(env.enabled(LEDGER_COMMANDS.close)).toBe(true)
    await env.session.open(file('Home.tessera'))
    expect(env.session.current?.name).toBe('Home')
  })

  it('lets the ledger be read and edited meanwhile', async () => {
    const env = await activateLedger()
    await env.newLedger()
    env.session.beginOperation('Importing statements')
    const personal = await env.session.createSubLedger({ name: 'Personal', parentId: null })
    await env.session.renameSubLedger(personal.id, 'Mine')
    expect((await env.session.tree()).subLedgers.map(s => s.name)).toEqual(['Mine'])
  })

  it('never stops the ledger closing when Tessera quits', async () => {
    const env = await activateLedger()
    await env.newLedger()
    env.session.beginOperation('Importing statements')
    await env.runtime.lifecycle.requestShutdown('user')
    expect(env.session.current).toBeUndefined()
  })
})

describe('a ledger\'s identity', () => {
  it('is given when the ledger is created, kept when it reopens, and recorded in the recent list', async () => {
    const env = await activateLedger()
    const created = await env.newLedger('Home.tessera')
    expect(created.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(await env.engine.readMeta({ path: file('Home.tessera') })).toMatchObject({ [LEDGER_META.id]: created.id })
    await env.session.close()
    expect((await env.session.open(file('Home.tessera')))?.id).toBe(created.id)
    expect((await env.ask(LEDGER_CHANNELS.recent))[0]).toMatchObject({ path: file('Home.tessera'), id: created.id })
  })

  it('is given to a ledger made before ids existed, the first time it opens', async () => {
    const env = await activateLedger()
    env.driver.databases.set(file('Old.tessera'), { collections: new Map(), meta: new Map([[LEDGER_META.format, 1 as never]]) })
    const opened = await env.session.open(file('Old.tessera'))
    expect(opened?.id).toMatch(/^[0-9A-Z]{26}$/)
    expect(env.driver.databases.get(file('Old.tessera'))!.meta.get(LEDGER_META.id)).toBe(opened?.id)
  })

  it('is different for two ledgers', async () => {
    const env = await activateLedger()
    const home = await env.newLedger('Home.tessera')
    const other = (await env.session.create(file('Other.tessera')))!
    expect(other.name).toBe('Other')
    expect(home.id).not.toBe(other.id)
  })
})
