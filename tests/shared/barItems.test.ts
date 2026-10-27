import { describe, it, expect } from 'vitest'
import { resolveBarItems } from '../../shared/layout/resolveBarItems'

const resources = {
  assetUrlFor: (id: string, rel: string) => id === 'alpha' ? `tessera-plugin://${id}/${rel}` : undefined,
  isCommandEnabled: (command: string) => command === 'alpha.enabled'
}

const button = (id: string, extra: Record<string, unknown> = {}) =>
  ({ contributor: 'alpha', impl: { kind: 'button', id, slot: 'shell.top', label: id, command: 'alpha.enabled', ...extra } })

describe('resolveBarItems', () => {
  it('orders items by slot, alignment, order, then registration', () => {
    const { items, diagnostics } = resolveBarItems([
      button('alpha.end', { align: 'end' }),
      button('alpha.b', { order: 2 }),
      button('alpha.a', { order: 1 }),
      button('alpha.bottom', { slot: 'shell.bottom' })
    ], resources)

    expect(diagnostics).toEqual([])
    expect(items.map(i => i.id)).toEqual(['alpha.bottom', 'alpha.a', 'alpha.b', 'alpha.end'])
  })

  it('computes the enabled flag from the command, and marks plain text enabled', () => {
    const { items } = resolveBarItems([
      button('alpha.on'),
      button('alpha.off', { command: 'alpha.disabled' }),
      { contributor: 'alpha', impl: { kind: 'text', id: 'alpha.text', slot: 'shell.bottom', text: 'hi' } },
      { contributor: 'alpha', impl: { kind: 'text', id: 'alpha.link', slot: 'shell.bottom', text: 'hi', command: 'alpha.disabled' } }
    ], resources)

    expect(items.map(i => [i.id, i.enabled])).toEqual([
      [ 'alpha.text', true ],
      [ 'alpha.link', false ],
      [ 'alpha.on', true ],
      [ 'alpha.off', false ]
    ])
    expect(items.every(i => i.pluginId === 'alpha')).toBe(true)
  })

  it('resolves "./" icons through the plugin protocol and keeps set names', () => {
    const { items, diagnostics } = resolveBarItems([
      button('alpha.file', { icon: './icons/save.svg' }),
      button('alpha.named', { icon: 'save' }),
      { contributor: 'beta', impl: { kind: 'button', id: 'beta.file', slot: 'shell.top', label: 'B', command: 'c', icon: './i.svg' } }
    ], resources)

    expect(items.map(i => [i.id, i.icon])).toEqual([
      ['alpha.file', 'tessera-plugin://alpha/icons/save.svg'],
      ['alpha.named', 'save']
    ])
    expect(diagnostics).toEqual(['Bar item "beta.file" has icon "./i.svg", which cannot be served from "beta"'])
  })

  it('skips invalid shapes, duplicate ids, main-slot items and bad when expressions', () => {
    const { items, diagnostics } = resolveBarItems([
      button('alpha.ok', { when: 'vault.isOpen' }),
      button('alpha.ok'),
      button('alpha.main', { slot: 'shell.main' }),
      button('alpha.badWhen', { when: '&&' }),
      { contributor: 'alpha', impl: { kind: 'button', id: 'alpha.noLabel', slot: 'shell.top', command: 'c' } },
      { contributor: 'alpha', impl: { kind: 'text', id: 'alpha.noText', slot: 'shell.top' } },
      { contributor: 'alpha', impl: { kind: 'widget', id: 'alpha.widget', slot: 'shell.top' } },
      { contributor: 'alpha', impl: { kind: 'button', id: 'alpha.badAlign', slot: 'shell.top', label: 'x', command: 'c', align: 'middle' } },
      { contributor: 'alpha', impl: null }
    ], resources)

    expect(items.map(i => i.id)).toEqual(['alpha.ok'])
    expect(items[0].when).toBe('vault.isOpen')
    expect(diagnostics).toEqual([
      'Duplicate bar item id "alpha.ok" ignored',
      'Bar item "alpha.main" targets "shell.main"; items go in bar slots only',
      expect.stringContaining('Bar item "alpha.badWhen" has an invalid when expression'),
      'Bar item "alpha.noLabel" is missing a label',
      'Bar item "alpha.noText" is missing its text',
      'Bar item "alpha.widget" has unknown kind "widget"',
      'Bar item "alpha.badAlign" has an invalid align',
      'Bar item contribution is not an object'
    ])
  })
})
