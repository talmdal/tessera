// The Budget menu's commands. Each takes an optional `{ id }` (the Budgets tab's or the view's context menu acting on
// an item) and otherwise acts on what the view shows and has selected. Deleting asks first, with the native
// confirmation every plugin uses.
import type { Disposable, PluginContext, ShellPrompts } from '@tessera/types'
import { LEDGER_CONTEXT_KEYS, nameKey, uniqueName, yearStartOf, type LedgerSession } from '@tessera/ledger-api'
import { ACCOUNTS_CONTEXT_KEYS, mostUsedCurrency, type AccountsService } from '@tessera/accounts-api'
import {
  BUDGET_COMMANDS as C, BUDGET_CONTEXT_KEYS as K, BUDGET_DIALOGS, BUDGET_EVENTS, BUDGET_REPORTS, BUDGET_SETTINGS_DEFAULTS, BUDGET_VIEWS,
  budgetYear, firstDayOf, isBudgetError, lastDayOf, yearToDate,
  type BudgetSettings,
  type Budget, type BudgetDialogInput, type BudgetDialogResult, type DuplicateDialogInput, type HistoryDialogInput, type BudgetItemArgs, type LineDialogInput, type LineTarget, type NewLineArgs,
  type TransactionsArgs, type TransactionsDialogInput
} from '@tessera/budget-api'
import { REPORTS_COMMANDS } from '@tessera/reports-api'
import type { BudgetServiceImpl } from './BudgetServiceImpl'
import type { BudgetViewSupport } from './viewSupport'
import { local, type ViewState } from './viewState'

const WRITABLE = `${LEDGER_CONTEXT_KEYS.isOpen} && !${LEDGER_CONTEXT_KEYS.isReadOnly}`
const SHOWN = `${LEDGER_CONTEXT_KEYS.isOpen} && ${K.shown}`
const SHOWN_WRITABLE = `${WRITABLE} && ${K.shown}`
const LINE_WRITABLE = `${WRITABLE} && ${K.lineSelected}`

const idOf = (args: unknown) => {
  const id = (args as BudgetItemArgs | undefined)?.id
  return typeof id === 'string' && id !== '' ? id : undefined
}

export function registerCommands(
  context: PluginContext,
  service: BudgetServiceImpl,
  views: BudgetViewSupport,
  accounts: AccountsService,
  session: LedgerSession,
  view: ViewState,
  prompts: ShellPrompts,
  settings: () => BudgetSettings = () => BUDGET_SETTINGS_DEFAULTS
): Disposable[] {
  const attempt = async <T>(doing: string, work: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await work()
    } catch (err) {
      if (!isBudgetError(err)) context.logger.error(`[budget] ${doing} failed`, err)
      await prompts.message({ kind: 'error', message: `Could not ${doing}.`, detail: err instanceof Error ? err.message : String(err) })
      return undefined
    }
  }

  const reveal = async (viewId: string) => {
    if (context.commands.has('shell.layout.reveal')) await context.commands.execute('shell.layout.reveal', viewId).catch(() => undefined)
  }

  /** The budget a command acts on: the argument's, else the one shown. */
  const targetBudget = async (args: unknown): Promise<Budget | undefined> => {
    const id = idOf(args) ?? view.get().shown ?? undefined
    return id === undefined ? undefined : service.get(id)
  }

  /** What the budget dialog needs: the tree, and every account's place and currency. */
  const budgetDialog = async (budget?: Budget): Promise<BudgetDialogInput> => {
    const [tree, all] = await Promise.all([session.tree(), accounts.list()])
    const scopeAccounts = all.map(a => ({ id: a.id, name: a.name, subLedgerId: a.subLedgerId, currency: a.currency, closed: a.closed }))
    // A new budget covers the sub-ledger selected in the Accounts navigator, if one is, else the whole ledger
    const selected = context.contextKeys.get(ACCOUNTS_CONTEXT_KEYS.selectionKind) === 'subLedger' ? context.contextKeys.get(ACCOUNTS_CONTEXT_KEYS.selectionId) : undefined
    const subLedgerId = typeof selected === 'string' && tree.subLedgers.some(s => s.id === selected) ? selected : null
    // A new budget's year starts in the month the ledger's does (File › Ledger Properties…); a budget keeps its own
    const yearStartMonth = yearStartOf(tree.ledger).month
    // Budget Properties…: what a new scope or currency would do to the lines, for the dialog to say before saving
    const lines = budget ? await service.lines(budget.id) : []
    const transferLines = lines.flatMap(({ target }) => {
      if (target.kind !== 'transfer') return []
      const name = all.find(a => a.id === target.accountId)?.name ?? '(deleted account)'
      return [{ accountId: target.accountId, label: `${target.direction === 'in' ? 'Transfers from' : 'Transfers to'} ${name}` }]
    })
    return {
      ...(budget && { budget, lineCount: lines.length, transferLines }),
      ledgerName: tree.ledger.name,
      subLedgers: tree.subLedgers.map(s => ({ id: s.id, parentId: s.parentId, name: s.name, order: s.order })),
      accounts: scopeAccounts, subLedgerId, yearStartMonth, defaultCurrency: mostUsedCurrency(scopeAccounts, 'CAD')
    }
  }

  /** Fill from History, for a budget: from the month the view shows, over the months and to the step the Budget page says. */
  const fillFromHistory = async (budgetId: string) => {
    const budget = await service.get(budgetId)
    if (!budget) return undefined
    const { historyMonths, roundTo } = settings()
    const input: HistoryDialogInput = { budget, start: view.get().month, months: historyMonths, roundTo }
    return prompts.show<{ count: number }>(BUDGET_DIALOGS.history, input, { title: `Fill “${budget.name}” from History` })
  }

  /** Tells the view to select a line a command added or changed. */
  const selectLine = (budgetId: string, lineId: string) => context.events.emit(local(BUDGET_EVENTS.line), { budgetId, lineId })

  return [
    context.commands.register(C.newBudget, async () => {
      const created = await prompts.show<BudgetDialogResult>(BUDGET_DIALOGS.budget, await budgetDialog())
      if (created) {
        await view.show(created.id)
        await reveal(BUDGET_VIEWS.view)
        // *Amounts from my last 12 months*: the new budget, straight into Fill from History
        if (created.fill) await fillFromHistory(created.id)
      }
      return created ? { id: created.id } : undefined
    }, { enablement: WRITABLE }),

    context.commands.register(C.show, async (args?: unknown) => {
      const explicit = idOf(args)
      if (explicit !== undefined) {
        if (!(await service.get(explicit))) return false
        await view.show(explicit)
      }
      await reveal(BUDGET_VIEWS.view)
      return true
    }, { enablement: LEDGER_CONTEXT_KEYS.isOpen }),

    context.commands.register(C.properties, async (args?: unknown) => {
      const budget = await targetBudget(args)
      if (!budget) return undefined
      return prompts.show<{ id: string }>(BUDGET_DIALOGS.budget, await budgetDialog(budget), { title: 'Budget Properties' })
    }, { enablement: SHOWN_WRITABLE }),

    context.commands.register(C.deleteBudget, async (args?: unknown) => {
      const budget = await targetBudget(args)
      if (!budget) return false
      const count = (await service.lines(budget.id)).length
      const confirmed = await prompts.confirm({
        message: count === 0 ? `Delete the budget “${budget.name}”?` : `Delete the budget “${budget.name}” and its ${count === 1 ? 'line' : `${count} lines`}?`,
        detail: 'Your transactions aren’t affected. This can’t be undone.',
        confirmLabel: 'Delete Budget',
        destructive: true
      })
      if (!confirmed) return false
      return (await attempt('delete the budget', async () => { await service.delete(budget.id); return true })) === true
    }, { enablement: SHOWN_WRITABLE }),

    context.commands.register(C.duplicate, async (args?: unknown) => {
      const budget = await targetBudget(args)
      if (!budget) return undefined
      const taken = new Set((await service.list()).map(b => nameKey(b.name)))
      const input: DuplicateDialogInput = { budget, name: uniqueName(budget.name, taken) }
      const copy = await prompts.show<{ id: string }>(BUDGET_DIALOGS.duplicate, input, { title: `Duplicate “${budget.name}”` })
      if (copy) {
        await view.show(copy.id)
        await reveal(BUDGET_VIEWS.view)
      }
      return copy
    }, { enablement: SHOWN_WRITABLE }),

    context.commands.register(C.fillFromHistory, async (args?: unknown) => {
      const budget = await targetBudget(args)
      return budget ? fillFromHistory(budget.id) : undefined
    }, { enablement: SHOWN_WRITABLE }),

    context.commands.register(C.newLine, async (args?: unknown) => {
      const { shown, month } = view.get()
      const budget = shown === null ? undefined : await service.get(shown)
      if (!budget) return undefined
      const choices = await views.targets(budget.id)
      const wanted = (args as NewLineArgs | undefined)?.target
      const preset = wanted && choices.find(c => sameTarget(c.target, wanted))
      const input: LineDialogInput = {
        budget, month, choices, canCreateCategory: true,
        ...(preset && { target: preset.target, label: preset.label, group: preset.group })
      }
      const added = await prompts.show<{ id: string }>(BUDGET_DIALOGS.line, input)
      if (added) selectLine(budget.id, added.id)
      return added
    }, { enablement: SHOWN_WRITABLE }),

    context.commands.register(C.editLine, async (args?: unknown) => {
      const id = idOf(args) ?? view.get().lineId
      if (id === undefined) return undefined
      const line = await service.line(id).catch(() => undefined)
      const budget = line && await service.get(line.budgetId)
      if (!line || !budget) return undefined
      const { label, group } = await views.describeLine(line)
      const input: LineDialogInput = { budget, month: view.get().month, line, label, group }
      const changed = await prompts.show<{ id: string }>(BUDGET_DIALOGS.line, input, { title: `Edit Line: ${label}` })
      if (changed) selectLine(budget.id, changed.id)
      return changed
    }, { enablement: LINE_WRITABLE }),

    context.commands.register(C.deleteLine, async (args?: unknown) => {
      const id = idOf(args) ?? view.get().lineId
      if (id === undefined) return false
      const line = await service.line(id).catch(() => undefined)
      if (!line) return false
      const { label, group } = await views.describeLine(line)
      const confirmed = await prompts.confirm({
        message: `Delete the line “${label}”?`,
        detail: `Its plan goes. Its transactions aren’t affected: they count toward a parent’s line, or ${group === 'income' ? 'Other income' : 'Other expenses'}.`,
        confirmLabel: 'Delete Line',
        destructive: true
      })
      if (!confirmed) return false
      return (await attempt('delete the line', async () => { await service.deleteLine(id); return true })) === true
    }, { enablement: LINE_WRITABLE }),

    context.commands.register(C.transactions, async (args?: unknown) => {
      const request = args as TransactionsArgs | undefined
      if (typeof request?.budgetId !== 'string' || typeof request.row !== 'object' || request.row === null) return undefined
      const budget = await service.get(request.budgetId)
      if (!budget) return undefined
      const found = await attempt('list the transactions', () => views.rowTransactions(budget.id, request.row, request.months))
      if (!found) return undefined
      const input: TransactionsDialogInput = {
        row: String(request.label ?? ''), period: String(request.period ?? ''), currency: budget.currency, ...found
      }
      await prompts.show(BUDGET_DIALOGS.transactions, input, { title: `Transactions: ${input.row}` })
      return true
    }, { enablement: SHOWN }),

    // The budget shown, over the months shown, as Budget vs Actual in the report view: through the reports plugin's
    // command, when it is there
    context.commands.register(C.showReport, async (args?: unknown) => {
      if (!context.commands.has(REPORTS_COMMANDS.show)) return false
      const budget = await targetBudget(args)
      if (!budget) return false
      const { month, period } = view.get()
      const range = period === 'yearToDate' ? yearToDate(month, budget.yearStartMonth) : period === 'year' ? budgetYear(month, budget.yearStartMonth) : { from: month, to: month }
      return context.commands.execute(REPORTS_COMMANDS.show, {
        definitionId: BUDGET_REPORTS.vsActual,
        parameters: { source: { budget: budget.id }, period: { from: firstDayOf(range.from), to: lastDayOf(range.to) } }
      })
    }, { enablement: SHOWN })
  ]
}

export function sameTarget(a: LineTarget, b: LineTarget): boolean {
  return a.kind === 'category'
    ? b.kind === 'category' && a.categoryId === b.categoryId
    : b.kind === 'transfer' && a.accountId === b.accountId && a.direction === b.direction
}
