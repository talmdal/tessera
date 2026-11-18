// The commands behind File ▸ Import and the register's statement rows.
//
// Importing is now reading and filing: read the file, settle which account each statement belongs to — a saved
// link, the account number, the name, or the user through the Choose Account dialog — and file the statements to
// read. Nothing touches a register here. The register's own Accept and Change… commands do that, one row at a
// time, which is where the user actually reads the statement.
import type { Disposable, PluginContext, ShellFiles, ShellPrompts } from '@tessera/types'
import {
  ACCOUNTS_COMMANDS, categoryLabel, todayIso,
  type AccountsService, type NewAccountArgs, type OverlayActionArgs
} from '@tessera/accounts-api'
import type { Json } from '@tessera/types'
import { BOOK_COMMANDS, BOOK_CONTEXT_KEYS } from '@tessera/book-api'
import {
  EXCHANGE_COMMANDS, EXCHANGE_DIALOGS, EXCHANGE_VIEWS, MAX_DATE_WINDOW, isExchangeError,
  type ChooseAccountInput, type ChooseAccountResult, type ExchangeConfirmation, type ExchangeStatement,
  type ExportAccountArgs, type HistoryDialogInput, type HistoryDialogResult,
  type RenameDialogInput, type RenameDialogResult, type RulesDialogInput, type RulesDialogResult,
  type SourcesDialogInput, type SourcesDialogResult,
  type UndoArgs,
  type ExportDialogInput, type ExportDialogResult, type FileResult,
  type ImportIntoArgs, type MatchingDialogInput, type MatchingDialogResult, type QuestionDialogInput, type ReadResult
} from '@tessera/exchange-api'
import type { ExchangeServiceImpl } from './ExchangeServiceImpl'
import { CAN_EDIT_ROWS, CAN_EXPORT, CAN_IMPORT, CAN_UNDO } from './contributions'
import type { FormatRegistry } from './formats'
import type { ExportOptionsRegistry } from './exportOptions'
import { parseOverlayKey } from './pending'
import { learnedRuleFrom } from './rules'
import { accountFromStatement, describeStatement, resolveAccount } from './planning'
import type { BookSession } from '@tessera/book-api'

/** One statement of the file and the account it is going to, plus whether that account is new because of it. */
interface ImportTarget {
  statement: ExchangeStatement
  accountId: string
  remember: boolean
  createdAccount?: boolean
}

export interface CommandDeps {
  service: ExchangeServiceImpl
  prompts: ShellPrompts
  formats: FormatRegistry
  session: BookSession
  accounts: AccountsService
  /** For the export command's save dialog; the service has its own copy for reading. */
  files: Pick<ShellFiles, 'showSaveDialog' | 'documentsPath'>
  /** What each format wants the export dialog to ask on its behalf. */
  exportOptions?: Pick<ExportOptionsRegistry, 'fields'>
}

/**
 * What to call the exported file: the account or the book, the year when the range is one, and the format's
 * own extension — `Chequing 2026.qif`. A name the user can accept without editing is the point.
 */
export function suggestedPath(
  deps: Pick<CommandDeps, 'files' | 'session'>,
  settled: ExportDialogResult,
  accounts: readonly { id: string, name: string }[],
  extension: string
): string {
  const scope = settled.scope
  const what = scope.kind === 'account'
    ? (accounts.find(a => a.id === scope.accountId)?.name ?? 'Transactions')
    : deps.session.current?.name ?? 'Transactions'

  const { from, to } = settled.range ?? {}
  const year = from?.slice(0, 4)
  const when = year !== undefined && year === to?.slice(0, 4) ? ` ${year}` : ''
  // No path separators, colons or anything else a file name cannot hold: an account may be called "RRSP: Mine".
  const safe = `${what}${when}`.replace(/[\\/:*?"<>|]/g, '-').trim()
  return `${deps.files.documentsPath()}/${safe === '' ? 'Transactions' : safe}.${extension}`
}

export function registerCommands(context: PluginContext, deps: CommandDeps): Disposable[] {
  const { service, prompts, formats, accounts } = deps

  /**
   * Runs an import step and reports what went wrong in the user's words. Anything the user caused is a message
   * box; anything else is a bug and is logged as one rather than dressed up as advice.
   */
  const attempt = async (title: string, work: () => Promise<void>) => {
    try {
      await work()
    } catch (err) {
      if (isExchangeError(err)) {
        // Cancelling the file dialog is not a failure, and saying so would be noise
        if (err.code === 'INVALID' && err.field === 'path') return
        await prompts.message({ kind: 'warning', title, message: 'This could not be done.', detail: err.message })
        return
      }
      context.logger.error(`[exchange] ${title} failed`, err)
      await prompts.message({
        kind: 'error', title, message: 'Something went wrong.',
        detail: String((err as Error)?.message ?? err)
      })
    }
  }

  /**
   * Reads a file, settles where it goes, files its statements, and shows Statements to Read.
   *
   * A file describing several accounts — a Money or Quicken data file — is asked about once: add its accounts
   * to the open book, or make a new book of it. In a new book every account is created from the file without
   * further questions; in the open book each statement is matched to an account, or the user chooses one.
   */
  const startImport = async (accountId?: string) => {
    if (formats.readable().length === 0) {
      await prompts.message({
        kind: 'info', title: 'Import',
        message: 'No file formats are installed.',
        detail: 'Tessera reads statements through format plugins, and none is available.'
      })
      return
    }

    const read = await service.read()
    const { document } = read
    const source = {
      fileName: read.fileName, fileHash: read.fileHash, formatId: document.formatId,
      ...(document.dialect !== undefined && { dialect: document.dialect })
    }

    // Which accounts each statement goes to: file name → account, so transfers between them resolve
    let targets: ImportTarget[]
    let skipped = 0
    if (document.statements.length > 1 && accountId === undefined) {
      const destination = await askDestination(document.statements.length)
      if (destination === undefined) return
      if (destination === 'new') {
        // Every question is asked before the book is made: cancelling the currency question after it would leave
        // the user in a new, empty book with nothing imported.
        const currency = await settleCurrency(read)
        if (currency === undefined) return
        const created = await context.commands.execute(BOOK_COMMANDS.new)
        if (created === undefined || created === null) return
        targets = await createAccountsFor(read, currency)
      } else {
        const chosen = await chooseAccountsFor(read, accountId)
        targets = chosen.targets
        skipped = chosen.skipped
      }
    } else {
      const chosen = await chooseAccountsFor(read, accountId)
      targets = chosen.targets
      skipped = chosen.skipped
    }

    // Nothing chosen — the user backed out of every account — so nothing is created either. Categories made
    // here would belong to no import, and no undo would ever name them.
    if (targets.length === 0) return
    const createdCategories = await service.ensureCategories(document)
    let categoriesCredited = createdCategories.length === 0
    const accountMap = Object.fromEntries(targets
      .filter(t => t.statement.account.name !== undefined)
      .map(t => [t.statement.account.name!, t.accountId]))

    let filed = 0
    let duplicates = 0
    const problems: string[] = []
    for (const target of targets) {
      try {
        // Each statement is credited with the account its own filing created. The categories came from the
        // document as a whole, so they go to one statement rather than being counted again for each — the first
        // that actually files rows. One skipped, refused, or with nothing new creates no pending statement to
        // carry them, and they would be credited to nothing.
        const created = {
          ...(target.createdAccount === true && { accounts: [target.accountId] }),
          ...(!categoriesCredited && { categories: createdCategories })
        }
        const fileIt = (force: boolean) => service.file(target.statement, target.accountId, {
          source,
          remember: target.remember,
          ...(document.truncatedAt !== undefined && { truncatedAt: document.truncatedAt }),
          accountMap,
          ...(Object.keys(created).length > 0 && { created }),
          ...(force && { force: true })
        })

        let result: FileResult
        try {
          result = await fileIt(false)
        } catch (err) {
          if (!isExchangeError(err) || err.code !== 'ALREADY_IMPORTED') throw err
          // Imported before. A bank that re-issues a corrected file is a real thing, so this is a question.
          const again = await prompts.confirm({
            title: 'Import',
            message: 'Import this file again?',
            detail: `${err.message} Importing it again will show its transactions once more; anything already in the register will be recognised and not added twice.`,
            confirmLabel: 'Import Anyway'
          })
          if (!again) { skipped += target.statement.transactions.length; continue }
          result = await fileIt(true)
        }
        if (result.filed > 0) categoriesCredited = true
        filed += result.filed
        duplicates += result.duplicates
      } catch (err) {
        if (isExchangeError(err)) problems.push(err.message)
        else throw err
      }
    }

    if (problems.length > 0) {
      await prompts.message({ kind: 'warning', title: 'Import', message: 'Part of this file could not be filed.', detail: problems.join('\n') })
    }
    if (filed === 0 && problems.length === 0 && skipped === 0) {
      await prompts.message({
        kind: 'info', title: 'Import',
        message: 'Nothing new to read.',
        detail: duplicates > 0
          ? `All ${duplicates} transactions in this file are already in the book.`
          : 'This file brought no transactions.'
      })
      return
    }
    await reveal(EXCHANGE_VIEWS.statements)
  }

  /** Into this book, or a new one? Undefined when the user backs out. */
  const askDestination = async (count: number): Promise<'this' | 'new' | undefined> => {
    const book = deps.session.current?.name ?? 'this book'
    const question: QuestionDialogInput = {
      question: {
        kind: 'choice',
        id: 'exchange.import.destination',
        title: `This file holds ${count} accounts. Where should they go?`,
        detail: 'A data file exported from Money or Quicken usually becomes a book of its own; statements from several accounts of a bank belong in the book you have open.',
        options: [
          { value: 'this', label: `Add them to “${book}”`, detail: 'Each account is matched to one in this book, or you choose.' },
          { value: 'new', label: 'Create a new book from this file…', detail: 'You choose where to save it; its accounts and categories are created from the file.' }
        ],
        suggested: 'this'
      }
    }
    const answer = await prompts.show<Json, QuestionDialogInput>(EXCHANGE_DIALOGS.question, question, { title: 'Import' })
    return answer === 'this' || answer === 'new' ? answer : undefined
  }

  /**
   * Every statement's account in a book just created for it: made from the file, no questions asked beyond the
   * one the file cannot answer — its currency, when it names none (QIF never does).
   */
  const createAccountsFor = async (read: ReadResult, currency: string) => {
    const today = new Date().toISOString().slice(0, 10)
    const targets: ImportTarget[] = []
    const taken = new Set<string>()
    for (const [at, statement] of read.document.statements.entries()) {
      const withCurrency: ExchangeStatement = { ...statement, account: { ...statement.account, currency: statement.account.currency ?? currency } }
      const prefill = accountFromStatement(withCurrency, today, read.document.institution?.name)
      if (prefill === undefined) continue
      // A file may name two accounts alike. The suffix counts up: a fixed one ("A (3)") hung the main process
      // when that name was itself already taken, since every turn of the loop assigned the same value.
      let name = prefill.name
      for (let suffix = at + 1; taken.has(name.toLowerCase()); suffix += 1) name = `${prefill.name} (${suffix})`
      taken.add(name.toLowerCase())
      const account = await accounts.createAccount({
        ...prefill, name,
        ...(read.document.institution?.name !== undefined && { institution: read.document.institution.name })
      })
      targets.push({ statement, accountId: account.id, remember: false, createdAccount: true })
    }
    return targets
  }

  /** The currency the file's accounts are in: what the file says, else one answer for all of them. */
  const settleCurrency = async (read: ReadResult): Promise<string | undefined> => {
    const named = read.document.statements.map(s => s.account.currency).find(c => c !== undefined)
    if (named !== undefined) return named.toUpperCase()
    const existing = await accounts.list({ includeClosed: true })
    const suggested = existing[0]?.currency ?? 'CAD'
    const answer = await prompts.show<Json, QuestionDialogInput>(EXCHANGE_DIALOGS.question, {
      question: {
        kind: 'currency',
        id: 'exchange.import.currency',
        title: 'Which currency are these accounts in?',
        detail: 'The file does not say, and every account in the book needs one.',
        suggested
      }
    }, { title: 'Import' })
    return typeof answer === 'string' && /^[A-Za-z]{3}$/.test(answer.trim()) ? answer.trim().toUpperCase() : undefined
  }

  /** Each statement's account in the open book: resolved, or chosen; a statement the user skips is left out. */
  const chooseAccountsFor = async (read: ReadResult, forced: string | undefined) => {
    const links = await service.links()
    const targets: ImportTarget[] = []
    let skipped = 0
    for (const statement of read.document.statements) {
      const resolved = await resolveAccount(statement, read.document.formatId, { accounts, links }, forced)
      if (resolved.target.kind === 'existing') {
        targets.push({ statement, accountId: resolved.target.accountId, remember: resolved.target.matchedBy !== 'link' })
        continue
      }
      const chosen = await chooseAccount(statement, read)
      if (chosen === undefined) { skipped += statement.transactions.length; continue }
      targets.push({
        statement, accountId: chosen.accountId, remember: chosen.remember,
        ...(chosen.created === true && { createdAccount: true })
      })
    }
    return { targets, skipped }
  }

  /**
   * Which account a statement belongs to, from the user: the Choose Account dialog, and — when they ask for a
   * new account — the accounts plugin's New Account dialog prefilled from the statement, so the opening balance
   * leaves the account at the bank's figure once the statement is read.
   */
  const chooseAccount = async (
    statement: ExchangeStatement, read: ReadResult
  ): Promise<{ accountId: string, remember: boolean, created: boolean } | undefined> => {
    const all = await accounts.list({ includeClosed: true })
    const canCreate = context.commands.has(ACCOUNTS_COMMANDS.newAccount)
    const input: ChooseAccountInput = {
      statement: describeStatement(statement, read.document.institution?.name),
      fileName: read.fileName,
      ...(statement.account.currency !== undefined && { currency: statement.account.currency.toUpperCase() }),
      accounts: [...all]
        .sort((a, b) => Number(a.closed) - Number(b.closed) || a.name.localeCompare(b.name))
        .map(a => ({
          id: a.id, name: a.name, currency: a.currency,
          ...(a.accountNumber !== undefined && { number: a.accountNumber }),
          ...(a.closed && { closed: true })
        })),
      canCreate
    }
    const answer = await prompts.show<ChooseAccountResult, ChooseAccountInput>(EXCHANGE_DIALOGS.account, input)
    if (answer === undefined) return undefined

    if (answer.kind === 'existing') return { accountId: answer.accountId, remember: answer.remember, created: false }

    const prefill = accountFromStatement(statement, new Date().toISOString().slice(0, 10), read.document.institution?.name)
    const args: NewAccountArgs = {
      reveal: false,
      defaults: {
        name: prefill?.name ?? statement.account.name ?? input.statement,
        ...(prefill !== undefined && {
          type: prefill.type, currency: prefill.currency,
          openingDate: prefill.openingDate, openingBalance: prefill.openingBalance
        }),
        ...(statement.account.number !== undefined && { accountNumber: statement.account.number }),
        ...(statement.account.bankId !== undefined && { routingNumber: statement.account.bankId }),
        ...(read.document.institution?.name !== undefined && { institution: read.document.institution.name })
      }
    }
    const account = await context.commands.execute(ACCOUNTS_COMMANDS.newAccount, args) as { id?: string } | undefined
    if (typeof account?.id !== 'string') return undefined
    return { accountId: account.id, remember: answer.remember, created: true }
  }

  /**
   * Puts a statement row aside — or, with `all`, everything left in its statement, which is how a user is done
   * with a file they do not want. Confirmed when it is the whole statement, because that is several rows at
   * once; a single row is one click and as easily undone by importing the file again.
   */
  const skip = async (args: unknown) => {
    const { accountId, statementId, rowKey } = rowOf(args)
    const all = (args as { all?: boolean } | undefined)?.all === true

    if (all) {
      const waiting = (await service.pendingFor(accountId)).find(s => s.id === statementId)
      const left = waiting?.rows.length ?? 0
      if (left === 0) return
      const agreed = await prompts.confirm({
        title: 'Skip',
        message: `Put the rest of “${waiting?.fileName ?? 'this statement'}” aside?`,
        detail: `${left} line${left === 1 ? '' : 's'} will not be imported. The import history will record that you left ${left === 1 ? 'it' : 'them'}.`,
        confirmLabel: 'Skip the Rest',
        destructive: true
      })
      if (!agreed) return
    }
    await service.dismiss(accountId, statementId, all ? undefined : rowKey)
  }

  /** The row named by an overlay action's arguments, or an error in the user's words. */
  /**
   * Edit Statement Line: the payee and the category for one row, with *Always rename this* writing a rule.
   *
   * The rename is saved on the row first and the rule second: the row is what the user asked for, and a rule
   * that could not be written — a stem too short to be safe — must not take the rename down with it.
   */
  const rename = async (args: unknown) => {
    const { accountId, statementId, rowKey } = rowOf(args)
    const input: RenameDialogInput = await service.renameInput(accountId, statementId, rowKey)
    const answer = await prompts.show<RenameDialogResult, RenameDialogInput>(EXCHANGE_DIALOGS.rename, input)
    if (answer === undefined) return

    // Only what the user changed: a rule's name or category sent back as it was would become theirs.
    const edit = {
      ...(answer.payee !== undefined && { payee: answer.payee }),
      ...(answer.categoryId !== undefined && { categoryId: answer.categoryId })
    }
    if (Object.keys(edit).length > 0) await service.editRow(accountId, statementId, rowKey, edit)
    if (!answer.always || !input.offerLearning || typeof answer.payee !== 'string') return

    // `add` places a learned rule after every existing one, so it never shadows a rule written by hand.
    const learned = learnedRuleFrom(input.original, answer.payee)
    if (learned === undefined) return
    await service.payeeRules.add([learned])
  }

  /** File ▸ Payee Rules…: the book's rules, as a list the user edits whole. */
  const showRules = async () => {
    const [rules, categories, accounts] = await Promise.all([
      service.payeeRules.list(),
      deps.accounts.categories.list(),
      deps.accounts.list({ includeClosed: true })
    ])
    const answer = await prompts.show<RulesDialogResult, RulesDialogInput>(EXCHANGE_DIALOGS.rules, {
      rules,
      // A category whose path cannot be resolved — a parent deleted beneath it — falls back to its own name
      // rather than disappearing from the list.
      categories: categories.map(c => ({ id: c.id, label: categoryLabel(categories, c.id) ?? c.name })),
      accounts: accounts.map(a => ({ id: a.id, name: a.name }))
    }, { title: 'Payee Rules' })
    if (answer === undefined) return
    // Replaced whole: the dialog edits the list, and `order` comes from the position in it.
    await service.payeeRules.replace(answer.rules)
  }

  /**
   * File ▸ Statement Sources…: the sources this book has linked to its accounts, each with its own matching
   * window. Changes and removals are applied one by one after the dialog closes; a source that disappeared in
   * the meantime is skipped rather than failing the rest.
   */
  const showSources = async () => {
    const [links, all] = await Promise.all([service.links(), accounts.list({ includeClosed: true })])
    if (links.length === 0) {
      await prompts.message({
        kind: 'info', title: 'Statement Sources',
        message: 'No statement sources are linked to this book’s accounts yet.',
        detail: 'A source is remembered when you import a statement and choose to remember which account it belongs to.'
      })
      return
    }
    const names = new Map(all.map(a => [a.id, a.name]))
    const answer = await prompts.show<SourcesDialogResult, SourcesDialogInput>(EXCHANGE_DIALOGS.sources, {
      sources: links.map(link => ({
        id: link.id,
        label: link.label,
        accountName: names.get(link.accountId) ?? 'A deleted account',
        formatLabel: formats.get(link.formatId)?.label ?? link.formatId,
        numberKey: link.numberKey,
        ...(link.lastImportedAt !== undefined && { lastImportedAt: link.lastImportedAt }),
        ...(link.dateWindow !== undefined && { dateWindow: link.dateWindow })
      })),
      defaultWindow: service.defaultDateWindow(),
      maxWindow: MAX_DATE_WINDOW
    }, { title: 'Statement Sources' })
    if (answer === undefined) return

    const removed = new Set(answer.removed)
    for (const change of answer.windows) {
      if (removed.has(change.id)) continue
      await service.updateLink(change.id, { dateWindow: change.dateWindow }).catch(err => {
        if (!isExchangeError(err) || err.code !== 'NOT_FOUND') throw err
      })
    }
    for (const id of removed) await service.removeLink(id)
  }

  const rowOf = (args: unknown): { accountId: string, statementId: string, rowKey: string } => {
    const { accountId, key } = (args ?? {}) as Partial<OverlayActionArgs>
    const parsed = parseOverlayKey(key)
    if (typeof accountId !== 'string' || parsed === undefined) {
      throw new Error('That statement line is no longer waiting to be read.')
    }
    return { accountId, ...parsed }
  }

  /** Change Transaction Matching for one row: keep it unmatched, or match it to one item in the register. */
  const change = async (args: unknown) => {
    const { accountId, statementId, rowKey } = rowOf(args)
    const input: MatchingDialogInput = await service.matchingInput(accountId, statementId, rowKey)
    const answer = await prompts.show<MatchingDialogResult, MatchingDialogInput>(EXCHANGE_DIALOGS.matching, input)
    if (answer === undefined) return
    await service.setMatch(accountId, statementId, rowKey, answer.matchTo)
  }

  const reveal = async (viewId: string) => {
    const shown = context.commands.has('shell.layout.reveal')
      ? await context.commands.execute('shell.layout.reveal', viewId).catch(() => false)
      : false
    if (shown !== false) return
    context.logger.error(`[exchange] The view ${viewId} could not be shown`)
  }

  /**
   * File ▸ Export Transactions…: settle what to write in the dialog, then where to put it, then write it. The
   * save dialog comes second on purpose — a user who cancels at the format step should never have been asked
   * to name a file, and the platform's own dialog is what asks before replacing one.
   */
  const startExport = async (accountId?: string) => {
    const writable = formats.writable()
    if (writable.length === 0) {
      await prompts.message({
        kind: 'info', title: 'Export',
        message: 'No file formats that can be written are installed.',
        detail: 'Tessera needs a format plugin — QIF or CSV — to export transactions.'
      })
      return
    }

    const chart = await accounts.chart({ includeClosed: true })
    const all = await accounts.list({ includeClosed: true })
    const settled = await prompts.show<ExportDialogResult, ExportDialogInput>(EXCHANGE_DIALOGS.export, {
      formats: writable.map(f => ({
        id: f.id,
        label: f.label,
        extensions: f.extensions,
        multiAccount: f.capabilities.multiAccount,
        fields: deps.exportOptions?.fields(f.id) ?? []
      })),
      accounts: all.map(a => ({
        id: a.id, name: a.name, subBookId: a.subBookId ?? null, ...(a.closed === true && { closed: true })
      })),
      subBooks: chart.subBooks.map(s => ({ id: s.id, name: s.name })),
      ...(accountId !== undefined && { scope: { kind: 'account' as const, accountId } }),
      today: todayIso()
    }, { title: 'Export Transactions' })
    if (settled === undefined) return

    const descriptor = formats.get(settled.formatId)
    const path = await deps.files.showSaveDialog({
      title: 'Export Transactions',
      buttonLabel: 'Export',
      defaultPath: suggestedPath(deps, settled, all, descriptor?.extensions[0] ?? 'txt'),
      ...(descriptor !== undefined && { filters: [{ name: descriptor.label, extensions: descriptor.extensions }] })
    })
    // Cancelling the save dialog abandons the export, having written nothing.
    if (path === undefined) return

    const result = await service.export({ ...settled, path })
    await prompts.message({
      kind: 'info', title: 'Export',
      message: `${result.transactions.toLocaleString()} transaction${result.transactions === 1 ? '' : 's'} from ${result.accounts} account${result.accounts === 1 ? '' : 's'} were written.`,
      detail: result.path
    })
  }

  /**
   * Takes an import back out, gathering any confirmation it needs **before** anything is written: a row
   * reconciled or edited since it was imported is a question, not a refusal, and the user answers it once for
   * the whole batch rather than row by row.
   */
  const undoBatch = async (batchId: string, title = 'Undo Import') => {
    const run = async (confirm?: ExchangeConfirmation[]) =>
      service.undo(batchId, ...(confirm === undefined ? [] : [{ confirm }]))

    let result
    try {
      result = await run()
    } catch (err) {
      if (!isExchangeError(err) || err.code !== 'CONFIRMATION_REQUIRED') throw err
      const agreed = await prompts.confirm({
        title,
        message: 'Undo this import anyway?',
        detail: err.message,
        confirmLabel: 'Undo Import',
        // Cancel is the default button: this discards work the user did after the import.
        destructive: true
      })
      if (!agreed) return
      result = await run(err.reasons as ExchangeConfirmation[])
    }

    const kept = [...result.kept.accounts, ...result.kept.categories]
    await prompts.message({
      kind: 'info',
      title,
      message: `${result.removed} ${result.removed === 1 ? 'transaction was' : 'transactions were'} removed`
        + `${result.restored > 0 ? ` and ${result.restored} put back as ${result.restored === 1 ? 'it was' : 'they were'}` : ''}.`,
      // Accounts and categories the import created are kept, and saying so is the honest ending.
      ...(kept.length > 0 && { detail: `Kept: ${kept.join(', ')}.` })
    })
  }

  /** File ▸ Import History…: what has been imported, and the chance to take one back out. */
  const showHistory = async () => {
    const entries = await service.historyEntries({ includeUndone: true })
    if (entries.length === 0) {
      await prompts.message({
        kind: 'info', title: 'Import History',
        message: 'Nothing has been imported into this book yet.'
      })
      return
    }
    const chosen = await prompts.show<HistoryDialogResult, HistoryDialogInput>(
      EXCHANGE_DIALOGS.history, { entries }, { title: 'Import History' })
    if (chosen?.undo !== undefined) await undoBatch(chosen.undo, 'Import History')
  }

  return [
    context.commands.register(EXCHANGE_COMMANDS.import, () => attempt('Import', () => startImport()), { enablement: CAN_IMPORT }),

    // Disabled on a read-only book: the dialog exists to undo imports, and an undo there could only fail.
    context.commands.register(EXCHANGE_COMMANDS.history, () => attempt('Import History', () => showHistory()),
      { enablement: CAN_EDIT_ROWS }),

    context.commands.register(EXCHANGE_COMMANDS.sources, () => attempt('Statement Sources', () => showSources()),
      { enablement: `${BOOK_CONTEXT_KEYS.isOpen} && !${BOOK_CONTEXT_KEYS.isReadOnly}` }),

    context.commands.register(EXCHANGE_COMMANDS.rules, () => attempt('Payee Rules', () => showRules()),
      { enablement: `${BOOK_CONTEXT_KEYS.isOpen} && !${BOOK_CONTEXT_KEYS.isReadOnly}` }),

    // Without an argument this undoes the most recent import, which is what the result banner asks for.
    context.commands.register(EXCHANGE_COMMANDS.undo, (args: unknown) =>
      attempt('Undo Import', async () => {
        const given = (args as UndoArgs | undefined)?.batchId
        if (typeof given === 'string' && given !== '') return undoBatch(given)
        const [recent] = await service.history({ limit: 1 })
        if (recent === undefined) {
          await prompts.message({
            kind: 'info', title: 'Undo Import',
            message: 'There is no import to undo in this book.'
          })
          return
        }
        await undoBatch(recent.id)
      }), { enablement: CAN_UNDO }),

    context.commands.register(EXCHANGE_COMMANDS.export, () => attempt('Export', () => startExport()),
      { enablement: CAN_EXPORT }),

    context.commands.register(EXCHANGE_COMMANDS.exportAccount, (args: unknown) => {
      const accountId = (args as ExportAccountArgs | undefined)?.accountId
      return attempt('Export', () => startExport(typeof accountId === 'string' ? accountId : undefined))
    }, { enablement: CAN_EXPORT }),

    context.commands.register(EXCHANGE_COMMANDS.importInto, (args: unknown) => {
      const accountId = (args as ImportIntoArgs | undefined)?.accountId
      return attempt('Import', () => startImport(typeof accountId === 'string' ? accountId : undefined))
    }, { enablement: CAN_IMPORT }),

    context.commands.register(EXCHANGE_COMMANDS.statements, () => reveal(EXCHANGE_VIEWS.statements)),

    context.commands.register(EXCHANGE_COMMANDS.accept, (args: unknown) =>
      attempt('Accept', async () => {
        const { accountId, statementId, rowKey } = rowOf(args)
        try {
          await service.accept(accountId, statementId, rowKey)
        } catch (err) {
          if (!isExchangeError(err) || err.code !== 'CONFIRMATION_REQUIRED') throw err
          const agreed = await prompts.confirm({
            title: 'Accept',
            message: 'Change a reconciled transaction?',
            detail: err.message,
            confirmLabel: 'Accept',
            destructive: true
          })
          if (!agreed) return
          await service.accept(accountId, statementId, rowKey, { confirm: err.reasons ?? [] })
        }
      }), { enablement: CAN_EDIT_ROWS }),

    context.commands.register(EXCHANGE_COMMANDS.change, (args: unknown) =>
      attempt('Change Transaction Matching', () => change(args)), { enablement: CAN_EDIT_ROWS }),

    context.commands.register(EXCHANGE_COMMANDS.rename, (args: unknown) =>
      attempt('Edit Statement Line', () => rename(args)), { enablement: CAN_EDIT_ROWS }),

    context.commands.register(EXCHANGE_COMMANDS.skip, (args: unknown) =>
      attempt('Skip', () => skip(args)), { enablement: CAN_EDIT_ROWS })
  ]
}
