// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import type { AppState } from '@tessera/types'
import { createPluginRuntime } from '../../core/plugins/PluginContext'
import { PluginManager } from '../../core/plugins/PluginManager'
import { FsPluginSource } from '../../shell/main/plugins/FsPluginSource'
import { BOOTSTRAP_FILE, readBootstrapConfig } from '../../shell/main/bootstrap/bootstrapConfig'
import { buildPlugins } from '../../scripts/build-plugins.mts'
import { removeDir, tempDir } from '../helpers/tempDir'

describe('storage plugins through the real pipeline', () => {
  const dirs: string[] = []
  afterEach(() => { for (const dir of dirs.splice(0)) removeDir(dir) })

  it('builds, discovers and activates; one storage.engine provider wins, the other is skipped', async () => {
    // Inside the repo, so the built bundles resolve the external lokijs from
    // the repo's node_modules, as they do when loaded from modules/ in the app.
    const modules = fs.mkdtempSync(path.resolve(__dirname, '../../tessera-modules-'))
    const userData = tempDir('tessera-userdata')
    dirs.push(modules, userData)

    const results = await buildPlugins({
      pluginsDir: path.resolve(__dirname, '../../plugins'),
      outDir: modules,
      only: ['storage-loki', 'storage-sqlite', 'app-state']
    })
    expect(results.map(r => r.ok)).toEqual([true, true, true])

    const launch = async (bootstrap: Record<string, unknown>) => {
      fs.writeFileSync(path.join(userData, BOOTSTRAP_FILE), JSON.stringify(bootstrap))
      const warnings: string[] = []
      const log = { info() {}, warn: (m: string) => warnings.push(m), error: (m: string, e?: unknown) => { throw new Error(`${m}: ${e}`) } }
      const runtime = createPluginRuntime(userData, log)
      const config = readBootstrapConfig(path.join(userData, BOOTSTRAP_FILE), log)
      const manager = new PluginManager(new FsPluginSource([{ dir: modules, origin: 'bundled' }], log), runtime, log, config)
      await manager.activateAll()
      const state = runtime.services.get<AppState>('app.state')
      return { warnings, runtime, state, quit: async () => { await runtime.lifecycle.requestShutdown('user'); await manager.deactivateAll() } }
    }

    // Without a preference, discovery order decides and the other backend is skipped with a warning.
    let run = await launch({})
    const byDiscovery = run.runtime.services.providerOf('storage.engine')
    expect(['storage-loki', 'storage-sqlite']).toContain(byDiscovery)
    expect(run.warnings.join('\n')).toContain(`Skipping "${byDiscovery === 'storage-loki' ? 'storage-sqlite' : 'storage-loki'}"`)
    await run.quit()

    // The bootstrap file picks the backend: a preference changes which plugin wins.
    run = await launch({ preferredPlugins: ['storage-sqlite'] })
    expect(run.runtime.services.providerOf('storage.engine')).toBe('storage-sqlite')
    await run.state.set('theme', 'dark')
    await run.quit()
    expect(fs.existsSync(path.join(userData, 'storage', 'app.sqlite'))).toBe(true)

    // Disabling is the other primitive, and is logged without a warning.
    run = await launch({ disabledPlugins: ['storage-sqlite'] })
    expect(run.runtime.services.providerOf('storage.engine')).toBe('storage-loki')
    expect(run.warnings).toEqual([])
    await run.quit()
  }, 60_000)
})
