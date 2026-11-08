// core/ports.ts
//
// Ports the core depends on. Adapters live in shell/main. Nothing in core/ may
// import electron or node:* — tests/architecture enforces this.

import type { JsonObject } from '@tessera/types'
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

/** A settings namespace as it is kept: the version of its shape when saved, and only what differs from the defaults. */
export interface StoredSettings {
  version: number
  values: JsonObject
}

/** Where settings are kept, one document per namespace. Adapted to JSON files under the user-data folder in shell/main. */
export interface SettingsPersistence {
  /**
   * Every saved namespace's document, by namespace id, as read: the service checks them. The adapter leaves out (and
   * sets aside) a document it can't read, so one bad file never costs the others.
   */
  loadAll(): Promise<Record<string, unknown>>
  /** Replaces a namespace's document, atomically; `undefined` removes it (everything is at its default). */
  save(id: string, document: StoredSettings | undefined): Promise<void>
}
