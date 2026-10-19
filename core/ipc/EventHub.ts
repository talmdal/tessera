// core/ipc/EventHub.ts
import { IpcEvent } from '../../shared/ipc'
import { Disposable, Logger } from '../ports'

export type EventListener = (event: IpcEvent) => void

/**
 * Where main-process code publishes events meant for the renderer. An adapter
 * (shell/main/events) subscribes and delivers them to the windows. A listener
 * that throws is logged and the others still get the event.
 */
export class EventHub {
  private listeners = new Set<EventListener>()

  constructor(private readonly log?: Logger) {}

  publish(name: string, data?: unknown) {
    const event: IpcEvent = { name, data }
    for (const listener of [...this.listeners]) {
      try {
        listener(event)
      } catch (err) {
        this.log?.error(`[events] A listener failed for ${name}`, err)
      }
    }
  }

  subscribe(listener: EventListener): Disposable {
    this.listeners.add(listener)
    return { dispose: () => { this.listeners.delete(listener) } }
  }
}
