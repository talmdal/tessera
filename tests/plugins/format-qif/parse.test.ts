// @vitest-environment node
// The QIF format: its contributions, sniffing, the QIF Options dialog only when a file can be read two ways (its dates,
// its decimal separator), what is remembered per source, skip and cancel, and `correct`, which keeps the sign
// cross-check's reversal so the source's next file is read reversed without asking.
import { describe, expect, it } from 'vitest'
import { DIALOGS_EXTENSION_POINT } from '@tessera/types'
import { IMPORT_FORMATS_POINT, isImportError, type ParseContext, type ParseResult } from '@tessera/import-api'
import { EXPORT_FORMATS_POINT } from '@tessera/export-api'
import { ExtensionRegistryImpl } from '../../../core/extensions/ExtensionRegistry'
import { QIF_EXPORT } from '../../../plugins/format-qif/src/privileged/export'
import { QIF_FORMAT, activate, createQifFormat, looksLikeQif } from '../../../plugins/format-qif/src/privileged/index'
import { optionsKey } from '../../../plugins/format-qif/src/privileged/parse'
import { OPTIONS_DIALOG, type OptionsDialogInput, type OptionsDialogResult } from '../../../plugins/format-qif/src/shared/options'
import { importFile, sample } from '../../helpers/importFile'

const format = createQifFormat({ now: () => new Date('2026-11-06T12:00:00Z') })
function contextOf(memory = new Map<string, unknown>(), answer: (input: OptionsDialogInput) => OptionsDialogResult | undefined = input => ({ kind: 'options', dateOrder: input.dates?.value, decimal: input.decimal?.value })) {
  const shown: { input: OptionsDialogInput, title?: string }[] = []
  const context = {
    memory: { get: async (k: string) => structuredClone(memory.get(k)), set: async (k: string, v: unknown) => { memory.set(k, structuredClone(v)) } },
    prompt: async (id: string, input: OptionsDialogInput, options?: { title?: string }) => {
      expect(id).toBe(OPTIONS_DIALOG)
      shown.push({ input, title: options?.title })
      return answer(input)
    }
  } as unknown as ParseContext
  return { context, memory, shown }
}
const parse = async (file: ReturnType<typeof importFile>, ctx = contextOf()) => (await format.parse(file, ctx.context)) as ParseResult
const failure = (work: Promise<unknown>) => work.then(() => { throw new Error('expected a failure') }, err => err)
const AMBIGUOUS = '!Type:Bank\nD01/08/2026\nT500.00\nPTRANSFER\n^\nD12/08/2026\nT-80.00\nPE-TRANSFER\n^\n'

describe('the QIF format plugin', () => {
  it('contributes the format for .qif (reading and writing) and the QIF Options dialog, and provides its services', () => {
    const extensions = new ExtensionRegistryImpl()
    const provided: string[] = []
    activate({ extensions, subscriptions: [], services: { provide: (_: string, id: string) => { provided.push(id); return { dispose() {} } } } } as never)
    expect(extensions.getContributions(IMPORT_FORMATS_POINT).map(c => c.impl)).toEqual([QIF_FORMAT])
    expect(QIF_FORMAT).toMatchObject({ extensions: ['qif'], label: 'QIF file (Quicken, Microsoft Money)' })
    expect(extensions.getContributions(DIALOGS_EXTENSION_POINT).map(c => c.impl)).toEqual([{ id: OPTIONS_DIALOG, title: 'QIF Options', module: './OptionsDialog', size: 'sm' }])
    // One plugin per file type: it writes QIF too, for File › Export… (docs/export-design.md)
    expect(extensions.getContributions(EXPORT_FORMATS_POINT).map(c => c.impl)).toEqual([QIF_EXPORT])
    expect(QIF_EXPORT).toMatchObject({ id: 'format-qif.qif', extension: 'qif', service: 'format-qif.export', accounts: 'many' })
    expect(provided).toEqual(['format-qif.import', 'format-qif.export'])
  })

  it('knows a QIF file by its first line, with a byte-order mark or not, and nothing else', () => {
    const sniff = (text: string) => looksLikeQif({ name: 'x.txt', extension: 'txt', head: new TextEncoder().encode(text) })
    expect(sniff('!Type:Bank\nD1/5/26\n')).toBe(true)
    expect(sniff('\uFEFF\r\n!Account\nNChequing\n')).toBe(true)
    expect(sniff('!Option:AutoSwitch\n')).toBe(true)
    expect(sniff('!type : ccard\n')).toBe(true)
    expect(sniff('Date,Description,Amount\n')).toBe(false)
    expect(sniff('OFXHEADER:100\n')).toBe(false)
  })
})

describe('QIF Options', () => {
  it('doesn’t appear for a file it can read one way: a Money export', async () => {
    const ctx = contextOf()
    const { statements } = await parse(sample('maple-trust-chequing-2026-09.qif'), ctx)
    expect(ctx.shown).toEqual([])
    expect(statements).toHaveLength(1)
    expect(ctx.memory.get(optionsKey('qif:account:maple trust chequing'))).toEqual({ dateOrder: 'MDY', decimal: '.', label: 'Maple Trust Chequing' })
  })

  it('asks about the dates when every day is 12 or less, offering first the order with the shortest span', async () => {
    const ctx = contextOf()
    const { statements: [s] } = await parse(sample('cedar-savings-2026-08-12.qif'), ctx)
    expect(ctx.shown).toEqual([{
      title: 'QIF Options: cedar-savings-2026-08-12.qif',
      input: {
        fileName: 'cedar-savings-2026-08-12.qif',
        dates: {
          example: '01/08/2026', value: 'DMY',
          choices: [{ value: 'MDY', label: 'Month/Day/Year: 01/08/2026 is Jan 8, 2026' }, { value: 'DMY', label: 'Day/Month/Year: 01/08/2026 is Aug 1, 2026' }]
        }
      }
    }])
    expect(s.lines.map(l => l.date)).toEqual(['2026-08-01', '2026-08-05', '2026-08-10', '2026-08-12'])
  })

  it('reads the file as answered, and remembers it for the source: its next file isn’t asked', async () => {
    const ctx = contextOf(new Map(), () => ({ kind: 'options', dateOrder: 'MDY' }))
    const first = await parse(importFile('Savings 2026-08.qif', AMBIGUOUS), ctx)
    expect(first.statements[0].lines.map(l => l.date)).toEqual(['2026-01-08', '2026-12-08'])
    expect(ctx.memory.get(optionsKey('qif:file:savings'))).toEqual({ dateOrder: 'MDY', decimal: '.', label: 'Savings 2026-08' })
    await parse(importFile('Savings 2026-09.qif', AMBIGUOUS), ctx)
    expect(ctx.shown).toHaveLength(1)
  })

  it('asks again when the remembered order no longer reads the file', async () => {
    const memory = new Map<string, unknown>([[optionsKey('qif:file:savings'), { dateOrder: 'YMD', decimal: '.' }]])
    const ctx = contextOf(memory)
    await parse(importFile('Savings.qif', AMBIGUOUS), ctx)
    expect(ctx.shown).toHaveLength(1)
  })

  it('asks about the decimal separator when every amount fits both, alone or with the dates', async () => {
    const ctx = contextOf(new Map(), () => ({ kind: 'options', decimal: ',' }))
    const { statements: [s] } = await parse(importFile('x.qif', '!Type:Bank\nD10/13/2026\nT-1,234\n^\nD10/14/2026\nT500\n^\n'), ctx)
    expect(ctx.shown[0].input).toEqual({
      fileName: 'x.qif',
      decimal: {
        example: '-1,234', value: '.',
        choices: [{ value: '.', label: 'A point for decimals (1,234.56): “-1,234” is -1234' }, { value: ',', label: 'A comma for decimals (1.234,56): “-1,234” is -1.234' }]
      }
    })
    expect(s.lines.map(l => l.amount)).toEqual(['-1.234', '500'])
    const both = contextOf()
    await parse(importFile('y.qif', '!Type:Bank\nD01/08/2026\nT-1,234\n^\nD12/08/2026\nT500\n^\n'), both)
    expect(Object.keys(both.shown[0].input).sort()).toEqual(['dates', 'decimal', 'fileName'])
  })

  it('skips the file for Skip This File, and stops the import for Cancel Import', async () => {
    expect(await format.parse(importFile('x.qif', AMBIGUOUS), contextOf(new Map(), () => ({ kind: 'skip' })).context)).toBeUndefined()
    const err = await failure(format.parse(importFile('x.qif', AMBIGUOUS), contextOf(new Map(), () => undefined).context))
    expect(isImportError(err) && err.code).toBe('CANCELLED')
  })
})

describe('what a file gives', () => {
  it('refuses a file that isn’t QIF', async () => {
    const err = await failure(format.parse(importFile('x.qif', 'Date,Amount\n2026-10-05,-1.00\n'), contextOf().context))
    expect(isImportError(err) && err.message).toBe('x.qif isn\'t a QIF file: it has no !Type or !Account line.')
  })

  it('gives no statement, and says why, for a file of investment accounts only', async () => {
    const { statements, warnings } = await parse(importFile('x.qif', '!Account\nNRRSP\nTInvst\n^\n!Type:Invst\nD1/5/26\nNBuy\n^\n'))
    expect(statements).toEqual([])
    expect(warnings).toHaveLength(1)
  })

  it('leaves out an account without transactions, saying so', async () => {
    const { statements, warnings } = await parse(importFile('x.qif', '!Account\nNEmpty\nTBank\n^\n!Type:Bank\nD1/1/26\nT0.00\nPOpening Balance\nL[Empty]\n^\n!Account\nNFull\nTBank\n^\n!Type:Bank\nD1/5/26\nT1.00\n^\n'))
    expect(statements.map(s => s.account.name)).toEqual(['Full'])
    expect(warnings).toEqual([{ message: '“Empty” has no transactions, so nothing of it was imported.', line: 5 }])
  })
})

describe('correct: a reversal the user asked to remember', () => {
  it('reads the source’s next file reversed, without asking, and says it can’t for keys it didn’t make', async () => {
    const ctx = contextOf()
    const { statements: [card] } = await parse(sample('northwind-visa-2026-09.qif'), ctx)
    expect(card.lines[0].amount).toBe('128.44')
    expect(await format.correct!({ kind: 'signsReversed', key: card.account.key! }, { memory: ctx.context.memory })).toBe(true)
    expect(ctx.memory.get(optionsKey('qif:file:northwind-visa'))).toMatchObject({ reversed: true })
    const again = await parse(sample('northwind-visa-2026-09.qif'), ctx)
    expect(again.statements[0].lines[0].amount).toBe('-128.44')
    expect(ctx.shown).toEqual([])
    // Reversed again (the bank fixed its files): read as written
    await format.correct!({ kind: 'signsReversed', key: card.account.key! }, { memory: ctx.context.memory })
    expect((await parse(sample('northwind-visa-2026-09.qif'), ctx)).statements[0].lines[0].amount).toBe('128.44')
    expect(await format.correct!({ kind: 'signsReversed', key: 'csv:layout:1' }, { memory: ctx.context.memory })).toBe(false)
  })
})

describe('describeMemory: what the format remembers, as Saved Import Choices lists it', () => {
  it('describes a source’s options by its name', () => {
    expect(format.describeMemory!(optionsKey('qif:account:visa'), { dateOrder: 'DMY', decimal: ',', reversed: true, label: 'Visa' }))
      .toEqual({ what: 'QIF options', source: 'Visa', detail: 'Dates day first · a comma for decimals · amounts reversed' })
    expect(format.describeMemory!(optionsKey('qif:file:savings'), { reversed: true })).toEqual({ what: 'QIF options', source: 'savings', detail: 'Amounts reversed' })
    expect(format.describeMemory!('something-else', {})).toBeUndefined()
  })
})
