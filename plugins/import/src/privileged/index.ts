// The import plugin (the import manager): File › Import…, which turns bank statements into transactions. It knows
// no file format: format plugins contribute to `import.formats`. It finds each statement's account (and remembers it),
// leaves out lines imported before, proposes matches for those the user already entered, and adds the rest through
// accounts.service. The register shows what to review (accounts.register.annotations), with Accept and Change… on
// each row. See docs/import-manager-design.md.
import type { IpcMessage, PluginContext, ShellFiles, ShellPrompts } from '@tessera/types'
import { SHELL_FILES_SERVICE, SHELL_PROMPTS_SERVICE } from '@tessera/types'
import { LEDGER_CONTEXT_KEYS, LEDGER_SCHEMA_POINT, LEDGER_SESSION_SERVICE, type LedgerSession } from '@tessera/ledger-api'
import { ACCOUNTS_SERVICE, type AccountsService } from '@tessera/accounts-api'
import {
  IMPORT_ANNOTATOR_SERVICE, IMPORT_CHANNELS, IMPORT_COMMANDS, IMPORT_CONTEXT_KEYS, IMPORT_EVENTS, IMPORT_FORMATS_POINT,
  IMPORT_MANAGER_SERVICE, IMPORT_MIGRATOR_SERVICE, IMPORT_PLUGIN_ID,
  isImportError, type AcceptAllArgs, type AcceptArgs, type ChangeArgs, type MatchCandidatesRequest
} from '@tessera/import-api'
import { PayeeAliases } from './aliases'
import { ImportAnnotator } from './annotator'
import { contributions } from './contributions'
import type { FileReader } from './files'
import { Formats } from './formats'
import { Links } from './links'
import { Review, toReviewResult } from './review'
import { Importer } from './run'
import { IMPORT_SCHEMA, importMigrator } from './schema'
import { IMPORT_SETTINGS, settingsContribution, tuningOf } from './settings'
import { ImportFlow } from './service'

export interface ActivateOptions {
  /** Tests read files from memory, shorten the time a format may take, and fix the clock. */
  reader?: FileReader
  parseTimeoutMs?: number
  now?: () => Date
}

export async function activate(context: PluginContext, options: ActivateOptions = {}) {
  const session = context.services.get<LedgerSession>(LEDGER_SESSION_SERVICE)
  const accounts = context.services.get<AccountsService>(ACCOUNTS_SERVICE)
  const files = context.services.get<ShellFiles>(SHELL_FILES_SERVICE)
  const prompts = context.services.get<ShellPrompts>(SHELL_PROMPTS_SERVICE)
  const now = options.now ?? (() => new Date())

  // The matching tolerances the user chose, read each time they are used, so a change applies at once
  const settings = context.settings.register(IMPORT_SETTINGS)
  const tuning = () => tuningOf(settings.get())

  const db = () => session.database(IMPORT_PLUGIN_ID)
  const formats = new Formats(context.extensions, context.services, context.logger)
  const links = new Links(db, () => now().toISOString())
  const aliases = new PayeeAliases(db, () => now().toISOString())
  const annotator = new ImportAnnotator({ session, accounts, aliases, tuning })
  // Lines changed: the registers showing these accounts read their marks again, and views hear of it
  const changed = (changedAccounts: string[]) => {
    annotator.fire(changedAccounts)
    context.events.emit(IMPORT_EVENTS.batches.slice(`${IMPORT_PLUGIN_ID}:`.length), { accounts: changedAccounts })
  }
  const importer = new Importer({
    session, accounts, files, prompts, state: context.state, formats, links, aliases, changed, contextKeys: context.contextKeys, log: context.logger, tuning,
    now, ...(options.reader && { reader: options.reader }), ...(options.parseTimeoutMs !== undefined && { parseTimeoutMs: options.parseTimeoutMs })
  })
  const review = new Review({ session, accounts, prompts, aliases, changed, log: context.logger, tuning })
  const flow = new ImportFlow({ importer, formats, prompts, commands: context.commands, log: context.logger })
  const reviewing = `${LEDGER_CONTEXT_KEYS.isOpen} && !${LEDGER_CONTEXT_KEYS.isReadOnly}`

  const publishFormats = () => context.contextKeys.set(IMPORT_CONTEXT_KEYS.hasFormats, formats.all().length > 0)
  const quietly = (what: string) => (err: unknown) => context.logger.error(`[import] ${what}`, err)

  context.subscriptions.push(
    // Declared before any ledger opens (the ledger reopens the last one once every plugin has activated)
    context.extensions.contribute(IMPORT_PLUGIN_ID, LEDGER_SCHEMA_POINT, IMPORT_PLUGIN_ID, IMPORT_SCHEMA),
    context.services.provide(IMPORT_PLUGIN_ID, IMPORT_MIGRATOR_SERVICE, importMigrator),
    context.services.provide(IMPORT_PLUGIN_ID, IMPORT_MANAGER_SERVICE, flow.service()),
    context.services.provide(IMPORT_PLUGIN_ID, IMPORT_ANNOTATOR_SERVICE, annotator.service()),
    ...[...contributions(), settingsContribution()].map(([point, id, impl]) => context.extensions.contribute(IMPORT_PLUGIN_ID, point, id, impl)),
    // Proposals waiting for review are scored, and shown, by the preset chosen now
    settings.onDidChange(({ changed }) => {
      if (changed.includes('matching')) annotator.presetChanged().catch(quietly('Could not refresh the registers for the new matching preset'))
    }),
    context.extensions.onDidChange(({ point }) => { if (point === IMPORT_FORMATS_POINT) publishFormats() }),
    // An import interrupted last time is put right as soon as its ledger opens
    session.onDidChange(change => { if (change.type === 'opened') importer.recover().catch(quietly('Could not check for interrupted imports')) }),
    // A deleted account takes its saved matches and import records with it
    accounts.onDidChange(change => { importer.forgetAccounts(change.deleted).catch(quietly('Could not forget deleted accounts')) }),
    context.commands.register(IMPORT_COMMANDS.file, async () => {
      try {
        await flow.importFiles()
      } catch (err) {
        if (!isImportError(err)) throw err
        await prompts.message({ kind: 'error', message: 'Nothing was imported.', detail: err.message })
      }
    }, {
      enablement: `${LEDGER_CONTEXT_KEYS.isOpen} && !${LEDGER_CONTEXT_KEYS.isReadOnly} && ${IMPORT_CONTEXT_KEYS.hasFormats} && !${IMPORT_CONTEXT_KEYS.isRunning}`
    }),
    // Review, from the register's buttons and review bar. Each answers a result: a failure shows in the register
    context.commands.register(IMPORT_COMMANDS.accept, (args: unknown) => review.accept(args as AcceptArgs), { enablement: reviewing }),
    context.commands.register(IMPORT_COMMANDS.acceptAll, (args: unknown) => review.acceptAll(args as AcceptAllArgs), { enablement: reviewing }),
    context.commands.register(IMPORT_COMMANDS.change, (args: unknown) => review.change(args as ChangeArgs), { enablement: reviewing }),
    // The Change Match dialog's list
    context.ipc.register(IMPORT_CHANNELS.matchCandidates, (msg: IpcMessage<MatchCandidatesRequest>) =>
      toReviewResult(() => review.candidates(msg.data)))
  )
  context.contextKeys.set(IMPORT_CONTEXT_KEYS.isRunning, false)
  publishFormats()
  // Format plugins that activate after this one are counted once every plugin has
  context.lifecycle.onStarted(() => publishFormats())
}
