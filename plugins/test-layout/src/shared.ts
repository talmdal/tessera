// plugins/layout.sample/src/shared.ts
//
// The contract between the plugin's two halves: the state the privileged side
// owns, and the IPC channels and events that carry it. Both halves import this
// file; nothing else is shared between them.

import { BORDERS, Border } from '@tessera/types'

export const PLUGIN_ID = 'test-layout'

/** Owned by the privileged side; views only ever receive a copy. */
export interface LayoutState {
  counts: Record<Border, number>
  total: number
  /** The most recent ping, if any. */
  last?: { side: Border, at: number }
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
  panel: (side: Border) => `${PLUGIN_ID}.${side}`
} as const

export interface PingRequest {
  side: Border
}

export function isSide(value: unknown): value is Border {
  return typeof value === 'string' && (BORDERS as readonly string[]).includes(value)
}