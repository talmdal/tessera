// An import, from files to transactions: choose the files, then for each file its format, its statements, and for
// each statement its account; convert the lines, leave out those imported before, propose matches for those the user
// already entered, and add the rest. One import runs at a time. A file that fails is reported and the others still import; Cancel stops the file and those after it.
// See docs/import-manager-design.md, "The import flow".
import path from 'node:path'
import type { AppState, ContextKeyService, Database, Logger, ShellFiles, ShellPrompts } from '@tessera/types'
import type { LedgerSession } from '@tessera/ledger-api'
import { isAccountsError, isLiability, type Account, type AccountsService, type PayeeSuggestion } from '@tessera/accounts-api'
import {
  IMPORT_CONTEXT_KEYS, IMPORT_DIALOGS, IMPORT_LIMITS, IMPORT_STATE_KEYS, ImportError, isImportError,
  type FormatDialogInput, type FormatDialogResult, type ImportCounts, type ImportErrorCode, type ImportFile,
  type ImportFormatContribution, type ImportReport, type ImportSource, type ParsedStatement, type StatementReport
} from '@tessera/import-api'
import { AccountResolver } from './accountResolution'
import type { PayeeAliases } from './aliases'
import { applyImport, recoverImports } from './apply'
import { convertLines, toMinor, type ConvertedLine } from './convert'
import { Drafts } from './drafts'
import { nodeReader, readImportFile, type FileReader } from './files'
import type { Formats } from './formats'
import type { Links } from './links'
import { assign, isCandidate, windowOf, type Proposal } from './matching/assign'
import { MATCHED_AT } from './matching/tuning'
import { formatMemory } from './memory'
import { settleInterrupted } from './review'
import { collectionsOf } from './store'

export interface ImporterDeps {
  session: LedgerSession
  accounts: AccountsService
  files: ShellFiles
  prompts: ShellPrompts
  appState: AppState
  formats: Formats
  links: Links
  aliases: PayeeAliases
  /** Told which accounts' import records changed, so their registers' marks are read again. */
  changed: (accounts: string[]) => void
  contextKeys: Pick<ContextKeyService, 'set'>
  log: Logger
  reader?: FileReader
  now?: () => Date
  parseTimeoutMs?: number
}

const NO_COUNTS: ImportCounts = { lines: 0, added: 0, matched: 0, possible: 0, duplicates: 0, invalid: 0 }

/** Rejects after `ms` unless `work` settles first, aborting `controller`; the timer never outlives it. */
function within<T>(work: Promise<T>, ms: number, controller: AbortController, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new ImportError('UNREADABLE', `${what} took too long to read (more than ${ms / 1000} seconds).`)) }, ms)
  })
  return Promise.race([work, late]).finally(() => clearTimeout(timer))
}

/** Why something failed, as the report says it: an import or accounts error as it is, anything else as unreadable. */
function failureOf(err: unknown): { code: ImportErrorCode, message: string } {
  if (isImportError(err)) return { code: err.code, message: err.message }
  if (isAccountsError(err)) {
    const code: ImportErrorCode = err.code === 'ACCOUNT_CLOSED' ? 'ACCOUNT_CLOSED' : err.code === 'NO_LEDGER' ? 'NO_LEDGER'
      : err.code === 'READ_ONLY' ? 'READ_ONLY' : 'UNREADABLE'
    return { code, message: err.message }
  }
  return { code: 'UNREADABLE', message: String((err as Error)?.message ?? err) }
}

/** Where statements come from in one run: a file (with its format) or a plugin. */
interface Origin {
  source: string
  filePath?: string
  format?: ImportFormatContribution
  formatLabel: string
}

export class Importer {
  private running = false
  private notices: string[] = []
  private readonly reader: FileReader
  private readonly now: () => Date

  constructor(private readonly deps: ImporterDeps) {
    this.reader = deps.reader ?? nodeReader
    this.now = deps.now ?? (() => new Date())
  }

  get isRunning(): boolean {
    return this.running
  }

  private db(): Database {
    return this.deps.session.database('import')
  }

  private today(): string {
    const d = this.now()
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  }

  /**
   * Puts right imports, and review changes, an interruption left half done. Notices for the user wait for the next
   * import's summary. A read-only ledger is left as it is.
   */
  async recover(): Promise<void> {
    if (!this.deps.session.current || this.deps.session.current.readOnly) return
    await settleInterrupted(() => this.db(), this.deps.accounts)
    const notices = await recoverImports(() => this.db(), this.deps.accounts)
    for (const notice of notices) this.deps.log.warn(`[import] ${notice}`)
    this.notices.push(...notices)
  }

  /** Deletes what the import kept about accounts that are gone: their matches, lines and batches. */
  async forgetAccounts(accountIds: string[]): Promise<void> {
    if (accountIds.length === 0 || !this.deps.session.current) return
    await this.db().transaction(async tx => {
      const c = collectionsOf(tx)
      const accountId = { $in: accountIds }
      await c.links.deleteMany({ accountId })
      await c.lines.deleteMany({ accountId })
      await c.batches.deleteMany({ accountId })
    })
  }

  /** Runs `work` as the one import in progress, with the ledger open and writable. */
  private async exclusively<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const current = this.deps.session.current
    if (!current) throw new ImportError('NO_LEDGER', 'Open a ledger to import into.')
    if (current.readOnly) throw new ImportError('READ_ONLY', 'This ledger is open read-only.')
    if (this.running) throw new ImportError('BUSY', 'Another import is running. Wait for it to finish.')
    this.running = true
    this.deps.contextKeys.set(IMPORT_CONTEXT_KEYS.isRunning, true)
    const controller = new AbortController()
    const closing = this.deps.session.onWillClose(() => controller.abort())
    try {
      await this.recover()
      return await work(controller.signal)
    } finally {
      closing.dispose()
      this.running = false
      this.deps.contextKeys.set(IMPORT_CONTEXT_KEYS.isRunning, false)
    }
  }

  /** The File › Import… flow. Asks for files when `paths` is omitted; undefined if the user cancels that. */
  async importFiles(paths?: string[], options: { windowId?: number } = {}): Promise<ImportReport | undefined> {
    return this.exclusively(async signal => {
      const chosen = paths ?? await this.chooseFiles(options.windowId)
      if (chosen.length === 0) return undefined
      const report: ImportReport = { results: [] }
      for (const filePath of chosen) {
        if (signal.aborted) break
        const stop = await this.importFile(filePath, report, signal, options.windowId)
        if (stop) break
      }
      return this.finish(report)
    })
  }

  /** Statements a plugin already has: the same account resolution, duplicates and applying as for a file. */
  async importStatements(statements: ParsedStatement[], source: ImportSource, options: { interactive?: boolean } = {}): Promise<ImportReport> {
    return this.exclusively(async signal => {
      const format = source.formatId !== undefined ? this.deps.formats.all().find(f => f.id === source.formatId) : undefined
      const report: ImportReport = { results: [] }
      await this.importParsed(statements, { source: source.label, ...(format && { format }), formatLabel: format?.label ?? source.label },
        report, signal, options.interactive ?? true)
      return this.finish(report)
    })
  }

  private finish(report: ImportReport): ImportReport {
    if (this.notices.length > 0) { report.notices = this.notices; this.notices = [] }
    return report
  }

  private async chooseFiles(windowId?: number): Promise<string[]> {
    const { files, appState } = this.deps
    const last = await appState.get<string>(IMPORT_STATE_KEYS.lastFolder).catch(() => undefined)
    const folder = last && await files.exists(last) ? last : files.downloadsPath()
    const chosen = await files.showOpenFilesDialog({
      title: 'Import Statements', buttonLabel: 'Import', defaultPath: folder, filters: this.deps.formats.filters(),
      ...(windowId !== undefined && { windowId })
    })
    if (chosen.length > 0) await appState.set(IMPORT_STATE_KEYS.lastFolder, path.dirname(chosen[0])).catch(() => undefined)
    return chosen
  }

  /** Imports one file's statements into `report`. Resolves true when the user cancelled the import. */
  private async importFile(filePath: string, report: ImportReport, signal: AbortSignal, windowId?: number): Promise<boolean> {
    const name = path.basename(filePath)
    const failed = (err: unknown, warnings: string[] = []) => {
      report.results.push({ source: name, statementIndex: 0, outcome: 'failed', counts: NO_COUNTS, error: failureOf(err), warnings })
      return false
    }

    let file: ImportFile
    try {
      file = await readImportFile(filePath, this.reader)
    } catch (err) { return failed(err) }

    const choice = await this.deps.formats.choose(file)
    let format: ImportFormatContribution
    if (choice.kind === 'none') {
      const installed = this.deps.formats.all().map(f => f.label).join(', ')
      return failed(new ImportError('NO_FORMAT', `Tessera can't read ${name}.${installed ? ` It can import: ${installed}.` : ''}`))
    }
    if (choice.kind === 'one') format = choice.format
    else {
      const input: FormatDialogInput = { fileName: name, formats: choice.formats.map(({ id, label, description }) => ({ id, label, ...(description && { description }) })) }
      const answer = await this.deps.prompts.show<FormatDialogResult, FormatDialogInput>(IMPORT_DIALOGS.format, input, windowId !== undefined ? { windowId } : undefined)
      const chosen = answer && choice.formats.find(f => f.id === answer.formatId)
      if (!chosen) {
        report.results.push({ source: name, statementIndex: 0, outcome: 'cancelled', counts: NO_COUNTS, warnings: [] })
        return true
      }
      format = chosen
    }

    const service = this.deps.formats.service(format)
    if (!service) return failed(new ImportError('NO_FORMAT', `${format.label} can't be read right now: its plugin didn't start.`))
    const controller = new AbortController()
    const stopParsing = () => controller.abort()
    signal.addEventListener('abort', stopParsing)
    let parsed
    try {
      parsed = await within(Promise.resolve(service.parse(file, {
        signal: controller.signal, memory: formatMemory(() => this.db(), format.id), log: this.deps.log,
        ...(windowId !== undefined && { windowId })
      })), this.deps.parseTimeoutMs ?? IMPORT_LIMITS.parseTimeoutMs, controller, name)
    } catch (err) {
      return failed(err)
    } finally {
      signal.removeEventListener('abort', stopParsing)
    }
    if (parsed === undefined) {
      report.results.push({ source: name, statementIndex: 0, outcome: 'skipped', counts: NO_COUNTS, warnings: [] })
      return false
    }
    const warnings = (Array.isArray(parsed.warnings) ? parsed.warnings : []).map(w => w.line !== undefined ? `Line ${w.line}: ${w.message}` : w.message)
    const statements = Array.isArray(parsed.statements) ? parsed.statements : []
    if (statements.length === 0 || statements.every(s => !Array.isArray(s.lines) || s.lines.length === 0)) {
      return failed(new ImportError('EMPTY', `${name} holds no transactions.`), warnings)
    }
    const before = report.results.length
    const stop = await this.importParsed(statements, { source: name, filePath, format, formatLabel: format.label }, report, signal, true, windowId)
    // The file's own warnings belong with its first statement
    if (warnings.length > 0 && report.results.length > before) report.results[before].warnings.unshift(...warnings)
    return stop
  }

  /** Imports statements into `report`. Resolves true when the user cancelled the import. */
  private async importParsed(statements: ParsedStatement[], origin: Origin, report: ImportReport, signal: AbortSignal, interactive: boolean, windowId?: number): Promise<boolean> {
    for (const [statementIndex, statement] of statements.entries()) {
      if (signal.aborted) {
        report.results.push({ source: origin.source, statementIndex, outcome: 'cancelled', counts: NO_COUNTS, error: { code: 'CANCELLED', message: 'The ledger closed.' }, warnings: [] })
        return true
      }
      const base = { source: origin.source, statementIndex, warnings: [] as string[] }
      const lineCount = Array.isArray(statement.lines) ? statement.lines.length : 0
      try {
        const resolution = await new AccountResolver({
          accounts: this.deps.accounts, links: this.deps.links, prompts: this.deps.prompts, log: this.deps.log, today: () => this.today()
        }).resolve({
          statement, statementIndex, statementCount: statements.length, fileName: origin.source,
          format: { id: origin.format?.id ?? `plugin:${origin.source}`, label: origin.formatLabel }, interactive,
          ...(windowId !== undefined && { windowId })
        })
        if (resolution.kind === 'cancel') {
          report.results.push({ ...base, outcome: 'cancelled', counts: { ...NO_COUNTS, lines: lineCount } })
          return true
        }
        if (resolution.kind === 'skip') { report.results.push({ ...base, outcome: 'skipped', counts: { ...NO_COUNTS, lines: lineCount } }); continue }
        if (resolution.kind === 'needsAccount') { report.results.push({ ...base, outcome: 'needsAccount', counts: { ...NO_COUNTS, lines: lineCount } }); continue }
        report.results.push(await this.importStatement(statement, resolution.account, origin, statementIndex))
      } catch (err) {
        report.results.push({ ...base, outcome: 'failed', counts: { ...NO_COUNTS, lines: lineCount }, error: failureOf(err) })
      }
    }
    return false
  }

  /** One statement into its account: convert, leave out lines imported before, add the rest. */
  private async importStatement(statement: ParsedStatement, account: Account, origin: Origin, statementIndex: number): Promise<StatementReport> {
    const { accounts } = this.deps
    const base = { source: origin.source, statementIndex, accountId: account.id, accountName: account.name }
    if (account.closed) throw new ImportError('ACCOUNT_CLOSED', `“${account.name}” is closed, so nothing can be imported into it.`)
    if (statement.currency !== undefined && statement.currency !== account.currency) {
      throw new ImportError('CURRENCY_MISMATCH', `The statement is in ${statement.currency}, but “${account.name}” is in ${account.currency}.`)
    }
    const converted = convertLines(statement.lines, account.currency, { stableIds: origin.format?.stableIds })
    const known = await this.importedBefore(account.id, converted.lines.map(l => l.importId))
    const fresh = converted.lines.filter(line => !known.has(line.importId))
    const counts: ImportCounts = {
      ...NO_COUNTS, lines: statement.lines.length, invalid: converted.invalid,
      duplicates: converted.lines.length - fresh.length + converted.repeated
    }
    if (fresh.length === 0) return { ...base, outcome: 'imported', counts, warnings: converted.warnings }

    const [payees, categories, aliases] = await Promise.all([
      accounts.payees.search('', 100_000), accounts.categories.list(), this.deps.aliases.map()
    ])
    // The lines that are transactions the user already entered are proposed as matches; the rest are added
    const proposals = await this.propose(account, fresh, payees, aliases)
    const proposedLines = new Set(proposals.map(p => p.line))
    const added = fresh.filter((_, i) => !proposedLines.has(i))
    const matched = proposals.map(p => ({ line: fresh[p.line], proposedId: p.transactionId, score: p.score }))
    counts.added = added.length
    counts.matched = matched.filter(m => m.score >= MATCHED_AT).length
    counts.possible = matched.length - counts.matched

    const drafts = new Drafts({ payees, categories, liability: isLiability(account.type), aliases })
    const balance = statement.balance ? toMinor(statement.balance.amount, account.currency) : undefined
    const { batchId } = await applyImport(() => this.db(), accounts, {
      accountId: account.id, fileName: origin.source, statementIndex, counts,
      ...(origin.filePath !== undefined && { filePath: origin.filePath }),
      ...(origin.format !== undefined && { formatId: origin.format.id }),
      ...(statement.period !== undefined && { period: statement.period }),
      ...(balance?.ok && { bankBalance: { amount: balance.value, asOf: statement.balance!.asOf } }),
      lines: added, drafts: added.map(line => drafts.draftFor(line)), matched
    }, this.now().toISOString())
    await this.deps.aliases.used(drafts.usedAliases).catch(err => this.deps.log.warn(`[import] Could not count payee alias uses: ${(err as Error)?.message ?? err}`))
    this.deps.changed([account.id])
    return { ...base, outcome: 'imported', counts, batchId, warnings: converted.warnings }
  }

  /**
   * The statement's lines that look like transactions already in the account, each paired with one transaction.
   * The candidates are read once, over the whole statement's window.
   */
  private async propose(account: Account, lines: ConvertedLine[], payees: PayeeSuggestion[], aliases: ReadonlyMap<string, string>): Promise<Proposal[]> {
    const range = windowOf(lines.map(line => line.bank))
    if (!range) return []
    const listed = await this.deps.accounts.transactions(account.id).list(range)
    // A transaction already proposed for a line of an earlier import waits for that line's review
    const pending = new Set((await collectionsOf(this.db()).lines.find({ accountId: account.id, outcome: 'matched', review: 'pending' }))
      .map(line => line.proposedId).filter((id): id is string => id !== undefined))
    const names = new Map(payees.map(p => [p.id, p.name]))
    const targets = listed.filter(t => isCandidate(t, pending)).map(t => ({
      id: t.id, date: t.date, amount: t.amount,
      ...(t.payeeId !== undefined && names.has(t.payeeId) && { payeeName: names.get(t.payeeId)! }),
      ...(t.number !== undefined && { number: t.number })
    }))
    return assign(lines.map(line => line.bank), targets, account.currency, aliases)
  }

  /** The import ids among `ids` already in the account, or recorded as imported (so one the user deleted stays gone). */
  private async importedBefore(accountId: string, ids: string[]): Promise<Set<string>> {
    const known = new Set<string>()
    const lines = collectionsOf(this.db()).lines
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500)
      for (const t of await this.deps.accounts.transactions(accountId).findByExternalIds(chunk)) if (t.externalId) known.add(t.externalId)
      for (const line of await lines.find({ accountId, importId: { $in: chunk } })) known.add(line.importId)
    }
    return known
  }
}
