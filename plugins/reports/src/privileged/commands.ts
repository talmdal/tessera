// The Reports menu's commands, and those other plugins run: Show Reports (the tab), Show (a report, from anywhere),
// Refresh, and Show Transactions (the dialog behind a figure); and (R4) Customise Report…, Save Report, Save Report
// As…, and a saved report's Rename…, Duplicate… and Delete…. Each acts on what the view shows, or on a saved report
// named in its argument (the Reports tab's context menu). A definition's own menu command is registered as it is
// contributed (menu.ts).
import type { Disposable, PluginContext, ShellPrompts } from '@tessera/types'
import { LEDGER_CONTEXT_KEYS, nameKey, uniqueName } from '@tessera/ledger-api'
import {
  REPORTS_COMMANDS as C, REPORTS_CONTEXT_KEYS as K, REPORTS_DIALOGS, REPORTS_EVENTS, REPORTS_VIEWS, TOP_OPTION, isReportsError,
  type CustomiseDialogInput, type CustomiseResult, type ReportRef, type SaveDialogInput, type SavedReport, type ShowArgs, type StaleEvent,
  type TransactionsArgs, type TransactionsDialogInput
} from '@tessera/reports-api'
import type { ReportsServiceImpl } from './ReportsServiceImpl'
import { basisOf, viewOf } from './saving'
import { local, type ViewState } from './viewState'

const SHOWN = `${LEDGER_CONTEXT_KEYS.isOpen} && ${K.shown}`
const WRITABLE = `${LEDGER_CONTEXT_KEYS.isOpen} && !${LEDGER_CONTEXT_KEYS.isReadOnly}`

/** A saved report's id from a command's argument (`{ id }`), or undefined. */
const idOf = (args: unknown) => {
  const id = (args as { id?: unknown } | undefined)?.id
  return typeof id === 'string' && id !== '' ? id : undefined
}

/** A `ReportRef` from a command's argument, or undefined. */
export function refOf(args: unknown): ReportRef | undefined {
  if (typeof args !== 'object' || args === null) return undefined
  const { definitionId, savedId } = args as { definitionId?: unknown, savedId?: unknown }
  if (typeof definitionId === 'string' && definitionId !== '') return { definitionId }
  if (typeof savedId === 'string' && savedId !== '') return { savedId }
  return undefined
}

export function registerCommands(
  context: PluginContext,
  service: ReportsServiceImpl,
  view: ViewState,
  prompts: ShellPrompts
): { disposables: Disposable[], show: (ref: ReportRef, parameters?: ShowArgs['parameters']) => Promise<boolean> } {
  const reveal = async (viewId: string) => {
    if (context.commands.has('shell.layout.reveal')) await context.commands.execute('shell.layout.reveal', viewId).catch(() => undefined)
  }

  /** Shows a report, if there is such a one: a definition offered, or a saved report in the open ledger. */
  const show = async (ref: ReportRef, parameters?: ShowArgs['parameters']): Promise<boolean> => {
    const exists = 'definitionId' in ref
      ? service.definitions().some(d => d.id === ref.definitionId)
      : (await service.saved().catch(() => [])).some(s => s.id === ref.savedId)
    if (!exists) return false
    const given = typeof parameters === 'object' && parameters !== null ? parameters : undefined
    await view.show(ref, given)
    await reveal(REPORTS_VIEWS.view)
    return true
  }

  /** Reports a failure the user can't act on in a dialog, with the native message. */
  const failed = async (doing: string, err: unknown) => {
    if (!isReportsError(err)) context.logger.error(`[reports] ${doing} failed`, err)
    await prompts.message({ kind: 'error', message: `Could not ${doing}.`, detail: err instanceof Error ? err.message : String(err) })
  }

  /** The saved report a command acts on: the argument's, else the one shown. */
  const targetSaved = async (args: unknown): Promise<SavedReport | undefined> => {
    const shown = view.shownRef()
    const id = idOf(args) ?? (shown && 'savedId' in shown ? shown.savedId : undefined)
    return id === undefined ? undefined : (await service.saved()).find(s => s.id === id)
  }

  const takenNames = async () => (await service.saved()).map(s => s.name)

  const disposables = [
    context.commands.register(C.showList, async () => {
      await reveal(REPORTS_VIEWS.list)
      return true
    }, { enablement: LEDGER_CONTEXT_KEYS.isOpen }),

    context.commands.register(C.show, async (args?: unknown) => {
      const ref = refOf(args)
      return ref ? show(ref, (args as ShowArgs).parameters) : false
    }, { enablement: LEDGER_CONTEXT_KEYS.isOpen }),

    // The report shown, worked out again: the view runs it at once (it is on screen, or F5 couldn't reach it)
    context.commands.register(C.refresh, () => {
      const stale: StaleEvent = { sources: null }
      context.events.emit(local(REPORTS_EVENTS.stale), stale)
      return true
    }, { enablement: SHOWN }),

    context.commands.register(C.transactions, async (args?: unknown) => {
      const a = args as TransactionsArgs | undefined
      const ref = refOf(a?.ref)
      if (!a || !ref) return undefined
      try {
        const result = await service.transactions(ref, a.parameters ?? {}, a.options ?? {}, a.row, a.column, a.currency)
        const input: TransactionsDialogInput = {
          title: [a.label, a.columnLabel].filter(s => typeof s === 'string' && s !== '').join(' · '),
          currency: typeof a.currency === 'string' ? a.currency : null,
          figure: typeof a.figure === 'number' ? a.figure : null,
          result
        }
        await prompts.show(REPORTS_DIALOGS.transactions, input, { title: `Transactions: ${input.title}` })
        return true
      } catch (err) {
        if (!isReportsError(err)) context.logger.error('[reports] Show Transactions failed', err)
        await prompts.message({ kind: 'error', message: 'Could not list the transactions.', detail: err instanceof Error ? err.message : String(err) })
        return false
      }
    }, { enablement: SHOWN }),

    // Customise Report…: the report as shown, its options and the general ones; applied by showing it so. Nothing saved
    context.commands.register(C.customise, async () => {
      const current = view.get()
      if (!current) return undefined
      const r = await service.resolve(current.ref, current.parameters, current.options ?? {})
      const saved = 'savedId' in current.ref ? (await service.saved()).find(s => s.id === (current.ref as { savedId: string }).savedId) : undefined
      const definitionId = 'definitionId' in current.ref ? current.ref.definitionId : saved?.basis.kind === 'definition' ? saved.basis.definitionId : undefined
      const definition = definitionId === undefined ? undefined : service.registry.offeredById(definitionId)?.definition
      const chosenTop = r.options[TOP_OPTION]
      const input: CustomiseDialogInput = {
        title: r.title,
        options: (definition?.options ?? []).map(o => ({
          key: o.key, label: o.label, ...(o.description && { description: o.description }), kind: o.kind,
          ...(o.choices && { choices: o.choices.map(c => ({ value: c.value, label: c.label })) }), default: o.default, value: r.options[o.key] ?? o.default
        })),
        ...(r.topDefault !== undefined && {
          top: { value: chosenTop === 'all' ? 'all' : typeof chosenTop === 'string' ? Number(chosenTop) : r.topDefault, default: r.topDefault }
        }),
        ...(r.spec.presentation.chart && { show: current.view?.show ?? r.spec.presentation.show })
      }
      const result = await prompts.show<CustomiseResult>(REPORTS_DIALOGS.customise, input, { title: `Customise “${r.title}”` })
      if (!result) return false
      await view.show(current.ref, current.parameters, result.options, result.show)
      return true
    }, { enablement: SHOWN }),

    // Save Report: the saved report shown, as it is shown now; refused if it changed elsewhere since it was opened
    context.commands.register(C.save, async () => {
      const current = view.get()
      const saved = await targetSaved(undefined)
      if (!current || !saved || !('savedId' in current.ref)) return false
      try {
        const patch = { basis: basisOf(saved, current.options ?? {}), parameters: current.parameters, view: viewOf(current.view) }
        // Over the report as it was when shown: a change made elsewhere since is refused, not overwritten
        const updated = await service.updateReport(saved.id, patch, { expectedRev: view.shownRev(saved.id) ?? saved.rev })
        view.savedAt(saved.id, updated.rev)
        await view.savedChanged()
        return true
      } catch (err) {
        if (isReportsError(err) && err.code === 'CONFLICT') {
          await prompts.message({ kind: 'warning', message: `“${saved.name}” was changed elsewhere since it was opened.`, detail: 'Show it again to see how it is saved now, or use Save Report As… to keep this one too.' })
          return false
        }
        await failed('save the report', err)
        return false
      }
    }, { enablement: `${WRITABLE} && ${K.shownSaved} && ${K.changed}` }),

    // Save Report As…: a name, then the report as shown is saved under it, and shown
    context.commands.register(C.saveAs, async () => {
      const current = view.get()
      if (!current) return undefined
      const r = await service.resolve(current.ref, current.parameters, current.options ?? {})
      const taken = await takenNames()
      const input: SaveDialogInput = {
        mode: 'saveAs', report: { ...current, name: '' }, name: uniqueName(r.title, new Set(taken.map(nameKey))), taken
      }
      const created = await prompts.show<{ id: string }>(REPORTS_DIALOGS.save, input, { title: 'Save Report As' })
      if (!created) return undefined
      await show({ savedId: created.id })
      return created
    }, { enablement: `${WRITABLE} && ${K.shown}` }),

    context.commands.register(C.rename, async (args?: unknown) => {
      const saved = await targetSaved(args)
      if (!saved) return undefined
      const input: SaveDialogInput = { mode: 'rename', id: saved.id, rev: saved.rev, name: saved.name, taken: (await takenNames()).filter(n => n !== saved.name) }
      const renamed = await prompts.show<{ id: string }>(REPORTS_DIALOGS.save, input, { title: `Rename “${saved.name}”` })
      if (renamed) {
        // Renamed here, so no change made elsewhere: the revision Save Report expects moves on with it
        const now = (await service.saved()).find(s => s.id === saved.id)
        if (now && view.shownRev(saved.id) === saved.rev) view.savedAt(saved.id, now.rev)
        await view.savedChanged()
      }
      return renamed
    }, { enablement: WRITABLE }),

    context.commands.register(C.duplicate, async (args?: unknown) => {
      const saved = await targetSaved(args)
      if (!saved) return undefined
      const taken = await takenNames()
      const input: SaveDialogInput = { mode: 'duplicate', id: saved.id, name: uniqueName(saved.name, new Set(taken.map(nameKey))), taken }
      const copy = await prompts.show<{ id: string }>(REPORTS_DIALOGS.save, input, { title: `Duplicate “${saved.name}”` })
      if (copy) await show({ savedId: copy.id })
      return copy
    }, { enablement: WRITABLE }),

    context.commands.register(C.deleteSaved, async (args?: unknown) => {
      const saved = await targetSaved(args)
      if (!saved) return false
      const confirmed = await prompts.confirm({
        message: `Delete the saved report “${saved.name}”?`,
        detail: 'Your transactions aren’t affected, and the report it was made from stays. This can’t be undone.',
        confirmLabel: 'Delete Report',
        destructive: true
      })
      if (!confirmed) return false
      try {
        await service.deleteReport(saved.id)
        return true
      } catch (err) {
        await failed('delete the report', err)
        return false
      }
    }, { enablement: WRITABLE })
  ]
  return { disposables, show }
}
