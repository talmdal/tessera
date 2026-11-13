// The commands behind the Recurring view and the Accounts menu. Each takes what to act on as an argument: the
// view sends its selection, so nothing has to be mirrored into the main process as a context key.
//
// Everything that changes a series goes through `recurring.service`, and everything that asks the user goes
// through `shell.prompts`, so the view stays a view.
import type { Disposable, PluginContext, ShellPrompts } from '@tessera/types'
import { BOOK_CONTEXT_KEYS } from '@tessera/book-api'
import {
  ACCOUNTS_SERVICE,
  type Account, type AccountsService, type RegisterFigure, type RegisterFigureArgs, type TransactionActionArgs
} from '@tessera/accounts-api'
import {
  DEFAULT_HORIZON_DAYS, LATE_STATES, RECURRING_COMMANDS, RECURRING_CONTEXT_KEYS as K, RECURRING_DIALOGS, RECURRING_EVENTS,
  RECURRING_VIEWS, addIsoDays, isRecurringError,
  type EnterArgs, type EnterDialogInput, type EnterDialogRow, type EnterRequest, type EnterResult, type HolidaysDialogInput,
  type NewSeriesArgs, type RecurringConfirmation, type SeriesArgs, type SeriesDialogInput, type SkipArgs
} from '@tessera/recurring-api'
import type { RecurringServiceImpl } from './RecurringServiceImpl'
import { local } from './ipc'

const WRITABLE = `${BOOK_CONTEXT_KEYS.isOpen} && !${BOOK_CONTEXT_KEYS.isReadOnly}`

/** How many times a single Enter will go back to the user for a confirmation before giving up. */
const MAX_CONFIRMATION_ROUNDS = 3

const idsOf = (args: unknown): string[] => {
  const ids = (args as SeriesArgs | undefined)?.ids
  return Array.isArray(ids) ? ids.filter(id => typeof id === 'string') : []
}

export function registerCommands(
  context: PluginContext,
  service: RecurringServiceImpl,
  prompts: ShellPrompts
): Disposable[] {
  const accounts = context.services.get<AccountsService>(ACCOUNTS_SERVICE)

  const attempt = async <T>(doing: string, work: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await work()
    } catch (err) {
      if (!isRecurringError(err)) context.logger.error(`[recurring] ${doing} failed`, err)
      await prompts.message({ kind: 'error', message: `Could not ${doing}.`, detail: err instanceof Error ? err.message : String(err) })
      return undefined
    }
  }

  const reveal = async (viewId: string) => {
    if (context.commands.has('shell.layout.reveal')) await context.commands.execute('shell.layout.reveal', viewId).catch(() => undefined)
  }

  /** Everything the series dialog needs to offer: the chart, the categories, the holidays, and the plugin's today. */
  const dialogBasics = async (): Promise<Pick<SeriesDialogInput, 'chart' | 'categories' | 'today' | 'holidays'>> => {
    const [chart, categories, holidays, snapshot] = await Promise.all([
      accounts.chart(), accounts.categories.list(), service.holidays(), service.snapshot()
    ])
    return { chart, categories, holidays: holidays.map(h => h.date), today: snapshot.today }
  }

  /** Enters, asking once for each confirmation the service wants, and giving up if the user says no. */
  const enterWithConfirmations = async (requests: EnterRequest[]): Promise<EnterResult | undefined> => {
    const confirm: RecurringConfirmation[] = []
    for (let round = 0; round <= MAX_CONFIRMATION_ROUNDS; round++) {
      try {
        return await service.enter(requests, { confirm })
      } catch (err) {
        if (!isRecurringError(err) || err.code !== 'CONFIRMATION_REQUIRED' || !err.reasons) throw err
        const yes = await prompts.confirm({
          message: 'Enter it anyway?',
          detail: err.message,
          confirmLabel: 'Enter'
        })
        if (!yes) return undefined
        confirm.push(...err.reasons)
      }
    }
    return undefined
  }

  /** The rows the enter dialog shows: one per occurrence, pre-filled with what would be written. */
  const enterRowsFor = async (ids: readonly string[]): Promise<EnterDialogInput | undefined> => {
    const snapshot = await service.snapshot({ includePaused: true, includeEnded: true })
    const wanted = new Set(ids)
    const rows: EnterDialogRow[] = []
    const accountIds = new Set<string>()

    for (const row of snapshot.rows) {
      if (!wanted.has(row.series.id) || row.blockedReason !== undefined) continue
      if (row.state === 'paused' || row.state === 'ended' || !row.occurrence) continue
      const { series } = row
      const suggested = series.template.autoNumber
        ? await accounts.transactions(series.accountId).nextNumber().catch(() => undefined)
        : undefined
      rows.push({
        row,
        request: {
          seriesId: series.id,
          amount: series.template.amount,
          date: row.occurrence.date,
          ...(suggested ?? series.template.number ? { number: suggested ?? series.template.number } : {}),
          ...(series.template.memo !== undefined && { memo: series.template.memo })
        },
        ...(suggested !== undefined && { suggestedNumber: suggested })
      })
      accountIds.add(series.accountId)
    }
    if (rows.length === 0) return undefined

    const all = await accounts.list({ includeClosed: true })
    return { rows, accounts: all.filter((a: Account) => accountIds.has(a.id)) }
  }

  return [
    context.commands.register(RECURRING_COMMANDS.open, () => reveal(RECURRING_VIEWS.list),
      { enablement: BOOK_CONTEXT_KEYS.isOpen }),

    // ---- Creating and changing

    context.commands.register(RECURRING_COMMANDS.new, async (args?: unknown) => {
      const accountId = (args as NewSeriesArgs | undefined)?.accountId
      const basics = await dialogBasics()
      const input: SeriesDialogInput = { ...basics, mode: 'create', ...(accountId !== undefined && { accountId }) }
      const created = await prompts.show<{ id: string }>(RECURRING_DIALOGS.series, input)
      if (created) await reveal(RECURRING_VIEWS.list)
      return created
    }, { enablement: WRITABLE }),

    /**
     * Make Recurring… in a register row's context menu. The transaction is left exactly as it is: it only fills
     * the dialog in, and is recorded afterwards as the new series' last entry, so the schedule starts after it.
     */
    context.commands.register(RECURRING_COMMANDS.fromTransaction, async (args?: unknown) => {
      const { accountId, transactionIds } = (args ?? {}) as TransactionActionArgs
      const transactionId = Array.isArray(transactionIds) ? transactionIds[0] : undefined
      if (typeof accountId !== 'string' || typeof transactionId !== 'string') return undefined

      const from = await attempt('read that transaction', () => service.templateFrom(accountId, transactionId))
      if (!from) return undefined

      const basics = await dialogBasics()
      const input: SeriesDialogInput = {
        ...basics, mode: 'fromTransaction', accountId, transactionId,
        template: from.template,
        // A sensible first guess: the same day of each month, anchored on the transaction's own date
        schedule: { frequency: 'monthly', interval: 1, startDate: from.date },
        sourceDate: from.date
      }
      const created = await prompts.show<{ id: string }>(RECURRING_DIALOGS.series, input, { title: 'Make Recurring' })
      if (created) await reveal(RECURRING_VIEWS.list)
      return created
    }, { enablement: WRITABLE }),

    context.commands.register(RECURRING_COMMANDS.edit, async (args?: unknown) => {
      const [id] = idsOf(args)
      const series = id === undefined ? undefined : await service.get(id)
      if (!series) return undefined
      const basics = await dialogBasics()
      const input: SeriesDialogInput = { ...basics, mode: 'edit', series }
      return prompts.show<{ id: string }>(RECURRING_DIALOGS.series, input, { title: 'Edit Recurring Transaction' })
    }, { enablement: WRITABLE }),

    context.commands.register(RECURRING_COMMANDS.delete, async (args?: unknown) => {
      const ids = idsOf(args)
      if (ids.length === 0) return false
      const names = (await Promise.all(ids.map(id => service.get(id)))).filter(Boolean)
      if (names.length === 0) return false
      const confirmed = await prompts.confirm({
        message: names.length === 1 ? `Delete “${names[0]!.name}”?` : `Delete ${names.length} recurring transactions?`,
        detail: 'The transactions already entered stay in their registers. This can’t be undone.',
        confirmLabel: 'Delete',
        destructive: true
      })
      if (!confirmed) return false
      return (await attempt('delete it', async () => { await service.delete(ids); return true })) ?? false
    }, { enablement: WRITABLE }),

    // ---- Entering and skipping

    context.commands.register(RECURRING_COMMANDS.enter, async (args?: unknown): Promise<EnterResult | undefined> => {
      const given = (args as EnterArgs | undefined)?.requests
      // Already filled in by the dialog, or still to be shown
      const requests = Array.isArray(given) && given.length > 0 ? given : await (async () => {
        const input = await enterRowsFor(idsOf(args))
        if (!input) return undefined
        return prompts.show<EnterRequest[]>(RECURRING_DIALOGS.enter, input)
      })()
      if (!requests || requests.length === 0) return undefined
      return attempt('enter it', () => enterWithConfirmations(requests).then(result => result ?? { entered: [], failed: [] }))
    }, { enablement: WRITABLE }),

    // From the menu: the view does the work, so its result is reported where the user is looking
    context.commands.register(RECURRING_COMMANDS.enterDue, async () => {
      await reveal(RECURRING_VIEWS.list)
      context.events.emit(local(RECURRING_EVENTS.enterDue), {})
      return true
    }, { enablement: `${WRITABLE} && ${K.dueCount}` }),

    context.commands.register(RECURRING_COMMANDS.skip, async (args?: unknown) => {
      const ids = idsOf(args)
      if (ids.length === 0) return false
      const count = Math.max(1, Math.trunc((args as SkipArgs | undefined)?.count ?? 1))
      const first = await service.get(ids[0])
      if (!first) return false

      const what = ids.length === 1 ? `“${first.name}”` : `${ids.length} recurring transactions`
      const when = count === 1
        ? first.nextDate === null ? '' : ` due ${first.nextDate}`
        : ` — ${count} occurrences`
      const confirmed = await prompts.confirm({
        message: `Skip ${what}${ids.length === 1 ? when : ''}?`,
        detail: 'Nothing is entered in the register, and it moves on to the next time it falls due.',
        confirmLabel: 'Skip'
      })
      if (!confirmed) return false
      return (await attempt('skip it', async () => { await service.skip(ids, { count }); return true })) ?? false
    }, { enablement: WRITABLE }),

    context.commands.register(RECURRING_COMMANDS.holidays, async () => {
      const [holidays, snapshot] = await Promise.all([service.holidays(), service.snapshot()])
      const input: HolidaysDialogInput = { holidays, today: snapshot.today }
      await prompts.show(RECURRING_DIALOGS.holidays, input)
      return true
    }, { enablement: WRITABLE }),

    /**
     * The register's projected balance, through `accounts.register.figures`: the account's balance after every
     * occurrence due in the next `DEFAULT_HORIZON_DAYS` days, transfers into it included. Nothing when nothing is
     * scheduled for the account, so the register shows no figure rather than one that merely repeats Current.
     */
    context.commands.register(RECURRING_COMMANDS.projectBalance, async (args?: unknown): Promise<RegisterFigure | undefined> => {
      const accountId = (args as RegisterFigureArgs | undefined)?.accountId
      if (typeof accountId !== 'string') return undefined
      const account = await accounts.get(accountId).catch(() => undefined)
      if (!account) return undefined

      const today = (await service.snapshot()).today
      const entries = await service.forecast({ from: today, to: addIsoDays(today, DEFAULT_HORIZON_DAYS) })
      let scheduled = 0
      let count = 0
      for (const entry of entries) {
        if (entry.accountId === accountId) { scheduled += entry.amount; count++ } else if (entry.transferAccountId === accountId) { scheduled -= entry.amount; count++ }
      }
      if (count === 0) return undefined

      const { current } = await accounts.balances(accountId)
      return {
        minor: current + scheduled,
        currency: account.currency,
        detail: `after ${count === 1 ? '1 scheduled transaction' : `${count} scheduled transactions`}`
      }
    }, { enablement: BOOK_CONTEXT_KEYS.isOpen }),

    context.commands.register(RECURRING_COMMANDS.pause, async (args?: unknown) => {
      const ids = idsOf(args)
      if (ids.length === 0) return false
      return (await attempt('pause it', async () => { await service.setPaused(ids, true); return true })) ?? false
    }, { enablement: WRITABLE }),

    context.commands.register(RECURRING_COMMANDS.resume, async (args?: unknown) => {
      const ids = idsOf(args)
      if (ids.length === 0) return false
      return (await attempt('resume it', async () => { await service.setPaused(ids, false); return true })) ?? false
    }, { enablement: WRITABLE })
  ]
}

/** The series that are due now — what *Enter Due Transactions…* acts on. Exported for the view and its tests. */
export function dueNow(rows: readonly { series: { id: string }, state: string, blockedReason?: string }[]): string[] {
  return rows
    .filter(row => (LATE_STATES as readonly string[]).includes(row.state) && row.blockedReason === undefined)
    .map(row => row.series.id)
}
