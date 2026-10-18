// Builds bundled plugins from plugins/<id>/ into modules/<id>/, the layout the
// app (and an installed user plugin) loads:
//
//   plugins/<id>/manifest.json            copied; its entries name the built paths
//   plugins/<id>/src/privileged/index.ts  bundled to modules/<id>/<privileged.entry>
//   plugins/<id>/src/renderer/*.tsx       compiled with Module Federation into the
//                                         folder of <renderer.entry>, for every module
//                                         listed in manifest renderer.expose
//   plugins/<id>/renderer/**              (no renderer.expose) copied as-is
//
// Usage: ts-node --transpile-only scripts/build-plugins.ts [--src <dir>] [--out <dir>] [<plugin-id>...]
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

export interface BuildOptions {
  /** Directory containing one folder per plugin. */
  pluginsDir: string
  /** Directory the built plugins are written to. */
  outDir: string
  /** Build only these plugin ids. */
  only?: string[]
  log?: (message: string) => void
}

export interface BuildResult {
  id: string
  ok: boolean
  error?: string
}

const SOURCE_CANDIDATES = ['src/privileged/index.ts', 'src/privileged/index.js', 'src/privileged/index.mjs']

// The shell provides these to plugin remotes as singletons (shell/renderer/views/federationViewLoader.ts).
// Plugins use the shell's copies and bundle no fallbacks. The range must match the shell's React.
const SHARED_REACT_RANGE = '^18.2.0'
const SHARED_MODULES = ['react', 'react/jsx-runtime', 'react-dom']

export async function buildPlugins({ pluginsDir, outDir, only, log = () => {} }: BuildOptions): Promise<BuildResult[]> {
  if (!fs.existsSync(pluginsDir)) return []

  const folders = fs.readdirSync(pluginsDir, { withFileTypes: true })
    .filter(d => d.isDirectory() && fs.existsSync(path.join(pluginsDir, d.name, 'manifest.json')))
    .map(d => d.name)
    .filter(name => !only?.length || only.includes(name))

  const results: BuildResult[] = []
  for (const folder of folders) {
    try {
      const id = await buildPlugin(path.join(pluginsDir, folder), outDir)
      log(`built ${id}`)
      results.push({ id, ok: true })
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      log(`FAILED ${folder}: ${error}`)
      results.push({ id: folder, ok: false, error })
    }
  }
  return results
}

async function buildPlugin(srcDir: string, outDir: string): Promise<string> {
  const manifestPath = path.join(srcDir, 'manifest.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  const id: unknown = manifest.id
  const entry: unknown = manifest.privileged?.entry
  if (typeof id !== 'string' || typeof entry !== 'string') throw new Error('manifest.json needs "id" and "privileged.entry"')

  const source = SOURCE_CANDIDATES.map(c => path.join(srcDir, c)).find(fs.existsSync)
  if (!source) throw new Error(`no privileged source found (looked for ${SOURCE_CANDIDATES.join(', ')})`)

  const rendererEntry: unknown = manifest.renderer?.entry
  const expose = manifest.renderer?.expose
  const staticRenderer = path.join(srcDir, 'renderer')
  if (expose !== undefined) {
    if (typeof rendererEntry !== 'string') throw new Error('renderer.expose needs renderer.entry')
    if (fs.existsSync(staticRenderer)) {
      throw new Error('renderer/ exists alongside renderer.expose; remove one (the build would overwrite renderer/)')
    }
    checkExposes(srcDir, expose)
  }

  const pluginOut = path.join(outDir, id)
  fs.rmSync(pluginOut, { recursive: true, force: true })
  fs.mkdirSync(pluginOut, { recursive: true })

  // Privileged code: one ES-module file, with the plugin's own dependencies
  // bundled in. Node built-ins stay external.
  const entryOut = path.resolve(pluginOut, entry)
  await build({
    configFile: false,
    logLevel: 'warn',
    root: srcDir,
    ssr: { noExternal: true },
    build: {
      ssr: source,
      target: 'node20',
      outDir: path.dirname(entryOut),
      emptyOutDir: false,
      minify: false,
      sourcemap: true,
      rollupOptions: { output: { format: 'es', entryFileNames: path.basename(entryOut) } }
    }
  })
  if (!fs.existsSync(entryOut)) throw new Error(`build did not produce ${entry}`)

  // A "type" marker beside the code: without it, the ES-module output would be
  // read as CommonJS when the folder is copied under the user-data directory.
  fs.writeFileSync(path.join(pluginOut, 'package.json'), JSON.stringify({ type: 'module' }) + '\n')

  // renderer.expose is build-time only; the built manifest is what the app reads.
  if (manifest.renderer) delete manifest.renderer.expose
  fs.writeFileSync(path.join(pluginOut, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')

  if (expose !== undefined) {
    await withoutTestEnv(() => buildRenderer(srcDir, id, path.resolve(pluginOut, rendererEntry as string), expose))
  } else if (fs.existsSync(staticRenderer)) {
    fs.cpSync(staticRenderer, path.join(pluginOut, 'renderer'), { recursive: true })
  }

  if (typeof rendererEntry === 'string' && !fs.existsSync(path.resolve(pluginOut, rendererEntry))) {
    throw new Error(`manifest renderer.entry "${rendererEntry}" was not produced`)
  }

  return id
}

/**
 * @module-federation/vite builds nothing when it detects a test run (NODE_ENV=test,
 * VITEST or JEST_WORKER_ID). Plugin builds are real builds even when the tests start
 * them, so hide those variables while one runs.
 */
async function withoutTestEnv<T>(work: () => Promise<T>): Promise<T> {
  const names = ['NODE_ENV', 'VITEST', 'JEST_WORKER_ID']
  const saved = names.map(name => [name, process.env[name]] as const)
  for (const name of names) delete process.env[name]
  try {
    return await work()
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

function checkExposes(srcDir: string, expose: unknown) {
  if (typeof expose !== 'object' || expose === null || Array.isArray(expose) || Object.keys(expose).length === 0) {
    throw new Error('renderer.expose must map module names (like "./MyView") to source files')
  }
  for (const [name, file] of Object.entries(expose)) {
    if (!name.startsWith('./')) throw new Error(`renderer.expose key "${name}" must start with "./"`)
    if (typeof file !== 'string' || !fs.existsSync(path.resolve(srcDir, file))) {
      throw new Error(`renderer.expose "${name}": source file "${String(file)}" not found`)
    }
  }
}

/**
 * Compiles the exposed TSX/TS modules into a Module Federation remote
 * (an ES-module container) at `entryOut`, with chunks and assets beside it.
 */
async function buildRenderer(srcDir: string, id: string, entryOut: string, expose: Record<string, string>) {
  const { federation } = await import('@module-federation/vite')

  // A remote has no page of its own, but Vite needs some build input.
  const stub = '\0tessera-stub-entry'
  await build({
    configFile: false,
    logLevel: 'warn',
    root: srcDir,
    plugins: [
      {
        name: 'tessera-stub-entry',
        resolveId: source => source === 'tessera-stub-entry' ? stub : null,
        load: source => source === stub ? 'export {}' : null
      },
      federation({
        name: id.replace(/[^A-Za-z0-9_$]/g, '_'),
        filename: path.basename(entryOut),
        exposes: Object.fromEntries(Object.entries(expose).map(([name, file]) => [name, path.resolve(srcDir, file)])),
        shared: Object.fromEntries(SHARED_MODULES.map(name =>
          [name, { singleton: true, requiredVersion: SHARED_REACT_RANGE, import: false }])),
        dts: false
      })
    ],
    esbuild: { jsx: 'automatic' },
    build: {
      target: 'esnext',
      outDir: path.dirname(entryOut),
      emptyOutDir: true,
      minify: false,
      rollupOptions: {
        input: 'tessera-stub-entry',
        onwarn: (warning, warn) => { if (warning.code !== 'EMPTY_BUNDLE') warn(warning) }
      }
    }
  })

  const assets = path.join(path.dirname(entryOut), 'assets')
  if (fs.existsSync(assets)) {
    for (const file of fs.readdirSync(assets)) {
      if (file.startsWith('_tessera-stub-entry')) fs.rmSync(path.join(assets, file))
    }
  }
}

function parseArgs(argv: string[]): BuildOptions {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const options: BuildOptions = { pluginsDir: path.join(root, 'plugins'), outDir: path.join(root, 'modules'), only: [], log: m => console.log(`[plugins] ${m}`) }

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--src') options.pluginsDir = path.resolve(argv[++i])
    else if (argv[i] === '--out') options.outDir = path.resolve(argv[++i])
    else options.only!.push(argv[i])
  }
  return options
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2))
  buildPlugins(options).then(results => {
    if (results.length === 0) options.log?.('no plugins to build')
    process.exit(results.some(r => !r.ok) ? 1 : 0)
  })
}
