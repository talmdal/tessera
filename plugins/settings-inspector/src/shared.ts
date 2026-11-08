// What the inspector's privileged half reports to its dialog. Plain data: it crosses IPC.
import type { Json, JsonObject } from '@tessera/types'

export const INSPECTOR_PLUGIN_ID = 'settings-inspector'

export const INSPECTOR = {
  /** Tools › Settings Inspector…: shows the dialog. */
  command: 'settings-inspector.show',
  dialog: 'settings-inspector.dialog',
  /** → `InspectorReport`, read fresh from the settings and the disk. */
  report: 'settings-inspector:report'
} as const

/**
 * How what is in effect compares with what is on disk:
 * - `defaults`: no file, and every setting is at its default. As it should be: only differences are saved.
 * - `matches`: the file, merged over the defaults, is exactly what is in effect.
 * - `differs`: they disagree (see the note for why it can happen).
 * - `unreadable`: the file isn't valid JSON, or isn't `{ version, values }`.
 */
export type Check = 'defaults' | 'matches' | 'differs' | 'unreadable'

export interface FileReport {
  /** The file's name, `ledger.json`. */
  name: string
  path: string
  /** Exactly what is on disk. */
  text: string
  /** When it was last written, ISO. */
  modified: string
  /** What the file says, when it is in the expected form. */
  version?: number
  values?: JsonObject
  /** Why it can't be used, when it can't. */
  problem?: string
}

export interface NamespaceReport {
  id: string
  owner: string
  /** What plugins read now: the defaults with the saved values merged over them. */
  value: JsonObject
  defaults: JsonObject
  readOnly?: string
  file?: FileReport
  check: Check
  /** The check, in words. */
  note: string
  /** The settings that differ from their defaults, as dotted paths. */
  changed: string[]
}

export interface InspectorReport {
  /** The settings folder, `<userData>/settings`. */
  folder: string
  folderExists: boolean
  namespaces: NamespaceReport[]
  /** Files no registered namespace reads: a plugin that isn't installed or active, and files set aside (`.bad`). */
  others: FileReport[]
  /** When the report was made, ISO. */
  at: string
}

export type { Json }
