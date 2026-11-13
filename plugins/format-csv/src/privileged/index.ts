// The CSV file-type plugin: banks' CSV exports. Every file's layout is shown in the CSV Columns dialog for confirmation,
// guessed the first time and remembered after. It turns a file into neutral statements; the import manager does
// everything else. `.txt` isn't claimed (a CSV export named so is imported through All files, and sniffed).
// One plugin per file type, reading and (from docs/export-design.md, phase X1) writing.
// See docs/import-formats-design.md, "CSV".
import { DIALOGS_EXTENSION_POINT, type DialogContribution, type PluginContext } from '@tessera/types'
import { IMPORT_FORMATS_POINT, type ImportFormat, type ImportFormatContribution, type ImportSample } from '@tessera/import-api'
import { EXPORT_FORMATS_POINT } from '@tessera/export-api'
import { detectDelimiter } from '../shared/csv'
import { LAYOUT_DIALOG } from '../shared/dialog'
import { CSV_EXPORT, csvExport } from './export'
import { correctCsv, describeCsvMemory, parseCsvFile, type CsvOptions } from './parse'

export const CSV_FORMAT: ImportFormatContribution = {
  id: 'format-csv.csv',
  label: 'CSV file (comma-separated values)',
  extensions: ['csv'],
  service: 'format-csv.import',
  description: 'The spreadsheet-style exports most banks offer. Tessera shows its columns for you to check.',
  order: 10
}

export const LAYOUT_DIALOG_CONTRIBUTION: DialogContribution = { id: LAYOUT_DIALOG, title: 'CSV Columns', module: './LayoutDialog', size: 'lg' }

/** The start of a file as text: UTF-16 when it has that byte-order mark, otherwise Latin-1 (enough to see its shape). */
function headText(head: Uint8Array): string {
  if (head[0] === 0xff && head[1] === 0xfe) return new TextDecoder('utf-16le').decode(head.subarray(2))
  if (head[0] === 0xfe && head[1] === 0xff) return new TextDecoder('utf-16be').decode(head.subarray(2))
  return new TextDecoder('latin1').decode(head)
}

/**
 * True for the start of a CSV file: lines that split into the same number of cells (2 or more), most of them, and a
 * first line that isn't QIF's '!Type:' or an OFX or XML header.
 */
export function looksLikeCsv(sample: ImportSample): boolean {
  const text = headText(sample.head).replace(/^\uFEFF/, '').replace(/^ï»¿/, '')
  const lines = text.split(/\r\n|\r|\n/)
  if (sample.head.length >= 4096) lines.pop()                    // the last line may be cut short
  const filled = lines.filter(l => l.trim() !== '').slice(0, 30)
  if (filled.length < 2) return false
  if (/^\s*(!|<|OFXHEADER)/i.test(filled[0])) return false
  const delimiter = detectDelimiter(filled.join('\n'))
  const counts = filled.map(line => {
    let n = 1
    let quoted = false
    for (const ch of line) { if (ch === '"') quoted = !quoted; else if (ch === delimiter && !quoted) n++ }
    return n
  })
  const tally = new Map<number, number>()
  for (const n of counts) if (n >= 2) tally.set(n, (tally.get(n) ?? 0) + 1)
  const most = Math.max(0, ...tally.values())
  return most >= 2 && most >= 0.6 * filled.length
}

export function createCsvFormat(options: CsvOptions = {}): ImportFormat {
  return {
    sniff: looksLikeCsv,
    parse: (file, context) => parseCsvFile(file, context, options),
    correct: (correction, { memory }) => correctCsv(correction, memory),
    describeMemory: describeCsvMemory
  }
}

export function activate(context: PluginContext, options: CsvOptions = {}) {
  context.subscriptions.push(
    context.extensions.contribute('format-csv', IMPORT_FORMATS_POINT, CSV_FORMAT.id, CSV_FORMAT),
    context.extensions.contribute('format-csv', DIALOGS_EXTENSION_POINT, LAYOUT_DIALOG_CONTRIBUTION.id, LAYOUT_DIALOG_CONTRIBUTION),
    context.services.provide('format-csv', CSV_FORMAT.service, createCsvFormat(options)),
    // Writing CSV, for File › Export… (docs/export-design.md, phase X1)
    context.extensions.contribute('format-csv', EXPORT_FORMATS_POINT, CSV_EXPORT.id, CSV_EXPORT),
    context.services.provide('format-csv', CSV_EXPORT.service, csvExport)
  )
}
