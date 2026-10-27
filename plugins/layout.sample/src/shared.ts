// plugins/layout.sample/src/shared.ts
//
// The contract between the plugin's two halves: the state the privileged side
// owns, and the IPC channels and events that carry it. Both halves import this
// file; nothing else is shared between them.

import type { BarSide } from '@tessera/types'

export const PLUGIN_ID = 'layout-sample'

/** The bars of the window manager, as the shell names them. */
export type Side = BarSide
export const SIDES: readonly Side[] = ['top', 'bottom', 'left', 'right']

/** Owned by the privileged side; views only ever receive a copy. */
export interface SampleState {
  counts: Record<Side, number>
  total: number
  /** The most recent ping, if any. */
  last?: { side: Side, at: number }
}

/** Requests, handled in the privileged half (`window.api.invoke`). */
export const CHANNELS = {
  /** → SampleState. The current state; request it after subscribing to EVENTS.changed. */
  state: `${PLUGIN_ID}:state`,
  /** { side } → SampleState. A bar's button was pressed. */
  ping: `${PLUGIN_ID}:ping`,
  /** → SampleState. Back to zero. */
  reset: `${PLUGIN_ID}:reset`
} as const

/** Push events from the privileged half to every view (`window.api.on`). */
export const EVENTS = {
  /** → SampleState, the whole new state (absolute, so a replay is harmless). */
  changed: `${PLUGIN_ID}:changed`
} as const

export const COMMANDS = {
  reset: `${PLUGIN_ID}.reset`,
  showDashboard: `${PLUGIN_ID}.showDashboard`
} as const

export const VIEWS = {
  dashboard: `${PLUGIN_ID}.dashboard`,
  detail: `${PLUGIN_ID}.detail`,
  panel: (side: Side) => `${PLUGIN_ID}.${side}`
} as const

export interface PingRequest {
  side: Side
}

export function isSide(value: unknown): value is Side {
  return typeof value === 'string' && (SIDES as readonly string[]).includes(value)
}
