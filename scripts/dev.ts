import { spawn } from 'child_process'
import * as path from 'path'

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

    p.on('exit', code => {
      if (code === 0) resolve()
      else reject(new Error(`Build failed: ${configPath}`))
    })
  })
}

function startRendererDevServer() {
  return spawn('node', [
    path.resolve('node_modules/vite/bin/vite.js'),
    'dev',
    '--config',
    'shell/renderer/vite.config.ts'
  ], {
    stdio: ['pipe', 'pipe', 'inherit']
  })
}

function startElectron(renderer) {
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
  await runViteBuild('shell/main/vite.config.ts')

  console.log('[DEV] Building preload...')
  await runViteBuild('shell/preload/vite.config.ts')

  console.log('[DEV] Starting renderer dev server...')
  const renderer = startRendererDevServer()

  renderer.stdout.on('data', data => {
    const text = data.toString()
    if (text.includes('http://localhost:')) {
      console.log('[DEV] Renderer ready — launching Electron')
      startElectron(renderer)
    }
  })
}

main()
