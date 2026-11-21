// The exchange plugin: reading a statement or a whole data file into the open book, and writing one back out.
// It owns the pipeline — read, resolve, match, review, apply — and the `exchange.formats` seam that file
// formats attach to. See docs/import-export-design.md.
//
// Built so far: the pipeline (phase 1), the review view with Accept and Change… (phase 3), and OFX, QFX and
// QBO through the `exchange-ofx` plugin (phase 2). QIF and CSV are phases 4 and 5, and export is phase 5.
// Until a format plugin is installed the import command is disabled, which is what `exchange.formats.count`
// is for.
import type { PluginContext, ShellFiles, ShellPrompts } from '@tessera/types'
import { SHELL_FILES_SERVICE, SHELL_PROMPTS_SERVICE } from '@tessera/types'
import { BOOK_SCHEMA_POINT, BOOK_SESSION_SERVICE, type BookSession } from '@tessera/book-api'
import { ACCOUNTS_SERVICE, type AccountsService } from '@tessera/accounts-api'
import {
  EXCHANGE_EVENTS, EXCHANGE_MIGRATOR_SERVICE, EXCHANGE_OPTIONS_DEFAULTS, EXCHANGE_PLUGIN_ID, EXCHANGE_SERVICE,
  validateExchangeOptions, type ExchangeOptions, type ExchangeService
} from '@tessera/exchange-api'
import { ExchangeServiceImpl } from './ExchangeServiceImpl'
import { registerCommands } from './commands'
import { contributions } from './contributions'
import { nodeDisk, type ExchangeDisk } from './disk'
import { FormatRegistry } from './formats'
import { ExportOptionsRegistry } from './exportOptions'
import { local as localEvent, publishKeys, registerIpc } from './ipc'
import { EXCHANGE_SCHEMA, exchangeMigrator } from './schema'

/** Exactly the `ExchangeService` contract, so other plugins can't reach the implementation's internals. */
export function publicService(service: ExchangeServiceImpl): ExchangeService {
  return {
    formats: () => service.formats(),
    read: (path, options) => service.read(path, options),
    file: (statement, accountId, options) => service.file(statement, accountId, options),
    ensureCategories: document => service.ensureCategories(document),
    pendingSummary: () => service.pendingSummary(),
    pendingFor: accountId => service.pendingFor(accountId),
    accept: (accountId, statementId, rowKey, options) => service.accept(accountId, statementId, rowKey, options),
    setMatch: (accountId, statementId, rowKey, matchTo) => service.setMatch(accountId, statementId, rowKey, matchTo),
    editRow: (accountId, statementId, rowKey, edit) => service.editRow(accountId, statementId, rowKey, edit),
    dismiss: (accountId, statementId, rowKey) => service.dismiss(accountId, statementId, rowKey),
    previewRename: (accountId, statementId, rowKey, payee) => service.previewRename(accountId, statementId, rowKey, payee),
    matchingCandidates: (accountId, statementId, rowKey) => service.matchingCandidates(accountId, statementId, rowKey),
    undo: (batchId, options) => service.undo(batchId, options),
    history: filter => service.history(filter),
    export: request => service.export(request),
    links: () => service.links(),
    removeLink: id => service.removeLink(id),
    updateLink: (id, patch) => service.updateLink(id, patch),
    payeeRules: service.payeeRules,
    onDidChange: service.onDidChange
  }
}

export interface ActivateOptions {
  /** The file system to use. Injected by tests, as the book plugin's disk is. */
  disk?: ExchangeDisk
}

export async function activate(context: PluginContext, options: ActivateOptions = {}) {
  const session = context.services.get<BookSession>(BOOK_SESSION_SERVICE)
  const accounts = context.services.get<AccountsService>(ACCOUNTS_SERVICE)
  const prompts = context.services.get<ShellPrompts>(SHELL_PROMPTS_SERVICE)
  const files = context.services.get<ShellFiles>(SHELL_FILES_SERVICE)

  const formats = new FormatRegistry({
    extensions: context.extensions,
    services: context.services,
    log: context.logger
  })
  const exportOptions = new ExportOptionsRegistry({ extensions: context.extensions, log: context.logger })

  // The user's own settings, or the defaults until the options service hands over the real ones. Every option
  // here changes how a file is *read*; what a file is written as belongs to the export dialog.
  const settings = context.options?.register<ExchangeOptions>({
    defaults: EXCHANGE_OPTIONS_DEFAULTS,
    validate: value => validateExchangeOptions(value)
  })

  const service = new ExchangeServiceImpl({
    session, accounts, prompts, files, formats, exportOptions,
    ...(settings !== undefined && { options: () => settings.get() }),
    disk: options.disk ?? nodeDisk(), log: context.logger
  })

  const publish = () => publishKeys(context, service, formats, session)

  context.subscriptions.push(
    // The register's overlay and the Statements view follow this: whose pending statements changed
    service.onDidChange(changed => {
      if (changed.pending.length > 0) {
        context.events.emit(localEvent(EXCHANGE_EVENTS.pending), { accounts: changed.pending })
      }
    }),
    { dispose: () => service.dispose() },
    // Declared before any book opens; the collections are created when one does
    context.extensions.contribute(EXCHANGE_PLUGIN_ID, BOOK_SCHEMA_POINT, EXCHANGE_PLUGIN_ID, EXCHANGE_SCHEMA),
    context.services.provide(EXCHANGE_PLUGIN_ID, EXCHANGE_MIGRATOR_SERVICE, exchangeMigrator),
    context.services.provide(EXCHANGE_PLUGIN_ID, EXCHANGE_SERVICE, publicService(service)),
    // Before accounts: ordering only sequences the prunes — what each removes comes from the surveys
    session.participateInArchive(EXCHANGE_PLUGIN_ID, service.archiveParticipant, { before: ['accounts'] }),

    service.onDidChange(() => { void publish() }),
    session.onDidChange(() => { void publish() }),

    ...contributions().map(([point, id, impl]) => context.extensions.contribute(EXCHANGE_PLUGIN_ID, point, id, impl)),
    ...registerIpc(context, service, formats, session),
    ...registerCommands(context, { service, prompts, formats, exportOptions, session, accounts, files })
  )

  // After every plugin has activated, so a format contributed by one that loads later is counted
  context.lifecycle.onStarted(() => { void publish() })
  await publish()
}
