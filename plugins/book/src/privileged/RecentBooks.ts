// The recent-books list and the last book, kept in application state (tier 1), never in a book.
import type { AppState } from '@tessera/types'
import type { RecentBook } from '@tessera/book-api'

// Keep the persisted keys so existing recent-book and last-opened state remains available.
export const RECENT_KEY = 'ledger.recent'
export const LAST_KEY = 'ledger.last'
export const RECENT_LIMIT = 10

/** Paths compare as the platform does: Windows and macOS file systems are usually case-insensitive. */
const samePath = (a: string, b: string) =>
  process.platform === 'win32' || process.platform === 'darwin' ? a.toLowerCase() === b.toLowerCase() : a === b

function valid(entry: unknown): entry is RecentBook {
  const e = entry as Partial<RecentBook> | null
  return typeof e?.path === 'string' && typeof e.name === 'string' && typeof e.openedAt === 'string'
}

export class RecentBooks {
  constructor(private readonly state: AppState, private readonly now: () => Date = () => new Date()) {}

  /** Most recently opened first. Whatever is stored is read defensively: a bad entry is dropped, not an error. */
  async list(): Promise<RecentBook[]> {
    const stored = await this.state.get<unknown>(RECENT_KEY)
    return Array.isArray(stored) ? stored.filter(valid).map(({ path, name, openedAt }) => ({ path, name, openedAt })) : []
  }

  async add(path: string, name: string): Promise<void> {
    const rest = (await this.list()).filter(entry => !samePath(entry.path, path))
    await this.state.set(RECENT_KEY, [{ path, name, openedAt: this.now().toISOString() }, ...rest].slice(0, RECENT_LIMIT))
    await this.state.set(LAST_KEY, path)
  }

  async remove(path: string): Promise<void> {
    await this.state.set(RECENT_KEY, (await this.list()).filter(entry => !samePath(entry.path, path)))
    const last = await this.last()
    if (last !== undefined && samePath(last, path)) await this.forgetLast()
  }

  /** The book to reopen at start-up: the one open when the app last quit. */
  async last(): Promise<string | undefined> {
    const last = await this.state.get<unknown>(LAST_KEY)
    return typeof last === 'string' && last !== '' ? last : undefined
  }

  /** After an explicit Close Book, the next start shows the start view rather than reopening it. */
  async forgetLast(): Promise<void> {
    await this.state.set(LAST_KEY, null)
  }
}
