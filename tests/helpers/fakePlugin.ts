// tests/helpers/fakePlugin.ts
import fs from 'node:fs'
import path from 'node:path'

/** Writes a CommonJS plugin to `<modulesDir>/<dirName>` whose activate registers `ping`. */
export function writeFakePlugin(modulesDir: string, id = 'test-plugin', dirName = id) {
  const pluginDir = path.join(modulesDir, dirName)
  fs.mkdirSync(path.join(pluginDir, 'privileged'), { recursive: true })

  fs.writeFileSync(
    path.join(pluginDir, 'manifest.json'),
    JSON.stringify({
      id,
      name: 'Test Plugin',
      version: '0.0.1',
      privileged: { entry: 'privileged/index.js' }
    })
  )

  fs.writeFileSync(
    path.join(pluginDir, 'privileged', 'index.js'),
    `
      exports.activate = (context) => {
        context.ipc.handle('ping', async () => 'pong')
      }
    `
  )

  return pluginDir
}
