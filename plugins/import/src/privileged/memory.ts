// A format's memory (ParseContext.memory): small values a format plugin keeps between imports, such as a CSV file's
// column layout, stored in the ledger under the format's id.
import type { Database } from '@tessera/types'
import type { FormatMemory } from '@tessera/import-api'
import { collectionsOf } from './store'

export function formatMemory(db: () => Database, formatId: string): FormatMemory {
  return {
    async get<T>(key: string) {
      const found = await collectionsOf(db()).memory.findOne({ formatId, key })
      return found?.value as T | undefined
    },
    async set(key: string, value: unknown) {
      // Kept as JSON would be: a value that can't be written that way fails here, not later
      const json = JSON.parse(JSON.stringify(value ?? null))
      const c = collectionsOf(db())
      const existing = await c.memory.findOne({ formatId, key })
      if (existing) await c.memory.replace({ ...existing, value: json })
      else await c.memory.insert({ formatId, key, value: json })
    }
  }
}
