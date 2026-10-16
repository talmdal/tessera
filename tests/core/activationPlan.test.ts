import { describe, it, expect } from 'vitest'
import { planActivation } from '../../core/plugins/activationPlan'
import type { PluginManifest } from '../../shared/plugins/manifest'

const plugin = (id: string, services: PluginManifest['services'] = {}) =>
  ({ manifest: { id, name: id, version: '1', privileged: { entry: 'i.js' }, services } })

const plan = (candidates: ReturnType<typeof plugin>[], shellServices: string[] = []) => {
  const result = planActivation(candidates, id => shellServices.includes(id))
  return {
    order: result.order.map(c => c.manifest.id),
    skipped: Object.fromEntries(result.skipped.map(s => [s.candidate.manifest.id, s.reason]))
  }
}

describe('planActivation', () => {
  it('keeps discovery order when there are no dependencies', () => {
    expect(plan([plugin('a'), plugin('b'), plugin('c')]).order).toEqual(['a', 'b', 'c'])
  })

  it('activates providers before the plugins that require them', () => {
    const result = plan([
      plugin('reports', { requires: ['vault.store'] }),
      plugin('budget'),
      plugin('vault', { provides: ['vault.store'], requires: ['crypto.cipher'] }),
      plugin('crypto', { provides: ['crypto.cipher'] })
    ])

    expect(result.order).toEqual(['budget', 'crypto', 'vault', 'reports'])
    expect(result.skipped).toEqual({})
  })

  it('treats services already registered (by the shell) as satisfied', () => {
    expect(plan([plugin('a', { requires: ['shell.dialogs'] })], ['shell.dialogs']).order).toEqual(['a'])
  })

  it('ignores a plugin requiring a service it provides itself', () => {
    expect(plan([plugin('a', { provides: ['a.x'], requires: ['a.x'] })]).order).toEqual(['a'])
  })

  it('skips the second provider of a service, and providers of shell services', () => {
    const result = plan([
      plugin('sqlite', { provides: ['vault.store'] }),
      plugin('files', { provides: ['vault.store'] }),
      plugin('rogue', { provides: ['shell.dialogs'] })
    ], ['shell.dialogs'])

    expect(result.order).toEqual(['sqlite'])
    expect(result.skipped).toEqual({
      files: 'service "vault.store" is also provided by "sqlite"',
      rogue: 'service "shell.dialogs" is already provided by the shell'
    })
  })

  it('skips plugins with missing providers, and everything that depends on them', () => {
    const result = plan([
      plugin('vault', { provides: ['vault.store'], requires: ['crypto.cipher'] }),
      plugin('reports', { requires: ['vault.store'] }),
      plugin('ok')
    ])

    expect(result.order).toEqual(['ok'])
    expect(result.skipped).toEqual({
      vault: 'requires service "crypto.cipher", which no plugin provides',
      reports: 'requires service "vault.store", but its provider "vault" was skipped'
    })
  })

  it('skips plugins in, or depending on, a dependency cycle', () => {
    const result = plan([
      plugin('a', { provides: ['a.x'], requires: ['b.x'] }),
      plugin('b', { provides: ['b.x'], requires: ['a.x'] }),
      plugin('c', { requires: ['a.x'] }),
      plugin('d')
    ])

    expect(result.order).toEqual(['d'])
    expect(Object.keys(result.skipped)).toEqual(['a', 'b', 'c'])
    expect(result.skipped.a).toBe('has a circular service dependency (among: a, b, c)')
  })
})
