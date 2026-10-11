// tests/helpers/fakePlugin.ts
import fs from 'node:fs'
import path from 'node:path'

export function writeFakePlugin(modulesDir: string) {
  const pluginDir = path.join(modulesDir, 'test-plugin')
  fs.mkdirSync(pluginDir)

  fs.writeFileSync(
    path.join(pluginDir, 'manifest.json'),
    JSON.stringify({
      id: 'test-plugin',
      name: 'Test Plugin',
      version: '0.0.1',
      privileged: { entry: 'privileged/index.js' }
    })
  )

  const privDir = path.join(pluginDir, 'privileged')
  fs.mkdirSync(privDir)

  fs.writeFileSync(
    path.join(privDir, 'index.js'),
    `
      exports.activate = (context) => {
        context.ipc.register('test', 'ping', async (msg) => {
          return 'pong'
        })
      }
    `
  )
}
