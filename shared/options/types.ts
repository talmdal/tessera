// shared/options/types.ts — ids, channel names and the shell's own option categories.
import { channelFor } from '@tessera/types'
import type { ThemeSelection } from '@tessera/types'
import { SHELL_CONTRIBUTOR_ID } from '../plugins/manifest'
import { DEFAULT_SELECTION } from '../theme/selection'

const shell = (event: string) => channelFor(SHELL_CONTRIBUTOR_ID, event)

/** Extension point plugins contribute option pages to. Defined in `@tessera/types`, where plugins can reach it. */
export { OPTIONS_EXTENSION_POINT } from '@tessera/types'

/** Commands the shell registers for options. */
export const OPTIONS_COMMANDS = {
  /**
   * Opens the options dialog in the focused window. Optional argument `{ page }`: a page id to open at, so a warning
   * can lead straight to the setting it is about. An unknown page opens the first page instead.
   */
  open: 'shell.options.open'
} as const

/** Request (renderer → main): the resolved page tree. */
export const OPTIONS_PAGES = shell('options.pages')          // → OptionsPageNode[]

/**
 * Push event (main → renderer): open the options dialog in this window.
 *
 * `session` is minted by the open command and is what the edit channels below demand, so options can be read and
 * written only while the user has the dialog open, through the dialog they opened. It dies when the dialog
 * closes, or when a newer one opens in the same window.
 */
export const OPTIONS_OPEN = shell('options.open')            // OptionsOpen
export interface OptionsOpen { windowId: number, session: string, /** The page to start on. */ page?: string }

/** Request (renderer → main): a namespace's current value and defaults, to seed the dialog's draft. */
export const OPTIONS_GET = shell('options.get')              // OptionsGet → OptionsValues | null
export interface OptionsGet { session: string, namespace: string }
export interface OptionsValues { value: unknown, defaults: unknown }

/**
 * Request (renderer → main): save the dirty namespaces. Each is validated and saved on its own, so one plugin's
 * validation failure costs nobody else their save. The answer maps each namespace to its validation messages:
 * an empty array means it was saved.
 */
export const OPTIONS_COMMIT = shell('options.commit')        // OptionsCommit → Record<string, string[]>
export interface OptionsCommit { session: string, changes: Record<string, unknown> }

/** Request (renderer → main): the dialog closed; the session is dead. */
export const OPTIONS_CLOSED = shell('options.closed')        // OptionsClosed
export interface OptionsClosed { session: string }

/** The categories the shell contributes, so plugins always have somewhere to nest. */
export const OPTIONS_CATEGORIES = {
  general: 'shell.options.general',
  appearance: 'shell.options.appearance'
} as const

/**
 * A page as the renderer receives it: validated, placed in the tree and ordered.
 *
 * `pluginId` is the plugin whose options namespace the page edits — the contributor, not anything the descriptor
 * says — which is what binds a page to the values it is allowed to change.
 */
export interface OptionsPageNode {
  id: string
  title: string
  pluginId: string
  /** The module the plugin's remote exposes. Absent on a category: a node that only groups other pages. */
  module?: string
  /** URL of the plugin's federation remote entry. Absent on a category. */
  remoteEntry?: string
  /** Searched along with the title. */
  keywords: string[]
  children: OptionsPageNode[]
}

/**
 * The shell's own options: one namespace per plugin, and the shell is one plugin, so each shell concern is a
 * branch of this one value. `appearance` is the application-wide theme selection, edited by the Appearance page
 * and applied by the theme manager when the user saves.
 */
export interface ShellOptionsValue {
  appearance: ThemeSelection
}

export const SHELL_OPTIONS_DEFAULTS: ShellOptionsValue = { appearance: { ...DEFAULT_SELECTION } }
