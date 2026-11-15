// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { OPTIONS_FILE, createJsonOptionsStore, optionsFilePath, quarantinePath } from '../../shell/main/options/JsonOptionsStore'
import { createLogger } from '../helpers/runtime'
import { createTempModulesDir } from '../helpers/tempModules'

const write = (dir: string, content: string) => fs.writeFileSync(optionsFilePath(dir), content)
const read = (dir: string) => JSON.parse(fs.readFileSync(optionsFilePath(dir), 'utf8'))

describe('the options file (tier 0)', () => {
  it('lives in the user data folder as tessera-options.json, beside the bootstrap file', () => {
    expect(optionsFilePath('/data')).toBe(path.join('/data', OPTIONS_FILE))
    expect(OPTIONS_FILE).toBe('tessera-options.json')
  })

  it('is an empty document when the file does not exist, without a warning', () => {
    const log = createLogger()
    expect(createJsonOptionsStore(createTempModulesDir(), log).read()).toEqual({})
    expect(log.warn).not.toHaveBeenCalled()
  })

  it('reads the entries as they are, including namespaces nothing has registered', () => {
    const dir = createTempModulesDir()
    const document = { book: { version: 2, values: { autoBackup: false } }, future: { version: 9, values: {} } }
    write(dir, JSON.stringify(document))

    expect(createJsonOptionsStore(dir, createLogger()).read()).toEqual(document)
  })

  it.each([
    ['invalid JSON', '{ nope'],
    ['an array', '[]'],
    ['a string', '"text"'],
    ['null', 'null']
  ])('ignores a file holding %s, keeps a copy and never blocks startup', (_label, text) => {
    const dir = createTempModulesDir()
    const log = createLogger()
    write(dir, text)

    expect(createJsonOptionsStore(dir, log).read()).toEqual({})
    expect(log.warn).toHaveBeenCalled()
    expect(fs.readFileSync(quarantinePath(dir), 'utf8')).toBe(text)
    expect(fs.existsSync(optionsFilePath(dir))).toBe(true)      // the original is left for the user
  })

  it('writes the document, and reads back what it wrote', async () => {
    const dir = createTempModulesDir()
    const store = createJsonOptionsStore(dir, createLogger(), { delayMs: 0 })

    store.write({ book: { version: 1, values: { autoBackup: false } } })
    await store.flush()

    expect(read(dir)).toEqual({ book: { version: 1, values: { autoBackup: false } } })
    expect(createJsonOptionsStore(dir, createLogger()).read()).toEqual({ book: { version: 1, values: { autoBackup: false } } })
  })

  it('creates the folder if it is not there yet', async () => {
    const dir = path.join(createTempModulesDir(), 'not-yet')
    const store = createJsonOptionsStore(dir, createLogger())

    store.write({ book: { version: 1, values: {} } })
    await store.flush()

    expect(read(dir)).toEqual({ book: { version: 1, values: {} } })
  })

  it('coalesces a burst of writes into one, keeping the last', async () => {
    const dir = createTempModulesDir()
    const store = createJsonOptionsStore(dir, createLogger(), { delayMs: 50 })

    store.write({ a: { version: 1, values: { n: 1 } } })
    store.write({ a: { version: 1, values: { n: 2 } } })
    store.write({ a: { version: 1, values: { n: 3 } } })
    expect(fs.existsSync(optionsFilePath(dir))).toBe(false)     // nothing written yet

    await store.flush()
    expect(read(dir)).toEqual({ a: { version: 1, values: { n: 3 } } })
  })

  it('flushes on demand, so the shutdown sequence loses nothing', async () => {
    const dir = createTempModulesDir()
    const store = createJsonOptionsStore(dir, createLogger(), { delayMs: 10_000 })

    store.write({ a: { version: 1, values: { saved: true } } })
    await store.flush()

    expect(read(dir)).toEqual({ a: { version: 1, values: { saved: true } } })
  })

  it('does nothing when flushed with nothing pending', async () => {
    const dir = createTempModulesDir()
    const store = createJsonOptionsStore(dir, createLogger())

    await store.flush()
    expect(fs.existsSync(optionsFilePath(dir))).toBe(false)
  })

  it('writes the file whole through a temporary file, leaving none behind', async () => {
    const dir = createTempModulesDir()
    const store = createJsonOptionsStore(dir, createLogger(), { delayMs: 0 })

    store.write({ a: { version: 1, values: { first: true } } })
    await store.flush()
    store.write({ a: { version: 1, values: { second: true } } })
    await store.flush()

    expect(read(dir)).toEqual({ a: { version: 1, values: { second: true } } })
    expect(fs.readdirSync(dir)).toEqual([OPTIONS_FILE])
  })

  it('is human readable, as the file a user may edit by hand', async () => {
    const dir = createTempModulesDir()
    const store = createJsonOptionsStore(dir, createLogger(), { delayMs: 0 })

    store.write({ book: { version: 1, values: { autoBackup: false } } })
    await store.flush()

    const text = fs.readFileSync(optionsFilePath(dir), 'utf8')
    expect(text).toContain('\n  "book"')
    expect(text.endsWith('\n')).toBe(true)
  })

  it('logs a failed write instead of throwing, so a commit and the shutdown both survive it', async () => {
    const dir = createTempModulesDir()
    const log = createLogger()
    const store = createJsonOptionsStore(dir, log, { delayMs: 0 })
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('disk full') })

    store.write({ a: { version: 1, values: {} } })
    await expect(store.flush()).resolves.toBeUndefined()

    expect(log.error).toHaveBeenCalled()
    expect(fs.readdirSync(dir)).toEqual([])                     // the temporary file is cleaned up
    rename.mockRestore()
  })

  it('logs an unreadable file rather than throwing', () => {
    const dir = createTempModulesDir()
    const log = createLogger()
    const readFile = vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
    })

    expect(createJsonOptionsStore(dir, log).read()).toEqual({})
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('permission denied'))
    readFile.mockRestore()
  })
})
