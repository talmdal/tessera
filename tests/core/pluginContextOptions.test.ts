// context.options: a plugin's own options, and nobody else's.
import { describe, it, expect, vi } from 'vitest'
import { OptionsService } from '../../core/options/OptionsService'
import { createMemoryOptionsStore } from '../../core/options/memoryOptionsStore'
import { createPluginContext, createPluginRuntime } from '../../core/plugins/PluginContext'
import { createLogger } from '../helpers/runtime'

const DEFAULTS = { autoBackup: true, backup: { count: 5 } }

function setup(stored: Record<string, unknown> = {}) {
  const store = createMemoryOptionsStore(stored as never)
  const options = new OptionsService(store, { log: createLogger() })
  const runtime = createPluginRuntime(undefined, createLogger(), options)
  return { options, runtime, store }
}

describe('context.options', () => {
  it('registers under the plugin id, with no namespace to pass', () => {
    const { runtime, options } = setup()
    const scope = createPluginContext('book', runtime)

    const handle = scope.context.options.register({ defaults: DEFAULTS })

    expect(handle.get()).toEqual(DEFAULTS)
    expect(options.namespaces()).toEqual(['book'])
  })

  it('reads the values stored for that plugin, and is synchronous', () => {
    const { runtime } = setup({ book: { version: 1, values: { autoBackup: false } } })
    const scope = createPluginContext('book', runtime)

    expect(scope.context.options.register({ defaults: DEFAULTS }).get())
      .toEqual({ autoBackup: false, backup: { count: 5 } })
  })

  it('gives two plugins separate namespaces', () => {
    const { runtime, options } = setup({
      book: { version: 1, values: { autoBackup: false } },
      ledger: { version: 1, values: { autoBackup: true } }
    })

    const book = createPluginContext('book', runtime).context.options.register({ defaults: DEFAULTS })
    const ledger = createPluginContext('ledger', runtime).context.options.register({ defaults: { autoBackup: false } })

    expect(book.get().autoBackup).toBe(false)
    expect(ledger.get().autoBackup).toBe(true)
  })

  it('offers a plugin no way to name a namespace that is not its own', () => {
    const { runtime } = setup()
    const api = createPluginContext('book', runtime).context.options

    // The only method takes a spec, never a namespace: ownership is structural, not a rule to break.
    expect(Object.keys(api)).toEqual(['register'])
    expect(api.register.length).toBe(1)
  })

  it('refuses a second registration by the same plugin', () => {
    const { runtime } = setup()
    const api = createPluginContext('book', runtime).context.options

    api.register({ defaults: DEFAULTS })
    expect(() => api.register({ defaults: DEFAULTS })).toThrow(/already registered/)
  })

  it('tells the plugin when its options change', () => {
    const { runtime, options } = setup()
    const handle = createPluginContext('book', runtime).context.options.register({ defaults: DEFAULTS })
    const listener = vi.fn()
    handle.onDidChange(listener)

    options.commit('book', { autoBackup: false, backup: { count: 5 } })

    expect(listener).toHaveBeenCalledWith({ autoBackup: false, backup: { count: 5 } }, DEFAULTS)
  })

  it('forgets the registration when the plugin deactivates, keeping the stored values', () => {
    const { runtime, options, store } = setup()
    const scope = createPluginContext('book', runtime)
    scope.context.options.register({ defaults: DEFAULTS })
    options.commit('book', { autoBackup: false, backup: { count: 5 } })

    scope.dispose()

    expect(options.has('book')).toBe(false)
    expect(store.read()).toEqual({ book: { version: 1, values: { autoBackup: false } } })
  })

  it('lets a plugin register again after being deactivated, finding its values where it left them', () => {
    const { runtime, options } = setup()
    const first = createPluginContext('book', runtime)
    first.context.options.register({ defaults: DEFAULTS })
    options.commit('book', { autoBackup: false, backup: { count: 5 } })
    first.dispose()

    const second = createPluginContext('book', runtime)
    expect(second.context.options.register({ defaults: DEFAULTS }).get().autoBackup).toBe(false)
  })

  it('stops telling a deactivated plugin about changes', () => {
    const { runtime, options } = setup()
    const scope = createPluginContext('book', runtime)
    const handle = scope.context.options.register({ defaults: DEFAULTS })
    const listener = vi.fn()
    handle.onDidChange(listener)

    scope.dispose()
    createPluginContext('book', runtime).context.options.register({ defaults: DEFAULTS })
    options.commit('book', { autoBackup: false, backup: { count: 5 } })

    expect(listener).not.toHaveBeenCalled()
  })

  it('works without a store, so tests and embeddings need not supply one', () => {
    const runtime = createPluginRuntime(undefined, createLogger())
    const handle = createPluginContext('book', runtime).context.options.register({ defaults: DEFAULTS })

    expect(handle.get()).toEqual(DEFAULTS)
    runtime.options.register('other', { defaults: { a: 1 } })
    expect(runtime.options.register).toBeDefined()
  })
})
