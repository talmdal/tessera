// `exchange.service`: read a file, file its statements against accounts as “statements to read”, serve those
// statements to the register as provisional rows, accept them row by row, and take a whole statement's batch
// back out again. The pipeline is read → resolve → file, then per row match → accept, in the register itself.
import type { Database, Disposable, Doc, Event, Json, Logger, ShellFiles, ShellPrompts } from '@tessera/types'
import type { BookSession } from '@tessera/book-api'
import type { AccountsService, Category, OverlayRow, Transaction } from '@tessera/accounts-api'
import { accountNumberKey, categoryLabel, formatAmount, todayIso } from '@tessera/accounts-api'
import {
  CANDIDATE_LIMIT, CANDIDATE_WINDOW_DAYS, EXCHANGE_DIALOGS, EXCHANGE_OPTIONS_DEFAULTS, ExchangeError,
  MAX_DATE_WINDOW, QIF_DATE_ORDER_QUESTION, csvFingerprintOf, isDateWindow, payeeRuleProblem, type LinkPatch,
  type AcceptOptions, type AccountLink, type ExchangeChange, type ExchangeDocument, type ExchangeFormatDescriptor,
  type ExchangeOptions, type ExchangeQuestion, type ExchangeService, type ExchangeStatement, type ExportRequest,
  type ExportResult, type ExchangeConfirmation, type FileOptions, type FileResult, type HistoryEntry, type HistoryFilter, type ImportBatch, type MatchingCandidate,
  type MatchingDialogInput, type NewPayeeRule, type PayeeRule, type PayeeRuleDirectory, type PendingRow, type PendingStatement,
  type PendingSummary, type QuestionDialogInput, type RenameDialogInput, type RenamePreview, type RowEdit, type ReadOptions, type ReadResult, type UndoOptions, type UndoResult
} from '@tessera/exchange-api'
import { acceptNew, backOut, describeObstacles, mergeInto, reverse, undoObstacles } from './applying'
import { baseNameOf, hashOf, type ExchangeDisk } from './disk'
import { FormatRegistry } from './formats'
import type { ExportOptionsRegistry } from './exportOptions'
import { rankCandidates, type ExistingRow, type MatchOptions } from './matcher'
import { payeeOf, resolveRename, type RuleOutcome } from './rules'
import {
  dedupeRows, effectiveRows, noteFor, toOverlayRow, type EffectiveRow
} from './pending'
import {
  buildDraft, categoryIndex, checkCurrency, linkForSource, normalisePath, toExistingRow
} from './planning'
import type { ArchiveParticipant } from '@tessera/book-api'
import { exchangeArchiveParticipant } from './archiveParticipant'
import {
  Emitter, change, collectionsOf, invalid, notFound, toBatch, toLink, toPending, toRule, translate,
  type Collections, type StoredBatch, type StoredPending, type StoredRule
} from './store'

export interface ExchangeServiceDeps {
  session: BookSession
  accounts: AccountsService
  prompts: ShellPrompts
  files: ShellFiles
  disk: ExchangeDisk
  log: Pick<Logger, 'warn' | 'error'>
  formats: FormatRegistry
  /** What each format wants to be asked in the export dialog. Absent in tests that do not exercise it. */
  exportOptions?: ExportOptionsRegistry
  /** The plugin's options; the defaults until the options service hands over the real ones. */
  options?: () => ExchangeOptions
  today?: () => string
  now?: () => string
}

export class ExchangeServiceImpl implements ExchangeService {
  private readonly changes: Emitter<ExchangeChange>
  private readonly subscriptions: Disposable[] = []
  private warnedForeign = false
  /** One queue per account, so its statement-row writes run in turn. See `serial`. */
  private readonly rowQueues = new Map<string, Promise<unknown>>()

  readonly onDidChange: Event<ExchangeChange>

  constructor(private readonly deps: ExchangeServiceDeps) {
    this.changes = new Emitter(deps.log)
    this.onDidChange = this.changes.event
    this.subscriptions.push(deps.session.onDidChange(() => {
      this.changes.fire(change({}))
    }))
  }

  dispose() {
    for (const subscription of this.subscriptions.splice(0)) subscription.dispose()
  }

  private get today() { return this.deps.today ?? (() => todayIso()) }
  private get now() { return this.deps.now ?? (() => new Date().toISOString()) }
  private get settings() { return this.deps.options?.() ?? EXCHANGE_OPTIONS_DEFAULTS }

  private db(): Database {
    try {
      return this.deps.session.database('exchange')
    } catch (err) { throw translate(err) }
  }

  /** What archiving asks of the exchange data: import batches whose undo window went with their transactions. */
  readonly archiveParticipant: ArchiveParticipant = exchangeArchiveParticipant({ collections: () => this.c() })

  private c(): Collections {
    return collectionsOf(this.db())
  }

  private async read_<T>(work: (c: Collections) => Promise<T>): Promise<T> {
    try { return await work(this.c()) } catch (err) { throw translate(err) }
  }

  private async write<T>(work: (c: Collections) => Promise<T>, announce: (result: T) => Partial<ExchangeChange>): Promise<T> {
    let result: T
    try {
      result = await this.db().transaction(tx => work(collectionsOf(tx)))
    } catch (err) { throw translate(err) }
    this.changes.fire(change(announce(result)))
    return result
  }

  // ---- Formats

  formats(): ExchangeFormatDescriptor[] {
    return this.deps.formats.all()
  }

  // ---- Reading

  async read(path?: string, options: ReadOptions = {}): Promise<ReadResult> {
    const chosen = await this.pathFor(path)
    const data = await this.deps.disk.read(chosen).catch(() => {
      throw new ExchangeError('UNREADABLE', 'That file could not be opened.')
    })
    const descriptor = this.deps.formats.choose(baseNameOf(chosen), data, options.formatId)
    const format = this.deps.formats.implementation(descriptor)
    if (format.read === undefined || !descriptor.capabilities.read) {
      throw new ExchangeError('UNKNOWN_FORMAT', `${descriptor.label} files can be written but not read.`, 'formatId')
    }

    // What the options settle is answered before any reader can ask; the caller's answers win over them
    const answers: Record<string, Json> = {
      ...(this.settings.qif?.dateOrder !== undefined && this.settings.qif.dateOrder !== 'auto' && { [QIF_DATE_ORDER_QUESTION]: this.settings.qif.dateOrder }),
      ...options.answers
    }
    let document: ExchangeDocument
    try {
      document = await format.read(data, {
        fileName: baseNameOf(chosen),
        formatId: descriptor.id,
        answers,
        request: question => this.answer(question, answers, descriptor.id),
        log: this.deps.log
      })
    } catch (err) {
      if (err instanceof ExchangeError || (err as { name?: string })?.name === 'ExchangeError') throw err
      throw new ExchangeError('UNREADABLE', `This ${descriptor.label} file could not be read: ${(err as Error)?.message ?? 'it is malformed'}.`)
    }

    const rows = document.statements.reduce((n, s) => n + s.transactions.length, 0)
    const { maxRows } = this.settings.import
    if (rows > maxRows) {
      throw new ExchangeError('TOO_LARGE', `This file holds ${rows.toLocaleString()} transactions, more than the limit of ${maxRows.toLocaleString()}.`)
    }
    if (rows === 0) throw new ExchangeError('EMPTY', 'This file holds no transactions.')

    return {
      path: chosen,
      fileName: baseNameOf(chosen),
      fileHash: hashOf(data),
      document: { ...document, formatId: document.formatId || descriptor.id }
    }
  }

  /** The path given, or one the user chooses, with a filter per readable format. */
  private async pathFor(path: string | undefined): Promise<string> {
    if (typeof path === 'string' && path.trim() !== '') return path
    const readable = this.deps.formats.readable()
    if (readable.length === 0) {
      throw new ExchangeError('UNKNOWN_FORMAT', 'No file formats are installed, so there is nothing to import.')
    }
    const folder = this.settings.import.defaultFolder
    const chosen = await this.deps.files.showOpenDialog({
      title: 'Import Transactions',
      buttonLabel: 'Import',
      defaultPath: folder === '' ? this.deps.files.documentsPath() : folder,
      filters: [
        { name: 'All supported files', extensions: [...new Set(readable.flatMap(f => f.extensions))] },
        ...readable.map(f => ({ name: f.label, extensions: f.extensions }))
      ]
    })
    if (chosen === undefined) throw new ExchangeError('INVALID', 'No file was chosen.', 'path')
    return chosen
  }

  /**
   * An answer a reader asked for: one already given, else one the book saved against this file shape, else the
   * user's — which is then saved, so that the same shape is never asked about twice.
   *
   * A `csvProfile` question carries its fingerprint in its id, which is what lets the profile store be
   * consulted here without this method having to parse the file. See `csvProfileQuestionId`.
   */
  private async answer(question: ExchangeQuestion, answers: Record<string, Json>, formatId: string): Promise<Json> {
    if (answers[question.id] !== undefined) return answers[question.id]

    const fingerprint = csvFingerprintOf(question.id)
    if (fingerprint !== undefined) {
      const saved = await this.read_(async c => (await c.profiles.find({ formatId, fingerprint }))[0])
      const remembered = saved?.answers.find(entry => entry.questionId === question.id)
      if (remembered !== undefined) {
        answers[question.id] = remembered.value
        return remembered.value
      }
    }

    const given = await this.askFor(question)
    answers[question.id] = given

    if (fingerprint !== undefined) {
      // Saved after the fact rather than before, so a cancelled or failed read leaves nothing behind.
      await this.write(
        c => c.profiles.insert({
          formatId,
          fingerprint,
          name: nameOfProfile(given, question),
          answers: [{ questionId: question.id, value: given }]
        }),
        () => ({ profiles: true })
      ).catch(err => {
        // The read itself has already succeeded, so this is not worth failing: the cost is being asked again.
        this.deps.log.warn(`[exchange] A format profile could not be saved: ${String(err)}`)
      })
    }
    return given
  }

  /** The dialog for a question: the CSV mapping grid for a column mapping, the plain one for anything else. */
  private async askFor(question: ExchangeQuestion): Promise<Json> {
    const dialog = question.kind === 'csvProfile' ? EXCHANGE_DIALOGS.csvProfile : EXCHANGE_DIALOGS.question
    const given = await this.deps.prompts.show<Json, QuestionDialogInput>(dialog, { question }, { title: question.title })
    if (given === undefined) throw new ExchangeError('INVALID', `${question.title} was not answered.`, question.id)
    return given
  }

  // ---- Filing a statement to read

  async file(statement: ExchangeStatement, accountId: string, options: FileOptions): Promise<FileResult> {
    const account = await this.deps.accounts.get(accountId)
    if (account === undefined) throw notFound('That account no longer exists.')
    checkCurrency(statement, account)
    const archivedRows = statement.transactions.filter(row => row.date < account.openingDate)
    const whollyArchived = statement.period?.to !== undefined
      ? statement.period.to < account.openingDate
      : archivedRows.length === statement.transactions.length && archivedRows.length > 0
    if (whollyArchived && options.archivedOverride !== true) {
      const firstDate = statement.transactions.reduce((first, row) => row.date < first ? row.date : first, statement.transactions[0].date)
      const lastDate = statement.transactions.reduce((last, row) => row.date > last ? row.date : last, statement.transactions[0].date)
      const from = statement.period?.from ?? firstDate
      const to = statement.period?.to ?? lastDate
      throw new ExchangeError('ARCHIVED_PERIOD',
        `“${options.source.fileName}” covers ${from}–${to}, before “${account.name}”’s opening date of ${account.openingDate}. Its transactions may already be included in the opening balance.`)
    }

    // Re-reading a file still waiting is caught whole, before any row-level checks
    const waiting = await this.pendingFor(accountId)
    if (waiting.some(p => p.fileHash === options.source.fileHash)) {
      throw new ExchangeError('INVALID', `“${options.source.fileName}” is already waiting to be read in “${account.name}”.`)
    }
    // And a file already read *through* — nothing of it waiting, but its batch in the history — unless the
    // caller has said to go ahead anyway. A bank re-issuing an identical file after a correction is a real
    // thing, so this is a question rather than a refusal; `ALREADY_IMPORTED` is what the caller asks about.
    if (options.force !== true) {
      const earlier = await this.importedBefore(options.source.fileHash, accountId)
      if (earlier !== undefined) {
        throw new ExchangeError('ALREADY_IMPORTED',
          `“${options.source.fileName}” was imported into “${account.name}” on ${earlier.importedAt.slice(0, 10)}`
          + `${earlier.counts.imported > 0 ? `, adding ${earlier.counts.imported} transaction${earlier.counts.imported === 1 ? '' : 's'}` : ''}.`)
      }
    }

    // A row whose bank reference the account — or an earlier statement — already holds is already here
    const register = await this.deps.accounts.transactions(accountId).register()
    const known = new Set<string>()
    for (const row of register.rows) {
      if (row.transaction.externalId !== undefined) known.add(row.transaction.externalId)
    }
    for (const pending of waiting) {
      for (const row of pending.rows) {
        if (row.transaction.externalId !== undefined) known.add(row.transaction.externalId)
      }
    }
    const { kept, duplicates } = dedupeRows(statement.transactions, known)

    if (options.remember === true) await this.rememberLink(statement, options.source.formatId, accountId)
    if (kept.length === 0) return { filed: 0, duplicates }

    const rows: PendingRow[] = kept.map((transaction, at) => ({
      key: `r${at}`, transaction,
      ...(transaction.date < account.openingDate && { archivedPeriod: true })
    }))
    const stored = await this.write(async c => {
      const doc = await c.pending.insert({
        accountId,
        readAt: this.now(),
        formatId: options.source.formatId,
        ...(options.source.dialect !== undefined && { dialect: options.source.dialect }),
        fileName: options.source.fileName,
        fileHash: options.source.fileHash,
        source: {
          ...(statement.account.number !== undefined && { number: statement.account.number }),
          ...(statement.account.bankId !== undefined && { bankId: statement.account.bankId }),
          ...(statement.account.name !== undefined && { name: statement.account.name })
        },
        ...(statement.period !== undefined && { period: statement.period }),
        ...(statement.balances?.ledger !== undefined && { ledger: statement.balances.ledger }),
        ...(options.truncatedAt !== undefined && { truncatedAt: options.truncatedAt }),
        ...(options.accountMap !== undefined && Object.keys(options.accountMap).length > 0 && { accountMap: options.accountMap }),
        ...(createdBy(options) !== undefined && { created: createdBy(options)! }),
        rows
      })
      return toPending(doc)
    }, () => ({ pending: [accountId] }))

    return { statement: stored, filed: rows.length, duplicates }
  }

  /**
   * Remembers which account this source belongs to, keyed by format, bank and account number. A link that cannot
   * be written is not worth failing an import over: the user would simply be asked again next month.
   */
  private async rememberLink(statement: ExchangeStatement, formatId: string, accountId: string) {
    const numberKey = accountNumberKey(statement.account.number ?? '')
    if (numberKey === '') return
    const bankId = statement.account.bankId
    const fields = {
      formatId,
      numberKey,
      accountId,
      label: statement.account.name ?? numberKey,
      lastImportedAt: this.now(),
      ...(bankId !== undefined && { bankId })
    }
    try {
      await this.write(async c => {
        const existing = await c.links.findOne({ formatId, numberKey, ...(bankId !== undefined && { bankId }) })
        if (existing === undefined) await c.links.insert(fields)
        else await c.links.replace({ ...existing, ...fields })
      }, () => ({ links: true }))
    } catch (err) {
      this.deps.log.warn(`[exchange] Could not remember the account for “${fields.label}”: ${String(err)}`)
    }
  }

  /**
   * The categories a file carried that the book lacks, created so the rows filed from it resolve to them. A path
   * the book cannot represent is skipped rather than failing the import; the rows keep no category.
   */
  async ensureCategories(document: Pick<ExchangeDocument, 'categories'>): Promise<string[]> {
    const wanted = document.categories ?? []
    if (wanted.length === 0 || !this.settings.import.createCategories) return []
    const created: string[] = []
    const known = categoryIndex(await this.deps.accounts.categories.list())
    for (const { path, kind } of wanted) {
      if (known.has(normalisePath(path))) continue
      try {
        const category = await this.deps.accounts.categories.create(path, kind)
        created.push(category.id)
        known.set(normalisePath(path), category.id)
      } catch (err) {
        this.deps.log.warn(`[exchange] Could not create the category “${path}”: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    return created
  }

  // ---- Statements to read

  async pendingFor(accountId: string): Promise<PendingStatement[]> {
    return this.read_(async c =>
      this.wellFormed(await c.pending.find({ accountId }, { sort: { readAt: 1 } })))
  }

  private async allPending(): Promise<PendingStatement[]> {
    return this.read_(async c => this.wellFormed(await c.pending.find(undefined, { sort: { readAt: 1 } })))
  }

  /**
   * Only documents in the shape this build writes. A book can carry documents another build left in the same
   * collection; those are the migration's to convert, and must never stop this one from opening the book.
   */
  private wellFormed(docs: Parameters<typeof toPending>[0][]): PendingStatement[] {
    const kept: PendingStatement[] = []
    let skipped = 0
    for (const doc of docs) {
      if (Array.isArray(doc.rows) && typeof doc.accountId === 'string') kept.push(toPending(doc))
      else skipped++
    }
    if (skipped > 0 && !this.warnedForeign) {
      this.warnedForeign = true
      this.deps.log.warn(`[exchange] ${skipped} document${skipped === 1 ? '' : 's'} in exchange.pending ${skipped === 1 ? 'is' : 'are'} not in a shape this version understands and ${skipped === 1 ? 'was' : 'were'} ignored.`)
    }
    return kept
  }

  /** Every account with rows waiting, plus every account a source is linked to — the Statements to Read lines. */
  async pendingSummary(): Promise<PendingSummary[]> {
    const [pending, links, accounts] = await Promise.all([
      this.allPending(), this.links(), this.deps.accounts.list({ includeClosed: true })
    ])
    const byAccount = new Map<string, PendingStatement[]>()
    for (const statement of pending) {
      const list = byAccount.get(statement.accountId) ?? []
      list.push(statement)
      byAccount.set(statement.accountId, list)
    }

    const ids = [...new Set([...byAccount.keys(), ...links.map(l => l.accountId)])]
    const lines: PendingSummary[] = []
    for (const id of ids) {
      const account = accounts.find(a => a.id === id)
      if (account === undefined) continue
      const statements = byAccount.get(id) ?? []
      const newest = statements[statements.length - 1]
      const withLedger = [...statements].reverse().find(s => s.ledger !== undefined)
      const balances = await this.deps.accounts.balances(id)
      lines.push({
        accountId: id,
        accountName: account.name,
        currency: account.currency,
        items: statements.reduce((n, s) => n + s.rows.length, 0),
        ...(statements.some(s => s.rows.some(row => row.transaction.date < account.openingDate)) && {
          archivedItems: statements.reduce((n, s) => n + s.rows.filter(row => row.transaction.date < account.openingDate).length, 0)
        }),
        ...(newest !== undefined && { lastReadAt: newest.readAt }),
        ...(withLedger?.ledger !== undefined && { bankBalance: withLedger.ledger.amount }),
        localBalance: balances.current
      })
    }
    return lines.sort((a, b) => b.items - a.items || a.accountName.localeCompare(b.accountName))
  }

  /** How many rows are waiting across the book, for the context key and the navigator badge. */
  async pendingCount(): Promise<number> {
    const pending = await this.allPending()
    return pending.reduce((n, s) => n + s.rows.length, 0)
  }

  // ---- The register's provisional rows

  /**
   * How many days either side this statement's rows may sit from a register transaction and still match: the
   * source's own window when its link has one, else the option. Per source because posting lag is a property of
   * the bank — one card issuer posts the next day, another a week later — and a single window is either too
   * tight for the slow one or loose enough to pair unrelated rows from the fast one.
   *
   * The link only counts when it points at the account the statement was filed in: a statement filed by hand
   * into some other account is not that source's statement as far as its quirks are concerned.
   */
  private dateWindowFor(
    statement: Pick<PendingStatement, 'formatId' | 'source' | 'accountId'>,
    links: readonly AccountLink[]
  ): number {
    const link = linkForSource(links, statement.formatId, statement.source)
    return link !== undefined && link.accountId === statement.accountId && link.dateWindow !== undefined
      ? link.dateWindow
      : this.settings.import.dateWindow
  }

  private matchOptions(
    statement: Pick<PendingStatement, 'truncatedAt' | 'formatId' | 'source' | 'accountId'>,
    links: readonly AccountLink[]
  ): MatchOptions {
    return {
      dateWindow: this.dateWindowFor(statement, links),
      mergeManualEntries: this.settings.import.mergeManualEntries,
      // Rows without a reference simply skip tier 1, so this is safe for every format
      transactionIds: true,
      // A standard QIF cuts payees at fifteen characters: compare them by prefix
      ...(statement?.truncatedAt !== undefined && { truncatedAt: statement.truncatedAt })
    }
  }

  /** Everything matching an account's pending rows needs, loaded once. */
  private async matchingState(accountId: string) {
    const account = await this.deps.accounts.get(accountId)
    if (account === undefined) throw notFound('That account no longer exists.')
    const statements = await this.pendingFor(accountId)
    const register = await this.deps.accounts.transactions(accountId).register()
    const existing = register.rows.map(toExistingRow)
    const existingById = new Map(existing.map(row => [row.id, row]))
    const categories = await this.deps.accounts.categories.list()
    const accountsByName = new Map(
      (await this.deps.accounts.list({ includeClosed: true })).map(a => [a.name.trim().toLowerCase(), a.id]))
    // The payee rules are resolved here, before `effectiveRows` matches anything, so a renamed payee is what
    // the matcher compares — which is the point of having rules at all.
    const renameOf = await this.renamer(accountId)
    const links = await this.links()
    for (const statement of statements) {
      for (const row of statement.rows) {
        if (row.transaction.date < account.openingDate) row.archivedPeriod = true
        else delete row.archivedPeriod
      }
    }
    const entries = effectiveRows(statements, existing, statement => this.matchOptions(statement, links), renameOf)
    return { account, statements, existing, existingById, categories, accountsByName, entries, links, renameOf }
  }

  /**
   * How each pending row's payee and category are resolved for one account: the user's own choices, else the
   * book's rules, else the file. One function for every caller that matches, so a preview and the real thing
   * cannot resolve the same row differently.
   */
  private async renamer(accountId: string): Promise<(row: PendingRow) => RuleOutcome> {
    const rules = await this.payeeRules.list()
    const applyRules = this.settings.import.applyRules
    return row => resolveRename(row.transaction, accountId, {
      rules,
      applyRules,
      ...(row.userPayee !== undefined && { userPayee: row.userPayee }),
      ...(row.userCategoryId !== undefined && { userCategoryId: row.userCategoryId })
    })
  }

  /** The book's accounts by name, plus the file's own names as the user mapped them, for a statement's transfers. */
  private accountsFor(statement: Pick<PendingStatement, 'accountMap'> | undefined, accountsByName: Map<string, string>): Map<string, string> {
    if (statement?.accountMap === undefined) return accountsByName
    const merged = new Map(accountsByName)
    for (const [name, id] of Object.entries(statement.accountMap)) merged.set(name.trim().toLowerCase(), id)
    return merged
  }

  /** The statement rows waiting in one register, as the register's overlay draws them. */
  async overlayRows(accountId: string): Promise<OverlayRow[]> {
    const statements = await this.pendingFor(accountId)
    if (statements.length === 0) return []
    const { account, existingById, categories, accountsByName, entries } = await this.matchingState(accountId)
    const byId = new Map(statements.map(s => [s.id, s]))
    return entries.map(entry => {
      const draft = buildDraft(entry.row.transaction, account, {
        renamed: entry.rename,
        categories: categoryIndex(categories), accountsByName: this.accountsFor(byId.get(entry.statementId), accountsByName)
      })
      const label = draft.categoryId === undefined ? undefined : categoryLabel(categories, draft.categoryId)
      return toOverlayRow(entry, draft.payee, label, existingById)
    }).sort((a, b) => a.date.localeCompare(b.date) || a.key.localeCompare(b.key))
  }

  private entryFor(entries: EffectiveRow[], statementId: string, rowKey: string): EffectiveRow {
    const entry = entries.find(e => e.statementId === statementId && e.row.key === rowKey)
    if (entry === undefined) throw notFound('That statement line is no longer waiting to be read.')
    return entry
  }

  // ---- Accepting a row

  /**
   * Accepts one pending row: a matched row merges into its register transaction, an unmatched one is written as
   * a new transaction, and a row whose reference turned up in the register since it was filed is simply let go.
   * Whatever was written is recorded on the statement's batch, so Undo Import can take the statement back out.
   */
  /**
   * Runs one account's statement-row writes one after another. Each reads the pending rows, writes through
   * `accounts.service` — which cannot join this plugin's storage transaction — and then records what it wrote,
   * so two interleaved runs could both act on the same row: a double-click on Accept wrote the row twice. Run
   * in turn, the second finds the row already gone and refuses.
   */
  private serial<T>(accountId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.rowQueues.get(accountId) ?? Promise.resolve()
    const run = previous.then(work, work)
    const settled = run.then(() => undefined, () => undefined)
    this.rowQueues.set(accountId, settled)
    void settled.then(() => { if (this.rowQueues.get(accountId) === settled) this.rowQueues.delete(accountId) })
    return run
  }

  accept(accountId: string, statementId: string, rowKey: string, options: AcceptOptions = {}): Promise<void> {
    return this.serial(accountId, () => this.acceptNow(accountId, statementId, rowKey, options))
  }

  private async acceptNow(accountId: string, statementId: string, rowKey: string, options: AcceptOptions): Promise<void> {
    const { account, statements, categories, accountsByName, entries, existingById } = await this.matchingState(accountId)
    const statement = statements.find(s => s.id === statementId)
    if (statement === undefined) throw notFound('That statement is no longer waiting to be read.')
    const entry = this.entryFor(entries, statementId, rowKey)

    const draft = buildDraft(entry.row.transaction, account, {
      renamed: entry.rename,
      categories: categoryIndex(categories), accountsByName: this.accountsFor(statement, accountsByName)
    })

    if (entry.disposition !== 'duplicate') {
      const reasons: ExchangeConfirmation[] = []
      const details: string[] = []
      if (entry.row.transaction.date < account.openingDate && !(options.confirm ?? []).includes('archivedPeriod')) {
        reasons.push('archivedPeriod')
        details.push(`Import ${formatAmount(entry.row.transaction.amount, account.currency)} dated ${entry.row.transaction.date} into “${account.name}”? It is before the account’s opening date of ${account.openingDate}; accepting it changes the balance, and Tessera can’t tell whether it is already in the archive.`)
      }
      if (entry.matchedId !== undefined && existingById.get(entry.matchedId)?.status === 'reconciled' &&
        !(options.confirm ?? []).includes('reconciled')) {
        reasons.push('reconciled')
        details.push('This line matches a transaction that is already reconciled. Accepting it will change that transaction.')
      }
      if (reasons.length > 0) {
        throw new ExchangeError('CONFIRMATION_REQUIRED', details.join('\n\n'), undefined, reasons)
      }
    }

    let createdId: string | undefined
    let merged: Awaited<ReturnType<typeof mergeInto>> | undefined
    if (entry.disposition === 'duplicate') {
      // Already in the register: accepting only acknowledges it
    } else if (entry.matchedId !== undefined) {
      try {
        merged = await mergeInto(entry.matchedId, entry.row.transaction, draft, accountId, {
          accounts: this.deps.accounts,
          adoptBankDetail: this.settings.import.adoptBankDetail,
          payeeOf: id => existingById.get(id)?.payeeName
        })
      } catch (err) { throw translate(err) }
    } else {
      try {
        createdId = await acceptNew(draft, accountId, this.deps.accounts)
      } catch (err) { throw translate(err) }
    }

    let closed: boolean
    try {
      closed = await this.recordAcceptance(statement, entry, accountId, createdId, merged)
    } catch (err) {
      // The write went through but could not be recorded. Left in place, it is a transaction no batch knows
      // about — Undo Import cannot reach it, and the row is still waiting, so accepting again writes it twice.
      // Take it back out, then report the failure.
      const at = this.now()
      await reverse({
        id: 'unrecorded',
        created: createdId === undefined ? [] : [{ accountId, rows: [{ id: createdId, at }] }],
        merged: merged === undefined ? [] : [{ ...merged, at }]
      }, { accounts: this.deps.accounts }).catch(undoErr => {
        this.deps.log.error('[exchange] An accepted row could not be recorded, nor taken back out', undoErr)
      })
      throw err
    }
    // Trimmed when a batch closes rather than on every accepted row: one statement adds one batch, so this is
    // the moment the history actually grows, and a fifty-row statement does not trim fifty times.
    if (closed) await this.trimHistory()
  }

  /**
   * A batch for this file already in the book's history, or undefined. Undone batches do not count: taking an
   * import back out is exactly how a user says they want to do it again.
   */
  private async importedBefore(fileHash: string, accountId: string): Promise<ImportBatch | undefined> {
    return this.read_(async c => {
      const found = await c.batches.find({ fileHash }, { sort: { importedAt: -1 } })
      return found.map(toBatch).find(batch =>
        batch.undoneAt === undefined && batch.accountIds.includes(accountId))
    })
  }

  /**
   * Puts statement rows aside without importing them: one row by `rowKey`, or everything still waiting in the
   * statement when none is given.
   *
   * The rows are **counted, not forgotten**. A statement imported with twelve rows left behind is a different
   * event from one imported whole, and the history should be able to say which — so a dismissal records
   * `counts.skipped` on the statement's batch, opening one when nothing had been accepted yet. A file the user
   * read and took nothing from is still something that happened to the book, and recording it is also what
   * lets a later re-import of the same file be recognised.
   */
  /**
   * The batch a statement's next row goes into: the one it points at, if that is still there and not undone,
   * else a new, empty one for it. One place for this rule, because accepting and skipping both need it and two
   * copies had already drifted apart — one of them silently dropped the record when the batch was missing.
   * Returns the batch to write and whether it must be inserted rather than replaced.
   */
  private async batchFor(
    c: Collections, statement: Doc<StoredPending>, accountId: string, at: string
  ): Promise<{ batch: StoredBatch & { id?: string, rev?: number }, isNew: boolean }> {
    const found = statement.batchId === undefined ? undefined : await c.batches.get(statement.batchId)
    // An undone batch takes no more rows: they would be hidden in a batch the history no longer lists, and could
    // never be undone again.
    if (found !== undefined && found.undoneAt === undefined) return { batch: found, isNew: false }
    return {
      isNew: true,
      batch: {
        importedAt: at,
        lastAcceptedAt: at,
        formatId: statement.formatId,
        ...(statement.dialect !== undefined && { dialect: statement.dialect }),
        fileName: statement.fileName,
        fileHash: statement.fileHash,
        accountIds: [accountId],
        created: [],
        merged: [],
        createdAccounts: statement.created?.accounts ?? [],
        createdCategories: statement.created?.categories ?? [],
        counts: { read: statement.rows.length, imported: 0, merged: 0, duplicates: 0, skipped: 0, unsupported: 0 },
        manualMatches: 0
      }
    }
  }

  /** Writes a batch `batchFor` produced, inserting a new one or replacing the one it found. Resolves its id. */
  private async saveBatch(c: Collections, batch: StoredBatch & { id?: string, rev?: number }, isNew: boolean): Promise<string> {
    if (isNew) return (await c.batches.insert(batch)).id
    await c.batches.replace(batch as Doc<StoredBatch>)
    return batch.id!
  }

  dismiss(accountId: string, statementId: string, rowKey?: string): Promise<number> {
    return this.serial(accountId, () => this.dismissNow(accountId, statementId, rowKey))
  }

  private async dismissNow(accountId: string, statementId: string, rowKey?: string): Promise<number> {
    let dismissed = 0
    await this.write(async c => {
      const current = await c.pending.get(statementId)
      if (current === undefined || current.accountId !== accountId) {
        throw notFound('That statement is no longer waiting to be read.')
      }
      if (rowKey !== undefined && !current.rows.some(row => row.key === rowKey)) {
        throw notFound('That statement line is no longer waiting to be read.')
      }

      const kept = rowKey === undefined ? [] : current.rows.filter(row => row.key !== rowKey)
      dismissed = current.rows.length - kept.length
      if (dismissed === 0) return []

      const at = this.now()
      const { batch, isNew } = await this.batchFor(c, current, accountId, at)
      const batchId = await this.saveBatch(c, {
        ...batch, counts: { ...batch.counts, skipped: batch.counts.skipped + dismissed }
      }, isNew)

      if (kept.length === 0) {
        await c.pending.deleteOne({ id: statementId })
        await c.batches.updateOne({ id: batchId }, { $set: { closedAt: at } })
      } else {
        await c.pending.replace({ ...current, rows: kept, batchId })
      }
      return [batchId]
    }, batches => ({ pending: [accountId], batches }))

    if (dismissed > 0) await this.trimHistory()
    return dismissed
  }

  /**
   * Removes the accepted row from its statement and appends what it wrote to the statement's batch. Resolves
   * true when that was the statement's last row, so the batch is now closed.
   */
  private async recordAcceptance(
    statement: PendingStatement,
    entry: EffectiveRow,
    accountId: string,
    createdId: string | undefined,
    merged: Awaited<ReturnType<typeof mergeInto>> | undefined
  ): Promise<boolean> {
    let closed = false
    await this.write(async c => {
      const current = await c.pending.get(statement.id)
      // The row has to still be waiting: if it is not, something else accepted or skipped it since this accept
      // read it, and what was just written would be recorded nowhere. `accept` rolls that write back.
      if (current === undefined || !current.rows.some(row => row.key === entry.row.key)) {
        throw notFound('That statement line was dealt with while it was being accepted.')
      }

      // The batch, created with the first accepted row and grown with each one after. It stays open until the
      // statement has no rows left, so undoing it takes back the whole statement however many sittings it took.
      // A batch that has gone — trimmed, or the statement's pointer stale — is opened afresh rather than the
      // acceptance being dropped, which would leave a written row no undo can reach.
      const manual = entry.matchedBy === 'user' ? 1 : 0
      const at = this.now()
      const { batch, isNew } = await this.batchFor(c, current, accountId, at)

      const created = batch.created.map(group => ({ ...group, rows: [...group.rows] }))
      if (createdId !== undefined) {
        const group = created.find(g => g.accountId === accountId)
        if (group === undefined) created.push({ accountId, rows: [{ id: createdId, at }] })
        else group.rows.push({ id: createdId, at })
      }
      const batchId = await this.saveBatch(c, {
        ...batch,
        // `importedAt` is when the batch began and is never rewritten. Each row carries its own time, so
        // "edited since the import" is asked of the row rather than of the batch.
        lastAcceptedAt: at,
        created,
        merged: merged === undefined ? batch.merged : [...batch.merged, { ...merged, at }],
        counts: {
          ...batch.counts,
          imported: batch.counts.imported + (createdId === undefined ? 0 : 1),
          merged: batch.counts.merged + (merged === undefined ? 0 : 1),
          duplicates: batch.counts.duplicates + (createdId === undefined && merged === undefined ? 1 : 0)
        },
        manualMatches: batch.manualMatches + manual
      }, isNew)

      const rows = current.rows.filter(row => row.key !== entry.row.key)
      if (rows.length === 0) {
        // The statement is read through: nothing more can join this batch, so it is closed.
        await c.pending.deleteOne({ id: statement.id })
        await c.batches.updateOne({ id: batchId }, { $set: { closedAt: at } })
        closed = true
      } else {
        await c.pending.replace({ ...current, rows, batchId })
      }
      return batchId
    }, batchId => ({
      pending: [accountId],
      accounts: createdId !== undefined || merged !== undefined ? [accountId] : [],
      batches: batchId === undefined ? [] : [batchId]
    }))
    return closed
  }

  // ---- Matching by hand

  /** The user's answer from Change Transaction Matching. It wins over the matcher until the row is accepted. */
  async setMatch(accountId: string, statementId: string, rowKey: string, matchTo: string | null): Promise<void> {
    if (matchTo !== null) {
      const target = await this.deps.accounts.transactions(accountId).get(matchTo)
      if (target === undefined) throw notFound('That transaction is no longer in the register.')
    }
    await this.write(async c => {
      const current = await c.pending.get(statementId)
      if (current === undefined || current.accountId !== accountId) {
        throw notFound('That statement is no longer waiting to be read.')
      }
      const rows = current.rows.map(row => row.key === rowKey ? { ...row, userMatch: matchTo } : row)
      if (!current.rows.some(row => row.key === rowKey)) {
        throw notFound('That statement line is no longer waiting to be read.')
      }
      await c.pending.replace({ ...current, rows })
    }, () => ({ pending: [accountId] }))
  }

  /**
   * The user's own payee and category for one row, from Edit Statement Line, winning over every rule. Each is
   * `null` to clear it and let the rules — and the file — decide again, and absent to leave it as it is.
   *
   * Renaming can change what the row matches, because the rename happens before matching — which is the point,
   * and is why the dialog shows `previewRename` before saving rather than letting the disposition change
   * behind the user.
   */
  async editRow(accountId: string, statementId: string, rowKey: string, edit: RowEdit): Promise<void> {
    const payee = edit.payee === undefined || edit.payee === null ? edit.payee : edit.payee.trim()
    if (payee === '') throw invalid('payee', 'Give the payee a name, or clear the rename.')

    await this.write(async c => {
      const current = await c.pending.get(statementId)
      if (current === undefined || current.accountId !== accountId) {
        throw notFound('That statement is no longer waiting to be read.')
      }
      if (!current.rows.some(row => row.key === rowKey)) {
        throw notFound('That statement line is no longer waiting to be read.')
      }
      const rows = current.rows.map(row => {
        if (row.key !== rowKey) return row
        const { userPayee, userCategoryId, ...rest } = row
        return {
          ...rest,
          ...(payee === undefined ? (userPayee !== undefined && { userPayee }) : payee !== null && { userPayee: payee }),
          ...(edit.categoryId === undefined
            ? (userCategoryId !== undefined && { userCategoryId })
            : edit.categoryId !== null && { userCategoryId: edit.categoryId })
        }
      })
      await c.pending.replace({ ...current, rows })
    }, () => ({ pending: [accountId] }))
  }

  /**
   * What one row would become under a proposed payee, without saving anything: the name, and the match it
   * would then have. The rename dialog shows this so that a row jumping from “New” to “Matches 3 Nov” is
   * something the user reads before agreeing to, not something they discover afterwards.
   */
  async previewRename(
    accountId: string, statementId: string, rowKey: string, payee: string | null
  ): Promise<RenamePreview> {
    const { statements, existing, existingById, links, renameOf } = await this.matchingState(accountId)
    const statement = statements.find(s => s.id === statementId)
    if (statement === undefined) throw notFound('That statement is no longer waiting to be read.')
    if (!statement.rows.some(row => row.key === rowKey)) {
      throw notFound('That statement line is no longer waiting to be read.')
    }

    const wanted = payee === null ? null : payee.trim()
    // The whole account is re-matched, not just this row: renaming a row can take a transaction another row
    // was going to claim, and the user should be shown the match they will actually get.
    const proposed = statements.map(s => s.id !== statementId ? s : {
      ...s,
      rows: s.rows.map(row => {
        if (row.key !== rowKey) return row
        const { userPayee: _removed, ...rest } = row
        return wanted === null ? rest : { ...rest, userPayee: wanted }
      })
    })
    const entries = effectiveRows(proposed, existing, s => this.matchOptions(s, links), renameOf)

    const entry = this.entryFor(entries, statementId, rowKey)
    const matched = entry.matchedId === undefined ? undefined : existingById.get(entry.matchedId)
    return {
      payee: payeeOf(entry.rename, entry.row.transaction),
      disposition: entry.disposition,
      note: noteFor(entry, existingById),
      ...(entry.matchedId !== undefined && { matchedId: entry.matchedId }),
      ...(matched !== undefined && {
        matches: {
          date: matched.date,
          amount: matched.amount,
          ...(matched.payeeName !== undefined && { payee: matched.payeeName })
        }
      })
    }
  }

  /** What Edit Statement Line opens showing: the bank's own text, the name and category, and the row's match. */
  async renameInput(accountId: string, statementId: string, rowKey: string): Promise<RenameDialogInput> {
    const { account, entries, existingById, categories } = await this.matchingState(accountId)
    const entry = this.entryFor(entries, statementId, rowKey)
    const t = entry.row.transaction
    const matched = entry.matchedId === undefined ? undefined : existingById.get(entry.matchedId)
    // What anything has chosen so far: the user's own pick, else a rule's, else the path the file named.
    const category = entry.rename.categoryId
      ?? (t.category === undefined ? undefined : categoryIndex(categories).get(normalisePath(t.category)))

    return {
      accountId,
      statementId,
      rowKey,
      // What the bank sent, never overwritten: a learned rule is derived from this, not from the tidy name.
      original: t.payee ?? t.memo ?? '',
      payee: payeeOf(entry.rename, t) ?? '',
      renamed: entry.row.userPayee !== undefined,
      offerLearning: this.settings.import.learnRules,
      ...(category !== undefined && { categoryId: category }),
      categories: categories.map(c => ({ id: c.id, label: categoryLabel(categories, c.id) ?? c.name })),
      preview: {
        ...(payeeOf(entry.rename, t) !== undefined && { payee: payeeOf(entry.rename, t)! }),
        disposition: entry.disposition,
        note: noteFor(entry, existingById),
        ...(entry.matchedId !== undefined && { matchedId: entry.matchedId }),
        ...(matched !== undefined && {
          matches: {
            date: matched.date,
            amount: matched.amount,
            ...(matched.payeeName !== undefined && { payee: matched.payeeName })
          }
        })
      },
      currency: account.currency,
      amount: t.amount,
      date: t.date
    }
  }

  /** Everything the Change Transaction Matching dialog shows for one row, in one call. */
  async matchingInput(accountId: string, statementId: string, rowKey: string): Promise<MatchingDialogInput> {
    const { account, entries } = await this.matchingState(accountId)
    const entry = this.entryFor(entries, statementId, rowKey)
    const candidates = await this.matchingCandidates(accountId, statementId, rowKey)
    const t = entry.row.transaction
    return {
      entry: {
        date: t.date,
        amount: t.amount,
        // As the file wrote it, not as a rule renamed it: the user is deciding whether two things are the same
        ...(t.payee !== undefined && { payee: t.payee }),
        ...(t.memo !== undefined && { memo: t.memo }),
        ...(t.number !== undefined && { number: t.number })
      },
      currency: account.currency,
      candidates,
      ...(entry.matchedId !== undefined && { currentId: entry.matchedId })
    }
  }

  /**
   * Register transactions one pending row could match, nearest first, for Change Transaction Matching. A
   * transaction an earlier import already bank-matched, or that another pending row has claimed, is left out —
   * except the row's own current match, which leads the list.
   */
  async matchingCandidates(accountId: string, statementId: string, rowKey: string): Promise<MatchingCandidate[]> {
    const { existing, categories, entries } = await this.matchingState(accountId)
    const entry = this.entryFor(entries, statementId, rowKey)
    const currentId = entry.matchedId

    const claimed = new Set(entries
      .filter(e => !(e.statementId === statementId && e.row.key === rowKey))
      .map(e => e.matchedId)
      .filter((id): id is string => id !== undefined))

    const eligible = existing.filter(candidate => {
      if (candidate.id === currentId) return true
      if (candidate.voided) return false
      if (claimed.has(candidate.id)) return false
      // Already reported by the bank: a second statement line cannot be the same transaction
      if (candidate.externalId !== undefined) return false
      return true
    })

    const ranked = rankCandidates(entry.row.transaction, eligible, {
      dateWindow: Math.max(CANDIDATE_WINDOW_DAYS, this.settings.import.dateWindow),
      ...(currentId !== undefined && { currentId })
    })
    return ranked.slice(0, CANDIDATE_LIMIT)
      .map(candidate => {
        const label = candidate.transaction.categoryId === undefined
          ? undefined
          : categoryLabel(categories, candidate.transaction.categoryId)
        return {
          id: candidate.transaction.id,
          date: candidate.transaction.date,
          amount: candidate.transaction.amount,
          status: candidate.transaction.status,
          ...(candidate.transaction.number !== undefined && { number: candidate.transaction.number }),
          ...(candidate.payee !== undefined && { payee: candidate.payee }),
          ...(label !== undefined && { categoryLabel: label }),
          ...(candidate.caution === 'reconciled' && { caution: 'reconciled' as const })
        }
      })
      .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id))
  }

  // ---- Undo

  async undo(batchId: string, options: UndoOptions = {}): Promise<UndoResult> {
    let stored = await this.read_(c => c.batches.get(batchId))
    if (stored === undefined) throw notFound('That import is not in this book’s history.')
    if (stored.undoneAt !== undefined) throw new ExchangeError('ALREADY_UNDONE', 'That import has already been undone.')

    // An undo that never finished — the app closed during it, or its own back-out failed — left its journal.
    // Its steps are put back first, so this undo starts from the batch's imported state.
    if (stored.undoing !== undefined) {
      let recreated: Map<string, string>
      try {
        recreated = await backOut(stored.undoing, { accounts: this.deps.accounts })
      } catch (err) { throw translate(err) }
      await this.settleBackOut(batchId, recreated)
      stored = (await this.read_(c => c.batches.get(batchId)))!
    }
    const batch = toBatch(stored)

    // Gathered before anything is written: undo does the whole batch or nothing
    const obstacles = await undoObstacles(batch, this.deps.accounts)
    const needed = describeObstacles(obstacles)
    if (needed !== undefined) {
      const given = options.confirm ?? []
      const missing = (needed.reasons ?? []).filter(reason => !given.includes(reason))
      if (missing.length > 0) throw needed
    }

    let result: Omit<UndoResult, 'kept'>
    try {
      result = await reverse(batch, {
        accounts: this.deps.accounts,
        now: () => this.now(),
        // Saved after every step: what has been undone so far, and what puts it back
        record: journal => this.write(async c => {
          const current = await c.batches.get(batchId)
          if (current !== undefined) await c.batches.replace({ ...current, undoing: journal })
        }, () => ({})),
        backedOut: recreated => this.settleBackOut(batchId, recreated)
      })
    } catch (err) { throw translate(err) }

    await this.write(async c => {
      const done = await c.batches.get(batchId)
      if (done !== undefined) {
        const { undoing: _finished, ...rest } = done
        await c.batches.replace({ ...rest, undoneAt: this.now() })
      }
      // A statement still being read points at this batch. Its next accepted row must open a new one: joining
      // an undone batch hides it from the history and makes it impossible to undo.
      const pointing = (await c.pending.find()).filter(p => p.batchId === batchId)
      for (const statement of pointing) {
        const { batchId: _cleared, ...rest } = statement
        await c.pending.replace(rest as typeof statement)
      }
    }, () => ({ batches: [batchId], accounts: batch.accountIds }))

    return { ...result, kept: await this.keptByUndo(batch) }
  }

  /**
   * After an undo has been backed out: the journal is cleared, and the batch is pointed at the transactions that
   * were written back in place of the ones the undo had deleted — they have new ids, and without this the batch
   * would name rows that no longer exist and could never be undone again.
   */
  private async settleBackOut(batchId: string, recreated: Map<string, string>): Promise<void> {
    // Every transaction the back-out wrote counts as written *by the import*, now: putting the import's version
    // back is not the user editing it, and without this a retry found each one "changed since the import" and
    // asked for a confirmation that meant nothing.
    const at = this.now()
    await this.write(async c => {
      const batch = await c.batches.get(batchId)
      if (batch === undefined) return
      const touched = new Set(batch.undoing?.restored.map(r => r.id) ?? [])
      const { undoing: _backedOut, ...rest } = batch
      await c.batches.replace({
        ...rest,
        created: batch.created.map(group => ({
          ...group,
          rows: group.rows.map(row => {
            const replacement = recreated.get(row.id)
            return replacement === undefined ? row : { id: replacement, at }
          })
        })),
        merged: batch.merged.map(record => touched.has(record.id) ? { ...record, at } : record)
      })
    }, () => ({ batches: [batchId] }))
  }

  /**
   * The history with, for each entry, the account names and why it cannot be undone. Gathered here because
   * only this side can ask the register what has happened since — the renderer has neither.
   */
  async historyEntries(filter: HistoryFilter = {}): Promise<HistoryEntry[]> {
    const batches = await this.history(filter)
    const accounts = new Map((await this.deps.accounts.list({ includeClosed: true })).map(a => [a.id, a.name]))

    const entries: HistoryEntry[] = []
    for (const batch of batches) {
      const accountNames = batch.accountIds.map(id => accounts.get(id) ?? 'A deleted account')
      const blocked = await this.undoBlockedBecause(batch)
      entries.push({ batch, accountNames, ...(blocked !== undefined && { blocked }) })
    }
    return entries
  }

  /**
   * Why this batch cannot be undone at all, or undefined. Only the outright refusals: something that merely
   * needs confirming is not blocked, it is a question, and the dialog asks it when the user presses Undo.
   */
  private async undoBlockedBecause(batch: ImportBatch): Promise<string | undefined> {
    if (batch.undoneAt !== undefined) return 'Already undone'
    const written = batch.created.reduce((n, group) => n + group.rows.length, 0) + batch.merged.length
    if (written === 0) return 'Nothing was written'
    return undefined
  }

  /**
   * Drops the oldest batches beyond `history.keep`. Deleting rather than emptying is deliberate: a batch that
   * can no longer be undone must not sit in the history looking as though it could.
   */
  private async trimHistory(): Promise<void> {
    const keep = Math.max(1, this.settings.history.keep)
    await this.write(async c => {
      const all = await c.batches.find(undefined, { sort: { importedAt: -1 } })
      // Only a closed batch can go. An open one still has a statement pointing at it, with rows waiting to join
      // it — and rows already in it that only it can undo. Open batches still count towards `keep`, so the
      // history stays near the size asked for, but they are never what is dropped.
      const dropped = all.slice(keep).filter(batch => batch.closedAt !== undefined)
      for (const batch of dropped) await c.batches.deleteOne({ id: batch.id })
      return dropped.map(batch => batch.id)
    }, ids => ({ batches: ids }))
  }

  /**
   * Accounts and categories the import created and this undo left alone. Deleting an account that has since
   * been used is a much larger action than undoing an import, and one the user can take deliberately.
   */
  private async keptByUndo(batch: ImportBatch): Promise<UndoResult['kept']> {
    const accounts: string[] = []
    for (const id of batch.createdAccounts) {
      const account = await this.deps.accounts.get(id)
      if (account !== undefined) accounts.push(account.name)
    }
    const all = await this.deps.accounts.categories.list()
    const categories = batch.createdCategories
      .map(id => all.find(c => c.id === id)?.name)
      .filter((name): name is string => name !== undefined)
    return { accounts, categories }
  }

  async history(filter: HistoryFilter = {}): Promise<ImportBatch[]> {
    return this.read_(async c => {
      const all = await c.batches.find(undefined, { sort: { importedAt: -1 } })
      return all
        .map(toBatch)
        .filter(batch => filter.includeUndone === true || batch.undoneAt === undefined)
        .filter(batch => filter.accountId === undefined || batch.accountIds.includes(filter.accountId))
        .slice(0, Math.max(1, filter.limit ?? 50))
    })
  }

  // ---- Export

  async export(request: ExportRequest): Promise<ExportResult> {
    const descriptor = this.deps.formats.get(request.formatId)
    if (descriptor === undefined) throw new ExchangeError('UNKNOWN_FORMAT', 'That file format is not installed.', 'formatId')
    if (!descriptor.capabilities.write) {
      throw new ExchangeError('NOT_WRITABLE', `Tessera reads ${descriptor.label} files but does not write them.`, 'formatId')
    }
    const format = this.deps.formats.implementation(descriptor)
    if (format.write === undefined) {
      throw new ExchangeError('NOT_WRITABLE', `${descriptor.label} cannot be written.`, 'formatId')
    }

    const document = await this.exportDocument(request, descriptor.id)
    const accounts = document.statements.length
    if (accounts > 1 && !descriptor.capabilities.multiAccount) {
      throw new ExchangeError('NOT_WRITABLE',
        `${descriptor.label} holds one account, and this would export ${accounts}. Export them one at a time.`, 'formatId')
    }
    // Resolved against what the format declared it wants, so a writer can trust `context.options` without
    // re-checking, and a caller that passed none still gets that format's own defaults rather than nothing.
    const options = this.deps.exportOptions?.resolve(descriptor.id, request.formatOptions)
      ?? request.formatOptions ?? {}
    const bytes = await format.write(document, { options, log: this.deps.log })
    await this.deps.disk.write(request.path, bytes)
    return {
      path: request.path,
      accounts,
      transactions: document.statements.reduce((n, s) => n + s.transactions.length, 0),
      bytes: bytes.byteLength
    }
  }

  /** The book, as the neutral model, for a writer to turn into bytes. */
  private async exportDocument(request: ExportRequest, formatId: string): Promise<ExchangeDocument> {
    const chosen = await this.exportAccounts(request)
    const categories = await this.deps.accounts.categories.list()
    const names = new Map((await this.deps.accounts.list({ includeClosed: true })).map(a => [a.id, a.name]))

    const statements = []
    for (const account of chosen) {
      const register = await this.deps.accounts.transactions(account.id).register()
      const rows = register.rows
        .filter(row => inRange(row.transaction, request.range))
        .filter(row => request.includeVoided === true || !row.transaction.voided)
        .filter(row => request.clearedOnly !== true || row.transaction.status !== 'uncleared')

      statements.push({
        account: {
          name: account.name,
          type: account.type,
          currency: account.currency,
          ...(account.accountNumber !== undefined && { number: account.accountNumber }),
          ...(account.routingNumber !== undefined && { bankId: account.routingNumber })
        },
        balances: { ledger: { amount: register.balances.current, asOf: this.today() } },
        transactions: rows.map(row => exportRow(row.transaction, row.payeeName, categories, names))
      })
    }

    return {
      formatId,
      generatedAt: this.now(),
      statements,
      ...(request.includeCategories !== false && {
        categories: categories.map(category => ({
          path: labelOf(categories, category.id), kind: category.kind
        })).filter(entry => entry.path !== '')
      }),
      unsupported: [],
      warnings: []
    }
  }

  private async exportAccounts(request: ExportRequest) {
    if (request.scope.kind === 'account') {
      const account = await this.deps.accounts.get(request.scope.accountId)
      if (account === undefined) throw notFound('That account no longer exists.')
      return [account]
    }
    if (request.scope.kind === 'subBook') {
      return this.deps.accounts.list({
        subBookId: request.scope.subBookId,
        includeDescendants: request.scope.includeDescendants,
        includeClosed: true
      })
    }
    return this.deps.accounts.list({ includeClosed: true })
  }

  // ---- Links and rules

  async links(): Promise<AccountLink[]> {
    return this.read_(async c => (await c.links.find()).map(toLink))
  }

  async removeLink(id: string): Promise<void> {
    await this.write(c => c.links.deleteOne({ id }), () => ({ links: true }))
  }

  /** The matching window every source without its own uses: the option. */
  defaultDateWindow(): number {
    return this.settings.import.dateWindow
  }

  async updateLink(id: string, patch: LinkPatch): Promise<AccountLink> {
    if (patch.dateWindow !== undefined && patch.dateWindow !== null && !isDateWindow(patch.dateWindow)) {
      throw invalid('dateWindow', `The matching window must be a whole number of days from 0 to ${MAX_DATE_WINDOW}.`)
    }
    const updated = await this.write(async c => {
      const existing = await c.links.get(id)
      if (existing === undefined) throw notFound('That statement source is no longer linked.')
      const { dateWindow: _old, ...rest } = existing
      const next = {
        ...rest,
        ...(patch.dateWindow === undefined
          ? (existing.dateWindow !== undefined && { dateWindow: existing.dateWindow })
          : patch.dateWindow !== null && { dateWindow: patch.dateWindow })
      }
      return toLink(await c.links.replace(next))
    // The source's statements still waiting re-match against the new window, so their registers redraw.
    }, link => ({ links: true, pending: [link.accountId] }))
    return updated
  }

  readonly payeeRules: PayeeRuleDirectory = {
    list: () => this.read_(async c =>
      (await c.rules.find(undefined, { sort: { order: 1 } })).map(toRule)),

    replace: rules => this.write(async c => {
      for (const existing of await c.rules.find()) await c.rules.deleteOne({ id: existing.id })
      const written: PayeeRule[] = []
      for (const [at, rule] of rules.entries()) written.push(toRule(await c.rules.insert(checkRule(rule, at))))
      return written
    }, () => ({ rules: true })),

    add: rules => this.write(async c => {
      const highest = (await c.rules.find(undefined, { sort: { order: -1 }, limit: 1 }))[0]?.order ?? -1
      const written: PayeeRule[] = []
      for (const [at, rule] of rules.entries()) written.push(toRule(await c.rules.insert(checkRule(rule, highest + 1 + at))))
      return written
    }, () => ({ rules: true }))
  }
}

/** Checks and normalises a rule, and gives it its position in the list. */
function checkRule(rule: NewPayeeRule | PayeeRule, order: number): StoredRule {
  // The same check the Payee Rules dialog runs, so nothing it lets through is refused here.
  const problem = payeeRuleProblem(rule)
  if (problem !== undefined) throw invalid(problem.field, problem.message)
  return {
    order,
    match: { kind: rule.match.kind, value: rule.match.value.trim(), ignoreCase: rule.match.ignoreCase !== false },
    payee: rule.payee.trim(),
    ...(rule.categoryId !== undefined && { categoryId: rule.categoryId }),
    ...(rule.accountId !== undefined && { accountId: rule.accountId }),
    enabled: rule.enabled !== false,
    ...(rule.learned === true && { learned: true })
  }
}

/**
 * What to call a saved profile in the list: the name the answer carries — the mapping dialog puts one there —
 * and the question's own title when it does not.
 */
function nameOfProfile(answer: Json, question: ExchangeQuestion): string {
  const name = typeof answer === 'object' && answer !== null && !Array.isArray(answer)
    ? (answer as Record<string, Json>).name
    : undefined
  return typeof name === 'string' && name.trim() !== '' ? name.trim() : question.title
}

/** The accounts and categories a file's own reading created, or undefined when it created none. */
function createdBy(options: FileOptions): PendingStatement['created'] | undefined {
  const accounts = options.created?.accounts ?? []
  const categories = options.created?.categories ?? []
  if (accounts.length === 0 && categories.length === 0) return undefined
  return {
    ...(accounts.length > 0 && { accounts }),
    ...(categories.length > 0 && { categories })
  }
}

const inRange = (transaction: Transaction, range: ExportRequest['range']) =>
  (range?.from === undefined || transaction.date >= range.from) &&
  (range?.to === undefined || transaction.date <= range.to)

function labelOf(categories: readonly Category[], id: string): string {
  const byId = new Map(categories.map(c => [c.id, c]))
  const names: string[] = []
  for (let at = byId.get(id); at !== undefined; at = at.parentId === null ? undefined : byId.get(at.parentId)) {
    names.unshift(at.name)
    if (names.length > categories.length) break
  }
  return names.join(' : ')
}

function exportRow(
  transaction: Transaction, payeeName: string | undefined,
  categories: readonly Category[],
  accountNames: Map<string, string>
) {
  const cleared = transaction.status === 'reconciled'
    ? 'reconciled' as const
    : transaction.status === 'uncleared' ? undefined : 'cleared' as const
  return {
    date: transaction.date,
    amount: transaction.amount,
    ...(payeeName !== undefined && { payee: payeeName }),
    ...(transaction.memo !== undefined && { memo: transaction.memo }),
    ...(transaction.number !== undefined && { number: transaction.number }),
    ...(transaction.categoryId !== undefined && { category: labelOf(categories, transaction.categoryId) }),
    ...(transaction.transferAccountId !== undefined && {
      transferAccount: accountNames.get(transaction.transferAccountId) ?? 'Unknown account'
    }),
    ...(cleared !== undefined && { cleared }),
    externalId: transaction.id
  }
}
