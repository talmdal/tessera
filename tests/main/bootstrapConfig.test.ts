// @vitest-environment node
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  BOOTSTRAP_FILE, DEFAULT_PREFERRED_PLUGINS, bootstrapConfigPath, defaultBootstrapConfig, loadBootstrapConfig,
  saveBootstrapConfig, toPluginSelection
} from '../../shell/main/bootstrap/bootstrapConfig'
import { createLogger } from '../helpers/runtime'
import { createTempModulesDir } from '../helpers/tempModules'

const write = (dir: string, content: string) => fs.writeFileSync(bootstrapConfigPath(dir), content)

describe('bootstrap configuration (tier 0)', () => {
  it('is the defaults when the file does not exist, without a warning', () => {
    const log = createLogger()
    expect(loadBootstrapConfig(createTempModulesDir(), log)).toEqual({ disabledPlugins: [], preferredPlugins: [] })
    expect(log.warn).not.toHaveBeenCalled()
  })

  it('lives in the user data folder as tessera-bootstrap.json', () => {
    expect(bootstrapConfigPath('/data')).toBe(path.join('/data', BOOTSTRAP_FILE))
    expect(BOOTSTRAP_FILE).toBe('tessera-bootstrap.json')
  })

  it('reads the disabled and preferred plugin lists', () => {
    const dir = createTempModulesDir()
    write(dir, JSON.stringify({ disabledPlugins: ['a', 'b'], preferredPlugins: ['storage-sqlite'], other: 1 }))
    expect(loadBootstrapConfig(dir, createLogger())).toEqual({ disabledPlugins: ['a', 'b'], preferredPlugins: ['storage-sqlite'] })
  })

  it('drops duplicate ids', () => {
    const dir = createTempModulesDir()
    write(dir, JSON.stringify({ preferredPlugins: ['a', 'b', 'a'] }))
    expect(loadBootstrapConfig(dir, createLogger()).preferredPlugins).toEqual(['a', 'b'])
  })

  it('ignores a malformed file with a warning, so startup is never blocked', () => {
    for (const text of ['{ nope', '[]', '"text"', 'null']) {
      const dir = createTempModulesDir()
      const log = createLogger()
      write(dir, text)
      expect(loadBootstrapConfig(dir, log)).toEqual({ disabledPlugins: [], preferredPlugins: [] })
      expect(log.warn).toHaveBeenCalledOnce()
    }
  })

  it('ignores one bad field and keeps the other', () => {
    const dir = createTempModulesDir()
    const log = createLogger()
    write(dir, JSON.stringify({ disabledPlugins: 'storage-loki', preferredPlugins: ['storage-sqlite'] }))
    expect(loadBootstrapConfig(dir, log)).toEqual({ disabledPlugins: [], preferredPlugins: ['storage-sqlite'] })
    expect(log.warn).toHaveBeenCalledOnce()

    write(dir, JSON.stringify({ preferredPlugins: ['ok', 3] }))
    expect(loadBootstrapConfig(dir, createLogger()).preferredPlugins).toEqual([])
  })

  it('warns when the file cannot be read for a reason other than being absent', () => {
    const dir = createTempModulesDir()
    fs.mkdirSync(bootstrapConfigPath(dir))   // a folder where the file should be
    const log = createLogger()
    expect(loadBootstrapConfig(dir, log)).toEqual({ disabledPlugins: [], preferredPlugins: [] })
    expect(log.warn).toHaveBeenCalledOnce()
  })

  it('saves what it loads, leaving no temporary file', () => {
    const dir = path.join(createTempModulesDir(), 'new-user-data')
    saveBootstrapConfig(dir, { disabledPlugins: ['x'], preferredPlugins: ['storage-sqlite'] })
    expect(fs.readdirSync(dir)).toEqual([BOOTSTRAP_FILE])
    expect(loadBootstrapConfig(dir, createLogger())).toEqual({ disabledPlugins: ['x'], preferredPlugins: ['storage-sqlite'] })
  })

  it('hands the plugin manager its selection, with SQLite as the default storage engine after the user\'s choices', () => {
    expect(toPluginSelection({ disabledPlugins: ['x'], preferredPlugins: ['y'] }))
      .toEqual({ disabled: ['x'], preferred: ['y'], defaultPreferred: ['storage-sqlite'] })
    expect(toPluginSelection(defaultBootstrapConfig()).defaultPreferred).toEqual(DEFAULT_PREFERRED_PLUGINS)
    expect(DEFAULT_PREFERRED_PLUGINS).toEqual(['storage-sqlite'])
  })
})
