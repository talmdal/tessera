// core/ipc/IpcRouter.ts
import { 
  IpcResponse, 
  IpcRouter, 
  IpcHandler,
  IpcSender,
  Disposable, 
  Logger
} from '../../tessera-types'
import { isIpcRequest } from '../../shared/ipc'

/**
 * Routes requests arriving on the single invoke channel to handlers by logical
 * channel. Handlers are looked up per request, so handlers registered after
 * startup are reachable immediately.
 */
export class IpcRouterImpl implements IpcRouter {
  private handlers = new Map<string, IpcHandler<any, any>>()

  constructor(private readonly log?: Logger) {}

  register<TReq, TRes>(channel: string, handler: IpcHandler<TReq, TRes>): Disposable {
    if (this.handlers.has(channel)) {
      throw new Error(`IPC channel already registered: ${channel}`)
    }

    this.handlers.set(channel, handler)
    return {
      dispose: () => {
        if (this.handlers.get(channel) === handler) this.handlers.delete(channel)
      }
    }
  }

  has(channel: string) {
    return this.handlers.has(channel)
  }

  async dispatch(request: unknown, sender?: IpcSender):Promise<IpcResponse> {
    if (!isIpcRequest(request)) {
      return { ok: false, error: { code: 'BAD_REQUEST', message: 'Malformed IPC request' } }
    }

    const { channel, data, correlationId } = request
    const handler = this.handlers.get(channel)
    if (!handler) {
      return { ok: false, error: { code: 'NO_HANDLER', message: `No IPC handler for ${channel}` }, correlationId }
    }

    try {
      return { ok: true, data: await handler({ channel, data, correlationId, sender }), correlationId }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // The reason in the message itself, so a list of problems says what failed without opening each one
      this.log?.error(`[ipc] Handler for ${channel} failed: ${message}`, err)
      return { ok: false, error: { code: 'HANDLER_ERROR', message }, correlationId }
    }
  }
}
