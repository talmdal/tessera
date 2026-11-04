// The `book.schema` extension point: what each domain plugin stores in a book, and how to migrate it.
import type { CollectionSchema, ExtensionRegistry, Logger, ServiceRegistry } from '@tessera/types'
import {
  BOOK_COLLECTIONS, BOOK_PLUGIN_ID, BOOK_SCHEMA_POINT, BookError, type Migrator, type SchemaContribution
} from '@tessera/book-api'

/** The book's own collections: part of the book format, not a contribution. */
export const BOOK_OWN_COLLECTIONS: CollectionSchema[] = [
  {
    name: BOOK_COLLECTIONS.subBooks,
    indexes: [
      { name: 'byParent', fields: ['parentId', 'order'] },
      // Sibling names are unique ignoring case; top-level sub-books store parentId: null, which counts as a value
      { name: 'uniqueName', fields: ['parentId', 'nameKey'], unique: true }
    ]
  }
]

const SERVICE_ID = /^[A-Za-z][\w-]*(\.[\w-]+)+$/

/** Why a contribution is invalid, or undefined. */
function problemWith(raw: unknown, contributor: string): string | undefined {
  if (typeof raw !== 'object' || raw === null) return `A book.schema contribution from "${contributor}" is not an object`
  const c = raw as Record<string, unknown>
  if (c.id !== contributor) return `A book.schema contribution from "${contributor}" must have id "${contributor}", not "${String(c.id)}"`
  if (contributor === BOOK_PLUGIN_ID) return `"${BOOK_PLUGIN_ID}" is reserved for the book's own collections`
  if (typeof c.version !== 'number' || !Number.isInteger(c.version) || c.version < 1) return `The book.schema of "${contributor}" needs a version that is a whole number of at least 1`
  if (typeof c.migrator !== 'string' || !SERVICE_ID.test(c.migrator)) return `The book.schema of "${contributor}" must name its migrator service, like "${contributor}.migrator"`
  if (!Array.isArray(c.collections)) return `The book.schema of "${contributor}" needs a list of collections`
  for (const collection of c.collections as unknown[]) {
    const name = (collection as { name?: unknown } | null)?.name
    if (typeof name !== 'string' || !name.startsWith(`${contributor}.`) || name.length === contributor.length + 1) {
      return `The book.schema of "${contributor}" declares collection "${String(name)}"; its collections must be named "${contributor}.<name>"`
    }
    const indexes = (collection as { indexes?: unknown }).indexes
    if (indexes !== undefined && !Array.isArray(indexes)) return `Collection "${name}" of "${contributor}" has invalid indexes`
  }
}

/**
 * Reads `book.schema` contributions each time it is asked, so plugins that activate later are included. Invalid
 * contributions are skipped, with one warning each.
 */
export class SchemaRegistry {
  private readonly warned = new Set<string>()

  constructor(
    private readonly extensions: Pick<ExtensionRegistry, 'getContributions'>,
    private readonly services: Pick<ServiceRegistry, 'has' | 'get'>,
    private readonly log: Pick<Logger, 'warn'>
  ) {}

  /** Valid contributions, ordered by contributor id so migrations run in the same order every time. */
  contributions(): SchemaContribution[] {
    const valid = new Map<string, SchemaContribution>()
    for (const { contributor, impl } of this.extensions.getContributions(BOOK_SCHEMA_POINT)) {
      const problem = problemWith(impl, contributor) ?? (valid.has(contributor) ? `"${contributor}" contributed to book.schema twice; the first is used` : undefined)
      if (problem) {
        if (!this.warned.has(problem)) { this.warned.add(problem); this.log.warn(`[book] ${problem}`) }
        continue
      }
      valid.set(contributor, impl as SchemaContribution)
    }
    return [...valid.values()].sort((a, b) => a.id.localeCompare(b.id))
  }

  /** Every collection a book is opened with: the book's own, then each contributor's. */
  collections(): CollectionSchema[] {
    return [...BOOK_OWN_COLLECTIONS, ...this.contributions().flatMap(c => c.collections)]
  }

  /** The contributor's migrator. Looked up when a book opens, after every plugin has activated. */
  migrator(contribution: SchemaContribution): Migrator {
    const migrator = this.services.has(contribution.migrator) ? this.services.get<Migrator>(contribution.migrator) : undefined
    if (typeof migrator?.migrate !== 'function') {
      throw new BookError('MIGRATION_FAILED',
        `The data of "${contribution.id}" can’t be prepared: its migrator service "${contribution.migrator}" isn’t available.`)
    }
    return migrator
  }
}
