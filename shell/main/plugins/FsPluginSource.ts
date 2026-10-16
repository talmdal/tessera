// shell/main/plugins/FsPluginSource.ts
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { Logger, PluginDescriptor, PluginSource } from '../../../core/ports'

/** Discovers plugins as `<dir>/<plugin>/manifest.json` folders under each root directory. */
export class FsPluginSource implements PluginSource {
  constructor(
    private readonly roots: readonly string[],
    private readonly log: Logger
  ) {}

  async discover(): Promise<PluginDescriptor[]> {
    const descriptors: PluginDescriptor[] = []

    for (const root of this.roots) {
      const dirs = await fs.readdir(root, { withFileTypes: true }).catch(ignoreMissing)
      for (const dir of dirs ?? []) {
        if (!dir.isDirectory()) continue

        const location = path.join(root, dir.name)
        const raw = await fs.readFile(path.join(location, 'manifest.json'), 'utf8').catch(ignoreMissing)
        if (raw === undefined) continue

        try {
          descriptors.push({ location, manifest: JSON.parse(raw) })
        } catch {
          this.log.warn(`[plugins] Skipping ${location}: manifest.json is not valid JSON`)
        }
      }
    }

    return descriptors
  }

  async load(descriptor: PluginDescriptor, entry: string): Promise<unknown> {
    const location = path.resolve(descriptor.location)
    const file = path.resolve(location, entry)
    if (!file.startsWith(location + path.sep)) {
      throw new Error(`Entry "${entry}" resolves outside the plugin directory`)
    }

    return import(/* @vite-ignore */ pathToFileURL(file).href)
  }
}

function ignoreMissing(err: NodeJS.ErrnoException): undefined {
  if (err.code === 'ENOENT') return undefined
  throw err
}
