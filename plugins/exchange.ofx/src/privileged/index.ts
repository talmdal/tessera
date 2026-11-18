// The `exchange-ofx` plugin: OFX, and the two Intuit-branded files that are also OFX.
//
// Three descriptors, one reader. `.qfx` is Quicken Web Connect and `.qbo` is QuickBooks Web Connect, and they
// are structurally identical to plain OFX — only the extension and a couple of Intuit tags tell them apart,
// which is why the extension is tried before the content.
//
// All three read. Only `.ofx` writes, and only OFX 2.x: a QFX or a QBO is defined by an identifier Intuit
// issues to a financial institution and Tessera is not one, while 1.x is a second SGML code path whose only
// customer is software that would rather have QIF anyway. See writer.ts.
import type { PluginContext } from '@tessera/types'
import {
  FORMATS_POINT, SNIFF_BYTES,
  type ExchangeFormat, type ExchangeFormatContribution, type ReadContext
} from '@tessera/exchange-api'
import { readOfx } from './reader'
import { writeOfx } from './writer'
import { isSignConvention, type SignConvention } from './values'

export const OFX_PLUGIN_ID = 'exchange-ofx'
export const OFX_FORMAT_SERVICE = 'exchange-ofx.format'

export const OFX_FORMATS = {
  ofx: 'exchange-ofx.ofx',
  qfx: 'exchange-ofx.qfx',
  qbo: 'exchange-ofx.qbo'
} as const

/** The answer a previous import settled: how this source signs its amounts. */
export const SIGNS_ANSWER = 'exchange-ofx.signs'

export const DESCRIPTORS: ExchangeFormatContribution[] = [
  {
    id: OFX_FORMATS.ofx,
    label: 'OFX statement (*.ofx)',
    extensions: ['ofx'],
    service: OFX_FORMAT_SERVICE,
    // Writes as well as reads, and holds several accounts: OFX has a message set per account kind, and each
    // can carry more than one statement response.
    capabilities: { read: true, write: true, multiAccount: true, transactionIds: true },
    order: 10
  },
  {
    id: OFX_FORMATS.qfx,
    label: 'Quicken Web Connect (*.qfx)',
    extensions: ['qfx'],
    service: OFX_FORMAT_SERVICE,
    capabilities: { read: true, transactionIds: true },
    order: 11
  },
  {
    id: OFX_FORMATS.qbo,
    label: 'QuickBooks Web Connect (*.qbo)',
    extensions: ['qbo'],
    service: OFX_FORMAT_SERVICE,
    capabilities: { read: true, transactionIds: true },
    order: 12
  }
]

/** Enough of the head to see a header block and the first tags, as text, whatever the body's encoding is. */
const headOf = (head: Uint8Array) => new TextDecoder('latin1').decode(head.subarray(0, SNIFF_BYTES))


/**
 * How sure we are that these bytes are OFX. An `OFXHEADER` line or an `<?OFX` instruction is as certain as it
 * gets; a bare `<OFX>` tag is nearly so. The Intuit descriptors want their own extension, so a file carrying
 * `INTU.BID` scores full marks for them and an OFX file without it scores lower — enough to lose a tie to the
 * plain descriptor without being ruled out, since plenty of `.qfx` files omit the tag.
 */
export function sniffOfx(head: Uint8Array, _fileName: string, formatId: string): number {
  const text = headOf(head)
  const isOfx = /^OFXHEADER:/m.test(text) || /<\?OFX\b/i.test(text) || /<OFX>/i.test(text)
  if (!isOfx) return 0

  const intuit = /<INTU\.BID>/i.test(text)
  if (formatId === OFX_FORMATS.ofx) return intuit ? 0.7 : 1
  return intuit ? 1 : 0.6
}

/** The sign convention to read with: what a previous import settled, else as the file gives it. */
export function signsFrom(context: Pick<ReadContext, 'answers'>): SignConvention {
  const answer = context.answers?.[SIGNS_ANSWER]
  return isSignConvention(answer) ? answer : 'asGiven'
}

/**
 * One implementation behind all three descriptors. Both halves are told which format they are being asked
 * about: the registry passes it to `sniff`, and the pipeline puts the chosen descriptor in the read context.
 */
export const ofxFormat: ExchangeFormat = {
  sniff: (head, fileName, formatId) => sniffOfx(head, fileName, formatId),
  read: async (data, context) => readOfx(data, {
    formatId: context.formatId,
    signs: signsFrom(context)
  }),
  // One writer behind three descriptors, but only the plain one declares `write`, so `exchange.export` refuses
  // QFX and QBO before reaching here. There is nothing to configure: see writer.ts on why 2.x is not a choice.
  write: async document => writeOfx(document)
}

export async function activate(context: PluginContext) {
  context.subscriptions.push(
    context.services.provide(OFX_PLUGIN_ID, OFX_FORMAT_SERVICE, ofxFormat),
    ...DESCRIPTORS.map(descriptor =>
      context.extensions.contribute(OFX_PLUGIN_ID, FORMATS_POINT, descriptor.id, descriptor))
  )
}

export { readOfx, writeOfx }
