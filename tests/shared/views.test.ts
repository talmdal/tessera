import { describe, it, expect } from 'vitest'
import { resolveViews } from '../../shared/views/resolveViews'

const entries: Record<string, string> = { alpha: 'tessera-plugin://alpha/remoteEntry.js' }
const remoteEntryFor = (id: string) => entries[id]
const resources = {
  remoteEntryFor,
  assetUrlFor: (id: string, rel: string) => entries[id] && `tessera-plugin://${id}/${rel}`
}

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

  it('skips views from contributors without a renderer, duplicates and invalid shapes', () => {
    const { views, diagnostics } = resolveViews([
      { contributor: 'beta', impl: { id: 'beta.x', title: 'X', slot: 'shell.main', module: './X' } },
      view('alpha.a'),
      view('alpha.a'),
      view('alpha.bad-module', { module: 'View' }),
      { contributor: 'alpha', impl: { id: 'alpha.no-slot', title: 'T', module: './V' } },
      { contributor: 'alpha', impl: { id: 'alpha.odd-slot', title: 'T', slot: 's', module: './V' } },
      { contributor: 'alpha', impl: null }
    ], remoteEntryFor)

    expect(views.map(v => v.id)).toEqual(['alpha.a'])
    expect(diagnostics).toEqual([
      'View "beta.x" ignored: "beta" has no renderer entry',
      'Duplicate view id "alpha.a" ignored',
      'View "alpha.bad-module" must name an exposed module like "./MyView"',
      'View "alpha.no-slot" is missing a slot',
      'View "alpha.odd-slot" targets unknown slot "s"',
      'View contribution is not an object'
    ])
  })

  it('keeps when expressions and rejects invalid ones', () => {
    const { views, diagnostics } = resolveViews([
      view('alpha.a', { when: 'vault.isOpen' }),
      view('alpha.broken', { when: 'vault.isOpen &&' })
    ], remoteEntryFor)

    expect(views.map(v => v.id)).toEqual(['alpha.a'])
    expect(views[0].when).toBe('vault.isOpen')
    expect(diagnostics).toEqual([
      expect.stringContaining('View "alpha.broken" has an invalid when expression')
    ])
  })

  it('requires an icon for bar slots and resolves "./" icons through the plugin protocol', () => {
    const { views, diagnostics } = resolveViews([
      view('alpha.bare', { slot: 'shell.left' }),
      view('alpha.file', { slot: 'shell.left', icon: './icons/a.svg' }),
      view('alpha.named', { slot: 'shell.right', icon: 'calendar' }),
      view('alpha.unknown', { slot: 'shell.right', icon: 'no-such-glyph' }),
      { contributor: 'beta', impl: { id: 'beta.icon', title: 'B', slot: 'shell.main', module: './V', icon: './i.svg' } }
    ], resources)

    expect(views.map(v => [v.id, v.icon])).toEqual([
      ['alpha.file', 'tessera-plugin://alpha/icons/a.svg'],
      ['alpha.named', 'calendar']
    ])
    expect(diagnostics).toEqual([
      'View "alpha.bare" needs an icon: bar views are shown on the collapsed rail',
      'View "alpha.unknown" has an invalid icon "no-such-glyph": use "./file.svg" or a shell icon name',
      'View "beta.icon" ignored: "beta" has no renderer entry'
    ])
  })
})
