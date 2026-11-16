// `budget.service`: the budgets of the open ledger. Every rule is enforced here, so whatever writes budgets (the
// dialogs, Fill from History, another plugin) gets the same checks. Actuals are never copied: each status is worked out
// from `accounts.service.transactionTotals` and the archived months. See docs/budget-design.md.
import type { Collection, Database, Disposable, Event, Logger, Transaction } from '@tessera/types'
import { nameKey, validateLedgerName, type ArchiveParticipant, type LedgerSession, type LedgerTree, type SubLedgerParticipant } from '@tessera/ledger-api'
import { isCurrencyCode, minorDigits, type Account, type AccountsService, type Category } from '@tessera/accounts-api'
import {
  BUDGET_AMOUNT_MAX, BUDGET_LINES_MAX, BUDGET_NOTES_MAX_LENGTH, BUDGET_PLUGIN_ID, BudgetError, DEFAULT_WARN_AT_PERCENT, STATUS_MONTHS_MAX,
  addMonths, applyPlanChange, firstDayOf, isMonth, lastDayOf, monthsOf, planProblem,
  type Budget, type BudgetChange, type BudgetInput, type BudgetLine, type BudgetService, type BudgetStatus, type LineInput,
  type LinePlan, type LineSuggestion, type LineTarget, type MonthRange, type PlanChange, type StatusOptions, type SuggestOptions,
  type WriteOptions
} from '@tessera/budget-api'
import {
  Emitter, change, collectionsOf, invalid, notFound, optionalText, targetKey, toBudget, toLine, translate,
  type Collections, type StoredBudget, type StoredLine
} from './store'
import { budgetArchiver, budgetSubLedgerParticipant } from './participants'
import { budgetStatus, countedTotals, scopeOf, type CountedTotal, type Scope } from './status'
import { suggestLines } from './suggest'

export interface BudgetServiceDeps {
  session: LedgerSession
  accounts: AccountsService
  log: Pick<Logger, 'warn' | 'error'>
  /** Now, as an ISO timestamp: when budgets are created and changed. */
  now?: () => string
  /** Lets the event loop turn during a long archive (tests count the turns). Default: `setImmediate`. */
  turn?: () => Promise<void>
  /** The Budget page's *Warn at*, for a status asked for without one. Default: `DEFAULT_WARN_AT_PERCENT`. */
  warnAtPercent?: () => number
}

/** Only what a plan is: a form or another plugin may send more. */
const planOf = (p: LinePlan): LinePlan => ({ from: p.from, amount: p.amount, frequency: p.frequency, due: p.due, ...(p.secondDay !== undefined && { secondDay: p.secondDay }) })

/** What a budget's form sets: the fields `update` takes from a patch. */
const BUDGET_INPUT_KEYS = ['name', 'subLedgerId', 'currency', 'yearStartMonth', 'notes'] as const satisfies readonly (keyof BudgetInput)[]


export class BudgetServiceImpl implements BudgetService {
  private readonly changes: Emitter<BudgetChange>
  private readonly subscriptions: Disposable[] = []
  /**
   * Budgets a sub-ledger delete moved, by the sub-ledger deleted. The delete may still roll back (another participant
   * refusing), and the ledger says nothing then; so they are announced at the next tree change only if that sub-ledger
   * is gone from the tree, which means the delete was committed.
   */
  private readonly moved = new Map<string, string[]>()
  readonly onDidChange: Event<BudgetChange>
  readonly subLedgerParticipant: SubLedgerParticipant
  readonly archiver: ArchiveParticipant

  constructor(private readonly deps: BudgetServiceDeps) {
    this.changes = new Emitter(deps.log)
    this.onDidChange = this.changes.event
    this.subLedgerParticipant = budgetSubLedgerParticipant(() => this.db(), this.now, (from, ids) => { this.moved.set(from, ids) })
    this.archiver = budgetArchiver({ ...(deps.turn && { turn: deps.turn }), log: deps.log, committed: () => this.changes.fire(change({ actuals: true })) })
    const actuals = () => this.changes.fire(change({ actuals: true }))
    this.subscriptions.push(
      // Another ledger means other budgets, and other actuals
      deps.session.onDidChange(actuals),
      // A sub-ledger created, moved or deleted changes what a budget covers; a delete may have moved budgets
      deps.session.onDidChangeTree(() => { void this.treeChanged() }),
      // Transactions, categories and accounts (moved, closed, deleted) are what actuals are made of
      deps.accounts.onDidChange(c => {
        if (c.transactions.length > 0 || c.categories || c.created.length > 0 || c.updated.length > 0 || c.deleted.length > 0) actuals()
      })
    )
  }

  /** After a tree change: what covers the budgets changed, and budgets a committed delete moved are announced. */
  private async treeChanged(): Promise<void> {
    if (this.moved.size === 0) {
      this.changes.fire(change({ actuals: true }))
      return
    }
    const pending = [...this.moved]
    this.moved.clear()
    const tree = await this.deps.session.tree().catch(() => undefined)
    const budgets = tree ? pending.filter(([from]) => !tree.subLedgers.some(s => s.id === from)).flatMap(([, ids]) => ids) : []
    this.changes.fire(change({ budgets, actuals: true }))
  }

  dispose() {
    for (const subscription of this.subscriptions.splice(0)) subscription.dispose()
  }

  private get now() { return this.deps.now ?? (() => new Date().toISOString()) }

  private db(): Database {
    try {
      return this.deps.session.database(BUDGET_PLUGIN_ID)
    } catch (err) { throw translate(err) }
  }

  private c(tx?: Transaction): Collections {
    return collectionsOf(tx ?? this.db())
  }

  private async read<T>(work: (c: Collections) => Promise<T>): Promise<T> {
    try { return await work(this.c()) } catch (err) { throw translate(err) }
  }

  /** Runs a write in one storage transaction, then announces what it touched. */
  private async write<T>(work: (c: Collections) => Promise<T>, announce: (result: T) => Partial<BudgetChange>): Promise<T> {
    let result: T
    try {
      if (this.deps.session.current?.readOnly) throw new BudgetError('READ_ONLY', 'This ledger is open read-only.')
      result = await this.db().transaction(tx => work(this.c(tx)))
    } catch (err) { throw translate(err) }
    this.changes.fire(change(announce(result)))
    return result
  }

  /** A call into another plugin's service, its errors as budget errors where they mean something. */
  private async outside<T>(work: () => Promise<T>): Promise<T> {
    try { return await work() } catch (err) { throw translate(err) }
  }

  private tree(): Promise<LedgerTree> { return this.outside(() => this.deps.session.tree()) }
  private allAccounts(): Promise<Account[]> { return this.outside(() => this.deps.accounts.list()) }
  private allCategories(): Promise<Category[]> { return this.outside(() => this.deps.accounts.categories.list()) }

  private async budgetOf(c: Collections, id: string, field = 'budgetId') {
    const doc = typeof id === 'string' ? await c.budgets.get(id) : undefined
    if (!doc) throw notFound('budget', field)
    return doc
  }

  private async lineOf(c: Collections, id: string) {
    const doc = typeof id === 'string' ? await c.lines.get(id) : undefined
    if (!doc) throw notFound('line', 'lineId')
    return doc
  }

  private async checkNameFree(budgets: Collection<StoredBudget>, key: string, except?: string) {
    const clash = await budgets.findOne({ nameKey: key })
    if (clash && clash.id !== except) throw new BudgetError('DUPLICATE_NAME', `There is already a budget named “${clash.name}”.`, 'name')
  }

  /** Checks and normalises a budget's fields. Throws INVALID or NOT_FOUND naming the field at fault. */
  private async checkBudget(input: BudgetInput): Promise<Omit<StoredBudget, 'createdAt' | 'updatedAt'>> {
    if (typeof input !== 'object' || input === null) throw invalid('name', 'Enter the budget’s details.')
    const problem = typeof input.name === 'string' ? validateLedgerName(input.name) : 'Enter a name.'
    if (problem) throw invalid('name', problem)
    if (input.subLedgerId !== null && typeof input.subLedgerId !== 'string') throw invalid('subLedgerId', 'Choose what the budget covers.')
    if (input.subLedgerId !== null && !(await this.tree()).subLedgers.some(s => s.id === input.subLedgerId)) throw notFound('sub-ledger', 'subLedgerId')
    const currency = typeof input.currency === 'string' ? input.currency.trim().toUpperCase() : ''
    if (!isCurrencyCode(currency)) throw invalid('currency', 'Choose a currency, like CAD.')
    if (!Number.isInteger(input.yearStartMonth) || input.yearStartMonth < 1 || input.yearStartMonth > 12) throw invalid('yearStartMonth', 'Choose the month the budget’s year starts in.')
    const name = input.name.trim()
    const notes = optionalText(input.notes, 'notes', BUDGET_NOTES_MAX_LENGTH)
    return { name, nameKey: nameKey(name), subLedgerId: input.subLedgerId, currency, yearStartMonth: input.yearStartMonth, ...(notes !== undefined && { notes }) }
  }

  /** What a budget covers, where every account is now. For this plugin's views too (`viewSupport.ts`); not on the contract. */
  async scope(budget: Pick<Budget, 'subLedgerId' | 'currency'>): Promise<{ scope: Scope, accounts: Account[] }> {
    const [tree, accounts] = await Promise.all([this.tree(), this.allAccounts()])
    return { scope: scopeOf(budget, tree.subLedgers, accounts), accounts }
  }

  /** What checking targets reads: the categories, and what the budget covers. Read once for many targets (`fill`). */
  private async targetContext(budget: Pick<Budget, 'subLedgerId' | 'currency'>) {
    const [categories, { scope, accounts }] = await Promise.all([this.allCategories(), this.scope(budget)])
    return { categories: new Set(categories.map(c => c.id)), scope, accounts }
  }

  /** Checks a line's target against the budget: it exists, and a transfer's account is outside the scope, in its currency. */
  private async checkTarget(
    target: LineTarget, budget: Pick<Budget, 'subLedgerId' | 'currency'>, field = 'target', context?: Awaited<ReturnType<BudgetServiceImpl['targetContext']>>
  ): Promise<LineTarget> {
    if (typeof target !== 'object' || target === null) throw invalid(field, 'Choose a category, or an account transferred with.')
    const { categories, scope, accounts } = context ?? await this.targetContext(budget)
    if (target.kind === 'category') {
      if (typeof target.categoryId !== 'string' || !categories.has(target.categoryId)) throw notFound('category', field)
      return { kind: 'category', categoryId: target.categoryId }
    }
    if (target.kind !== 'transfer') throw invalid(field, 'Choose a category, or an account transferred with.')
    if (target.direction !== 'in' && target.direction !== 'out') throw invalid(field, 'Choose transfers from the account, or to it.')
    const account = accounts.find(a => a.id === target.accountId)
    if (!account) throw notFound('account', field)
    if (scope.inside.has(account.id)) {
      throw invalid(field, `“${account.name}” is one of this budget’s accounts: moving money to it or from it isn’t income or spending.`)
    }
    if (account.currency !== budget.currency) throw invalid(field, `“${account.name}” is in ${account.currency}; this budget is in ${budget.currency}.`)
    return { kind: 'transfer', accountId: account.id, direction: target.direction }
  }

  private checkPlan(plan: LinePlan, prefix = ''): LinePlan {
    const problem = planProblem(plan)
    if (problem) throw invalid(`${prefix}${problem.field}`, problem.message)
    return planOf(plan)
  }

  private async duplicateLine(lines: Collection<StoredLine>, budgetId: string, target: LineTarget, field = 'target') {
    const clash = (await lines.find({ budgetId })).find(l => targetKey(l.target) === targetKey(target))
    if (clash) throw new BudgetError('DUPLICATE_LINE', await this.describeTarget(target, 'already has a line in this budget.'), field)
  }

  private async describeTarget(target: LineTarget, rest: string): Promise<string> {
    if (target.kind === 'category') {
      const category = (await this.allCategories()).find(c => c.id === target.categoryId)
      return `“${category?.name ?? 'That category'}” ${rest}`
    }
    const account = (await this.allAccounts()).find(a => a.id === target.accountId)
    return `Transfers with “${account?.name ?? 'that account'}” ${rest.replace(/^already has/, 'already have')}`
  }

  // ---- Budgets

  async list(): Promise<Budget[]> {
    return this.read(async c => (await c.budgets.find()).map(toBudget).sort((a, b) => a.name.localeCompare(b.name)))
  }

  async get(id: string): Promise<Budget | undefined> {
    return this.read(async c => {
      const doc = typeof id === 'string' ? await c.budgets.get(id) : undefined
      return doc && toBudget(doc)
    })
  }

  async create(input: BudgetInput): Promise<Budget> {
    this.db()
    const fields = await this.checkBudget(input)
    return this.write(async c => {
      await this.checkNameFree(c.budgets, fields.nameKey)
      const now = this.now()
      return toBudget(await c.budgets.insert({ ...fields, createdAt: now, updatedAt: now }))
    }, budget => ({ budgets: [budget.id] }))
  }

  async update(id: string, patch: Partial<BudgetInput>, options: WriteOptions = {}): Promise<Budget> {
    const current = await this.get(id)
    if (!current) throw notFound('budget', 'budgetId')
    if (typeof patch !== 'object' || patch === null) throw invalid('name', 'Nothing to change.')
    const merged: BudgetInput = {
      name: current.name, subLedgerId: current.subLedgerId, currency: current.currency, yearStartMonth: current.yearStartMonth,
      ...(current.notes !== undefined && { notes: current.notes })
    }
    // Only a budget's own fields: a patch can't carry anything else through
    for (const key of BUDGET_INPUT_KEYS) if (patch[key] !== undefined) (merged as unknown as Record<string, unknown>)[key] = patch[key]
    const fields = await this.checkBudget(merged)
    return this.write(async c => {
      const stored = await this.budgetOf(c, id)
      await this.checkNameFree(c.budgets, fields.nameKey, id)
      // Amounts are kept in minor units: in a currency with other decimals they would mean other amounts (650.00 CAD
      // would become ¥65,000), and turning them into the new currency's would need rounding, which budgets never do
      if (fields.currency !== stored.currency && minorDigits(fields.currency) !== minorDigits(stored.currency) && await c.lines.count({ budgetId: id }) > 0) {
        const places = (currency: string) => { const d = minorDigits(currency); return d === 0 ? 'no decimal places' : d === 1 ? '1 decimal place' : `${d} decimal places` }
        throw invalid('currency', `“${stored.name}” is planned in ${stored.currency}, which has ${places(stored.currency)}; ${fields.currency} has ${places(fields.currency)}, so its amounts would change. Make a new budget to plan in ${fields.currency}.`)
      }
      const { id: _id, rev: _rev, ...rest } = stored
      const next = { ...rest, ...fields, updatedAt: this.now() }
      if (fields.notes === undefined) delete next.notes
      return toBudget(await c.budgets.replace({ ...next, id }, options.expectedRev === undefined ? {} : { expectedRev: options.expectedRev }))
    }, budget => ({ budgets: [budget.id] }))
  }

  async duplicate(id: string, name: string): Promise<Budget> {
    const current = await this.get(id)
    if (!current) throw notFound('budget', 'budgetId')
    const fields = await this.checkBudget({ ...current, name })
    return this.write(async c => {
      await this.checkNameFree(c.budgets, fields.nameKey)
      const now = this.now()
      const copy = await c.budgets.insert({ ...fields, createdAt: now, updatedAt: now })
      for (const line of await c.lines.find({ budgetId: id })) {
        const { id: _id, rev: _rev, ...rest } = line
        await c.lines.insert({ ...structuredClone(rest), budgetId: copy.id })
      }
      return toBudget(copy)
    }, budget => ({ budgets: [budget.id], lines: [budget.id] }))
  }

  async delete(id: string): Promise<void> {
    await this.write(async c => {
      await this.budgetOf(c, id)
      for (const line of await c.lines.find({ budgetId: id })) await c.lines.deleteOne({ id: line.id })
      await c.budgets.deleteOne({ id })
    }, () => ({ budgets: [id], deleted: [id], lines: [id] }))
  }

  // ---- Lines

  async lines(budgetId: string): Promise<BudgetLine[]> {
    return this.read(async c => {
      await this.budgetOf(c, budgetId)
      return (await c.lines.find({ budgetId })).map(toLine)
    })
  }

  async addLine(budgetId: string, input: LineInput): Promise<BudgetLine> {
    const budget = await this.get(budgetId)
    if (!budget) throw notFound('budget', 'budgetId')
    if (typeof input !== 'object' || input === null) throw invalid('target', 'Choose a category, or an account transferred with.')
    const target = await this.checkTarget(input.target, budget)
    const plan = this.checkPlan(input.plan)
    const notes = optionalText(input.notes, 'notes', BUDGET_NOTES_MAX_LENGTH)
    return this.write(async c => {
      await this.budgetOf(c, budgetId)
      await this.duplicateLine(c.lines, budgetId, target)
      if (await c.lines.count({ budgetId }) >= BUDGET_LINES_MAX) throw invalid('target', `A budget can have at most ${BUDGET_LINES_MAX} lines.`)
      return toLine(await c.lines.insert({ budgetId, target, plans: [plan], ...(notes !== undefined && { notes }) }))
    }, line => ({ lines: [line.budgetId] }))
  }

  async changeLine(lineId: string, planChange: PlanChange, options: WriteOptions = {}): Promise<BudgetLine> {
    return this.editLine(lineId, { change: planChange }, options)
  }

  async setLineNotes(lineId: string, notes: string | null, options: WriteOptions = {}): Promise<BudgetLine> {
    return this.editLine(lineId, { notes }, options)
  }

  /**
   * A plan change and the notes, either or both, in one storage transaction checked against one revision, and announced
   * once: the Budget Line dialog saves both at once, and half a save would leave the line changed with the dialog saying
   * it wasn't. Everything is checked before anything is written. Not on the `BudgetService` contract: its two methods
   * are this, one part at a time.
   */
  async editLine(lineId: string, edit: { change?: PlanChange, notes?: string | null }, options: WriteOptions = {}): Promise<BudgetLine> {
    const change = edit.change === undefined ? undefined : this.checkChange(edit.change)
    const notes = edit.notes === undefined ? undefined : { text: optionalText(edit.notes, 'notes', BUDGET_NOTES_MAX_LENGTH) }
    return this.write(async c => {
      const line = await this.lineOf(c, lineId)
      const { id: _id, rev: _rev, ...rest } = structuredClone(line)
      let next: StoredLine = rest
      if (change) next = applyPlanChange(next, change)
      if (notes) {
        const { notes: _notes, ...withoutNotes } = next
        next = { ...withoutNotes, ...(notes.text !== undefined && { notes: notes.text }) }
      }
      return toLine(await c.lines.replace({ ...next, id: lineId }, options.expectedRev === undefined ? {} : { expectedRev: options.expectedRev }))
    }, line => ({ lines: [line.budgetId] }))
  }

  /** A `PlanChange` checked: a plan from a month, or one month's own amount (null to use the plan again). */
  private checkChange(planChange: PlanChange): PlanChange {
    if (typeof planChange !== 'object' || planChange === null) throw invalid('apply', 'Say what to change.')
    if (planChange.apply === 'from') return { apply: 'from', plan: this.checkPlan(planChange.plan), ...(planChange.replaceLater === true && { replaceLater: true }) }
    if (planChange.apply !== 'only') throw invalid('apply', 'Apply the change from a month on, or to one month only.')
    if (!isMonth(planChange.month)) throw invalid('month', 'Choose the month.')
    const amount = planChange.amount
    if (amount !== null && (!Number.isSafeInteger(amount) || amount < 0)) throw invalid('amount', 'Enter an amount of zero or more.')
    if (amount !== null && amount > BUDGET_AMOUNT_MAX) throw invalid('amount', 'That amount is too large for a budget.')
    return { apply: 'only', month: planChange.month, amount }
  }

  async deleteLine(lineId: string): Promise<void> {
    await this.write(async c => {
      const line = await this.lineOf(c, lineId)
      await c.lines.deleteOne({ id: lineId })
      return line.budgetId
    }, budgetId => ({ lines: [budgetId] }))
  }

  async fill(budgetId: string, inputs: LineInput[]): Promise<BudgetLine[]> {
    const budget = await this.get(budgetId)
    if (!budget) throw notFound('budget', 'budgetId')
    if (!Array.isArray(inputs)) throw invalid('lines', 'Give the lines to fill.')
    const checked: { target: LineTarget, plan: LinePlan, notes?: string }[] = []
    const seen = new Set<string>()
    const context = await this.targetContext(budget)
    for (const [i, input] of inputs.entries()) {
      if (typeof input !== 'object' || input === null) throw invalid(`lines[${i}].target`, 'Choose a category, or an account transferred with.')
      const target = await this.checkTarget(input.target, budget, `lines[${i}].target`, context)
      if (seen.has(targetKey(target))) throw invalid(`lines[${i}].target`, await this.describeTarget(target, 'is in the list twice.'))
      seen.add(targetKey(target))
      const notes = optionalText(input.notes, `lines[${i}].notes`, BUDGET_NOTES_MAX_LENGTH)
      checked.push({ target, plan: this.checkPlan(input.plan, `lines[${i}].`), ...(notes !== undefined && { notes }) })
    }
    if (checked.length === 0) return []
    return this.write(async c => {
      await this.budgetOf(c, budgetId)
      const existing = new Map((await c.lines.find({ budgetId })).map(l => [targetKey(l.target), l]))
      const added = checked.filter(x => !existing.has(targetKey(x.target))).length
      if (existing.size + added > BUDGET_LINES_MAX) throw invalid('lines', `A budget can have at most ${BUDGET_LINES_MAX} lines.`)
      const result: BudgetLine[] = []
      for (const { target, plan, notes } of checked) {
        const line = existing.get(targetKey(target))
        if (!line) {
          result.push(toLine(await c.lines.insert({ budgetId, target, plans: [plan], ...(notes !== undefined && { notes }) })))
          continue
        }
        // A line it has: the plan from the month on, as a change would add it
        const { id, rev: _rev, ...rest } = structuredClone(line)
        result.push(toLine(await c.lines.replace({ ...applyPlanChange(rest, { apply: 'from', plan }), id })))
      }
      return result
    }, () => ({ lines: [budgetId] }))
  }

  // ---- How the months stand

  /**
   * Everything a status or a suggestion is made from: the budget's lines, the ledger's categories and accounts, and what
   * counts. For this plugin's views too (`viewSupport.ts`); not on the contract.
   */
  async gather(budgetId: string, range: MonthRange) {
    const budget = await this.get(budgetId)
    if (!budget) throw notFound('budget', 'budgetId')
    const [lines, categories, { scope, accounts }] = await Promise.all([this.lines(budgetId), this.allCategories(), this.scope(budget)])
    const live = scope.counted.size === 0 ? [] : await this.outside(() => this.deps.accounts.transactionTotals({
      from: firstDayOf(range.from), to: lastDayOf(range.to), accountIds: [...scope.counted], includeTransfers: true
    }))
    const archived = await this.read(c => c.archivedMonths.find({ month: { $gte: range.from, $lte: range.to } }))
    const byId = new Map(accounts.map(a => [a.id, a]))
    const totals: CountedTotal[] = countedTotals(live, archived, scope, byId, budget.currency)
    return { budget, lines, categories, scope, accounts: byId, totals }
  }

  async status(budgetId: string, range: MonthRange, options: StatusOptions = {}): Promise<BudgetStatus> {
    if (typeof range !== 'object' || range === null || !isMonth(range.from) || !isMonth(range.to)) throw invalid('months', 'Choose the months, as YYYY-MM.')
    const months = monthsOf(range)
    if (months.length === 0) throw invalid('months', 'The last month comes before the first.')
    if (months.length > STATUS_MONTHS_MAX) throw invalid('months', `Choose at most ${STATUS_MONTHS_MAX} months.`)
    const warnAtPercent = options.warnAtPercent ?? this.deps.warnAtPercent?.() ?? DEFAULT_WARN_AT_PERCENT
    if (!Number.isInteger(warnAtPercent) || warnAtPercent < 1 || warnAtPercent > 100) throw invalid('warnAtPercent', 'Choose a share from 1 to 100 %.')
    const { budget, lines, categories, scope, accounts, totals } = await this.gather(budgetId, range)
    return budgetStatus({ budget, lines, categories, accounts, totals, months, notCounted: scope.notCounted, warnAtPercent, byMonth: options.byMonth === true })
  }

  async suggest(budgetId: string, options: SuggestOptions): Promise<LineSuggestion[]> {
    if (typeof options !== 'object' || options === null) throw invalid('months', 'Choose how many months to look at.')
    if (!Number.isInteger(options.months) || options.months < 1 || options.months > STATUS_MONTHS_MAX) throw invalid('months', `Look at 1 to ${STATUS_MONTHS_MAX} months.`)
    if (!isMonth(options.start)) throw invalid('start', 'Choose the month the lines start from.')
    if (!Number.isSafeInteger(options.step) || options.step < 1 || options.step > BUDGET_AMOUNT_MAX) throw invalid('step', 'Choose what to round to.')
    const range = { from: addMonths(options.start, -options.months), to: addMonths(options.start, -1) }
    const { lines, categories, accounts, totals } = await this.gather(budgetId, range)
    return suggestLines({ totals, categories, accounts, lines, months: monthsOf(range), start: options.start, step: options.step })
  }

  // ---- Not on the `BudgetService` contract: for this plugin's own views (see also viewSupport.ts)

  /** One line, as stored now. */
  async line(lineId: string): Promise<BudgetLine> {
    return this.read(async c => toLine(await this.lineOf(c, lineId)))
  }
}
