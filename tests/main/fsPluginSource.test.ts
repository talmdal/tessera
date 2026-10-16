import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { PluginManager } from '../../core/plugins/PluginManager'
import { FsPluginSource } from '../../shell/main/plugins/FsPluginSource'
import { writeFakePlugin } from '../helpers/fakePlugin'
import { createLogger, createRuntime } from '../helpers/runtime'
import { createTempModulesDir } from '../helpers/tempModules'

describe('FsPluginSource', () => {
  it('discovers plugin folders with a manifest across roots, ignoring missing roots', async () => {
    const root = createTempModulesDir()
    writeFakePlugin(root, 'alpha')
    fs.mkdirSync(path.join(root, 'no-manifest'))
    fs.writeFileSync(path.join(root, 'stray-file.txt'), '')

    const log = createLogger()
    const descriptors = await new FsPluginSource([root, path.join(root, 'missing')], log).discover()

    expect(descriptors).toEqual([{ location: path.join(root, 'alpha'), manifest: expect.objectContaining({ id: 'alpha' }) }])
    expect(log.warn).not.toHaveBeenCalled()
  })

  it('warns about and skips invalid manifest JSON', async () => {
    const root = createTempModulesDir()
    fs.mkdirSync(path.join(root, 'broken'))
    fs.writeFileSync(path.join(root, 'broken', 'manifest.json'), '{ nope')

    const log = createLogger()
    expect(await new FsPluginSource([root], log).discover()).toEqual([])
    expect(log.warn).toHaveBeenCalledOnce()
  })

  it('refuses entries that resolve outside the plugin directory', async () => {
    const source = new FsPluginSource([], createLogger())

    await expect(source.load({ location: createTempModulesDir(), manifest: {} }, '../evil.js'))
      .rejects.toThrow('outside the plugin directory')
  })

  it('loads a CommonJS plugin end to end, even when the folder name differs from the id', async () => {
    const root = createTempModulesDir()
    writeFakePlugin(root, 'test-plugin', 'test-plugin-1.2.3')
    const runtime = createRuntime()

    const active = await new PluginManager(new FsPluginSource([root], createLogger()), runtime, createLogger()).activateAll()

    expect(active.map(m => m.id)).toEqual(['test-plugin'])
    await expect(runtime.ipc.dispatch({ channel: 'test-plugin:ping' })).resolves.toMatchObject({ ok: true, data: 'pong' })
  })
})
