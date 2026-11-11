// Rules for ledger and sub-ledger names, and the tree helpers every view of the ledger needs. Pure functions, so the
// session, the dialogs and other plugins (the accounts navigator) apply exactly the same rules.
import type { SubLedger } from './model'

/**
 * A calendar date (YYYY-MM-DD) as people read it, in their own locale: "Jan 1, 2026", "1 Jan 2026". It is the same
 * day in every time zone. Messages and dialogs show dates this way; file names and logs keep YYYY-MM-DD.
 */
export const displayDate = (date: string): string =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString([], { dateStyle: 'medium', timeZone: 'UTC' })

/** A file's size as people read it: "600 KB", "7.6 MB". */
export const displaySize = (bytes: number): string =>
  bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`

/** The longest a sub-ledger's name may be. */
export const LEDGER_NAME_MAX_LENGTH = 100

/** Control characters, and the characters no file name may contain on Windows. */
const FORBIDDEN = /[\u0000-\u001f\u007f<>:"/\\|?*]/

/**
 * Why a name can't be used, or undefined when it can. Names are trimmed first. The same rules serve sub-ledgers and
 * new ledger files (whose name becomes the suggested file name), so a name valid here is also a valid file name.
 */
export function validateLedgerName(name: string): string | undefined {
  const trimmed = name.trim()
  if (trimmed === '') return 'Enter a name.'
  if (trimmed.length > LEDGER_NAME_MAX_LENGTH) return `Use at most ${LEDGER_NAME_MAX_LENGTH} characters.`
  if (FORBIDDEN.test(trimmed)) return 'A name can’t contain < > : " / \\ | ? * or control characters.'
  if (/^\.+$/.test(trimmed)) return 'Enter a name other than dots.'
  return undefined
}

/** Names Windows reserves for devices, whatever the extension: a file can't have them. */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/**
 * Why a name can't be a ledger file's name (without its extension), or undefined when it can: a ledger name that is
 * also a file name on every platform, so no reserved name and no trailing dot or space. Names are trimmed first.
 */
export function validateLedgerFileName(name: string): string | undefined {
  const problem = validateLedgerName(name)
  if (problem) return problem
  const trimmed = name.trim()
  if (RESERVED.test(trimmed)) return `“${trimmed}” is a name Windows keeps for itself. Choose another.`
  if (trimmed.endsWith('.')) return 'A file name can’t end with a dot.'
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

/** What the tree helpers need of a sub-ledger, so they also take other plugins' copies of the tree (a chart). */
export type TreeNode = Pick<SubLedger, 'id' | 'parentId' | 'name' | 'order'>

/** Sub-ledgers directly under `parentId` (null: the ledger itself), in display order. */
export function childrenOf<T extends TreeNode>(subLedgers: readonly T[], parentId: string | null): T[] {
  return subLedgers
    .filter(s => s.parentId === parentId)
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
}

/** Ids of every sub-ledger beneath `id`, not including it. */
export function descendantIds(subLedgers: readonly TreeNode[], id: string): Set<string> {
  const found = new Set<string>()
  const visit = (parentId: string) => {
    for (const child of subLedgers) {
      if (child.parentId === parentId && !found.has(child.id)) {
        found.add(child.id)
        visit(child.id)
      }
    }
  }
  visit(id)
  return found
}

/** The tree in display order, depth first, each with its depth (0 for the ledger's own children). */
export function flattenTree<T extends TreeNode>(subLedgers: readonly T[], options: { expanded?: ReadonlySet<string> } = {}):
  { subLedger: T, depth: number, hasChildren: boolean }[] {
  const rows: { subLedger: T, depth: number, hasChildren: boolean }[] = []
  const visit = (parentId: string | null, depth: number) => {
    for (const subLedger of childrenOf(subLedgers, parentId)) {
      const hasChildren = subLedgers.some(s => s.parentId === subLedger.id)
      rows.push({ subLedger, depth, hasChildren })
      if (hasChildren && (options.expanded === undefined || options.expanded.has(subLedger.id))) visit(subLedger.id, depth + 1)
    }
  }
  visit(null, 0)
  return rows
}

/** The names from the ledger down to the sub-ledger, for messages: ["Personal", "Rentals"]. Empty for unknown ids. */
export function pathOf(subLedgers: readonly TreeNode[], id: string): string[] {
  const byId = new Map(subLedgers.map(s => [s.id, s]))
  const names: string[] = []
  for (let current = byId.get(id); current && names.length <= subLedgers.length; current = current.parentId === null ? undefined : byId.get(current.parentId)) {
    names.unshift(current.name)
  }
  return names
}
