// Saved account matches: "statements from this source go to that account", one per key, kept in the ledger.
import type { Database } from '@tessera/types'
import type { AccountLink, KeyStrength } from '@tessera/import-api'
import { collectionsOf } from './store'

export class Links {
  constructor(private readonly db: () => Database, private readonly now: () => string) {}

  private get c() { return collectionsOf(this.db()) }

  async get(key: string): Promise<AccountLink | undefined> {
    const found = await this.c.links.findOne({ key })
    return found ? { ...found } : undefined
  }

  /** Saves (or replaces) the match for `key`, as used now. */
  async save(link: { key: string, strength: KeyStrength, accountId: string, autoApply: boolean, label: string, formatId: string }): Promise<void> {
    const now = this.now()
    const existing = await this.c.links.findOne({ key: link.key })
    if (existing) await this.c.links.replace({ ...existing, ...link, lastUsedAt: now })
    else await this.c.links.insert({ ...link, createdAt: now, lastUsedAt: now })
  }

  /** Notes that the match for `key` was used. */
  async touch(key: string): Promise<void> {
    await this.c.links.updateOne({ key }, { $set: { lastUsedAt: this.now() } })
  }

  async forget(key: string): Promise<void> {
    await this.c.links.deleteOne({ key })
  }
}
