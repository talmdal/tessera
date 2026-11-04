// Bringing each `book.schema` contributor's data up to its plugin's version.
import type { Database } from '@tessera/types'
import { BOOK_META, BookError, type SchemaContribution } from '@tessera/book-api'
import type { SchemaRegistry } from './SchemaRegistry'
import { scopedDatabase } from './scopedDatabase'

export interface MigrationStep {
  contribution: SchemaContribution
  /** The version in the file (0: none of this contributor's data yet). */
  from: number
}

export interface MigrationPlan {
  steps: MigrationStep[]
  /** True when existing data will change (a step from version 1 or later), so the file must be backed up first. */
  needsBackup: boolean
}

/** Reads the contributors' versions from a book's meta. */
export async function schemaVersions(db: Database, contributions: readonly SchemaContribution[]): Promise<Record<string, number>> {
  const versions: Record<string, number> = {}
  for (const { id } of contributions) {
    const version = await db.meta.get(BOOK_META.schemaVersion(id))
    versions[id] = typeof version === 'number' && Number.isInteger(version) && version > 0 ? version : 0
  }
  return versions
}

/**
 * What opening a book with these versions needs. A file newer than a plugin is refused: the plugin can't know
 * what the newer data means, and writing to it could damage it. A contributor whose plugin isn't installed isn't
 * in `contributions`, so its data is left as it is.
 */
export function planMigrations(contributions: readonly SchemaContribution[], versions: Record<string, number>, fileName: string): MigrationPlan {
  const steps: MigrationStep[] = []
  for (const contribution of contributions) {
    const from = versions[contribution.id] ?? 0
    if (from > contribution.version) {
      throw new BookError('UNSUPPORTED_FILE',
        `“${fileName}” was saved by a newer version of the “${contribution.id}” plugin (data version ${from}; this one understands ${contribution.version}). Update Tessera to open it.`)
    }
    if (from < contribution.version) steps.push({ contribution, from })
  }
  return { steps, needsBackup: steps.some(step => step.from > 0) }
}

/**
 * Runs each step, one version at a time, recording each version as soon as it is reached, so a crash part way
 * resumes from the last finished version. A migrator that throws stops everything.
 */
export async function runMigrations(db: Database, plan: MigrationPlan, registry: SchemaRegistry): Promise<void> {
  for (const { contribution, from } of plan.steps) {
    const migrator = registry.migrator(contribution)
    const scoped = scopedDatabase(db, contribution.id)
    for (let version = from; version < contribution.version; version++) {
      try {
        await migrator.migrate(scoped, version)
      } catch (err) {
        throw new BookError('MIGRATION_FAILED',
          `The data of “${contribution.id}” could not be brought from version ${version} to ${version + 1}: ${err instanceof Error ? err.message : String(err)}`)
      }
      await db.meta.set(BOOK_META.schemaVersion(contribution.id), version + 1)
    }
  }
}
