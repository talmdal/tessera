// shared/views/types.ts
import { channelFor } from '@tessera/types'
import { SHELL_CONTRIBUTOR_ID } from '../plugins/manifest'

/** Extension point that view contributions are registered under. */
export const VIEWS_EXTENSION_POINT = 'shell.views'

/** Slots the shell's layout renders. */
export const MAIN_SLOT = 'shell.main'

/** IPC channel the renderer uses to fetch resolved views; the shell handles VIEWS_LIST_EVENT. */
export const VIEWS_LIST_EVENT = 'views.list'
export const VIEWS_LIST_CHANNEL = channelFor(SHELL_CONTRIBUTOR_ID, VIEWS_LIST_EVENT)

/** Push event: the set of views changed. Re-request VIEWS_LIST_CHANNEL. No payload. */
export const VIEWS_CHANGED = channelFor(SHELL_CONTRIBUTOR_ID, 'views.changed')

/**
 * A view, contributed from a plugin's privileged `activate`. Pure data: the
 * component lives in the plugin's renderer remote and is only loaded when the
 * slot it targets is rendered.
 */
export interface ViewContribution {
  id: string
  title: string
  /** Slot to render in, e.g. MAIN_SLOT. */
  slot: string
  /** Module the plugin's renderer remote exposes, e.g. "./AccountsView". Its default export is the component. */
  module: string
  /** Lower sorts first within the slot. Ties keep registration order. Defaults to 0. */
  order?: number
}

/** A view resolved by the main process, with everything the renderer needs to load it. */
export interface ViewDescriptor {
  id: string
  title: string
  slot: string
  module: string
  pluginId: string
  /** URL of the plugin's federation remote entry. */
  remoteEntry: string
}
