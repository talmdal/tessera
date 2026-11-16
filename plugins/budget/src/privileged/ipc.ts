// The budget's views and dialogs talk to the plugin here. Writes reply with `BudgetResult`s, so a dialog shows what
// went wrong beside the field at fault and stays open.
import type { Disposable, IpcMessage, PluginContext, SettingsHandle } from '@tessera/types'
import { isAccountsError, type AccountsService, type Category } from '@tessera/accounts-api'
import {
  BUDGET_CHANNELS, BudgetError, toBudgetResult,
  type AddLineRequest, type BudgetInput, type BudgetLine, type BudgetStatus, type BudgetResult, type ChangeLineRequest, type MonthRange,
  type SaveBudgetRequest, type StatusRequest, type ViewReport,
  type Budget, type BudgetSettings, type DuplicateRequest, type FillRequest, type LineInput, type LineSuggestion, type SuggestRequest,
  type ViewOptions
} from '@tessera/budget-api'
import type { BudgetServiceImpl } from './BudgetServiceImpl'
import type { ViewState } from './viewState'

const text = (value: unknown) => typeof value === 'string' ? value : ''

export function registerIpc(
  context: PluginContext,
  service: BudgetServiceImpl,
  accounts: AccountsService,
  view: ViewState,
  settings?: Pick<SettingsHandle<BudgetSettings>, 'update'>
): Disposable[] {
  return [
    context.ipc.register(BUDGET_CHANNELS.budgets, () => view.view()),

    // The view's *More* menu: the Budget page's view settings, changed as the user would on the page
    context.ipc.register(BUDGET_CHANNELS.viewOptions, async (msg: IpcMessage<Partial<ViewOptions>>) => {
      const patch: Partial<ViewOptions> = {}
      for (const key of ['showBars', 'showEmptyLines'] as const) {
        const value = msg.data?.[key]
        if (value !== undefined && typeof value !== 'boolean') throw new Error(`${key} is true or false`)
        if (value !== undefined) patch[key] = value
      }
      if (Object.keys(patch).length > 0) await settings?.update(patch)
    }),

    context.ipc.register(BUDGET_CHANNELS.status, async (msg: IpcMessage<StatusRequest>): Promise<BudgetResult<BudgetStatus>> =>
      toBudgetResult(() => service.status(text(msg.data?.budgetId), msg.data?.months as MonthRange, { byMonth: msg.data?.byMonth === true }))),

    context.ipc.register(BUDGET_CHANNELS.suggest, async (msg: IpcMessage<SuggestRequest>): Promise<BudgetResult<LineSuggestion[]>> =>
      toBudgetResult(() => {
        const { budgetId, months, start, step } = msg.data ?? {} as Partial<SuggestRequest>
        return service.suggest(text(budgetId), { months: months as number, start: text(start), step: step as number })
      })),

    context.ipc.register(BUDGET_CHANNELS.fill, async (msg: IpcMessage<FillRequest>): Promise<BudgetResult<BudgetLine[]>> =>
      toBudgetResult(() => service.fill(text(msg.data?.budgetId), msg.data?.lines as LineInput[]))),

    context.ipc.register(BUDGET_CHANNELS.duplicate, async (msg: IpcMessage<DuplicateRequest>): Promise<BudgetResult<Budget>> =>
      toBudgetResult(() => service.duplicate(text(msg.data?.id), text(msg.data?.name)))),

    context.ipc.register(BUDGET_CHANNELS.select, async (msg: IpcMessage<ViewReport>) => {
      const report = msg.data
      if (typeof report?.budgetId !== 'string') throw new Error('A report is { budgetId, month, period, lineId? }')
      await view.report(report)
    }),

    context.ipc.register(BUDGET_CHANNELS.saveBudget, async (msg: IpcMessage<SaveBudgetRequest>) => {
      const { id, input, expectedRev } = msg.data ?? {} as Partial<SaveBudgetRequest>
      return toBudgetResult(() => {
        if (typeof input !== 'object' || input === null) throw new BudgetError('INVALID', 'Enter the budget’s details.', 'name')
        if (typeof id !== 'string') return service.create(input)
        // The whole form: notes it leaves out were emptied, so they are cleared
        const patch: BudgetInput = { ...input, notes: input.notes ?? '' }
        return service.update(id, patch, typeof expectedRev === 'number' ? { expectedRev } : {})
      })
    }),

    context.ipc.register(BUDGET_CHANNELS.addLine, async (msg: IpcMessage<AddLineRequest>) =>
      toBudgetResult(() => service.addLine(text(msg.data?.budgetId), msg.data?.input))),

    context.ipc.register(BUDGET_CHANNELS.changeLine, async (msg: IpcMessage<ChangeLineRequest>): Promise<BudgetResult<BudgetLine>> =>
      toBudgetResult(async () => {
        const { lineId, change, notes, expectedRev } = msg.data ?? {} as Partial<ChangeLineRequest>
        const id = text(lineId)
        // The plan and the notes in one write: all of it, or none, checked against the revision the dialog started from
        if (change === undefined && notes === undefined) return service.line(id)
        return service.editLine(id, { ...(change !== undefined && { change }), ...(notes !== undefined && { notes }) },
          typeof expectedRev === 'number' ? { expectedRev } : {})
      })),

    context.ipc.register(BUDGET_CHANNELS.line, async (msg: IpcMessage<{ lineId?: string }>) =>
      toBudgetResult(() => service.line(text(msg.data?.lineId)))),

    context.ipc.register(BUDGET_CHANNELS.createCategory, async (msg: IpcMessage<{ path?: string, kind?: Category['kind'] }>) =>
      toBudgetResult(async () => {
        const kind = msg.data?.kind === 'income' ? 'income' : 'expense'
        try {
          return await accounts.categories.create(text(msg.data?.path), kind)
        } catch (err) {
          // The accounts plugin's reasons (an empty name, one too long) are the user's to see, on the For field
          if (isAccountsError(err)) throw new BudgetError(err.code === 'READ_ONLY' ? 'READ_ONLY' : 'INVALID', err.message, 'target')
          throw err
        }
      }))
  ]
}
