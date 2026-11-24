// What a saved report keeps of a report as shown (phase R4): its basis (the definition and the option values, or a
// spec of its own), the heading's parameters, and what the view shows. Save Report and Save Report As… both make it
// here, so they can't differ. See docs/reporting-design.md, "Customising and saving reports".
import {
  ReportsError, TOP_OPTION, applyTop,
  type OptionValues, type ReportRef, type SavedReport, type SavedReportInput, type ViewChoices
} from '@tessera/reports-api'
import type { ReportsServiceImpl } from './ReportsServiceImpl'

/**
 * The basis for a report shown as `ref` with `options`: a definition's id and option values; a saved report's own basis,
 * with the options now chosen; or, for a spec of its own, the spec with *Show the top* written into it (it has no
 * options to keep it in).
 */
export async function basisFor(service: ReportsServiceImpl, ref: ReportRef, options: OptionValues = {}): Promise<SavedReportInput['basis']> {
  if ('definitionId' in ref) return { kind: 'definition', definitionId: ref.definitionId, options: { ...options } }
  const saved = (await service.saved()).find(s => s.id === ref.savedId)
  if (!saved) throw new ReportsError('NOT_FOUND', 'That saved report no longer exists.', 'savedId')
  return basisOf(saved, options)
}

export function basisOf(saved: SavedReport, options: OptionValues = {}): SavedReportInput['basis'] {
  if (saved.basis.kind === 'definition') return { kind: 'definition', definitionId: saved.basis.definitionId, options: { ...options } }
  const top = options[TOP_OPTION]
  return { kind: 'spec', spec: top === undefined ? saved.basis.spec : applyTop(saved.basis.spec, { [TOP_OPTION]: top }, 0) }
}

/** What is kept of what the view shows: the chart or table, and the rows folded (when any are). */
export function viewOf(view?: ViewChoices): SavedReport['view'] | undefined {
  if (!view) return undefined
  const out: NonNullable<SavedReport['view']> = {}
  if (view.show === 'chart' || view.show === 'table' || view.show === 'both') out.show = view.show
  if (Array.isArray(view.collapsed) && view.collapsed.length > 0) out.collapsed = view.collapsed.filter((c): c is string => typeof c === 'string')
  return Object.keys(out).length > 0 ? out : undefined
}
