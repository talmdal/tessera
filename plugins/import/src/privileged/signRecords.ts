// What the sign cross-check keeps, per source and account: whether the import manager reverses this source's files
// itself (for formats that can't remember a correction), and what the source's files have been like (the share of
// money out), so a file that suddenly runs the other way is caught. No record means the source's first import into
// the account, when the account's type counts as evidence. Kept in `import.memory` under the import plugin's own id.
// See docs/import-formats-design.md, "What is retained".
import type { Database } from '@tessera/types'
import { OWN_MEMORY } from './categoryChoice'
import { collectionsOf } from './store'

export interface SignRecord {
  /** The import manager's own correction: this source's files are reversed before they are checked. */
  reverse: boolean
  /** Of the lines imported from this source into this account, the share that were money out (after any correction). */
  outShare: number
  /** How many lines `outShare` is based on, at most `PROFILE_CAP`, so it follows a source that changes slowly. */
  lines: number
  lastImportAt: string
}

/** The most lines a profile is based on. */
export const PROFILE_CAP = 500

const PREFIX = 'signs:'
const keyOf = (sourceKey: string, accountId: string) => `${PREFIX}${sourceKey}:${accountId}`

const isRecord = (v: unknown): v is SignRecord => typeof v === 'object' && v !== null &&
  typeof (v as SignRecord).reverse === 'boolean' && typeof (v as SignRecord).outShare === 'number' && typeof (v as SignRecord).lines === 'number'

/**
 * A profile with a statement's lines added: its share of money out, weighted by lines, the older lines counting less
 * once there are more than `PROFILE_CAP`.
 */
export function addToProfile(record: Pick<SignRecord, 'outShare' | 'lines'> | undefined, out: number, lines: number): { outShare: number, lines: number } {
  if (lines === 0) return record ? { outShare: record.outShare, lines: record.lines } : { outShare: 0, lines: 0 }
  const kept = Math.max(0, Math.min(record?.lines ?? 0, PROFILE_CAP - lines))
  const total = kept + lines
  return { outShare: ((record?.outShare ?? 0) * kept + out) / total, lines: Math.min(total, PROFILE_CAP) }
}

export class SignRecords {
  constructor(private readonly db: () => Database, private readonly now: () => string) {}

  async get(sourceKey: string, accountId: string): Promise<SignRecord | undefined> {
    const found = await collectionsOf(this.db()).memory.findOne({ formatId: OWN_MEMORY, key: keyOf(sourceKey, accountId) })
    return isRecord(found?.value) ? found.value : undefined
  }

  async save(sourceKey: string, accountId: string, record: Omit<SignRecord, 'lastImportAt'>): Promise<void> {
    const value: SignRecord = { ...record, lastImportAt: this.now() }
    await this.db().transaction(async tx => {
      const memory = collectionsOf(tx).memory
      const existing = await memory.findOne({ formatId: OWN_MEMORY, key: keyOf(sourceKey, accountId) })
      if (existing) await memory.replace({ ...existing, value })
      else await memory.insert({ formatId: OWN_MEMORY, key: keyOf(sourceKey, accountId), value })
    })
  }

  /** Forgets the records of accounts that are gone. */
  async forgetAccounts(accountIds: readonly string[]): Promise<void> {
    if (accountIds.length === 0) return
    const memory = collectionsOf(this.db()).memory
    for (const found of await memory.find({ formatId: OWN_MEMORY })) {
      if (found.key.startsWith(PREFIX) && accountIds.some(id => found.key.endsWith(`:${id}`))) await memory.deleteOne({ id: found.id })
    }
  }
}
