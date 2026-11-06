// Payee aliases: how the bank writes a payee ('costco whse', normalised) → the user's name for it ('Costco'), learnt
// when the user accepts a match or chooses a transaction for a bank line. Matching then scores that payee 1, and a
// new line with the same text gets the user's payee and its category. Kept per ledger. See
// docs/import-manager-design.md, "Payee aliases (learning)".
import type { Database } from '@tessera/types'
import { normalizePayee } from './matching/payees'
import { collectionsOf } from './store'

export class PayeeAliases {
  constructor(private readonly db: () => Database, private readonly now: () => string) {}

  /** Every alias: normalised bank text → payee name. */
  async map(): Promise<Map<string, string>> {
    return new Map((await collectionsOf(this.db()).aliases.find()).map(a => [a.pattern, a.payeeName]))
  }

  /**
   * Learns that `bankText` is `payeeName`, unless it says nothing (normalised away), is already that name, or is
   * already an alias for it. Resolves true when an alias was saved. A later answer replaces an earlier one.
   */
  async learn(bankText: string | undefined, payeeName: string | undefined): Promise<boolean> {
    const pattern = normalizePayee(bankText)
    const name = payeeName?.trim()
    if (!pattern || !name || normalizePayee(name) === pattern) return false
    const c = collectionsOf(this.db())
    const existing = await c.aliases.findOne({ pattern })
    if (existing?.payeeName.toLowerCase() === name.toLowerCase()) return false
    if (existing) await c.aliases.replace({ ...existing, payeeName: name, createdAt: this.now(), uses: 0 })
    else await c.aliases.insert({ pattern, payeeName: name, createdAt: this.now(), uses: 0 })
    return true
  }

  /** Counts a use of each of these aliases (for the aliases list, phase 4). */
  async used(patterns: Iterable<string>): Promise<void> {
    const c = collectionsOf(this.db())
    for (const pattern of new Set(patterns)) await c.aliases.updateOne({ pattern }, { $inc: { uses: 1 } })
  }
}
