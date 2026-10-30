// plugins/storage.sqlite/src/privileged/index.ts
//
// Provides `storage.engine` (the document-database contract in
// tessera-types/storage.ts) backed by SQLite over node:sqlite, with named
// databases under <userData>/storage/. See docs/storage-engine-design.md.
//
// `storage.engine` has one provider at a time: with storage-loki also
// bundled, whichever is discovered first wins and the other is skipped with
// a warning. Which backend ships active is a bundling decision; both pass
// the same conformance suite, so nothing above the service can tell.
//
// Databases are closed in deactivate(), not onShuttingDown: the plugin
// manager deactivates the plugins that require storage.engine first, so
// every dependent has finished before the engine goes away.
import path from 'node:path'
import { PluginContext } from '@tessera/types'
import { SqliteStorageEngine } from './SqliteStorageEngine'

let engine: SqliteStorageEngine | undefined
let log: PluginContext['logger'] = console

export async function activate(context: PluginContext) {
  log = context.logger
  engine = new SqliteStorageEngine({ dir: path.join(context.paths, 'storage'), log })
  context.subscriptions.push(context.services.provide('storage-sqlite', 'storage.engine', engine))
}

export async function deactivate() {
  if (!engine) return
  try {
    await engine.closeAll()
    log.info('[storage-sqlite] Storage closed')
  } catch (err) {
    // Logged, not thrown: a failed final write must not stop the quit.
    log.error('[storage-sqlite] Error closing storage', err)
  } finally {
    engine = undefined
  }
}
