// What the import plugin adds, as plain data: File › Import…, its dialogs, and its marks on register rows.
import { DIALOGS_EXTENSION_POINT, type DialogContribution } from '@tessera/types'
import { REGISTER_ANNOTATIONS_POINT, type RegisterAnnotationsContribution } from '@tessera/accounts-api'
import { IMPORT_ANNOTATOR_SERVICE, IMPORT_COMMANDS, IMPORT_DIALOGS } from '@tessera/import-api'

const FILE_MENU = 'shell.file'

export const MENUS = [
  // Between the ledger's own items (order 0) and Delete Ledger… (order 10)
  { kind: 'group', id: 'import.file', parent: FILE_MENU, order: 5 },
  { kind: 'item', id: 'import.file.import', label: '&Import…', parent: FILE_MENU, group: 'import.file', command: IMPORT_COMMANDS.file },
  { kind: 'item', id: 'import.file.saved', label: 'Saved Import &Choices…', parent: FILE_MENU, group: 'import.file', command: IMPORT_COMMANDS.manageLinks }
] as const

export const DIALOGS: DialogContribution[] = [
  { id: IMPORT_DIALOGS.format, title: 'Choose a Format', module: './FormatDialog', size: 'xs' },
  { id: IMPORT_DIALOGS.account, title: 'Which account is this statement for?', module: './AccountDialog', size: 'md' },
  { id: IMPORT_DIALOGS.summary, title: 'Import', module: './SummaryDialog', size: 'sm' },
  { id: IMPORT_DIALOGS.match, title: 'Change Match', module: './MatchDialog', size: 'md' },
  { id: IMPORT_DIALOGS.categories, title: 'Categories from the File', module: './CategoriesDialog', size: 'sm' },
  { id: IMPORT_DIALOGS.signs, title: 'Amounts Reversed?', module: './SignsDialog', size: 'sm' },
  { id: IMPORT_DIALOGS.links, title: 'Saved Import Choices', module: './SavedChoicesDialog', size: 'lg' }
]

/** The review marks on register rows, answered by `import.annotator`. */
export const ANNOTATIONS: RegisterAnnotationsContribution = { id: 'import.review', service: IMPORT_ANNOTATOR_SERVICE }

/** Every contribution, as `[point, id, impl]`. */
export function contributions(): [string, string, unknown][] {
  return [
    ...MENUS.map(m => ['shell.menus', m.id, m] as [string, string, unknown]),
    ...DIALOGS.map(d => [DIALOGS_EXTENSION_POINT, d.id, d] as [string, string, unknown]),
    [REGISTER_ANNOTATIONS_POINT, ANNOTATIONS.id, ANNOTATIONS]
  ]
}
