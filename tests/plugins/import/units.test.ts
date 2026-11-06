// @vitest-environment node
// The import plugin's pure parts: decoding text, payee cleaning and similarity, converting lines, choosing a format, drafts, and how
// the Account dialog ranks accounts and fills in a new one.
import { describe, expect, it, vi } from 'vitest'
import { ExtensionRegistryImpl } from '../../../core/extensions/ExtensionRegistry'
import { ServiceRegistryImpl } from '../../../core/services/ServiceRegistry'
import type { Account, AccountSummary, Category, PayeeSuggestion } from '@tessera/accounts-api'
import { IMPORT_FORMATS_POINT, type ImportFormat, type ParsedStatement } from '@tessera/import-api'
import { accountFromStatement, fileNameKey, identityOf, rankChoices } from '../../../plugins/import/src/privileged/accountResolution'
import { convertLines, fingerprint, toMinor } from '../../../plugins/import/src/privileged/convert'
import { Drafts } from '../../../plugins/import/src/privileged/drafts'
import { decode } from '../../../plugins/import/src/privileged/files'
import { Formats } from '../../../plugins/import/src/privileged/formats'
import { bankName, jaroWinkler, normalizePayee, normalizeSearch, payeeSimilarity, tidyPayee } from '../../../plugins/import/src/privileged/matching/payees'

describe('decoding a file’s text', () => {
  const bytes = (...values: number[]) => new Uint8Array(values)

  it('reads windows-1252 as the Encoding Standard does, under all its labels, with € and curly quotes', () => {
    // 0x80 € 0x91 ‘ 0x92 ’ 0x93 “ 0x94 ” 0x96 – 0x97 — 0x85 … 0xC9 É 0xE9 é; Node's TextDecoder gives U+0080 etc.
    const quoted = bytes(0x80, 0x20, 0x91, 0x92, 0x93, 0x94, 0x96, 0x97, 0x85, 0x20, 0xc9, 0xe9)
    for (const label of ['windows-1252', 'WINDOWS-1252', 'cp1252', 'latin1', 'iso-8859-1', 'us-ascii']) {
      expect(decode(quoted, label), label).toBe('€ ‘’“”–—… Éé')
    }
    expect(decode(bytes(0x81, 0x8d, 0x8f, 0x90, 0x9d), 'windows-1252')).toBe('\u0081\u008d\u008f\u0090\u009d')  // undefined in 1252
  })

  it('decodes a large windows-1252 file whole', () => {
    const big = new Uint8Array(100_000).fill(0x41)
    big[99_999] = 0x80
    const text = decode(big, 'windows-1252')
    expect(text).toHaveLength(100_000)
    expect(text.endsWith('A€')).toBe(true)
  })

  it('lets a byte-order mark decide, and otherwise reads UTF-8', () => {
    const cafe = [...new TextEncoder().encode('Café')]
    expect(decode(bytes(...cafe))).toBe('Café')
    expect(decode(bytes(0xef, 0xbb, 0xbf, ...cafe), 'windows-1252')).toBe('Café')
    expect(decode(bytes(0xff, 0xfe, 0x43, 0, 0xe9, 0), 'windows-1252')).toBe('Cé')
    expect(decode(bytes(0xfe, 0xff, 0, 0x43, 0, 0xe9))).toBe('Cé')
    expect(decode(bytes(0x43, 0xe9), 'iso-8859-2')).toBe('Cé')                                // other encodings: the runtime's
  })
})

describe('payees', () => {
  it('tidy a bank’s text into a name: no noise, store numbers, references or region; accents kept', () => {
    const cases: [string, string][] = [
      ['POS PURCHASE COSTCO WHSE #0123 OTTAWA ON', 'Costco Whse Ottawa'],
      ['THE KEG #12', 'Keg'],
      ['AMZN MKTP CA*2K3L91', 'Amzn Mktp'],
      ['CAFÉ DÉPÔT #204', 'Café Dépôt'],
      ['SHELL C12345', 'Shell'],
      ['JOHNNY & CO BISTRO', 'Johnny & Co Bistro'],
      ["MCDONALD'S #4455 KANATA ON", "Mcdonald's Kanata"],
      ['7ELEVEN STORE 31', '7eleven Store 31'],
      ['#123 456', '#123 456']                                  // nothing left: the text as it was
    ]
    for (const [bank, tidy] of cases) expect(tidyPayee(bank), bank).toBe(tidy)
  })

  it('keep the bank’s words, as written, for naming the bank’s text to the user', () => {
    expect(bankName('POS PURCHASE COSTCO WHSE #0123')).toBe('COSTCO WHSE')
    expect(bankName('AMZN MKTP CA*2K3L91')).toBe('AMZN MKTP')
    expect(bankName('#123')).toBe('#123')
    expect(normalizeSearch('  Café   DÉPÔT ')).toBe('cafe depot')
  })

  it('normalise for comparing: lower case, no accents, & as and', () => {
    expect(normalizePayee('CAFÉ DÉPÔT #204')).toBe('cafe depot')
    expect(normalizePayee('Johnny & Co')).toBe('johnny and co')
    expect(normalizePayee('PAYMENT')).toBe('payment')           // only noise: compared as itself
    expect(normalizePayee(undefined)).toBe('')
  })

  it('are alike as the design scores them: the same name 1, one inside the other 0.9, a truncated name by its first word', () => {
    expect(jaroWinkler('amzn', 'amazon')).toBeCloseTo(0.911, 3)
    expect(payeeSimilarity('THE KEG #12', 'The Keg')).toBe(1)
    expect(payeeSimilarity('COSTCO WHSE #0123', 'Costco')).toBeGreaterThanOrEqual(0.9)
    expect(payeeSimilarity('COSTCO WHSE #0123', 'Costco')).toBeLessThan(1)
    expect(payeeSimilarity('HYDRO ONE NETWORKS', 'Hydro One')).toBeCloseTo(0.9, 1)
    expect(payeeSimilarity('AMZN MKTP CA*2K3L91', 'Amazon')).toBeGreaterThan(0.8)
    expect(payeeSimilarity('LOBLAWS #1001', 'The Keg')).toBeLessThan(0.5)
    expect(payeeSimilarity('', 'Costco')).toBe(0)
  })
})

describe('converting lines', () => {
  it('turns canonical decimals into minor units for any currency, dropping only trailing zeros', () => {
    expect(toMinor('-84.12', 'CAD')).toEqual({ ok: true, value: -8412 })
    expect(toMinor('-12.3400', 'CAD')).toEqual({ ok: true, value: -1234 })
    expect(toMinor('1200', 'JPY')).toEqual({ ok: true, value: 1200 })
    expect(toMinor('1.500', 'BHD')).toEqual({ ok: true, value: 1500 })
    expect(toMinor('12.345', 'CAD')).toEqual({ ok: false, problem: '12.345 has more decimals than CAD allows (2)' })
    expect(toMinor('12.5', 'JPY')).toMatchObject({ ok: false })
    expect(toMinor('1,234.00', 'CAD')).toMatchObject({ ok: false })          // not canonical
  })

  it('leaves out what it can’t read, and zero amounts, with a warning each, and keeps the rest', () => {
    const { lines, invalid, warnings } = convertLines([
      { date: '2026-10-05', amount: '-1.00', externalId: 'A' },
      { date: '2026-13-05', amount: '-1.00', externalId: 'B' },
      { date: '2026-10-05', amount: '-1.005', externalId: 'C' },
      { date: '2026-10-05', amount: '0.00', externalId: 'D' }
    ], 'CAD')
    expect(lines.map(l => l.importId)).toEqual(['A'])
    expect(invalid).toBe(3)
    expect(warnings).toEqual([
      'Line 2: “2026-13-05” isn\'t a date, so the line was left out.',
      'Line 3: -1.005 has more decimals than CAD allows (2), so the line was left out.',
      'Line 4: an amount of zero (usually a card authorisation) was left out.'
    ])
  })

  it('cuts long text to what a transaction holds, and keeps a long cheque number in the memo', () => {
    const [line] = convertLines([{ date: '2026-10-05', amount: '-1', payee: `  ${'X'.repeat(150)}  `, memo: 'Rent', number: 'REF-123456789012345678901' }], 'CAD').lines
    expect(line.bank.payee).toHaveLength(100)
    expect(line.bank.payee!.endsWith('…')).toBe(true)
    expect(line.bank.number).toBeUndefined()
    expect(line.bank.memo).toBe('Rent (REF-123456789012345678901)')
  })

  it("knows a line by the bank's id, or else by a fingerprint, numbered when the same line repeats", () => {
    const coffee = { date: '2026-10-29', amount: '-4.75', payee: 'TIM HORTONS #4021' }
    const first = convertLines([coffee, coffee, { ...coffee, amount: '-5.25' }], 'CAD').lines.map(l => l.importId)
    const base = fingerprint({ date: '2026-10-29', amount: -475, payee: 'TIM HORTONS #4021' })
    expect(first).toEqual([`${base}#1`, `${base}#2`, fingerprint({ date: '2026-10-29', amount: -525, payee: 'TIM HORTONS #4021' })])
    expect(base).toMatch(/^fp:[0-9a-f]{16}$/)
    // The same line in another file (another store number, even) has the same fingerprint: it's the same purchase
    expect(convertLines([coffee], 'CAD').lines[0].importId).toBe(base)
    expect(fingerprint({ date: '2026-10-29', amount: -475, payee: 'Tim Hortons #9999' })).toBe(base)
    // Bank ids win, unless the format says they can't be trusted
    expect(convertLines([{ ...coffee, externalId: 'X1' }], 'CAD').lines[0].importId).toBe('X1')
    expect(convertLines([{ ...coffee, externalId: 'X1' }], 'CAD', { stableIds: false }).lines[0].importId).toBe(base)
  })

  it('counts the same bank id twice in a file as one line', () => {
    const { lines, repeated } = convertLines([{ date: '2026-10-05', amount: '-1', externalId: 'A' }, { date: '2026-10-06', amount: '-2', externalId: 'A' }], 'CAD')
    expect(lines).toHaveLength(1)
    expect(repeated).toBe(1)
  })
})

describe('choosing a format', () => {
  function setup(formats: { id: string, extensions: string[], sniff?: ImportFormat['sniff'], provided?: boolean, order?: number }[]) {
    const extensions = new ExtensionRegistryImpl()
    const services = new ServiceRegistryImpl()
    const log = { warn: vi.fn() }
    for (const f of formats) {
      const [plugin] = f.id.split('.')
      extensions.contribute(plugin, IMPORT_FORMATS_POINT, f.id, { id: f.id, label: `Label ${f.id}`, extensions: f.extensions, service: `${f.id}.svc`, ...(f.order !== undefined && { order: f.order }) })
      if (f.provided !== false) services.provide(plugin, `${f.id}.svc`, { parse: async () => ({ statements: [] }), ...(f.sniff && { sniff: f.sniff }) })
    }
    return { formats: new Formats(extensions, services, log), extensions, log }
  }
  const file = (name: string) => ({ name, extension: name.split('.').pop()!, head: new Uint8Array() })

  it('builds the dialog’s filters: everything importable first, each format, then all files', () => {
    const { formats } = setup([{ id: 'b.csv', extensions: ['csv', 'txt'] }, { id: 'a.ofx', extensions: ['ofx', 'qfx'], order: -1 }])
    expect(formats.filters()).toEqual([
      { name: 'All supported statements', extensions: ['ofx', 'qfx', 'csv', 'txt'] },
      { name: 'Label a.ofx', extensions: ['ofx', 'qfx'] },
      { name: 'Label b.csv', extensions: ['csv', 'txt'] },
      { name: 'All files', extensions: ['*'] }
    ])
  })

  it('chooses by extension, then by sniffing, and asks when still unsure', async () => {
    const yes = async () => true
    const no = async () => false
    const { formats } = setup([
      { id: 'a.ofx', extensions: ['ofx'], sniff: yes },
      { id: 'b.csv', extensions: ['csv', 'txt'], sniff: no },
      { id: 'c.txt', extensions: ['txt'] },                        // can't sniff: maybe
      { id: 'd.bad', extensions: ['dat'], sniff: () => { throw new Error('boom') } }
    ])
    expect(await formats.choose(file('x.ofx'))).toMatchObject({ kind: 'one', format: { id: 'a.ofx' } })
    expect(await formats.choose(file('x.txt'))).toMatchObject({ kind: 'one', format: { id: 'c.txt' } })   // b said no
    expect(await formats.choose(file('x.dat'))).toMatchObject({ kind: 'one', format: { id: 'd.bad' } })  // its extension decides
    // No format claims .pdf: every format is asked (d's sniff throws: no); the one that recognises it wins over
    // those that can't tell
    expect(await formats.choose(file('x.pdf'))).toMatchObject({ kind: 'one', format: { id: 'a.ofx' } })
  })

  it('asks when two formats claim a file, skips formats whose plugin is missing, and warns once per bad contribution', async () => {
    const { formats, extensions, log } = setup([
      { id: 'a.ofx', extensions: ['ofx'], sniff: async () => true },
      { id: 'b.ofx', extensions: ['ofx'] },
      { id: 'c.gone', extensions: ['ofx'], provided: false }
    ])
    expect(await formats.choose(file('x.ofx'))).toMatchObject({ kind: 'several', formats: [{ id: 'a.ofx' }, { id: 'b.ofx' }] })
    extensions.contribute('z', IMPORT_FORMATS_POINT, 'bad1', { id: 'other.x', label: 'x', extensions: ['x'], service: 's' })
    extensions.contribute('z', IMPORT_FORMATS_POINT, 'bad2', { id: 'z.dots', label: 'x', extensions: ['.x'], service: 's' })
    formats.all(); formats.all()
    expect(log.warn.mock.calls.map(([m]) => m)).toEqual([
      '[import] An import format from "z" needs an id starting with "z."',
      '[import] Import format "z.dots" needs extensions in lower case, without dots, such as ["ofx", "qfx"]'
    ])
  })
})

describe('drafts', () => {
  const categories: Category[] = [
    { id: 'fees', parentId: null, name: 'Bank fees', kind: 'expense', rev: 1 },
    { id: 'int', parentId: null, name: 'Interest', kind: 'income', rev: 1 },
    { id: 'paid', parentId: null, name: 'Interest paid', kind: 'expense', rev: 1 },
    { id: 'groc', parentId: null, name: 'Groceries', kind: 'expense', rev: 1 }
  ]
  const payees: PayeeSuggestion[] = [
    { id: 'p1', rev: 1, name: 'Costco', lastCategoryId: 'groc', lastAmount: -8400 },
    { id: 'p2', rev: 1, name: 'Savings transfer', lastTransferAccountId: 's' }
  ]
  const line = (payee: string | undefined, extra: object = {}) =>
    ({ importId: 'X', bank: { date: '2026-10-06', amount: -100, ...(payee && { payee }), ...extra } })

  it("uses an existing payee named almost the same, with its category; otherwise tidies the bank's text", () => {
    const drafts = new Drafts({ payees: [...payees], categories, liability: false })
    expect(drafts.draftFor(line('POS PURCHASE COSTCO WHSE #0123'))).toEqual({
      date: '2026-10-06', amount: -100, status: 'electronic', externalId: 'X', payee: 'Costco', categoryId: 'groc'
    })
    expect(drafts.draftFor(line('HYDRO ONE NETWORKS'))).toMatchObject({ payee: 'Hydro One Networks' })
    expect(drafts.draftFor(line('HYDRO ONE NETWORKS #2'))).toMatchObject({ payee: 'Hydro One Networks' })  // the same new payee
    expect(drafts.draftFor(line(undefined))).not.toHaveProperty('payee')
  })

  it('uses the payee a saved alias names before any other, with its category, and counts the alias as used', () => {
    const drafts = new Drafts({ payees: [...payees], categories, liability: false, aliases: new Map([['amzn mktp', 'costco']]) })
    expect(drafts.draftFor(line('AMZN MKTP CA*2K3L91'))).toMatchObject({ payee: 'Costco', categoryId: 'groc' })
    expect(drafts.usedAliases).toEqual(new Set(['amzn mktp']))
    // An alias for a payee the ledger no longer has still names it (it is created again), without a category
    const gone = new Drafts({ payees: [], categories, liability: false, aliases: new Map([['amzn mktp', 'Amazon']]) })
    expect(gone.draftFor(line('AMZN MKTP CA*9Z8Y7X'))).toMatchObject({ payee: 'Amazon' })
    expect(gone.draftFor(line('AMZN MKTP CA*9Z8Y7X'))).not.toHaveProperty('categoryId')
  })

  it('names a payee found partway through the import the same way for the lines after it', () => {
    const drafts = new Drafts({ payees: [], categories, liability: false })
    expect(drafts.draftFor(line('BELL CANADA')).payee).toBe('Bell Canada')
    expect(drafts.draftFor(line('HYDRO ONE')).payee).toBe('Hydro One')
    expect(drafts.draftFor(line('BELL CANADA #22')).payee).toBe('Bell Canada')
    expect(drafts.draftFor(line('HYDRO ONE NETWORKS')).payee).toBe('Hydro One')
  })

  it('gives no category for a payee last used for a transfer: it would make the other side', () => {
    const drafts = new Drafts({ payees: [...payees], categories, liability: false })
    expect(drafts.draftFor(line('SAVINGS TRANSFER'))).not.toHaveProperty('categoryId')
  })

  it('chooses a category from the kind of line: fees, and interest earned or paid', () => {
    const asset = new Drafts({ payees: [], categories, liability: false })
    const card = new Drafts({ payees: [], categories, liability: true })
    expect(asset.draftFor(line('MONTHLY FEE', { kind: 'serviceCharge' })).categoryId).toBe('fees')
    expect(asset.draftFor(line('INTEREST', { kind: 'interest' })).categoryId).toBe('int')
    expect(card.draftFor(line('INTEREST', { kind: 'interest' })).categoryId).toBe('paid')
    expect(new Drafts({ payees: [], categories: [], liability: false }).draftFor(line('FEE', { kind: 'fee' }))).not.toHaveProperty('categoryId')
  })
})

describe('the Account dialog’s choices', () => {
  const account = (over: Partial<Account>): Account => ({
    id: 'x', rev: 1, name: 'X', type: 'chequing', subLedgerId: null, currency: 'CAD', openingDate: '2026-01-01', openingBalance: 0, order: 0, closed: false, ...over
  })
  const summary = (a: Account): AccountSummary => ({ account: a, balances: { current: 1000, available: 1000, cleared: 0, reconciled: 0, transactionCount: 0 } })
  const statement = (over: Partial<ParsedStatement> = {}): ParsedStatement =>
    ({ account: { accountNumber: '8812345678', institution: 'Maple Trust Bank', type: 'chequing' }, currency: 'CAD', lines: [], ...over })

  it('ranks the likely account first, and can’t choose a closed one or one in another currency', () => {
    const { choices, preselectedId } = rankChoices(statement(), [
      summary(account({ id: 'visa', name: 'Visa', type: 'creditCard' })),
      summary(account({ id: 'usd', name: 'US', currency: 'USD', accountNumber: '5678' })),
      summary(account({ id: 'old', name: 'Old', closed: true, accountNumber: '5678' })),
      summary(account({ id: 'bank', name: 'Everyday', institution: 'maple trust bank' })),
      summary(account({ id: 'chq', name: 'Chequing', accountNumber: '88-1234-5678' }))
    ])
    expect(choices.map(c => [c.account.id, c.hint ?? '', c.disabledReason ?? ''])).toEqual([
      ['chq', 'Account number matches', ''], ['bank', 'Same bank', ''], ['visa', '', ''],
      ['usd', 'Account number matches', 'Other currency'], ['old', 'Account number matches', 'Closed']
    ])
    expect(preselectedId).toBe('chq')
    expect(rankChoices(statement(), [summary(account({ id: 'visa' })), summary(account({ id: 'last' }))], 'last').choices[0])
      .toMatchObject({ account: { id: 'last' }, hint: 'Used last time' })
  })

  it('fills in a new account from the statement: opened the day before its first line, at the balance that adds up', () => {
    const s = statement({
      account: { label: 'Maple Trust Bank •••• 5678', accountNumber: '8812345678', institution: 'Maple Trust Bank', type: 'chequing' },
      balance: { amount: '1100.00', asOf: '2026-10-31' },
      lines: [{ date: '2026-10-02', amount: '-100.00' }, { date: '2026-10-05', amount: '200.00' }, { date: '2026-11-02', amount: '-50.00' }]
    })
    expect(accountFromStatement(s, 'CAD', '2026-11-06')).toEqual({
      name: 'Maple Trust Bank 5678', type: 'chequing', currency: 'CAD', institution: 'Maple Trust Bank', accountNumber: '8812345678',
      openingDate: '2026-10-01', openingBalance: 100000
    })
    const card = accountFromStatement({ account: { accountNumber: 'XXXX3456', numberIsPartial: true, label: 'Visa •••• 3456', type: 'creditCard' }, lines: [] }, 'CAD', '2026-11-06')
    expect(card).toEqual({ name: 'Visa •••• 3456', type: 'creditCard', currency: 'CAD', accountNumber: '3456', openingDate: '2026-11-06', openingBalance: 0 })
  })

  it('knows a statement by its key, or by its file’s name when the format gives none', () => {
    expect(identityOf(statement({ account: { key: 'ofx:bank:1:2' } }), 'f', 'x.ofx')).toEqual({ key: 'ofx:bank:1:2', strength: 'strong', fromFileName: false })
    expect(identityOf(statement({ account: { key: 'csv:1', keyStrength: 'weak' } }), 'f', 'x.csv')).toMatchObject({ strength: 'weak' })
    expect(identityOf(statement({ account: {} }), 'f', 'x.csv')).toEqual({ key: 'f:file:x', strength: 'weak', fromFileName: true })
    expect(fileNameKey('qif', 'Checking 2026-10 (2).qif')).toBe('qif:file:checking')
    expect(fileNameKey('qif', 'Checking 2026-11 - Copy.qif')).toBe('qif:file:checking')
  })
})
