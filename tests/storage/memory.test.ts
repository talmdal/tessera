// @vitest-environment node
import { MemoryStorageEngine } from '../../core/storage/memory/MemoryStorageEngine'
import { describeStorageEngine } from './conformance'

describeStorageEngine('memory', {
  create: async () => new MemoryStorageEngine(),
  // The memory engine keeps its databases for as long as the instance lives.
  reopen: async engine => engine
})
