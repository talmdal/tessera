// What the ledger adds to the shell, as plain data: File menu items, views, dialogs and a status item.
import { DIALOGS_EXTENSION_POINT } from '@tessera/types'
import type { DialogContribution } from '@tessera/types'
import { LEDGER_COMMANDS, LEDGER_CONTEXT_KEYS, LEDGER_DIALOGS, LEDGER_PLUGIN_ID, LEDGER_VIEWS } from '@tessera/ledger-api'

const FILE_MENU = 'shell.file'

export const MENUS = [
  { kind: 'group', id: 'ledger.file', parent: FILE_MENU, order: 0 },
  { kind: 'group', id: 'ledger.danger', parent: FILE_MENU, order: 10 },
  { kind: 'item', id: 'ledger.file.new', label: '&New Ledger…', parent: FILE_MENU, group: 'ledger.file', command: LEDGER_COMMANDS.new },
  { kind: 'item', id: 'ledger.file.open', label: '&Open Ledger…', parent: FILE_MENU, group: 'ledger.file', command: LEDGER_COMMANDS.open, accelerator: 'CmdOrCtrl+O' },
  { kind: 'item', id: 'ledger.file.close', label: '&Close Ledger', parent: FILE_MENU, group: 'ledger.file', command: LEDGER_COMMANDS.close },
  { kind: 'item', id: 'ledger.file.delete', label: '&Delete Ledger…', parent: FILE_MENU, group: 'ledger.danger', command: LEDGER_COMMANDS.delete }
] as const

export const VIEWS = [
  // Shown in the main area while no ledger is open; first, so it is the page people land on
  { id: LEDGER_VIEWS.start, title: 'Start', slot: 'shell.main', module: './StartView', icon: 'Home', order: -100, when: `!${LEDGER_CONTEXT_KEYS.isOpen}` },
  // Hidden while another plugin's navigator shows the tree (the accounts navigator, with accounts in it)
  { id: LEDGER_VIEWS.tree, title: 'Ledger', slot: 'shell.left', module: './LedgerTree', icon: 'AccountBalance', order: -100, when: `${LEDGER_CONTEXT_KEYS.isOpen} && !${LEDGER_CONTEXT_KEYS.hasNavigator}` }
] as const

export const DIALOGS: DialogContribution[] = [
  { id: LEDGER_DIALOGS.newLedger, title: 'New Ledger', module: './NewLedgerDialog', size: 'sm' },
  { id: LEDGER_DIALOGS.renameSubLedger, title: 'Rename Sub-Ledger', module: './RenameDialog', size: 'xs' }
]

export const BAR_ITEMS = [
  {
    kind: 'text', id: 'ledger.status.name', slot: 'shell.bottom', align: 'start', icon: 'AccountBalance',
    text: `Ledger: {${LEDGER_CONTEXT_KEYS.name}}`, when: LEDGER_CONTEXT_KEYS.isOpen, tooltip: 'The open ledger'
  }
] as const

/** Every contribution, as `[point, id, impl]`. */
export function contributions(): [string, string, unknown][] {
  return [
    ...MENUS.map(m => ['shell.menus', m.id, m] as [string, string, unknown]),
    ...VIEWS.map(v => ['shell.views', v.id, v] as [string, string, unknown]),
    ...DIALOGS.map(d => [DIALOGS_EXTENSION_POINT, d.id, d] as [string, string, unknown]),
    ...BAR_ITEMS.map(b => ['shell.bar.items', b.id, b] as [string, string, unknown])
  ]
}

export { LEDGER_PLUGIN_ID }
