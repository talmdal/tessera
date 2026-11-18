// The `exchange.formats` extension point: collecting contributions, validating them, and choosing which format
// reads a given file. The point validates its own contributions (the framework has no declared points yet, see
// docs/todo.md), skips the invalid ones, and warns once about each problem rather than on every read.
import type { ExtensionRegistry, Logger, ServiceRegistry } from '@tessera/types'
import {
  ExchangeError, FORMATS_POINT, SNIFF_BYTES, extensionOf, toDescriptor, validateFormat,
  type ExchangeFormat, type ExchangeFormatContribution, type ExchangeFormatDescriptor
} from '@tessera/exchange-api'

export interface FormatsDeps {
  extensions: Pick<ExtensionRegistry, 'getContributions'>
  services: Pick<ServiceRegistry, 'get' | 'has'>
  log: Pick<Logger, 'warn'>
}

/**
 * The installed formats. Contributions are read on every call — a plugin may contribute after activation — but
 * each distinct problem is warned about once, with the `[exchange]` prefix the shell's diagnostics use.
 */
export class FormatRegistry {
  private readonly warned = new Set<string>()

  constructor(private readonly deps: FormatsDeps) {}

  private warn(problem: string) {
    if (this.warned.has(problem)) return
    this.warned.add(problem)
    this.deps.log.warn(`[exchange] ${problem}`)
  }

  /** Every valid descriptor, by `order` then as contributed, duplicate ids and extensions dropped. */
  all(): ExchangeFormatDescriptor[] {
    const valid: { item: ExchangeFormatDescriptor, seq: number }[] = []
    const seenId = new Set<string>()
    const seenExtension = new Map<string, string>()

    this.deps.extensions.getContributions(FORMATS_POINT).forEach(({ contributor, impl }, seq) => {
      const problem = validateFormat(impl, contributor)
      if (problem) { this.warn(problem); return }

      const descriptor = toDescriptor(impl as ExchangeFormatContribution, contributor)
      if (seenId.has(descriptor.id)) { this.warn(`Duplicate format “${descriptor.id}” ignored`); return }
      // A format whose service is missing would fail at read time with a confusing error; drop it now instead
      if (!this.deps.services.has(descriptor.service)) {
        this.warn(`Format “${descriptor.id}” names the service “${descriptor.service}”, which nothing provides`)
        return
      }
      const clash = descriptor.extensions.find(e => seenExtension.has(e))
      if (clash !== undefined) {
        // Not fatal: sniffing still tells them apart, and the user can choose the format in the dialog
        this.warn(`Formats “${seenExtension.get(clash)}” and “${descriptor.id}” both claim “.${clash}”`)
      }
      for (const e of descriptor.extensions) if (!seenExtension.has(e)) seenExtension.set(e, descriptor.id)

      seenId.add(descriptor.id)
      valid.push({ item: descriptor, seq })
    })

    return valid.sort((a, b) => a.item.order - b.item.order || a.seq - b.seq).map(v => v.item)
  }

  /** The formats that can read, for the open dialog's filters. */
  readable(): ExchangeFormatDescriptor[] {
    return this.all().filter(f => f.capabilities.read)
  }

  /** The formats that can write, for the export dialog. */
  writable(): ExchangeFormatDescriptor[] {
    return this.all().filter(f => f.capabilities.write)
  }

  get(id: string): ExchangeFormatDescriptor | undefined {
    return this.all().find(f => f.id === id)
  }

  /** The behaviour behind a descriptor. */
  implementation(descriptor: ExchangeFormatDescriptor): ExchangeFormat {
    try {
      return this.deps.services.get<ExchangeFormat>(descriptor.service)
    } catch {
      throw new ExchangeError('UNKNOWN_FORMAT', `The plugin that reads ${descriptor.label} is not available.`)
    }
  }

  /**
   * Which format reads this file: the one the user chose, else the one claiming its extension, else the one
   * that recognises its first bytes. Extension before content, because `.qfx` and `.qbo` are structurally
   * identical and only the extension tells them apart — while a `.txt` full of OFX is still OFX.
   */
  choose(fileName: string, data: Uint8Array, formatId?: string): ExchangeFormatDescriptor {
    const readable = this.readable()
    if (readable.length === 0) {
      throw new ExchangeError('UNKNOWN_FORMAT', 'No file formats are installed, so there is nothing to import.')
    }

    if (formatId !== undefined) {
      const chosen = readable.find(f => f.id === formatId)
      if (!chosen) throw new ExchangeError('UNKNOWN_FORMAT', 'That file format is not installed.', 'formatId')
      return chosen
    }

    const extension = extensionOf(fileName)
    const byExtension = extension === '' ? [] : readable.filter(f => f.extensions.includes(extension))
    if (byExtension.length === 1) return byExtension[0]

    // Several claim the extension, or none does: ask the content. Candidates keep their extension's head start.
    const candidates = byExtension.length > 1 ? byExtension : readable
    const head = data.subarray(0, SNIFF_BYTES)
    const scored = candidates
      .map(descriptor => ({ descriptor, score: this.sniff(descriptor, head, fileName) }))
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score || a.descriptor.order - b.descriptor.order)

    if (scored.length === 0) {
      const tried = candidates.map(f => f.label).join(', ')
      throw new ExchangeError('UNKNOWN_FORMAT', `Tessera could not tell what kind of file this is. It tried: ${tried}.`)
    }
    if (scored.length > 1 && scored[0].score === scored[1].score) {
      const tied = scored.filter(s => s.score === scored[0].score).map(s => s.descriptor.label).join(' and ')
      throw new ExchangeError('UNKNOWN_FORMAT', `This file could be ${tied}. Choose the format and try again.`)
    }
    return scored[0].descriptor
  }

  /** A format's own opinion of the bytes. A reader that throws here is broken, not the file: score it 0. */
  private sniff(descriptor: ExchangeFormatDescriptor, head: Uint8Array, fileName: string): number {
    let format: ExchangeFormat
    try {
      format = this.implementation(descriptor)
    } catch { return 0 }
    try {
      const score = format.sniff(head, fileName, descriptor.id)
      return typeof score === 'number' && Number.isFinite(score) && score > 0 ? Math.min(score, 1) : 0
    } catch (err) {
      this.deps.log.warn(`[exchange] Format “${descriptor.id}” failed to sniff a file: ${String(err)}`)
      return 0
    }
  }
}
