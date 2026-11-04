// shell/main/dialogs/registerDialogs.ts
import type { DialogContribution, IpcMessage, PluginContext, PluginRuntime, ShellFiles, ShellPrompts } from '@tessera/types'
import { DIALOGS_EXTENSION_POINT, SHELL_FILES_SERVICE, SHELL_PROMPTS_SERVICE } from '@tessera/types'
import type { DialogService } from '../../../core/dialogs/DialogService'
import { DIALOG_CLOSE, DialogClose, PROMPT_DIALOG, PROMPT_DIALOG_MODULE } from '../../../shared/dialogs/types'

/** The shell's own dialogs. Their components are built into the renderer, keyed by module. */
const BUILT_IN_DIALOGS: DialogContribution[] = [
  { id: PROMPT_DIALOG, title: 'Tessera', module: PROMPT_DIALOG_MODULE, size: 'xs' }
]

/**
 * Provides `shell.prompts` and `shell.files`, contributes the shell's own dialogs, and routes each window's answers
 * (`shell:dialog.close`) back to the dialog service. Must run before plugins activate, so that a plugin can list
 * the services in `services.requires`.
 */
export function registerDialogs(
  shell: PluginContext,
  runtime: Pick<PluginRuntime, 'services'>,
  dialogs: DialogService,
  services: { prompts: ShellPrompts, files: ShellFiles }
) {
  for (const dialog of BUILT_IN_DIALOGS) shell.extensions.contribute(shell.pluginId, DIALOGS_EXTENSION_POINT, dialog.id, dialog)

  shell.ipc.register(DIALOG_CLOSE, (msg: IpcMessage<DialogClose>) => dialogs.close(msg.sender?.windowId, msg.data))

  runtime.services.provide(shell.pluginId, SHELL_PROMPTS_SERVICE, services.prompts)
  runtime.services.provide(shell.pluginId, SHELL_FILES_SERVICE, services.files)
}
