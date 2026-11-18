// The `exchange-qif` plugin: Quicken Interchange Format, read in both dialects and both forms — a bare
// statement, or a whole data file with several accounts and a category list — and written in either flavour.
// Microsoft Money has no other way out, so this reader is how its users arrive. See
// docs/import-export-design.md, "QIF, and its two dialects".
import type { PluginContext } from '@tessera/types'
import {
  EXPORT_OPTIONS_POINT, FORMATS_POINT, SNIFF_BYTES,
  type ExchangeFormat, type ExchangeFormatContribution, type ExportOptionsContribution,
  type ReadContext, type WriteContext
} from '@tessera/exchange-api'
import { DATE_ORDER_QUESTION, readQif } from './reader'
import { writeQif, type QifFlavour } from './writer'

export const QIF_PLUGIN_ID = 'exchange-qif'
export const QIF_FORMAT_SERVICE = 'exchange-qif.format'
export const QIF_FORMAT = 'exchange-qif.qif'

export const DESCRIPTORS: ExchangeFormatContribution[] = [
  {
    id: QIF_FORMAT,
    label: 'Quicken Interchange Format (*.qif)',
    extensions: ['qif'],
    service: QIF_FORMAT_SERVICE,
    capabilities: { read: true, write: true, multiAccount: true },
    order: 20
  }
]

/** A `!Type:` or `!Account` control line near the start, or a record ended by `^`, says QIF. */
export function sniffQif(head: Uint8Array): number {
  const text = new TextDecoder('latin1').decode(head.subarray(0, SNIFF_BYTES))
  if (/^!(Type:|Account|Option:AutoSwitch)/m.test(text)) return 1
  if (/^\^\s*$/m.test(text) && /^[DT]/m.test(text)) return 0.5
  return 0
}

/** The date order an earlier import settled, when the caller carries one. */
const dateOrderFrom = (context: Pick<ReadContext, 'answers'>): 'dmy' | 'mdy' | undefined => {
  const answer = context.answers?.[DATE_ORDER_QUESTION]
  return answer === 'dmy' || answer === 'mdy' ? answer : undefined
}

const flavourFrom = (context: WriteContext): QifFlavour => {
  const options = context.options
  const flavour = typeof options === 'object' && options !== null && !Array.isArray(options) ? options.flavour : undefined
  return flavour === 'standard' ? 'standard' : 'microsoft'
}

export const qifFormat: ExchangeFormat = {
  sniff: head => sniffQif(head),
  read: (data, context) => readQif(data, {
    formatId: context.formatId,
    ...(dateOrderFrom(context) !== undefined && { dateOrder: dateOrderFrom(context)! }),
    request: question => context.request(question),
    ...(context.progress !== undefined && { progress: context.progress })
  }),
  write: async (document, context) => writeQif(document, flavourFrom(context))
}

/**
 * The one thing only QIF can be asked about. Microsoft's flavour writes names whole and dates as `M/D/YYYY`;
 * the standard cuts payee, memo and category at fifteen characters — so the choice is between a file Money and
 * Quicken read back exactly and one older programs accept, and only the user knows which they are feeding.
 */
export const EXPORT_OPTIONS: ExportOptionsContribution = {
  formatId: QIF_FORMAT,
  fields: [
    {
      kind: 'choice',
      key: 'flavour',
      label: 'QIF flavour',
      detail: 'Which dialect the receiving program expects',
      options: [
        { value: 'microsoft', label: 'Microsoft Money', detail: 'names in full, dates as M/D/YYYY' },
        { value: 'standard', label: 'Quicken (standard)', detail: 'names cut at 15 characters' }
      ],
      default: 'microsoft'
    }
  ]
}

export async function activate(context: PluginContext) {
  context.subscriptions.push(
    context.services.provide(QIF_PLUGIN_ID, QIF_FORMAT_SERVICE, qifFormat),
    ...DESCRIPTORS.map(descriptor =>
      context.extensions.contribute(QIF_PLUGIN_ID, FORMATS_POINT, descriptor.id, descriptor)),
    context.extensions.contribute(QIF_PLUGIN_ID, EXPORT_OPTIONS_POINT, QIF_FORMAT, EXPORT_OPTIONS)
  )
}

export { readQif, writeQif, DATE_ORDER_QUESTION }
