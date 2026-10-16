// core/plugins/types.ts
import type { PluginContext } from './PluginContext'

export interface PrivilegedPluginModule {
  activate: (context: PluginContext) => Promise<void> | void
  deactivate?: () => Promise<void> | void
}
