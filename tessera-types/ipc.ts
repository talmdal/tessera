import { Disposable } from "."

export interface IpcMessage<T = unknown> {
  channel: string
  data: T
  correlationId?: string
}

export type IpcHandler<TReq = unknown, TRes = unknown> =
  (msg: IpcMessage<TReq>) => Promise<TRes> | TRes

export interface IpcRequest<T = unknown> {
  channel: string
  data?: T
  correlationId?: string
}

export type IpcErrorCode = 'BAD_REQUEST' | 'NO_HANDLER' | 'HANDLER_ERROR'

export type IpcResponse<T = unknown> =
  | { ok: true, data: T, correlationId?: string }
  | { ok: false, error: { code: IpcErrorCode, message: string }, correlationId?: string }

/** A push event from the main process. Named `<pluginId>:<event>`, like request channels. */
export interface IpcEvent<T = unknown> {
  name: string
  data?: T
}

/** API the preload exposes to the renderer as `window.api`. */
export interface TesseraBridge {
  invoke<TRes = unknown, TReq = unknown>(channel: string, data?: TReq): Promise<TRes>
  /** Listens for a push event from the main process. Returns a function that stops listening. */
  on<T = unknown>(name: string, listener: (event: string , data: T) => void): () => void
  // send(channel: string, data?: any): void
}

/** Logical channels are namespaced by the plugin that handles them: `<pluginId>:<event>`. */
export function channelFor(pluginId: string, event: string) {
  return `${pluginId}:${event}`
}

export interface IpcRouter {
  register<TReq, TRes>(channel: string, handler: IpcHandler<TReq, TRes>): Disposable 

  has(channel: string): boolean

  dispatch(request: unknown): Promise<IpcResponse> 
}