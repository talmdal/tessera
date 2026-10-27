import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import esbuild from 'esbuild'

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

const SHARED_REACT_RANGE = '^18.2.0'
const SHARED_MODULES = ['react', 'react/jsx-runtime', 'react-dom']

export async function buildPlugins({ pluginsDir, outDir, only, log = () => {} }: BuildOptions): Promise<BuildResult[]> {
  if (!fs.existsSync(pluginsDir)) return []

  // `only` names plugins by manifest id ("layout-sample") or by folder ("layout.sample").
  const wanted = (folder: string) => {
    if (!only?.length) return true
    if (only.includes(folder)) return true
    try {
      return only.includes(JSON.parse(fs.readFileSync(path.join(pluginsDir, folder, 'manifest.json'), 'utf8')).id)
    } catch {
      return false
    }
  }
  const folders = fs.readdirSync(pluginsDir, { withFileTypes: true })
    .filter(d => d.isDirectory() && fs.existsSync(path.join(pluginsDir, d.name, 'manifest.json')))
    .map(d => d.name)
    .filter(wanted)

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
      '@tessera/types': path.resolve(process.cwd(), 'tessera-types/index.ts')
    }
  })

  fs.writeFileSync(path.join(pluginOut, 'package.json'), JSON.stringify({ type: 'cjs' }) + '\n')

  if (manifest.renderer) delete manifest.renderer.expose
  fs.writeFileSync(path.join(pluginOut, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')

  if (expose !== undefined) {
    await buildRenderer(srcDir, id, path.resolve(pluginOut, rendererEntry), expose)
  } else if (fs.existsSync(staticRenderer)) {
    fs.cpSync(staticRenderer, path.join(pluginOut, 'renderer'), { recursive: true })
  }

  if (typeof rendererEntry === 'string' && !fs.existsSync(path.resolve(pluginOut, rendererEntry))) {
    throw new Error(`manifest renderer.entry "${rendererEntry}" was not produced`)
  }

  return id
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

const RENDERER_BUILDER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'build-renderer.mjs')

/**
 * Builds the renderer remote in a Node process of its own (see
 * build-renderer.mjs for why), with the test runner's environment variables
 * removed so Vite builds for production. The job travels on stdin, which
 * needs no quoting on any platform.
 */
function buildRenderer(srcDir: string, id: string, entryOut: string, expose: Record<string, string>) {
  const env = { ...process.env }
  for (const name of ['NODE_ENV', 'VITEST', 'JEST_WORKER_ID']) delete env[name]

  return new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [RENDERER_BUILDER], { env, stdio: ['pipe', 'inherit', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', reject)
    child.on('close', code => {
      if (code === 0) {
        if (stderr.trim()) process.stderr.write(stderr)      // Vite warnings
        resolve()
      } else {
        reject(new Error(`renderer build failed (exit code ${code})${stderr.trim() ? `:\n${stderr.trim()}` : ''}`))
      }
    })
    child.stdin.end(JSON.stringify({
      srcDir, id, entryOut, expose, shared: SHARED_MODULES, sharedVersion: SHARED_REACT_RANGE
    }))
  })
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
