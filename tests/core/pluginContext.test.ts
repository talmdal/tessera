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

describe('createPluginContext: settings', () => {
  it('registers settings in the plugin\'s own namespaces only', () => {
    const runtime = createRuntime()
    const { context } = createPluginContext('finance', runtime)

    expect(context.settings.register({ defaults: { currency: 'CAD' } }).get()).toEqual({ currency: 'CAD' })
    expect(context.settings.register({ id: 'finance.reports', defaults: {} }).id).toBe('finance.reports')
    expect(() => context.settings.register({ id: 'ledger', defaults: {} })).toThrow('"finance" cannot register settings "ledger"')
    expect(runtime.settings.has('finance')).toBe(true)
  })

  it('forgets the plugin\'s namespaces when it is deactivated, keeping what the user chose for next time', async () => {
    const runtime = createRuntime()
    const scope = createPluginContext('finance', runtime)
    await scope.context.settings.register({ defaults: { currency: 'CAD' } }).update({ currency: 'USD' })

    scope.dispose()

    expect(runtime.settings.has('finance')).toBe(false)
    const again = createPluginContext('finance', runtime).context.settings.register({ defaults: { currency: 'CAD' } })
    expect(again.get()).toEqual({ currency: 'USD' })
  })
})

describe('createPluginContext: reading other plugins\' settings', () => {
  it('lets a plugin read another plugin\'s settings and hear of changes, with nothing to change them by', async () => {
    const runtime = createRuntime()
    const ledger = createPluginContext('ledger', runtime).context.settings.register({ defaults: { recentLimit: 10 } })
    const { context } = createPluginContext('finance', runtime)

    const reader = context.settings.read<{ recentLimit: number }>('ledger')
    const heard: string[][] = []
    reader.onDidChange(event => heard.push(event.changed))
    await ledger.update({ recentLimit: 3 })

    expect(reader.get()).toEqual({ recentLimit: 3 })
    expect(heard).toEqual([['recentLimit']])
    expect(reader).not.toHaveProperty('update')
    expect(reader).not.toHaveProperty('reset')
  })

  it('stops the reader\'s listeners when the reading plugin is deactivated', async () => {
    const runtime = createRuntime()
    const ledger = createPluginContext('ledger', runtime).context.settings.register({ defaults: { recentLimit: 10 } })
    const scope = createPluginContext('finance', runtime)
    const heard: unknown[] = []
    scope.context.settings.read('ledger').onDidChange(event => heard.push(event))

    scope.dispose()
    await ledger.update({ recentLimit: 3 })

    expect(heard).toEqual([])
  })
})

describe('createPluginContext: state', () => {
  /** An app.state store in memory, provided as the app-state plugin provides it. */
  function withAppState() {
    const runtime = createRuntime()
    const values = new Map<string, unknown>()
    runtime.services.provide('app-state', 'app.state', {
      get: async (key: string, defaultFn?: () => unknown) => values.has(key) ? values.get(key) : defaultFn?.(),
      set: async (key: string, value: unknown) => { values.set(key, value) },
      update: async (key: string, patch: object) => { values.set(key, { ...(values.get(key) as object), ...patch }) },
      remove: async (key: string) => { values.delete(key) }
    })
    return { runtime, values }
  }

  it('keeps a plugin\'s state under its own keys in app.state, as plugins stored it before', async () => {
    const { runtime, values } = withAppState()
    const { state } = createPluginContext('ledger', runtime, { requires: ['app.state'] }).context

    await state.set('recent', ['Home'])
    await state.update('window', { width: 800 })
    await state.update('window', { height: 600 })

    expect([...values]).toEqual([['ledger.recent', ['Home']], ['ledger.window', { width: 800, height: 600 }]])
    expect(await state.get('recent')).toEqual(['Home'])
    expect(await state.get('missing', () => 'fallback')).toBe('fallback')
    expect(values.has('ledger.missing')).toBe(false)
    await state.remove('recent')
    expect(values.has('ledger.recent')).toBe(false)
  })

  it('reaches only the plugin\'s own keys', async () => {
    const { runtime, values } = withAppState()
    values.set('ledger.recent', ['Home'])
    const { state } = createPluginContext('import', runtime, { requires: ['app.state'] }).context

    expect(await state.get('recent')).toBeUndefined()
    expect(await state.get('ledger.recent')).toBeUndefined()
    await state.set('recent', 'mine')
    expect(values.get('ledger.recent')).toEqual(['Home'])
    expect(values.get('import.recent')).toBe('mine')
  })

  it('refuses a key that is not a non-empty string', async () => {
    const { state } = createPluginContext('ledger', withAppState().runtime).context
    await expect(state.get('')).rejects.toThrow('Plugin "ledger" used an invalid state key ""')
    await expect(state.set(3 as never, 1)).rejects.toThrow('invalid state key "3"')
  })

  it('needs app.state declared in the manifest, even when the store happens to be there', async () => {
    const { runtime } = withAppState()
    const { state } = createPluginContext('budget', runtime, { requires: ['ledger.session'] }).context
    await expect(state.get('x')).rejects.toThrow('Plugin "budget" used context.state without requiring "app.state": add it to services.requires in its manifest')
  })

  it('says so when the app-state plugin is not there', async () => {
    const { state } = createPluginContext('budget', createRuntime(), { requires: ['app.state'] }).context
    await expect(state.set('x', 1)).rejects.toThrow('"app.state" is not available: is the app-state plugin installed and active?')
  })
})
