import { LokiStorageEngine } from './LokiStorageEngine'
import { PluginRuntime } from '../../../../core/plugins/PluginContext'

export async function activate(context: PluginRuntime) {
  const engine = new LokiStorageEngine(context.paths)
  await engine.init()

  context.services.provide('storage.engine', 'storage.loki', engine)

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
