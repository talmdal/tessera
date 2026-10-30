// core/storage/index.ts
//
// The storage kit: everything a backend needs besides its own store. A
// backend maps the contract in tessera-types/storage.ts onto its engine and
// uses these for the parts that must behave identically everywhere:
// validation, filter and update semantics, sorting, cursors, aggregation
// (for stages it can't push down), ids and errors.
export { StorageError, isStorageError } from './errors'
export { MemoryStorageEngine } from './memory/MemoryStorageEngine'
export { KitDatabase, type DatabaseBackend } from './kit/KitDatabase'
export { KitCollection, type Scope, type ChangeKind } from './kit/KitCollection'
export { MapStore, type DocumentStore, indexKey, checkUnique, buildUnique, rebuildUnique, put, remove, cloneUnique } from './kit/DocumentStore'
export { compileFilter, filterEqualities, filterFields, tokenize, type Predicate } from './filter'
export { applyUpdate, validateUpdate } from './update'
export { compileSort, sortFields, type Comparator } from './sort'
export { compileProjection, type Projector } from './projection'
export { encodeCursor, decodeCursor, compareToCursor } from './cursor'
export { runPipeline, compilePipeline, compileExpression, SUPPORTED, type CollectionResolver } from './aggregate'
export { normalizeDocument, validateCollectionName, validateIndexSpec, sameIndex, RESERVED_FIELDS } from './documents'
export { toJson, cloneJson, deepEqual, getPath, setPath, deletePath, compareJson, canonical, isPlainObject, isJsonObject } from './json'
export { ulid } from './ulid'
