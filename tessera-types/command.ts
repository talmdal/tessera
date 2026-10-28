import { Disposable, Event } from "."

export type CommandHandler = (...args: unknown[]) => unknown

export interface CommandOptions {
  /**
   * Context-key expression, e.g. "vault.isOpen && vault.isDirty". The command
   * is disabled, and refuses to execute, while it evaluates to false.
   */
  enablement?: string
}

export interface CommandRegistry {
  /** Fires when a command is added or removed, or when enablement may have changed. */
  readonly onDidChange: Event<void>

  register(id: string, handler: CommandHandler, options?: CommandOptions): Disposable

  has(id: string): boolean

  /** True when the command is registered and its enablement expression, if any, holds. */
  isEnabled(id: string): boolean

  execute(id: string, ...args: unknown[]): Promise<unknown>
}
