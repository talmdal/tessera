// The `exchange.exportOptions` extension point: collecting what each format wants to ask in the export dialog.
//
// Like `exchange.formats`, the point validates its own contributions, skips the invalid ones, and warns once
// about each problem rather than on every export. A format that contributes nothing is the normal case, not an
// error — OFX has no choices to offer, and asking for none is a position rather than an omission.
import type { ExtensionRegistry, Json, Logger } from '@tessera/types'
import {
  EXPORT_OPTIONS_POINT, exportOptionDefaults, exportOptionValue, validateExportOptions,
  type ExportOptionField, type ExportOptionsContribution
} from '@tessera/exchange-api'

export interface ExportOptionsDeps {
  extensions: Pick<ExtensionRegistry, 'getContributions'>
  log: Pick<Logger, 'warn'>
}

export class ExportOptionsRegistry {
  private readonly warned = new Set<string>()

  constructor(private readonly deps: ExportOptionsDeps) {}

  private warn(problem: string) {
    if (this.warned.has(problem)) return
    this.warned.add(problem)
    this.deps.log.warn(`[exchange] ${problem}`)
  }

  /** The fields a format asks for, in contribution order. Empty when it asks for nothing. */
  fields(formatId: string): ExportOptionField[] {
    const fields: ExportOptionField[] = []
    const seenKey = new Set<string>()

    for (const { contributor, impl } of this.deps.extensions.getContributions(EXPORT_OPTIONS_POINT)) {
      const problem = validateExportOptions(impl, contributor)
      if (problem !== undefined) { this.warn(problem); continue }

      const contribution = impl as ExportOptionsContribution
      if (contribution.formatId !== formatId) continue
      for (const field of contribution.fields) {
        // Two contributions for one format are allowed, but they may not both claim a key: the second would
        // silently overwrite the first in `formatOptions`.
        if (seenKey.has(field.key)) {
          this.warn(`Two export options for “${formatId}” both use the key “${field.key}”; the second was ignored`)
          continue
        }
        seenKey.add(field.key)
        fields.push(field)
      }
    }
    return fields
  }

  /** What a format's options start at, for a caller that never opens the dialog. */
  defaults(formatId: string): Record<string, Json> {
    return exportOptionDefaults(this.fields(formatId))
  }

  /**
   * A dialog's answers, checked against what the format actually asked for: unknown keys are dropped and a
   * value of the wrong shape falls back to the field's default. A writer can then read `context.options`
   * without re-validating, which is the point of having the fields declared at all.
   */
  resolve(formatId: string, given: Json | undefined): Record<string, Json> {
    const values: Record<string, Json> = {}
    for (const field of this.fields(formatId)) values[field.key] = exportOptionValue(field, given)
    return values
  }
}
