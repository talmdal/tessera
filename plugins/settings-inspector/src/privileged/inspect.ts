// Compares what the settings hold with what is on disk. The merge rule is written out again here, independently of
// the framework's, on purpose: the inspector is a second witness, so if the framework's merge ever drifted from the
// documented rule (objects merge key by key; everything else is replaced whole) the two would disagree, and it shows.
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Json, JsonObject, SettingsNamespaceSnapshot } from '@tessera/types'
import type { Check, FileReport, InspectorReport, NamespaceReport } from '../shared'

const isObject = (value: unknown): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value)

/** The documented rule: stored values over the defaults, objects key by key, anything else whole. */
export function merged(defaults: JsonObject, values: JsonObject): JsonObject {
  const result: JsonObject = { ...defaults }
  for (const [key, value] of Object.entries(values)) {
    const base = result[key]
    result[key] = isObject(base) && isObject(value) ? merged(base, value) : value
  }
  return result
}

export function same(a: Json | undefined, b: Json | undefined): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, i) => same(item, b[i]))
  if (isObject(a) && isObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)])
    return [...keys].every(key => key in a && key in b && same(a[key], b[key]))
  }
  return a === b
}

/** The settings that differ from their defaults, as dotted paths. */
export function changedFromDefaults(defaults: JsonObject, value: JsonObject, prefix = ''): string[] {
  return [...new Set([...Object.keys(defaults), ...Object.keys(value)])].flatMap(key => {
    const a = defaults[key]
    const b = value[key]
    if (isObject(a) && isObject(b)) return changedFromDefaults(a, b, `${prefix}${key}.`)
    return same(a, b) ? [] : [`${prefix}${key}`]
  })
}

async function readFile(folder: string, name: string): Promise<FileReport> {
  const file = path.join(folder, name)
  const [text, stat] = await Promise.all([fs.readFile(file, 'utf8'), fs.stat(file)])
  const report: FileReport = { name, path: file, text, modified: stat.mtime.toISOString() }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    return { ...report, problem: `It is not valid JSON: ${err instanceof Error ? err.message : String(err)}` }
  }
  const { version, values } = (parsed ?? {}) as { version?: unknown, values?: unknown }
  if (!isObject(parsed) || !Number.isInteger(version) || (version as number) < 1 || !isObject(values)) {
    return { ...report, problem: 'It is not in the expected form, { "version": 1, "values": { … } }.' }
  }
  return { ...report, version: version as number, values }
}

function judge(snapshot: SettingsNamespaceSnapshot, file: FileReport | undefined): { check: Check, note: string } {
  const { value, defaults } = snapshot
  if (!file) {
    return same(value, defaults)
      ? { check: 'defaults', note: 'Every setting is at its default, so nothing is saved: only differences are written.' }
      : { check: 'differs', note: 'Some settings differ from their defaults, but there is no file: the write may have failed (see the log), or the file was removed since.' }
  }
  if (file.problem) return { check: 'unreadable', note: `${file.problem} At the next start it is set aside as ${file.name}.bad and the defaults are used.` }
  if (same(merged(defaults, file.values!), value)) {
    return { check: 'matches', note: 'What is in effect is exactly the saved values merged over the defaults.' }
  }
  return {
    check: 'differs',
    note: snapshot.readOnly
      ?? 'What is in effect is not the saved values merged over the defaults. The file may have been changed since Tessera read it, '
        + 'saved by another version of the plugin (upgraded, or read-only), or a saved value was refused and its default used: the log says which.'
  }
}

/**
 * A report of every namespace (what is in effect, its defaults, its file and whether they agree) and of every other
 * file in the folder. Reads the disk fresh each time.
 */
export async function inspectSettings(snapshots: readonly SettingsNamespaceSnapshot[], folder: string, now = new Date()): Promise<InspectorReport> {
  let names: string[] = []
  let folderExists = true
  try {
    names = (await fs.readdir(folder)).sort()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    folderExists = false
  }

  const files = new Map<string, FileReport>()
  for (const name of names) {
    if (name.endsWith('.json') || name.endsWith('.json.bad')) files.set(name, await readFile(folder, name))
  }

  const namespaces: NamespaceReport[] = [...snapshots].sort((a, b) => a.id.localeCompare(b.id)).map(snapshot => {
    const file = files.get(`${snapshot.id}.json`)
    files.delete(`${snapshot.id}.json`)
    return {
      id: snapshot.id, owner: snapshot.owner, value: snapshot.value, defaults: snapshot.defaults,
      ...(snapshot.readOnly !== undefined && { readOnly: snapshot.readOnly }),
      ...(file && { file }),
      ...judge(snapshot, file),
      changed: changedFromDefaults(snapshot.defaults, snapshot.value)
    }
  })

  return { folder, folderExists, namespaces, others: [...files.values()], at: now.toISOString() }
}
