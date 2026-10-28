// shell/main/commands/commandsIpc.ts
import type { IpcMessage, Logger, PluginContext } from '@tessera/types'
import { COMMANDS_EXECUTE, ExecuteCommandRequest } from '../../../shared/shellEvents'

/**
 * Lets the renderer run a command (a bar button, a navigation view). Any view
 * may run any command, so each run is logged with the window it came from. A
 * disabled or unknown command rejects with the registry's error.
 */
export function registerCommandsIpc(shell: PluginContext, log: Logger) {
  shell.ipc.register(COMMANDS_EXECUTE, (msg: IpcMessage<ExecuteCommandRequest>) => {
    const { id, args } = msg.data ?? {} as Partial<ExecuteCommandRequest>
    if (typeof id !== 'string' || id.length === 0) throw new Error('A command id is required')
    if (args !== undefined && !Array.isArray(args)) throw new Error('args must be an array')

    log.info(`[commands] ${msg.sender?.windowId ?? 'unknown window'} executed ${id}`)
    return shell.commands.execute(id, ...(args ?? []))
  })
}
