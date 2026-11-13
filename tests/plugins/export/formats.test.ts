// The export.formats extension point (docs/export-design.md, "The contract"): contributions are checked, with one
// warning each for those that can't be used, ordered, and listed only when their service is there.
import { describe, expect, it, vi } from 'vitest'
import { EXPORT_FORMATS_POINT, type ExportFormatContribution } from '@tessera/export-api'
import { Formats } from '../../../plugins/export/src/privileged/formats'

const service = { check: () => ({ transactions: 0, problems: [], warnings: [] }), write: () => ({ bytes: new Uint8Array(), warnings: [] }) }
const good = (over: Partial<ExportFormatContribution> = {}): ExportFormatContribution =>
  ({ id: 'fmt.csv', label: 'CSV', extension: 'csv', service: 'fmt.export', accounts: 'many', ...over })

function formats(contributions: { contributor?: string, impl: unknown }[], services: Record<string, unknown> = { 'fmt.export': service }) {
  const log = { warn: vi.fn() }
  const registry = { getContributions: vi.fn((point: string) => point === EXPORT_FORMATS_POINT ? contributions.map(c => ({ contributor: c.contributor ?? 'fmt', impl: c.impl })) : []) }
  const registryServices = { has: (id: string) => id in services, get: <T>(id: string) => services[id] as T }
  return { formats: new Formats(registry as never, registryServices as never, log), log }
}

describe('export formats', () => {
  it('lists valid formats by order then label, with their options for the dialog', () => {
    const { formats } = formats_([
      good({ id: 'fmt.qif', label: 'QIF', extension: 'qif', order: 20 }),
      good({ options: [{ kind: 'boolean', key: 'guard', label: 'Guard', default: true }], order: 10, description: 'Spreadsheets' }),
      good({ id: 'fmt.ofx', label: 'OFX', extension: 'ofx', accounts: 'one', accountTypes: ['chequing', 'creditCard'], order: 20 })
    ])
    expect(formats.all().map(f => f.id)).toEqual(['fmt.csv', 'fmt.ofx', 'fmt.qif'])
    expect(formats.info()[0]).toEqual({
      id: 'fmt.csv', label: 'CSV', extension: 'csv', accounts: 'many', description: 'Spreadsheets',
      options: [{ kind: 'boolean', key: 'guard', label: 'Guard', default: true }], accountFields: []
    })
    expect(formats.info()[1]).toMatchObject({ accounts: 'one', accountTypes: ['chequing', 'creditCard'], options: [] })
    expect(formats.get('fmt.ofx')?.label).toBe('OFX')
    expect(formats.service(formats.get('fmt.csv')!)).toBe(service)
  })

  it('skips what can’t be used, with one warning each', () => {
    const bad: [unknown, string][] = [
      [good({ id: 'other.csv' }), 'needs an id starting with "fmt."'],
      [good({ label: '' }), 'needs a label'],
      [good({ extension: '.CSV' }), 'needs an extension in lower case'],
      [good({ accounts: 'all' as never }), 'needs accounts: "one" or "many"'],
      [good({ accountTypes: ['chequing', 'boat' as never] }), 'has invalid account types'],
      [good({ options: [{ kind: 'choice', key: 'x', label: 'X', default: 'z', options: [{ value: 'a', label: 'A' }] }] }), 'a default that isn\'t one of its choices'],
      [good({ options: [{ kind: 'boolean', key: 'x', label: 'X', default: 'yes' as never }] }), 'needs a true or false default'],
      [good({ options: [{ kind: 'text', key: '1x', label: 'X', default: '' }] }), 'needs a key of letters and digits'],
      [good({ options: [{ kind: 'boolean', key: 'x', label: 'X', default: true }, { kind: 'boolean', key: 'x', label: 'Y', default: true }] }), 'two options with the same key'],
      [good({ options: [{ kind: 'slider', key: 'x', label: 'X', default: 1 } as never] }), 'has an unknown kind'],
      [good({ accountFields: [{ field: 'sortCode' as never, need: 'required' }] }), 'has invalid account fields'],
      [good({ accountFields: [{ field: 'bankId', need: 'maybe' as never }] }), 'has invalid account fields']
    ]
    for (const [impl, problem] of bad) {
      const { formats, log } = formats_([impl])
      expect(formats.all(), problem).toEqual([])
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining(problem))
    }
    // The same one twice: the first counts
    const { formats: twice, log } = formats_([good(), good({ label: 'Again' })])
    expect(twice.all().map(f => f.label)).toEqual(['CSV'])
    expect(log.warn).toHaveBeenCalledWith('[export] Duplicate export format "fmt.csv" ignored')
  })

  it('leaves out a format whose service isn’t there, or isn’t one', () => {
    expect(formats([{ impl: good() }], {}).formats.all()).toEqual([])
    expect(formats([{ impl: good() }], { 'fmt.export': { check: () => undefined } }).formats.all()).toEqual([])
  })
})

/** `formats` with these contributions, all from the plugin "fmt". */
const formats_ = (impls: unknown[]) => formats(impls.map(impl => ({ impl })))
