// shell/renderer/views/federationViewLoader.ts
import type { ViewDescriptor } from '@tessera/types'
import { createInstance, ModuleFederation } from '@module-federation/runtime'
import * as React from 'react'
import * as ReactDOM from 'react-dom'
import * as JsxRuntime from 'react/jsx-runtime'
import type { ComponentType } from 'react'
import { ViewLoader } from './ports'

const singleton = (lib: object, version: string) => ({
  version,
  lib: () => lib,
  shareConfig: { singleton: true, requiredVersion: `^${version}` }
})

/** The shell's federation host. Plugins receive the shell's React rather than bundling their own. */
export function createShellFederation(): ModuleFederation {
  return createInstance({
    name: 'tessera_shell',
    remotes: [],
    shared: {
      'react': singleton(React, React.version),
      'react/jsx-runtime': singleton(JsxRuntime, React.version),
      'react-dom': singleton(ReactDOM, ReactDOM.version)
    }
  })
}

/**
 * Loads view components from plugin renderer remotes. Each plugin is a
 * federation remote named by its plugin id; a view's `module` is an exposed
 * module whose default export is the component.
 */
export function createFederationViewLoader(federation: ModuleFederation = createShellFederation()): ViewLoader {
  const registered = new Map<string, string>()

  return {
    async load(view: ViewDescriptor) {
      const entry = registered.get(view.pluginId)
      if (entry !== view.remoteEntry) {
        federation.registerRemotes([{ name: view.pluginId, entry: view.remoteEntry, type: 'module' }], { force: entry !== undefined })
        registered.set(view.pluginId, view.remoteEntry)
      }

      const module = await federation.loadRemote<{ default?: unknown }>(`${view.pluginId}/${view.module.slice(2)}`)
      const component = module?.default
      if (!isComponent(component)) {
        throw new Error(`View "${view.id}": ${view.pluginId} module ${view.module} has no default-exported component`)
      }
      return component
    }
  }
}

function isComponent(value: unknown): value is ComponentType {
  // Function and class components, or memo/forwardRef/lazy wrappers.
  return typeof value === 'function' || (typeof value === 'object' && value !== null && '$$typeof' in value)
}
