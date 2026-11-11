// The recent-ledgers list and the last ledger, kept in the plugin's application state (`context.state`, tier 1),
// never in a ledger. Stored as `ledger.recent` and `ledger.last`.
import type { PluginState } from '@tessera/types'
import type { RecentLedger } from '@tessera/ledger-api'

/** Keys in the ledger's `context.state`. */
export const RECENT_KEY = 'recent'
export const LAST_KEY = 'last'
/** How many are kept when no limit is given; the user's limit comes from the ledger's settings. */
export const RECENT_LIMIT = 10

/** Paths compare as the platform does: Windows and macOS file systems are usually case-insensitive. */
const samePath = (a: string, b: string) =>
  process.platform === 'win32' || process.platform === 'darwin' ? a.toLowerCase() === b.toLowerCase() : a === b

function valid(entry: unknown): entry is RecentLedger {
  const e = entry as Partial<RecentLedger> | null
  return typeof e?.path === 'string' && typeof e.name === 'string' && typeof e.openedAt === 'string'
}

export class RecentLedgers {
  constructor(
    private readonly state: PluginState,
    private readonly now: () => Date = () => new Date(),
    private readonly limit: () => number = () => RECENT_LIMIT
  ) {}

  /**
   * Most recently opened first, at most the limit (a lowered limit shows at once; the rest go at the next `add`).
   * Whatever is stored is read defensively: a bad entry is dropped, not an error.
   */
  async list(): Promise<RecentLedger[]> {
    const stored = await this.state.get<unknown>(RECENT_KEY)
    return Array.isArray(stored) ? stored.filter(valid).slice(0, this.limit()).map(({ path, name, openedAt }) => ({ path, name, openedAt })) : []
  }

  async add(path: string, name: string): Promise<void> {
    const rest = (await this.list()).filter(entry => !samePath(entry.path, path))
    await this.state.set(RECENT_KEY, [{ path, name, openedAt: this.now().toISOString() }, ...rest].slice(0, this.limit()))
    await this.state.set(LAST_KEY, path)
  }

  async remove(path: string): Promise<void> {
    await this.state.set(RECENT_KEY, (await this.list()).filter(entry => !samePath(entry.path, path)))
    const last = await this.last()
    if (last !== undefined && samePath(last, path)) await this.forgetLast()
  }

  /** The ledger to reopen at start-up: the one open when the app last quit. */
  async last(): Promise<string | undefined> {
    const last = await this.state.get<unknown>(LAST_KEY)
    return typeof last === 'string' && last !== '' ? last : undefined
  }

  /** After an explicit Close Ledger, the next start shows the start view rather than reopening it. */
  async forgetLast(): Promise<void> {
    await this.state.set(LAST_KEY, null)
  }
}
