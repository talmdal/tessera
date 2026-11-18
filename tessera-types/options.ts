// Options: the user's choices, owned by the plugin that defines them.
//
// Options live in tier 0 — a plain JSON file the shell reads synchronously at startup, before any plugin
// activates — so that the shell can read its own options early, and so that every plugin can have options,
// including the storage backends and `app-state` that sit below any plugin-provided service.
// See docs/options-framework-design.md.
import type { Disposable, Json } from '.'

/** One namespace's stored entry: the version that wrote it, and only the values that differ from the defaults. */
export interface OptionsEntry {
  version: number
  values: Json
}

/** The whole options file: one entry per namespace, keyed by plugin id. Entries are validated on read. */
export type OptionsDocument = Record<string, Json>

export interface OptionsSpec<T> {
  /** The complete value, used for every key the user has not overridden. Must be valid. */
  defaults: T
  /** Raise it when the shape changes, so `migrate` is called for values written by an older version. Default 1. */
  version?: number
  /**
   * Brings stored overrides written by an older version up to date. It receives the stored overrides (a partial
   * value), not the merged one, and returns the overrides to use instead. The result is merged over `defaults`.
   */
  migrate?(stored: Json, fromVersion: number): Json
  /** Authoritative check, run on load and on every commit. Return one message per problem, or an empty array. */
  validate?(value: T): string[]
  /** Reserved: only `'application'` is supported, and it is the default. */
  scope?: 'application'
}

export interface OptionsHandle<T> {
  /** The stored overrides merged over the defaults: always complete, never partial. */
  get(): T
  /** Fires after a commit or a reset changes this namespace's value. */
  onDidChange(listener: (value: T, previous: T) => void): Disposable
}

/**
 * `context.options`: a plugin's view of the options service, bound to its own namespace. There is no namespace
 * argument, so a plugin cannot read or write another plugin's options.
 */
export interface OptionsApi {
  /** Declares this plugin's options. Call once, from `activate`; a second call throws. */
  register<T>(spec: OptionsSpec<T>): OptionsHandle<T>
}

/**
 * What the plugin runtime needs of the options service, to build each plugin's namespace-bound `context.options`.
 * The service itself (in core) does more: the options dialog also reads and commits other namespaces through it.
 */
export interface OptionsRegistrar {
  register<T>(namespace: string, spec: OptionsSpec<T>): OptionsHandle<T>
  /** Forgets a namespace's registration, keeping its stored values. Called when a plugin deactivates. */
  unregister(namespace: string): void
}

/**
 * Extension point plugins contribute `OptionsPageDescriptor`s to. Here rather than only in `shared/` because a
 * plugin reaches the framework through `@tessera/*` alone, and a page is contributed from a plugin.
 */
export const OPTIONS_EXTENSION_POINT = 'shell.options.pages'

/** A page in the options dialog. Plain data, contributed to `shell.options.pages`, like a view or a menu item. */
export interface OptionsPageDescriptor {
  /** Prefixed with the contributing plugin's id, like every contribution. */
  id: string
  title: string
  /** A page or category id. Omitted places the page at the top level. */
  parent?: string
  /** A module the plugin's renderer remote exposes, starting with `./`. Omit for a category-only node. */
  module?: string
  /** Searched with the title. */
  keywords?: string[]
  /** Sorts among siblings; default 0. */
  order?: number
}

/** What the options dialog passes to a page. Pages never touch the options IPC: the dialog owns the draft. */
export interface OptionsPageProps<T> {
  /** The current draft for this page's namespace, pending until the user applies it. */
  value: T
  defaults: T
  /** Replaces the draft. Nothing is applied or stored until the user clicks Apply or OK. */
  onChange(next: T): void
  /** Gates Apply and OK. A convenience for the user: `validate` in the main process is authoritative. */
  onValidityChange(valid: boolean): void
  /** True while a commit is in progress. */
  disabled: boolean
}
