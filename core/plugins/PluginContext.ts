// core/plugins/PluginContext.ts
import { channelFor } from '../../tessera-types'
import { ContextKeyServiceImpl } from '../context/ContextKeyService'
import {
  Disposable,
  OptionsRegistrar,
  PluginRuntime,
  PluginContext,
  PluginScope,
  Logger
} from '@tessera/types'
import { ServiceRegistryImpl } from '../services/ServiceRegistry'
import { IpcRouterImpl } from '@core/ipc/IpcRouter'
import { ExtensionRegistryImpl } from '@core/extensions/ExtensionRegistry'
import { CommandRegistryImpl } from '@core/commands/CommandRegistry'
import { EventHubImpl } from '@core/ipc/EventHub'
import { AppLifecycleImpl } from '@core/lifecycle/AppLifecycle'
import { OptionsService } from '@core/options/OptionsService'
import { createMemoryOptionsStore } from '@core/options/memoryOptionsStore'

/**
 * Creates the registries, wired so command enablement follows context keys.
 *
 * `options` is the one registry the shell builds itself, because it is read from a file before anything else
 * happens. Without one, options last for the session, which is what tests want.
 */
export function createPluginRuntime(path?: string, log?: Logger, options?: OptionsRegistrar): PluginRuntime {
  const contextKeys = new ContextKeyServiceImpl()
  return {
    ipc: new IpcRouterImpl(log),
    extensions: new ExtensionRegistryImpl(),
    commands: new CommandRegistryImpl(contextKeys),
    contextKeys,
    services: new ServiceRegistryImpl(),
    lifecycle: new AppLifecycleImpl({ log }),
    events: new EventHubImpl(log),
    options: options ?? new OptionsService(createMemoryOptionsStore(), { log }),
    paths: path ?? '/tmp/tessera-test',
    logger: log ? log : console
  }
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
    ipc: runtime.ipc,
    commands: {
      onDidChange: runtime.commands.onDidChange,
      register: (id, handler, options) => {
        assertOwned('command', id)
        return track(runtime.commands.register(id, handler, options))
      },
      has: id => runtime.commands.has(id),
      isEnabled: id => runtime.commands.isEnabled(id),
      execute: (id, ...args) => runtime.commands.execute(id, ...args)
    },
    extensions: runtime.extensions,
    contextKeys: runtime.contextKeys,
    services: runtime.services,
    lifecycle: runtime.lifecycle,
    events: {
      emit: (event, data) => {
        if (!event || event.includes(':')) throw new Error(`Plugin "${pluginId}" used invalid event name "${event}"`)
        runtime.events.publish(channelFor(pluginId, event), data)
      }
    },
    // Bound to this plugin's namespace: there is no namespace argument to pass, so a plugin can neither read nor
    // write another's options. The registration is forgotten when the plugin deactivates; its values stay.
    options: {
      register: spec => {
        const handle = runtime.options.register(pluginId, spec)
        track({ dispose: () => runtime.options.unregister(pluginId) })
        return handle
      }
    },
    subscriptions,
    paths: runtime.paths,
    logger: runtime.logger
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
