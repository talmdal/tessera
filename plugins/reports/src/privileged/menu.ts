// The reports offered, mirrored into the Reports menu. A menu item names a command with no arguments, and the menu is
// built once, after every plugin has activated; so as each definition reaches `reports.definitions`, a command
// `reports.show.<definition id>` is registered (enabled while a ledger is open and the definition's `when` holds) and an
// item contributed under its group's submenu. Every plugin contributes while activating, before the menu is built. One
// contributed later is in the Reports tab at once and in the menu after a restart; one withdrawn has its command
// unregistered, so its item is disabled until then. See docs/reporting-design.md, "The Reports menu, commands and
// context keys".
import type { Disposable, PluginContext } from '@tessera/types'
import { LEDGER_CONTEXT_KEYS } from '@tessera/ledger-api'
import { REPORTS_MENU, REPORTS_PLUGIN_ID, showCommandOf, type ReportDefinitionInfo, type ReportGroupInfo } from '@tessera/reports-api'
import { MENU_GROUPS } from './contributions'

const MENUS_POINT = 'shell.menus'

/** A menu label as written: `&` stands for itself, not a mnemonic. */
const literal = (label: string) => label.replace(/&/g, '&&')

/** The submenu a group's reports are in. */
export const groupMenuId = (groupId: string) => `reports.menu.group.${groupId}`

/** The command's enablement: a ledger open, and the definition's `when`. */
export const enablementOf = (when?: string) => when ? `${LEDGER_CONTEXT_KEYS.isOpen} && (${when})` : LEDGER_CONTEXT_KEYS.isOpen

interface Mirrored {
  when?: string
  command: Disposable
  item: Disposable
}

export class MenuMirror implements Disposable {
  private readonly mirrored = new Map<string, Mirrored>()
  private readonly groups = new Map<string, Disposable>()

  constructor(
    private readonly context: Pick<PluginContext, 'commands' | 'extensions'>,
    private readonly definitions: () => ReportDefinitionInfo[],
    /** What a definition's command does: shows it. */
    private readonly show: (definitionId: string) => Promise<boolean>
  ) {}

  /** Brings the commands and items in line with the definitions offered now. */
  sync(): void {
    const offered = this.definitions()
    const ids = new Set(offered.map(d => d.id))
    for (const [id, m] of this.mirrored) {
      if (ids.has(id)) continue
      m.command.dispose()
      m.item.dispose()
      this.mirrored.delete(id)
    }
    for (const d of offered) {
      const had = this.mirrored.get(d.id)
      if (had && had.when === d.when) continue
      had?.command.dispose()
      had?.item.dispose()
      this.group(d.group)
      const command = this.context.commands.register(showCommandOf(d.id), () => this.show(d.id), { enablement: enablementOf(d.when) })
      const item = this.context.extensions.contribute(REPORTS_PLUGIN_ID, MENUS_POINT, `reports.menu.item.${d.id}`, {
        kind: 'item', id: `reports.menu.item.${d.id}`, label: literal(d.label), parent: groupMenuId(d.group.id), command: showCommandOf(d.id), order: d.order
      })
      this.mirrored.set(d.id, { ...(d.when && { when: d.when }), command, item })
    }
  }

  /** A group's submenu, contributed once. (An empty one isn't drawn.) */
  private group(group: ReportGroupInfo) {
    if (this.groups.has(group.id)) return
    this.groups.set(group.id, this.context.extensions.contribute(REPORTS_PLUGIN_ID, MENUS_POINT, groupMenuId(group.id), {
      kind: 'menu', id: groupMenuId(group.id), label: literal(group.label), parent: REPORTS_MENU, group: MENU_GROUPS.reports, order: group.order
    }))
  }

  dispose(): void {
    for (const m of this.mirrored.values()) { m.command.dispose(); m.item.dispose() }
    this.mirrored.clear()
    for (const g of this.groups.values()) g.dispose()
    this.groups.clear()
  }
}
