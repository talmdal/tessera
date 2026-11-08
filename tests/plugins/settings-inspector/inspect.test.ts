// @vitest-environment node
// The inspector against the real settings service and the real JSON files, in a temporary user-data folder: what it
// reports is what Tessera holds and what is on disk.
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { SETTINGS_FOLDER } from '@tessera/types'
import { SettingsService } from '../../../core/settings/SettingsService'
import { changedFromDefaults, inspectSettings, merged, same } from '../../../plugins/settings-inspector/src/privileged/inspect'
import { createJsonSettingsPersistence } from '../../../shell/main/settings/jsonSettingsPersistence'
import { createLogger } from '../../helpers/runtime'
import { createTempModulesDir } from '../../helpers/tempModules'

const LEDGER = { reopenLast: true, recentLimit: 10 }
const IMPORT = { matching: 'balanced', folders: { statements: 'Downloads' } }

async function setup() {
  const folder = path.join(createTempModulesDir(), SETTINGS_FOLDER)
  const settings = new SettingsService({ persistence: createJsonSettingsPersistence(folder, createLogger()) })
  await settings.load()
  const ledger = settings.register('ledger', { defaults: LEDGER })
  const imports = settings.register('import', { defaults: IMPORT })
  const inspect = () => inspectSettings(settings.snapshots(), folder, new Date('2026-11-08T10:00:00Z'))
  const write = (name: string, text: string) => { fs.mkdirSync(folder, { recursive: true }); fs.writeFileSync(path.join(folder, name), text) }
  const byId = async (id: string) => (await inspect()).namespaces.find(n => n.id === id)!
  return { folder, settings, ledger, imports, inspect, write, byId }
}

describe('the settings inspector: what it finds', () => {
  it('says nothing has been saved while every setting is at its default, and there is no folder yet', async () => {
    const { inspect, folder } = await setup()
    const report = await inspect()

    expect(report).toMatchObject({ folder, folderExists: false, others: [], at: '2026-11-08T10:00:00.000Z' })
    expect(report.namespaces.map(n => [n.id, n.check, n.changed])).toEqual([['import', 'defaults', []], ['ledger', 'defaults', []]])
    expect(report.namespaces[1].note).toContain('only differences are written')
  })

  it('finds a change in its file, agreeing with what is in effect, and names what changed', async () => {
    const { ledger, settings, byId } = await setup()
    await ledger.update({ reopenLast: false })
    await settings.flush()

    const report = await byId('ledger')

    expect(report).toMatchObject({ check: 'matches', changed: ['reopenLast'], value: { reopenLast: false, recentLimit: 10 }, defaults: LEDGER })
    expect(report.file).toMatchObject({ name: 'ledger.json', version: 1, values: { reopenLast: false } })
    expect(JSON.parse(report.file!.text)).toEqual({ version: 1, values: { reopenLast: false } })
    expect(report.file!.modified).toMatch(/^\d{4}-\d\d-\d\dT/)
  })

  it('merges nested settings key by key, as the framework documents', async () => {
    const { imports, settings, byId } = await setup()
    await imports.update({ folders: { statements: 'Bank' } })
    await settings.flush()

    expect(await byId('import')).toMatchObject({ check: 'matches', changed: ['folders.statements'] })
  })

  it('notices a file changed on disk since Tessera read it', async () => {
    const { ledger, settings, write, byId } = await setup()
    await ledger.update({ recentLimit: 5 })
    await settings.flush()
    write('ledger.json', JSON.stringify({ version: 1, values: { recentLimit: 7 } }))

    const report = await byId('ledger')
    expect(report.check).toBe('differs')
    expect(report.note).toContain('changed since Tessera read it')
  })

  it('notices settings that differ from their defaults with no file to show for it', async () => {
    const { ledger, settings, folder, byId } = await setup()
    await ledger.update({ recentLimit: 5 })
    await settings.flush()
    fs.rmSync(path.join(folder, 'ledger.json'))

    expect(await byId('ledger')).toMatchObject({ check: 'differs', note: expect.stringContaining('there is no file') })
  })

  it('reports a file that cannot be read, and what happens to it at the next start', async () => {
    const { write, byId } = await setup()
    write('ledger.json', '{ "version": 1, "values": ')
    expect(await byId('ledger')).toMatchObject({ check: 'unreadable', note: expect.stringContaining('set aside as ledger.json.bad') })

    write('ledger.json', JSON.stringify({ values: {} }))
    expect(await byId('ledger')).toMatchObject({ check: 'unreadable', note: expect.stringContaining('not in the expected form') })
  })

  it('lists files no namespace reads: a missing plugin\'s, and files set aside', async () => {
    const { write, inspect } = await setup()
    write('budget.json', JSON.stringify({ version: 1, values: { warnAt: 80 } }))
    write('ledger.json.bad', 'not json')
    write('notes.txt', 'ignored')

    expect((await inspect()).others.map(f => [f.name, f.problem === undefined])).toEqual([['budget.json', true], ['ledger.json.bad', false]])
  })
})

describe('the settings inspector: its own merge, a second witness', () => {
  it('merges objects key by key and replaces everything else whole', () => {
    expect(merged({ a: 1, o: { x: 1, y: 2 }, list: [1, 2] }, { o: { y: 3 }, list: [9], extra: true }))
      .toEqual({ a: 1, o: { x: 1, y: 3 }, list: [9], extra: true })
  })

  it('compares as JSON, and names what differs from the defaults', () => {
    expect(same({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true)
    expect(same({ a: 1 }, { a: 1, b: 2 })).toBe(false)
    expect(changedFromDefaults({ a: 1, o: { x: 1 }, l: [1] }, { a: 1, o: { x: 2 }, l: [1], n: 3 })).toEqual(['o.x', 'n'])
  })
})
