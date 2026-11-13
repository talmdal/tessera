// What the export plugin adds, as plain data: File › Export…, Accounts › Export Account…, and the dialog.
import { DIALOGS_EXTENSION_POINT, type DialogContribution } from '@tessera/types'
import { EXPORT_COMMANDS, EXPORT_DIALOGS } from '@tessera/export-api'

const FILE_MENU = 'shell.file'
/** The accounts plugin's menu, and its group for what is done with one account's transactions. */
const ACCOUNTS_MENU = 'accounts.menu'
const ACCOUNTS_REGISTER_GROUP = 'accounts.menu.register'

export const MENUS = [
  // After the import's items (order 5), before Back Up Ledger… (order 7)
  { kind: 'group', id: 'export.file', parent: FILE_MENU, order: 6 },
  { kind: 'item', id: 'export.file.export', label: '&Export…', parent: FILE_MENU, group: 'export.file', command: EXPORT_COMMANDS.file },
  // After Open Register, New Transaction and Reconcile with Statement…
  {
    kind: 'item', id: 'export.accounts.export', label: 'Ex&port Account…', parent: ACCOUNTS_MENU, group: ACCOUNTS_REGISTER_GROUP,
    order: 10, command: EXPORT_COMMANDS.account
  }
] as const

export const DIALOGS: DialogContribution[] = [
  { id: EXPORT_DIALOGS.export, title: 'Export', module: './ExportDialog', size: 'md' }
]

/** Every contribution, as `[point, id, impl]`. */
export function contributions(): [string, string, unknown][] {
  return [
    ...MENUS.map(m => ['shell.menus', m.id, m] as [string, string, unknown]),
    ...DIALOGS.map(d => [DIALOGS_EXTENSION_POINT, d.id, d] as [string, string, unknown])
  ]
}
