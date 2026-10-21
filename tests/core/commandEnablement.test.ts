import { describe, it, expect, vi } from 'vitest'
import { CommandRegistryImpl } from '../../core/commands/CommandRegistry'
import { ContextKeyServiceImpl } from '../../core/context/ContextKeyService'
import { createPluginContext } from '../../core/plugins/PluginContext'
import { createRuntime } from '../helpers/runtime'

describe('ContextKeyService', () => {
  it('stores values, removes them with undefined, and reports only real changes', () => {
    const keys = new ContextKeyServiceImpl()
    const changes: string[][] = []
    keys.onDidChange(c => changes.push(c))

    keys.set('vault.isOpen', true)
    keys.set('vault.isOpen', true)
    keys.set('vault.isOpen', undefined)

    expect(keys.get('vault.isOpen')).toBeUndefined()
    expect(changes).toEqual([['vault.isOpen'], ['vault.isOpen']])
  })

  it('deletes a whole namespace without touching look-alike keys', () => {
    const keys = new ContextKeyServiceImpl()
    keys.set('vault', 1)
    keys.set('vault.isOpen', true)
    keys.set('vaultx.isOpen', true)

    keys.deleteNamespace('vault')

    expect([keys.get('vault'), keys.get('vault.isOpen'), keys.get('vaultx.isOpen')]).toEqual([undefined, undefined, true])
  })
})

describe('command enablement', () => {
  it('evaluates the enablement expression against context keys', () => {
    const keys = new ContextKeyServiceImpl()
    const commands = new CommandRegistryImpl(keys)
    commands.register('vault.save', () => {}, { enablement: 'vault.isOpen && vault.isDirty' })
    commands.register('vault.open', () => {})

    expect(commands.isEnabled('vault.save')).toBe(false)
    expect(commands.isEnabled('vault.open')).toBe(true)
    expect(commands.isEnabled('vault.unknown')).toBe(false)

    keys.set('vault.isOpen', true)
    keys.set('vault.isDirty', true)
    expect(commands.isEnabled('vault.save')).toBe(true)
  })

  it('refuses to execute a disabled command', async () => {
    const handler = vi.fn()
    const commands = new CommandRegistryImpl()
    commands.register('vault.close', handler, { enablement: 'vault.isOpen' })

    await expect(commands.execute('vault.close')).rejects.toThrow('Command is disabled: vault.close')
    expect(handler).not.toHaveBeenCalled()
  })

  it('rejects invalid enablement expressions at registration', () => {
    const commands = new CommandRegistryImpl()

    expect(() => commands.register('vault.save', () => {}, { enablement: 'vault.isOpen &&' })).toThrow(/^Invalid expression/)
    expect(commands.has('vault.save')).toBe(false)
  })

  it('fires onDidChange for registrations, disposals and context key changes', () => {
    const keys = new ContextKeyServiceImpl()
    const commands = new CommandRegistryImpl(keys)
    const listener = vi.fn()
    commands.onDidChange(listener)

    commands.register('vault.save', () => {}).dispose()
    keys.set('vault.isOpen', true)

    expect(listener).toHaveBeenCalledTimes(3)
  })
})

describe('plugin context keys', () => {
  it('lets a plugin set only its own keys but read anyone\'s', () => {
    const runtime = createRuntime()
    createPluginContext('vault', runtime).context.contextKeys.set('vault.isOpen', true)
    const { context } = createPluginContext('export', runtime)

    expect(context.contextKeys.get('vault.isOpen')).toBe(true)
  })

  it('lets other plugins enable their commands from another plugin\'s keys', () => {
    const runtime = createRuntime()
    const vault = createPluginContext('vault', runtime).context
    const exporter = createPluginContext('export', runtime).context
    exporter.commands.register('export.vault', () => {}, { enablement: 'vault.isOpen' })

    expect(exporter.commands.isEnabled('export.vault')).toBe(false)
    vault.contextKeys.set('vault.isOpen', true)
    expect(exporter.commands.isEnabled('export.vault')).toBe(true)
  })

  it('clears the plugin\'s keys on deactivation', () => {
    const runtime = createRuntime()
    const scope = createPluginContext('vault', runtime)
    scope.context.contextKeys.set('vault.isOpen', true)

    scope.dispose()

    expect(runtime.contextKeys.get('vault.isOpen')).toBeUndefined()
  })
})
