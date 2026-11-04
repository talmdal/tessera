// @tessera/storage-kit: the shared half of every `storage.engine` backend. It holds all the querying,
// transaction and change-event semantics, so a backend only implements `BackendDriver` / `StorageBackend`
// (open, load, persist a batch, flush, close). Depends on @tessera/types alone, so a backend plugin can
// bundle it without reaching into core/ or shared/.
export * from './backend'
export * from './engine'
export * from './errors'
export * from './memory'
export { ulid } from './ulid'
export { KitDatabase } from './database'
export type { IndexSpec } from './state'
