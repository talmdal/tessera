// shared/ipcRouter.ts
import { IpcHandler, IPCMessage } from './ipcMessage'

export class IpcRouter {
  private handlers = new Map<string, IpcHandler<any, any>>()

  register<TReq, TRes>(
    module: string,
    event: string,
    handler: IpcHandler<TReq, TRes>
  ) {
    const channel = `${module}:${event}`

    if (this.handlers.has(channel)) {
      throw new Error(`IPC channel already registered: ${channel}`)
    }

    this.handlers.set(channel, handler)
  }

  getHandlers() {
    return this.handlers
  }

  createMessage<T>(module: string, event: string, data: T, correlationId?: string) {
    return new IPCMessage(module, event, data, correlationId)
  }
}
