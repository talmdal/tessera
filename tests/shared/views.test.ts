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

  it('skips views from contributors without a renderer, duplicates and invalid shapes', () => {
    const { views, diagnostics } = resolveViews([
      { contributor: 'beta', impl: { id: 'beta.x', title: 'X', slot: 's', module: './X' } },
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
