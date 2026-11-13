// The QIF file-type plugin: Quicken Interchange Format files, from banks, Quicken and Microsoft Money. A file holds one
// account's transactions or, exported from Quicken as a whole, every account's. It turns a file into neutral
// statements, one per account (investment accounts are left out); the import manager does everything else.
// One plugin per file type, reading and (from docs/export-design.md, phase X2) writing.
// See docs/import-formats-design.md, "QIF".
import { DIALOGS_EXTENSION_POINT, type DialogContribution, type PluginContext } from '@tessera/types'
import { IMPORT_FORMATS_POINT, type ImportFormat, type ImportFormatContribution, type ImportSample } from '@tessera/import-api'
import { EXPORT_FORMATS_POINT } from '@tessera/export-api'
import { OPTIONS_DIALOG } from '../shared/options'
import { QIF_EXPORT, qifExport } from './export'
import { correctQif, describeQifMemory, parseQifFile, type QifFormatOptions } from './parse'

export const QIF_FORMAT: ImportFormatContribution = {
  id: 'format-qif.qif',
  label: 'QIF file (Quicken, Microsoft Money)',
  extensions: ['qif'],
  service: 'format-qif.import',
  description: 'The Quicken Interchange Format: exports from Quicken and Microsoft Money, and some banks\' downloads.',
  order: 20
}

export const OPTIONS_DIALOG_CONTRIBUTION: DialogContribution = { id: OPTIONS_DIALOG, title: 'QIF Options', module: './OptionsDialog', size: 'sm' }

/** True for the start of a QIF file: its first line opens a section or an account, or sets an option. */
export function looksLikeQif(sample: ImportSample): boolean {
  const text = new TextDecoder('latin1').decode(sample.head).replace(/^\uFEFF|^ï»¿/, '')
  const first = text.split(/\r\n|\r|\n/).find(line => line.trim() !== '')?.trim() ?? ''
  return /^!\s*(type\s*:|account|option\s*:)/i.test(first)
}

export function createQifFormat(options: QifFormatOptions = {}): ImportFormat {
  return {
    sniff: looksLikeQif,
    parse: (file, context) => parseQifFile(file, context, options),
    correct: (correction, { memory }) => correctQif(correction, memory),
    describeMemory: describeQifMemory
  }
}

export function activate(context: PluginContext, options: QifFormatOptions = {}) {
  context.subscriptions.push(
    context.extensions.contribute('format-qif', IMPORT_FORMATS_POINT, QIF_FORMAT.id, QIF_FORMAT),
    context.extensions.contribute('format-qif', DIALOGS_EXTENSION_POINT, OPTIONS_DIALOG_CONTRIBUTION.id, OPTIONS_DIALOG_CONTRIBUTION),
    context.services.provide('format-qif', QIF_FORMAT.service, createQifFormat(options)),
    // Writing QIF, for File › Export… (docs/export-design.md, phase X2)
    context.extensions.contribute('format-qif', EXPORT_FORMATS_POINT, QIF_EXPORT.id, QIF_EXPORT),
    context.services.provide('format-qif', QIF_EXPORT.service, qifExport)
  )
}
