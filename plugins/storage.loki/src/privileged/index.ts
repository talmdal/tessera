import fs from 'node:fs'
import path from 'node:path'
import { LokiStorageEngine } from './LokiStorageEngine'
import { PluginContext } from '@tessera/types'

export async function activate(context: PluginContext) {
  const root = context.paths // e.g. %APPDATA%/tessera
  const storageDir = path.join(root, 'storage')

  // Ensure directory exists
  fs.mkdirSync(storageDir, { recursive: true })

  const dbPath = path.join(storageDir, 'tessera.json')
  const engine = new LokiStorageEngine(dbPath)
  await engine.init()

  context.services.provide('storage-loki', 'storage.engine', engine)

  // Clean shutdown
  context.lifecycle.onShuttingDown(async () => {
    try {
      await engine.close()
      context.logger.info('[storage.loki] Clean shutdown complete')
    } catch (err) {
      context.logger.error('[storage.loki] Error during shutdown:', err)
    }
  })
}
