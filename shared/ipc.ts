// shared/ipc.ts

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

/** API the preload exposes to the renderer as `window.api`. */
export interface TesseraBridge {
  invoke<TRes = unknown, TReq = unknown>(channel: string, data?: TReq): Promise<TRes>
}

export function isIpcRequest(value: unknown): value is IpcRequest {
  if (typeof value !== 'object' || value === null) return false
  const { channel, correlationId } = value as Record<string, unknown>
  return typeof channel === 'string' && channel.length > 0 &&
    (correlationId === undefined || typeof correlationId === 'string')
}
