import { describe, expect, it } from 'vitest'
import { isIconName, resolveIcon } from '../../shared/layout/icons'
import { isRegisteredIconIn, resolveIcons } from '../../shared/layout/resolveIcons'

const iconUrlFor = (pluginId: string, relative: string) => pluginId === 'headless' ? undefined : `tessera-plugin://${pluginId}/${relative}`
const resolve = (...impls: unknown[]) => resolveIcons(impls.map(impl => ({ contributor: 'p', impl })), iconUrlFor)

describe('resolveIcons', () => {
  it('turns a valid contribution into an id and the URL of its file', () => {
    expect(resolve({ id: 'p.bank', file: './icons/bank.svg' })).toEqual({
      icons: [{ id: 'p.bank', url: 'tessera-plugin://p/icons/bank.svg', pluginId: 'p' }],
      diagnostics: []
    })
  })

  it('accepts an upper-case extension', () => {
    expect(resolve({ id: 'p.bank', file: './BANK.SVG' }).icons).toHaveLength(1)
  })

  it.each<[string, unknown, string]>([
    ['not an object', 'nope', 'not an object'],
    ['no id', { file: './a.svg' }, 'missing an id'],
    ['an id the plugin does not own', { id: 'other.a', file: './a.svg' }, 'must have an id prefixed by "p."'],
    ['a bare prefix as id', { id: 'p.', file: './a.svg' }, 'must have an id prefixed by "p."'],
    ['no file', { id: 'p.a' }, 'needs a file starting with "./"'],
    ['a file that is not relative to the renderer folder', { id: 'p.a', file: 'a.svg' }, 'needs a file starting with "./"'],
    ['a path that leaves the folder', { id: 'p.a', file: './../a.svg' }, 'must be a file inside the plugin\'s renderer folder'],
    ['a backslash path', { id: 'p.a', file: './a\\b.svg' }, 'must be a file inside the plugin\'s renderer folder'],
    ['a file that is not an svg', { id: 'p.a', file: './a.png' }, 'must be an .svg file'],
    ['an unknown field', { id: 'p.a', file: './a.svg', size: 20 }, 'unknown field "size"']
  ])('skips a contribution with %s', (_name, impl, message) => {
    const { icons, diagnostics } = resolve(impl)

    expect(icons).toEqual([])
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]).toContain(message)
  })

  it('skips an icon from a plugin with no renderer, because nothing could serve the file', () => {
    const { icons, diagnostics } = resolveIcons([{ contributor: 'headless', impl: { id: 'headless.a', file: './a.svg' } }], iconUrlFor)

    expect(icons).toEqual([])
    expect(diagnostics[0]).toContain('"headless" has no renderer entry')
  })

  it('keeps the first of two icons with the same id', () => {
    const { icons, diagnostics } = resolve({ id: 'p.a', file: './one.svg' }, { id: 'p.a', file: './two.svg' })

    expect(icons.map(i => i.url)).toEqual(['tessera-plugin://p/one.svg'])
    expect(diagnostics).toEqual(['Duplicate icon id "p.a" ignored'])
  })

  it('judges each contribution on its own', () => {
    const { icons, diagnostics } = resolve({ id: 'p.bad' }, { id: 'p.good', file: './g.svg' })

    expect(icons.map(i => i.id)).toEqual(['p.good'])
    expect(diagnostics).toHaveLength(1)
  })
})

describe('isRegisteredIconIn', () => {
  it('says which ids were registered, ignoring invalid contributions', () => {
    const registered = isRegisteredIconIn([
      { contributor: 'p', impl: { id: 'p.bank', file: './bank.svg' } },
      { contributor: 'p', impl: { id: 'p.bad' } }
    ], iconUrlFor)

    expect(registered('p.bank')).toBe(true)
    expect(registered('p.bad')).toBe(false)
    expect(registered('Save')).toBe(false)
  })
})

describe('resolveIcon with registered icons', () => {
  const registered = (id: string) => id === 'q.bank'

  it('passes a registered id through, whichever plugin registered it', () => {
    expect(resolveIcon('q.bank', 'p', iconUrlFor, registered)).toEqual({ icon: 'q.bank' })
  })

  it('rejects an id nobody registered, and rejects any when it cannot tell', () => {
    expect(resolveIcon('q.nope', 'p', iconUrlFor, registered)).toEqual({ problem: 'unknown icon "q.nope"' })
    expect(resolveIcon('q.bank', 'p', iconUrlFor)).toEqual({ problem: 'unknown icon "q.bank"' })
  })

  it('still prefers the standard set and files', () => {
    expect(resolveIcon('Save', 'p', iconUrlFor, () => false)).toEqual({ icon: 'Save' })
    expect(resolveIcon('./a.svg', 'p', iconUrlFor, () => false)).toEqual({ icon: 'tessera-plugin://p/a.svg' })
    expect(isIconName('q.bank')).toBe(false)
  })
})
