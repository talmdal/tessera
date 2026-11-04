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


/** The platform's light/dark setting. Adapted to Electron's `nativeTheme` in shell/main. */
export interface ThemePort {
  /** True while the operating system wants dark colours. */
  readonly systemPrefersDark: boolean
  /**
   * Applies the application-wide mode to platform chrome (menus, dialogs):
   * `system` hands control back to the OS, `light` and `dark` force it.
   */
  setSource(mode: 'system' | 'light' | 'dark'): void
  /** Fires when `systemPrefersDark` may have changed. Returns an unsubscribe. */
  onSystemChange(listener: () => void): () => void
}
