// The QIF format plugin: Quicken Interchange Format files, from banks, Quicken and Microsoft Money. A file holds one
// account's transactions or, exported from Quicken as a whole, every account's. It turns a file into neutral
// statements, one per account (investment accounts are left out); the import manager does everything else.
// See docs/import-formats-design.md, "QIF".
import { DIALOGS_EXTENSION_POINT, type DialogContribution, type PluginContext } from '@tessera/types'
import { IMPORT_FORMATS_POINT, type ImportFormat, type ImportFormatContribution, type ImportSample } from '@tessera/import-api'
import { OPTIONS_DIALOG } from '../shared/options'
import { correctQif, describeQifMemory, parseQifFile, type QifFormatOptions } from './parse'

export const QIF_FORMAT: ImportFormatContribution = {
  id: 'import-qif.qif',
  label: 'QIF file (Quicken, Microsoft Money)',
  extensions: ['qif'],
  service: 'import-qif.format',
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
    context.extensions.contribute('import-qif', IMPORT_FORMATS_POINT, QIF_FORMAT.id, QIF_FORMAT),
    context.extensions.contribute('import-qif', DIALOGS_EXTENSION_POINT, OPTIONS_DIALOG_CONTRIBUTION.id, OPTIONS_DIALOG_CONTRIBUTION),
    context.services.provide('import-qif', QIF_FORMAT.service, createQifFormat(options))
  )
}
