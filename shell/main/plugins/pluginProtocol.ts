// shell/main/plugins/pluginProtocol.ts
import { protocol } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * Serves plugin renderer bundles to the renderer as
 * `tessera-plugin://<pluginId>/<path>`, rooted at the folder containing the
 * plugin's renderer entry. Nothing outside that folder is reachable.
 */
export const PLUGIN_SCHEME = 'tessera-plugin'

const CONTENT_TYPES: Record<string, string> = {
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.wasm': 'application/wasm'
}

export function pluginUrl(pluginId: string, relativePath: string) {
  return `${PLUGIN_SCHEME}://${pluginId}/${relativePath.split(path.sep).join('/')}`
}

/** Must run before the app is ready. */
export function registerPluginSchemePrivileges() {
  protocol.registerSchemesAsPrivileged([{
    scheme: PLUGIN_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true }
  }])
}

/** `rendererRootFor` returns the directory to serve for a plugin, or undefined if it has none. */
export function handlePluginProtocol(rendererRootFor: (pluginId: string) => string | undefined) {
  protocol.handle(PLUGIN_SCHEME, request => servePluginFile(request.url, rendererRootFor))
}

export async function servePluginFile(
  url: string,
  rendererRootFor: (pluginId: string) => string | undefined
): Promise<Response> {
  const { hostname, pathname } = new URL(url)
  const root = rendererRootFor(hostname)
  if (!root) return new Response('Unknown plugin', { status: 404 })

  const file = path.resolve(root, '.' + decodeURIComponent(pathname))
  if (!file.startsWith(path.resolve(root) + path.sep)) return new Response('Forbidden', { status: 403 })

  try {
    const body = await fs.readFile(file)
    return new Response(body, {
      headers: {
        'content-type': CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
        // Module scripts are fetched in CORS mode from the renderer's origin.
        'access-control-allow-origin': '*'
      }
    })
  } catch {
    return new Response('Not found', { status: 404 })
  }
}
