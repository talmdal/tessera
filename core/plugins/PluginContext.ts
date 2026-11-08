// core/plugins/PluginContext.ts
import { channelFor } from '../../tessera-types'
import { ContextKeyServiceImpl } from '../context/ContextKeyService'
import {
  Disposable,
  PluginRuntime,
  PluginContext,
  PluginScope,
  Logger,
  SettingsReader
} from '@tessera/types'
import { APP_STATE_SERVICE, type AppState } from '@tessera/types'
import { ServiceRegistryImpl } from '../services/ServiceRegistry'
import { IpcRouterImpl } from '@core/ipc/IpcRouter'
import { ExtensionRegistryImpl } from '@core/extensions/ExtensionRegistry'
import { CommandRegistryImpl } from '@core/commands/CommandRegistry'
import { EventHubImpl } from '@core/ipc/EventHub'
import { AppLifecycleImpl } from '@core/lifecycle/AppLifecycle'
import { SettingsService } from '../settings/SettingsService'
import { createPluginState } from '../state/PluginState'
import type { SettingsPersistence } from '../ports'

export interface PluginRuntimeOptions {
  /** Where settings are kept. Without it they last for the session (tests). */
  settingsPersistence?: SettingsPersistence
}

/** Creates the registries, wired so command enablement follows context keys. */
export function createPluginRuntime(path?: string, log?: Logger, options: PluginRuntimeOptions = {}): PluginRuntime {
  const contextKeys = new ContextKeyServiceImpl()
  const extensions = new ExtensionRegistryImpl()
  return {
    ipc: new IpcRouterImpl(log),
    extensions,
    commands: new CommandRegistryImpl(contextKeys),
    contextKeys,
    services: new ServiceRegistryImpl(),
    lifecycle: new AppLifecycleImpl({ log }),
    events: new EventHubImpl(log),
    settings: new SettingsService({ extensions, persistence: options.settingsPersistence, log }),
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
  /** Services the plugin requires, from its manifest. `context.state` needs `app.state` among them. */
  requires?: readonly string[]
}

export function createPluginContext(pluginId: string, runtime: PluginRuntime, options: PluginContextOptions = {}): PluginScope {
  const subscriptions: Disposable[] = []

  const track = <D extends Disposable>(disposable: D): D => {
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
    // Scoped like commands: a plugin registers only namespaces it owns, and they go when it deactivates.
    settings: {
      register: definition => track(runtime.settings.register(pluginId, definition)),
      // Anyone's settings, to read only: there is no way to change another plugin's settings.
      read: <T extends object>(id: string): SettingsReader<T> => {
        const reader = runtime.settings.reader<T>(id)
        return { id: reader.id, get: () => reader.get(), onDidChange: listener => track(reader.onDidChange(listener)) }
      },
      snapshots: () => runtime.settings.snapshots()
    },
    // Its own keys in the app.state store. Looked up on each use: the app-state plugin provides it once it has activated.
    state: createPluginState(pluginId,
      () => runtime.services.has(APP_STATE_SERVICE) ? runtime.services.get<AppState>(APP_STATE_SERVICE) : undefined,
      { requires: options.requires }),
    events: {
      emit: (event, data) => {
        if (!event || event.includes(':')) throw new Error(`Plugin "${pluginId}" used invalid event name "${event}"`)
        runtime.events.publish(channelFor(pluginId, event), data)
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
