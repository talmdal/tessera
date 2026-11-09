// The ledger plugin activated as the app runs it, on a memory engine, with a clock, timers and retry timing the test
// controls: for the tests of what the plugin does through its commands (backups, the one-operation rule).
import { KitStorageEngine, memoryDriver } from '@tessera/storage-kit'
import { SHELL_FILES_SERVICE, SHELL_PROMPTS_SERVICE } from '@tessera/types'
import { LEDGER_COMMANDS, LEDGER_SESSION_SERVICE, type LedgerSession } from '@tessera/ledger-api'
import { createPluginContext, createPluginRuntime } from '../../../core/plugins/PluginContext'
import { activate } from '../../../plugins/ledger/src/privileged/index'
import type { Timers } from '../../../plugins/ledger/src/privileged/backup/activity'
import { memorySettingsPersistence } from '../../helpers/settings'
import { fakeFiles, fakePrompts, file, logger, memoryAppState, memoryDisk } from './harness'

/** Timers that only move when the test says so. */
export function manualTimers() {
  let now = 0
  const pending: { at: number, run: () => void, handle: object }[] = []
  const timers: Timers = {
    setTimeout: (run, ms) => { const handle = {}; pending.push({ at: now + ms, run, handle }); return handle },
    clearTimeout: handle => { const i = pending.findIndex(p => p.handle === handle); if (i >= 0) pending.splice(i, 1) },
    now: () => now
  }
  /** Moves the clock on, running what falls due, in order. */
  const advance = (ms: number) => {
    const until = now + ms
    for (;;) {
      pending.sort((a, b) => a.at - b.at)
      const next = pending[0]
      if (!next || next.at > until) break
      pending.shift()
      now = next.at
      next.run()
    }
    now = until
  }
  return { timers, advance, now: () => now }
}

export interface PluginOptions {
  /** Saved settings by namespace, as the app reads them before plugins activate: `{ 'ledger.backup': { … } }`. */
  settings?: Record<string, object>
  /** The wall clock the plugin sees (names, `takenAt`, retention). */
  now?: () => Date
  /** The app state, to carry what the plugin remembers into a second run (a restart). */
  state?: ReturnType<typeof memoryAppState>
}

export async function activateLedger(options: PluginOptions = {}) {
  const log = logger()
  const saved = memorySettingsPersistence(Object.fromEntries(Object.entries(options.settings ?? {}).map(([id, values]) => [id, { version: 1, values }])))
  const runtime = createPluginRuntime(undefined, log, { settingsPersistence: saved.persistence })
  await runtime.settings.load()
  const driver = memoryDriver()
  const engine = new KitStorageEngine(driver)
  const disk = memoryDisk(driver)
  const { files, trashed } = fakeFiles(driver, disk)
  const { prompts, answers } = fakePrompts()
  const state = options.state ?? memoryAppState()
  runtime.services.provide('storage-memory', 'storage.engine', engine)
  runtime.services.provide('app-state', 'app.state', state)
  runtime.services.provide('shell', SHELL_FILES_SERVICE, files)
  runtime.services.provide('shell', SHELL_PROMPTS_SERVICE, prompts)
  createPluginContext('shell', runtime).context.commands.register('shell.layout.reveal', () => {})

  // Retrying a held file waits on this clock, which each wait moves on: no real time passes
  let retryClock = 0
  const sleeps: number[] = []
  const retry = { now: () => retryClock, sleep: async (ms: number) => { sleeps.push(ms); retryClock += ms } }
  const clock = manualTimers()

  const events: { name: string, data?: any }[] = []
  runtime.events.subscribe(event => events.push(event))

  const context = createPluginContext('ledger', runtime).context
  await activate({ ...context, logger: log }, { disk: disk.disk, timers: clock.timers, retry, ...(options.now && { now: options.now }) })

  const run = <T = unknown>(id: string, ...args: unknown[]) => runtime.commands.execute(id, ...args) as Promise<T>
  const session = runtime.services.get<LedgerSession>(LEDGER_SESSION_SERVICE)
  const key = (k: string) => runtime.contextKeys.get(k)
  const enabled = (id: string) => runtime.commands.isEnabled(id)
  /** Opens a new ledger through File › New Ledger…, answering the save dialog. */
  const newLedger = async (name = 'Home.tessera') => {
    files.showSaveDialog.mockResolvedValueOnce(file(name))
    await run(LEDGER_COMMANDS.new)
    return session.current!
  }
  const ask = async (channel: string, data?: unknown) => {
    const reply = await runtime.ipc.dispatch({ channel, data })
    if (!reply.ok) throw new Error(reply.error.message)
    return reply.data as any
  }
  return { runtime, log, driver, engine, disk, files, trashed, prompts, answers, state, run, session, key, enabled, newLedger, ask, clock, sleeps, saved, events }
}

export type LedgerPlugin = Awaited<ReturnType<typeof activateLedger>>
