// @vitest-environment node
// The `exchange.formats` extension point: which contributions are usable, and which format reads a given file.
import { describe, expect, it, vi } from 'vitest'
import { FORMATS_POINT, validateFormat, type ExchangeFormat, type ExchangeFormatContribution } from '@tessera/exchange-api'
import { ExtensionRegistryImpl } from '../../../core/extensions/ExtensionRegistry'
import { ServiceRegistryImpl } from '../../../core/services/ServiceRegistry'
import { FormatRegistry } from '../../../plugins/exchange/src/privileged/formats'
import { rejection, spyLogger } from './harness'

const bytes = (text: string) => new TextEncoder().encode(text)

function setup() {
  const extensions = new ExtensionRegistryImpl()
  const services = new ServiceRegistryImpl()
  const log = spyLogger()
  const registry = new FormatRegistry({ extensions, services, log })

  const install = (contribution: ExchangeFormatContribution, format: Partial<ExchangeFormat> = {}) => {
    const contributor = contribution.id.split('.')[0]
    if (!services.has(contribution.service)) {
      services.provide(contributor, contribution.service, { sniff: () => 0, read: async () => ({}), ...format })
    }
    extensions.contribute(contributor, FORMATS_POINT, contribution.id, contribution)
  }

  const contribution = (over: Partial<ExchangeFormatContribution> & { id: string }): ExchangeFormatContribution => ({
    label: 'A format', extensions: ['x'], service: `${over.id.split('.')[0]}.format`,
    capabilities: { read: true }, ...over
  })

  return { extensions, services, log, registry, install, contribution }
}

describe('validating a contribution', () => {
  const ok: ExchangeFormatContribution = {
    id: 'mine.qif', label: 'QIF', extensions: ['qif'], service: 'mine.format', capabilities: { read: true }
  }

  it('accepts a complete one', () => {
    expect(validateFormat(ok, 'mine')).toBeUndefined()
  })

  it('insists the id is namespaced to the contributor', () => {
    expect(validateFormat({ ...ok, id: 'qif' }, 'mine')).toMatch(/needs an id starting with/)
    expect(validateFormat({ ...ok, id: 'theirs.qif' }, 'mine')).toMatch(/needs an id starting with/)
  })

  it('names what is missing', () => {
    expect(validateFormat({ ...ok, label: '' }, 'mine')).toMatch(/needs a label/)
    expect(validateFormat({ ...ok, service: '' }, 'mine')).toMatch(/needs the service/)
    expect(validateFormat({ ...ok, extensions: [] }, 'mine')).toMatch(/at least one file extension/)
    expect(validateFormat({ ...ok, capabilities: {} }, 'mine')).toMatch(/can neither read nor write/)
  })

  it('rejects an extension written with its dot, which would never match', () => {
    expect(validateFormat({ ...ok, extensions: ['.qif'] }, 'mine')).toMatch(/write “qif”, not “.qif”/)
  })

  it('rejects anything that is not a contribution at all', () => {
    expect(validateFormat(null, 'mine')).toMatch(/not an object/)
    expect(validateFormat({ ...ok, order: 'soon' }, 'mine')).toMatch(/invalid order/)
  })
})

describe('collecting the installed formats', () => {
  it('fills in the defaults and sorts by order', () => {
    const { registry, install, contribution } = setup()
    install(contribution({ id: 'b.two', extensions: ['two'], order: 1 }))
    install(contribution({ id: 'a.one', extensions: ['one'], order: 0 }))

    const all = registry.all()
    expect(all.map(f => f.id)).toEqual(['a.one', 'b.two'])
    expect(all[0].capabilities).toEqual({ read: true, write: false, multiAccount: false, transactionIds: false })
    expect(all[0].contributor).toBe('a')
  })

  it('skips an invalid contribution and warns once, not on every read', () => {
    const { registry, extensions, log } = setup()
    extensions.contribute('bad', FORMATS_POINT, 'bad.one', { id: 'bad.one' })

    expect(registry.all()).toEqual([])
    registry.all()
    registry.all()
    expect(log.warn).toHaveBeenCalledTimes(1)
    expect(log.warn.mock.calls[0][0]).toMatch(/^\[exchange\] /)
  })

  it('drops a format whose service nothing provides, rather than failing later at read time', () => {
    const { registry, extensions, log } = setup()
    extensions.contribute('ghost', FORMATS_POINT, 'ghost.one', {
      id: 'ghost.one', label: 'Ghost', extensions: ['g'], service: 'ghost.format', capabilities: { read: true }
    })
    expect(registry.all()).toEqual([])
    expect(log.warn.mock.calls[0][0]).toMatch(/which nothing provides/)
  })

  it('keeps the first of two formats sharing an id', () => {
    const { registry, install, contribution, log } = setup()
    install(contribution({ id: 'a.one', label: 'First' }))
    install(contribution({ id: 'a.one', label: 'Second' }))
    expect(registry.all()).toHaveLength(1)
    expect(registry.all()[0].label).toBe('First')
    expect(log.warn.mock.calls.some(([m]) => /Duplicate format/.test(m))).toBe(true)
  })

  it('separates what can be read from what can be written', () => {
    const { registry, install, contribution } = setup()
    install(contribution({ id: 'a.read', extensions: ['r'], capabilities: { read: true } }))
    install(contribution({ id: 'b.write', extensions: ['w'], capabilities: { write: true } }))

    expect(registry.readable().map(f => f.id)).toEqual(['a.read'])
    expect(registry.writable().map(f => f.id)).toEqual(['b.write'])
  })
})

describe('choosing the format for a file', () => {
  it('uses the extension when exactly one format claims it, whatever the content looks like', () => {
    const { registry, install, contribution } = setup()
    install(contribution({ id: 'a.qif', extensions: ['qif'] }), { sniff: () => 0 })
    expect(registry.choose('statement.qif', bytes('nonsense')).id).toBe('a.qif')
  })

  it('asks the content when the extension is unknown', () => {
    const { registry, install, contribution } = setup()
    install(contribution({ id: 'a.ofx', extensions: ['ofx'] }), { sniff: head => new TextDecoder().decode(head).startsWith('OFXHEADER') ? 1 : 0 })
    install(contribution({ id: 'b.csv', extensions: ['csv'] }), { sniff: () => 0.2 })

    expect(registry.choose('download.txt', bytes('OFXHEADER:100')).id).toBe('a.ofx')
    expect(registry.choose('download.txt', bytes('a,b,c')).id).toBe('b.csv')
  })

  it('asks the content when several formats claim the extension', () => {
    const { registry, install, contribution } = setup()
    install(contribution({ id: 'a.one', extensions: ['dat'] }), { sniff: () => 0.3 })
    install(contribution({ id: 'b.two', extensions: ['dat'] }), { sniff: () => 0.9 })
    expect(registry.choose('x.dat', bytes('anything')).id).toBe('b.two')
  })

  it('refuses to guess between two equally confident formats, and names them', () => {
    const { registry, install, contribution } = setup()
    install(contribution({ id: 'a.one', label: 'One', extensions: ['one'] }), { sniff: () => 0.5 })
    install(contribution({ id: 'b.two', label: 'Two', extensions: ['two'] }), { sniff: () => 0.5 })

    expect(() => registry.choose('x.unknown', bytes('?'))).toThrow(/could be One and Two/)
  })

  it('says what it tried when nothing recognises the file', () => {
    const { registry, install, contribution } = setup()
    install(contribution({ id: 'a.one', label: 'Only one', extensions: ['one'] }), { sniff: () => 0 })
    expect(() => registry.choose('x.unknown', bytes('?'))).toThrow(/It tried: Only one/)
  })

  it('honours the format the user chose, and refuses one that is not installed', () => {
    const { registry, install, contribution } = setup()
    install(contribution({ id: 'a.one', extensions: ['one'] }), { sniff: () => 1 })
    install(contribution({ id: 'b.two', extensions: ['two'] }), { sniff: () => 1 })

    expect(registry.choose('x.one', bytes('?'), 'b.two').id).toBe('b.two')
    expect(() => registry.choose('x.one', bytes('?'), 'c.nope')).toThrow(/not installed/)
  })

  it('treats a format that throws while sniffing as having declined, and warns', () => {
    const { registry, install, contribution, log } = setup()
    install(contribution({ id: 'a.bad', extensions: ['bad'] }), { sniff: () => { throw new Error('boom') } })
    install(contribution({ id: 'b.good', extensions: ['good'] }), { sniff: () => 0.5 })

    expect(registry.choose('x.unknown', bytes('?')).id).toBe('b.good')
    expect(log.warn.mock.calls.some(([m]) => /failed to sniff/.test(m))).toBe(true)
  })

  it('says there is nothing to import when no format is installed', () => {
    const { registry } = setup()
    expect(() => registry.choose('x.qif', bytes('?'))).toThrow(/No file formats are installed/)
  })
})

describe('the service a descriptor names', () => {
  it('hands back the implementation', () => {
    const { registry, install, contribution } = setup()
    const sniff = vi.fn(() => 1)
    install(contribution({ id: 'a.one', extensions: ['one'] }), { sniff })
    registry.implementation(registry.all()[0]).sniff(bytes('x'), 'x.one', 'a.one')
    expect(sniff).toHaveBeenCalled()
  })

  it('leaves a write-only format out of the choices, so it is never asked to read', () => {
    const { registry, install, contribution } = setup()
    install(contribution({ id: 'a.out', extensions: ['out'], capabilities: { write: true } }))
    expect(registry.readable()).toEqual([])
    expect(() => registry.choose('x.out', bytes('?'))).toThrow(/No file formats are installed/)
  })
})
