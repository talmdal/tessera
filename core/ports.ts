// core/ports.ts
//
// Ports the core depends on. Adapters live in shell/main. Nothing in core/ may
// import electron or node:* — tests/architecture enforces this.

import { PluginManifest } from "@shared/plugins/manifest"
import type { OptionsDocument } from "@tessera/types"

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


/**
 * Where options are kept. The JSON-file adapter lives in shell/main.
 *
 * `read` is synchronous and never throws: the shell reads options before anything else happens, and a missing or
 * damaged file must leave the application starting on its defaults rather than not starting at all.
 */
export interface OptionsStore {
  /** The whole document. A missing or unreadable file is an empty document. */
  read(): OptionsDocument
  /** Queues a write of the whole document. Writes may be coalesced; `flush` settles them. */
  write(document: OptionsDocument): void
  /** Resolves once every queued write has been written. Called while shutting down. */
  flush(): Promise<void>
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
