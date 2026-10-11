// shared/plugins/types.ts

export interface PluginManifest {
  id: string
  name: string
  version: string
  privileged: {
    entry: string // e.g. "privileged/index.js"
  }
  renderer?: {
    entry: string // e.g. "renderer/index.js"
  }
}

export interface PrivilegedPluginModule {
  activate: (context: PluginContext) => Promise<void> | void
}

export interface LoadedPlugin {
  id: string
  manifest: PluginManifest
  privileged: PrivilegedPluginModule
}

export interface Services {
  // expand later
  vault: {
    createVault: (name: string) => Promise<string>
  }
}
