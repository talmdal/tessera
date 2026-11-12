// An import, from files to transactions: choose the files, then for each file its format, its statements, and for
// each statement its account; convert the lines, leave out those imported before, propose matches for those the user
// already entered, and add the rest. One import runs at a time. A file that fails is reported and the others still import; Cancel stops the file and those after it.
// See docs/import-manager-design.md, "The import flow".
import path from 'node:path'
import type { ContextKeyService, Database, Logger, PluginState, ShellFiles, ShellPrompts } from '@tessera/types'
import { displayDate, isLedgerError, type LedgerSession } from '@tessera/ledger-api'
import {
  ACCOUNT_TYPE_LABELS, AMOUNT_COLUMNS, formatAmount, isAccountsError, isLiability,
  type Account, type AccountsService, type PayeeSuggestion
} from '@tessera/accounts-api'
import {
  IMPORT_CONTEXT_KEYS, IMPORT_DIALOGS, IMPORT_LIMITS, IMPORT_STATE_KEYS, ImportError, isImportError,
  type CategoriesDialogInput, type CategoriesDialogResult, type CategorySource, type FormatDialogInput, type FormatDialogResult,
  type ImportCounts, type ImportErrorCode, type ImportFile, type ImportFormatContribution, type ImportReport, type ImportSource,
  type ParsedStatement, type SignExample, type SignsDialogInput, type SignsDialogResult, type StatementCategories, type StatementReport
} from '@tessera/import-api'
import { AccountResolver, accountFromStatement, identityOf } from './accountResolution'
import type { PayeeAliases } from './aliases'
import { applyImport, recoverImports } from './apply'
import { CategoryChoices } from './categoryChoice'
import { distrustsStatement, findCollisions, type Prior } from './collisions'
import { convertLines, isFingerprint, toMinor, type ConvertedLine } from './convert'
import { DUPLICATE_CHEQUE_DAYS, DUPLICATE_DAYS, findDuplicates, type DuplicatePair, type EarlierLine } from './matching/duplicates'
import { dayNumber } from './matching/score'
import { BOTH_WAYS_LINES, balanceSays, bothWays, describeEvidence, profileSays, shouldAsk, typeSays, type SignEvidence } from './matching/signs'
import { SignRecords, addToProfile, type SignRecord } from './signRecords'
import { Drafts } from './drafts'
import { nodeReader, readImportFile, type FileReader } from './files'
import type { Formats } from './formats'
import type { Links } from './links'
import { assign, isCandidate, windowOf, type Proposal } from './matching/assign'
import { BALANCED, type MatchTuning } from './matching/tuning'
import { formatMemory } from './memory'
import { settleInterrupted } from './review'
import { collectionsOf, type StoredLine } from './store'

/** The import's label as the ledger's running operation: "Wait for “Importing statements” to finish." */
export const IMPORT_OPERATION = 'Importing statements'

export interface ImporterDeps {
  session: LedgerSession
  accounts: AccountsService
  files: ShellFiles
  prompts: ShellPrompts
  /** What the import remembers between runs: `context.state`. */
  state: PluginState
  formats: Formats
  links: Links
  aliases: PayeeAliases
  /** Told which accounts' import records changed, so their registers' marks are read again. */
  changed: (accounts: string[]) => void
  contextKeys: Pick<ContextKeyService, 'set'>
  log: Logger
  /** The matching preset the user chose (the `import` setting), read at each statement. Balanced when not given. */
  tuning?: () => MatchTuning
  reader?: FileReader
  now?: () => Date
  parseTimeoutMs?: number
}

const NO_COUNTS: ImportCounts = { lines: 0, added: 0, matched: 0, possible: 0, duplicates: 0, invalid: 0 }

/**
 * A format's time limit for one file's `parse`, which stops while the format's dialog is open: the limit is there to
 * stop a hung or slow format, not a user reading a preview. When it runs out, it aborts the parse and `expired`
 * rejects. Pauses nest, for a format that opens a dialog from inside another's answer.
 */
export class ParseClock {
  private timer: ReturnType<typeof setTimeout> | undefined
  private remaining: number
  private startedAt = 0
  private pauses = 0
  private over = false
  private fail: (err: unknown) => void = () => {}
  /** Rejects when the time is up; never settles otherwise. */
  readonly expired: Promise<never>

  constructor(ms: number, private readonly onExpire: () => unknown) {
    this.remaining = ms
    this.expired = new Promise<never>((_, reject) => { this.fail = reject })
    this.expired.catch(() => {})                     // raced by the run; never an unhandled rejection
    this.start()
  }

  private start() {
    this.startedAt = Date.now()
    this.timer = setTimeout(() => {
      this.over = true
      this.fail(this.onExpire())
    }, Math.max(0, this.remaining))
  }

  pause() {
    if (this.over || this.pauses++ > 0) return
    clearTimeout(this.timer)
    this.remaining -= Date.now() - this.startedAt
  }

  resume() {
    if (this.over || this.pauses === 0 || --this.pauses > 0) return
    this.start()
  }

  /** The parse is over: the clock never fires. */
  stop() {
    this.over = true
    clearTimeout(this.timer)
  }
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

/** A balance as the user reads it: for a card or a loan, what they owe (or have in credit). */
function balanceInWords(minor: number, account: Account): string {
  const amount = formatAmount(Math.abs(minor), account.currency, { currency: false })
  if (!isLiability(account.type)) return formatAmount(minor, account.currency, { currency: false })
  return minor <= 0 ? `you owe ${amount}` : `${amount} in your favour`
}

/** A decimal the other way round: '-84.12' ↔ '84.12'; zero stays zero. */
const negate = (decimal: string) => /^-/.test(decimal) ? decimal.slice(1) : /^0*(\.0*)?$/.test(decimal) ? decimal : `-${decimal}`

/** A statement with every amount, and its balance, the other way round. */
export function reversedStatement(statement: ParsedStatement): ParsedStatement {
  return {
    ...statement,
    lines: statement.lines.map(line => ({ ...line, amount: typeof line.amount === 'string' ? negate(line.amount) : line.amount })),
    ...(statement.balance && { balance: { ...statement.balance, amount: negate(statement.balance.amount) } })
  }
}

/** The format id statements are known under: their format's, or, from a plugin with none, one made from its label. */
const formatIdOf = (origin: Origin) => origin.format?.id ?? `plugin:${origin.source}`

/** The warning for a line whose bank id had named another transaction: which line, and what the id named then. */
function collisionWarning(line: ConvertedLine, prior: Prior, currency: string): string {
  const before = prior.kind === 'line' ? prior.bank : { date: prior.date, amount: prior.amount, payee: undefined }
  const what = [displayDate(before.date), ...(before.payee ? [before.payee] : []), formatAmount(before.amount, currency, { currency: false })].join(', ')
  return `Line ${line.line}: the bank’s id “${line.importId}” was used before for a different transaction (${what}), so this line is recognised by its content instead.`
}

export class Importer {
  private running = false
  private notices: string[] = []
  private readonly reader: FileReader
  private readonly now: () => Date
  private readonly categoryChoices: CategoryChoices
  private readonly signRecords: SignRecords

  constructor(private readonly deps: ImporterDeps) {
    this.reader = deps.reader ?? nodeReader
    this.now = deps.now ?? (() => new Date())
    this.categoryChoices = new CategoryChoices(() => this.db(), () => this.now().toISOString())
    this.signRecords = new SignRecords(() => this.db(), () => this.now().toISOString())
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
    await this.signRecords.forgetAccounts(accountIds)
  }

  /**
   * Runs `work` as the one import in progress, with the ledger open and writable. It is the ledger's operation for
   * the whole run, dialogs included, so no backup (or Close Ledger) happens in the middle of an import.
   */
  private async exclusively<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const current = this.deps.session.current
    if (!current) throw new ImportError('NO_LEDGER', 'Open a ledger to import into.')
    if (current.readOnly) throw new ImportError('READ_ONLY', 'This ledger is open read-only.')
    if (this.running) throw new ImportError('BUSY', 'Another import is running. Wait for it to finish.')
    let operation: { dispose(): void }
    try {
      operation = this.deps.session.beginOperation(IMPORT_OPERATION)
    } catch (err) {
      if (isLedgerError(err) && err.code === 'BUSY') throw new ImportError('BUSY', err.message)
      throw err
    }
    this.running = true
    this.deps.contextKeys.set(IMPORT_CONTEXT_KEYS.isRunning, true)
    const controller = new AbortController()
    const closing = this.deps.session.onWillClose(() => controller.abort())
    try {
      await this.recover()
      return await work(controller.signal)
    } finally {
      closing.dispose()
      operation.dispose()
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
    const { files, state } = this.deps
    const last = await state.get<string>(IMPORT_STATE_KEYS.lastFolder).catch(() => undefined)
    const folder = last && await files.exists(last) ? last : files.downloadsPath()
    const chosen = await files.showOpenFilesDialog({
      title: 'Import Statements', buttonLabel: 'Import', defaultPath: folder, filters: this.deps.formats.filters(),
      ...(windowId !== undefined && { windowId })
    })
    if (chosen.length > 0) await state.set(IMPORT_STATE_KEYS.lastFolder, path.dirname(chosen[0])).catch(() => undefined)
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
    const limit = this.deps.parseTimeoutMs ?? IMPORT_LIMITS.parseTimeoutMs
    const clock = new ParseClock(limit, () => {
      controller.abort()
      return new ImportError('UNREADABLE', `${name} took too long to read (more than ${limit / 1000} seconds).`)
    })
    // The format's own dialogs: in the import's window, and with the clock stopped while the user answers
    const prompt = async <TResult, TInput>(dialogId: string, input: TInput, options?: { title?: string }): Promise<TResult | undefined> => {
      if (controller.signal.aborted) return undefined
      clock.pause()
      try {
        const answer = await this.deps.prompts.show<TResult, TInput>(dialogId, input, {
          ...(typeof options?.title === 'string' && { title: options.title }), ...(windowId !== undefined && { windowId })
        })
        return controller.signal.aborted ? undefined : answer
      } finally {
        clock.resume()
      }
    }
    let parsed
    try {
      parsed = await Promise.race([Promise.resolve(service.parse(file, {
        signal: controller.signal, memory: formatMemory(() => this.db(), format.id), log: this.deps.log, prompt,
        ...(windowId !== undefined && { windowId })
      })), clock.expired])
    } catch (err) {
      // Cancel Import in the format's own dialog: this file and those after it are left, as in the import's dialogs
      if (isImportError(err) && err.code === 'CANCELLED') {
        report.results.push({ source: name, statementIndex: 0, outcome: 'cancelled', counts: NO_COUNTS, warnings: [] })
        return true
      }
      return failed(err)
    } finally {
      clock.stop()
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
          format: { id: formatIdOf(origin), label: origin.formatLabel }, interactive,
          ...(windowId !== undefined && { windowId })
        })
        if (resolution.kind === 'cancel') {
          report.results.push({ ...base, outcome: 'cancelled', counts: { ...NO_COUNTS, lines: lineCount } })
          return true
        }
        if (resolution.kind === 'skip') { report.results.push({ ...base, outcome: 'skipped', counts: { ...NO_COUNTS, lines: lineCount } }); continue }
        if (resolution.kind === 'needsAccount') { report.results.push({ ...base, outcome: 'needsAccount', counts: { ...NO_COUNTS, lines: lineCount } }); continue }
        report.results.push(await this.importStatement(statement, resolution.account, origin, statementIndex, { interactive, ...(windowId !== undefined && { windowId }) }, resolution.how))
      } catch (err) {
        // Cancel Import in a question about the statement (its categories): nothing of it was applied
        if (isImportError(err) && err.code === 'CANCELLED') {
          report.results.push({ ...base, outcome: 'cancelled', counts: { ...NO_COUNTS, lines: lineCount } })
          return true
        }
        report.results.push({ ...base, outcome: 'failed', counts: { ...NO_COUNTS, lines: lineCount }, error: failureOf(err) })
      }
    }
    return false
  }

  /**
   * One statement into its account: convert, leave out lines imported before, propose matches, and add the rest,
   * except lines dated before the account's last archival date, which are never added.
   */
  /**
   * A statement's lines as the account will take them: converted, each with its import id, a bank id that named another
   * transaction before known by its content instead, and the lines imported before left out (`fresh` are the rest).
   */
  private async prepareLines(statement: ParsedStatement, account: Account, origin: Origin) {
    // The statement's own word on its bank ids wins over its format's
    const stableIds = typeof statement.stableIds === 'boolean' ? statement.stableIds : origin.format?.stableIds
    let converted = convertLines(statement.lines, account.currency, { stableIds })
    let known = await this.importedBefore(account.id, converted.lines.map(l => l.importId))

    // A bank id seen before that now names a different transaction isn't a duplicate: the line is known by its content
    const collisions = findCollisions(converted.lines, known)
    const collisionWarnings: string[] = []
    if (collisions.length > 0) {
      const knownBankIds = converted.lines.filter(l => !isFingerprint(l.importId) && known.has(l.importId)).length
      const wholeStatement = distrustsStatement(collisions.length, knownBankIds)
      if (wholeStatement) {
        collisionWarnings.push(`${collisions.length === 1 ? 'A bank id' : `${collisions.length.toLocaleString()} of the bank’s ids`} in this statement had been used before for other transactions, so none of its ids are trusted: its lines are recognised by their content instead.`)
      } else {
        for (const { line, prior } of collisions) collisionWarnings.push(collisionWarning(line, prior, account.currency))
      }
      converted = convertLines(statement.lines, account.currency, wholeStatement
        ? { stableIds: false }
        : { stableIds, distrust: new Set(collisions.map(c => c.line.importId)) })
      known = await this.importedBefore(account.id, converted.lines.map(l => l.importId))
    }
    const warnings = [...converted.warnings, ...collisionWarnings]
    const fresh = converted.lines.filter(line => !known.has(line.importId))
    const counts: ImportCounts = {
      ...NO_COUNTS, lines: statement.lines.length, invalid: converted.invalid,
      duplicates: converted.lines.length - fresh.length + converted.repeated,
      ...(collisions.length > 0 && { idConflicts: collisions.length })
    }
    return { converted, fresh, counts, warnings }
  }

  /**
   * One statement into its account: convert, leave out lines imported before, check the amounts aren't the wrong way
   * round, propose matches, and add the rest, except lines dated before the account's last archival date, which are
   * never added. `how` says how the account was found: one created from this statement is set right if its amounts
   * are reversed.
   */
  private async importStatement(original: ParsedStatement, account: Account, origin: Origin, statementIndex: number,
    ask: { interactive: boolean, windowId?: number }, how?: 'saved' | 'number' | 'chosen' | 'created'): Promise<StatementReport> {
    const { accounts } = this.deps
    const base = { source: origin.source, statementIndex, accountId: account.id, accountName: account.name }
    if (account.closed) throw new ImportError('ACCOUNT_CLOSED', `“${account.name}” is closed, so nothing can be imported into it.`)
    if (original.currency !== undefined && original.currency !== account.currency) {
      throw new ImportError('CURRENCY_MISMATCH', `The statement is in ${original.currency}, but “${account.name}” is in ${account.currency}.`)
    }
    const { key } = identityOf(original, formatIdOf(origin), origin.source)
    const record = await this.signRecords.get(key, account.id)
    // A correction the import manager keeps for this source (its format can't keep one) applies before anything else
    let keepReversing = record?.reverse === true
    let statement = keepReversing ? reversedStatement(original) : original
    let { converted, fresh, counts, warnings } = await this.prepareLines(statement, account, origin)
    let reversed: StatementReport['reversed'] = keepReversing ? { decidedBy: 'remembered', remembered: true } : undefined
    if (fresh.length === 0) return { ...base, outcome: 'imported', counts, warnings, ...(reversed && { reversed }) }

    const [payees, categories, aliases] = await Promise.all([
      accounts.payees.search('', 100_000), accounts.categories.list(), this.deps.aliases.map()
    ])
    // The lines that are transactions the user already entered are proposed as matches; the rest are added. One preset
    // for the whole statement, even if the user changes it meanwhile
    const tuning = this.deps.tuning?.() ?? BALANCED

    // Are the amounts the wrong way round? Asked at most once; reversing reads the statement again, as its fingerprints
    // include the amounts
    const evidence = await this.signEvidence(statement, converted.lines, fresh, account, origin, record, how, payees, aliases, tuning)
    if (shouldAsk(evidence)) {
      const reasons = evidence.filter(e => e.says === 'reversed').sort((a, b) => (a.strength === b.strength ? 0 : a.strength === 'strong' ? -1 : 1))
        .map(e => describeEvidence(e, minor => balanceInWords(minor, account), displayDate))
      if (!ask.interactive) {
        return {
          ...base, outcome: 'needsConfirmation', counts: { ...NO_COUNTS, lines: original.lines.length },
          warnings: [`The amounts may be the wrong way round for “${account.name}”, so nothing was imported:`, ...reasons]
        }
      }
      const answer = await this.askSigns(fresh, account, origin, reasons, keepReversing ? record : undefined, ask.windowId)
      if (!answer) throw new ImportError('CANCELLED', 'The import was cancelled.')
      if (answer.reverse) {
        statement = reversedStatement(statement)
        ;({ converted, fresh, counts, warnings } = await this.prepareLines(statement, account, origin))
        if (keepReversing) {
          // The kept correction is taken off: the files come the right way round now
          if (answer.remember) keepReversing = false
          reversed = undefined
        } else {
          // A remembered correction has one owner: the format, when it can keep it; otherwise the import manager
          if (answer.remember) keepReversing = !(await this.formatCorrects(origin, key))
          reversed = { decidedBy: 'asked', remembered: answer.remember === true }
        }
        // An account made from this statement opened at the balance the statement gave as read: the other way round now
        if (how === 'created') await this.reopen(account, original, statement)
        if (fresh.length === 0) {
          await this.keepSigns(key, account.id, record, keepReversing, [])
          return { ...base, outcome: 'imported', counts, warnings, ...(reversed && { reversed }) }
        }
      } else if (keepReversing) {
        reversed = { decidedBy: 'remembered', remembered: true }
      }
    }
    // A line that looks like one imported before from another file (the bank's CSV, then its OFX) is proposed as
    // already imported, on that line's transaction, and is neither matched nor added
    const duplicates = await this.alreadyImported(account, fresh, formatIdOf(origin))
    const duplicateLines = new Set(duplicates.map(d => d.line))
    const rest = fresh.filter((_, i) => !duplicateLines.has(i))
    if (duplicates.length > 0) counts.alreadyImported = duplicates.length
    const proposals = await this.propose(account, rest, payees, aliases, tuning)
    const proposedLines = new Set(proposals.map(p => p.line))
    // A line dated before the account's last archival date is never added: that period is in an archive file, and the
    // line may be a transaction an archive removed, whose record went with it. It can still be proposed as a match for
    // a transaction that stayed (an old cheque the bank has only now cleared): a proposal adds nothing until accepted.
    // See docs/ledger-compaction-design.md, "Imports after an archive".
    const cutoff = account.lastArchiveDate
    const unmatched = rest.filter((_, i) => !proposedLines.has(i))
    const added = cutoff === undefined ? unmatched : unmatched.filter(line => line.bank.date >= cutoff)
    const leftOut = unmatched.length - added.length
    const archivedReport = leftOut > 0 ? { lastArchiveDate: cutoff } : {}
    if (leftOut > 0) counts.archived = leftOut
    const matched = proposals.map(p => ({ line: rest[p.line], proposedId: p.transactionId, score: p.score }))
    counts.added = added.length
    counts.matched = matched.filter(m => m.score >= tuning.matchedAt).length
    counts.possible = matched.length - counts.matched
    if (added.length === 0 && matched.length === 0 && duplicates.length === 0) return { ...base, outcome: 'imported', counts, ...archivedReport, warnings }

    const drafts = new Drafts({ payees, categories, liability: isLiability(account.type), aliases })
    // Categories the file gives are used only once the user has said so for this source; asked the first time
    const categoryReport = await this.chooseCategories(drafts, added, statement, origin, account, ask)
    const balance = statement.balance ? toMinor(statement.balance.amount, account.currency) : undefined
    const { batchId } = await applyImport(() => this.db(), accounts, {
      accountId: account.id, fileName: origin.source, statementIndex, counts,
      ...(origin.filePath !== undefined && { filePath: origin.filePath }),
      formatId: formatIdOf(origin),
      ...(statement.period !== undefined && { period: statement.period }),
      ...(balance?.ok && { bankBalance: { amount: balance.value, asOf: statement.balance!.asOf } }),
      lines: added, drafts: added.map(line => drafts.draftFor(line)), matched,
      duplicates: duplicates.map(d => ({ line: fresh[d.line], proposedId: d.earlier.transactionId, duplicateOf: d.earlier.lineId, score: d.score }))
    }, this.now().toISOString())
    await this.deps.aliases.used(drafts.usedAliases).catch(err => this.deps.log.warn(`[import] Could not count payee alias uses: ${(err as Error)?.message ?? err}`))
    await this.keepSigns(key, account.id, record, keepReversing, fresh.map(line => line.bank.amount))
    this.deps.changed([account.id])
    return {
      ...base, outcome: 'imported', counts, ...archivedReport, batchId, warnings,
      ...(categoryReport !== undefined && { categories: categoryReport }),
      ...(reversed && { reversed })
    }
  }

  /**
   * The evidence on a statement's signs (matching/signs.ts), with the statement as it stands (after any kept
   * correction): lines matching the user's entries each way, lines looking like earlier imports each way, the bank's
   * balance, and, from what this source's lines are like, the account's type on its first import, or the source's
   * profile after that. The "each way" passes look at the first `BOTH_WAYS_LINES` new lines.
   */
  private async signEvidence(statement: ParsedStatement, all: ConvertedLine[], fresh: ConvertedLine[], account: Account, origin: Origin,
    record: SignRecord | undefined, how: string | undefined, payees: PayeeSuggestion[], aliases: ReadonlyMap<string, string>, tuning: MatchTuning): Promise<SignEvidence[]> {
    const evidence: SignEvidence[] = []
    const some = fresh.slice(0, BOTH_WAYS_LINES)
    const flipped = some.map(line => ({ ...line, bank: { ...line.bank, amount: -line.bank.amount } }))
    const [matchAsRead, matchReversed, earlierAsRead, earlierReversed] = await Promise.all([
      this.propose(account, some, payees, aliases, tuning), this.propose(account, flipped, payees, aliases, tuning),
      this.alreadyImported(account, some, formatIdOf(origin)), this.alreadyImported(account, flipped, formatIdOf(origin))
    ])
    const matching = bothWays(matchAsRead.length, matchReversed.length)
    if (matching) evidence.push({ kind: 'matching', says: matching, strength: 'strong', asRead: matchAsRead.length, reversed: matchReversed.length })
    const earlier = bothWays(earlierAsRead.length, earlierReversed.length)
    if (earlier) evidence.push({ kind: 'earlier', says: earlier, strength: 'strong', asRead: earlierAsRead.length, reversed: earlierReversed.length })

    // The bank's balance, for an account with a history of its own on the balance's date. (One made from this
    // statement opened at the balance the statement gave, so its balance would agree with anything)
    const bank = statement.balance ? toMinor(statement.balance.amount, account.currency) : undefined
    const asOf = statement.balance?.asOf
    if (bank?.ok && asOf !== undefined && how !== 'created' && asOf >= account.openingDate && (account.lastArchiveDate === undefined || asOf >= account.lastArchiveDate)) {
      const before = account.openingBalance + (await this.deps.accounts.transactions(account.id).list({ to: asOf }))
        .filter(t => !t.voided).reduce((sum, t) => sum + t.amount, 0)
      const lines = fresh.filter(line => line.bank.date <= asOf).reduce((sum, line) => sum + line.bank.amount, 0)
      const says = balanceSays(before, lines, bank.value)
      if (says) evidence.push({ kind: 'balance', says, strength: 'strong', balance: says === 'reversed' ? -bank.value : bank.value, asOf })
    }

    // What the source's lines are like: against the account's type the first time, against the source's profile after
    const amounts = all.map(line => line.bank.amount)
    const direction = record ? profileSays(record, amounts) : typeSays(account.type, amounts)
    if (direction) evidence.push(direction)
    return evidence
  }

  /** Amounts Reversed?: the evidence in words, a line each way, and whether to remember the answer. */
  private async askSigns(fresh: ConvertedLine[], account: Account, origin: Origin, reasons: string[],
    kept: SignRecord | undefined, windowId?: number): Promise<SignsDialogResult | undefined> {
    const example = (line: ConvertedLine | undefined): SignExample[] => line
      ? [{ date: line.bank.date, amount: line.bank.amount, ...(line.bank.payee !== undefined && { payee: line.bank.payee }) }] : []
    const input: SignsDialogInput = {
      fileName: origin.source, accountName: account.name, accountTypeLabel: ACCOUNT_TYPE_LABELS[account.type], currency: account.currency,
      columns: AMOUNT_COLUMNS[account.type], reasons,
      examples: [...example(fresh.find(line => line.bank.amount < 0)), ...example(fresh.find(line => line.bank.amount > 0))],
      rememberLabel: `Remember for files like this one going into “${account.name}”`,
      ...(kept && { correctedSince: `These amounts are shown reversed already, as you chose on ${displayDate(kept.lastImportAt.slice(0, 10))}. Reversing them again reads them as the file writes them.` })
    }
    const answer = await this.deps.prompts.show<SignsDialogResult, SignsDialogInput>(IMPORT_DIALOGS.signs, input, windowId !== undefined ? { windowId } : undefined)
    return answer && typeof answer.reverse === 'boolean' ? answer : undefined
  }

  /** Asks the statement's format to remember a reversal for its source. True if it has; false if it can't. */
  private async formatCorrects(origin: Origin, key: string): Promise<boolean> {
    const format = origin.format
    const service = format ? this.deps.formats.service(format) : undefined
    if (!format || typeof service?.correct !== 'function') return false
    try {
      return (await service.correct({ kind: 'signsReversed', key }, { memory: formatMemory(() => this.db(), format.id) })) === true
    } catch (err) {
      this.deps.log.warn(`[import] ${format.label} couldn't remember a correction: ${(err as Error)?.message ?? err}`)
      return false
    }
  }

  /**
   * An account made from a statement whose amounts turned out reversed: it opened at the balance the statement gave as
   * read. It opens at the reversed one instead, unless the user changed it in the New Account form.
   */
  private async reopen(account: Account, asRead: ParsedStatement, now: ParsedStatement): Promise<void> {
    const current = await this.deps.accounts.get(account.id)
    if (!current) return
    const was = accountFromStatement(asRead, current.currency, this.today()).openingBalance
    const should = accountFromStatement(now, current.currency, this.today()).openingBalance
    if (was === undefined || should === undefined || current.openingBalance !== was || was === should) return
    await this.deps.accounts.updateAccount(account.id, { openingBalance: should })
  }

  /** Keeps the source's sign record: the import manager's correction, and its profile with these lines added. */
  private async keepSigns(key: string, accountId: string, record: SignRecord | undefined, reverse: boolean, amounts: number[]): Promise<void> {
    const moving = amounts.filter(a => a !== 0)
    const profile = addToProfile(record, moving.filter(a => a < 0).length, moving.length)
    await this.signRecords.save(key, accountId, { reverse, ...profile })
      .catch(err => this.deps.log.warn(`[import] Could not keep what the statement's signs were like: ${(err as Error)?.message ?? err}`))
  }

  /**
   * Whether the new lines take the categories their file gives, for the statement's source. Nothing is asked when the
   * file gives none the ledger has. Otherwise the source's remembered answer applies, or the user is asked (Categories
   * from the File), with nothing chosen to begin with. Without asking (a non-interactive import), the file's
   * categories aren't used. Cancel Import in the dialog throws CANCELLED. Sets `drafts.categorySource`.
   */
  private async chooseCategories(drafts: Drafts, added: ConvertedLine[], statement: ParsedStatement, origin: Origin, account: Account,
    ask: { interactive: boolean, windowId?: number }): Promise<StatementCategories | undefined> {
    const offers = drafts.offers(added)
    if (offers.length === 0) return undefined
    const { key } = identityOf(statement, formatIdOf(origin), origin.source)
    const sourceLabel = statement.account.label ?? statement.account.name ?? origin.source
    const differing = offers.filter(o => o.usual !== undefined && o.usual !== o.file).length
    const examples = drafts.examples(offers)
    const about = { offered: offers.length, differing, key, sourceLabel, examples }

    const saved = await this.categoryChoices.get(key)
    if (saved) {
      drafts.categorySource = saved.source
      return { ...about, source: saved.source, decidedBy: 'remembered', remembered: true }
    }
    if (!ask.interactive) {
      drafts.categorySource = 'payee'
      return { ...about, source: 'payee', decidedBy: 'default', remembered: false }
    }
    const input: CategoriesDialogInput = { fileName: origin.source, sourceLabel, accountName: account.name, offered: offers.length, differing, examples }
    const answer = await this.deps.prompts.show<CategoriesDialogResult, CategoriesDialogInput>(IMPORT_DIALOGS.categories, input,
      ask.windowId !== undefined ? { windowId: ask.windowId } : undefined)
    if (!answer || (answer.source !== 'file' && answer.source !== 'payee')) {
      throw new ImportError('CANCELLED', 'The import was cancelled.')
    }
    if (answer.remember) await this.categoryChoices.save(key, answer.source, sourceLabel)
    drafts.categorySource = answer.source
    return { ...about, source: answer.source, decidedBy: 'asked', remembered: answer.remember === true }
  }

  /**
   * Changes, or forgets, a source's answer about its files' categories (the summary's Change…). Applies from the next
   * import; what was imported keeps its categories.
   */
  async changeCategoryChoice(key: string, source: CategorySource, label: string, remember: boolean): Promise<void> {
    const current = this.deps.session.current
    if (!current || current.readOnly) return
    if (remember) await this.categoryChoices.save(key, source, label)
    else await this.categoryChoices.forget(key)
  }

  /**
   * The statement's lines that look like lines imported before into the account from another file, each paired with one
   * of them (matching/duplicates.ts). The earlier lines are those whose transaction, dated near the statement's lines,
   * still carries them and isn't void (reconciled is fine: last month's import likely was), and isn't already waiting on
   * another line as its duplicate.
   */
  private async alreadyImported(account: Account, lines: ConvertedLine[], formatId: string): Promise<DuplicatePair[]> {
    if (lines.length === 0) return []
    const days = lines.map(line => dayNumber(line.bank.date))
    const iso = (n: number) => new Date(n * 86_400_000).toISOString().slice(0, 10)
    const window = lines.some(line => line.bank.number) ? Math.max(DUPLICATE_DAYS, DUPLICATE_CHEQUE_DAYS) : DUPLICATE_DAYS
    const listed = await this.deps.accounts.transactions(account.id).list({ from: iso(Math.min(...days) - window), to: iso(Math.max(...days) + window) })
    const carriers = new Map(listed.filter(t => t.externalId !== undefined && !t.voided).map(t => [t.id, t]))
    if (carriers.size === 0) return []
    const c = collectionsOf(this.db())
    const taken = new Set((await c.lines.find({ accountId: account.id, outcome: 'matched', review: 'pending' }))
      .filter(line => line.duplicateOf !== undefined).map(line => line.proposedId))
    const ids = [...carriers.keys()]
    const found: (StoredLine & { id: string })[] = []
    for (let i = 0; i < ids.length; i += 500) found.push(...await c.lines.find({ accountId: account.id, transactionId: { $in: ids.slice(i, i + 500) } }))
    const earlierLines = found.filter(line => line.outcome !== 'skipped' && line.transactionId !== undefined
      && carriers.get(line.transactionId)?.externalId === line.importId && !taken.has(line.transactionId))
    if (earlierLines.length === 0) return []
    const batches = new Map((await c.batches.getMany([...new Set(earlierLines.map(line => line.batchId))])).map(b => [b.id, b]))
    const earlier: EarlierLine[] = earlierLines
      .map(line => ({ line, importedAt: batches.get(line.batchId)?.importedAt ?? '' }))
      .sort((a, b) => a.importedAt.localeCompare(b.importedAt) || a.line.bank.date.localeCompare(b.line.bank.date))
      .map(({ line }) => {
        const formatOf = batches.get(line.batchId)?.formatId
        return {
          lineId: line.id, transactionId: line.transactionId!, importId: line.importId, bank: line.bank,
          ...(formatOf !== undefined && { formatId: formatOf })
        }
      })
    return findDuplicates(lines.map(line => ({ importId: line.importId, bank: line.bank })), formatId, earlier)
  }

  /**
   * The statement's lines that look like transactions already in the account, each paired with one transaction.
   * The candidates are read once, over the whole statement's window.
   */
  private async propose(account: Account, lines: ConvertedLine[], payees: PayeeSuggestion[], aliases: ReadonlyMap<string, string>, tuning: MatchTuning): Promise<Proposal[]> {
    const range = windowOf(lines.map(line => line.bank), tuning)
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
    return assign(lines.map(line => line.bank), targets, account.currency, aliases, tuning)
  }

  /**
   * The import ids among `ids` already in the account, or recorded as imported (so one the user deleted stays gone),
   * with what each named: the bank's version of the line when its record is kept, else the transaction carrying it.
   */
  private async importedBefore(accountId: string, ids: string[]): Promise<Map<string, Prior>> {
    const known = new Map<string, Prior>()
    const lines = collectionsOf(this.db()).lines
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500)
      for (const line of await lines.find({ accountId, importId: { $in: chunk } })) known.set(line.importId, { kind: 'line', bank: line.bank })
      for (const t of await this.deps.accounts.transactions(accountId).findByExternalIds(chunk)) {
        if (t.externalId && !known.has(t.externalId)) known.set(t.externalId, { kind: 'transaction', date: t.date, amount: t.amount })
      }
    }
    return known
  }
}
