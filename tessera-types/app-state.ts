export interface AppState {
  /** The stored value, or `defaultFn()` if there is none. The default is returned, not stored. */
  get<T>(key: string, defaultFn?: () => T): Promise<T | undefined>
  /** `value` must be JSON (plain objects, arrays, primitives); anything else is rejected. */
  set<T>(key: string, value: T): Promise<void>
  update<T>(key: string, patch: Partial<T>): Promise<void>
  remove(key: string): Promise<void>
}
