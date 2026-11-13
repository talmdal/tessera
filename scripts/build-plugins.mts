import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import esbuild from 'esbuild'
import { build as viteBuild } from 'vite'

export interface BuildOptions {
  pluginsDir: string
  outDir: string
  only?: string[]
  log?: (message: string) => void
}

export interface BuildResult {
  id: string
  ok: boolean
  error?: string
}

const SOURCE_CANDIDATES = [
  'src/privileged/index.ts',
  'src/privileged/index.js',
  'src/privileged/index.mjs'
]

/**
 * The React range views accept: the shell's own, from package.json, so the two can't drift apart. (The shell
 * shares the React it is built with, so a range taken from the same declaration always admits it.)
 */
const sharedReactRange = () => {
  const { dependencies } = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8'))
  const range = dependencies?.react
  if (typeof range !== 'string') throw new Error('package.json has no "react" dependency to take the shared range from')
  return range
}
const SHARED_MODULES = ['react', 'react/jsx-runtime', 'react-dom']

/** The shell's UI facade, shared with every view. Its MUI and Emotion stay the shell's private dependencies. */
const SHARED_UI_MODULE = '@tessera/ui'
const sharedUiRange = () => {
  const { version } = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'tessera-ui/package.json'), 'utf8'))
  return `^${version}`
}

/**
 * Plugins' published contracts (types and constants), which other plugins import. Each plugin bundles what it uses,
 * in both halves, since they hold no state. Resolved against the working directory, like the other aliases.
 */
const API_PACKAGES = ['ledger-api', 'accounts-api', 'import-api', 'export-api']
const API_PACKAGE_ALIASES = (): Record<string, string> => Object.fromEntries(
  API_PACKAGES.map(name => [`@tessera/${name}`, path.resolve(process.cwd(), 'packages', name, 'index.ts')]))

/** Libraries a plugin must reach through `@tessera/ui`, never directly: a second copy would ignore the shell's theme. */
const PRIVATE_UI_LIBRARIES = /^@(mui|emotion)\//

/** Fails the build when a plugin's own source imports one of the shell's private UI libraries. */
function forbidPrivateUiImports(srcDir: string) {
  const root = path.resolve(srcDir) + path.sep
  return {
    name: 'tessera-forbid-private-ui',
    enforce: 'pre' as const,
    resolveId(this: { error(message: string): never }, source: string, importer?: string) {
      if (!importer || !path.resolve(importer).startsWith(root) || !PRIVATE_UI_LIBRARIES.test(source)) return null
      this.error(`"${source}" is the shell's private dependency; import components from "${SHARED_UI_MODULE}" instead (${path.relative(root, importer)})`)
    }
  }
}

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
  const id = manifest.id
  const entry = manifest.privileged?.entry

  if (typeof id !== 'string' || typeof entry !== 'string') {
    throw new Error('manifest.json needs "id" and "privileged.entry"')
  }

  const source = SOURCE_CANDIDATES.map(c => path.join(srcDir, c)).find(fs.existsSync)
  if (!source) throw new Error(`no privileged source found (${SOURCE_CANDIDATES.join(', ')})`)

  const rendererEntry = manifest.renderer?.entry
  const expose = manifest.renderer?.expose
  const staticRenderer = path.join(srcDir, 'renderer')

  if (expose !== undefined) {
    if (typeof rendererEntry !== 'string') throw new Error('renderer.expose needs renderer.entry')
    if (fs.existsSync(staticRenderer)) {
      throw new Error('renderer/ exists alongside renderer.expose; remove one')
    }
    checkExposes(srcDir, expose)
  }

  const pluginOut = path.join(outDir, id)
  fs.rmSync(pluginOut, { recursive: true, force: true })
  fs.mkdirSync(pluginOut, { recursive: true })

  const entryOut = path.resolve(pluginOut, entry)

  // ⭐ PRIVILEGED BUILD USING ESBUILD
  await esbuild.build({
    entryPoints: [source],
    outfile: entryOut,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    sourcemap: true,
    packages: 'external',
    external: [
      'lokijs',
      'lokijs/src/loki-fs-sync-adapter.js'
    ],
    alias: {
      '@core': path.resolve(process.cwd(), 'core'),
      '@shared': path.resolve(process.cwd(), 'shared'),
      '@shell': path.resolve(process.cwd(), 'shell'),
      '@plugins': path.resolve(process.cwd(), 'plugins'),
      '@tessera/types': path.resolve(process.cwd(), 'tessera-types/index.ts'),
      '@tessera/storage-kit': path.resolve(process.cwd(), 'packages/storage-kit/index.ts'),
      ...API_PACKAGE_ALIASES()
    }
  })

  fs.writeFileSync(path.join(pluginOut, 'package.json'), JSON.stringify({ type: 'cjs' }) + '\n')

  if (manifest.renderer) delete manifest.renderer.expose
  fs.writeFileSync(path.join(pluginOut, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')

  if (expose !== undefined) {
    await withoutTestEnv(() =>
      buildRenderer(srcDir, id, path.resolve(pluginOut, rendererEntry), expose)
    )
  } else if (fs.existsSync(staticRenderer)) {
    fs.cpSync(staticRenderer, path.join(pluginOut, 'renderer'), { recursive: true })
  }

  if (typeof rendererEntry === 'string' && !fs.existsSync(path.resolve(pluginOut, rendererEntry))) {
    throw new Error(`manifest renderer.entry "${rendererEntry}" was not produced`)
  }

  return id
}

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
  for (const [name, file] of Object.entries(expose as Record<string, string>)) {
    if (!name.startsWith('./')) throw new Error(`renderer.expose key "${name}" must start with "./"`)
    if (!fs.existsSync(path.resolve(srcDir, file))) {
      throw new Error(`renderer.expose "${name}": source file "${file}" not found`)
    }
  }
}

/**
 * The oldest `@module-federation/vite` that builds more than two federated plugins in one process. Earlier versions
 * write their virtual modules to `<plugin>/node_modules/__mf__virtual` and lose track of them from the third build on
 * ("Rollup failed to resolve import …__mf__virtual/…hostAutoInit…"). There is no lockfile yet, so an old install can
 * survive a `package.json` bump until `npm install` is run; this says so, rather than failing obscurely.
 */
const MIN_FEDERATION_VITE = [1, 16, 0] as const

/** Why the installed `@module-federation/vite` version can't be used, or undefined when it can (or can't be read). */
export function federationVersionProblem(version: string): string | undefined {
  const parts = version.split(/[.-]/).slice(0, 3).map(Number)
  if (parts.length < 3 || parts.some(Number.isNaN)) return undefined
  for (let i = 0; i < 3; i++) {
    if (parts[i] > MIN_FEDERATION_VITE[i]) return undefined
    if (parts[i] < MIN_FEDERATION_VITE[i]) {
      return `@module-federation/vite ${version} is installed; ${MIN_FEDERATION_VITE.join('.')} or later is ` +
        'needed to build several federated plugins together. Run "npm install" to update it.'
    }
  }
  return undefined
}

function checkFederationVersion() {
  const file = path.resolve(process.cwd(), 'node_modules', '@module-federation', 'vite', 'package.json')
  if (!fs.existsSync(file)) return
  const { version } = JSON.parse(fs.readFileSync(file, 'utf8')) as { version?: unknown }
  const problem = typeof version === 'string' ? federationVersionProblem(version) : undefined
  if (problem) throw new Error(problem)
}

async function buildRenderer(srcDir: string, id: string, entryOut: string, expose: Record<string, string>) {
  checkFederationVersion()
  const { federation } = await import('@module-federation/vite')

  const stub = '\0tessera-stub-entry'
  await viteBuild({
    configFile: false,
    logLevel: 'warn',
    root: srcDir,
    plugins: [
      forbidPrivateUiImports(srcDir),
      {
        name: 'tessera-stub-entry',
        resolveId: source => source === 'tessera-stub-entry' ? stub : null,
        load: source => source === stub ? 'export {}' : null
      },
      federation({
        name: id.replace(/[^A-Za-z0-9_$]/g, '_'),
        filename: path.basename(entryOut),
        exposes: Object.fromEntries(
          Object.entries(expose).map(([name, file]) => [name, path.resolve(srcDir, file)])
        ),
        shared: {
          ...Object.fromEntries(
            SHARED_MODULES.map(name => [
              name,
              { singleton: true, requiredVersion: sharedReactRange(), import: false }
            ])
          ),
          [SHARED_UI_MODULE]: { singleton: true, requiredVersion: sharedUiRange(), import: false }
        },
        dts: false
      })
    ],
    esbuild: { jsx: 'automatic' },
    // Views import values (not just types) from the shared types package, as the privileged build allows.
    // Deliberately no alias for `@tessera/ui`: an alias resolves it before the federation plugin sees the import, and it
    // would be bundled rather than shared. The shell's copy is used at run time; types come from tsconfig paths.
    // The API packages are types and constants, so bundling a copy into each plugin is right.
    resolve: { alias: { '@tessera/types': path.resolve(process.cwd(), 'tessera-types/index.ts'), ...API_PACKAGE_ALIASES() } },
    build: {
      target: 'esnext',
      outDir: path.dirname(entryOut),
      emptyOutDir: true,
      minify: false,
      rollupOptions: {
        input: 'tessera-stub-entry',
        onwarn: (warning, warn) => {
          if (warning.code !== 'EMPTY_BUNDLE') warn(warning)
        }
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
  const options: BuildOptions = {
    pluginsDir: path.join(root, 'plugins'),
    outDir: path.join(root, 'modules'),
    only: [],
    log: m => console.log(`[plugins] ${m}`)
  }

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
