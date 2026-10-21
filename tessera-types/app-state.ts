export interface AppState {
  get<T>(key: string, defaultFn?: () => T): Promise<T | undefined>
  set<T>(key: string, value: T): Promise<void>
  update<T>(key: string, patch: Partial<T>): Promise<void>
  remove(key: string): Promise<void>
}
