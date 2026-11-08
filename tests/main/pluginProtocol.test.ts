// @vitest-environment node
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { pluginUrl, servePluginFile } from '../../shell/main/plugins/pluginProtocol'
import { createTempModulesDir } from '../helpers/tempModules'

function setup() {
  const pluginDir = createTempModulesDir()
  const root = path.join(pluginDir, 'renderer')
  fs.mkdirSync(path.join(root, 'assets'), { recursive: true })
  fs.writeFileSync(path.join(root, 'remoteEntry.js'), 'export const x = 1')
  fs.writeFileSync(path.join(root, 'assets', 'view.css'), 'p {}')
  fs.writeFileSync(path.join(pluginDir, 'secret.txt'), 'privileged')

  const roots: Record<string, string> = { alpha: root }
  return (url: string) => servePluginFile(url, id => roots[id])
}

describe('plugin protocol', () => {
  it('builds URLs from plugin id and relative path', () => {
    expect(pluginUrl('alpha', path.join('assets', 'view.css'))).toBe('tessera-plugin://alpha/assets/view.css')
  })

  it('serves files under the renderer root with a content type and CORS header', async () => {
    const serve = setup()

    const js = await serve('tessera-plugin://alpha/remoteEntry.js')
    expect(js.status).toBe(200)
    expect(js.headers.get('content-type')).toBe('text/javascript')
    expect(js.headers.get('access-control-allow-origin')).toBe('*')
    // Plugin files change when a plugin is rebuilt or updated; a cached copy would keep running old code
    expect(js.headers.get('cache-control')).toBe('no-cache')
    expect(await js.text()).toBe('export const x = 1')

    const css = await serve('tessera-plugin://alpha/assets/view.css')
    expect(css.headers.get('content-type')).toBe('text/css')
  })

  it('returns 404 for unknown plugins and missing files', async () => {
    const serve = setup()

    expect((await serve('tessera-plugin://beta/remoteEntry.js')).status).toBe(404)
    expect((await serve('tessera-plugin://alpha/nope.js')).status).toBe(404)
  })

  it('never serves files outside the renderer root', async () => {
    const serve = setup()

    // URL parsing collapses ../ and %2e%2e; an encoded backslash survives it. On Windows the backslash separates folders,
    // so the path leaves the root and the root check refuses it (403); elsewhere it is part of a file name inside the
    // root, which doesn't exist (404). Either way the file outside is never served.
    for (const url of [
      'tessera-plugin://alpha/../secret.txt',
      'tessera-plugin://alpha/%2e%2e/secret.txt',
      'tessera-plugin://alpha/..%5csecret.txt'
    ]) {
      expect((await serve(url)).status, url).not.toBe(200)
    }
    expect([403, 404]).toContain((await serve('tessera-plugin://alpha/..%5csecret.txt')).status)
  })
})
