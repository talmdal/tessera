/** The service id of `AppState`, provided by the `app-state` plugin. */
export const APP_STATE_SERVICE = 'app.state'

/** The application's key/value store (the `app.state` service): what the application remembers, not what the user sets. */
export interface AppState {
  get<T>(key: string, defaultFn?: () => T): Promise<T | undefined>
  set<T>(key: string, value: T): Promise<void>
  update<T>(key: string, patch: Partial<T>): Promise<void>
  remove(key: string): Promise<void>
}

/**
 * `context.state`: what a plugin remembers between runs (a recent-files list, the folder a dialog showed last), kept in
 * the `app.state` store under the plugin's own keys. A key given here is stored as `<pluginId>.<key>`, so a plugin
 * reaches only its own. Not for what the user chooses: that is a setting (`context.settings`).
 *
 * It needs the `app-state` plugin: list `app.state` in the manifest's `services.requires`, so that plugin activates
 * first. Without it every call rejects, saying so.
 */
export interface PluginState {
  /** Never writes: a missing key gives `defaultFn()` (or undefined) without storing it. */
  get<T>(key: string, defaultFn?: () => T): Promise<T | undefined>
  set<T>(key: string, value: T): Promise<void>
  /** Merges `patch` into the object stored under `key`, in one step. */
  update<T>(key: string, patch: Partial<T>): Promise<void>
  remove(key: string): Promise<void>
}
