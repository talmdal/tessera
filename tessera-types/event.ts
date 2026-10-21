import { IpcEvent, Disposable } from '.'

export type Event<T> = (listener: (value: T) => void) => Disposable

export type EventListener = (event: IpcEvent) => void

/**
 * Where main-process code publishes events meant for the renderer. An adapter
 * (shell/main/events) subscribes and delivers them to the windows. A listener
 * that throws is logged and the others still get the event.
 */
export interface EventHub {
  publish(name: string, data?: unknown): void

  subscribe(listener: EventListener): Disposable
}
