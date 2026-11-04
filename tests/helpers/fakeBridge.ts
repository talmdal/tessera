import { vi } from 'vitest'

type Responder = (() => unknown) | 'deferred'

/**
 * A bridge for the renderer's state tests. Each request is answered by its
 * responder, or with `'deferred'` is held until the test calls `resolve`.
 * Events are fired with `emit`.
 */
export function createFakeRemote(responders: Record<string, Responder>) {
  const listeners = new Map<string, Set<(data: any) => void>>()
  const pending = new Map<string, (value: unknown) => void>()

  const bridge = {
    invoke: vi.fn((channel: string) => {
      const responder = responders[channel]
      if (responder === undefined) return Promise.reject(new Error(`No answer for ${channel}`))
      if (responder === 'deferred') return new Promise(resolve => { pending.set(channel, resolve) })
      return Promise.resolve(responder())
    }),
    on: vi.fn((name: string, listener: (data: any) => void) => {
      if (!listeners.has(name)) listeners.set(name, new Set())
      listeners.get(name)!.add(listener)
      return () => { listeners.get(name)!.delete(listener) }
    })
  } as any

  return {
    bridge,
    /** Fires a push event. */
    emit: (name: string, data?: unknown) => listeners.get(name)?.forEach(listener => listener(data)),
    /** Answers a deferred request. */
    resolve: (channel: string, value: unknown) => pending.get(channel)!(value)
  }
}
