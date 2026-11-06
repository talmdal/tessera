// @vitest-environment node
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { PluginManager } from '../../core/plugins/PluginManager'
import { buildPlugins, federationVersionProblem } from '../../scripts/build-plugins.mts'
import { FsPluginSource } from '../../shell/main/plugins/FsPluginSource'
import { writeFakePlugin } from '../helpers/fakePlugin'
import { createLogger, createRuntime } from '../helpers/runtime'
import { createTempModulesDir } from '../helpers/tempModules'

const fixtures = path.resolve(__dirname, '../fixtures/plugins')

const activate = async (roots: ConstructorParameters<typeof FsPluginSource>[0]) => {
  const runtime = createRuntime()
  const log = createLogger()
  const manager = new PluginManager(new FsPluginSource(roots, log), runtime, log)
  await manager.activateAll()
  return { runtime, log, manager }
}

/** Copies the fixture to a temp plugins dir, lets `change` edit it and its manifest, then builds it. */
async function buildModified(change: (plugin: string, manifest: any) => void) {
  const src = createTempModulesDir()
  const plugin = path.join(src, 'p')
  fs.cpSync(path.join(fixtures, 'sample-builtin'), plugin, { recursive: true })
  const manifest = JSON.parse(fs.readFileSync(path.join(plugin, 'manifest.json'), 'utf8'))
  change(plugin, manifest)
  fs.writeFileSync(path.join(plugin, 'manifest.json'), JSON.stringify(manifest))
  const out = createTempModulesDir()
  const [result] = await buildPlugins({ pluginsDir: src, outDir: out })
  return { result, out }
}

// Builds run esbuild and Vite: seconds each, and longer while other test files build in parallel
describe('building bundled plugins', { timeout: 60_000 }, () => {
  it('builds source into the module layout, with dependencies bundled', async () => {
    const out = createTempModulesDir()

    const results = await buildPlugins({ pluginsDir: fixtures, outDir: out })

    expect(results).toEqual([{ id: 'sample-builtin', ok: true }])
    const built = path.join(out, 'sample-builtin')
    expect(fs.readdirSync(built).sort()).toEqual(['manifest.json', 'package.json', 'privileged', 'renderer'])
    expect(JSON.parse(fs.readFileSync(path.join(built, 'package.json'), 'utf8'))).toEqual({ type: 'cjs' })

    const code = fs.readFileSync(path.join(built, 'privileged/index.js'), 'utf8')
    expect(code).toContain('Hello from')           // ./greeting was bundled in
    expect(code).not.toContain('./greeting')
  })

  it('compiles exposed TSX into a federation remote, and drops build-time keys from the manifest', async () => {
    const out = createTempModulesDir()
    await buildPlugins({ pluginsDir: fixtures, outDir: out })
    const built = path.join(out, 'sample-builtin')

    const entry = fs.readFileSync(path.join(built, 'renderer/remoteEntry.js'), 'utf8')
    expect(entry).toMatch(/export \{[^}]*\bget\b[^}]*\}/)
    expect(entry).toMatch(/export \{[^}]*\binit\b[^}]*\}/)
    const assets = fs.readdirSync(path.join(built, 'renderer/assets'))
    expect(assets.some(f => f.startsWith('HelloView-'))).toBe(true)
    expect(assets.some(f => f.startsWith('_tessera-stub-entry'))).toBe(false)
    // The shell provides React; plugins carry no fallback copy
    expect(assets.some(f => /react(-dom)?\.production|react\.development/.test(f))).toBe(false)

    expect(JSON.parse(fs.readFileSync(path.join(built, 'manifest.json'), 'utf8')).renderer)
      .toEqual({ entry: 'renderer/remoteEntry.js' })
  })

  it('bundles values from the plugin API packages into both halves, so plugins can share contracts', async () => {
    const { result, out } = await buildModified(plugin => {
      fs.writeFileSync(path.join(plugin, 'src/privileged/index.ts'), `
        import type { PluginContext } from '@tessera/types'
        import { LEDGER_SESSION_SERVICE } from '@tessera/ledger-api'
        import { IMPORT_FORMATS_POINT, canonicalDecimal } from '@tessera/import-api'
        export function activate(context: PluginContext) {
          context.ipc.register('sample-builtin:hello', async () => LEDGER_SESSION_SERVICE)
          context.ipc.register('sample-builtin:format', async () => [IMPORT_FORMATS_POINT, canonicalDecimal('1,234.50')])
        }
      `)
      fs.writeFileSync(path.join(plugin, 'src/renderer/HelloView.tsx'), `
        import { ACCOUNTS_CHANNELS } from '@tessera/accounts-api'
        export default function HelloView() { return <p>{ACCOUNTS_CHANNELS.chart}</p> }
      `)
    })

    expect(result).toEqual({ id: 'sample-builtin', ok: true })
    const privileged = fs.readFileSync(path.join(out, 'sample-builtin', 'privileged/index.js'), 'utf8')
    expect(privileged).toContain('ledger.session')
    expect(privileged).toContain('import.formats')
    expect(privileged).not.toMatch(/require\(["']@tessera\//)
    const assets = path.join(out, 'sample-builtin', 'renderer/assets')
    const view = fs.readdirSync(assets).find(f => f.startsWith('HelloView-'))!
    const code = fs.readFileSync(path.join(assets, view), 'utf8')
    // The constant is built with channelFor from @tessera/types, which is bundled along with it
    expect(code).toMatch(/["']chart["']/)
    expect(code).not.toMatch(/from\s*["']@tessera\/(accounts|ledger)-api["']/)
  })

  it('copies a hand-written renderer/ folder as-is when the manifest has no renderer.expose', async () => {
    const { result, out } = await buildModified((plugin, manifest) => {
      fs.rmSync(path.join(plugin, 'src/renderer'), { recursive: true })
      delete manifest.renderer.expose
      fs.mkdirSync(path.join(plugin, 'renderer'))
      fs.writeFileSync(path.join(plugin, 'renderer/remoteEntry.js'), 'export const handWritten = true')
    })

    expect(result).toEqual({ id: 'sample-builtin', ok: true })
    expect(fs.readFileSync(path.join(out, 'sample-builtin/renderer/remoteEntry.js'), 'utf8')).toBe('export const handWritten = true')
  })

  it('produces a plugin the app loads, even from a folder with no package.json (a user install)', async () => {
    const out = createTempModulesDir()
    await buildPlugins({ pluginsDir: fixtures, outDir: out })

    const { runtime, manager } = await activate([{ dir: out, origin: 'bundled' }])

    expect(manager.get('sample-builtin')).toMatchObject({ origin: 'bundled' })
    await expect(runtime.ipc.dispatch({ channel: 'sample-builtin:hello' }))
      .resolves.toMatchObject({ ok: true, data: 'Hello from a built-in plugin' })
    expect(runtime.extensions.getContributions('shell.views')).toMatchObject([{ id: 'sample-builtin.hello' }])
  })

  it('removes stale files from a previous build, and builds only the requested plugins', async () => {
    const out = createTempModulesDir()
    fs.mkdirSync(path.join(out, 'sample-builtin'))
    fs.writeFileSync(path.join(out, 'sample-builtin/stale.js'), '')

    expect(await buildPlugins({ pluginsDir: fixtures, outDir: out, only: ['other'] })).toEqual([])
    expect(fs.existsSync(path.join(out, 'sample-builtin/stale.js'))).toBe(true)

    await buildPlugins({ pluginsDir: fixtures, outDir: out, only: ['sample-builtin'] })
    expect(fs.existsSync(path.join(out, 'sample-builtin/stale.js'))).toBe(false)
  })

  it('reports a plugin that fails to build and still builds the others', async () => {
    const src = createTempModulesDir()
    fs.cpSync(path.join(fixtures, 'sample-builtin'), path.join(src, 'good'), { recursive: true })
    fs.mkdirSync(path.join(src, 'broken'))
    fs.writeFileSync(path.join(src, 'broken/manifest.json'),
      JSON.stringify({ id: 'broken', name: 'Broken', version: '1', privileged: { entry: 'privileged/index.js' } }))
    const out = createTempModulesDir()

    const results = await buildPlugins({ pluginsDir: src, outDir: out })

    expect(results.map(r => [r.id, r.ok])).toEqual([['broken', false], ['sample-builtin', true]])
    expect(results[0].error).toContain('no privileged source found')
    expect(fs.existsSync(path.join(out, 'sample-builtin/manifest.json'))).toBe(true)
  })

  it('returns nothing when the plugins directory does not exist', async () => {
    expect(await buildPlugins({ pluginsDir: path.join(createTempModulesDir(), 'nope'), outDir: createTempModulesDir() })).toEqual([])
  })

  describe('renderer configuration errors', () => {
    it('fails when an exposed source file does not exist', async () => {
      const { result } = await buildModified(plugin => fs.rmSync(path.join(plugin, 'src/renderer'), { recursive: true }))

      expect(result).toMatchObject({ ok: false, error: expect.stringContaining('source file "src/renderer/HelloView.tsx" not found') })
    })

    it('fails when renderer/ would be overwritten by the build', async () => {
      const { result } = await buildModified(plugin => fs.mkdirSync(path.join(plugin, 'renderer')))

      expect(result).toMatchObject({ ok: false, error: expect.stringContaining('exists alongside renderer.expose') })
    })

    it('fails on malformed expose maps', async () => {
      expect((await buildModified((_, m) => { m.renderer.expose = { HelloView: 'src/renderer/HelloView.tsx' } })).result)
        .toMatchObject({ ok: false, error: expect.stringContaining('must start with "./"') })
      expect((await buildModified((_, m) => { m.renderer.expose = {} })).result)
        .toMatchObject({ ok: false, error: expect.stringContaining('must map module names') })
      expect((await buildModified((_, m) => { delete m.renderer.entry })).result)
        .toMatchObject({ ok: false, error: expect.stringContaining('renderer.expose needs renderer.entry') })
    })

    it('fails when a static renderer entry is not in the copied folder', async () => {
      const { result } = await buildModified((plugin, manifest) => {
        fs.rmSync(path.join(plugin, 'src/renderer'), { recursive: true })
        delete manifest.renderer.expose
      })

      expect(result).toMatchObject({ ok: false, error: expect.stringContaining('was not produced') })
    })
  })

  // Versions before 1.16.0 lose their virtual modules from the third federated build in a process on.
  it('names an installed federation plugin too old to build several remotes, and asks for npm install', () => {
    expect(federationVersionProblem('1.15.5')).toMatch(/1\.15\.5 is installed; 1\.16\.0 or later .*npm install/)
    expect(federationVersionProblem('1.14.2')).toBeDefined()
    expect(federationVersionProblem('0.99.0')).toBeDefined()
    for (const ok of ['1.16.0', '1.23.0', '1.100.0', '2.0.0', '1.16.0-beta.1']) expect(federationVersionProblem(ok)).toBeUndefined()
    expect(federationVersionProblem('not-a-version')).toBeUndefined()
  })

  it('accepts the installed federation plugin', () => {
    const { version } = JSON.parse(fs.readFileSync(path.resolve('node_modules/@module-federation/vite/package.json'), 'utf8'))
    expect(federationVersionProblem(version)).toBeUndefined()
  })
})

describe('bundled and user plugin roots', { timeout: 60_000 }, () => {
  it('tags plugins with their origin and activates both', async () => {
    const bundled = createTempModulesDir()
    const user = createTempModulesDir()
    await buildPlugins({ pluginsDir: fixtures, outDir: bundled })
    writeFakePlugin(user, 'user-plugin')

    const { manager } = await activate([{ dir: bundled, origin: 'bundled' }, { dir: user, origin: 'user' }])

    expect(manager.get('sample-builtin')?.origin).toBe('bundled')
    expect(manager.get('user-plugin')?.origin).toBe('user')
  })

  it('lets the bundled plugin win when a user plugin has the same id', async () => {
    const bundled = createTempModulesDir()
    const user = createTempModulesDir()
    await buildPlugins({ pluginsDir: fixtures, outDir: bundled })
    writeFakePlugin(user, 'sample-builtin')

    const { runtime, log, manager } = await activate([{ dir: bundled, origin: 'bundled' }, { dir: user, origin: 'user' }])

    expect(manager.get('sample-builtin')?.origin).toBe('bundled')
    expect(runtime.ipc.has('sample-builtin:hello')).toBe(true)
    expect(runtime.ipc.has('sample-builtin:ping')).toBe(false)
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining(`plugin "sample-builtin" is already provided by ${path.join(bundled, 'sample-builtin')}`))
  })
})
