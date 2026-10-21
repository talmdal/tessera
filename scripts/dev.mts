import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import * as path from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

function runViteBuild(configPath: string) {
  return new Promise<void>((resolve, reject) => {
    const p = spawn('node', [
      path.resolve('node_modules/vite/bin/vite.js'),
      'build',
      '--config',
      configPath
    ], {
      stdio: 'inherit'
    })

    p.on('exit', (code: any) => {
      if (code === 0) resolve()
      else reject(new Error(`Build failed: ${configPath}`))
    })
  })
}

function buildBundledPlugins() {
  return new Promise<void>((resolve, reject) => {
    const p = spawn('node', [
      path.resolve('node_modules/ts-node/dist/bin.js'),
      '--transpile-only',
      path.resolve('scripts/build-plugins.mts')
    ], { stdio: 'inherit' })

    p.on('exit', (code: any) => {
      if (code === 0) resolve()
      else reject(new Error('Building bundled plugins failed'))
    })
  })
}

function startRendererDevServer() {
  return spawn('node', [
    path.resolve('node_modules/vite/bin/vite.js'),
    'dev',
    '--config',
    path.resolve('shell/renderer/vite.config.ts')
  ], {
    stdio: ['pipe', 'pipe', 'inherit']
  })
}

function startElectron(renderer: ReturnType<typeof startRendererDevServer>) {
  const p = spawn('node', [
    path.resolve('node_modules/electron/cli.js'),
    '.'
  ], {
    stdio: 'inherit',
    cwd: path.resolve(__dirname, '..')
  })

  p.on('exit', () => {
    console.log('[DEV] Electron exited — shutting down dev server')
    renderer.kill('SIGTERM')
    process.exit(0)
  })

  return p
}

async function main() {
  console.log('[DEV] Building main...')
  await runViteBuild(path.resolve('shell/main/vite.config.ts'))

  console.log('[DEV] Building preload...')
  await runViteBuild(path.resolve('shell/preload/vite.config.ts'))

  console.log('[DEV] Building bundled plugins...')
  await buildBundledPlugins()

  console.log('[DEV] Starting renderer dev server...')
  const renderer = startRendererDevServer()

  renderer.stdout.on('data', (data: Buffer) => {
    const text = data.toString()
    if (text.includes('http://localhost:')) {
      console.log('[DEV] Renderer ready — launching Electron')
      startElectron(renderer)
    }
  })
}

main()
