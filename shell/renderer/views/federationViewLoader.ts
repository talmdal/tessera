// shell/renderer/views/federationViewLoader.ts
import { createInstance, ModuleFederation } from '@module-federation/runtime'
import * as React from 'react'
import * as ReactDOM from 'react-dom'
import * as JsxRuntime from 'react/jsx-runtime'
import * as EmotionReact from '@emotion/react'
import * as EmotionStyled from '@emotion/styled'
import * as Mui from '@mui/material'
import * as TesseraUi from '@tessera/ui'
import { version as emotionReactVersion } from '@emotion/react/package.json'
import { version as emotionStyledVersion } from '@emotion/styled/package.json'
import { version as muiVersion } from '@mui/material/package.json'
import type { ComponentType } from 'react'
import { SHARED_MODULES, SharedModule } from '../../../shared/federation'
import type { ViewDescriptor } from '../../../shared/views/types'
import { ViewLoader } from './ports'

const singleton = (name: SharedModule, lib: object, version: string) => ({
  version,
  lib: () => lib,
  shareConfig: { singleton: true, requiredVersion: SHARED_MODULES[name] }
})

/**
 * The shell's federation host. Plugins receive the shell's copy of every module
 * in SHARED_MODULES (React, Emotion, MUI and @tessera/ui) rather than bundling
 * their own, which is what lets their views share the shell's theme.
 */
export function createShellFederation(): ModuleFederation {
  const shared: Record<SharedModule, ReturnType<typeof singleton>> = {
    'react': singleton('react', React, React.version),
    'react/jsx-runtime': singleton('react/jsx-runtime', JsxRuntime, React.version),
    'react-dom': singleton('react-dom', ReactDOM, ReactDOM.version),
    '@emotion/react': singleton('@emotion/react', EmotionReact, emotionReactVersion),
    '@emotion/styled': singleton('@emotion/styled', EmotionStyled, emotionStyledVersion),
    '@mui/material': singleton('@mui/material', Mui, muiVersion),
    '@tessera/ui': singleton('@tessera/ui', TesseraUi, TesseraUi.version)
  }
  return createInstance({ name: 'tessera_shell', remotes: [], shared })
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
