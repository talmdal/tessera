// core/context/ContextKeyService.ts
import type { ContextKeyValue } from '../../shared/context/when'
import { Emitter } from '../events'

/**
 * Named pieces of application state ("is a vault open?") that enablement
 * expressions read. Plugins write only their own keys via PluginContext.
 */
export class ContextKeyService {
  private values = new Map<string, ContextKeyValue>()
  private changed = new Emitter<string[]>()

  /** Fires with the keys whose values changed. */
  readonly onDidChange = this.changed.event

  /** A copy of every key and its value. */
  snapshot(): Record<string, ContextKeyValue> {
    return Object.fromEntries(this.values)
  }

  get(key: string): ContextKeyValue | undefined {
    return this.values.get(key)
  }

  /** Setting `undefined` removes the key. */
  set(key: string, value: ContextKeyValue | undefined) {
    if (this.values.get(key) === value) return
    if (value === undefined) this.values.delete(key)
    else this.values.set(key, value)
    this.changed.fire([key])
  }

  /** Removes `namespace` and every `namespace.*` key. */
  deleteNamespace(namespace: string) {
    const removed = [...this.values.keys()].filter(key => key === namespace || key.startsWith(`${namespace}.`))
    for (const key of removed) this.values.delete(key)
    if (removed.length > 0) this.changed.fire(removed)
  }
}
