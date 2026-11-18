// What the exchange plugin adds to the shell and to the accounts plugin, as plain data: the File menu's Import
// group, the Statements to Read view, the dialogs the flow opens, the register's provisional rows, and the
// navigator's "Statements to read" row with its live count.
import {
  DIALOGS_EXTENSION_POINT, OPTIONS_EXTENSION_POINT, type DialogContribution, type OptionsPageDescriptor
} from '@tessera/types'
import { BOOK_CONTEXT_KEYS } from '@tessera/book-api'
import {
  NAVIGATOR_ITEMS_POINT, REGISTER_OVERLAYS_POINT,
  type NavigatorItemContribution, type RegisterOverlayContribution
} from '@tessera/accounts-api'
import {
  EXCHANGE_CHANNELS, EXCHANGE_COMMANDS as C, EXCHANGE_CONTEXT_KEYS as K, EXCHANGE_DIALOGS, EXCHANGE_EVENTS,
  EXCHANGE_VIEWS
} from '@tessera/exchange-api'

const FILE_MENU = 'shell.file'

/** The group the import items sit in, above the shell's Exit group. */
export const IMPORT_GROUP = 'exchange.file.import'

/**
 * Importing needs a writable book and a format that can read. `exchange.formats.count` is unset rather than
 * zero when nothing is installed, so the bare key is false and the item greys itself out — which is what the
 * user should see before any format plugin exists, rather than a command that fails when they press it.
 */
export const CAN_IMPORT = `${BOOK_CONTEXT_KEYS.isOpen} && !${BOOK_CONTEXT_KEYS.isReadOnly} && ${K.formatCount}`

/**
 * Exporting needs a book and a format that can write, but not a writable book: exporting from a book opened
 * read-only is a perfectly reasonable thing to want, and is what a user reaching for an archive will try.
 */
export const CAN_EXPORT = `${BOOK_CONTEXT_KEYS.isOpen} && ${K.writableFormatCount}`

/**
 * Undoing needs a writable book and an import to undo. `exchange.canUndo` is unset rather than false when the
 * history is empty, so the bare key greys the item on its own.
 */
/**
 * Anything that changes a statement row — Accept, Change…, Edit…, Skip — needs a writable book. Without this the
 * register's row buttons stayed live on a book opened read-only and only failed after being pressed.
 */
export const CAN_EDIT_ROWS = `${BOOK_CONTEXT_KEYS.isOpen} && !${BOOK_CONTEXT_KEYS.isReadOnly}`

export const CAN_UNDO = `${BOOK_CONTEXT_KEYS.isOpen} && !${BOOK_CONTEXT_KEYS.isReadOnly} && ${K.canUndo}`

export const MENUS = [
  {
    kind: 'item', id: 'exchange.menu.import', label: '&Import Transactions…',
    parent: FILE_MENU, group: IMPORT_GROUP, command: C.import, order: 10
  },
  {
    kind: 'item', id: 'exchange.menu.export', label: '&Export Transactions…',
    parent: FILE_MENU, group: IMPORT_GROUP, command: C.export, order: 15
  },
  {
    kind: 'item', id: 'exchange.menu.statements', label: 'Statements to &Read',
    parent: FILE_MENU, group: IMPORT_GROUP, command: C.statements, order: 20,
    when: BOOK_CONTEXT_KEYS.isOpen
  },
  {
    kind: 'item', id: 'exchange.menu.history', label: 'Import &History…',
    parent: FILE_MENU, group: IMPORT_GROUP, command: C.history, order: 30,
    when: BOOK_CONTEXT_KEYS.isOpen
  },
  {
    kind: 'item', id: 'exchange.menu.sources', label: 'Statement &Sources…',
    parent: FILE_MENU, group: IMPORT_GROUP, command: C.sources, order: 35,
    when: BOOK_CONTEXT_KEYS.isOpen
  },
  {
    kind: 'item', id: 'exchange.menu.rules', label: '&Payee Rules…',
    parent: FILE_MENU, group: IMPORT_GROUP, command: C.rules, order: 40,
    when: BOOK_CONTEXT_KEYS.isOpen
  }
] as const

export const VIEWS = [
  {
    id: EXCHANGE_VIEWS.statements,
    title: 'Statements',
    slot: 'shell.main',
    module: './StatementsView',
    icon: 'Download',
    order: -30,
    when: BOOK_CONTEXT_KEYS.isOpen
  }
] as const

export const DIALOGS: DialogContribution[] = [
  { id: EXCHANGE_DIALOGS.account, title: 'Choose an Account', module: './ChooseAccountDialog', size: 'sm' },
  { id: EXCHANGE_DIALOGS.matching, title: 'Change Transaction Matching', module: './MatchingDialog', size: 'md' },
  { id: EXCHANGE_DIALOGS.question, title: 'Import', module: './QuestionDialog', size: 'sm' },
  // Wide: it shows the file's columns side by side, and a grid that scrolls sideways defeats the point of it.
  { id: EXCHANGE_DIALOGS.csvProfile, title: 'Match the Columns', module: './CsvProfileDialog', size: 'lg' },
  { id: EXCHANGE_DIALOGS.export, title: 'Export Transactions', module: './ExportDialog', size: 'md' },
  { id: EXCHANGE_DIALOGS.history, title: 'Import History', module: './HistoryDialog', size: 'md' },
  { id: EXCHANGE_DIALOGS.rename, title: 'Edit Statement Line', module: './RenameDialog', size: 'sm' },
  { id: EXCHANGE_DIALOGS.rules, title: 'Payee Rules', module: './RulesDialog', size: 'lg' },
  { id: EXCHANGE_DIALOGS.sources, title: 'Statement Sources', module: './SourcesDialog', size: 'md' }
]

/** The register draws the statement rows waiting in an account, asking `pending.rows` for them. */
export const OVERLAYS: RegisterOverlayContribution[] = [
  {
    id: 'exchange.pending',
    channel: EXCHANGE_CHANNELS.pendingRows,
    refreshOn: EXCHANGE_EVENTS.pending
  }
]

/** The navigator's "Statements to read" row, with the waiting count as its badge. */
export const NAVIGATOR_ITEMS: NavigatorItemContribution[] = [
  {
    id: 'exchange.statementsToRead',
    label: 'Statements to read',
    command: C.statements,
    icon: 'Download',
    placement: 'bottom',
    badgeKey: K.pendingCount,
    description: 'Downloaded statements waiting to be read into a register'
  }
]

/**
 * The options page, at **Tools ▸ Options ▸ Import and export**. The values it edits are the ones that change
 * how a file is *read* — the write-side choices belong to the export dialog, where they are per-export.
 */
export const OPTIONS_PAGES: OptionsPageDescriptor[] = [
  {
    id: 'exchange.options.importExport',
    title: 'Import and export',
    module: './OptionsPage',
    keywords: ['import', 'export', 'statement', 'ofx', 'qif', 'csv', 'payee', 'matching', 'duplicate'],
    order: 40
  }
]

/** Every contribution, as `[point, id, impl]`. */
export function contributions(): [string, string, unknown][] {
  const as = (point: string) => (c: { id: string }): [string, string, unknown] => [point, c.id, c]
  return [
    ...MENUS.map(as('shell.menus')),
    ...VIEWS.map(as('shell.views')),
    ...DIALOGS.map(as(DIALOGS_EXTENSION_POINT)),
    ...OVERLAYS.map(as(REGISTER_OVERLAYS_POINT)),
    ...NAVIGATOR_ITEMS.map(as(NAVIGATOR_ITEMS_POINT)),
    ...OPTIONS_PAGES.map(as(OPTIONS_EXTENSION_POINT))
  ]
}
