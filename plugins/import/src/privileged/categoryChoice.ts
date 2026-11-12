// Each source's answer to "take the categories the file gives?", kept in the ledger. A file's categories are never
// used until the user has said so for its source (Categories from the File), and the answer is remembered per source:
// a Money export and a bank's CSV in the same ledger want different answers. Kept in `import.memory` under the import
// plugin's own id, which has no dot and so can't clash with a format's id ('<plugin>.<name>').
// See docs/import-formats-design.md, "Category hints".
import type { Database } from '@tessera/types'
import { IMPORT_PLUGIN_ID, type CategorySource } from '@tessera/import-api'
import { collectionsOf } from './store'

/** The `import.memory` owner for what the import manager itself remembers per source. */
export const OWN_MEMORY = IMPORT_PLUGIN_ID

const keyOf = (sourceKey: string) => `categories:${sourceKey}`

export interface CategoryChoice {
  source: CategorySource
  /** How the file named its source when the answer was given, for listing the answers later. */
  label: string
  decidedAt: string
}

const isSource = (value: unknown): value is CategorySource => value === 'file' || value === 'payee'

export class CategoryChoices {
  constructor(private readonly db: () => Database, private readonly now: () => string) {}

  /** The source's answer, if it has one. */
  async get(sourceKey: string): Promise<CategoryChoice | undefined> {
    const found = await collectionsOf(this.db()).memory.findOne({ formatId: OWN_MEMORY, key: keyOf(sourceKey) })
    const value = found?.value as Partial<CategoryChoice> | undefined
    return value && isSource(value.source)
      ? { source: value.source, label: String(value.label ?? ''), decidedAt: String(value.decidedAt ?? '') }
      : undefined
  }

  async save(sourceKey: string, source: CategorySource, label: string): Promise<void> {
    const value: CategoryChoice = { source, label, decidedAt: this.now() }
    await this.db().transaction(async tx => {
      const memory = collectionsOf(tx).memory
      const existing = await memory.findOne({ formatId: OWN_MEMORY, key: keyOf(sourceKey) })
      if (existing) await memory.replace({ ...existing, value })
      else await memory.insert({ formatId: OWN_MEMORY, key: keyOf(sourceKey), value })
    })
  }

  /** Forgets the source's answer: the next file from it asks again. */
  async forget(sourceKey: string): Promise<void> {
    await collectionsOf(this.db()).memory.deleteMany({ formatId: OWN_MEMORY, key: keyOf(sourceKey) })
  }
}
