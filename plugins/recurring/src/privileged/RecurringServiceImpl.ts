// `recurring.service`: the recurring transactions of the open book. Every rule is enforced here, so whatever
// writes them (the dialogs, a future importer) gets the same checks.
//
// Nothing reaches the accounts collections: a transaction is written through `accounts.service`, which enforces
// the account manager's own rules (closed accounts, transfers, currencies, reconciled balances). That means an
// entry is two storage transactions — the account manager's, then ours — which is why a bulk entry reports what
// it managed rather than rolling back. See docs/recurring-transactions-design.md, "Entering an occurrence".
import type { Database, Disposable, Doc, Event, Logger, Transaction as StorageTransaction } from '@tessera/types'
import type { BookSession } from '@tessera/book-api'
import {
  isIsoDate, todayIso,
  type Account, type AccountsChange, type AccountsService, type Category, type Transaction, type TransactionDraft
} from '@tessera/accounts-api'
import {
  HOLIDAY_NAME_MAX_LENGTH, MAX_FORECAST_ENTRIES, MAX_FORECAST_YEARS, RecurringError, SOURCE_POSTING_INDEX,
  addIsoDays, firstIndexOnOrAfter, isRecurringError, occurrenceAt, occurrencesFrom, seriesKind,
  type BusinessCalendar, type EnterRequest, type EnterResult, type EnteredOccurrence, type ForecastEntry, type Holiday, type Posting,
  type RecurringChange, type RecurringConfirmation, type RecurringService, type RecurringSnapshot,
  type Schedule, type Series, type SeriesFilter, type SeriesInput, type SeriesPatch, type SeriesTemplate,
  type WriteOptions
} from '@tessera/recurring-api'
import { applyPatch, checkSeriesInput, sameSchedule, type CheckedSeries } from './rules'
import { buildSnapshot } from './snapshot'
import {
  Emitter, change, collectionsOf, invalid, notFound, optionalText, toHoliday, toPosting, toSeries, translate,
  type Collections, type StoredSeries
} from './store'

export { translate }

/** A date this far from today is worth asking about before it is written into a register. */
const UNUSUAL_DAYS = 365

export interface RecurringServiceDeps {
  session: BookSession
  accounts: AccountsService
  log: Pick<Logger, 'warn' | 'error'>
  /** Today, as YYYY-MM-DD. */
  today?: () => string
  /** Now, as an ISO timestamp: when a posting is recorded. */
  now?: () => string
}

/** One occurrence, checked and ready to write, or the reason it can't be. */
interface Planned {
  request: EnterRequest
  series: Series
  account?: Account
  draft?: TransactionDraft
  /** Confirmations the user must give first. */
  needs: RecurringConfirmation[]
  problem?: { code: RecurringError['code'], message: string }
}

export class RecurringServiceImpl implements RecurringService {
  private readonly changes: Emitter<RecurringChange>
  private readonly subscriptions: Disposable[] = []

  readonly onDidChange: Event<RecurringChange>

  constructor(private readonly deps: RecurringServiceDeps) {
    this.changes = new Emitter(deps.log)
    this.onDidChange = this.changes.event
    // Another book means other recurring transactions
    this.subscriptions.push(deps.session.onDidChange(() => this.changes.fire(change({}))))
  }

  dispose() {
    for (const subscription of this.subscriptions.splice(0)) subscription.dispose()
  }

  private get today() { return this.deps.today ?? (() => todayIso()) }
  private get now() { return this.deps.now ?? (() => new Date().toISOString()) }

  private db(): Database {
    try {
      return this.deps.session.database('recurring')
    } catch (err) { throw translate(err) }
  }

  private c(tx?: StorageTransaction): Collections {
    return collectionsOf(tx ?? this.db())
  }

  private async read<T>(work: (c: Collections) => Promise<T>): Promise<T> {
    try { return await work(this.c()) } catch (err) { throw translate(err) }
  }

  /** Runs a write in one storage transaction, then announces what it touched. */
  private async write<T>(work: (c: Collections) => Promise<T>, announce: (result: T) => Partial<RecurringChange>): Promise<T> {
    let result: T
    try {
      result = await this.db().transaction(tx => work(this.c(tx)))
    } catch (err) { throw translate(err) }
    this.changes.fire(change(announce(result)))
    return result
  }

  /** The book's holidays, as the schedule engine takes them. Read once per operation, not once per occurrence. */
  private async calendar(c?: Collections): Promise<BusinessCalendar> {
    const holidays = c ? await c.holidays.find() : await this.read(x => x.holidays.find())
    return { holidays: new Set(holidays.map(h => h.date)) }
  }

  // ---- Reading

  async get(id: string): Promise<Series | undefined> {
    return this.read(async c => {
      const doc = typeof id === 'string' ? await c.series.get(id) : undefined
      return doc && toSeries(doc)
    })
  }

  async list(filter: SeriesFilter = {}): Promise<Series[]> {
    return this.read(async c => {
      let series = (await c.series.find(undefined, { sort: { nextDate: 1 } })).map(toSeries)
      if (filter.accountId !== undefined) series = series.filter(s => s.accountId === filter.accountId)
      if (filter.kinds !== undefined) series = series.filter(s => filter.kinds!.includes(seriesKind(s.template)))
      if (filter.includePaused !== true) series = series.filter(s => !s.paused)
      if (filter.includeEnded !== true) series = series.filter(s => s.nextDate !== null && s.endedOn === undefined)
      return series
    })
  }

  /**
   * Everything the Recurring view shows. A series the *user* paused is left out unless asked for; one the plugin
   * paused (its account was closed) is always shown, because the user never asked for it to stop.
   */
  async snapshot(options: { includePaused?: boolean, includeEnded?: boolean } = {}): Promise<RecurringSnapshot> {
    const all = await this.read(async c => (await c.series.find()).map(toSeries))
    const wanted = all.filter(series => {
      if (series.paused && series.pausedReason === 'user' && options.includePaused !== true) return false
      if ((series.nextDate === null || series.endedOn !== undefined) && options.includeEnded !== true) return false
      return true
    })
    const [accounts, categories, calendar] = await Promise.all([this.allAccounts(), this.allCategories(), this.calendar()])
    return buildSnapshot(wanted, accounts, categories, this.today(), calendar)
  }

  async forecast(range: { from: string, to: string }, filter: SeriesFilter = {}): Promise<ForecastEntry[]> {
    const { from, to } = range ?? {}
    if (typeof from !== 'string' || typeof to !== 'string' || from > to) throw invalid('from', 'Give a date range to look over.')
    if (Number(to.slice(0, 4)) - Number(from.slice(0, 4)) > MAX_FORECAST_YEARS) {
      throw invalid('to', `Look over at most ${MAX_FORECAST_YEARS} years at a time.`)
    }

    const series = await this.list(filter)
    const [accountList, calendar] = await Promise.all([this.allAccounts(), this.calendar()])
    const accounts = new Map(accountList.map(account => [account.id, account]))
    const entries: ForecastEntry[] = []
    for (const one of series) {
      // Never before the next unentered occurrence: what is already entered is in the register, not the forecast
      const start = Math.max(one.nextIndex, firstIndexOnOrAfter(one.schedule, from, calendar) ?? one.nextIndex)
      for (const occurrence of occurrencesFrom(one.schedule, { fromIndex: start, until: to, calendar })) {
        if (occurrence.date < from) continue
        entries.push({
          seriesId: one.id, accountId: one.accountId, name: one.name, kind: seriesKind(one.template),
          date: occurrence.date, amount: one.template.amount,
          currency: accounts.get(one.accountId)?.currency ?? '',
          estimated: one.template.estimated,
          ...(one.template.transferAccountId !== undefined && { transferAccountId: one.template.transferAccountId })
        })
      }
    }
    return entries.sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name)).slice(0, MAX_FORECAST_ENTRIES)
  }

  async history(seriesId: string, limit = 50): Promise<Posting[]> {
    return this.read(async c => {
      const postings = await c.postings.find({ seriesId }, { sort: { dueDate: -1 } })
      return postings.slice(0, Math.max(0, limit)).map(toPosting)
    })
  }

  // ---- The account manager, as this plugin sees it

  private allAccounts(): Promise<Account[]> {
    return this.deps.accounts.list({ includeClosed: true }).catch(err => { throw translate(err) })
  }

  private allCategories(): Promise<Category[]> {
    return this.deps.accounts.categories.list().catch(err => { throw translate(err) })
  }

  private async account(id: string): Promise<Account> {
    const account = await this.deps.accounts.get(id).catch(err => { throw translate(err) })
    if (!account) throw new RecurringError('NOT_FOUND', 'That account no longer exists.', 'accountId')
    return account
  }

  /** An open account to write into. */
  private async openAccount(id: string): Promise<Account> {
    const account = await this.account(id)
    if (account.closed) {
      throw new RecurringError('ACCOUNT_CLOSED', `“${account.name}” is closed. Reopen it to use it.`, 'accountId')
    }
    return account
  }

  /** The other side of a transfer must exist, be open, and be in the same currency, as the register requires. */
  private async checkTransfer(template: SeriesTemplate, account: Account): Promise<void> {
    if (template.transferAccountId === undefined) return
    if (template.transferAccountId === account.id) {
      throw new RecurringError('TRANSFER_UNAVAILABLE', 'An account can’t transfer to itself.', 'transferAccountId')
    }
    const other = await this.deps.accounts.get(template.transferAccountId).catch(err => { throw translate(err) })
    if (!other) throw new RecurringError('TRANSFER_UNAVAILABLE', 'That account no longer exists.', 'transferAccountId')
    if (other.closed) {
      throw new RecurringError('TRANSFER_UNAVAILABLE', `“${other.name}” is closed. Reopen it to transfer to it.`, 'transferAccountId')
    }
    if (other.currency !== account.currency) {
      throw new RecurringError('TRANSFER_UNAVAILABLE', `“${other.name}” is in ${other.currency}, not ${account.currency}.`, 'transferAccountId')
    }
  }

  /** What a series is called when the user doesn't name it: its payee, else where it transfers, else its account. */
  private async defaultName(input: SeriesInput): Promise<string> {
    const given = typeof input?.name === 'string' ? input.name.trim() : ''
    if (given !== '') return given
    const template = (input?.template ?? {}) as SeriesTemplate
    const payee = typeof template.payee === 'string' ? template.payee.trim() : ''
    if (payee !== '') return payee
    if (typeof template.transferAccountId === 'string') {
      const other = await this.deps.accounts.get(template.transferAccountId).catch(() => undefined)
      if (other) return `Transfer to ${other.name}`
    }
    const account = typeof input?.accountId === 'string' ? await this.deps.accounts.get(input.accountId).catch(() => undefined) : undefined
    return account ? `Recurring in ${account.name}` : 'Recurring transaction'
  }

  // ---- Creating and changing

  private storedFrom(checked: CheckedSeries, state: Pick<StoredSeries, 'nextIndex' | 'nextDate' | 'enteredCount' | 'skippedCount'> & Partial<StoredSeries>): StoredSeries {
    const now = this.now()
    return {
      accountId: checked.accountId,
      name: checked.name,
      template: checked.template,
      schedule: checked.schedule,
      remindDays: checked.remindDays,
      autoEnter: checked.autoEnter,
      paused: false,
      createdAt: now,
      updatedAt: now,
      ...(checked.notes !== undefined && { notes: checked.notes }),
      ...state
    }
  }

  async create(input: SeriesInput): Promise<Series> {
    const checked = checkSeriesInput({ ...input, name: await this.defaultName(input) })
    const account = await this.openAccount(checked.accountId)
    await this.checkTransfer(checked.template, account)

    // `validateSchedule` has already refused a schedule with no occurrences at all
    const first = occurrenceAt(checked.schedule, 0, await this.calendar())!
    const stored = this.storedFrom(checked, { nextIndex: 0, nextDate: first.date, enteredCount: 0, skippedCount: 0 })
    const created = await this.write(
      async c => toSeries(await c.series.insert(stored)),
      series => ({ created: [series.id] })
    )
    return created
  }

  /**
   * From a transaction already in a register. The transaction is left alone and recorded as the series' last
   * entry, so the schedule starts after it and the register doesn't gain a duplicate.
   *
   * `input` is the series as the user confirmed it — the dialog prefills from `templateFrom`, and anything
   * changed there is what gets stored.
   */
  async createFromTransaction(input: SeriesInput, source: { accountId: string, transactionId: string }): Promise<Series> {
    const { accountId, transactionId } = source ?? {}
    const checked = checkSeriesInput({ ...input, name: await this.defaultName(input) })
    const account = await this.openAccount(checked.accountId)
    await this.checkTransfer(checked.template, account)

    // The source must still be there: it is what the series' history and its starting point are built on
    const from = await this.templateFrom(accountId, transactionId)

    // The first occurrence after the one already in the register, so nothing is entered twice
    const calendar = await this.calendar()
    const nextIndex = firstIndexOnOrAfter(checked.schedule, addIsoDays(from.date, 1), calendar)
    const next = nextIndex === undefined ? undefined : occurrenceAt(checked.schedule, nextIndex, calendar)
    const stored = this.storedFrom(checked, {
      nextIndex: nextIndex ?? 0,
      nextDate: next?.date ?? null,
      enteredCount: 1,
      skippedCount: 0,
      lastEnteredDate: from.date,
      ...(next === undefined && { endedOn: this.today() })
    })

    return this.write(async c => {
      const series = toSeries(await c.series.insert(stored))
      await c.postings.insert({
        seriesId: series.id, accountId, index: SOURCE_POSTING_INDEX, dueDate: from.date, outcome: 'entered',
        transactionId, date: from.date, amount: from.template.amount, at: this.now()
      })
      return series
    }, series => ({ created: [series.id] }))
  }

  /**
   * What a transaction already in a register would make, for prefilling the dialog. The register snapshot is the
   * only published way to read a payee's name for a transaction, and it resolves the category label too, so one
   * call does both.
   */
  async templateFrom(accountId: string, transactionId: string): Promise<{ date: string, template: SeriesTemplate }> {
    if (typeof transactionId !== 'string' || transactionId === '') throw new RecurringError('NOT_FOUND', 'That transaction no longer exists.')
    const snapshot = await this.deps.accounts.transactions(accountId).register().catch(err => { throw translate(err) })
    const row = snapshot.rows.find(r => r.transaction.id === transactionId)
    if (!row) throw new RecurringError('NOT_FOUND', 'That transaction no longer exists.')
    const t: Transaction = row.transaction

    return {
      date: t.date,
      template: {
        amount: t.amount,
        autoNumber: false,
        estimated: false,
        // A cheque number doesn't repeat, so it is deliberately not carried over
        ...(row.payeeName !== undefined && { payee: row.payeeName }),
        ...(t.memo !== undefined && { memo: t.memo }),
        ...(t.categoryId !== undefined && { categoryId: t.categoryId }),
        ...(t.transferAccountId !== undefined && { transferAccountId: t.transferAccountId })
      }
    }
  }

  async update(id: string, patch: SeriesPatch, options: WriteOptions = {}): Promise<Series> {
    const current = await this.require(id)
    const checked = checkSeriesInput(applyPatch({
      accountId: current.accountId, name: current.name, template: current.template, schedule: current.schedule,
      remindDays: current.remindDays, autoEnter: current.autoEnter, ...(current.notes !== undefined && { notes: current.notes })
    }, patch))

    const account = await this.openAccount(checked.accountId)
    await this.checkTransfer(checked.template, account)

    // A changed schedule places the next occurrence again, after everything already entered or skipped
    let { nextIndex, nextDate, endedOn } = current
    if (!sameSchedule(checked.schedule, current.schedule)) {
      const calendar = await this.calendar()
      const after = await this.lastHandledDate(id)
      const found = after === undefined ? 0 : firstIndexOnOrAfter(checked.schedule, addIsoDays(after, 1), calendar)
      nextIndex = found ?? current.nextIndex
      const next = found === undefined ? undefined : occurrenceAt(checked.schedule, found, calendar)
      nextDate = next?.date ?? null
      endedOn = next === undefined ? this.today() : undefined
    }

    return this.write(async c => {
      const updated = await c.series.replace({
        id,
        ...this.storedFrom(checked, {
          nextIndex, nextDate, enteredCount: current.enteredCount, skippedCount: current.skippedCount,
          ...(current.lastEnteredDate !== undefined && { lastEnteredDate: current.lastEnteredDate }),
          ...(endedOn !== undefined && { endedOn })
        }),
        paused: current.paused,
        ...(current.pausedReason !== undefined && { pausedReason: current.pausedReason }),
        createdAt: current.createdAt
      }, { ...(options.expectedRev !== undefined && { expectedRev: options.expectedRev }) })
      return toSeries(updated)
    }, series => ({ updated: [series.id] }))
  }

  /** The date of the last occurrence dealt with, entered or skipped; undefined when none has been. */
  private async lastHandledDate(seriesId: string): Promise<string | undefined> {
    return this.read(async c => {
      const latest = await c.postings.findOne({ seriesId }, { sort: { dueDate: -1 } })
      return latest?.dueDate
    })
  }

  async delete(ids: string[], options: WriteOptions = {}): Promise<void> {
    const wanted = this.idsOf(ids)
    await this.write(async c => {
      for (const id of wanted) {
        const existing = await c.series.get(id)
        if (!existing) continue
        if (options.expectedRev !== undefined && existing.rev !== options.expectedRev) {
          throw new RecurringError('CONFLICT', 'This was changed elsewhere. Try again.')
        }
        // The transactions it has already produced stay in their registers: they are real money that moved
        await c.postings.deleteMany({ seriesId: id })
        await c.series.deleteOne({ id })
      }
      return wanted
    }, deleted => ({ deleted }))
  }

  async setPaused(ids: string[], paused: boolean): Promise<void> {
    await this.pause(this.idsOf(ids), paused === true ? 'user' : undefined)
  }

  /** Pauses or resumes, recording why. Resuming clears the reason. */
  private async pause(ids: string[], reason: Series['pausedReason'] | undefined): Promise<string[]> {
    return this.write(async c => {
      const touched: string[] = []
      for (const id of ids) {
        const existing = await c.series.get(id)
        if (!existing) continue
        const paused = reason !== undefined
        if (existing.paused === paused && existing.pausedReason === reason) continue
        const { pausedReason: _was, ...rest } = existing
        await c.series.replace({
          ...rest, paused, ...(reason !== undefined && { pausedReason: reason }), updatedAt: this.now()
        })
        touched.push(id)
      }
      return touched
    }, updated => ({ updated }))
  }

  // ---- Entering and skipping

  /**
   * Writes each request's occurrence into its account's register and advances its series. Confirmations are
   * gathered first, across every request, so the user is asked once before anything is written; after that a
   * failure stops neither the rest nor what has already gone in.
   */
  async enter(requests: EnterRequest[], options: WriteOptions = {}): Promise<EnterResult> {
    if (!Array.isArray(requests) || requests.length === 0) throw invalid('requests', 'Choose what to enter.')
    const given = new Set(options.confirm ?? [])
    const calendar = await this.calendar()

    const plans: Planned[] = []
    for (const request of requests) plans.push(await this.plan(request, calendar))
    // Only what can actually be written gets a say in what the user is asked
    const needed = [...new Set(plans.filter(p => p.problem === undefined).flatMap(p => p.needs))].filter(reason => !given.has(reason))
    if (needed.length > 0) throw new RecurringError('CONFIRMATION_REQUIRED', this.confirmationMessage(needed), undefined, needed)

    // In date order, so a register gains them the way they fell due
    plans.sort((a, b) => (a.draft?.date ?? '').localeCompare(b.draft?.date ?? ''))

    const entered: EnteredOccurrence[] = []
    const failed: EnterResult['failed'] = []
    const accounts: string[] = []
    const updated: string[] = []
    for (const plan of plans) {
      if (plan.problem || !plan.draft || !plan.account) {
        failed.push({ seriesId: plan.request.seriesId, code: plan.problem?.code ?? 'INVALID', message: plan.problem?.message ?? 'It can’t be entered.' })
        continue
      }
      try {
        const transaction = await this.deps.accounts.transactions(plan.account.id).create(plan.draft)
        await this.recordEntry(plan, transaction, calendar)
        entered.push({
          seriesId: plan.series.id, transactionId: transaction.id, accountId: plan.account.id,
          date: transaction.date, amount: transaction.amount
        })
        accounts.push(plan.account.id, ...(plan.draft.transferAccountId !== undefined ? [plan.draft.transferAccountId] : []))
        updated.push(plan.series.id)
      } catch (err) {
        const problem = translate(err)
        const { code, message } = isRecurringError(problem)
          ? problem
          : { code: 'INVALID' as const, message: (problem as Error)?.message ?? 'It could not be entered.' }
        this.deps.log.warn(`[recurring] Could not enter “${plan.series.name}”: ${message}`)
        failed.push({ seriesId: plan.series.id, code, message })
      }
    }

    if (entered.length > 0) this.changes.fire(change({ updated, accounts }))
    return { entered, failed }
  }

  private confirmationMessage(reasons: RecurringConfirmation[]): string {
    const parts = reasons.map(reason => reason === 'possibleDuplicate'
      ? 'One of these is already in the register, with the same date and amount.'
      : 'One of these is dated more than a year from today.')
    return `${parts.join(' ')} Enter it anyway?`
  }

  /** Checks one request and builds its draft, or says why it can't be entered. Writes nothing. */
  private async plan(request: EnterRequest, calendar: BusinessCalendar): Promise<Planned> {
    const seriesId = (request ?? {}).seriesId
    const series = typeof seriesId === 'string' ? await this.get(seriesId) : undefined
    if (!series) {
      return {
        request: request ?? { seriesId: '' }, series: { id: String(seriesId ?? '') } as Series, needs: [],
        problem: { code: 'NOT_FOUND', message: 'That recurring transaction no longer exists.' }
      }
    }

    const fail = (code: RecurringError['code'], message: string): Planned => ({ request, series, needs: [], problem: { code, message } })
    if (series.paused) return fail('SERIES_PAUSED', `“${series.name}” is paused. Resume it to enter it.`)
    if (series.nextDate === null || series.endedOn !== undefined) return fail('SERIES_ENDED', `“${series.name}” has finished: there is nothing left to enter.`)

    let account: Account
    try {
      account = await this.openAccount(series.accountId)
      await this.checkTransfer(series.template, account)
    } catch (err) {
      const problem = translate(err)
      return isRecurringError(problem) ? fail(problem.code, problem.message) : fail('INVALID', (problem as Error)?.message ?? 'It can’t be entered.')
    }

    const occurrence = occurrenceAt(series.schedule, series.nextIndex, calendar)
    if (!occurrence) return fail('SERIES_ENDED', `“${series.name}” has finished: there is nothing left to enter.`)

    const date = typeof request.date === 'string' ? request.date : occurrence.date
    const amount = typeof request.amount === 'number' ? request.amount : series.template.amount
    const number = typeof request.number === 'string' && request.number.trim() !== ''
      ? request.number.trim()
      : series.template.autoNumber
        ? await this.deps.accounts.transactions(account.id).nextNumber().catch(() => undefined)
        : series.template.number
    const memo = typeof request.memo === 'string' ? request.memo : series.template.memo

    const draft: TransactionDraft = {
      date,
      amount,
      ...(series.template.payee !== undefined && { payee: series.template.payee }),
      ...(memo !== undefined && memo !== '' && { memo }),
      ...(number !== undefined && { number }),
      ...(series.template.categoryId !== undefined && { categoryId: series.template.categoryId }),
      ...(series.template.transferAccountId !== undefined && { transferAccountId: series.template.transferAccountId })
    }

    return { request, series, account, draft, needs: await this.confirmationsFor(account.id, draft) }
  }

  /** What the user should be asked about before this draft is written. */
  private async confirmationsFor(accountId: string, draft: TransactionDraft): Promise<RecurringConfirmation[]> {
    const needs: RecurringConfirmation[] = []
    const today = this.today()
    if (draft.date < addIsoDays(today, -UNUSUAL_DAYS) || draft.date > addIsoDays(today, UNUSUAL_DAYS)) needs.push('unusualDate')

    // The same account, date and amount already there: most likely this occurrence was entered by hand
    const sameDay = await this.deps.accounts.transactions(accountId).list({ from: draft.date, to: draft.date }).catch(() => [])
    if (sameDay.some(t => !t.voided && t.amount === draft.amount)) needs.push('possibleDuplicate')
    return needs
  }

  /** The posting and the series' advance, in one storage transaction: both are this plugin's own collections. */
  private async recordEntry(plan: Planned, transaction: Transaction, calendar: BusinessCalendar): Promise<void> {
    const { series } = plan
    await this.db().transaction(async tx => {
      const c = this.c(tx)
      const stored = await c.series.get(series.id)
      if (!stored) return
      await c.postings.insert({
        seriesId: series.id, accountId: transaction.accountId, index: series.nextIndex,
        dueDate: occurrenceAt(series.schedule, series.nextIndex, calendar)?.date ?? transaction.date,
        outcome: 'entered', transactionId: transaction.id, date: transaction.date, amount: transaction.amount, at: this.now()
      })
      await c.series.replace({ id: series.id, ...this.advanced(stored, { lastEnteredDate: transaction.date, entered: true }, calendar) })
    }).catch(err => {
      // The transaction is in the register; the series did not move. The duplicate check catches it next time
      this.deps.log.error(`[recurring] Entered “${series.name}” but could not advance it`, err)
      throw err
    })

    if (plan.request.updateEstimate === true && series.template.estimated) {
      await this.write(async c => {
        const stored = await c.series.get(series.id)
        if (stored) {
          await c.series.replace({
            ...stored,
            template: { ...stored.template, amount: transaction.amount },
            updatedAt: this.now()
          })
        }
        return series.id
      }, id => ({ updated: [id] }))
    }
  }

  /** A stored series moved on one occurrence. */
  private advanced(stored: Doc<StoredSeries>, how: { lastEnteredDate?: string, entered: boolean }, calendar: BusinessCalendar): StoredSeries {
    const nextIndex = stored.nextIndex + 1
    const next = occurrenceAt(stored.schedule, nextIndex, calendar)
    const { id: _id, rev: _rev, endedOn: _ended, ...rest } = stored
    return {
      ...rest,
      nextIndex,
      nextDate: next?.date ?? null,
      enteredCount: stored.enteredCount + (how.entered ? 1 : 0),
      skippedCount: stored.skippedCount + (how.entered ? 0 : 1),
      ...(how.lastEnteredDate !== undefined ? { lastEnteredDate: how.lastEnteredDate } : stored.lastEnteredDate !== undefined ? { lastEnteredDate: stored.lastEnteredDate } : {}),
      ...(next === undefined && { endedOn: this.today() }),
      updatedAt: this.now()
    }
  }

  /** Passes over the next occurrence (or `count` of them) without writing anything, recording why it moved. */
  async skip(ids: string[], options: { count?: number } = {}): Promise<void> {
    const wanted = this.idsOf(ids)
    const count = Math.max(1, Math.trunc(options.count ?? 1))
    await this.write(async c => {
      const calendar = await this.calendar(c)
      const touched: string[] = []
      for (const id of wanted) {
        const series = await c.series.get(id)
        if (!series) continue
        if (series.nextDate === null || series.endedOn !== undefined) {
          throw new RecurringError('SERIES_ENDED', `“${series.name}” has finished: there is nothing left to skip.`)
        }
        let at = series
        for (let step = 0; step < count && at.nextDate !== null; step++) {
          await c.postings.insert({
            seriesId: id, accountId: at.accountId, index: at.nextIndex, dueDate: at.nextDate,
            outcome: 'skipped', at: this.now()
          })
          at = { ...at, ...this.advanced(at, { entered: false }, calendar) }
        }
        await c.series.replace({ id, ...this.stripDoc(at) })
        touched.push(id)
      }
      return touched
    }, updated => ({ updated }))
  }

  private stripDoc(doc: Doc<StoredSeries>): StoredSeries {
    const { id: _id, rev: _rev, ...rest } = doc
    return rest
  }

  private idsOf(ids: string[]): string[] {
    if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) throw invalid('ids', 'Choose the recurring transactions.')
    return [...new Set(ids)]
  }

  private async require(id: string): Promise<Series> {
    const series = await this.get(id)
    if (!series) throw notFound()
    return series
  }

  // ---- The book's holidays

  async holidays(): Promise<Holiday[]> {
    return this.read(async c => (await c.holidays.find(undefined, { sort: { date: 1 } })).map(toHoliday))
  }

  async addHoliday(input: { date: string, name: string }): Promise<Holiday> {
    const date = input?.date
    if (!isIsoDate(date)) throw invalid('date', 'Enter the holiday’s date.')
    const name = optionalText(input.name, 'name', HOLIDAY_NAME_MAX_LENGTH) ?? 'Holiday'
    const { holiday } = await this.write(async c => {
      const added = toHoliday(await c.holidays.insert({ date, name }))
      const moved = await this.placeNextDates(c)
      return { holiday: added, moved }
    }, ({ moved }) => ({ updated: moved, holidays: true }))
    return holiday
  }

  async removeHoliday(id: string): Promise<void> {
    if (typeof id !== 'string') throw invalid('id', 'Choose the holiday.')
    await this.write(async c => {
      await c.holidays.deleteOne({ id })
      return this.placeNextDates(c)
    }, moved => ({ updated: moved, holidays: true }))
  }

  /**
   * After the holidays change, every series' stored next date is worked out again from its index — a business-day
   * rule may now move it, or no longer move it. The index is the truth; the date is only kept for sorting.
   */
  private async placeNextDates(c: Collections): Promise<string[]> {
    const calendar = await this.calendar(c)
    const moved: string[] = []
    for (const stored of await c.series.find()) {
      if (stored.nextDate === null) continue
      const next = occurrenceAt(stored.schedule, stored.nextIndex, calendar)
      const nextDate = next?.date ?? null
      if (nextDate === stored.nextDate) continue
      await c.series.replace({ ...stored, nextDate, updatedAt: this.now() })
      moved.push(stored.id)
    }
    return moved
  }

  // ---- Keeping up with the account manager

  /**
   * What to do when accounts change under us. There is no transaction across the two plugins, so this runs after
   * the account manager has committed: a series whose account has gone is removed, and one whose account closed is
   * paused with the reason, so the view can say why rather than the series quietly failing to run.
   */
  async handleAccountsChange(accountsChange: Pick<AccountsChange, 'deleted' | 'updated'>): Promise<void> {
    try {
      const deleted = new Set(accountsChange.deleted ?? [])
      const updated = accountsChange.updated ?? []
      if (deleted.size === 0 && updated.length === 0) return

      const all = await this.read(async c => (await c.series.find()).map(toSeries))
      if (all.length === 0) return

      if (deleted.size > 0) {
        const gone = all.filter(series => deleted.has(series.accountId)).map(series => series.id)
        if (gone.length > 0) await this.delete(gone)

        // A transfer's other account is not guessed at or deleted: the user decides what the series should do now
        const orphaned = all.filter(series => !deleted.has(series.accountId)
          && series.template.transferAccountId !== undefined && deleted.has(series.template.transferAccountId))
        if (orphaned.length > 0) {
          await this.write(async c => {
            for (const series of orphaned) {
              const stored = await c.series.get(series.id)
              if (!stored) continue
              const { transferAccountId: _gone, ...template } = stored.template
              await c.series.replace({
                ...stored, template, paused: true, pausedReason: 'transferAccountGone', updatedAt: this.now()
              })
            }
            return orphaned.map(series => series.id)
          }, ids => ({ updated: ids }))
        }
      }

      for (const accountId of updated) {
        const account = await this.deps.accounts.get(accountId).catch(() => undefined)
        if (!account) continue
        const mine = all.filter(series => series.accountId === accountId && !deleted.has(series.accountId))
        if (account.closed) {
          const toPause = mine.filter(series => !series.paused).map(series => series.id)
          if (toPause.length > 0) await this.pause(toPause, 'accountClosed')
        } else {
          // Only the ones this plugin paused: a series the user paused stays paused
          const toResume = mine.filter(series => series.paused && series.pausedReason === 'accountClosed').map(series => series.id)
          if (toResume.length > 0) await this.pause(toResume, undefined)
        }
      }
    } catch (err) {
      this.deps.log.error('[recurring] Could not follow a change to the accounts', err)
    }
  }
}
