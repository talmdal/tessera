import { describe, it, expect } from 'vitest'
import { createPluginContext } from '../../core/plugins/PluginContext'
import { createRuntime } from '../helpers/runtime'

describe('createPluginContext', () => {
  it('shares the runtime registries with the plugin', () => {
    const runtime = createRuntime()
    const { context } = createPluginContext('finance', runtime)

    expect(context.ipc).toBe(runtime.ipc)
    expect(context.extensions).toBe(runtime.extensions)
    expect(context.contextKeys).toBe(runtime.contextKeys)
    expect(context.services).toBe(runtime.services)
    expect(context.lifecycle).toBe(runtime.lifecycle)
  })

  it('registers IPC handlers on the channel the plugin names', async () => {
    const runtime = createRuntime()
    createPluginContext('finance', runtime).context.ipc.register('finance:accounts.list', () => ['chequing'])

    await expect(runtime.ipc.dispatch({ channel: 'finance:accounts.list' })).resolves.toMatchObject({ data: ['chequing'] })
  })

  it('only lets a plugin register command ids it owns', () => {
    const { context } = createPluginContext('finance', createRuntime())

    expect(() => context.commands.register('finance.open', () => 1)).not.toThrow()
    expect(() => context.commands.register('shell.quit', () => 1)).toThrow('ids must start with "finance."')
    expect(() => context.commands.register('financeX.open', () => 1)).toThrow()
  })

  it('records the contributor and still lets plugins use others\' commands', async () => {
    const runtime = createRuntime()
    createPluginContext('shell', runtime).context.commands.register('shell.ping', () => 'pong')
    const { context } = createPluginContext('finance', runtime)

    context.extensions.contribute('finance', 'shell.menus', 'finance.menu', { id: 'finance.menu' })

    expect(runtime.extensions.getContributions('shell.menus')).toMatchObject([{ id: 'finance.menu', contributor: 'finance' }])
    await expect(context.commands.execute('shell.ping')).resolves.toBe('pong')
  })

  it('undoes tracked registrations and pushed subscriptions on dispose', () => {
    const runtime = createRuntime()
    const scope = createPluginContext('finance', runtime)
    const disposed: string[] = []

    scope.context.commands.register('finance.x', () => 1)
    scope.context.subscriptions.push(scope.context.ipc.register('finance:x', () => 1))
    scope.context.subscriptions.push(scope.context.extensions.contribute('finance', 'shell.menus', 'finance.x', {}))
    scope.context.subscriptions.push({ dispose: () => { disposed.push('own'); throw new Error('ignored') } })

    scope.dispose()

    expect(runtime.ipc.has('finance:x')).toBe(false)
    expect(runtime.commands.has('finance.x')).toBe(false)
    expect(runtime.extensions.getContributions('shell.menus')).toEqual([])
    expect(disposed).toEqual(['own'])
    expect(scope.context.subscriptions).toEqual([])
  })
})
