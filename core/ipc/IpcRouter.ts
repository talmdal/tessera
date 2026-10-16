// core/ipc/IpcRouter.ts
import { IpcResponse, isIpcRequest } from '../../shared/ipc'
import { Disposable, Logger } from '../ports'

export interface IpcMessage<T = unknown> {
  channel: string
  data: T
  correlationId?: string
}

export type IpcHandler<TReq = unknown, TRes = unknown> =
  (msg: IpcMessage<TReq>) => Promise<TRes> | TRes

/**
 * Routes requests arriving on the single invoke channel to handlers by logical
 * channel. Handlers are looked up per request, so handlers registered after
 * startup are reachable immediately.
 */
export class IpcRouter {
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

  async dispatch(request: unknown): Promise<IpcResponse> {
    if (!isIpcRequest(request)) {
      return { ok: false, error: { code: 'BAD_REQUEST', message: 'Malformed IPC request' } }
    }

    const { channel, data, correlationId } = request
    const handler = this.handlers.get(channel)
    if (!handler) {
      return { ok: false, error: { code: 'NO_HANDLER', message: `No IPC handler for ${channel}` }, correlationId }
    }

    try {
      return { ok: true, data: await handler({ channel, data, correlationId }), correlationId }
    } catch (err) {
      this.log?.error(`[ipc] Handler for ${channel} failed`, err)
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false, error: { code: 'HANDLER_ERROR', message }, correlationId }
    }
  }
}
