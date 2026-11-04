import fs from 'node:fs'
import path from 'node:path'
import { KitStorageEngine } from '@tessera/storage-kit'
import type { PluginContext } from '@tessera/types'
import { lokiDriver } from './LokiDriver'

let engine: KitStorageEngine | undefined

export async function activate(context: PluginContext) {
  const directory = path.join(context.paths, 'storage')
  fs.mkdirSync(directory, { recursive: true })

  engine = new KitStorageEngine(lokiDriver({ directory, log: context.logger }))
  context.services.provide('storage-loki', 'storage.engine', engine)
}

/**
 * Runs after every plugin that requires `storage.engine` has deactivated, so their last writes (their own
 * `onShuttingDown` flushes included) are in before the databases close.
 */
export async function deactivate() {
  const closing = engine
  engine = undefined
  await closing?.closeAll()
}
