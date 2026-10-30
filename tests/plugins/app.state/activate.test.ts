// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'
import type { AppState } from '@tessera/types'
import { createPluginContext } from '../../../core/plugins/PluginContext'
import { MemoryStorageEngine } from '../../../core/storage/memory/MemoryStorageEngine'
import { activate } from '../../../plugins/app.state/src/privileged/index'
import { createRuntime } from '../../helpers/runtime'

async function setup() {
  const runtime = createRuntime()
  const engine = new MemoryStorageEngine()
  runtime.services.provide('storage-loki', 'storage.engine', engine)

  const scope = createPluginContext('app-state', runtime)
  await activate(scope.context)

  const invoke = (channel: string, data?: unknown) => runtime.ipc.dispatch({ channel, data })
  return { runtime, engine, scope, invoke }
}

describe('app-state: privileged half', () => {
  it('provides app.state over the storage engine', async () => {
    const { runtime } = await setup()
    expect(runtime.services.providerOf('app.state')).toBe('app-state')
    const state = runtime.services.get<AppState>('app.state')
    await state.set('theme', 'dark')
    expect(await state.get('theme')).toBe('dark')
  })

  it('answers get, set, update and remove over IPC', async () => {
    const { invoke } = await setup()

    expect(await invoke('app.state:get', { key: 'window' })).toMatchObject({ ok: true, data: undefined })
    expect(await invoke('app.state:get', { key: 'window', defaultValue: { width: 800 } })).toMatchObject({ ok: true, data: { width: 800 } })

    await invoke('app.state:set', { key: 'window', value: { width: 1024, maximized: false } })
    await invoke('app.state:update', { key: 'window', patch: { maximized: true } })
    expect(await invoke('app.state:get', { key: 'window' })).toMatchObject({ ok: true, data: { width: 1024, maximized: true } })

    await invoke('app.state:remove', { key: 'window' })
    expect(await invoke('app.state:get', { key: 'window' })).toMatchObject({ ok: true, data: undefined })
  })

  it('reports a value that cannot be stored as an error reply', async () => {
    const { invoke } = await setup()
    const reply = await invoke('app.state:set', { key: 'bad', value: { when: new Date() } })
    expect(reply.ok).toBe(false)
  })

  it('flushes on shutdown and removes its service on deactivation', async () => {
    const { runtime, engine, scope } = await setup()
    const db = await engine.open({ name: 'app' })
    const flush = vi.spyOn(db, 'flush')

    await runtime.lifecycle.requestShutdown('user')
    expect(flush).toHaveBeenCalled()

    scope.dispose()
    expect(runtime.services.has('app.state')).toBe(false)
  })
})
