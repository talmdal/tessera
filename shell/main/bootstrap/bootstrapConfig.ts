// Tier 0 configuration: what must be known before any plugin activates, so it can't live behind a plugin.
// `storage.engine` is itself a plugin, so "which storage backend" or "which plugins are enabled" cannot be
// kept in the store it would choose. It is a small plain JSON file, read synchronously at startup.
// See docs/storage-engine-redesign.md, "Configuration tiers".
import fs from 'node:fs'
import path from 'node:path'
import type { Logger } from '@tessera/types'
import type { PluginSelection } from '../../../core/plugins/PluginManager'

export const BOOTSTRAP_FILE = 'tessera-bootstrap.json'

export interface BootstrapConfig {
  /** Plugin ids left out of activation entirely. */
  disabledPlugins: string[]
  /**
   * Plugin ids activated first, in this order. The first provider of a contested service wins, so this is
   * how one of several installed plugins providing the same service (`storage.engine`) is chosen.
   */
  preferredPlugins: string[]
}

export const defaultBootstrapConfig = (): BootstrapConfig => ({ disabledPlugins: [], preferredPlugins: [] })

export const bootstrapConfigPath = (userDataDir: string) => path.join(userDataDir, BOOTSTRAP_FILE)

function pluginIds(value: unknown, field: string, log: Logger): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some(id => typeof id !== 'string' || id === '')) {
    log.warn(`[bootstrap] Ignoring "${field}": it must be a list of plugin ids`)
    return []
  }
  return [...new Set(value as string[])]
}

/**
 * Reads the bootstrap file. A missing file is the defaults; an unreadable or malformed one is logged and
 * ignored, so it can never stop the application starting. Unknown keys are ignored.
 */
export function loadBootstrapConfig(userDataDir: string, log: Logger): BootstrapConfig {
  const file = bootstrapConfigPath(userDataDir)
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.warn(`[bootstrap] Could not read ${file}: ${err instanceof Error ? err.message : err}`)
    return defaultBootstrapConfig()
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    log.warn(`[bootstrap] Ignoring ${file}: it is not valid JSON (${err instanceof Error ? err.message : err})`)
    return defaultBootstrapConfig()
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    log.warn(`[bootstrap] Ignoring ${file}: it must hold a JSON object`)
    return defaultBootstrapConfig()
  }

  const { disabledPlugins, preferredPlugins } = parsed as Record<string, unknown>
  return {
    disabledPlugins: pluginIds(disabledPlugins, 'disabledPlugins', log),
    preferredPlugins: pluginIds(preferredPlugins, 'preferredPlugins', log)
  }
}

/** Writes the file whole, through a temporary file, so a crash can't leave half of it. Takes effect at the next start. */
export function saveBootstrapConfig(userDataDir: string, config: BootstrapConfig): void {
  const file = bootstrapConfigPath(userDataDir)
  fs.mkdirSync(userDataDir, { recursive: true })
  const temporary = `${file}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(config, null, 2) + '\n')
  fs.renameSync(temporary, file)
}

/** The part of the configuration the plugin manager acts on. */
export const toPluginSelection = (config: BootstrapConfig): PluginSelection => ({
  disabled: config.disabledPlugins,
  preferred: config.preferredPlugins
})
