// core/extensions/ExtensionRegistry.ts
import { Emitter } from '../events'
import { Disposable } from '../ports'

export interface ExtensionContribution<T = unknown> {
  point: string
  id: string
  /** Plugin id (or the shell) that made the contribution. */
  contributor: string
  impl: T
}

export class ExtensionRegistry {
  private contributions: ExtensionContribution[] = []
  private changed = new Emitter<{ point: string }>()

  /** Fires when a contribution is added to, or removed from, an extension point. */
  readonly onDidChange = this.changed.event

  contribute(contributor: string, point: string, id: string, impl: unknown): Disposable {
    const entry: ExtensionContribution = { point, id, contributor, impl }
    this.contributions.push(entry)
    this.changed.fire({ point })
    return {
      dispose: () => {
        const before = this.contributions.length
        this.contributions = this.contributions.filter(c => c !== entry)
        if (this.contributions.length !== before) this.changed.fire({ point })
      }
    }
  }

  getContributions(point: string) {
    return this.contributions.filter(c => c.point === point)
  }
}
