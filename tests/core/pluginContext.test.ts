import { describe, it, expect } from 'vitest'
import { createPluginContext } from '../../core/plugins/PluginContext'
import { createRuntime } from '../helpers/runtime'

describe('createPluginContext', () => {
  it('binds IPC handlers to the plugin namespace', async () => {
    const runtime = createRuntime()
    createPluginContext('finance', runtime).context.ipc.handle('accounts.list', () => ['chequing'])

    await expect(runtime.ipc.dispatch({ channel: 'finance:accounts.list' })).resolves.toMatchObject({ data: ['chequing'] })
  })

  it('rejects IPC events that would escape the namespace', () => {
    const { context } = createPluginContext('finance', createRuntime())

    expect(() => context.ipc.handle('other:x', () => 1)).toThrow('invalid IPC event')
    expect(() => context.ipc.handle('', () => 1)).toThrow('invalid IPC event')
  })

  it('only lets a plugin register command and contribution ids it owns', () => {
    const { context } = createPluginContext('finance', createRuntime())

    expect(() => context.commands.register('finance.open', () => 1)).not.toThrow()
    expect(() => context.commands.register('shell.quit', () => 1)).toThrow('ids must start with "finance."')
    expect(() => context.commands.register('financeX.open', () => 1)).toThrow()
    expect(() => context.extensions.contribute('shell.menus', { id: 'shell.file' })).toThrow('ids must start with "finance."')
    expect(() => context.extensions.contribute('shell.menus', {} as { id: string })).toThrow()
  })

  it('records the contributor and still lets plugins use others\' commands', async () => {
    const runtime = createRuntime()
    createPluginContext('shell', runtime).context.commands.register('shell.ping', () => 'pong')
    const { context } = createPluginContext('finance', runtime)

    context.extensions.contribute('shell.menus', { id: 'finance.menu' })

    expect(runtime.extensions.getContributions('shell.menus')).toMatchObject([{ id: 'finance.menu', contributor: 'finance' }])
    await expect(context.commands.execute('shell.ping')).resolves.toBe('pong')
  })

  it('undoes every registration, including pushed subscriptions, on dispose', () => {
    const runtime = createRuntime()
    const scope = createPluginContext('finance', runtime)
    const disposed: string[] = []

    scope.context.ipc.handle('x', () => 1)
    scope.context.commands.register('finance.x', () => 1)
    scope.context.extensions.contribute('shell.menus', { id: 'finance.x' })
    scope.context.subscriptions.push({ dispose: () => { disposed.push('own'); throw new Error('ignored') } })

    scope.dispose()

    expect(runtime.ipc.has('finance:x')).toBe(false)
    expect(runtime.commands.has('finance.x')).toBe(false)
    expect(runtime.extensions.getContributions('shell.menus')).toEqual([])
    expect(disposed).toEqual(['own'])
    expect(scope.context.subscriptions).toEqual([])
  })
})
