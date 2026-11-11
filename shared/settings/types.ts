// shared/settings/types.ts — the wire contract between the main process and a window's Options dialog.
import { channelFor } from '@tessera/types'
import type { SettingsNamespaceSnapshot, SettingsPageDescriptor } from '@tessera/types'
import { SHELL_CONTRIBUTOR_ID } from '../plugins/manifest'

export { SETTINGS_OPEN_COMMAND, SETTINGS_PAGES_EXTENSION_POINT } from '@tessera/types'

const shell = (event: string) => channelFor(SHELL_CONTRIBUTOR_ID, event)

/** Request → `SettingsCatalogue`: every page and every namespace, as they are now. */
export const SETTINGS_GET = shell('settings.get')

/** Request (`SettingsCommitRequest`) → `SettingsCommitResult`: applies the dialog's changes, all or none. */
export const SETTINGS_COMMIT = shell('settings.commit')

/** Push event: the Options dialog should open in the window named (`SettingsOpen`). */
export const SETTINGS_OPEN = shell('settings.open')

/** Push event: a namespace's value changed (`SettingsChanged`), from any window or from its owner. */
export const SETTINGS_CHANGED = shell('settings.changed')

/** A page with what the renderer needs to load its component. */
export interface SettingsPageInfo extends SettingsPageDescriptor {
  /**
   * URL of the plugin's federation remote entry, for a page with a `module`. Absent for the shell's own pages, whose
   * components the renderer already has, and for pages the shell draws (`fields`) or categories.
   */
  remoteEntry?: string
}

export interface SettingsCatalogue {
  /** In tree order: each page is followed by the pages under it. */
  pages: SettingsPageInfo[]
  namespaces: SettingsNamespaceSnapshot[]
}

export interface SettingsCommitRequest {
  changes: { id: string, value: unknown }[]
}

/** The namespace as it is now, and which of its settings changed (keys, or dotted paths into nested objects). */
export type SettingsChanged = SettingsNamespaceSnapshot & { changed: string[] }

export interface SettingsOpen {
  windowId: number
  /** The page to show first. */
  page?: string
}
