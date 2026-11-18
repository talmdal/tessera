// shell/main/problems/registerProblems.ts — puts the problem log in front of the user.
//
// A count in the status bar, shown only while there is something to see, opens the Problems dialog; so does
// Help ▸ Show Problems…. Windows report their own uncaught errors here too, so a view that breaks in the
// renderer is as visible as a plugin that failed to load in the main process.
import type { DialogContribution, IpcMessage, PluginContext, PluginRuntime, ShellPrompts } from '@tessera/types'
import { DIALOGS_EXTENSION_POINT, SHELL_PROMPTS_SERVICE } from '@tessera/types'
import type { ProblemLog } from '../../../core/problems/ProblemLog'
import { BAR_ITEMS_EXTENSION_POINT } from '../../../shared/layout/types'
import { HELP_MENU, MENUS_EXTENSION_POINT, type MenuContribution } from '../../../shared/menus/types'
import {
  PROBLEMS_CHANGED, PROBLEMS_CLEAR, PROBLEMS_COMMANDS, PROBLEMS_DIALOG, PROBLEMS_DIALOG_MODULE, PROBLEMS_KEYS,
  PROBLEMS_LIST, PROBLEMS_REPORT, REPORT_LIMIT, type ProblemEntry, type ProblemReport, type ProblemTotals
} from '../../../shared/problems/types'

const DIALOG: DialogContribution = { id: PROBLEMS_DIALOG, title: 'Problems', module: PROBLEMS_DIALOG_MODULE, size: 'md' }

const MENUS: MenuContribution[] = [
  { kind: 'group', id: 'shell.problems', parent: HELP_MENU, order: 9_000 },
  { kind: 'item', id: 'shell.help.problems', label: 'Show &Problems…', parent: HELP_MENU, group: 'shell.problems', command: PROBLEMS_COMMANDS.show }
]

/** At the far end of the status bar, and only while there is something in the log. */
const BAR_ITEM = {
  kind: 'text', id: 'shell.status.problems', slot: 'shell.bottom', align: 'end', icon: 'Warning', order: 1_000,
  text: `{${PROBLEMS_KEYS.count}}`, when: PROBLEMS_KEYS.count, command: PROBLEMS_COMMANDS.show,
  tooltip: 'Tessera ran into problems. Click to see them.'
} as const

const clip = (text: unknown) => {
  const value = typeof text === 'string' ? text : String(text ?? '')
  return value.length > REPORT_LIMIT ? `${value.slice(0, REPORT_LIMIT)}…` : value
}

/**
 * Must run before plugins activate, so their startup trouble is counted and the contributions are in place
 * when the first window asks for its bar items.
 */
export function registerProblems(shell: PluginContext, runtime: Pick<PluginRuntime, 'events' | 'services'>, problems: ProblemLog) {
  shell.extensions.contribute(shell.pluginId, DIALOGS_EXTENSION_POINT, DIALOG.id, DIALOG)
  shell.extensions.contribute(shell.pluginId, BAR_ITEMS_EXTENSION_POINT, BAR_ITEM.id, BAR_ITEM)
  for (const menu of MENUS) shell.extensions.contribute(shell.pluginId, MENUS_EXTENSION_POINT, menu.id, menu)

  const publish = (totals: ProblemTotals) => {
    shell.contextKeys.set(PROBLEMS_KEYS.count, totals.total > 0 ? totals.total : undefined)
    shell.contextKeys.set(PROBLEMS_KEYS.errors, totals.errors > 0 ? totals.errors : undefined)
    runtime.events.publish(PROBLEMS_CHANGED, totals)
  }
  // Whatever was logged before this ran (options and bootstrap loading, say) is counted from the start
  publish(problems.summary())
  shell.subscriptions.push(problems.onDidChange(publish))

  shell.ipc.register(PROBLEMS_LIST, (): ProblemEntry[] => problems.list())
  shell.ipc.register(PROBLEMS_CLEAR, () => { problems.clear() })
  shell.ipc.register(PROBLEMS_REPORT, (msg: IpcMessage<ProblemReport>) => {
    const report = msg.data
    if (typeof report !== 'object' || report === null) return
    const level = report.level === 'warning' ? 'warning' : 'error'
    const where = msg.sender?.windowId === undefined ? 'window' : `window ${msg.sender.windowId}`
    // Recorded straight into the log, not through the logger: the window has already printed it to its console
    problems.record(level, `[${where}] ${clip(report.message)}`, report.detail === undefined ? undefined : clip(report.detail))
  })

  shell.commands.register(PROBLEMS_COMMANDS.show, async () => {
    const prompts = runtime.services.get<ShellPrompts>(SHELL_PROMPTS_SERVICE)
    await prompts.show(PROBLEMS_DIALOG)
  })
  shell.commands.register(PROBLEMS_COMMANDS.clear, () => { problems.clear() })
}
