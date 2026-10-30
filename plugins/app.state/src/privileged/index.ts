import { PluginContext, StorageEngine } from '@tessera/types'
import type { GetRequest } from '../shared'
import { AppStateStore } from './AppStateStore'

export async function activate(context: PluginContext) {
  const engine = context.services.get<StorageEngine>('storage.engine')

  const store = new AppStateStore(engine)
  await store.init()

  context.subscriptions.push(context.services.provide('app-state', 'app.state', store))

  context.lifecycle.onShuttingDown(async () => {
    try {
      await store.flush()
    } catch (err) {
      context.logger.error('[app-state] Failed to save application state', err)
    }
  })

  context.ipc.register('app.state:get', async (msg: any) => {
    const { key, defaultValue } = msg.data as GetRequest
    return await store.get(key, defaultValue === undefined ? undefined : () => defaultValue)
  })

  context.ipc.register('app.state:set', async (msg: any) => {
    const { key, value } = msg.data
    await store.set(key, value)
  })

  context.ipc.register('app.state:update', async (msg: any) => {
    const { key, patch } = msg.data
    await store.update(key, patch)
  })

  context.ipc.register('app.state:remove', async (msg: any)=> {
    const { key } = msg.data
    await store.remove(key)
  })
}
