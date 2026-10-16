// shell/main/ipc/bindRouter.ts
import { ipcMain } from 'electron'
import { INVOKE_CHANNEL } from '../../../shared/ipc'
import { IpcRouter } from '../../../core/ipc/IpcRouter'

/**
 * Binds the single invoke channel to the router. The router resolves handlers
 * per request, so this runs once and later registrations need no rebinding.
 */
export function bindRouterToElectron(router: IpcRouter) {
  ipcMain.handle(INVOKE_CHANNEL, (_event, request) => router.dispatch(request))
}
