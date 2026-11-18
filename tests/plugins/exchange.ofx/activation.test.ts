// @vitest-environment node
// The OFX plugin's real `activate`, and what the exchange pipeline makes of what it contributes.
import { describe, expect, it } from 'vitest'
import { FORMATS_POINT, validateFormat, type ExchangeFormat } from '@tessera/exchange-api'
import { ExtensionRegistryImpl } from '../../../core/extensions/ExtensionRegistry'
import { ServiceRegistryImpl } from '../../../core/services/ServiceRegistry'
import { createPluginContext, createPluginRuntime } from '../../../core/plugins/PluginContext'
import { FormatRegistry } from '../../../plugins/exchange/src/privileged/formats'
import {
  DESCRIPTORS, OFX_FORMATS, OFX_FORMAT_SERVICE, OFX_PLUGIN_ID, activate
} from '../../../plugins/exchange.ofx/src/privileged/index'
import { logger } from '../book/harness'

const bytes = (text: string) => new TextEncoder().encode(text)
const OFX_FILE = bytes('OFXHEADER:100\r\nDATA:OFXSGML\r\n\r\n<OFX><SIGNONMSGSRSV1>')
const QBO_FILE = bytes('OFXHEADER:100\r\nDATA:OFXSGML\r\n\r\n<OFX><SIGNONMSGSRSV1><SONRS><INTU.BID>3000')

async function activated() {
  const runtime = createPluginRuntime(undefined, logger())
  await activate(createPluginContext(OFX_PLUGIN_ID, runtime).context)
  const registry = new FormatRegistry({
    extensions: runtime.extensions,
    services: runtime.services,
    log: logger()
  })
  return { runtime, registry }
}

describe('activating the OFX plugin', () => {
  it('contributes three formats and the one service behind them', async () => {
    const { runtime } = await activated()
    expect(runtime.services.has(OFX_FORMAT_SERVICE)).toBe(true)
    const contributed = runtime.extensions.getContributions(FORMATS_POINT).map(c => (c.impl as { id: string }).id)
    expect(contributed).toEqual([OFX_FORMATS.ofx, OFX_FORMATS.qfx, OFX_FORMATS.qbo])
  })

  it('contributes descriptors the point accepts', () => {
    for (const descriptor of DESCRIPTORS) {
      expect(validateFormat(descriptor, OFX_PLUGIN_ID), descriptor.id).toBeUndefined()
    }
  })

  it('writes plain OFX only: a QFX or a QBO is Intuit’s to issue, not ours', () => {
    for (const descriptor of DESCRIPTORS) {
      expect(descriptor.capabilities.read).toBe(true)
      expect(descriptor.capabilities.transactionIds).toBe(true)
      // Only the plain descriptor writes. The Intuit two are defined by an identifier Tessera cannot hold.
      expect(descriptor.capabilities.write).toBe(descriptor.id === OFX_FORMATS.ofx ? true : undefined)
    }
  })

  it('is seen by the pipeline as three readable formats and one writable one', async () => {
    const { registry } = await activated()
    expect(registry.readable().map(f => f.id)).toEqual([OFX_FORMATS.ofx, OFX_FORMATS.qfx, OFX_FORMATS.qbo])
    expect(registry.writable().map(f => f.id)).toEqual([OFX_FORMATS.ofx])
  })

  it('claims each extension for exactly one format, so no file needs sniffing', async () => {
    const { registry } = await activated()
    expect(registry.choose('statement.ofx', OFX_FILE).id).toBe(OFX_FORMATS.ofx)
    expect(registry.choose('statement.qfx', OFX_FILE).id).toBe(OFX_FORMATS.qfx)
    expect(registry.choose('statement.qbo', OFX_FILE).id).toBe(OFX_FORMATS.qbo)
  })

  it('falls back to the content for a file whose name says nothing', async () => {
    const { registry } = await activated()
    // No Intuit block: plain OFX outranks the two that want their own extension
    expect(registry.choose('download', OFX_FILE).id).toBe(OFX_FORMATS.ofx)
    expect(registry.choose('download.txt', OFX_FILE).id).toBe(OFX_FORMATS.ofx)
  })

  it('asks rather than guesses between Quicken and QuickBooks, which nothing in the file tells apart', () => {
    // `INTU.BID` identifies the bank, not the program: a nameless file carrying one could be either, and the
    // extension is normally what settles it. Guessing would put the wrong label on the saved account link.
    return activated().then(({ registry }) => {
      expect(() => registry.choose('download.txt', QBO_FILE))
        .toThrow(/could be Quicken Web Connect .* and QuickBooks Web Connect/)
      // Naming the format, or the file, resolves it
      expect(registry.choose('download.txt', QBO_FILE, OFX_FORMATS.qbo).id).toBe(OFX_FORMATS.qbo)
      expect(registry.choose('download.qbo', QBO_FILE).id).toBe(OFX_FORMATS.qbo)
    })
  })

  it('declines a file that is not OFX at all, naming what it tried', async () => {
    const { registry } = await activated()
    expect(() => registry.choose('ledger.dat', bytes('Date,Payee,Amount\n2026-10-01,X,1.00\n')))
      .toThrow(/could not tell what kind of file this is/)
  })

  it('honours the format the user chose over the file’s name', async () => {
    const { registry } = await activated()
    expect(registry.choose('mislabelled.ofx', QBO_FILE, OFX_FORMATS.qbo).id).toBe(OFX_FORMATS.qbo)
  })

  it('reads the same file the same way whichever of the three it is opened as', async () => {
    const { registry } = await activated()
    const format = registry.implementation(registry.get(OFX_FORMATS.ofx)!) as ExchangeFormat
    const file = bytes(
      'OFXHEADER:100\r\nDATA:OFXSGML\r\n\r\n<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>CAD' +
      '<BANKACCTFROM><BANKID>1<ACCTID>2<ACCTTYPE>CHECKING</BANKACCTFROM>' +
      '<BANKTRANLIST><STMTTRN><DTPOSTED>20261003<TRNAMT>-14.20<FITID>A1<NAME>Hydro</STMTTRN>' +
      '</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>')

    const read = async (formatId: string) => format.read!(file, {
      fileName: 'x', formatId, answers: {}, request: async () => { throw new Error('should not ask') }, log: logger()
    })

    const asOfx = await read(OFX_FORMATS.ofx)
    const asQbo = await read(OFX_FORMATS.qbo)
    expect(asQbo.statements).toEqual(asOfx.statements)
    // Only the format it was read as differs, which is what the batch records
    expect(asOfx.formatId).toBe(OFX_FORMATS.ofx)
    expect(asQbo.formatId).toBe(OFX_FORMATS.qbo)
  })

  it('reads a sign convention a previous import settled, without asking again', async () => {
    const { registry } = await activated()
    const format = registry.implementation(registry.get(OFX_FORMATS.ofx)!) as ExchangeFormat
    const file = bytes(
      'OFXHEADER:100\r\nDATA:OFXSGML\r\n\r\n<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>CAD' +
      '<BANKACCTFROM><BANKID>1<ACCTID>2<ACCTTYPE>CHECKING</BANKACCTFROM>' +
      '<BANKTRANLIST><STMTTRN><DTPOSTED>20261003<TRNAMT>-14.20<FITID>A1<NAME>Hydro</STMTTRN>' +
      '</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>')

    const document = await format.read!(file, {
      fileName: 'x',
      formatId: OFX_FORMATS.ofx,
      answers: { 'exchange-ofx.signs': 'invert' },
      // A settled answer must never put a dialog in front of the user again
      request: async () => { throw new Error('should not ask') },
      log: logger()
    })
    expect(document.statements[0].transactions[0].amount).toBe(1_420)
  })

  it('gives up its service and its formats when the plugin is disposed', async () => {
    const runtime = createPluginRuntime(undefined, logger())
    const created = createPluginContext(OFX_PLUGIN_ID, runtime)
    await activate(created.context)
    expect(runtime.services.has(OFX_FORMAT_SERVICE)).toBe(true)

    created.dispose()
    expect(runtime.services.has(OFX_FORMAT_SERVICE)).toBe(false)
    expect(runtime.extensions.getContributions(FORMATS_POINT)).toEqual([])
  })
})

describe('the formats point without the plugin', () => {
  it('leaves the pipeline with nothing readable, which is what greys out File ▸ Import', () => {
    const registry = new FormatRegistry({
      extensions: new ExtensionRegistryImpl(),
      services: new ServiceRegistryImpl(),
      log: logger()
    })
    expect(registry.readable()).toEqual([])
    expect(() => registry.choose('x.ofx', OFX_FILE)).toThrow(/No file formats are installed/)
  })
})
