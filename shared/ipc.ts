// shared/ipc.ts
import { IpcRequest, IpcEvent } from '../tessera-types'

/** The Electron channel that carries every main → renderer push event. */
export const EVENT_CHANNEL = 'tessera:event'

/** The single Electron channel that carries every renderer → main request. */
export const INVOKE_CHANNEL = 'tessera:invoke'

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
