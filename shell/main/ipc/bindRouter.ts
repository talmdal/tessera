// shell/main/ipc/bindRouter.ts
import { BrowserWindow, ipcMain } from 'electron'
import { IpcRouter } from '@tessera/types'
import { INVOKE_CHANNEL } from '../../../shared/ipc'

/**
 * Binds the single invoke channel to the router. The router resolves handlers
 * per request, so this runs once and later registrations need no rebinding.
 *
 * Each request is attributed to the window it came from (`msg.sender`), by the
 * adapter and never by the renderer, so a window cannot act as another one.
 */
export function bindRouterToElectron(router: IpcRouter) {
  ipcMain.handle(INVOKE_CHANNEL, (event, request) => {
    const window = event?.sender ? BrowserWindow.fromWebContents(event.sender) : null
    return router.dispatch(request, window ? { windowId: window.id } : undefined)
  })
}
