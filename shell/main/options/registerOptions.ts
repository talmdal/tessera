// shell/main/options/registerOptions.ts
import { randomUUID } from 'node:crypto'
import type { IpcMessage, Logger, OptionsPageDescriptor, PluginContext, PluginRuntime } from '@tessera/types'
import type { OptionsService } from '../../../core/options/OptionsService'
import { MENUS_EXTENSION_POINT, MenuContribution, TOOLS_MENU } from '../../../shared/menus/types'
import { resolveOptionPages } from '../../../shared/options/resolveOptionPages'
import {
  OPTIONS_CATEGORIES, OPTIONS_CLOSED, OPTIONS_COMMIT, OPTIONS_COMMANDS, OPTIONS_EXTENSION_POINT, OPTIONS_GET,
  OPTIONS_OPEN, OPTIONS_PAGES, OptionsClosed, OptionsCommit, OptionsGet, OptionsOpen, OptionsValues
} from '../../../shared/options/types'
import { SHELL_GROUP_ORDER } from '../menus/coreMenus'

/** Where Tools ▸ Options… sits: above the shell's developer group, which sorts last. */
const OPTIONS_GROUP = 'shell.options'

const optionsMenus: MenuContribution[] = [
  { kind: 'group', id: OPTIONS_GROUP, parent: TOOLS_MENU, order: SHELL_GROUP_ORDER - 1 },
  {
    kind: 'item',
    id: 'shell.tools.options',
    label: '&Options…',
    parent: TOOLS_MENU,
    group: OPTIONS_GROUP,
    command: OPTIONS_COMMANDS.open,
    accelerator: 'CmdOrCtrl+,'
  }
]

/**
 * The shell's own nodes: General is a category for plugins to nest under; Appearance is a page (built into the
 * shell's renderer, like its built-in dialogs) where the application theme is chosen.
 */
const categories: OptionsPageDescriptor[] = [
  { id: OPTIONS_CATEGORIES.general, title: 'General', order: 0 },
  { id: OPTIONS_CATEGORIES.appearance, title: 'Appearance', order: 10, module: './AppearancePage' }
]

export interface OptionsHostDependencies {
  /** The service the shell built from the tier-0 file, before any plugin activated. */
  options: OptionsService
  /** The renderer remote entry of a plugin, or undefined when it has none. */
  remoteEntryFor(pluginId: string): string | undefined
  /** The window to open the dialog in: the focused one, else the first. Undefined when there is no window. */
  targetWindow(): number | undefined
  log: Logger
  /** Session ids. Tests pass something predictable. */
  newSessionId?(): string
}

/**
 * The options dialog's main-process half: the command that opens it, its menu item, the shell's own categories,
 * the page tree, and the edit channels the dialog drives.
 *
 * The dialog is drawn in the window's own page, like the theme chooser, so opening it is an event to that window.
 * The event carries a **session id**, and the edit channels demand it: options can be read and written over IPC
 * only while the user has the dialog open, through the dialog they opened. One session per window; opening again
 * replaces it, closing ends it. This is the middle of the three ownership rules — what keeps one *plugin* out of
 * another's options is the namespace-bound `context.options`. See docs/options-framework-design.md.
 */
export function registerOptions(shell: PluginContext, runtime: PluginRuntime, deps: OptionsHostDependencies) {
  const { options, remoteEntryFor, targetWindow, log, newSessionId = randomUUID } = deps

  /** The live sessions: id → the window whose dialog holds it. */
  const sessions = new Map<string, number>()

  /** The window a message's session belongs to must be the window the message came from. */
  const validated = (msg: IpcMessage<{ session?: unknown }>): string => {
    const session = msg.data?.session
    if (typeof session !== 'string' || !sessions.has(session) || sessions.get(session) !== msg.sender?.windowId) {
      throw new Error('Options can only be edited by the options dialog, while it is open')
    }
    return session
  }

  shell.commands.register(OPTIONS_COMMANDS.open, (args?: unknown) => {
    const requested = (args as { page?: unknown } | undefined)?.page
    const page = typeof requested === 'string' && requested !== '' ? requested : undefined
    const windowId = targetWindow()
    if (windowId === undefined) throw new Error('There is no window')
    // One session per window, and running the command again while the dialog is up keeps it: replacing it would
    // strand the open dialog with a session its commits would be refused under, losing whatever is pending.
    const existing = [...sessions].find(([, owner]) => owner === windowId)?.[0]
    const session = existing ?? newSessionId()
    sessions.set(session, windowId)
    runtime.events.publish(OPTIONS_OPEN, { windowId, session, ...(page !== undefined && { page }) } satisfies OptionsOpen)
  })

  for (const contribution of optionsMenus) {
    shell.extensions.contribute(shell.pluginId, MENUS_EXTENSION_POINT, contribution.id, contribution)
  }
  for (const category of categories) {
    shell.extensions.contribute(shell.pluginId, OPTIONS_EXTENSION_POINT, category.id, category)
  }

  // Resolved per request, so pages contributed by a plugin activated after startup are included.
  shell.ipc.register(OPTIONS_PAGES, msg => {
    // Only a real window may ask. This is the weaker half of the ownership rules: within one window a plugin's
    // remote shares the page with the dialog, so what keeps a plugin out of another's options is the
    // namespace-bound `context.options`, not this. See docs/options-framework-design.md.
    if (msg.sender?.windowId === undefined || msg.sender.windowId < 0) throw new Error('Options can only be read by a window')

    const { pages, diagnostics } = resolveOptionPages(
      shell.extensions.getContributions(OPTIONS_EXTENSION_POINT), remoteEntryFor)
    for (const message of diagnostics) log.warn(`[options] ${message}`)
    return pages
  })

  // A namespace's value and defaults, to seed the dialog's draft. Null when nothing registered the namespace —
  // a page contributed by a plugin that never called context.options.register.
  shell.ipc.register(OPTIONS_GET, (msg: IpcMessage<OptionsGet>) => {
    validated(msg)
    const namespace = msg.data?.namespace
    if (typeof namespace !== 'string') throw new Error('Which namespace?')
    if (!options.has(namespace)) return null
    return { value: options.get(namespace), defaults: options.defaults(namespace) } satisfies OptionsValues
  })

  // Each namespace commits on its own: the answer maps it to its validation messages, empty meaning saved.
  shell.ipc.register(OPTIONS_COMMIT, (msg: IpcMessage<OptionsCommit>) => {
    validated(msg)
    const changes = msg.data?.changes
    if (typeof changes !== 'object' || changes === null || Array.isArray(changes)) throw new Error('Malformed commit')

    const results: Record<string, string[]> = {}
    for (const [namespace, value] of Object.entries(changes)) {
      try {
        results[namespace] = options.commit(namespace, value)
      } catch (err) {
        // Unregistered (its plugin is gone, or never registered): the page should not have been editable, but
        // answering beats crashing the whole commit.
        results[namespace] = [err instanceof Error ? err.message : String(err)]
      }
    }
    return results
  })

  shell.ipc.register(OPTIONS_CLOSED, (msg: IpcMessage<OptionsClosed>) => {
    sessions.delete(validated(msg))
  })
}
