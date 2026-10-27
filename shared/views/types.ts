// shared/views/types.ts
//
// Values of the `shell.views` extension point: its name, the slot ids and the
// IPC channels. The contribution and descriptor interfaces are in
// @tessera/types (tessera-types/views.ts).
import { channelFor } from '@tessera/types'
import { SHELL_CONTRIBUTOR_ID } from '../plugins/manifest'

/** Extension point that view contributions are registered under. */
export const VIEWS_EXTENSION_POINT = 'shell.views'

/** Slots the shell's layout renders: the centre, and a bar on each side. */
export const MAIN_SLOT = 'shell.main'
export const TOP_SLOT = 'shell.top'
export const BOTTOM_SLOT = 'shell.bottom'
export const LEFT_SLOT = 'shell.left'
export const RIGHT_SLOT = 'shell.right'

/** The four bar slots. Views here are tabbed and need an icon for the collapsed rail. */
export const BAR_SLOTS: readonly string[] = [TOP_SLOT, BOTTOM_SLOT, LEFT_SLOT, RIGHT_SLOT]

/** Every slot a view may target. */
export const ALL_SLOTS: readonly string[] = [MAIN_SLOT, ...BAR_SLOTS]

export function isBarSlot(slot: string) {
  return BAR_SLOTS.includes(slot)
}

/** IPC channel the renderer uses to fetch resolved views; the shell handles VIEWS_LIST_EVENT. */
export const VIEWS_LIST_EVENT = 'views.list'
export const VIEWS_LIST_CHANNEL = channelFor(SHELL_CONTRIBUTOR_ID, VIEWS_LIST_EVENT)

/** Push event: the set of views changed. Re-request VIEWS_LIST_CHANNEL. No payload. */
export const VIEWS_CHANGED = channelFor(SHELL_CONTRIBUTOR_ID, 'views.changed')
