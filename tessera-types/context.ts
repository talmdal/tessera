import { Event } from '.'
export type ContextKeyValue = boolean | string | number
/**
 *
 * Named pieces of application state ("is a vault open?") that enablement
 * expressions read. Plugins write only their own keys via PluginContext.
 */
export interface ContextKeyService {
  /** Fires with the keys whose values changed. */
  readonly onDidChange: Event<any>

  /** A copy of every key and its value. */
  snapshot(): Record<string, ContextKeyValue>
  get(key: string): ContextKeyValue | undefined

  /** Setting `undefined` removes the key. */
  set(key: string, value: ContextKeyValue | undefined): void

  /** Removes `namespace` and every `namespace.*` key. */
  deleteNamespace(namespace: string) : void
}
