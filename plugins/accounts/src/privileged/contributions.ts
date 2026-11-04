// What the accounts plugin adds to the shell, as plain data: the Accounts menu, the navigator and the dialogs.
import { DIALOGS_EXTENSION_POINT, type DialogContribution } from '@tessera/types'
import { BOOK_CONTEXT_KEYS } from '@tessera/book-api'
import {
  ACCOUNTS_COMMANDS as C, ACCOUNTS_CONTEXT_KEYS, ACCOUNTS_DIALOGS, ACCOUNTS_VIEWS, RECONCILE_ACTIONS_POINT, STATEMENT_RECONCILER,
  type ReconcileActionContribution
} from '@tessera/accounts-api'

const MENU = 'accounts.menu'
const VIEW_MENU = 'shell.view'

const item = (id: string, label: string, command: string, group: string, extra: object = {}) =>
  ({ kind: 'item', id, label, parent: MENU, group, command, ...extra })

export const MENUS = [
  { kind: 'menu', id: MENU, label: '&Accounts' },
  { kind: 'group', id: 'accounts.menu.account', parent: MENU, order: 0 },
  { kind: 'group', id: 'accounts.menu.subBook', parent: MENU, order: 10 },
  { kind: 'group', id: 'accounts.menu.move', parent: MENU, order: 20 },
  { kind: 'group', id: 'accounts.menu.register', parent: MENU, order: 30 },
  item('accounts.menu.new', '&New Account…', C.newAccount, 'accounts.menu.account'),
  item('accounts.menu.edit', '&Edit Account…', C.editAccount, 'accounts.menu.account'),
  item('accounts.menu.close', '&Close Account…', C.closeAccount, 'accounts.menu.account'),
  item('accounts.menu.reopen', '&Reopen Account', C.reopenAccount, 'accounts.menu.account'),
  item('accounts.menu.delete', '&Delete Account…', C.deleteAccount, 'accounts.menu.account'),
  item('accounts.menu.newSubBook', 'New &Sub-Book…', C.newSubBook, 'accounts.menu.subBook'),
  item('accounts.menu.renameSubBook', 'Re&name Sub-Book…', C.renameSubBook, 'accounts.menu.subBook'),
  item('accounts.menu.deleteSubBook', 'Delete Su&b-Book…', C.deleteSubBook, 'accounts.menu.subBook'),
  item('accounts.menu.move', '&Move To…', C.move, 'accounts.menu.move'),
  item('accounts.menu.register', '&Open Register', C.showRegister, 'accounts.menu.register'),
  // Ctrl+N is not a key text fields use, so it is safe as a menu accelerator while the user types in the register
  item('accounts.menu.newTransaction', 'New &Transaction', C.newTransaction, 'accounts.menu.register', { accelerator: 'CmdOrCtrl+N' }),
  item('accounts.menu.reconcile', 'Reconcile with &Statement…', C.reconcileStatement, 'accounts.menu.register'),
  { kind: 'item', id: 'accounts.view.accounts', label: '&Accounts', parent: VIEW_MENU, command: C.open }
] as const

export const VIEWS = [
  {
    id: ACCOUNTS_VIEWS.navigator, title: 'Accounts', slot: 'shell.left', module: './Navigator', icon: 'AccountBalance',
    order: -100, when: BOOK_CONTEXT_KEYS.isOpen
  },
  {
    id: ACCOUNTS_VIEWS.register, title: 'Register', slot: 'shell.main', module: './Register', icon: 'List',
    order: -50, when: BOOK_CONTEXT_KEYS.isOpen
  },
  // Beside the navigator while the register's account is being reconciled
  {
    id: ACCOUNTS_VIEWS.reconcile, title: 'Reconcile', slot: 'shell.left', module: './ReconcilePanel', icon: 'Check',
    order: -90, when: ACCOUNTS_CONTEXT_KEYS.reconciling
  }
] as const

export const DIALOGS: DialogContribution[] = [
  { id: ACCOUNTS_DIALOGS.account, title: 'New Account', module: './AccountDialog', size: 'sm' },
  { id: ACCOUNTS_DIALOGS.move, title: 'Move To', module: './MoveDialog', size: 'xs' },
  { id: ACCOUNTS_DIALOGS.reconcile, title: 'Reconcile with Statement', module: './ReconcileDialog', size: 'sm' }
]

/** The built-in reconciler, offered through the same extension point as any plugin's. */
export const RECONCILE_ACTIONS: ReconcileActionContribution[] = [
  {
    id: STATEMENT_RECONCILER, label: 'Reconcile with Statement…', scope: 'account', command: C.reconcileStatement,
    icon: 'Check', description: 'Mark the transactions on a bank statement, and balance the account with it'
  }
]

/** Every contribution, as `[point, id, impl]`. */
export function contributions(): [string, string, unknown][] {
  return [
    ...MENUS.map(m => ['shell.menus', m.id, m] as [string, string, unknown]),
    ...VIEWS.map(v => ['shell.views', v.id, v] as [string, string, unknown]),
    ...DIALOGS.map(d => [DIALOGS_EXTENSION_POINT, d.id, d] as [string, string, unknown]),
    ...RECONCILE_ACTIONS.map(a => [RECONCILE_ACTIONS_POINT, a.id, a] as [string, string, unknown])
  ]
}
