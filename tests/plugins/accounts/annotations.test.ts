// @vitest-environment node
// The accounts.register.annotations extension point, with the ledger and accounts activated as the app runs them and
// fixture plugins contributing annotators: their marks reach the register, merged, and a broken one can't break it.
import { describe, expect, it } from 'vitest'
import { KitStorageEngine, memoryDriver } from '@tessera/storage-kit'
import { SHELL_FILES_SERVICE, SHELL_PROMPTS_SERVICE } from '@tessera/types'
import { LEDGER_COMMANDS } from '@tessera/ledger-api'
import {
  ACCOUNTS_CHANNELS, ACCOUNTS_EVENTS, ACCOUNTS_SERVICE, REGISTER_ANNOTATIONS_POINT,
  type AccountAnnotations, type AccountsService, type AnnotationAction, type RegisterView
} from '@tessera/accounts-api'
import { createPluginContext, createPluginRuntime } from '../../../core/plugins/PluginContext'
import { activate as activateAccounts } from '../../../plugins/accounts/src/privileged/index'
import { activate as activateLedger } from '../../../plugins/ledger/src/privileged/index'
import { fakeFiles, fakePrompts, file, logger, memoryAppState, memoryDisk } from '../ledger/harness'
import { chequing } from './harness'

const TIMEOUT = 50

async function setup() {
  const log = logger()
  const runtime = createPluginRuntime(undefined, log)
  const driver = memoryDriver()
  const disk = memoryDisk(driver)
  const { files } = fakeFiles(driver, disk)
  runtime.services.provide('storage-memory', 'storage.engine', new KitStorageEngine(driver))
  runtime.services.provide('app-state', 'app.state', memoryAppState())
  runtime.services.provide('shell', SHELL_FILES_SERVICE, files)
  runtime.services.provide('shell', SHELL_PROMPTS_SERVICE, fakePrompts().prompts)
  const events: { name: string, data?: any }[] = []
  runtime.events.subscribe(event => events.push(event))
  await activateLedger(createPluginContext('ledger', runtime).context, { disk: disk.disk })
  const accountsLog = logger()
  await activateAccounts({ ...createPluginContext('accounts', runtime).context, logger: accountsLog }, { annotationTimeoutMs: TIMEOUT })

  files.showSaveDialog.mockResolvedValueOnce(file('Home.tessera'))
  await runtime.commands.execute(LEDGER_COMMANDS.new)
  const accounts = runtime.services.get<AccountsService>(ACCOUNTS_SERVICE)
  const chq = await accounts.createAccount(chequing())
  const sav = await accounts.createAccount(chequing({ name: 'Savings', type: 'savings', openingBalance: 0 }))
  const t = accounts.transactions(chq.id)
  const costco = await t.create({ date: '2026-10-05', amount: -8400, payee: 'Costco' })
  const hydro = await t.create({ date: '2026-10-07', amount: -8000, payee: 'Hydro One' })

  const load = async (accountId = chq.id) => {
    const reply = await runtime.ipc.dispatch({ channel: ACCOUNTS_CHANNELS.loadRegister, data: { accountId } })
    if (!reply.ok) throw new Error(reply.error.message)
    return reply.data as RegisterView
  }
  const named = (name: string) => events.filter(e => e.name === name).map(e => e.data)
  return { runtime, accountsLog, accounts, chq, sav, costco, hydro, load, named }
}

type Env = Awaited<ReturnType<typeof setup>>

/** A plugin that annotates with `annotate`, contributed as `<id>.review`; `fire` says its marks changed. */
function annotator(env: Env, id: string, annotate: (accountId: string) => Promise<AccountAnnotations> | AccountAnnotations, order?: number) {
  const context = createPluginContext(id, env.runtime).context
  const listeners = new Set<(change: { accounts: string[] }) => void>()
  const service = `${id}.annotator`
  context.services.provide(id, service, {
    annotate: async (accountId: string) => annotate(accountId),
    onDidChange: (listener: (change: { accounts: string[] }) => void) => { listeners.add(listener); return { dispose: () => listeners.delete(listener) } }
  })
  context.extensions.contribute(id, REGISTER_ANNOTATIONS_POINT, `${id}.review`, { id: `${id}.review`, service, ...(order !== undefined && { order }) })
  return { fire: (accounts: string[]) => listeners.forEach(l => l({ accounts })), listeners }
}

const action = (id: string, placement: 'button' | 'menu' = 'button'): AnnotationAction =>
  ({ id, label: id, command: `cmd.${id}`, args: { lineId: id }, placement })

describe('register annotations', () => {
  it("reach the register with its rows, in register order, for this account's transactions only", async () => {
    const env = await setup()
    annotator(env, 'bank', () => ({
      rows: [
        { transactionId: env.hydro.id, review: true, tone: 'info', detail: { icon: 'NewReleases', parts: [{ text: 'New from the bank: ' }, { text: 'HYDRO ONE', emphasis: true }] }, actions: [action('accept'), action('change')] },
        { transactionId: env.costco.id, review: true, tone: 'warning', detail: { parts: [{ text: 'Possible match' }] }, actions: [action('accept'), action('change'), action('third'), action('later', 'menu')] },
        { transactionId: 'not-in-this-register', review: true, tone: 'info', detail: { parts: [] }, actions: [] }
      ],
      summary: { message: '2 imported transactions to review', actions: [action('acceptAll')] }
    }))

    const { annotations, rows } = await env.load()

    expect(rows).toHaveLength(2)                                  // the snapshot itself is unchanged
    expect(annotations.rows.map(r => r.transactionId)).toEqual([env.costco.id, env.hydro.id])
    const [costco, hydro] = annotations.rows
    expect(costco).toMatchObject({ review: true, tone: 'warning' })
    expect(costco.buttons.map(b => b.id)).toEqual(['accept', 'change'])          // at most two buttons…
    expect(costco.menu.map(b => b.id)).toEqual(['third', 'later'])               // …the rest in the row's menu
    expect(hydro.detail).toEqual({ icon: 'NewReleases', parts: [{ text: 'New from the bank: ' }, { text: 'HYDRO ONE', emphasis: true }] })
    expect(annotations.summaries).toEqual([{ contributor: 'bank.review', message: '2 imported transactions to review', actions: [action('acceptAll')] }])
  })

  it('are none, with no summary, for an account nobody marks or a register with nothing to review', async () => {
    const env = await setup()
    annotator(env, 'bank', accountId => accountId === env.chq.id
      ? { rows: [{ transactionId: env.costco.id, review: false, tone: 'success', detail: { parts: [] }, actions: [action('undo', 'menu')] }], summary: { message: 'Nothing to review', actions: [] } }
      : { rows: [] })
    expect((await env.load(env.sav.id)).annotations).toEqual({ rows: [], summaries: [] })
    const { annotations } = await env.load()
    expect(annotations.rows).toEqual([expect.objectContaining({ review: false, buttons: [], menu: [action('undo', 'menu')] })])
    expect(annotations.summaries).toEqual([])                   // shown only while something needs the user
  })

  it('show a summary with no row to review while the annotator says something else is outstanding', async () => {
    const env = await setup()
    const resolve = action('resolve')
    annotator(env, 'bank', () => ({
      rows: [{ transactionId: env.costco.id, review: false, tone: 'info', detail: { parts: [] }, actions: [] }],
      summary: { message: '1 bank line lost its match', actions: [resolve], outstanding: 1 }
    }))
    expect((await env.load()).annotations.summaries).toEqual([{ contributor: 'bank.review', message: '1 bank line lost its match', actions: [resolve] }])
  })

  it('ignore an outstanding count that isn’t a positive number', async () => {
    const env = await setup()
    annotator(env, 'bank', () => ({ rows: [], summary: { message: 'Nothing', actions: [], outstanding: 'lots' as never } }))
    expect((await env.load()).annotations.summaries).toEqual([])
  })

  it('keep only what the register can draw and run from what an annotator returns', async () => {
    const env = await setup()
    annotator(env, 'sloppy', () => ({
      rows: [
        { transactionId: env.costco.id, review: 'yes', tone: 'purple', detail: { parts: [{ text: 'ok' }, { oops: 1 }, 'text'] },
          actions: [action('good'), { id: 'no-command', label: 'x', placement: 'button' }, { ...action('bad-placement'), placement: 'floating' }] },
        { transactionId: env.costco.id, review: true, tone: 'info', detail: { parts: [] }, actions: [] },   // a second row for it: ignored
        'not a row', null
      ],
      summary: { message: '', actions: [] }
    }) as unknown as AccountAnnotations)

    const { annotations } = await env.load()
    expect(annotations.rows).toEqual([{
      transactionId: env.costco.id, review: false, tone: 'info', detail: { parts: [{ text: 'ok' }] }, buttons: [action('good')], menu: []
    }])
  })

  it('from two annotators on one row: the first by order draws it, the second adds to its menu', async () => {
    const env = await setup()
    annotator(env, 'second', () => ({
      rows: [{ transactionId: env.costco.id, review: true, tone: 'warning', detail: { parts: [{ text: 'Duplicate?' }] }, actions: [action('dismiss'), action('merge', 'menu')] }],
      summary: { message: '1 possible duplicate', actions: [] }
    }), 10)
    annotator(env, 'first', () => ({
      rows: [{ transactionId: env.costco.id, review: false, tone: 'info', detail: { parts: [{ text: 'Matched' }] }, actions: [action('accept')] }],
      summary: { message: 'Matched', actions: [] }
    }), 1)

    const { annotations } = await env.load()
    expect(annotations.rows).toEqual([{
      transactionId: env.costco.id, review: true, tone: 'info', detail: { parts: [{ text: 'Matched' }] },
      buttons: [action('accept')], menu: [action('dismiss'), action('merge', 'menu')]
    }])
    // Only the annotator with something to review shows a summary
    expect(annotations.summaries.map(s => s.contributor)).toEqual(['second.review'])
  })

  it("leave out an annotator that fails, is slow or isn't there, so the register still loads, and warn once", async () => {
    const env = await setup()
    annotator(env, 'broken', () => { throw new Error('boom') })
    annotator(env, 'slow', () => new Promise<AccountAnnotations>(() => {}))
    annotator(env, 'good', () => ({ rows: [{ transactionId: env.costco.id, review: true, tone: 'info', detail: { parts: [] }, actions: [] }] }))
    const ghost = createPluginContext('ghost', env.runtime).context
    ghost.extensions.contribute('ghost', REGISTER_ANNOTATIONS_POINT, 'ghost.review', { id: 'ghost.review', service: 'ghost.annotator' })
    const fake = createPluginContext('fake', env.runtime).context
    fake.services.provide('fake', 'fake.annotator', { notAnAnnotator: true })
    fake.extensions.contribute('fake', REGISTER_ANNOTATIONS_POINT, 'fake.review', { id: 'fake.review', service: 'fake.annotator' })

    for (let i = 0; i < 2; i++) {
      const view = await env.load()
      expect(view.rows).toHaveLength(2)
      expect(view.annotations.rows.map(r => r.transactionId)).toEqual([env.costco.id])
    }
    const warnings = env.accountsLog.warn.mock.calls.map(([m]) => String(m))
    expect(warnings).toEqual([
      `[accounts] Register annotations "fake.review": service "fake.annotator" isn't a register annotator`,
      '[accounts] Register annotations "broken.review" failed: boom',
      `[accounts] Register annotations "slow.review" failed: Register annotations "slow.review" didn't answer within ${TIMEOUT} ms`
    ])
  })

  it('skip invalid contributions with one warning each', async () => {
    const env = await setup()
    const other = createPluginContext('other', env.runtime).context
    other.extensions.contribute('other', REGISTER_ANNOTATIONS_POINT, 'a', { id: 'someone-else.review', service: 'x.annotator' })
    other.extensions.contribute('other', REGISTER_ANNOTATIONS_POINT, 'b', { id: 'other.noService' })
    other.extensions.contribute('other', REGISTER_ANNOTATIONS_POINT, 'c', { id: 'other.badOrder', service: 'x.annotator', order: 'first' })
    annotator(env, 'dup', () => ({ rows: [] }))
    other.extensions.contribute('dup', REGISTER_ANNOTATIONS_POINT, 'dup.review.again', { id: 'dup.review', service: 'dup.annotator' })

    await env.load()
    await env.load()
    expect(env.accountsLog.warn.mock.calls.map(([m]) => String(m))).toEqual([
      '[accounts] A register annotations contribution from "other" needs an id starting with "other."',
      '[accounts] Register annotations "other.noService" needs a service',
      '[accounts] Register annotations "other.badOrder" has an invalid order',
      '[accounts] Duplicate register annotations "dup.review" ignored'
    ])
  })

  it("follow an annotator from start-up, even when its plugin contributed before providing the service", async () => {
    const env = await setup()
    const context = createPluginContext('early', env.runtime).context
    const listeners = new Set<(change: { accounts: string[] }) => void>()
    // The contribution comes first, when there is no service to follow yet; nothing announces the service arriving
    context.extensions.contribute('early', REGISTER_ANNOTATIONS_POINT, 'early.review', { id: 'early.review', service: 'early.annotator' })
    context.services.provide('early', 'early.annotator', {
      annotate: async () => ({ rows: [] }),
      onDidChange: (l: (change: { accounts: string[] }) => void) => { listeners.add(l); return { dispose: () => listeners.delete(l) } }
    })
    expect(listeners.size).toBe(0)

    await env.runtime.lifecycle.markStarted()                   // every plugin has activated: followed now
    expect(listeners.size).toBe(1)
    listeners.forEach(l => l({ accounts: [env.chq.id] }))
    expect(env.named(ACCOUNTS_EVENTS.annotations)).toEqual([{ accounts: [env.chq.id] }])
  })

  it('tell the registers concerned to reload when an annotator says its marks changed', async () => {
    const env = await setup()
    const bank = annotator(env, 'bank', () => ({ rows: [] }))
    expect(bank.listeners.size).toBe(1)                          // followed as soon as it is contributed

    bank.fire([env.chq.id])
    bank.fire([])                                                // nothing to reload: nothing sent
    expect(env.named(ACCOUNTS_EVENTS.annotations)).toEqual([{ accounts: [env.chq.id] }])

    // An annotator contributed later is followed as soon as the extension point changes
    const late = annotator(env, 'late', () => ({ rows: [] }))
    late.fire([env.sav.id])
    expect(env.named(ACCOUNTS_EVENTS.annotations)).toEqual([{ accounts: [env.chq.id] }, { accounts: [env.sav.id] }])
    await env.load()
    expect(bank.listeners.size).toBe(1)                          // loading doesn't subscribe twice
  })

  it('stop following an annotator whose plugin goes away', async () => {
    const env = await setup()
    const context = createPluginContext('gone', env.runtime).context
    const listeners = new Set<() => void>()
    const provided = context.services.provide('gone', 'gone.annotator', {
      annotate: async () => ({ rows: [] }),
      onDidChange: (l: () => void) => { listeners.add(l); return { dispose: () => listeners.delete(l) } }
    })
    context.extensions.contribute('gone', REGISTER_ANNOTATIONS_POINT, 'gone.review', { id: 'gone.review', service: 'gone.annotator' })
    await env.load()
    expect(listeners.size).toBe(1)
    provided.dispose()
    await env.load()
    expect(listeners.size).toBe(0)
  })
})
