// @vitest-environment node
import { afterAll, describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createPluginRuntime } from '../../core/plugins/PluginContext'
import { PluginManager } from '../../core/plugins/PluginManager'
import { buildPlugins } from '../../scripts/build-plugins.mts'
import { defaultBootstrapConfig, toPluginSelection } from '../../shell/main/bootstrap/bootstrapConfig'
import { FsPluginSource } from '../../shell/main/plugins/FsPluginSource'
import { createLogger } from '../helpers/runtime'
import { createTempModulesDir } from '../helpers/tempModules'
import type { AppState } from '@tessera/types'

const repo = path.resolve(__dirname, '../..')
const plugins = path.join(repo, 'plugins')

// Built inside the repository, as the app's modules/ folder is, so a plugin's external packages (lokijs) resolve.
const scratch = fs.mkdtempSync(path.join(fs.mkdirSync(path.join(repo, 'node_modules/.cache'), { recursive: true }) ?? path.join(repo, 'node_modules/.cache'), 'tessera-smoke-'))
afterAll(() => { fs.rmSync(scratch, { recursive: true, force: true }) })

// The storage plugins and app-state are built as the application builds them (bundled, kit included) and
// activated through the real plugin manager, as the shell does.
describe('storage plugins through the real build and plugin pipeline', () => {
  const built = (async () => {
    const out = path.join(scratch, 'modules')
    const results = await buildPlugins({ pluginsDir: plugins, outDir: out, only: ['storage.loki', 'storage.sqlite', 'app.state'] })
    return { out, results }
  })()

  async function run(selection: ConstructorParameters<typeof PluginManager>[3], work: (env: { userData: string, appState: AppState, provider?: string }) => Promise<void>) {
    const { out } = await built
    const userData = createTempModulesDir()
    const log = createLogger()
    const runtime = createPluginRuntime(userData, log)
    const manager = new PluginManager(new FsPluginSource([{ dir: out, origin: 'bundled' }], log), runtime, log, selection)
    await manager.activateAll()
    await work({ userData, appState: runtime.services.get<AppState>('app.state'), provider: runtime.services.providerOf('storage.engine') })
    await manager.deactivateAll()
    return { log, userData }
  }

  it('builds all three, with the kit bundled and no reference to core or shared', async () => {
    const { out, results } = await built
    expect(results).toEqual([
      { id: 'app-state', ok: true }, { id: 'storage-loki', ok: true }, { id: 'storage-sqlite', ok: true }
    ])
    for (const id of ['storage-loki', 'storage-sqlite', 'app-state']) {
      const manifest = JSON.parse(fs.readFileSync(path.join(out, id, 'manifest.json'), 'utf8'))
      const code = fs.readFileSync(path.join(out, id, manifest.privileged.entry), 'utf8')
      expect(code).not.toMatch(/require\(["'](\.\.?\/|@tessera\/|@core|@shared)/)
    }
    expect(fs.readFileSync(path.join(out, 'storage-loki', 'privileged/index.js'), 'utf8')).toContain('KitStorageEngine')
  })

  it('activates one storage.engine provider, the first discovered, and skips the other with a warning', async () => {
    const { log, userData } = await run({}, async ({ appState, provider }) => {
      expect(provider).toBe('storage-loki')
      await appState.set('k', { v: 1 })
      expect(await appState.get('k')).toEqual({ v: 1 })
    })
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('"storage-sqlite"'))
    expect(fs.readdirSync(path.join(userData, 'storage'))).toEqual(['app.loki.json'])   // written on shutdown
    expect(fs.readFileSync(path.join(userData, 'storage', 'app.loki.json'), 'utf8')).toContain('"v":1')
  })

  it("uses SQLite by default: the shell's selection with no bootstrap file", async () => {
    const { log, userData } = await run(toPluginSelection(defaultBootstrapConfig()), async ({ appState, provider }) => {
      expect(provider).toBe('storage-sqlite')
      await appState.set('k', { v: 3 })
      expect(await appState.get('k')).toEqual({ v: 3 })
    })
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('"storage-loki"'))
    expect(fs.readdirSync(path.join(userData, 'storage'))).toContain('app.sqlite')
  })

  it('still uses LokiJS when the bootstrap file prefers it over the default', async () => {
    const selection = toPluginSelection({ ...defaultBootstrapConfig(), preferredPlugins: ['storage-loki'] })
    const { log } = await run(selection, async ({ provider }) => { expect(provider).toBe('storage-loki') })
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('"storage-sqlite"'))
  })

  it('uses SQLite when the bootstrap configuration prefers it', async () => {
    const { log, userData } = await run({ preferred: ['storage-sqlite'] }, async ({ appState, provider }) => {
      expect(provider).toBe('storage-sqlite')
      await appState.set('k', { v: 2 })
    })
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('"storage-loki"'))
    expect(fs.readdirSync(path.join(userData, 'storage'))).toEqual(['app.sqlite'])
  })

  it('keeps state across a restart on either backend', async () => {
    for (const preferred of [['storage-loki'], ['storage-sqlite']]) {
      const { out } = await built
      const userData = createTempModulesDir()
      for (const round of [1, 2]) {
        const log = createLogger()
        const runtime = createPluginRuntime(userData, log)
        const manager = new PluginManager(new FsPluginSource([{ dir: out, origin: 'bundled' }], log), runtime, log, { preferred })
        await manager.activateAll()
        const appState = runtime.services.get<AppState>('app.state')
        if (round === 1) await appState.set('window', { x: 1 })
        else expect(await appState.get('window')).toEqual({ x: 1 })
        await manager.deactivateAll()
      }
    }
  })
})
