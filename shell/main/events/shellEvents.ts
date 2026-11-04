// shell/main/events/shellEvents.ts
import { PluginContext, PluginRuntime } from '@tessera/types'
import {
  CONTEXT_KEYS_CHANGED,
  CONTEXT_KEYS_SNAPSHOT,
  ContextKeysChanged,
  LIFECYCLE_CHANGED,
  LIFECYCLE_GET,
  LifecycleChanged
} from '../../../shared/shellEvents'
import { ICONS_EXTENSION_POINT } from '../../../shared/layout/types'
import { VIEWS_CHANGED, VIEWS_EXTENSION_POINT } from '../../../shared/views/types'

/**
 * Makes the shell's state visible to the renderer: a request for the current
 * value of each piece of state, plus a push event whenever it changes.
 * `shell` is the shell's own plugin context, which owns the handlers.
 */
export function registerShellEvents(shell: PluginContext, runtime: PluginRuntime) {
  const { events, lifecycle, contextKeys, extensions } = runtime

  shell.ipc.register(LIFECYCLE_GET, () => lifecycle.phase)
  shell.ipc.register(CONTEXT_KEYS_SNAPSHOT, () => contextKeys.snapshot())

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
      // A view's icon may name an icon registered after it, so its validity can change with the icons.
      if (point === VIEWS_EXTENSION_POINT || point === ICONS_EXTENSION_POINT) events.publish(VIEWS_CHANGED)
    })
  )
}
