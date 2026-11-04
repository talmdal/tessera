// shared/ipc.ts
import type { IpcRequest, IpcEvent, TesseraBridge, ThemeSnapshot } from '../tessera-types'

export type { TesseraBridge }

/**
 * What the shell's own preload exposes as `window.api`: the bridge every view
 * has, plus what the main process already knew when the page was created.
 */
export interface ShellBridge extends TesseraBridge {
  /** This window's theme, so the first render needs no round trip. Absent if the main process could not say. */
  readonly initialTheme?: ThemeSnapshot
}

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
