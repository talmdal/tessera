// shared/ipc.ts

/** The Electron channel that carries every main → renderer push event. */
export const EVENT_CHANNEL = 'tessera:event'

/** The single Electron channel that carries every renderer → main request. */
export const INVOKE_CHANNEL = 'tessera:invoke'

/** Logical channels are namespaced by the plugin that handles them: `<pluginId>:<event>`. */
export function channelFor(pluginId: string, event: string) {
  return `${pluginId}:${event}`
}

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
  on<T = unknown>(name: string, listener: (data: T) => void): () => void
}

export function isIpcEvent(value: unknown): value is IpcEvent {
  if (typeof value !== 'object' || value === null) return false
  const { name } = value as Record<string, unknown>
  return typeof name === 'string' && name.length > 0
}

export function isIpcRequest(value: unknown): value is IpcRequest {
  if (typeof value !== 'object' || value === null) return false
  const { channel, correlationId } = value as Record<string, unknown>
  return typeof channel === 'string' && channel.length > 0 &&
    (correlationId === undefined || typeof correlationId === 'string')
}
