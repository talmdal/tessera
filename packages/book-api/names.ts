// Rules for book and sub-book names, and the tree helpers every view of the book needs. Pure functions, so the
// session, the dialogs and other plugins (the accounts navigator) apply exactly the same rules.
import type { SubBook } from './model'

/** The longest a sub-book's name may be. */
export const BOOK_NAME_MAX_LENGTH = 100

/** Control characters, and the characters no file name may contain on Windows. */
const FORBIDDEN = /[\u0000-\u001f\u007f<>:"/\\|?*]/

/**
 * Why a name can't be used, or undefined when it can. Names are trimmed first. The same rules serve sub-books and
 * new book files (whose name becomes the suggested file name), so a name valid here is also a valid file name.
 */
export function validateBookName(name: string): string | undefined {
  const trimmed = name.trim()
  if (trimmed === '') return 'Enter a name.'
  if (trimmed.length > BOOK_NAME_MAX_LENGTH) return `Use at most ${BOOK_NAME_MAX_LENGTH} characters.`
  if (FORBIDDEN.test(trimmed)) return 'A name can’t contain < > : " / \\ | ? * or control characters.'
  if (/^\.+$/.test(trimmed)) return 'Enter a name other than dots.'
  return undefined
}

/** The key names are compared by: trimmed and lower case, so "Business" and " business" clash. */
export const nameKey = (name: string) => name.trim().toLocaleLowerCase()

/** `name`, or `name (2)`, `name (3)`… whichever is not yet taken. `taken` holds name keys. */
export function uniqueName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(nameKey(name))) return name
  for (let n = 2; ; n++) {
    const candidate = `${name} (${n})`
    if (!taken.has(nameKey(candidate))) return candidate
  }
}

/** What the tree helpers need of a sub-book, so they also take other plugins' copies of the tree (a chart). */
export type TreeNode = Pick<SubBook, 'id' | 'parentId' | 'name' | 'order'>

/** Sub-books directly under `parentId` (null: the book itself), in display order. */
export function childrenOf<T extends TreeNode>(subBooks: readonly T[], parentId: string | null): T[] {
  return subBooks
    .filter(s => s.parentId === parentId)
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
}

/** Ids of every sub-book beneath `id`, not including it. */
export function descendantIds(subBooks: readonly TreeNode[], id: string): Set<string> {
  const found = new Set<string>()
  const visit = (parentId: string) => {
    for (const child of subBooks) {
      if (child.parentId === parentId && !found.has(child.id)) {
        found.add(child.id)
        visit(child.id)
      }
    }
  }
  visit(id)
  return found
}

/** The tree in display order, depth first, each with its depth (0 for the book's own children). */
export function flattenTree<T extends TreeNode>(subBooks: readonly T[], options: { expanded?: ReadonlySet<string> } = {}):
  { subBook: T, depth: number, hasChildren: boolean }[] {
  const rows: { subBook: T, depth: number, hasChildren: boolean }[] = []
  const visit = (parentId: string | null, depth: number) => {
    for (const subBook of childrenOf(subBooks, parentId)) {
      const hasChildren = subBooks.some(s => s.parentId === subBook.id)
      rows.push({ subBook, depth, hasChildren })
      if (hasChildren && (options.expanded === undefined || options.expanded.has(subBook.id))) visit(subBook.id, depth + 1)
    }
  }
  visit(null, 0)
  return rows
}

/** The names from the book down to the sub-book, for messages: ["Personal", "Rentals"]. Empty for unknown ids. */
export function pathOf(subBooks: readonly TreeNode[], id: string): string[] {
  const byId = new Map(subBooks.map(s => [s.id, s]))
  const names: string[] = []
  for (let current = byId.get(id); current && names.length <= subBooks.length; current = current.parentId === null ? undefined : byId.get(current.parentId)) {
    names.unshift(current.name)
  }
  return names
}
