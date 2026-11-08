// The Settings Inspector: a developer's view of the settings, under Tools beside Toggle Developer Tools. For every
// namespace it shows what plugins read, the defaults and the file on disk, and whether they agree, so the settings
// can be checked without opening files by hand. It only reads: nothing here changes a setting.
import path from 'node:path'
import type { DialogContribution, PluginContext, ShellPrompts } from '@tessera/types'
import { DIALOGS_EXTENSION_POINT, SETTINGS_FOLDER, SHELL_PROMPTS_SERVICE } from '@tessera/types'
import { INSPECTOR, INSPECTOR_PLUGIN_ID } from '../shared'
import { inspectSettings } from './inspect'

const DIALOG: DialogContribution = { id: INSPECTOR.dialog, title: 'Settings Inspector', module: './InspectorDialog', size: 'lg' }

/** Tools › Settings Inspector…, in the shell's developer group, beside Toggle Developer Tools. */
const MENU_ITEM = {
  kind: 'item', id: 'settings-inspector.tools.show', label: 'Settings &Inspector…', parent: 'shell.tools', group: 'shell.developer',
  command: INSPECTOR.command
} as const

export function activate(context: PluginContext) {
  const prompts = context.services.get<ShellPrompts>(SHELL_PROMPTS_SERVICE)
  // Where the shell keeps settings: <userData>/settings
  const folder = path.join(context.paths, SETTINGS_FOLDER)

  context.commands.register(INSPECTOR.command, () => prompts.show(INSPECTOR.dialog))
  context.subscriptions.push(
    context.extensions.contribute(INSPECTOR_PLUGIN_ID, DIALOGS_EXTENSION_POINT, DIALOG.id, DIALOG),
    context.extensions.contribute(INSPECTOR_PLUGIN_ID, 'shell.menus', MENU_ITEM.id, MENU_ITEM),
    context.ipc.register(INSPECTOR.report, () => inspectSettings(context.settings.snapshots(), folder))
  )
}
