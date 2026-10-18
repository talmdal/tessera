// core/plugins/PluginContext.ts
import type { ContextKeyValue } from '../../shared/context/when'
import { channelFor } from '../../shared/ipc'
import { CommandHandler, CommandOptions, CommandRegistry } from '../commands/CommandRegistry'
import { ContextKeyService } from '../context/ContextKeyService'
import { ExtensionContribution, ExtensionRegistry } from '../extensions/ExtensionRegistry'
import { IpcHandler, IpcRouter } from '../ipc/IpcRouter'
import { Disposable, Logger } from '../ports'
import { ServiceRegistry } from '../services/ServiceRegistry'

/** Process-wide registries that plugin contexts are scoped views of. */
export interface PluginRuntime {
  ipc: IpcRouter
  extensions: ExtensionRegistry
  commands: CommandRegistry
  contextKeys: ContextKeyService
  services: ServiceRegistry
}

/** Creates the registries, wired so command enablement follows context keys. */
export function createPluginRuntime(log?: Logger): PluginRuntime {
  const contextKeys = new ContextKeyService()
  return {
    ipc: new IpcRouter(log),
    extensions: new ExtensionRegistry(),
    commands: new CommandRegistry(contextKeys),
    contextKeys,
    services: new ServiceRegistry()
  }
}

/**
 * What a plugin sees. Every id it registers must be its plugin id or start
 * with `<pluginId>.`, and IPC handlers are bound to `<pluginId>:<event>`, so a
 * plugin cannot claim another plugin's (or the shell's) names. Everything
 * registered through the context is undone when the plugin is deactivated.
 */
export interface PluginContext {
  readonly pluginId: string
  readonly ipc: {
    handle<TReq, TRes>(event: string, handler: IpcHandler<TReq, TRes>): Disposable
  }
  readonly commands: {
    register(id: string, handler: CommandHandler, options?: CommandOptions): Disposable
    has(id: string): boolean
    isEnabled(id: string): boolean
    execute(id: string, ...args: unknown[]): Promise<unknown>
  }
  /** State read by enablement expressions. Plugins may set only their own keys; all are removed on deactivation. */
  readonly contextKeys: {
    set(key: string, value: ContextKeyValue | undefined): void
    get(key: string): ContextKeyValue | undefined
  }
  readonly extensions: {
    contribute<T extends { id: string }>(point: string, contribution: T): Disposable
    getContributions(point: string): ExtensionContribution[]
  }
  /**
   * Objects other plugins call, e.g. "vault.store". Declare what you provide in
   * the manifest's services.provides, and what you need in services.requires so
   * you activate after the provider.
   */
  readonly services: {
    provide<T extends object>(id: string, impl: T): Disposable
    get<T = unknown>(id: string): T
    has(id: string): boolean
  }
  /** Disposed, last first, on deactivation. Plugins may push their own disposables. */
  readonly subscriptions: Disposable[]
}

export interface PluginScope {
  context: PluginContext
  dispose(): void
}

export function isOwnedId(pluginId: string, id: string) {
  return id === pluginId || id.startsWith(`${pluginId}.`)
}

export interface PluginContextOptions {
  /** Services the plugin may provide, from its manifest. Omit for the shell, which is unrestricted. */
  provides?: readonly string[]
}

export function createPluginContext(pluginId: string, runtime: PluginRuntime, options: PluginContextOptions = {}): PluginScope {
  const subscriptions: Disposable[] = []

  const track = (disposable: Disposable) => {
    subscriptions.push(disposable)
    return disposable
  }

  const assertOwned = (kind: string, id: unknown) => {
    if (typeof id !== 'string' || !isOwnedId(pluginId, id)) {
      throw new Error(`Plugin "${pluginId}" cannot register ${kind} "${String(id)}": ids must start with "${pluginId}."`)
    }
  }

  const context: PluginContext = {
    pluginId,
    ipc: {
      handle: (event, handler) => {
        if (!event || event.includes(':')) throw new Error(`Plugin "${pluginId}" used invalid IPC event "${event}"`)
        return track(runtime.ipc.register(channelFor(pluginId, event), handler))
      }
    },
    commands: {
      register: (id, handler, options) => {
        assertOwned('command', id)
        return track(runtime.commands.register(id, handler, options))
      },
      has: id => runtime.commands.has(id),
      isEnabled: id => runtime.commands.isEnabled(id),
      execute: (id, ...args) => runtime.commands.execute(id, ...args)
    },
    extensions: {
      contribute: (point, contribution) => {
        assertOwned(`${point} contribution`, contribution?.id)
        return track(runtime.extensions.contribute(pluginId, point, contribution.id, contribution))
      },
      getContributions: point => runtime.extensions.getContributions(point)
    },
    contextKeys: {
      set: (key, value) => {
        assertOwned('context key', key)
        runtime.contextKeys.set(key, value)
      },
      get: key => runtime.contextKeys.get(key)
    },
    services: {
      provide: (id, impl) => {
        if (options.provides && !options.provides.includes(id)) {
          throw new Error(`Plugin "${pluginId}" cannot provide service "${id}": declare it in the manifest's services.provides`)
        }
        return track(runtime.services.provide(pluginId, id, impl))
      },
      get: id => runtime.services.get(id),
      has: id => runtime.services.has(id)
    },
    subscriptions
  }

  // Disposed last, so a plugin's commands are gone before its state is cleared.
  subscriptions.push({ dispose: () => runtime.contextKeys.deleteNamespace(pluginId) })

  return {
    context,
    dispose: () => {
      for (const disposable of subscriptions.splice(0).reverse()) {
        try {
          disposable.dispose()
        } catch {
          // Keep unwinding; one failing disposable must not leak the rest.
        }
      }
    }
  }
}
