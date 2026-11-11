// @vitest-environment node
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { SettingsService } from '../../core/settings/SettingsService'
import { createJsonSettingsPersistence } from '../../shell/main/settings/jsonSettingsPersistence'
import { createLogger } from '../helpers/runtime'
import { createTempModulesDir } from '../helpers/tempModules'

function setup() {
  const dir = path.join(createTempModulesDir(), 'settings')
  const log = createLogger()
  const persistence = createJsonSettingsPersistence(dir, log)
  const file = (id: string) => path.join(dir, `${id}.json`)
  const write = (name: string, text: string) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, name), text) }
  return { dir, log, persistence, file, write }
}

describe('settings files', () => {
  it('reads nothing, without a warning, before anything was saved', async () => {
    const { persistence, log } = setup()
    expect(await persistence.loadAll()).toEqual({})
    expect(log.warn).not.toHaveBeenCalled()
  })

  it('keeps one readable JSON file per namespace, and deletes it when everything is at its default', async () => {
    const { persistence, file, dir } = setup()
    await persistence.save('ledger', { version: 1, values: { recentLimit: 4 } })
    await persistence.save('ledger.display', { version: 2, values: { compact: true } })

    expect(fs.readFileSync(file('ledger'), 'utf8')).toBe('{\n  "version": 1,\n  "values": {\n    "recentLimit": 4\n  }\n}\n')
    expect(await persistence.loadAll()).toEqual({
      ledger: { version: 1, values: { recentLimit: 4 } },
      'ledger.display': { version: 2, values: { compact: true } }
    })

    await persistence.save('ledger', undefined)
    await persistence.save('never-saved', undefined)
    expect(fs.readdirSync(dir)).toEqual(['ledger.display.json'])
  })

  it('replaces a file whole, leaving no temporary file behind', async () => {
    const { persistence, dir } = setup()
    await persistence.save('ledger', { version: 1, values: { recentLimit: 4 } })
    await persistence.save('ledger', { version: 1, values: { recentLimit: 5 } })
    expect(fs.readdirSync(dir)).toEqual(['ledger.json'])
    expect(await persistence.loadAll()).toEqual({ ledger: { version: 1, values: { recentLimit: 5 } } })
  })

  it('sets aside a file that is not JSON, so the user can still repair it, and reads the rest', async () => {
    const { persistence, write, dir, log } = setup()
    write('ledger.json', '{ "version": 1, "values": ')
    write('accounts.json', '{ "version": 1, "values": {} }')

    expect(await persistence.loadAll()).toEqual({ accounts: { version: 1, values: {} } })
    expect(fs.readdirSync(dir).sort()).toEqual(['accounts.json', 'ledger.json.bad'])
    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/ledger\.json is not valid JSON \(.*\); it was renamed to ledger\.json\.bad and its defaults are used$/))
  })

  it('ignores files that are not settings: set-aside files, leftovers and other names', async () => {
    const { persistence, write } = setup()
    write('ledger.json.bad', 'x')
    write('ledger.json.tmp', '{}')
    write('README.md', '# notes')
    write('Not An Id.json', '{}')
    expect(await persistence.loadAll()).toEqual({})
  })

  it('refuses ids that are not settings ids, so nothing is written outside the folder', async () => {
    const { persistence } = setup()
    await expect(persistence.save('../escape', { version: 1, values: {} })).rejects.toThrow('Invalid settings id "../escape"')
  })

  it('carries settings from one run to the next, through the settings service', async () => {
    const { dir, log } = setup()
    const first = new SettingsService({ persistence: createJsonSettingsPersistence(dir, log) })
    await first.load()
    await first.register('ledger', { defaults: { reopenLast: true, recentLimit: 10 } }).update({ reopenLast: false })
    await first.flush()

    const second = new SettingsService({ persistence: createJsonSettingsPersistence(dir, log) })
    await second.load()
    expect(second.register('ledger', { defaults: { reopenLast: true, recentLimit: 12 } }).get())
      .toEqual({ reopenLast: false, recentLimit: 12 })
  })

  it('starts a namespace whose file is broken at its defaults, and saves over it once the user changes it', async () => {
    const { dir, log, write, file } = setup()
    write('ledger.json', 'not json')
    const settings = new SettingsService({ persistence: createJsonSettingsPersistence(dir, log), log })
    await settings.load()
    const handle = settings.register('ledger', { defaults: { reopenLast: true } })
    expect(handle.get()).toEqual({ reopenLast: true })

    await handle.update({ reopenLast: false })
    expect(JSON.parse(fs.readFileSync(file('ledger'), 'utf8'))).toEqual({ version: 1, values: { reopenLast: false } })
    expect(fs.existsSync(`${file('ledger')}.bad`)).toBe(true)
  })
})
