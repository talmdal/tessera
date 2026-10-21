// core/ports.ts
//
// Ports the core depends on. Adapters live in shell/main. Nothing in core/ may
// import electron or node:* — tests/architecture enforces this.

import { PluginManifest } from "@shared/plugins/manifest"

/** Where a plugin was found: shipped with the app, or installed by the user. */
export type PluginOrigin = 'bundled' | 'user'

/** A plugin found by a PluginSource. `location` is opaque to the core. */
export interface PluginDescriptor {
  location: string
  manifest: PluginManifest
  origin?: PluginOrigin
}

export interface PluginSource {
  discover(): Promise<PluginDescriptor[]>
  /** Loads a module from the plugin, resolving `entry` relative to its location. */
  load(descriptor: PluginDescriptor, entry: string): Promise<unknown>
}
