// @vitest-environment node
// The three extension points as plugins use them: contributions in any order; malformed ones refused with one
// `[reports]` warning each, the rest unaffected; a definition whose source's plugin isn't running offered as
// unavailable, saying which plugin it needs; contributions withdrawn; and another plugin's source and definition run
// like the shipped ones. See docs/reporting-design.md, "Adding a report from another plugin".
import { describe, expect, it, vi } from 'vitest'
import {
  REPORT_DEFINITIONS_POINT, REPORT_GROUPS_POINT, REPORT_SOURCES_POINT,
  type ReportDefinitionContribution, type ReportSource, type ReportSourceContribution
} from '@tessera/reports-api'
import { FALLBACK_GROUP } from '../../../plugins/reports/src/privileged/registry'
import { setupReports, table, type ReportsEnv } from './harness'

/** Another plugin's source: its own figures, by a member dimension of its own. */
const SOURCE: ReportSourceContribution = {
  id: 'garden.harvest', label: 'Harvest', service: 'garden.harvestSource', time: 'range', scopes: 'none', currency: false,
  fields: [
    { kind: 'dimension', key: 'month', label: 'Month', type: 'time' },
    { kind: 'dimension', key: 'crop', label: 'Crop', type: 'member', plural: 'crops' },
    { kind: 'measure', key: 'kilos', label: 'Kilos', unit: 'count', combine: 'sum' }
  ]
}

const DEFINITION: ReportDefinitionContribution = {
  id: 'garden.harvestByCrop', label: 'Harvest by Crop', description: 'What the garden gave.', group: 'garden.group', version: 1, order: 5,
  spec: {
    specVersion: 1, source: 'garden.harvest', parameters: { period: { preset: 'thisYear' } },
    query: { rows: { dimension: 'crop', sort: 'valueDesc' }, measures: [{ measure: 'kilos' }] },
    presentation: { show: 'both', table: { totals: { row: true } }, chart: { kind: 'bar', measure: 0 } }
  }
}

const SERVICE: ReportSource = {
  query: vi.fn(async () => ({
    rows: [{ keys: ['beans'], values: [12] }, { keys: ['kale'], values: [30] }],
    members: { crop: [{ id: 'beans', label: 'Beans' }, { id: 'kale', label: 'Kale' }] }, notes: []
  })),
  members: async () => []
}

function garden(env: ReportsEnv, parts: { source?: unknown, definition?: unknown, group?: boolean, service?: unknown } = {}) {
  const out = []
  if (parts.service !== null) out.push(env.services.provide('garden', SOURCE.service, parts.service ?? SERVICE))
  if (parts.source !== null) out.push(env.extensions.contribute('garden', REPORT_SOURCES_POINT, 'garden.harvest', parts.source ?? SOURCE))
  if (parts.group !== false) out.push(env.extensions.contribute('garden', REPORT_GROUPS_POINT, 'garden.group', { id: 'garden.group', label: 'Garden', order: 50 }))
  if (parts.definition !== null) out.push(env.extensions.contribute('garden', REPORT_DEFINITIONS_POINT, 'garden.harvestByCrop', parts.definition ?? DEFINITION))
  return out
}

const warnings = (env: ReportsEnv) => env.log.warn.mock.calls.map((c: unknown[]) => String(c[0]))

describe('the report registry', () => {
  it('offers another plugin\'s source and definition, contributed in any order, and runs them', async () => {
    const env = await setupReports()
    env.extensions.contribute('garden', REPORT_DEFINITIONS_POINT, 'garden.harvestByCrop', DEFINITION)
    env.extensions.contribute('garden', REPORT_GROUPS_POINT, 'garden.group', { id: 'garden.group', label: 'Garden', order: 50 })
    env.extensions.contribute('garden', REPORT_SOURCES_POINT, 'garden.harvest', SOURCE)
    env.services.provide('garden', SOURCE.service, SERVICE)
    expect(env.reports.definitions().at(-1)).toEqual({
      id: 'garden.harvestByCrop', label: 'Harvest by Crop', description: 'What the garden gave.', order: 5,
      group: { id: 'garden.group', label: 'Garden', order: 50 }, contributor: 'garden', available: true
    })
    const result = await env.reports.run({ definitionId: 'garden.harvestByCrop' })
    expect(table(result)).toEqual([['Kale', '30'], ['Beans', '12'], ['Total', '42']])
    // A source with its own scope and currency: neither is asked, nor in the heading
    const asked = (SERVICE.query as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0]
    expect(['scope' in asked, 'currency' in asked]).toEqual([false, false])
    expect(result.subtitle).toBe('2027')
    expect(result.currency).toBeNull()
    expect(warnings(env)).toEqual([])
  })

  it('lists a definition whose source\'s plugin isn\'t running as unavailable, naming the plugin it needs', async () => {
    const env = await setupReports()
    garden(env, { service: null })
    expect(env.reports.definitions().find(d => d.id === DEFINITION.id)).toMatchObject({ available: false, reason: 'It needs the “garden” plugin, which isn’t running.' })
    await expect(env.reports.run({ definitionId: DEFINITION.id })).rejects.toMatchObject({ code: 'NO_SOURCE' })
    const alone = await setupReports()
    garden(alone, { service: null, source: null })
    expect(alone.reports.definitions().find(d => d.id === DEFINITION.id)).toMatchObject({ available: false, reason: 'It needs the “garden” plugin, which isn’t running.' })
  })

  it('refuses malformed contributions with one warning each, and offers the rest', async () => {
    const env = await setupReports()
    garden(env, { definition: { ...DEFINITION, spec: { ...DEFINITION.spec, query: { ...DEFINITION.spec.query, rows: { dimension: 'soil' } } } } })
    env.extensions.contribute('garden', REPORT_DEFINITIONS_POINT, 'weeds', { ...DEFINITION, id: 'weeds.byCrop' })
    env.extensions.contribute('garden', REPORT_SOURCES_POINT, 'garden.bad', { ...SOURCE, id: 'garden.bad', time: 'weekly' })
    env.extensions.contribute('garden', REPORT_GROUPS_POINT, 'garden.nameless', { id: 'garden.nameless' })
    for (let i = 0; i < 3; i++) env.reports.definitions()
    expect(warnings(env).sort()).toEqual([
      '[reports] A report definition contributed by "garden" needs an id starting with "garden."',
      '[reports] Report "garden.harvestByCrop": spec.query.rows.dimension: “soil” is not a dimension of source “garden.harvest”.',
      '[reports] Report group "garden.nameless" needs a label',
      '[reports] Report source "garden.bad" needs time: range, months or asOf'
    ])
    expect(env.reports.definitions().map(d => d.id)).not.toContain('garden.harvestByCrop')
    expect(env.reports.definitions()).toHaveLength(7)
  })

  it('refuses a definition one of whose options makes an invalid spec', async () => {
    const env = await setupReports()
    garden(env, { definition: { ...DEFINITION, options: [{ key: 'deep', label: 'Deep', kind: 'boolean', default: false, patch: { query: { rows: { depth: 2 } } } }] } })
    expect(env.reports.definitions().map(d => d.id)).not.toContain('garden.harvestByCrop')
    expect(warnings(env)).toEqual(['[reports] Report "garden.harvestByCrop": options[0]=true.query.rows.depth: “crop” isn’t a tree, so it has no depth.'])
  })

  it('lists a definition whose group isn\'t contributed under Other Reports, and ignores a duplicate id', async () => {
    const env = await setupReports()
    garden(env, { group: false })
    env.extensions.contribute('garden', REPORT_DEFINITIONS_POINT, 'garden.harvestByCrop.again', { ...DEFINITION, label: 'Again' })
    const offered = env.reports.definitions().filter(d => d.contributor === 'garden')
    expect(offered.map(d => [d.label, d.group.label])).toEqual([['Harvest by Crop', FALLBACK_GROUP.label]])
    expect(warnings(env)).toEqual(['[reports] Duplicate report definition "garden.harvestByCrop" ignored'])
  })

  it('follows contributions as they come and go, announcing the catalog changed', async () => {
    const env = await setupReports()
    const disposables = garden(env)
    expect(env.changes.some(c => c.catalog)).toBe(true)
    expect(env.reports.definitions().map(d => d.id)).toContain(DEFINITION.id)
    env.changes.length = 0
    for (const d of disposables) d.dispose()
    expect(env.reports.definitions().map(d => d.id)).not.toContain(DEFINITION.id)
    expect(env.changes.filter(c => c.catalog).length).toBeGreaterThan(0)
    await expect(env.reports.run({ definitionId: DEFINITION.id })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('follows a source\'s own changes: reports on it are stale', async () => {
    const env = await setupReports()
    let fire: () => void = () => {}
    garden(env, { service: { ...SERVICE, onDidChange: (listener: () => void) => { fire = listener; return { dispose: () => {} } } } })
    env.changes.length = 0
    fire()
    expect(env.changes).toEqual([{ catalog: false, figures: true, sources: ['garden.harvest'] }])
  })

  it('checks a source\'s reply: rows of the right width, integers, members for every key', async () => {
    const env = await setupReports()
    const reply = (r: unknown): ReportSource => ({ query: async () => r as never, members: async () => [] })
    const runWith = async (r: unknown) => {
      const e = await setupReports()
      garden(e, { service: reply(r) })
      return e.reports.run({ definitionId: DEFINITION.id }).catch(err => err as { code: string, message: string })
    }
    const members = { crop: [{ id: 'kale', label: 'Kale' }] }
    expect(await runWith({ rows: [{ keys: ['kale', 'x'], values: [1] }], members, notes: [] })).toMatchObject({ code: 'SOURCE_FAILED', message: 'The figures from “Harvest” couldn’t be used: a row has the wrong number of keys.' })
    expect(await runWith({ rows: [{ keys: ['kale'], values: [1.5] }], members, notes: [] })).toMatchObject({ code: 'SOURCE_FAILED', message: 'The figures from “Harvest” couldn’t be used: a row’s figures aren’t whole numbers.' })
    expect(await runWith({ rows: [{ keys: ['beans'], values: [1] }], members, notes: [] })).toMatchObject({ code: 'SOURCE_FAILED', message: 'The figures from “Harvest” couldn’t be used: “beans” isn’t a known crop.' })
    expect(await runWith(undefined)).toMatchObject({ code: 'SOURCE_FAILED' })
    const failing: ReportSource = { query: async () => { throw new Error('the shed is locked') }, members: async () => [] }
    garden(env, { service: failing })
    await expect(env.reports.run({ definitionId: DEFINITION.id })).rejects.toMatchObject({ code: 'SOURCE_FAILED', message: 'The figures from “Harvest” couldn’t be worked out: the shed is locked' })
    expect(env.log.error).toHaveBeenCalled()
  })

  it('gives a source its time limit: a run that passes it is TIMEOUT', async () => {
    const env = await setupReports({ timeoutMs: 30 })
    garden(env, { service: { query: () => new Promise(() => {}), members: async () => [] } })
    await expect(env.reports.run({ definitionId: DEFINITION.id })).rejects.toMatchObject({ code: 'TIMEOUT', message: 'The report took too long: “Harvest” didn’t answer within 1 second.' })
  })
})
