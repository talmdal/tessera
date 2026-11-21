// What the book adds to the shell, as plain data: File menu items, views, dialogs and a status item.
import { DIALOGS_EXTENSION_POINT, OPTIONS_EXTENSION_POINT } from '@tessera/types'
import type { DialogContribution, OptionsPageDescriptor } from '@tessera/types'
import { BOOK_COMMANDS, BOOK_CONTEXT_KEYS, BOOK_DIALOGS, BOOK_PLUGIN_ID, BOOK_VIEWS } from '@tessera/book-api'

const FILE_MENU = 'shell.file'

export const MENUS = [
  { kind: 'group', id: 'book.file', parent: FILE_MENU, order: 0 },
  { kind: 'group', id: 'book.backup', parent: FILE_MENU, order: 5 },
  { kind: 'group', id: 'book.danger', parent: FILE_MENU, order: 10 },
  { kind: 'item', id: 'book.file.new', label: '&New Book…', parent: FILE_MENU, group: 'book.file', command: BOOK_COMMANDS.new },
  { kind: 'item', id: 'book.file.open', label: '&Open Book…', parent: FILE_MENU, group: 'book.file', command: BOOK_COMMANDS.open, accelerator: 'CmdOrCtrl+O' },
  { kind: 'item', id: 'book.file.close', label: '&Close Book', parent: FILE_MENU, group: 'book.file', command: BOOK_COMMANDS.close },
  { kind: 'item', id: 'book.file.backupNow', label: 'Back &Up Now', parent: FILE_MENU, group: 'book.backup', command: BOOK_COMMANDS.backupNow },
  { kind: 'item', id: 'book.file.backupTo', label: 'Back Up &To…', parent: FILE_MENU, group: 'book.backup', command: BOOK_COMMANDS.backupTo },
  { kind: 'item', id: 'book.file.restore', label: '&Restore from Backup…', parent: FILE_MENU, group: 'book.backup', command: BOOK_COMMANDS.restore },
  { kind: 'item', id: 'book.file.archive', label: '&Archive…', parent: FILE_MENU, group: 'book.backup', command: BOOK_COMMANDS.archive },
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
  { id: BOOK_DIALOGS.renameSubBook, title: 'Rename Sub-Book', module: './RenameDialog', size: 'xs' },
  { id: BOOK_DIALOGS.restore, title: 'Restore from Backup', module: './RestoreDialog', size: 'md' },
  { id: BOOK_DIALOGS.archive, title: 'Archive', module: './ArchiveDialog', size: 'md' }
]

export const BAR_ITEMS = [
  {
    kind: 'text', id: 'book.status.name', slot: 'shell.bottom', align: 'start', icon: 'AccountBalance',
    text: `Book: {${BOOK_CONTEXT_KEYS.name}}`, when: `${BOOK_CONTEXT_KEYS.isOpen} && !${BOOK_CONTEXT_KEYS.isArchive}`,
    tooltip: 'The open book'
  },
  {
    kind: 'text', id: 'book.status.archive', slot: 'shell.bottom', align: 'start', icon: 'Lock',
    text: `Archive of “{${BOOK_CONTEXT_KEYS.name}}” through {${BOOK_CONTEXT_KEYS.archiveThrough}}`,
    when: BOOK_CONTEXT_KEYS.isArchive,
    tooltip: 'This book is an archive: a frozen copy. It can be read but never changed.'
  },
  {
    kind: 'text', id: 'book.status.backup', slot: 'shell.bottom', align: 'start', icon: 'Warning',
    text: 'Last backup failed', command: BOOK_COMMANDS.backupSettings, when: BOOK_CONTEXT_KEYS.backupFailed,
    tooltip: 'The last automatic backup of this book didn’t complete. Click to see why, in the backup settings.'
  }
] as const

/** Tools › Options › Book › Backups. The category leaves room for the book's other settings. */
export const OPTIONS_PAGES: OptionsPageDescriptor[] = [
  { id: 'book.options', title: 'Book', order: 30 },
  {
    id: 'book.options.backups',
    title: 'Backups',
    parent: 'book.options',
    module: './BackupsOptionsPage',
    keywords: ['backup', 'back up', 'automatic', 'folder', 'restore', 'keep', 'daily', 'weekly', 'monthly', 'safety'],
    order: 10
  },
  {
    id: 'book.options.archive',
    title: 'Archive',
    parent: 'book.options',
    module: './ArchiveOptionsPage',
    keywords: ['archive', 'cut-off', 'transactions', 'folder', 'reconciled', 'voided'],
    order: 20
  }
]

/** Every contribution, as `[point, id, impl]`. */
export function contributions(): [string, string, unknown][] {
  return [
    ...MENUS.map(m => ['shell.menus', m.id, m] as [string, string, unknown]),
    ...VIEWS.map(v => ['shell.views', v.id, v] as [string, string, unknown]),
    ...DIALOGS.map(d => [DIALOGS_EXTENSION_POINT, d.id, d] as [string, string, unknown]),
    ...BAR_ITEMS.map(b => ['shell.bar.items', b.id, b] as [string, string, unknown]),
    ...OPTIONS_PAGES.map(p => [OPTIONS_EXTENSION_POINT, p.id, p] as [string, string, unknown])
  ]
}

export { BOOK_PLUGIN_ID }
