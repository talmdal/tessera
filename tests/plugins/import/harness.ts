// The import plugin as the app runs it: the ledger, accounts, import and the OFX format plugin activated together on
// a memory engine, with a ledger open. Dialogs are answered by id: `answer(id, …)` queues answers, and every dialog
// shown is recorded.
import path from 'node:path'
import { KitStorageEngine, memoryDriver } from '@tessera/storage-kit'
import { SHELL_FILES_SERVICE, SHELL_PROMPTS_SERVICE } from '@tessera/types'
import { LEDGER_COMMANDS } from '@tessera/ledger-api'
import {
  ACCOUNTS_DIALOGS, ACCOUNTS_SERVICE, type AccountDialogInput as NewAccountInput, type AccountInput, type AccountsService
} from '@tessera/accounts-api'
import { IMPORT_DIALOGS, IMPORT_MANAGER_SERVICE, type ImportManager } from '@tessera/import-api'
import { createPluginContext, createPluginRuntime } from '../../../core/plugins/PluginContext'
import { activate as activateAccounts } from '../../../plugins/accounts/src/privileged/index'
import { activate as activateImport, type ActivateOptions } from '../../../plugins/import/src/privileged/index'
import { activate as activateOfx } from '../../../plugins/import-ofx/src/privileged/index'
import { activate as activateLedger } from '../../../plugins/ledger/src/privileged/index'
import { SAMPLES } from '../../helpers/importFile'
import { fakeFiles, fakePrompts, file, logger, memoryAppState, memoryDisk } from '../ledger/harness'

export const sample = (name: string) => path.join(SAMPLES, name)

type Answer = unknown | ((input: any, options?: any) => unknown)

export async function setupImport(options: ActivateOptions & { ofx?: boolean } = {}) {
  const log = logger()
  const runtime = createPluginRuntime(undefined, log)
  const driver = memoryDriver()
  const disk = memoryDisk(driver)
  const { files } = fakeFiles(driver, disk)
  const { prompts } = fakePrompts()
  const appState = memoryAppState()
  runtime.services.provide('storage-memory', 'storage.engine', new KitStorageEngine(driver))
  runtime.services.provide('app-state', 'app.state', appState)
  runtime.services.provide('shell', SHELL_FILES_SERVICE, files)
  runtime.services.provide('shell', SHELL_PROMPTS_SERVICE, prompts)
  const shell = createPluginContext('shell', runtime).context
  const registers: string[] = []
  shell.commands.register('shell.layout.reveal', () => {})

  await activateLedger(createPluginContext('ledger', runtime).context, { disk: disk.disk })
  await activateAccounts(createPluginContext('accounts', runtime).context)
  const importLog = logger()
  await activateImport({ ...createPluginContext('import', runtime).context, logger: importLog }, { now: () => new Date('2026-11-06T12:00:00Z'), ...options })
  if (options.ofx !== false) await activateOfx(createPluginContext('import-ofx', runtime).context)

  files.showSaveDialog.mockResolvedValueOnce(file('Home.tessera'))
  await runtime.commands.execute(LEDGER_COMMANDS.new)
  const accounts = runtime.services.get<AccountsService>(ACCOUNTS_SERVICE)
  const manager = runtime.services.get<ImportManager>(IMPORT_MANAGER_SERVICE)

  // Dialogs: answers queued per id, then the defaults: the summary closes, the New Account form creates what it shows
  const queued = new Map<string, Answer[]>()
  const shown: { id: string, input: any, options?: any }[] = []
  const defaults: Record<string, Answer> = {
    [IMPORT_DIALOGS.summary]: {},
    [ACCOUNTS_DIALOGS.account]: async (input: NewAccountInput) => {
      if (input.mode !== 'create') return undefined
      const created = await accounts.createAccount({ subLedgerId: input.subLedgerId, ...input.initial } as AccountInput)
      return { id: created.id }
    }
  }
  prompts.show.mockImplementation(async (...args: unknown[]) => {
    const [id, input, opts] = args as [string, unknown, unknown]
    shown.push({ id, input, options: opts })
    const answer = queued.get(id)?.shift() ?? defaults[id]
    return typeof answer === 'function' ? (answer as (i: unknown, o: unknown) => unknown)(input, opts) : answer
  })
  const answer = (id: string, ...answers: Answer[]) => queued.set(id, [...(queued.get(id) ?? []), ...answers])
  const dialogs = (id: string) => shown.filter(s => s.id === id)

  /** Every transaction in an account, in register order. */
  const transactions = (accountId: string) => accounts.transactions(accountId).list()
  const account = async (name: string) => (await accounts.list()).find(a => a.name === name)!

  return { runtime, log, importLog, files, prompts, appState, accounts, manager, answer, dialogs, shown, transactions, account, registers }
}

export type ImportEnv = Awaited<ReturnType<typeof setupImport>>
