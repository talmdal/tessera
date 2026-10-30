// shell/main/bootstrap/bootstrapConfig.ts
//
// Tier-0 configuration: the few choices that shape plugin activation and so
// cannot be stored through a plugin. A plain JSON file in userData, read
// synchronously before any plugin activates, owned by the shell:
//
//   {
//     "disabledPlugins": ["layout-sample"],
//     "preferredPlugins": ["storage-sqlite"]
//   }
//
// A missing file means defaults. A file that can't be read or parsed, or a
// key of the wrong shape, is logged and ignored, so this file can never
// stop the application from starting. Everything else the application
// remembers belongs in app.state or settings, which live behind
// storage.engine; see docs/storage-engine-design.md, "Configuration tiers".
import fs from 'node:fs'
import type { Logger } from '@tessera/types'
import type { PluginSelection } from '../../../core/plugins/pluginSelection'

export const BOOTSTRAP_FILE = 'tessera-bootstrap.json'

export interface BootstrapConfig extends PluginSelection {
  readonly disabledPlugins: readonly string[]
  readonly preferredPlugins: readonly string[]
}

const DEFAULTS: BootstrapConfig = { disabledPlugins: [], preferredPlugins: [] }

export function readBootstrapConfig(file: string, log: Logger): BootstrapConfig {
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.warn(`[bootstrap] Cannot read ${file}; using defaults`, err)
    return DEFAULTS
  }

  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (err) {
    log.warn(`[bootstrap] ${file} is not valid JSON; using defaults`, err)
    return DEFAULTS
  }
  return parseBootstrapConfig(raw, problem => log.warn(`[bootstrap] ${file}: ${problem}`))
}

/** Validates the file's shape, reporting each problem and falling back per key. */
export function parseBootstrapConfig(raw: unknown, report: (problem: string) => void = () => {}): BootstrapConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    report('expected an object; using defaults')
    return DEFAULTS
  }
  const record = raw as Record<string, unknown>
  const ids = (key: keyof BootstrapConfig): readonly string[] => {
    const value = record[key]
    if (value === undefined) return []
    if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
      report(`"${key}" must be an array of plugin ids; ignoring it`)
      return []
    }
    return value as string[]
  }
  for (const key of Object.keys(record)) {
    if (key !== 'disabledPlugins' && key !== 'preferredPlugins') report(`unknown key "${key}" ignored`)
  }
  return { disabledPlugins: ids('disabledPlugins'), preferredPlugins: ids('preferredPlugins') }
}
