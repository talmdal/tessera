// shared/plugins/manifest.ts

export interface PluginManifest {
  /** Lower-case, dash-separated. Prefixes every id the plugin registers. */
  id: string
  name: string
  version: string
  privileged: {
    entry: string // e.g. "privileged/index.js"
  }
  renderer?: {
    entry: string // e.g. "renderer/remoteEntry.js"
    /** Build time only (scripts/build-plugins.ts): module name to source file. Dropped from the built manifest. */
    expose?: Record<string, string>
  }
  services?: {
    /** Services this plugin provides from `activate`. Each id has exactly one provider. */
    provides?: string[]
    /** Services this plugin needs. It activates after their providers, or not at all. */
    requires?: string[]
  }
}

/** Contributor id the shell uses for its own contributions. Plugins may not claim it. */
export const SHELL_CONTRIBUTOR_ID = 'shell'

export const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/

/** Service ids are dotted names, e.g. "vault.store". They are not tied to the provider's plugin id. */
export const SERVICE_ID_PATTERN = /^[A-Za-z][\w-]*(\.[\w-]+)+$/

export function providedServices(manifest: PluginManifest): string[] {
  return manifest.services?.provides ?? []
}

export function requiredServices(manifest: PluginManifest): string[] {
  return manifest.services?.requires ?? []
}

/** Validates raw manifest JSON. Throws with a description of the first problem found. */
export function parseManifest(raw: unknown): PluginManifest {
  if (typeof raw !== 'object' || raw === null) throw new Error('Manifest is not an object')

  const m = raw as Record<string, unknown>
  const isString = (v: unknown): v is string => typeof v === 'string' && v.length > 0
  const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
  const hasEntry = (v: unknown) => isObject(v) && isString(v.entry)

  if (!isString(m.id) || !PLUGIN_ID_PATTERN.test(m.id)) throw new Error(`Manifest id "${String(m.id)}" is invalid`)
  if (m.id === SHELL_CONTRIBUTOR_ID) throw new Error(`Manifest id "${m.id}" is reserved`)
  if (!isString(m.name)) throw new Error(`Manifest "${m.id}" is missing a name`)
  if (!isString(m.version)) throw new Error(`Manifest "${m.id}" is missing a version`)
  if (!hasEntry(m.privileged)) throw new Error(`Manifest "${m.id}" is missing privileged.entry`)
  if (m.renderer !== undefined && !hasEntry(m.renderer)) throw new Error(`Manifest "${m.id}" has an invalid renderer.entry`)

  if (m.services !== undefined) {
    if (!isObject(m.services)) throw new Error(`Manifest "${m.id}" has an invalid services section`)
    for (const key of ['provides', 'requires'] as const) {
      const list = m.services[key]
      if (list === undefined) continue
      if (!Array.isArray(list)) throw new Error(`Manifest "${m.id}" services.${key} must be an array`)
      const bad = list.find(s => !isString(s) || !SERVICE_ID_PATTERN.test(s))
      if (bad !== undefined) throw new Error(`Manifest "${m.id}" services.${key} has invalid service id "${String(bad)}"`)
    }
  }

  return raw as PluginManifest
}
