// @vitest-environment node
// The CSV format: the CSV Columns dialog on every file, starting from a remembered layout or the guess, as the table in
// docs/import-formats-design.md ("What the dialog starts from") says; what is remembered; the statements' keys and
// labels; sniffing a CSV named .txt; and `correct`, which flips a remembered layout's reversed.
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ExtensionRegistryImpl } from '../../../core/extensions/ExtensionRegistry'
import { DIALOGS_EXTENSION_POINT } from '@tessera/types'
import { IMPORT_FORMATS_POINT, isImportError, type FormatMemory, type ParseContext, type ParseResult } from '@tessera/import-api'
import { EXPORT_FORMATS_POINT } from '@tessera/export-api'
import { CSV_EXPORT } from '../../../plugins/format-csv/src/privileged/export'
import { CSV_FORMAT, activate, createCsvFormat, looksLikeCsv } from '../../../plugins/format-csv/src/privileged/index'
import { MEMORY, type RememberedLayout } from '../../../plugins/format-csv/src/privileged/parse'
import { LAYOUT_DIALOG, firstLine, type LayoutDialogInput, type LayoutDialogResult } from '../../../plugins/format-csv/src/shared/dialog'
import { importFile, sample } from '../../helpers/importFile'

const NOW = () => new Date('2026-11-06T12:00:00Z')
const format = createCsvFormat({ now: NOW })
const LAYOUTS = path.resolve(__dirname, '../../fixtures/import/csv/layouts')
const corpus = (name: string) => importFile(name, fs.readFileSync(path.join(LAYOUTS, name)))

/** A memory kept in a map, and a dialog that answers as told (by default: confirm what it shows). */
function contextOf(memory = new Map<string, unknown>(), answer: (input: LayoutDialogInput) => LayoutDialogResult | undefined = input => ({ kind: 'layout', layout: input.layout })) {
  const shown: LayoutDialogInput[] = []
  const store: FormatMemory = {
    get: async <T>(key: string) => structuredClone(memory.get(key)) as T | undefined,
    set: async (key: string, value: unknown) => { memory.set(key, structuredClone(value)) }
  }
  const context = {
    signal: new AbortController().signal, memory: store, log: { info() {}, warn() {}, error() {}, debug() {} },
    prompt: async (id: string, input: unknown) => {
      expect(id).toBe(LAYOUT_DIALOG)
      shown.push(input as LayoutDialogInput)
      return answer(input as LayoutDialogInput)
    }
  } as unknown as ParseContext
  return { context, memory, shown }
}
const parse = async (file: ReturnType<typeof importFile>, ctx = contextOf()) => (await format.parse(file, ctx.context)) as ParseResult
const failure = (work: Promise<unknown>) => work.then(() => { throw new Error('expected a failure') }, err => err)

describe('the CSV format plugin', () => {
  it('contributes the format for .csv only (reading and writing), and the CSV Columns dialog, and provides its services', () => {
    const extensions = new ExtensionRegistryImpl()
    const provided: string[] = []
    activate({ extensions, subscriptions: [], services: { provide: (_: string, id: string) => { provided.push(id); return { dispose() {} } } } } as never)
    expect(extensions.getContributions(IMPORT_FORMATS_POINT).map(c => c.impl)).toEqual([CSV_FORMAT])
    expect(CSV_FORMAT.extensions).toEqual(['csv'])
    expect(extensions.getContributions(DIALOGS_EXTENSION_POINT).map(c => c.impl)).toEqual([{ id: LAYOUT_DIALOG, title: 'CSV Columns', module: './LayoutDialog', size: 'lg' }])
    // One plugin per file type: it writes CSV too, for File › Export… (docs/export-design.md)
    expect(extensions.getContributions(EXPORT_FORMATS_POINT).map(c => c.impl)).toEqual([CSV_EXPORT])
    expect(CSV_EXPORT).toMatchObject({ id: 'format-csv.csv', extension: 'csv', service: 'format-csv.export', accounts: 'many' })
    expect(provided).toEqual(['format-csv.import', 'format-csv.export'])
  })

  it('knows a CSV file by its shape, so one named .txt imports through All files, and says no to QIF, OFX and prose', () => {
    const sniff = (text: string, name = 'export.txt') => looksLikeCsv({ name, extension: 'txt', head: new TextEncoder().encode(text) })
    expect(sniff(fs.readFileSync(path.join(LAYOUTS, '03-headerless-out-in-balance.csv'), 'utf8'))).toBe(true)
    expect(sniff('Date;Libelle;Montant\n05/10/2026;COSTCO;-84,12\n06/10/2026;METRO;-12,00\n')).toBe(true)
    expect(sniff('!Type:Bank\nD10/05/2026\nT-84.12\n^\n')).toBe(false)
    expect(sniff('OFXHEADER:100\nDATA:OFXSGML\n<OFX>\n')).toBe(false)
    expect(sniff('Dear customer,\nYour statement is attached. Thank you for banking with us.\nRegards\n')).toBe(false)
    // UTF-16 with a byte-order mark, as Excel's Unicode text is
    const utf16 = new Uint8Array([0xff, 0xfe, ...Array.from('Date\tAmount\n2026-10-05\t-1.00\n2026-10-06\t-2.00\n').flatMap(ch => [ch.charCodeAt(0), 0])])
    expect(looksLikeCsv({ name: 'x.txt', extension: 'txt', head: utf16 })).toBe(true)
  })
})

describe('the CSV Columns dialog, on every file', () => {
  it('first sight, every column recognised: the guess, filled in, with nothing highlighted', async () => {
    const ctx = contextOf()
    await parse(sample('maple-trust-chequing-2026-10.csv'), ctx)
    const [input] = ctx.shown
    expect(input).toMatchObject({ fileName: 'maple-trust-chequing-2026-10.csv', start: 'recognised', uncertain: [], truncated: false, pivot: 2036 })
    expect(input.layout.columns).toMatchObject({ date: 0, payee: 1, debit: 2, credit: 3, balance: 4, status: { column: 5 } })
    expect(input.text).toBe(fs.readFileSync(sample('maple-trust-chequing-2026-10.csv').path, 'utf8'))
    expect(firstLine(input)).toBe('Tessera recognised these columns. Check the preview, then Import: they’ll be remembered for files like this.')
  })

  it('first sight, some of it a guess: the guess, with those choices highlighted and why', async () => {
    const ctx = contextOf()
    await parse(sample('northwind-visa-2026-10.csv'), ctx)
    const [input] = ctx.shown
    expect(input.start).toBe('guessed')
    expect(input.layout.reversed).toBe(true)
    expect(input.uncertain).toEqual([{ field: 'reversed', why: expect.stringMatching(/^6 of the 8 amounts are positive/) }])
    expect(firstLine(input)).toMatch(/^Tessera guessed these columns. Check the highlighted ones/)
  })

  it('remembered and fitting: the remembered layout, as last confirmed, with when it was last used', async () => {
    const ctx = contextOf(new Map(), input => ({ kind: 'layout', layout: { ...input.layout, reversed: false } }))
    await parse(sample('northwind-visa-2026-10.csv'), ctx)
    await parse(sample('northwind-visa-2026-10.csv'), ctx)
    expect(ctx.shown[1]).toMatchObject({ start: 'remembered', uncertain: [], lastUsed: '2026-11-06', layout: { reversed: false } })
    expect(firstLine(ctx.shown[1])).toBe('Same columns as last time (files like this one, last imported 6 Nov 2026). Check the preview, then Import.')
  })

  it('remembers the layout of the next month’s file, with the same header', async () => {
    const ctx = contextOf()
    await parse(sample('maple-trust-chequing-2026-10.csv'), ctx)
    await parse(sample('maple-trust-chequing-2026-11.csv'), ctx)
    expect(ctx.shown.map(s => s.start)).toEqual(['recognised', 'remembered'])
  })

  it('remembered, but not fitting this file: the remembered layout, and why it doesn’t fit', async () => {
    const ctx = contextOf()
    await parse(corpus('01-header-signed.csv'), ctx)
    // The same header, but the bank moved the amounts: the amount column now holds the descriptions
    const moved = 'Date,Description,Amount\n2026-11-02,-1200.00,CHEQUE 102\n2026-11-05,-84.12,COSTCO\n2026-11-09,3000.00,PAYROLL\n'
    const again = contextOf(ctx.memory, () => ({ kind: 'skip' }))
    await format.parse(importFile('moved.csv', moved), again.context)
    expect(again.shown[0]).toMatchObject({ start: 'misfit', misfit: 'None of its rows can be read with them.', layout: { columns: { date: 0, payee: 1, amount: 2 } } })
    expect(firstLine(again.shown[0])).toBe('These columns worked last time, but not for this file: None of its rows can be read with them. Choose the columns again.')
    // Some rows: more than 2% of them
    const some = 'Date,Description,Amount\n2026-11-02,CHEQUE 102,-1200.00\n2026-11-05,COSTCO,n/a\n2026-11-09,PAYROLL,3000.00\n'
    await format.parse(importFile('some.csv', some), again.context)
    expect(again.shown[1].misfit).toBe('1 row can\'t be read with them (row 3: “n/a” isn\'t an amount).')
  })

  it('remembered, with the dates now in another order: the order corrected, highlighted, and said', async () => {
    const ctx = contextOf()
    await parse(importFile('a.csv', 'Date,Description,Amount\n10/02/2026,A,-1.00\n10/13/2026,B,-2.00\n'), ctx)
    await parse(importFile('b.csv', 'Date,Description,Amount\n02/11/2026,A,-1.00\n13/11/2026,B,-2.00\n'), ctx)
    expect(ctx.shown[1]).toMatchObject({ start: 'dateOrderChanged', previousDateOrder: 'MDY', layout: { dateOrder: 'DMY' }, uncertain: [{ field: 'dateOrder' }] })
    expect(firstLine(ctx.shown[1])).toBe('The dates in this file are day first; last time they were read month first. Check the preview.')
  })

  it('finds a headerless file’s layout when a column’s shape changed (a month with no deposits)', async () => {
    const ctx = contextOf()
    const { statements: [october] } = await parse(corpus('03-headerless-out-in-balance.csv'), ctx)
    const noDeposits = '11/02/2026,CHQ#00102,1200.00,,5362.33\n11/05/2026,POS COSTCO WHSE #0123,84.12,,5278.21\n11/14/2026,HYDRO OTTAWA,96.40,,5181.81\n'
    const { statements: [november] } = await parse(importFile('nov.csv', noDeposits), ctx)
    expect(ctx.shown[1].start).toBe('remembered')
    expect(november.account.key).toBe(october.account.key)
  })
})

describe('what the dialog’s answer does', () => {
  it('imports the layout confirmed, and remembers it before returning', async () => {
    const ctx = contextOf(new Map(), input => ({ kind: 'layout', layout: { ...input.layout, reversed: false } }))
    const result = await parse(sample('northwind-visa-2026-10.csv'), ctx)
    expect(result.statements[0].lines[0]).toEqual({ date: '2026-10-03', payee: 'AIR CANADA 0142325781', amount: '128.44' })
    const key = result.statements[0].account.key!
    const signature = key.slice('csv:layout:'.length)
    expect(ctx.memory.get(MEMORY.layout(signature))).toEqual({ layout: { ...ctx.shown[0].layout, reversed: false }, lastUsed: '2026-11-06', columns: ['Date', 'Payee', 'Amount'] })
    expect(ctx.memory.get(MEMORY.signatures)).toEqual([signature])
    expect(ctx.memory.get(MEMORY.key(key))).toBe(signature)
  })

  it('reads the rows again when the separator was changed in the dialog', async () => {
    const text = 'Date;Description;Amount\n2026-10-05;COSTCO, OTTAWA;-84,12\n2026-10-06;METRO;-12,00\n'
    const ctx = contextOf(new Map(), input => ({ kind: 'layout', layout: input.layout }))
    const { statements: [s] } = await parse(importFile('x.csv', text), ctx)
    expect(s.lines.map(l => [l.payee, l.amount])).toEqual([['COSTCO, OTTAWA', '-84.12'], ['METRO', '-12.00']])
  })

  it('skips the file for Skip This File, and stops the import for Cancel Import', async () => {
    expect(await format.parse(sample('harbour-bank-2026-10.csv'), contextOf(new Map(), () => ({ kind: 'skip' })).context)).toBeUndefined()
    const cancelled = await failure(format.parse(sample('harbour-bank-2026-10.csv'), contextOf(new Map(), () => undefined).context))
    expect(isImportError(cancelled) && cancelled.code).toBe('CANCELLED')
  })

  it('refuses a layout that can’t be used, saying why', async () => {
    const err = await failure(format.parse(sample('harbour-bank-2026-10.csv'), contextOf(new Map(), input => ({ kind: 'layout', layout: { ...input.layout, columns: { payee: 2 } } })).context))
    expect(isImportError(err) && err.message).toBe('harbour-bank-2026-10.csv can\'t be read with those columns: Choose the column that holds the date.')
  })

  it('refuses an empty file', async () => {
    const err = await failure(format.parse(importFile('empty.csv', '\n\n'), contextOf().context))
    expect(isImportError(err) && err.code).toBe('UNREADABLE')
  })
})

describe('statements', () => {
  it('one, by the file’s layout: a weak key, and a label naming its columns', async () => {
    const { statements, warnings } = await parse(sample('maple-trust-chequing-2026-10.csv'))
    expect(statements).toHaveLength(1)
    const [s] = statements
    expect(s.account).toEqual({ key: expect.stringMatching(/^csv:layout:[0-9a-f]{16}$/), keyStrength: 'weak', label: 'CSV file with columns Date, Description, Withdrawals, Deposits, Balance, Status' })
    expect(s.balance).toEqual({ amount: '4677.80', asOf: '2026-10-31' })
    expect(s.lines).toHaveLength(17)
    expect(s.period).toBeUndefined()
    expect(warnings).toEqual([{ message: '1 pending transaction was left out; it\'ll come with a later export, once the bank posts it.' }])
  })

  it('one per account number: strong keys, found by number', async () => {
    const { statements } = await parse(sample('harbour-bank-2026-10.csv'))
    expect(statements.map(s => s.account)).toEqual([
      { key: 'csv:account:223301-4410', keyStrength: 'strong', accountNumber: '223301-4410', label: 'Account •••• 4410 (CSV)' },
      { key: 'csv:account:223301-4411', keyStrength: 'strong', accountNumber: '223301-4411', label: 'Account •••• 4411 (CSV)' }
    ])
    expect(statements.map(s => s.balance)).toEqual([{ amount: '2148.74', asOf: '2026-10-24' }, { amount: '5306.12', asOf: '2026-10-31' }])
  })

  it('a masked card number is partial', async () => {
    const { statements: [s] } = await parse(corpus('05-headerless-card-number.csv'))
    expect(s.account).toMatchObject({ key: 'csv:account:4500********1234', accountNumber: '4500********1234', numberIsPartial: true, label: 'Account •••• 1234 (CSV)' })
  })

  it('a headerless file’s label names the roles of its columns', async () => {
    const { statements: [s] } = await parse(corpus('10-headerless-signed-type.csv'))
    expect(s.account.label).toBe('CSV file with 5 columns: Date, Amount, (ignored), Memo, Payee')
  })

  it('the same signature for files with the same header, another for another', async () => {
    const key = async (file: ReturnType<typeof importFile>) => (await parse(file)).statements[0].account.key
    expect(await key(sample('maple-trust-chequing-2026-10.csv'))).toBe(await key(sample('maple-trust-chequing-2026-11.csv')))
    // 01 and 09 have the same header, Date, Description, Amount: the same layout, whatever their rows hold
    expect(await key(corpus('01-header-signed.csv'))).toBe(await key(corpus('09-card-positive-charges.csv')))
    expect(await key(corpus('01-header-signed.csv'))).not.toBe(await key(corpus('02-header-out-in-balance.csv')))
    expect(await key(corpus('03-headerless-out-in-balance.csv'))).not.toBe(await key(corpus('04-headerless-out-in.csv')))
  })

  it('warns about the rows it left out, each by its line in the file', async () => {
    const text = 'Date,Description,Amount\n2026-10-02,A,-1.00\n"2026-10-03","B\nsecond line",-2.00\nTOTAL,,-3.00\n2026-10-05,C,abc\n'
    const { warnings } = await parse(importFile('x.csv', text))
    expect(warnings).toEqual([
      { message: 'Left out: “TOTAL” isn\'t a date.', line: 5 },
      { message: 'Left out: “abc” isn\'t an amount.', line: 6 }
    ])
  })

  it('trusts no bank id that repeats in the file', async () => {
    const { statements: [s], warnings } = await parse(importFile('x.csv', 'Date,Description,Amount,Transaction ID\n2026-10-02,A,-1.00,7\n2026-10-03,B,-2.00,7\n'))
    expect(s.stableIds).toBe(false)
    expect(s.lines.map(l => l.externalId)).toEqual(['7', '7'])
    expect(warnings).toEqual([{ message: 'The bank ids in its id column repeat, so lines are recognised by their date, amount and payee instead.' }])
  })

  it('refuses rows in more than one currency', async () => {
    const err = await failure(format.parse(importFile('x.csv', 'Date,Description,Amount,Currency\n2026-10-02,A,-1.00,CAD\n2026-10-03,B,-2.00,USD\n'), contextOf().context))
    expect(isImportError(err) && err.message).toBe('x.csv has rows in more than one currency (CAD, USD). Export each currency separately.')
  })

  it('gives the dialog the start of a very long file, cut at a row’s end', async () => {
    const row = '2026-10-05,POS PURCHASE COSTCO WHSE #0123 OTTAWA ON,-84.12\n'
    const text = `Date,Description,Amount\n${row.repeat(Math.ceil(2_100_000 / row.length))}`
    const ctx = contextOf(new Map(), () => ({ kind: 'skip' }))
    await format.parse(importFile('long.csv', text), ctx.context)
    expect(ctx.shown[0].truncated).toBe(true)
    expect(ctx.shown[0].text.length).toBeLessThanOrEqual(2_000_000)
    expect(ctx.shown[0].text.endsWith('-84.12')).toBe(true)
  }, 30_000)
})

describe('correct: a reversal the user asked to remember', () => {
  it('flips the reversed of the layout that made the statement’s key, by layout or by account', async () => {
    const ctx = contextOf()
    const { statements: [s] } = await parse(sample('northwind-visa-2026-10.csv'), ctx)
    const signature = s.account.key!.slice('csv:layout:'.length)
    const memory = contextOf(ctx.memory).context.memory
    expect(await format.correct!({ kind: 'signsReversed', key: s.account.key! }, { memory })).toBe(true)
    expect((ctx.memory.get(MEMORY.layout(signature)) as RememberedLayout).layout.reversed).toBe(false)
    // The next file's dialog shows it
    await parse(sample('northwind-visa-2026-10.csv'), ctx)
    expect(ctx.shown[1]).toMatchObject({ start: 'remembered', layout: { reversed: false } })

    const { statements: [card] } = await parse(corpus('05-headerless-card-number.csv'), ctx)
    expect(await format.correct!({ kind: 'signsReversed', key: card.account.key! }, { memory })).toBe(true)
    const cardSignature = ctx.memory.get(MEMORY.key(card.account.key!)) as string
    expect((ctx.memory.get(MEMORY.layout(cardSignature)) as RememberedLayout).layout.reversed).toBe(true)
  })

  it('says it can’t for a key it never made', async () => {
    expect(await format.correct!({ kind: 'signsReversed', key: 'csv:account:nope' }, { memory: contextOf().context.memory })).toBe(false)
    expect(await format.correct!({ kind: 'signsReversed', key: 'csv:layout:0000' }, { memory: contextOf().context.memory })).toBe(false)
  })
})

describe('describeMemory: what the format remembers, as Saved Import Choices lists it', () => {
  it('describes a layout by its columns and settings, and not its own index', async () => {
    const ctx = contextOf(new Map(), input => ({ kind: 'layout', layout: { ...input.layout, decimal: ',' } }))
    await parse(sample('northwind-visa-2026-10.csv'), ctx)
    const [key, value] = [...ctx.memory.entries()].find(([k]) => k.startsWith('layout:'))!
    expect(format.describeMemory!(key, value)).toEqual({
      what: 'CSV columns', source: 'Date, Payee, Amount', detail: 'Dates month first · a comma for decimals · amounts reversed · no header · last imported 6 Nov 2026'
    })
    for (const [other, v] of ctx.memory.entries()) if (!other.startsWith('layout:')) expect(format.describeMemory!(other, v)).toBeUndefined()
    // A layout remembered before its columns' names were: named by their roles
    const { columns: _, ...older } = value as Record<string, unknown>
    expect(format.describeMemory!(key, older)?.source).toBe('Date, Payee, Amount')
    expect(format.describeMemory!(key, { nonsense: true })).toBeUndefined()
  })
})
