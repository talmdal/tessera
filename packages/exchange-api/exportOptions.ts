// The seam that lets a format plugin add its own questions to the export dialog.
//
// The `exchange` plugin owns the dialog — what to export, over what period, in what format, and what to leave
// out are the same questions whatever the format, and a dialog per format would be four dialogs to keep
// consistent. What differs is the handful of choices only one format has: the QIF flavour, the CSV delimiter.
// Those arrive here.
//
// Contributed as **plain data**, not as a renderer module, for two reasons. A format plugin is privileged-only
// today — `exchange-ofx`, `exchange-qif` and `exchange-csv` ship no renderer bundle at all — and requiring one
// just to offer a checkbox would be a large cost for a small thing. And data can be validated before any
// plugin code runs, which is the same reason `ExchangeFormatContribution` is data; see `format.ts`.
//
// The point is **optional**. A format that has nothing to ask contributes nothing and its section of the
// dialog simply does not appear. See docs/import-export-design.md#the-export-dialog.
import type { Json } from '@tessera/types'

/** Extension point for `ExportOptionsContribution`s, owned by the `exchange` plugin. */
export const EXPORT_OPTIONS_POINT = 'exchange.exportOptions'

export interface ExportOptionChoice {
  value: string
  label: string
  detail?: string
}

/**
 * One question. Deliberately a small, closed set of shapes: everything a writer has actually needed is a
 * choice, a switch or a short piece of text, and a richer vocabulary would be a licence to put a form in front
 * of a user who only wants a file.
 */
export type ExportOptionField =
  | {
    kind: 'choice'
    /** The key this lands under in `ExportRequest.formatOptions`. */
    key: string
    label: string
    detail?: string
    options: ExportOptionChoice[]
    default: string
  }
  | { kind: 'boolean', key: string, label: string, detail?: string, default: boolean }
  | { kind: 'text', key: string, label: string, detail?: string, default: string, maxLength?: number }

export interface ExportOptionsContribution {
  /**
   * The format descriptor these belong to — `exchange-qif.qif`. One contribution per descriptor, so a plugin
   * standing behind several (OFX, QFX and QBO are one reader with three faces) can ask different things for
   * each, or nothing for the ones it cannot write.
   */
  formatId: string
  fields: ExportOptionField[]
}

/** Why a contribution cannot be used, or undefined. Exported so the point's rules are testable on their own. */
export function validateExportOptions(raw: unknown, contributor: string): string | undefined {
  if (typeof raw !== 'object' || raw === null) return `Export options from “${contributor}” are not an object`
  const c = raw as Record<string, unknown>
  const text = (value: unknown) => typeof value === 'string' && value.trim() !== ''

  if (!text(c.formatId)) return `Export options from “${contributor}” need the format they belong to`
  const formatId = c.formatId as string
  if (!(formatId).startsWith(`${contributor}.`)) {
    return `Export options from “${contributor}” name the format “${formatId}”, which is not theirs`
  }
  if (!Array.isArray(c.fields) || c.fields.length === 0) {
    return `Export options for “${formatId}” list no fields`
  }

  const seen = new Set<string>()
  for (const raw of c.fields as unknown[]) {
    if (typeof raw !== 'object' || raw === null) return `A field of “${formatId}” is not an object`
    const field = raw as Record<string, unknown>
    if (!text(field.key)) return `A field of “${formatId}” needs a key`
    const key = field.key as string
    // A dotted key would be unwritable if a profile ever saved one, and is confusing in `formatOptions`
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(key)) {
      return `Field “${key}” of “${formatId}” needs a plain key: letters and digits, starting with a letter`
    }
    if (seen.has(key)) return `“${formatId}” lists the field “${key}” twice`
    seen.add(key)
    if (!text(field.label)) return `Field “${key}” of “${formatId}” needs a label`

    switch (field.kind) {
      case 'boolean':
        if (typeof field.default !== 'boolean') return `Field “${key}” of “${formatId}” needs a true or false default`
        break
      case 'text':
        if (typeof field.default !== 'string') return `Field “${key}” of “${formatId}” needs a text default`
        break
      case 'choice': {
        if (!Array.isArray(field.options) || field.options.length === 0) {
          return `Field “${key}” of “${formatId}” needs at least one option`
        }
        const values = new Set<string>()
        for (const option of field.options as unknown[]) {
          if (typeof option !== 'object' || option === null) return `An option of “${key}” is not an object`
          const o = option as Record<string, unknown>
          // The value may be whitespace — a tab is a perfectly good CSV delimiter — but it must not be empty,
          // and the label the user reads must be real text.
          if (typeof o.value !== 'string' || o.value === '') return `An option of “${key}” needs a value`
          if (!text(o.label)) return `An option of “${key}” needs a label`
          values.add(o.value)
        }
        // A default that is not one of the options would leave the dialog showing nothing chosen
        if (typeof field.default !== 'string' || !values.has(field.default)) {
          return `Field “${key}” of “${formatId}” defaults to something that is not one of its options`
        }
        break
      }
      default:
        return `Field “${key}” of “${formatId}” has an unknown kind “${String(field.kind)}”`
    }
  }
  return undefined
}

/**
 * The values a set of fields starts at. Also what a caller that never opens the dialog gets — `exchange.export`
 * is a service method as much as a menu item, and a script calling it should not have to know a format's
 * defaults to get the file that format's own dialog would have produced.
 */
export function exportOptionDefaults(fields: readonly ExportOptionField[]): Record<string, Json> {
  const values: Record<string, Json> = {}
  for (const field of fields) values[field.key] = field.default
  return values
}

/** A field's value out of a `formatOptions` bag, falling back to the default when it is absent or the wrong type. */
export function exportOptionValue(field: ExportOptionField, options: Json | undefined): Json {
  const bag = typeof options === 'object' && options !== null && !Array.isArray(options)
    ? options as Record<string, Json>
    : {}
  const given = bag[field.key]
  if (given === undefined) return field.default
  switch (field.kind) {
    case 'boolean': return typeof given === 'boolean' ? given : field.default
    case 'text': return typeof given === 'string' ? given : field.default
    case 'choice':
      return typeof given === 'string' && field.options.some(o => o.value === given) ? given : field.default
  }
}
