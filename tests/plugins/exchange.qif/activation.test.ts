// @vitest-environment node
// The QIF plugin's real `activate`, and what the exchange pipeline makes of what it contributes.
import { describe, expect, it } from 'vitest'
import { FORMATS_POINT, validateFormat, type ExchangeFormat } from '@tessera/exchange-api'
import { createPluginContext, createPluginRuntime } from '../../../core/plugins/PluginContext'
import { FormatRegistry } from '../../../plugins/exchange/src/privileged/formats'
import { DESCRIPTORS, QIF_FORMAT, QIF_FORMAT_SERVICE, QIF_PLUGIN_ID, activate } from '../../../plugins/exchange.qif/src/privileged/index'
import { logger } from '../book/harness'

const bytes = (text: string) => new TextEncoder().encode(text)

async function activated() {
  const runtime = createPluginRuntime(undefined, logger())
  await activate(createPluginContext(QIF_PLUGIN_ID, runtime).context)
  const registry = new FormatRegistry({ extensions: runtime.extensions, services: runtime.services, log: logger() })
  return { runtime, registry }
}

describe('activating the QIF plugin', () => {
  it('contributes one format that both reads and writes, for several accounts, with no row ids', async () => {
    const { runtime, registry } = await activated()
    expect(runtime.services.has(QIF_FORMAT_SERVICE)).toBe(true)
    expect(validateFormat(DESCRIPTORS[0], QIF_PLUGIN_ID)).toBeUndefined()
    expect(registry.readable().map(f => f.id)).toEqual([QIF_FORMAT])
    expect(registry.writable().map(f => f.id)).toEqual([QIF_FORMAT])
    const descriptor = registry.get(QIF_FORMAT)!
    expect(descriptor.capabilities).toEqual({ read: true, write: true, multiAccount: true, transactionIds: false })
  })

  it('claims .qif by extension, and a QIF under another name by its content', async () => {
    const { registry } = await activated()
    expect(registry.choose('export.qif', bytes('!Type:Bank\r\n')).id).toBe(QIF_FORMAT)
    expect(registry.choose('export.txt', bytes('!Type:Bank\r\nD1/1/26\r\nT1.00\r\n^\r\n')).id).toBe(QIF_FORMAT)
  })

  it('reads through the service, answering the date order from what the caller settled', async () => {
    const { runtime } = await activated()
    const format = runtime.services.get<ExchangeFormat>(QIF_FORMAT_SERVICE)
    const document = await format.read!(bytes("!Type:Bank\r\nD5/3'26\r\nT-1.00\r\nPX\r\n^\r\n"), {
      fileName: 'x.qif', formatId: QIF_FORMAT, answers: { 'exchange-qif.dateOrder': 'dmy' },
      request: async () => { throw new Error('should not ask') }, log: logger()
    })
    expect(document.statements[0].transactions[0].date).toBe('2026-03-05')
    const written = await format.write!(document, { options: { flavour: 'standard' }, log: logger() })
    expect(new TextDecoder('windows-1252').decode(written)).toContain("D3/5'26")
  })
})
