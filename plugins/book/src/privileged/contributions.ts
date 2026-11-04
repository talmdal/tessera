// What the book adds to the shell, as plain data: File menu items, views, dialogs and a status item.
import { DIALOGS_EXTENSION_POINT } from '@tessera/types'
import type { DialogContribution } from '@tessera/types'
import { BOOK_COMMANDS, BOOK_CONTEXT_KEYS, BOOK_DIALOGS, BOOK_PLUGIN_ID, BOOK_VIEWS } from '@tessera/book-api'

const FILE_MENU = 'shell.file'

export const MENUS = [
  { kind: 'group', id: 'book.file', parent: FILE_MENU, order: 0 },
  { kind: 'group', id: 'book.danger', parent: FILE_MENU, order: 10 },
  { kind: 'item', id: 'book.file.new', label: '&New Book…', parent: FILE_MENU, group: 'book.file', command: BOOK_COMMANDS.new },
  { kind: 'item', id: 'book.file.open', label: '&Open Book…', parent: FILE_MENU, group: 'book.file', command: BOOK_COMMANDS.open, accelerator: 'CmdOrCtrl+O' },
  { kind: 'item', id: 'book.file.close', label: '&Close Book', parent: FILE_MENU, group: 'book.file', command: BOOK_COMMANDS.close },
  { kind: 'item', id: 'book.file.delete', label: '&Delete Book…', parent: FILE_MENU, group: 'book.danger', command: BOOK_COMMANDS.delete }
] as const

export const VIEWS = [
  // Shown in the main area while no book is open; first, so it is the page people land on
  { id: BOOK_VIEWS.start, title: 'Start', slot: 'shell.main', module: './StartView', icon: 'Home', order: -100, when: `!${BOOK_CONTEXT_KEYS.isOpen}` },
  // Hidden while another plugin's navigator shows the tree (the accounts navigator, with accounts in it)
  { id: BOOK_VIEWS.tree, title: 'Book', slot: 'shell.left', module: './BookTree', icon: 'AccountBalance', order: -100, when: `${BOOK_CONTEXT_KEYS.isOpen} && !${BOOK_CONTEXT_KEYS.hasNavigator}` }
] as const

export const DIALOGS: DialogContribution[] = [
  { id: BOOK_DIALOGS.newBook, title: 'New Book', module: './NewBookDialog', size: 'sm' },
  { id: BOOK_DIALOGS.renameSubBook, title: 'Rename Sub-Book', module: './RenameDialog', size: 'xs' }
]

export const BAR_ITEMS = [
  {
    kind: 'text', id: 'book.status.name', slot: 'shell.bottom', align: 'start', icon: 'AccountBalance',
    text: `Book: {${BOOK_CONTEXT_KEYS.name}}`, when: BOOK_CONTEXT_KEYS.isOpen, tooltip: 'The open book'
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

export { BOOK_PLUGIN_ID }
