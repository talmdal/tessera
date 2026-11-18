// @vitest-environment node
// The `exchange.exportOptions` point: what a format plugin may add to the export dialog, what is refused, and
// what the service makes of the answers. The point is optional — a format that asks nothing is the normal case.
import { describe, expect, it, vi } from 'vitest'
import {
  EXPORT_OPTIONS_POINT, exportOptionDefaults, exportOptionValue, validateExportOptions,
  type ExportOptionField, type ExportOptionsContribution
} from '@tessera/exchange-api'
import { createPluginRuntime } from '../../../core/plugins/PluginContext'
import { ExportOptionsRegistry } from '../../../plugins/exchange/src/privileged/exportOptions'
import { logger } from '../book/harness'

const FIELDS: ExportOptionField[] = [
  {
    kind: 'choice', key: 'flavour', label: 'QIF flavour',
    options: [{ value: 'microsoft', label: 'Microsoft Money' }, { value: 'standard', label: 'Quicken' }],
    default: 'microsoft'
  },
  { kind: 'boolean', key: 'bom', label: 'Add a byte-order mark', default: true },
  { kind: 'text', key: 'org', label: 'Institution', default: 'Tessera', maxLength: 32 }
]

const contribution = (over: Partial<ExportOptionsContribution> = {}): ExportOptionsContribution => ({
  formatId: 'demo.one', fields: FIELDS, ...over
})

function registryWith(...contributions: [string, unknown][]) {
  const log = logger()
  const runtime = createPluginRuntime(undefined, log)
  for (const [contributor, impl] of contributions) {
    runtime.extensions.contribute(contributor, EXPORT_OPTIONS_POINT, `${contributor}:${Math.random()}`, impl)
  }
  return { registry: new ExportOptionsRegistry({ extensions: runtime.extensions, log }), log }
}

describe('validateExportOptions', () => {
  it('accepts a well-formed contribution', () => {
    expect(validateExportOptions(contribution(), 'demo')).toBeUndefined()
  })

  it('refuses options that name a format belonging to someone else', () => {
    expect(validateExportOptions(contribution({ formatId: 'other.one' }), 'demo'))
      .toMatch(/not theirs/)
  })

  it('refuses a choice whose default is not one of its options, which would show nothing chosen', () => {
    const bad = contribution({
      fields: [{ kind: 'choice', key: 'k', label: 'K', options: [{ value: 'a', label: 'A' }], default: 'b' }]
    })
    expect(validateExportOptions(bad, 'demo')).toMatch(/defaults to something that is not one of its options/)
  })

  it('refuses a default of the wrong type', () => {
    expect(validateExportOptions(contribution({
      fields: [{ kind: 'boolean', key: 'k', label: 'K', default: 'yes' as never }]
    }), 'demo')).toMatch(/true or false/)
  })

  it('refuses a dotted or otherwise awkward key', () => {
    for (const key of ['a.b', '1a', 'a-b', 'a b', '']) {
      expect(validateExportOptions(contribution({
        fields: [{ kind: 'boolean', key, label: 'K', default: true }]
      }), 'demo')).toBeDefined()
    }
  })

  it('refuses the same key twice, which would silently overwrite in formatOptions', () => {
    expect(validateExportOptions(contribution({
      fields: [
        { kind: 'boolean', key: 'same', label: 'A', default: true },
        { kind: 'boolean', key: 'same', label: 'B', default: false }
      ]
    }), 'demo')).toMatch(/twice/)
  })

  it('allows an option whose value is whitespace: a tab is a real CSV delimiter', () => {
    expect(validateExportOptions(contribution({
      fields: [{
        kind: 'choice', key: 'delimiter', label: 'Separator',
        options: [{ value: ',', label: 'Comma' }, { value: '\t', label: 'Tab' }],
        default: '\t'
      }]
    }), 'demo')).toBeUndefined()
  })

  it('still refuses an option with an empty value or a blank label', () => {
    const field = (options: { value: string, label: string }[]): ExportOptionField =>
      ({ kind: 'choice', key: 'k', label: 'K', options, default: options[0].value })
    expect(validateExportOptions(contribution({ fields: [field([{ value: '', label: 'Empty' }])] }), 'demo'))
      .toMatch(/needs a value/)
    expect(validateExportOptions(contribution({ fields: [field([{ value: 'a', label: '  ' }])] }), 'demo'))
      .toMatch(/needs a label/)
  })

  it('refuses an unknown field kind, rather than rendering nothing for it', () => {
    expect(validateExportOptions(contribution({
      fields: [{ kind: 'slider', key: 'k', label: 'K', default: 1 } as never]
    }), 'demo')).toMatch(/unknown kind/)
  })

  it('refuses a contribution with no fields at all: contribute nothing instead', () => {
    expect(validateExportOptions(contribution({ fields: [] }), 'demo')).toMatch(/no fields/)
  })
})

describe('the registry', () => {
  it('returns a format’s fields, and nothing for a format that asked for none', () => {
    const { registry } = registryWith(['demo', contribution()])
    expect(registry.fields('demo.one').map(f => f.key)).toEqual(['flavour', 'bom', 'org'])
    expect(registry.fields('demo.two')).toEqual([])
    expect(registry.fields('nobody.at.all')).toEqual([])
  })

  it('skips an invalid contribution and warns once, rather than failing every export', () => {
    const { registry, log } = registryWith(
      ['demo', contribution()],
      ['demo', { formatId: 'demo.broken', fields: 'nonsense' }]
    )
    expect(registry.fields('demo.one').map(f => f.key)).toEqual(['flavour', 'bom', 'org'])
    expect(registry.fields('demo.broken')).toEqual([])

    registry.fields('demo.broken')
    expect(log.warn.mock.calls.filter(call => String(call[0]).includes('demo.broken'))).toHaveLength(1)
  })

  it('refuses a second contribution claiming a key the first already took', () => {
    const { registry, log } = registryWith(
      ['demo', contribution({ fields: [{ kind: 'boolean', key: 'bom', label: 'First', default: true }] })],
      ['demo', contribution({ fields: [{ kind: 'boolean', key: 'bom', label: 'Second', default: false }] })]
    )
    expect(registry.fields('demo.one').map(f => f.label)).toEqual(['First'])
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('both use the key “bom”'))
  })

  it('gives the defaults for a caller that never opens a dialog', () => {
    const { registry } = registryWith(['demo', contribution()])
    expect(registry.defaults('demo.one')).toEqual({ flavour: 'microsoft', bom: true, org: 'Tessera' })
    expect(registry.defaults('demo.two')).toEqual({})
  })
})

describe('resolving what the dialog sent back', () => {
  const { registry } = registryWith(['demo', contribution()])

  it('keeps the answers a format asked for', () => {
    expect(registry.resolve('demo.one', { flavour: 'standard', bom: false, org: 'My Bank' }))
      .toEqual({ flavour: 'standard', bom: false, org: 'My Bank' })
  })

  it('drops keys the format never asked about, so a writer can trust what it is given', () => {
    expect(registry.resolve('demo.one', { flavour: 'standard', mystery: 'ignored' }))
      .toEqual({ flavour: 'standard', bom: true, org: 'Tessera' })
  })

  it('falls back to the default for a value of the wrong shape or an unknown choice', () => {
    expect(registry.resolve('demo.one', { flavour: 'nonsense', bom: 'yes', org: 42 }))
      .toEqual({ flavour: 'microsoft', bom: true, org: 'Tessera' })
  })

  it('returns the defaults when given nothing at all', () => {
    expect(registry.resolve('demo.one', undefined)).toEqual({ flavour: 'microsoft', bom: true, org: 'Tessera' })
    expect(registry.resolve('demo.one', 'not an object' as never))
      .toEqual({ flavour: 'microsoft', bom: true, org: 'Tessera' })
  })

  it('returns nothing for a format that asks nothing, whatever it is sent', () => {
    expect(registry.resolve('demo.two', { anything: 1 })).toEqual({})
  })
})

describe('the pure helpers', () => {
  it('exportOptionDefaults reads the defaults straight off the fields', () => {
    expect(exportOptionDefaults(FIELDS)).toEqual({ flavour: 'microsoft', bom: true, org: 'Tessera' })
    expect(exportOptionDefaults([])).toEqual({})
  })

  it('exportOptionValue takes a good value and refuses a bad one', () => {
    const [flavour, bom] = FIELDS
    expect(exportOptionValue(flavour, { flavour: 'standard' })).toBe('standard')
    expect(exportOptionValue(flavour, { flavour: 'nope' })).toBe('microsoft')
    expect(exportOptionValue(bom, { bom: false })).toBe(false)
    expect(exportOptionValue(bom, {})).toBe(true)
  })
})

describe('what the real format plugins ask for', () => {
  it('QIF asks for its flavour and nothing else', async () => {
    const { EXPORT_OPTIONS, QIF_FORMAT } = await import('../../../plugins/exchange.qif/src/privileged/index')
    expect(validateExportOptions(EXPORT_OPTIONS, 'exchange-qif')).toBeUndefined()
    expect(EXPORT_OPTIONS.formatId).toBe(QIF_FORMAT)
    expect(EXPORT_OPTIONS.fields.map(f => f.key)).toEqual(['flavour'])
  })

  it('CSV asks for the separator and the byte-order mark', async () => {
    const { EXPORT_OPTIONS, CSV_FORMAT } = await import('../../../plugins/exchange.csv/src/privileged/index')
    expect(validateExportOptions(EXPORT_OPTIONS, 'exchange-csv')).toBeUndefined()
    expect(EXPORT_OPTIONS.formatId).toBe(CSV_FORMAT)
    expect(EXPORT_OPTIONS.fields.map(f => f.key)).toEqual(['delimiter', 'bom'])
  })

  it('OFX asks for nothing, because the one choice it had was the version', async () => {
    const ofx = await import('../../../plugins/exchange.ofx/src/privileged/index')
    expect('EXPORT_OPTIONS' in ofx).toBe(false)
  })
})
