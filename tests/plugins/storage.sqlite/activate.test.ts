// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import type { StorageEngine } from '@tessera/types'
import { createPluginContext, createPluginRuntime } from '../../../core/plugins/PluginContext'
import { activate, deactivate } from '../../../plugins/storage.sqlite/src/privileged/index'
import { createLogger } from '../../helpers/runtime'
import { removeDir, tempDir } from '../../helpers/tempDir'

describe('storage-sqlite: privileged half', () => {
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
    const scope = createPluginContext('storage-sqlite', runtime)

    await activate(scope.context)
    expect(runtime.services.providerOf('storage.engine')).toBe('storage-sqlite')

    const engine = runtime.services.get<StorageEngine>('storage.engine')
    const db = await engine.open({ name: 'app' })
    await db.collection('c').insert({ id: '1' })
    expect(log.info).toHaveBeenCalledWith(`[storage-sqlite] Opened database "app" at ${path.join(userData, 'storage', 'app.sqlite')}`)

    await deactivate()
    expect(db.isOpen).toBe(false)
    expect(fs.existsSync(path.join(userData, 'storage', 'app.sqlite'))).toBe(true)
    expect(log.error).not.toHaveBeenCalled()

    scope.dispose()
    expect(runtime.services.has('storage.engine')).toBe(false)
  })
})
