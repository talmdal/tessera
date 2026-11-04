// core/dialogs/DialogService.ts
import type { EventHub, ExtensionRegistry, Logger, ShowDialogOptions } from '@tessera/types'
import { resolveDialogs } from '../../shared/dialogs/resolveDialogs'
import { DIALOGS_EXTENSION_POINT, DIALOG_OPEN, DialogClose, DialogDescriptor, DialogOpen } from '../../shared/dialogs/types'

export interface DialogServiceOptions {
  /** A plugin's renderer remote entry URL, or undefined when it has no renderer. */
  remoteEntryFor(pluginId: string): string | undefined
  /** The window a dialog goes to when the caller doesn't say: the focused one, else the first. Undefined: none. */
  targetWindow(): number | undefined
  log: Pick<Logger, 'warn'>
}

interface Pending {
  message: DialogOpen
  resolve(result: unknown): void
}

/**
 * Shows `shell.dialogs` contributions in windows and hands their results back to the callers of `show`.
 *
 * A request goes to one window as a `shell:dialog.open` event; that window's dialog host shows it and answers with
 * `shell:dialog.close`. Requests wait until their window's renderer is ready, because an event sent before it
 * listens would be lost; each time a window becomes ready again (its page reloaded), its open requests are sent
 * again. A request whose window closes resolves undefined.
 */
export class DialogService {
  private readonly pending = new Map<string, Pending>()
  private readonly ready = new Set<number>()
  private sequence = 0

  constructor(
    private readonly extensions: ExtensionRegistry,
    private readonly events: EventHub,
    private readonly options: DialogServiceOptions
  ) {}

  /** Every valid dialog contribution, resolved now, so it reflects plugins that activated since. */
  list(): DialogDescriptor[] {
    const { dialogs, diagnostics } = resolveDialogs(this.extensions.getContributions(DIALOGS_EXTENSION_POINT), this.options.remoteEntryFor)
    for (const message of diagnostics) this.options.log.warn(`[dialogs] ${message}`)
    return dialogs
  }

  show(dialogId: string, input?: unknown, options: ShowDialogOptions = {}): Promise<unknown> {
    const dialog = this.list().find(d => d.id === dialogId)
    if (!dialog) return Promise.reject(new Error(`Unknown dialog "${dialogId}"`))

    const windowId = options.windowId ?? this.options.targetWindow()
    if (windowId === undefined) return Promise.reject(new Error(`There is no window to show dialog "${dialogId}" in`))

    const requestId = `dialog-${++this.sequence}`
    const message: DialogOpen = {
      windowId, requestId, dialog, title: options.title ?? dialog.title,
      ...(input !== undefined && { input })
    }
    return new Promise(resolve => {
      this.pending.set(requestId, { message, resolve })
      if (this.ready.has(windowId)) this.events.publish(DIALOG_OPEN, message)
    })
  }

  /** The dialog host of `windowId` closed a dialog. Throws for a request it doesn't know, or that went elsewhere. */
  close(windowId: number | undefined, closed: DialogClose) {
    const entry = typeof closed?.requestId === 'string' ? this.pending.get(closed.requestId) : undefined
    if (!entry) throw new Error(`Unknown dialog request: ${String(closed?.requestId)}`)
    if (entry.message.windowId !== windowId) throw new Error(`Dialog request ${closed.requestId} belongs to another window`)

    this.pending.delete(closed.requestId)
    if ('error' in closed) {
      this.options.log.warn(`[dialogs] Dialog "${entry.message.dialog.id}" could not be shown in window ${windowId}: ${closed.error}`)
      entry.resolve(undefined)
    } else {
      entry.resolve(closed.result)
    }
  }

  /** A window's renderer is ready (again): send it every request still open for it, oldest first. */
  rendererReady(windowId: number) {
    this.ready.add(windowId)
    for (const { message } of this.pending.values()) {
      if (message.windowId === windowId) this.events.publish(DIALOG_OPEN, message)
    }
  }

  /** A window closed: its open requests resolve undefined, as if cancelled. */
  windowClosed(windowId: number) {
    this.ready.delete(windowId)
    for (const [requestId, { message, resolve }] of [...this.pending]) {
      if (message.windowId !== windowId) continue
      this.pending.delete(requestId)
      resolve(undefined)
    }
  }

  /** Requests not yet answered, for diagnostics and tests. */
  openRequests(): DialogOpen[] {
    return [...this.pending.values()].map(p => p.message)
  }
}
