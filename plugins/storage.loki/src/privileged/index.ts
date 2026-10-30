// plugins/storage.loki/src/privileged/index.ts
//
// Provides `storage.engine` (the document-database contract in
// tessera-types/storage.ts) backed by LokiJS, with named databases under
// <userData>/storage/. See docs/storage-engine-design.md.
//
// Databases are closed in deactivate(), not onShuttingDown: the plugin
// manager deactivates the plugins that require storage.engine first, so
// every dependent has flushed before the engine goes away.
import path from 'node:path'
import { PluginContext } from '@tessera/types'
import { LokiStorageEngine } from './LokiStorageEngine'

let engine: LokiStorageEngine | undefined
let log: PluginContext['logger'] = console

export async function activate(context: PluginContext) {
  log = context.logger
  engine = new LokiStorageEngine({ dir: path.join(context.paths, 'storage'), log })
  context.subscriptions.push(context.services.provide('storage-loki', 'storage.engine', engine))
}

export async function deactivate() {
  if (!engine) return
  try {
    await engine.closeAll()
    log.info('[storage-loki] Storage closed')
  } catch (err) {
    // Logged, not thrown: a failed final save must not stop the quit.
    log.error('[storage-loki] Error closing storage', err)
  } finally {
    engine = undefined
  }
}
