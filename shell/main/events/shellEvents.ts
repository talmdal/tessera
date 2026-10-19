// shell/main/events/shellEvents.ts
import { PluginContext, PluginRuntime } from '../../../core/plugins/PluginContext'
import {
  CONTEXT_KEYS_CHANGED,
  CONTEXT_KEYS_SNAPSHOT_EVENT,
  ContextKeysChanged,
  LIFECYCLE_CHANGED,
  LIFECYCLE_GET_EVENT,
  LifecycleChanged
} from '../../../shared/shellEvents'
import { VIEWS_CHANGED, VIEWS_EXTENSION_POINT } from '../../../shared/views/types'

/**
 * Makes the shell's state visible to the renderer: a request for the current
 * value of each piece of state, plus a push event whenever it changes.
 * `shell` is the shell's own plugin context, which owns the handlers.
 */
export function registerShellEvents(shell: PluginContext, runtime: PluginRuntime) {
  const { events, lifecycle, contextKeys, extensions } = runtime

  shell.ipc.handle(LIFECYCLE_GET_EVENT, () => lifecycle.phase)
  shell.ipc.handle(CONTEXT_KEYS_SNAPSHOT_EVENT, () => contextKeys.snapshot())

  shell.subscriptions.push(
    lifecycle.onDidChangePhase(phase => {
      events.publish(LIFECYCLE_CHANGED, { phase } satisfies LifecycleChanged)
    }),

    contextKeys.onDidChange(keys => {
      const changes: ContextKeysChanged = {}
      for (const key of keys) changes[key] = contextKeys.get(key) ?? null
      events.publish(CONTEXT_KEYS_CHANGED, changes)
    }),

    extensions.onDidChange(({ point }) => {
      if (point === VIEWS_EXTENSION_POINT) events.publish(VIEWS_CHANGED)
    })
  )
}
