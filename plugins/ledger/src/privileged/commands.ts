// The ledger's commands: File › New, Open, Close and Delete Ledger, and the sub-ledger commands views run.
import type { Disposable, PluginContext, ShellPrompts } from '@tessera/types'
import {
  LEDGER_COMMANDS, LEDGER_CONTEXT_KEYS, LEDGER_DIALOGS, LEDGER_VIEWS, childrenOf, isLedgerError,
  type LedgerInfo, type NewLedgerArgs, type NewLedgerDialogInput, type NewLedgerDialogResult,
  type RenameSubLedgerDialogInput, type SubLedgerArgs
} from '@tessera/ledger-api'
import type { LedgerSessionImpl } from './LedgerSessionImpl'

const K = LEDGER_CONTEXT_KEYS
const WRITABLE = `${K.isOpen} && !${K.isReadOnly}`

/** Shows a failure the user caused in a message box; anything else is also logged, as a bug. */
export function reportingFailures(context: Pick<PluginContext, 'logger'>, prompts: ShellPrompts) {
  return async <T>(doing: string, work: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await work()
    } catch (err) {
      if (!isLedgerError(err)) context.logger.error(`[ledger] ${doing} failed`, err)
      await prompts.message({ kind: 'error', message: `Could not ${doing}.`, detail: err instanceof Error ? err.message : String(err) })
      return undefined
    }
  }
}

/** Shows one of the ledger's views, when the layout is there to do it. */
export function revealer(context: Pick<PluginContext, 'commands' | 'logger'>) {
  return async (viewId: string) => {
    if (!context.commands.has('shell.layout.reveal')) return
    await context.commands.execute('shell.layout.reveal', viewId)
      .catch(err => context.logger.warn(`[ledger] Could not show ${viewId}: ${err instanceof Error ? err.message : String(err)}`))
  }
}

const subLedgerId = (args: unknown) => {
  const id = (args as Partial<SubLedgerArgs> | undefined)?.id
  if (typeof id !== 'string' || id === '') throw new Error('This command needs { id } of a sub-ledger')
  return id
}

export function registerCommands(context: PluginContext, session: LedgerSessionImpl, prompts: ShellPrompts): Disposable[] {
  const attempt = reportingFailures(context, prompts)
  const reveal = revealer(context)

  /** Creates a ledger file, then shows its tree (a navigator that replaces the panel shows its own). */
  const createFile = async (name?: string) => {
    const created = await attempt('create the ledger', () => session.create(undefined, name === undefined ? {} : { name }))
    if (created && !session.hasNavigator) await reveal(LEDGER_VIEWS.tree)
    return created
  }

  return [
    context.commands.register(LEDGER_COMMANDS.new, async (args?: unknown): Promise<NewLedgerDialogResult | LedgerInfo | undefined> => {
      // With nothing open there is no parent to choose: straight to the new file
      if (!session.current) return createFile()

      const requested = (args as NewLedgerArgs | undefined)?.parentId
      const tree = await session.tree()
      const parentId = requested === undefined || requested === null || tree.subLedgers.some(s => s.id === requested) ? requested : undefined
      const input: NewLedgerDialogInput = { tree, ...(parentId !== undefined && { parentId }) }
      const result = await prompts.show<NewLedgerDialogResult>(LEDGER_DIALOGS.newLedger, input)
      if (result?.kind === 'file') return createFile(result.name)
      return result      // a sub-ledger, created by the dialog itself so it could show a duplicate name; or cancelled
    }, { enablement: `!${K.isReadOnly}` }),

    context.commands.register(LEDGER_COMMANDS.open, () => attempt('open the ledger', () => session.open())),

    context.commands.register(LEDGER_COMMANDS.close, async () => {
      await session.close()
      await reveal(LEDGER_VIEWS.start)
    }, { enablement: K.isOpen }),

    context.commands.register(LEDGER_COMMANDS.delete, async () => {
      const deleted = await attempt('delete the ledger', () => session.delete())
      if (deleted) await reveal(LEDGER_VIEWS.start)
      return deleted
    }, { enablement: WRITABLE }),

    context.commands.register(LEDGER_COMMANDS.renameSubLedger, async (args?: unknown) => {
      const id = subLedgerId(args)
      const subLedger = (await session.tree()).subLedgers.find(s => s.id === id)
      if (!subLedger) return undefined
      const input: RenameSubLedgerDialogInput = { id, name: subLedger.name, rev: subLedger.rev }
      return prompts.show<{ id: string }>(LEDGER_DIALOGS.renameSubLedger, input)
    }, { enablement: WRITABLE }),

    context.commands.register(LEDGER_COMMANDS.deleteSubLedger, async (args?: unknown) => {
      const id = subLedgerId(args)
      const tree = await session.tree()
      const subLedger = tree.subLedgers.find(s => s.id === id)
      if (!subLedger) return false

      const parent = subLedger.parentId === null ? tree.ledger.name : tree.subLedgers.find(s => s.id === subLedger.parentId)?.name ?? tree.ledger.name
      const children = childrenOf(tree.subLedgers, id).length
      const contents = [
        ...(children > 0 ? [`${children} sub-ledger${children === 1 ? '' : 's'}`] : []),
        ...await session.describeContents(id)
      ]
      const confirmed = await prompts.confirm({
        message: `Delete sub-ledger “${subLedger.name}”?`,
        detail: contents.length === 0
          ? 'It is empty.'
          : `Its ${joinList(contents)} will move to “${parent}”. Nothing in it is deleted.`,
        confirmLabel: 'Delete'
      })
      if (!confirmed) return false
      return (await attempt('delete the sub-ledger', async () => { await session.deleteSubLedger(id); return true })) ?? false
    }, { enablement: WRITABLE })
  ]
}

/** "a", "a and b", "a, b and c". */
export function joinList(items: readonly string[]): string {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}
