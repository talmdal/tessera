import { Disposable, Event } from "."

export interface ExtensionContribution<T = unknown> {
  point: string
  id: string
  /** Plugin id (or the shell) that made the contribution. */
  contributor: string
  impl: T
}

export interface ExtensionRegistry {
  onDidChange: Event<{ point: string }>
  contribute(contributor: string, point: string, id: string, impl: unknown): Disposable
  getContributions(point: string): ExtensionContribution[]
}
