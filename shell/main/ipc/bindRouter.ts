// shell/main/ipc/bindRouter.ts
import { BrowserWindow, ipcMain } from 'electron'
import { INVOKE_CHANNEL } from '../../../shared/ipc'
import { IpcRouter } from '../../../core/ipc/IpcRouter'

/**
 * Binds the single invoke channel to the router. The router resolves handlers
 * per request, so this runs once and later registrations need no rebinding.
 * Each request is attributed to the window it came from.
 */
export function bindRouterToElectron(router: IpcRouter) {
  ipcMain.handle(INVOKE_CHANNEL, (event, request) =>
    router.dispatch(request, { windowId: BrowserWindow.fromWebContents(event.sender)?.id ?? -1 }))
}
