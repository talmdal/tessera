// @vitest-environment node
// The CSV plugin's real `activate`, and — the part that matters most — that being the permissive fallback
// format does not let it steal files from readers that actually know what they are.
import { describe, expect, it } from 'vitest'
import { FORMATS_POINT, validateFormat, type ExchangeFormat } from '@tessera/exchange-api'
import { createPluginContext, createPluginRuntime } from '../../../core/plugins/PluginContext'
import { FormatRegistry } from '../../../plugins/exchange/src/privileged/formats'
import {
  CSV_FORMAT, CSV_FORMAT_SERVICE, CSV_PLUGIN_ID, DESCRIPTORS, activate, sniffCsv
} from '../../../plugins/exchange.csv/src/privileged/index'
import { activate as activateQif, QIF_FORMAT } from '../../../plugins/exchange.qif/src/privileged/index'
import { logger } from '../book/harness'

const bytes = (text: string) => new TextEncoder().encode(text)

async function activated(alsoQif = false) {
  const runtime = createPluginRuntime(undefined, logger())
  await activate(createPluginContext(CSV_PLUGIN_ID, runtime).context)
  if (alsoQif) await activateQif(createPluginContext('exchange-qif', runtime).context)
  const registry = new FormatRegistry({ extensions: runtime.extensions, services: runtime.services, log: logger() })
  return { runtime, registry }
}

const SAMPLE = 'Date,Payee,Amount\r\n2026-10-15,Coffee,-4.50\r\n2026-10-16,Books,-9.99\r\n'

describe('activating the CSV plugin', () => {
  it('contributes one format that both reads and writes, for one account at a time, with no row ids', async () => {
    const { runtime, registry } = await activated()
    expect(runtime.services.has(CSV_FORMAT_SERVICE)).toBe(true)
    expect(validateFormat(DESCRIPTORS[0], CSV_PLUGIN_ID)).toBeUndefined()
    expect(registry.readable().map(f => f.id)).toEqual([CSV_FORMAT])
    expect(registry.writable().map(f => f.id)).toEqual([CSV_FORMAT])
    expect(registry.get(CSV_FORMAT)!.capabilities).toEqual({
      read: true, write: true, multiAccount: false, transactionIds: false
    })
  })

  it('claims a .csv file', async () => {
    const { registry } = await activated()
    expect(registry.choose('statement.csv', bytes(SAMPLE)).id).toBe(CSV_FORMAT)
  })

  it('leaves a QIF to the QIF reader even when it is full of commas', async () => {
    const { registry } = await activated(true)
    const qif = '!Type:Bank\r\nD10/15/2026\r\nT-1,234.56\r\nPSmith, John\r\n^\r\n'
    expect(registry.choose('export.qif', bytes(qif)).id).toBe(QIF_FORMAT)
  })

  it('does not claim .txt, which would hand it every file no other format claims', async () => {
    const { registry } = await activated(true)
    expect(registry.get(CSV_FORMAT)!.extensions).toEqual(['csv', 'tsv'])
    // Nothing claims `.txt`, so a delimited one falls to sniffing, where CSV's weak claim still wins.
    expect(registry.choose('export.txt', bytes(SAMPLE)).id).toBe(CSV_FORMAT)
    // But a QIF under a .txt name goes to the reader that actually recognises it.
    expect(registry.choose('export.txt', bytes('!Type:Bank\r\nD1/1/26\r\nT1.00\r\n^\r\n')).id).toBe(QIF_FORMAT)
  })
})

describe('sniffCsv', () => {
  it('is confident about a delimited .csv and less so about one it cannot square up', () => {
    expect(sniffCsv(bytes(SAMPLE), 'a.csv')).toBe(0.9)
    expect(sniffCsv(bytes('just\r\nsome prose\r\n'), 'a.csv')).toBe(0.6)
  })

  it('makes only a weak claim on a file whose name does not say CSV', () => {
    expect(sniffCsv(bytes(SAMPLE), 'a.dat')).toBe(0.2)
    expect(sniffCsv(bytes('just\r\nsome prose\r\n'), 'a.dat')).toBe(0)
  })

  it('declines a file that announces itself as another format', () => {
    expect(sniffCsv(bytes('OFXHEADER:100\r\nDATA:OFXSGML\r\n'), 'a.csv')).toBe(0)
    expect(sniffCsv(bytes('<?xml version="1.0"?>\r\n<OFX>\r\n'), 'a.csv')).toBe(0)
    expect(sniffCsv(bytes('!Type:Bank\r\nD1/1/26\r\n'), 'a.csv')).toBe(0)
  })

  it('declines an empty file and one with a single line', () => {
    expect(sniffCsv(bytes(''), 'a.csv')).toBe(0)
    expect(sniffCsv(bytes('Date,Payee,Amount\r\n'), 'a.csv')).toBe(0)
  })
})

describe('reading and writing through the service', () => {
  it('reads a file, answering the mapping from what the caller settled, and writes it back', async () => {
    const { runtime } = await activated()
    const format = runtime.services.get<ExchangeFormat>(CSV_FORMAT_SERVICE)

    const document = await format.read!(bytes(SAMPLE), {
      fileName: 'statement.csv',
      formatId: CSV_FORMAT,
      answers: {},
      request: async question => (question as { suggested?: unknown }).suggested as never,
      log: logger()
    })
    expect(document.statements[0].transactions).toHaveLength(2)

    const written = await format.write!(document, { options: { bom: false, delimiter: ',' }, log: logger() })
    expect(new TextDecoder().decode(written).split('\r\n')[0]).toBe('Date,Number,Payee,Category,Memo,Amount,Balance,Status,Account')
  })
})
