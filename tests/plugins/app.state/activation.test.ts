// @vitest-environment node
// The app-state plugin as the app activates it: it provides the store, and nothing else reaches it. Views have no
// channel of their own into it; a plugin's view asks its own plugin, which answers from context.state.
import { describe, expect, it, vi } from 'vitest'
import { KitStorageEngine, memoryDriver } from '@tessera/storage-kit'
import { APP_STATE_SERVICE, type AppState } from '@tessera/types'
import { createPluginContext, createPluginRuntime } from '../../../core/plugins/PluginContext'
import { activate } from '../../../plugins/app.state/src/privileged/index'
import { createLogger } from '../../helpers/runtime'

async function setup() {
  const runtime = createPluginRuntime(undefined, createLogger())
  const engine = new KitStorageEngine(memoryDriver())
  runtime.services.provide('storage-memory', 'storage.engine', engine)
  const scope = createPluginContext('app-state', runtime, { provides: [APP_STATE_SERVICE], requires: ['storage.engine'] })
  await activate(scope.context)
  return { runtime, scope, engine }
}

describe('the app-state plugin', () => {
  it('provides the store other plugins reach through context.state', async () => {
    const { runtime } = await setup()
    const budget = createPluginContext('budget', runtime, { requires: [APP_STATE_SERVICE] }).context

    await budget.state.set('layout', { columns: 3 })

    expect(await runtime.services.get<AppState>(APP_STATE_SERVICE).get('budget.layout')).toEqual({ columns: 3 })
  })

  it('offers views no channel into the store: a view asks its own plugin', async () => {
    const { runtime } = await setup()

    for (const event of ['get', 'set', 'update', 'remove']) expect(runtime.ipc.has(`app.state:${event}`), event).toBe(false)
    const reply = await runtime.ipc.dispatch({ channel: 'app.state:get', data: { key: 'ledger.recent' } }, { windowId: 1 })
    expect(reply).toMatchObject({ ok: false, error: { code: 'NO_HANDLER' } })
  })

  it('lets a view reach its plugin\'s state through the plugin\'s own IPC, answered from context.state', async () => {
    const { runtime } = await setup()
    // As plugin-creation.md shows: a handler for what the view needs, checked, and only the plugin's own keys
    const budget = createPluginContext('budget', runtime, { requires: [APP_STATE_SERVICE] }).context
    budget.ipc.register('budget:columns.get', () => budget.state.get('columns', () => ({ name: 200, amount: 120 })))
    budget.ipc.register('budget:columns.set', async (msg: { data?: unknown }) => {
      const widths = msg.data as Record<string, number>
      if (typeof widths !== 'object' || widths === null || !Object.values(widths).every(w => Number.isInteger(w) && w > 0)) {
        throw new Error('Column widths must be whole numbers of pixels')
      }
      await budget.state.set('columns', widths)
    })
    const view = (channel: string, data?: unknown) => runtime.ipc.dispatch({ channel, data }, { windowId: 1 })

    expect(await view('budget:columns.get')).toMatchObject({ ok: true, data: { name: 200, amount: 120 } })
    expect(await view('budget:columns.set', { name: 240, amount: 120 })).toMatchObject({ ok: true })
    expect(await view('budget:columns.set', { name: -1 })).toMatchObject({ ok: false, error: { message: 'Column widths must be whole numbers of pixels' } })

    expect(await view('budget:columns.get')).toMatchObject({ ok: true, data: { name: 240, amount: 120 } })
    expect(await runtime.services.get<AppState>(APP_STATE_SERVICE).get('budget.columns')).toEqual({ name: 240, amount: 120 })
  })

  it('writes the store to disk when the app is asked to quit', async () => {
    const { runtime, engine } = await setup()
    const database = await engine.open({ name: 'app' })
    const flush = vi.spyOn(database, 'flush')

    await runtime.lifecycle.requestShutdown('system')

    expect(flush).toHaveBeenCalled()
  })

  it('withdraws the store, and its shutdown work, when it is deactivated', async () => {
    const { runtime, scope, engine } = await setup()
    const flush = vi.spyOn(await engine.open({ name: 'app' }), 'flush')

    scope.dispose()
    await runtime.lifecycle.requestShutdown('system')

    expect(runtime.services.has(APP_STATE_SERVICE)).toBe(false)
    expect(flush).not.toHaveBeenCalled()
  })
})
