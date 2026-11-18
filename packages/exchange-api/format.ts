// The format seam: what a format plugin contributes (plain data) and what it provides (behaviour). A reader turns
// bytes into an `ExchangeDocument` and knows nothing about books, accounts, duplicates or the register — which is
// what makes every format testable as a pure function over a fixture.
import type { Json, Logger } from '@tessera/types'
import type { ExchangeDocument, ExchangeQuestion } from './model'

/** Extension point for `ExchangeFormatContribution`s, owned by the `exchange` plugin. */
export const FORMATS_POINT = 'exchange.formats'

export interface FormatCapabilities {
  read?: boolean
  write?: boolean
  /** The file can describe more than one account (a whole-book QIF). Changes the review view's header. */
  multiAccount?: boolean
  /** Rows carry a stable id, so duplicates are exact. Turns the heuristic matcher off for this format. */
  transactionIds?: boolean
}

/**
 * A file format, contributed as data with
 * `context.extensions.contribute(pluginId, FORMATS_POINT, id, contribution)`. Behaviour lives in the service it
 * names, so contributions stay validatable before any plugin code runs.
 */
export interface ExchangeFormatContribution {
  /** `<pluginId>.<name>`: 'exchange-ofx.qbo'. */
  id: string
  /** 'QuickBooks Web Connect (*.qbo)' — the file dialog's filter name and the dialog's list entry. */
  label: string
  /** Without dots: ['qbo']. */
  extensions: string[]
  /** The service implementing `ExchangeFormat`. */
  service: string
  /** A read-only format simply omits `write`. */
  capabilities: FormatCapabilities
  /** Tried in this order when sniffing an unknown file; lower first. */
  order?: number
}

/** A contribution as the pipeline and the dialogs receive it: valid, and with its defaults filled in. */
export interface ExchangeFormatDescriptor extends ExchangeFormatContribution {
  /** The plugin that contributed it. */
  contributor: string
  capabilities: Required<Pick<FormatCapabilities, 'read' | 'write' | 'multiAccount' | 'transactionIds'>>
  order: number
}

/** How many bytes of a file `sniff` is given. Enough for any header, small enough to read from a huge file. */
export const SNIFF_BYTES = 64 * 1024

export interface ReadContext {
  fileName: string
  /**
   * Which of the plugin's descriptors was chosen. One service may stand behind several — OFX, QFX and QBO are
   * one reader with three faces — so a format that reads more than one needs to be told which it is reading.
   */
  formatId: string
  /**
   * Answers already settled — by a saved link, a saved profile, an option, or the caller. A reader consults
   * these rather than asking, and `request` is for what is left. The distinction matters: a sign convention or
   * a date order that a previous import settled must not put a dialog in front of the user every month.
   */
  answers: Readonly<Record<string, Json>>
  /**
   * Answers the reader needs and cannot infer. `exchange` resolves each from a saved profile or link, from an
   * option, or from the user — and returns the answer. The reader stays a pure function of (bytes, answers),
   * which is exactly what a test wants to drive.
   *
   * Ask only what the read genuinely cannot proceed without. Something the user would merely like to adjust
   * belongs in `document.warnings`, where the review view can offer it without blocking the read.
   */
  request(question: ExchangeQuestion): Promise<Json>
  /** Progress for a large file, so a whole-book QIF does not look hung. */
  progress?(done: number, total: number): void
  log: Pick<Logger, 'warn'>
}

export interface WriteContext {
  /** Format-specific choices from the export dialog: the QIF flavour, the CSV delimiter, the OFX version. */
  options: Json
  log: Pick<Logger, 'warn'>
}

export interface ExchangeFormat {
  /**
   * Cheap check that these bytes are the format `formatId` names: a header line, a magic token, a first
   * record. Given the first `SNIFF_BYTES` only, and must not throw. The number lets a confident format outrank
   * a permissive one — OFX says 1 for an `OFXHEADER` line, CSV says 0.2 for anything with commas. 0 means
   * “not mine”.
   *
   * `formatId` is which descriptor is asking, because one service may stand behind several and they will not
   * all want to claim the same file.
   */
  sniff(head: Uint8Array, fileName: string, formatId: string): number
  /** Bytes → the neutral model. Throws an `ExchangeError` only when the file cannot be read at all. */
  read?(data: Uint8Array, context: ReadContext): Promise<ExchangeDocument>
  /** The neutral model → bytes. */
  write?(document: ExchangeDocument, context: WriteContext): Promise<Uint8Array>
}

/** Why a contribution cannot be used, or undefined. Exported so the point's rules are testable on their own. */
export function validateFormat(raw: unknown, contributor: string): string | undefined {
  if (typeof raw !== 'object' || raw === null) return `A format from “${contributor}” is not an object`
  const f = raw as Record<string, unknown>
  const text = (value: unknown) => typeof value === 'string' && value.trim() !== ''

  if (!text(f.id) || !(f.id as string).startsWith(`${contributor}.`)) {
    return `A format from “${contributor}” needs an id starting with “${contributor}.”`
  }
  const id = f.id as string
  if (!text(f.label)) return `Format “${id}” needs a label`
  if (!text(f.service)) return `Format “${id}” needs the service that implements it`
  if (!Array.isArray(f.extensions) || f.extensions.length === 0 || !f.extensions.every(text)) {
    return `Format “${id}” needs at least one file extension`
  }
  if ((f.extensions as string[]).some(e => e.includes('.'))) {
    return `Format “${id}” lists extensions with a dot; write “qif”, not “.qif”`
  }
  if (typeof f.capabilities !== 'object' || f.capabilities === null) return `Format “${id}” needs its capabilities`
  const caps = f.capabilities as Record<string, unknown>
  for (const key of ['read', 'write', 'multiAccount', 'transactionIds']) {
    if (caps[key] !== undefined && typeof caps[key] !== 'boolean') return `Format “${id}” has an invalid “${key}” capability`
  }
  if (caps.read !== true && caps.write !== true) return `Format “${id}” can neither read nor write`
  if (f.order !== undefined && (typeof f.order !== 'number' || !Number.isFinite(f.order))) {
    return `Format “${id}” has an invalid order`
  }
  return undefined
}

/** A validated contribution with its defaults filled in. */
export function toDescriptor(contribution: ExchangeFormatContribution, contributor: string): ExchangeFormatDescriptor {
  const { read, write, multiAccount, transactionIds } = contribution.capabilities
  return {
    ...contribution,
    contributor,
    extensions: contribution.extensions.map(e => e.trim().toLowerCase().replace(/^\./, '')),
    capabilities: {
      read: read === true,
      write: write === true,
      multiAccount: multiAccount === true,
      transactionIds: transactionIds === true
    },
    order: contribution.order ?? 0
  }
}

/** The extension of a file name, without the dot, lower case; empty when it has none. */
export function extensionOf(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? ''
  const at = base.lastIndexOf('.')
  return at <= 0 ? '' : base.slice(at + 1).toLowerCase()
}
