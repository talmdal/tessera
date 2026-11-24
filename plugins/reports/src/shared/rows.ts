// The rows of a result a table shows: those no folded row hides. Shared by the view's table, its print layout and the
// CSV export, which all show the table as it is on screen (docs/reporting-design.md, "Printing and exporting"). Pure.
import type { ResultRow } from '@tessera/reports-api'

export interface TableRow {
  row: ResultRow
  /** Its place in the result's rows. */
  index: number
  /** Rows fold under it. */
  parent: boolean
  open: boolean
}

/** Rows that fold under another, by its id. */
export function parentsOf(rows: readonly ResultRow[]): Set<string> {
  return new Set(rows.flatMap(r => r.parentId !== undefined ? [r.parentId] : []))
}

/** The rows showing: those with no collapsed row above them. */
export function visibleRows(rows: readonly ResultRow[], collapsed: ReadonlySet<string>): TableRow[] {
  const parents = parentsOf(rows)
  const byId = new Map(rows.map(r => [r.id, r]))
  const hidden = (row: ResultRow): boolean => {
    const seen = new Set<string>()
    for (let p = row.parentId; p !== undefined && !seen.has(p); p = byId.get(p)?.parentId) {
      seen.add(p)
      if (collapsed.has(p)) return true
    }
    return false
  }
  const out: TableRow[] = []
  rows.forEach((row, index) => {
    if (!hidden(row)) out.push({ row, index, parent: parents.has(row.id), open: !collapsed.has(row.id) })
  })
  return out
}
