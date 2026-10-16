// core/extensions/ExtensionRegistry.ts
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

  contribute(contributor: string, point: string, id: string, impl: unknown): Disposable {
    const entry: ExtensionContribution = { point, id, contributor, impl }
    this.contributions.push(entry)
    return {
      dispose: () => {
        this.contributions = this.contributions.filter(c => c !== entry)
      }
    }
  }

  getContributions(point: string) {
    return this.contributions.filter(c => c.point === point)
  }
}
