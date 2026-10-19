// shared/shellEvents.ts
//
// Names and payloads of the shell's own state, which the renderer can read
// (request/response) and follow (push events). Each piece of state has a
// snapshot request and a "changed" event; readers load the snapshot once, then
// apply the events.
import type { ContextKeyValue } from './context/when'
import { channelFor } from './ipc'
import { SHELL_CONTRIBUTOR_ID } from './plugins/manifest'

const shell = (event: string) => channelFor(SHELL_CONTRIBUTOR_ID, event)

/** starting → started → shuttingDown → shutDown. A vetoed shutdown returns to `started`. */
export type AppPhase = 'starting' | 'started' | 'shuttingDown' | 'shutDown'

// Application lifecycle
export const LIFECYCLE_GET_EVENT = 'lifecycle.get'
export const LIFECYCLE_GET = shell(LIFECYCLE_GET_EVENT)          // request → AppPhase
export const LIFECYCLE_CHANGED = shell('lifecycle.changed')      // push → LifecycleChanged
export interface LifecycleChanged { phase: AppPhase }

// Context keys
export const CONTEXT_KEYS_SNAPSHOT_EVENT = 'contextKeys.snapshot'
export const CONTEXT_KEYS_SNAPSHOT = shell(CONTEXT_KEYS_SNAPSHOT_EVENT)   // request → ContextKeySnapshot
export const CONTEXT_KEYS_CHANGED = shell('contextKeys.changed')          // push → ContextKeysChanged
export type ContextKeySnapshot = Record<string, ContextKeyValue>
/** The new value of each key that changed; `null` means the key was removed. */
export type ContextKeysChanged = Record<string, ContextKeyValue | null>
