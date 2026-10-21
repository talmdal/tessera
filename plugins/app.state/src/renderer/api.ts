import type { GetRequest } from '../shared'

export const appState = {
  /** `defaultValue` crosses IPC, so it must be a plain value (not a function). */
  get<T>(key: string, defaultValue: T) {
    return window.api.invoke<T, GetRequest<T>>('app.state:get', { key, defaultValue })
  },

  set(key: string, value: any) {
    return window.api.invoke('app.state:set', { key, value })
  },

  update(key: string, patch: any) {
    return window.api.invoke('app.state:update', { key, patch })
  },

  remove(key: string) {
    return window.api.invoke('app.state:remove', { key })
  }
}
