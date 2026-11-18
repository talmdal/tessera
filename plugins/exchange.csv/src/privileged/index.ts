// The `exchange-csv` plugin: delimited files, which are not one format but a family. The reader is told what
// the columns mean — once, through the mapping dialog — and the book remembers the answer against a
// fingerprint of the file's header, so next month's statement from the same bank is read without a question.
// See docs/import-export-design.md, "CSV".
import type { PluginContext } from '@tessera/types'
import {
  EXPORT_OPTIONS_POINT, FORMATS_POINT, SNIFF_BYTES,
  type ExchangeFormat, type ExchangeFormatContribution, type ExportOptionsContribution,
  type ReadContext, type WriteContext
} from '@tessera/exchange-api'
import { readCsv } from './reader'
import { writeCsv, CSV_WRITE_DEFAULTS } from './writer'

export const CSV_PLUGIN_ID = 'exchange-csv'
export const CSV_FORMAT_SERVICE = 'exchange-csv.format'
export const CSV_FORMAT = 'exchange-csv.csv'

export const DESCRIPTORS: ExchangeFormatContribution[] = [
  {
    id: CSV_FORMAT,
    label: 'Comma-Separated Values (*.csv)',
    // Not `txt`: the registry returns the sole format claiming an extension without sniffing at all, so
    // claiming it would hand CSV every `.txt` — including the OFX-in-a-.txt that `choose` means to protect.
    // A delimited file under another name is reachable by choosing the format in the dialog.
    extensions: ['csv', 'tsv'],
    service: CSV_FORMAT_SERVICE,
    // One account per file. A CSV has no way to say where one account's rows end and the next begin that its
    // reader could rely on, so a file written with several came back as one statement with every account's
    // rows mixed together. Exporting several accounts is refused up front instead; QIF is the format for that.
    // `transactionIds` is false because most exports carry none, and a profile that maps `externalId` does not
    // change the descriptor.
    capabilities: { read: true, write: true, multiAccount: false },
    // Last: CSV is the permissive format, and anything that another reader recognises should go to that
    // reader. A `.qif` full of commas must not be claimed here.
    order: 100
  }
]

/**
 * CSV has no magic number, so this is deliberately weak: a confident claim only for a `.csv` or `.tsv` name,
 * and a low one for any text that splits into consistent rows. 0.2 is below every real format's claim, which
 * is what lets CSV be the fallback without stealing files from readers that actually know what they are.
 */
export function sniffCsv(head: Uint8Array, fileName: string): number {
  const text = new TextDecoder('utf-8').decode(head.subarray(0, SNIFF_BYTES))
  if (text.trim() === '') return 0
  // Anything with a format's own header is not CSV, whatever its extension says.
  if (/^\s*(OFXHEADER|<\?xml|<OFX|!Type:|!Account)/i.test(text)) return 0

  const extension = (fileName.split(/[\\/]/).pop() ?? '').split('.').pop()?.toLowerCase()
  const lines = text.split(/\r\n|\n|\r/).filter(line => line.trim() !== '').slice(0, 10)
  if (lines.length < 2) return 0

  const delimited = [',', ';', '\t', '|'].some(d => {
    const counts = lines.map(line => line.split(d).length)
    return counts[0] > 1 && counts.every(n => n === counts[0])
  })
  if (extension === 'csv' || extension === 'tsv') return delimited ? 0.9 : 0.6
  return delimited ? 0.2 : 0
}

const writeOptionsFrom = (context: WriteContext) => {
  const options = context.options
  const bag = typeof options === 'object' && options !== null && !Array.isArray(options) ? options : {}
  return {
    delimiter: typeof bag.delimiter === 'string' && bag.delimiter !== '' ? bag.delimiter : CSV_WRITE_DEFAULTS.delimiter,
    bom: typeof bag.bom === 'boolean' ? bag.bom : CSV_WRITE_DEFAULTS.bom
  }
}

export const csvFormat: ExchangeFormat = {
  sniff: (head, fileName) => sniffCsv(head, fileName),
  read: (data, context: ReadContext) => readCsv(data, {
    formatId: context.formatId,
    fileName: context.fileName,
    answers: context.answers,
    request: question => context.request(question),
    ...(context.progress !== undefined && { progress: context.progress })
  }),
  write: async (document, context) => writeCsv(document, writeOptionsFrom(context))
}

/**
 * What only CSV can be asked about. The BOM is on by default and is worth a switch rather than a decision:
 * Excel reads a BOM-less UTF-8 file as the local code page and mangles every non-ASCII payee, while some
 * command-line tools treat the BOM as part of the first field name. Both of those people exist.
 */
export const EXPORT_OPTIONS: ExportOptionsContribution = {
  formatId: CSV_FORMAT,
  fields: [
    {
      kind: 'choice',
      key: 'delimiter',
      label: 'Separator',
      options: [
        { value: ',', label: 'Comma' },
        { value: ';', label: 'Semicolon', detail: 'what Excel expects in a comma-decimal locale' },
        { value: '\t', label: 'Tab' }
      ],
      default: ','
    },
    {
      kind: 'boolean',
      key: 'bom',
      label: 'Add a byte-order mark',
      detail: 'Excel needs it to read accented names correctly; some other tools would rather it were absent',
      default: true
    }
  ]
}

export async function activate(context: PluginContext) {
  context.subscriptions.push(
    context.services.provide(CSV_PLUGIN_ID, CSV_FORMAT_SERVICE, csvFormat),
    ...DESCRIPTORS.map(descriptor =>
      context.extensions.contribute(CSV_PLUGIN_ID, FORMATS_POINT, descriptor.id, descriptor)),
    context.extensions.contribute(CSV_PLUGIN_ID, EXPORT_OPTIONS_POINT, CSV_FORMAT, EXPORT_OPTIONS)
  )
}

export { readCsv, writeCsv }
