// The import.formats extension point: the file types installed format plugins can read. Contributions are plain data
// naming an ImportFormat service; this validates them, builds the file dialog's filters, and chooses a format for a
// file: by its extension, then by asking the candidates to sniff it. See docs/import-manager-design.md, "Choosing a
// format".
import type { ExtensionRegistry, FileFilter, Logger, ServiceRegistry } from '@tessera/types'
import {
  IMPORT_FORMATS_POINT,
  type ImportFormat, type ImportFormatContribution, type ImportFormatInfo, type ImportSample
} from '@tessera/import-api'

const text = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''

function problemWith(raw: unknown, contributor: string): string | undefined {
  if (typeof raw !== 'object' || raw === null) return `An import format from "${contributor}" is not an object`
  const f = raw as Record<string, unknown>
  if (!text(f.id) || !f.id.startsWith(`${contributor}.`)) return `An import format from "${contributor}" needs an id starting with "${contributor}."`
  if (!text(f.label)) return `Import format "${f.id}" needs a label`
  if (!text(f.service)) return `Import format "${f.id}" needs a service`
  if (!Array.isArray(f.extensions) || f.extensions.length === 0 || f.extensions.some(e => typeof e !== 'string' || !/^[a-z0-9]+$/.test(e))) {
    return `Import format "${f.id}" needs extensions in lower case, without dots, such as ["ofx", "qfx"]`
  }
  if (f.order !== undefined && (typeof f.order !== 'number' || !Number.isFinite(f.order))) return `Import format "${f.id}" has an invalid order`
}

/** The outcome of choosing a format for a file. */
export type FormatChoice =
  | { kind: 'one', format: ImportFormatContribution }
  | { kind: 'several', formats: ImportFormatContribution[] }
  | { kind: 'none' }

export class Formats {
  private readonly warned = new Set<string>()

  constructor(
    private readonly extensions: Pick<ExtensionRegistry, 'getContributions'>,
    private readonly services: Pick<ServiceRegistry, 'has' | 'get'>,
    private readonly log: Pick<Logger, 'warn'>
  ) {}

  private warn(problem: string) {
    if (this.warned.has(problem)) return
    this.warned.add(problem)
    this.log.warn(`[import] ${problem}`)
  }

  /** The valid contributions, by order then label. Invalid ones are skipped with one warning each. */
  all(): ImportFormatContribution[] {
    const valid: ImportFormatContribution[] = []
    const seen = new Set<string>()
    for (const { contributor, impl } of this.extensions.getContributions(IMPORT_FORMATS_POINT)) {
      const id = (impl as { id?: unknown } | null)?.id
      const problem = problemWith(impl, contributor) ?? (seen.has(id as string) ? `Duplicate import format "${id}" ignored` : undefined)
      if (problem) { this.warn(problem); continue }
      seen.add(id as string)
      valid.push(impl as ImportFormatContribution)
    }
    return valid.sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.label.localeCompare(b.label))
  }

  info(): ImportFormatInfo[] {
    return this.all().map(({ id, label, extensions, description }) => ({ id, label, extensions: [...extensions], ...(description && { description }) }))
  }

  /** The file dialog's filters: every importable file first (the default), then one per format, then all files. */
  filters(): FileFilter[] {
    const all = this.all()
    const extensions = [...new Set(all.flatMap(format => format.extensions))]
    return [
      { name: 'All supported statements', extensions },
      ...all.map(format => ({ name: format.label, extensions: [...format.extensions] })),
      { name: 'All files', extensions: ['*'] }
    ]
  }

  /** The service behind a format, or undefined when its plugin doesn't provide it (or it isn't one). */
  service(format: ImportFormatContribution): ImportFormat | undefined {
    if (!this.services.has(format.service)) return undefined
    const service = this.services.get<ImportFormat>(format.service)
    return typeof service?.parse === 'function' ? service : undefined
  }

  /**
   * The format for a file: those claiming its extension (all of them when none does); when more than one, those
   * whose sniff says yes, plus those that can't sniff ("maybe"). A sniff that throws says no.
   */
  async choose(sample: ImportSample): Promise<FormatChoice> {
    const all = this.all().filter(format => this.service(format) !== undefined)
    const byExtension = all.filter(format => format.extensions.includes(sample.extension))
    if (byExtension.length === 1) return { kind: 'one', format: byExtension[0] }
    const candidates = byExtension.length > 0 ? byExtension : all
    const verdicts = await Promise.all(candidates.map(async format => {
      const sniff = this.service(format)?.sniff
      if (!sniff) return 'maybe' as const
      try { return (await sniff.call(this.service(format), sample)) ? 'yes' as const : 'no' as const } catch { return 'no' as const }
    }))
    const yes = candidates.filter((_, i) => verdicts[i] === 'yes')
    const maybe = candidates.filter((_, i) => verdicts[i] === 'maybe')
    // A format that recognised the file beats those that can't tell
    const found = yes.length > 0 ? (yes.length === 1 && byExtension.length === 0 ? yes : [...yes, ...maybe]) : maybe
    if (found.length === 1) return { kind: 'one', format: found[0] }
    return found.length > 1 ? { kind: 'several', formats: found } : { kind: 'none' }
  }
}
