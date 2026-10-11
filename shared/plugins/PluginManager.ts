// shared/plugins/PluginManager.ts
import fs from 'node:fs'
import path from 'node:path'
import {
  PluginManifest,
  LoadedPlugin,
  PrivilegedPluginModule,
  Services
} from './types'
import { PluginContext, ExtensionRegistry } from './context'
import { IpcRouter } from '../ipcRouter'

export class PluginManager {
  constructor(
    private readonly modulesDir: string,
    private readonly services: Services,
    private readonly ipc: IpcRouter,
    private readonly extensions: ExtensionRegistry
  ) {}

  discover(): PluginManifest[] {
    if (!fs.existsSync(this.modulesDir)) return []

    const dirs = fs.readdirSync(this.modulesDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name)

    const manifests: PluginManifest[] = []

    for (const dir of dirs) {
      const manifestPath = path.join(this.modulesDir, dir, 'manifest.json')
      if (!fs.existsSync(manifestPath)) continue

      const raw = fs.readFileSync(manifestPath, 'utf8')
      manifests.push(JSON.parse(raw))
    }

    return manifests
  }

  load(manifest: PluginManifest): LoadedPlugin {
    const pluginDir = path.join(this.modulesDir, manifest.id)
    const privilegedPath = path.join(pluginDir, manifest.privileged.entry)
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const privileged: PrivilegedPluginModule = require(privilegedPath)

    return {
      id: manifest.id,
      manifest,
      privileged
    }
  }

  async activateAll(): Promise<LoadedPlugin[]> {
    const manifests = this.discover()
    const context = new PluginContext(this.ipc, this.extensions, this.services)

    const loaded: LoadedPlugin[] = []

    for (const manifest of manifests) {
      const plugin = this.load(manifest)
      await plugin.privileged.activate(context)
      loaded.push(plugin)
    }

    return loaded
  }
}
