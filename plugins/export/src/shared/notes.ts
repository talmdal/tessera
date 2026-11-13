// What the Export dialog and the message after an export say about accounts whose earlier transactions are in an
// archive file: one sentence for them all, so five accounts archived on the same day don't make five notes.
import { displayDate } from '@tessera/ledger-api'

/** 'a', 'a and b', 'a, b and c'. */
export function joinList(items: readonly string[]): string {
  return items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

/** “A”, “B” and “C”. */
export const listNames = (names: readonly string[]): string => joinList(names.map(name => `“${name}”`))

/** The note for accounts that start where an archive file takes over; undefined for none. */
export function archivedNote(archived: readonly { account: string, from: string }[]): string | undefined {
  if (archived.length === 0) return undefined
  if (new Set(archived.map(a => a.from)).size === 1) {
    const one = archived.length === 1
    return `${listNames(archived.map(a => a.account))} ${one ? 'starts' : 'start'} on ${displayDate(archived[0].from)}: ${one ? 'its' : 'their'} earlier transactions are in an archive file.`
  }
  return `Earlier transactions are in an archive file for ${joinList(archived.map(a => `“${a.account}” (from ${displayDate(a.from)})`))}.`
}
