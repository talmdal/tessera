// tests/helpers/fakeRemote.ts
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Hand-written Module Federation container (ESM remote entry) exposing
 * "./HelloView". It takes React from the host's share scope rather than
 * bundling it, as a real federated plugin build would. Returns the entry URL.
 */
export function writeFakeRemote(dir: string, fileName = 'remoteEntry.js') {
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, fileName)

  fs.writeFileSync(file, `
    let shareScope

    export function init(scope) {
      shareScope = scope
    }

    async function shared(name) {
      const versions = shareScope[name]
      const factory = await versions[Object.keys(versions)[0]].get()
      return factory()
    }

    export async function get(module) {
      if (module === './HelloView') {
        const React = await shared('react')
        globalThis.__remoteReact = React
        const HelloView = () => React.createElement('p', null, 'Hello from a federated plugin')
        return () => ({ default: HelloView })
      }
      if (module === './NotAComponent') {
        return () => ({ default: 42 })
      }
      throw new Error('Module ' + module + ' is not exposed')
    }
  `)

  return pathToFileURL(file).href
}
