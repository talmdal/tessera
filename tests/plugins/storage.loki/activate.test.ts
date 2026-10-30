// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import type { StorageEngine } from '@tessera/types'
import { createPluginContext } from '../../../core/plugins/PluginContext'
import { createPluginRuntime } from '../../../core/plugins/PluginContext'
import { activate, deactivate } from '../../../plugins/storage.loki/src/privileged/index'
import { createLogger } from '../../helpers/runtime'
import { removeDir, tempDir } from '../../helpers/tempDir'

describe('storage-loki: privileged half', () => {
  const dirs: string[] = []
  afterEach(async () => {
    await deactivate()
    for (const dir of dirs.splice(0)) removeDir(dir)
  })

  it('provides storage.engine with its databases under <userData>/storage, and closes them on deactivate', async () => {
    const userData = tempDir('tessera-userdata')
    dirs.push(userData)
    const log = createLogger()
    const runtime = createPluginRuntime(userData, log)
    const scope = createPluginContext('storage-loki', runtime)

    await activate(scope.context)
    expect(runtime.services.providerOf('storage.engine')).toBe('storage-loki')

    const engine = runtime.services.get<StorageEngine>('storage.engine')
    const db = await engine.open({ name: 'app' })
    await db.collection('c').insert({ id: '1' })
    expect(log.info).toHaveBeenCalledWith(`[storage-loki] Opened database "app" at ${path.join(userData, 'storage', 'app.loki.json')}`)

    await deactivate()
    expect(db.isOpen).toBe(false)
    expect(fs.existsSync(path.join(userData, 'storage', 'app.loki.json'))).toBe(true)
    expect(log.error).not.toHaveBeenCalled()

    scope.dispose()
    expect(runtime.services.has('storage.engine')).toBe(false)
  })
})
