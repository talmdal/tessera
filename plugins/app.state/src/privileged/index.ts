// The app-state plugin: the application's key/value store (`app.state`), in the application's own database, apart
// from any ledger. Plugins use their own keys through `context.state`; the shell keeps window layouts and positions
// here too. There is deliberately no IPC: a view reaches its plugin's state through that plugin's own IPC handlers,
// answered from `context.state`, so it gets only what its plugin chooses to give it, and never another plugin's keys.
import { APP_STATE_SERVICE, type PluginContext, type StorageEngine } from '@tessera/types'
import { AppStateStore } from './AppStateStore'

export async function activate(context: PluginContext) {
  const storage = context.services.get<StorageEngine>('storage.engine')

  const store = new AppStateStore(storage)
  await store.init()

  context.subscriptions.push(
    context.services.provide(context.pluginId, APP_STATE_SERVICE, store),
    // Written to disk before the storage plugin closes the database
    context.lifecycle.onShuttingDown(() => store.flush())
  )
}
