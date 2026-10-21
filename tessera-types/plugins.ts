import {
  AppLifecycle,
  AppPhase,
  ExtensionRegistry,
  EventHub,
  Disposable, 
  CommandRegistry,
  ContextKeyService,
  Logger,
  ServiceRegistry
} from '.'

export interface PluginContextOptions {
  /** Services the plugin may provide, from its manifest. Omit for the shell, which is unrestricted. */
  provides?: readonly string[]
}

/**
 * What a plugin sees. Every id it registers must be its plugin id or start
 * with `<pluginId>.`, and IPC handlers are bound to `<pluginId>:<event>`, so a
 * plugin cannot claim another plugin's (or the shell's) names. Everything
 * registered through the context is undone when the plugin is deactivated.
 */
export interface PluginContext {
  readonly pluginId: string
  readonly ipc: IpcRouter
  readonly commands: CommandRegistry
  /** State read by enablement expressions. Plugins may set only their own keys; all are removed on deactivation. */
  readonly contextKeys: ContextKeyService
  readonly extensions: ExtensionRegistry
  /**
   * Objects other plugins call, e.g. "vault.store". Declare what you provide in
   * the manifest's services.provides, and what you need in services.requires so
   * you activate after the provider.
   */
  readonly services: ServiceRegistry
  /**
   * Application lifecycle. `onStarted` runs once every plugin has activated
   * (immediately if the app has already started). `onShuttingDown` runs when
   * the app is asked to quit, before any plugin deactivates; it may be async
   * and may `veto()` a user-initiated quit. Listeners are removed when your
   * plugin deactivates.
   */
  /**
   * Push events to the renderer. `emit('saved', data)` reaches views as
   * `window.api.on('<pluginId>:saved', listener)`. `data` must be
   * structured-cloneable (plain objects, arrays, primitives).
   */
  readonly events: {
    emit(event: string, data?: unknown): void
  }
  readonly lifecycle: AppLifecycle
  /** Disposed, last first, on deactivation. Plugins may push their own disposables. */
  readonly subscriptions: Disposable[],
  /** Application datapath */
  readonly paths: string,
  /** Shared logger */
  readonly logger: Logger
}

export interface PluginScope {
  context: PluginContext
  dispose(): void
}

/** Process-wide registries that plugin contexts are scoped views of. */
import { IpcRouter } from '.'
export interface PluginRuntime {
  ipc: IpcRouter
  extensions: ExtensionRegistry
  commands: CommandRegistry
  contextKeys: ContextKeyService
  services: ServiceRegistry
  lifecycle: AppLifecycle
  events: EventHub
  paths: string
  logger: Logger
}
