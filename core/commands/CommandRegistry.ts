// core/commands/CommandRegistry.ts
import { WhenExpression, evaluateWhen, parseWhen } from '../../shared/context/when'
import { ContextKeyService } from '../context/ContextKeyService'
import { Emitter } from '../events'
import { Disposable } from '../ports'

export type CommandHandler = (...args: unknown[]) => unknown

export interface CommandOptions {
  /**
   * Context-key expression, e.g. "vault.isOpen && vault.isDirty". The command
   * is disabled, and refuses to execute, while it evaluates to false.
   */
  enablement?: string
}

interface Entry {
  handler: CommandHandler
  enablement?: WhenExpression
}

export class CommandRegistry {
  private entries = new Map<string, Entry>()
  private changed = new Emitter<void>()

  /** Fires when a command is added or removed, or when enablement may have changed. */
  readonly onDidChange = this.changed.event

  constructor(private readonly contextKeys: ContextKeyService = new ContextKeyService()) {
    contextKeys.onDidChange(() => this.changed.fire())
  }

  register(id: string, handler: CommandHandler, options: CommandOptions = {}): Disposable {
    if (this.entries.has(id)) {
      throw new Error(`Command already registered: ${id}`)
    }

    const entry: Entry = {
      handler,
      enablement: options.enablement === undefined ? undefined : parseWhen(options.enablement)
    }

    this.entries.set(id, entry)
    this.changed.fire()
    return {
      dispose: () => {
        if (this.entries.get(id) !== entry) return
        this.entries.delete(id)
        this.changed.fire()
      }
    }
  }

  has(id: string) {
    return this.entries.has(id)
  }

  /** True when the command is registered and its enablement expression, if any, holds. */
  isEnabled(id: string) {
    const entry = this.entries.get(id)
    if (!entry) return false
    return !entry.enablement || evaluateWhen(entry.enablement, key => this.contextKeys.get(key))
  }

  async execute(id: string, ...args: unknown[]) {
    const entry = this.entries.get(id)
    if (!entry) throw new Error(`Unknown command: ${id}`)
    if (!this.isEnabled(id)) throw new Error(`Command is disabled: ${id}`)
    return entry.handler(...args)
  }
}
