// The OFX file-type plugin: statement files in Open Financial Exchange, as banks offer them for Microsoft Money
// (.ofx), Quicken (.qfx) and QuickBooks (.qbo, Web Connect). QFX and QBO are OFX with a few Intuit tags the reader
// ignores. Both OFX 1.x (SGML) and 2.x (XML) are read. It turns a file into neutral statements; the import manager
// does everything else. One plugin per file type, reading and (from docs/export-design.md, phase X3) writing.
// See docs/import-file-types-design.md, "OFX, QFX and QBO", and docs/import-formats-design.md, "QBO".
import type { PluginContext } from '@tessera/types'
import {
  IMPORT_FORMATS_POINT, ImportError,
  type ImportFile, type ImportFormat, type ImportFormatContribution, type ImportSample, type ParseResult
} from '@tessera/import-api'
import { EXPORT_FORMATS_POINT } from '@tessera/export-api'
import { OFX_EXPORTS, OFX_EXPORT_SERVICE, ofxExport } from './export'
import { declaredEncoding, parseOfx } from './sgml'
import { errorOf, statementsOf } from './statements'

export const OFX_FORMAT: ImportFormatContribution = {
  id: 'format-ofx.ofx',
  label: 'OFX / QFX / QBO statement (Microsoft Money, Quicken, QuickBooks)',
  extensions: ['ofx', 'qfx', 'qbo'],
  service: 'format-ofx.import',
  description: 'The statement files banks offer for Microsoft Money, Quicken and QuickBooks (Web Connect).'
}

/** The encoding the file declares. The header is plain ASCII in every OFX version, so reading it as Latin-1 is safe. */
const encodingOf = (file: ImportFile): string => declaredEncoding(new TextDecoder('latin1').decode(file.bytes.subarray(0, 2048)))

export const ofxFormat: ImportFormat = {
  sniff: ({ head }: ImportSample) => /OFXHEADER|<OFX>/i.test(new TextDecoder('latin1').decode(head)),

  async parse(file: ImportFile): Promise<ParseResult> {
    let text: string
    try {
      text = file.text(encodingOf(file))
    } catch {
      text = file.text('utf-8')                  // an encoding this runtime doesn't know: the best guess
    }
    const document = parseOfx(text)
    if (!document) throw new ImportError('UNREADABLE', `${file.name} isn't an OFX statement: it has no <OFX> section.`)
    const { statements, warnings } = statementsOf(document.root)
    if (statements.length === 0) {
      const error = errorOf(document.root)
      throw new ImportError('UNREADABLE', error
        ? `${file.name} holds no statement. The bank said: ${error}`
        : `${file.name} holds no bank or credit card statement.`)
    }
    return { statements, warnings }
  }
}

export function activate(context: PluginContext) {
  context.subscriptions.push(
    context.extensions.contribute('format-ofx', IMPORT_FORMATS_POINT, OFX_FORMAT.id, OFX_FORMAT),
    context.services.provide('format-ofx', OFX_FORMAT.service, ofxFormat),
    // Writing OFX, QFX and QBO, for File › Export… (docs/export-design.md, phase X3): three choices, one writer
    ...OFX_EXPORTS.map(format => context.extensions.contribute('format-ofx', EXPORT_FORMATS_POINT, format.id, format)),
    context.services.provide('format-ofx', OFX_EXPORT_SERVICE, ofxExport)
  )
}
