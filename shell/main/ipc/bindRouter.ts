// shell/main/ipc/bindRouter.ts
import { ipcMain } from 'electron'
import { IpcRouter } from '@shared/ipcRouter'
import { IPCMessage } from '@shared/ipcMessage'

export function bindRouterToElectron(router: IpcRouter) {
  for (const [channel, handler] of router.getHandlers()) {
    ipcMain.handle(channel, async (_event, payload) => {
      const [module, event] = channel.split(':')
      const msg = new IPCMessage(
        module,
        event,
        payload?.data ?? payload,
        payload?.correlationId
      )

      return handler(msg)
    })
  }
}
