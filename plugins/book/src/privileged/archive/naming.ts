// Archive file names, and the cut-off the Archive dialog suggests. Pure, so both the dialog and the writer apply
// exactly the same rules. See docs/archive-design.md, "The archive file" and "Options".
import { BOOK_FILE_EXTENSION } from '@tessera/book-api'
import { safeFileName } from '../backups/naming'
export { suggestedCutoff } from '@tessera/book-api'

/** `YYYY-MM-DD`, and a real day: `2026-02-30` is not one. */
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  if (month < 1 || month > 12 || day < 1) return false
  return day <= new Date(year, month, 0).getDate()
}

const two = (n: number) => String(n).padStart(2, '0')

/** A local calendar date as `YYYY-MM-DD`, never shifted a day by UTC. */
export const isoDay = (date: Date): string => `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`

/** `2026-01-01` → `1 Jan 2026` (locale-dependent), read as a local date so it is never a day out. */
export function humanDate(iso: string): string {
  const [year, month, day] = iso.split('-').map(Number)
  const date = new Date(year, (month ?? 1) - 1, day ?? 1)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString(undefined, { dateStyle: 'medium' })
}

/**
 * `Home Finances Archive through 2026-01-01.tessera`. `attempt` 2 and later add ` (2)`…, for a name already taken
 * (two archives of one book through one date). The name is for people: Tessera knows an archive by its meta.
 */
export function archiveFileName(bookName: string, before: string, attempt = 1): string {
  const counter = attempt > 1 ? ` (${attempt})` : ''
  return `${safeFileName(bookName)} Archive through ${before}${counter}${BOOK_FILE_EXTENSION}`
}

/**
 * The name an archive is written under until it is complete: beside where it will go, so putting it in place is a
 * rename on one drive. Leading dot, as the restorer's staging file has, to keep it out of the way in a file manager.
 */
export const archiveStagingName = (bookName: string, id: string): string =>
  `.${safeFileName(bookName)}.archiving-${id}${BOOK_FILE_EXTENSION}`
