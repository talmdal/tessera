// core/options/memoryOptionsStore.ts
import type { OptionsDocument } from '@tessera/types'
import type { OptionsStore } from '../ports'

/**
 * An options store that keeps everything in memory.
 *
 * The real store is a file, and the shell builds it. This one is what a runtime falls back to when nobody
 * supplied one — tests, and any embedding that has no user-data folder — so `context.options` always works and a
 * plugin never has to ask whether options are available.
 */
export function createMemoryOptionsStore(initial: OptionsDocument = {}): OptionsStore {
  let document: OptionsDocument = { ...initial }
  return {
    read: () => document,
    write: next => { document = next },
    flush: async () => {}
  }
}
