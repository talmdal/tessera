import { describe, it, expect } from 'vitest'
import { resolveViews } from '../../shared/views/resolveViews'

const entries: Record<string, string> = { alpha: 'tessera-plugin://alpha/remoteEntry.js' }
const remoteEntryFor = (id: string) => entries[id]

const view = (id: string, extra: Record<string, unknown> = {}) =>
  ({ contributor: 'alpha', impl: { id, title: id, slot: 'shell.main', module: './View', ...extra } })

describe('resolveViews', () => {
  it('attaches plugin id and remote entry, sorted by order then registration', () => {
    const { views, diagnostics } = resolveViews([
      view('alpha.c', { order: 5 }),
      view('alpha.a'),
      view('alpha.b')
    ], remoteEntryFor)

    expect(diagnostics).toEqual([])
    expect(views.map(v => v.id)).toEqual(['alpha.a', 'alpha.b', 'alpha.c'])
    expect(views[0]).toEqual({
      id: 'alpha.a',
      title: 'alpha.a',
      slot: 'shell.main',
      module: './View',
      pluginId: 'alpha',
      remoteEntry: 'tessera-plugin://alpha/remoteEntry.js'
    })
  })

  it('resolves icons: a file in the renderer folder to its URL, a shell icon name as it is, and none when unnamed', () => {
    const iconUrlFor = (plugin: string, file: string) => `tessera-plugin://${plugin}/${file}`
    const { views, diagnostics } = resolveViews([
      view('alpha.file', { icon: './icons/a.svg' }),
      view('alpha.name', { icon: 'Save' }),
      view('alpha.none')
    ], remoteEntryFor, iconUrlFor)

    expect(diagnostics).toEqual([])
    expect(views.map(v => v.icon)).toEqual(['tessera-plugin://alpha/icons/a.svg', 'Save', undefined])
    expect(views[2]).not.toHaveProperty('icon')
  })

  it('skips views whose icon cannot be resolved', () => {
    const { views, diagnostics } = resolveViews([
      view('alpha.unknown', { icon: 'NotAnIcon' }),
      view('alpha.file', { icon: './a.svg' })
    ], remoteEntryFor)

    expect(views).toEqual([])
    expect(diagnostics).toEqual([
      'View "alpha.unknown" ignored: unknown icon "NotAnIcon"',
      'View "alpha.file" ignored: icon "./a.svg" needs a plugin with a renderer entry'
    ])
  })

  it('requires an icon in the bar slots, but not in the main slot', () => {
    const { views, diagnostics } = resolveViews([
      view('alpha.bar', { slot: 'shell.left' }),
      view('alpha.main'),
      view('alpha.rail', { slot: 'shell.right', icon: 'Home' })
    ], remoteEntryFor)

    expect(views.map(v => v.id)).toEqual(['alpha.main', 'alpha.rail'])
    expect(diagnostics).toEqual(['View "alpha.bar" in shell.left needs an icon, for the rail of a collapsed bar'])
  })

  it('keeps a valid when expression on the descriptor and skips an invalid one', () => {
    const { views, diagnostics } = resolveViews([
      view('alpha.ok', { when: 'vault.isOpen && !vault.isReadOnly' }),
      view('alpha.bad', { when: 'vault.isOpen &&' }),
      view('alpha.type', { when: 3 })
    ], remoteEntryFor)

    expect(views.map(v => [v.id, v.when])).toEqual([['alpha.ok', 'vault.isOpen && !vault.isReadOnly']])
    expect(diagnostics).toEqual([
      expect.stringContaining('View "alpha.bad" has an invalid when expression: Invalid expression "vault.isOpen &&"'),
      'View "alpha.type" has an invalid when expression'
    ])
  })

  it('skips views for unknown slots or with an invalid icon', () => {
    const { views, diagnostics } = resolveViews([
      view('alpha.slot', { slot: 'shell.middle' }),
      view('alpha.icon', { icon: 3 }),
      view('alpha.empty-icon', { icon: '' })
    ], remoteEntryFor)


    expect(views).toEqual([])
    expect(diagnostics).toEqual([
      'View "alpha.slot" targets unknown slot "shell.middle"',
      'View "alpha.icon" has an invalid icon',
      'View "alpha.empty-icon" has an invalid icon'
    ])
  })

  it.each(['shell.main', 'shell.top', 'shell.bottom', 'shell.left', 'shell.right'])('accepts the %s slot', slot => {
    expect(resolveViews([view('alpha.a', { slot, icon: 'Home' })], remoteEntryFor).views).toHaveLength(1)
  })

  it('skips views from contributors without a renderer, duplicates and invalid shapes', () => {
    const { views, diagnostics } = resolveViews([
      { contributor: 'beta', impl: { id: 'beta.x', title: 'X', slot: 'shell.main', module: './X' } },
      view('alpha.a'),
      view('alpha.a'),
      view('alpha.bad-module', { module: 'View' }),
      { contributor: 'alpha', impl: { id: 'alpha.no-slot', title: 'T', module: './V' } },
      { contributor: 'alpha', impl: null }
    ], remoteEntryFor)

    expect(views.map(v => v.id)).toEqual(['alpha.a'])
    expect(diagnostics).toEqual([
      'View "beta.x" ignored: "beta" has no renderer entry',
      'Duplicate view id "alpha.a" ignored',
      'View "alpha.bad-module" must name an exposed module like "./MyView"',
      'View "alpha.no-slot" is missing a slot',
      'View contribution is not an object'
    ])
  })
})
