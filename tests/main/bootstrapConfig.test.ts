import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { parseBootstrapConfig, readBootstrapConfig } from '../../shell/main/bootstrap/bootstrapConfig'
import { createLogger } from '../helpers/runtime'
import { removeDir, tempDir } from '../helpers/tempDir'

describe('readBootstrapConfig', () => {
  const dirs: string[] = []
  afterEach(() => { for (const dir of dirs.splice(0)) removeDir(dir) })

  const fileWith = (text: string) => {
    const dir = tempDir('tessera-bootstrap')
    dirs.push(dir)
    const file = path.join(dir, 'tessera-bootstrap.json')
    fs.writeFileSync(file, text)
    return file
  }

  it('reads the two keys', () => {
    const log = createLogger()
    const config = readBootstrapConfig(fileWith('{ "disabledPlugins": ["a"], "preferredPlugins": ["storage-sqlite"] }'), log)
    expect(config).toEqual({ disabledPlugins: ['a'], preferredPlugins: ['storage-sqlite'] })
    expect(log.warn).not.toHaveBeenCalled()
  })

  it('is silent and empty when the file does not exist', () => {
    const log = createLogger()
    expect(readBootstrapConfig('/nowhere/tessera-bootstrap.json', log)).toEqual({ disabledPlugins: [], preferredPlugins: [] })
    expect(log.warn).not.toHaveBeenCalled()
  })

  it('never prevents startup: invalid JSON is logged and ignored', () => {
    const log = createLogger()
    expect(readBootstrapConfig(fileWith('{ not json'), log)).toEqual({ disabledPlugins: [], preferredPlugins: [] })
    expect(log.warn.mock.calls[0][0]).toContain('not valid JSON')
  })

  it('falls back per key on the wrong shape, and mentions unknown keys', () => {
    const log = createLogger()
    const config = readBootstrapConfig(fileWith('{ "disabledPlugins": "a", "preferredPlugins": ["ok"], "storage": {} }'), log)
    expect(config).toEqual({ disabledPlugins: [], preferredPlugins: ['ok'] })
    const problems = log.warn.mock.calls.map(c => c[0] as string)
    expect(problems.some(p => p.includes('"disabledPlugins" must be an array'))).toBe(true)
    expect(problems.some(p => p.includes('unknown key "storage"'))).toBe(true)
  })
})

describe('parseBootstrapConfig', () => {
  it('treats non-objects as defaults', () => {
    for (const raw of [null, 3, 'x', [1]]) {
      expect(parseBootstrapConfig(raw)).toEqual({ disabledPlugins: [], preferredPlugins: [] })
    }
  })
})
