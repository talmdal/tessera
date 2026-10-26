import { Disposable } from "."

/**
 * Where a request came from, attributed by the platform adapter (never by the
 * renderer itself, so a window cannot act as another one). Absent when the
 * request did not come from a window, e.g. in tests that call dispatch directly.
 */
export interface IpcSender {
  windowId: number
}

export interface IpcMessage<T = unknown> {
  channel: string
  data: T
  correlationId?: string
  sender?: IpcSender
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
  /**
   * Listens for a push event from the main process. The listener receives
   * only the event's data (never Electron's event object). Returns a function
   * that stops listening.
   */
  on<T = unknown>(name: string, listener: (data: T) => void): () => void
  // send(channel: string, data?: any): void
}

/** Logical channels are namespaced by the plugin that handles them: `<pluginId>:<event>`. */
export function channelFor(pluginId: string, event: string) {
  return `${pluginId}:${event}`
}

export interface IpcRouter {
  register<TReq, TRes>(channel: string, handler: IpcHandler<TReq, TRes>): Disposable 

  has(channel: string): boolean

  dispatch(request: unknown, sender?: IpcSender): Promise<IpcResponse>
}