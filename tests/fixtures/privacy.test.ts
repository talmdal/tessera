// @vitest-environment node
// Nothing personal-looking in the statements the repository keeps: the made-up samples (samples/statements) and the
// import fixtures (tests/fixtures/import), including anonymised real files. The anonymiser's own scan
// (scripts/anonymise/scan.ts) runs over each: card numbers, long numbers, email addresses, phone numbers, postal
// codes, social insurance and security numbers, IBANs. A real file committed without `npm run anonymise` fails here.
//
// Made-up values that look personal on purpose are allowed below, each with its reason. Add one only for a value
// you made up yourself, never for one from a real file.
//
// A file named as the anonymiser names its output ('*.anon.*', in tests/fixtures/import/real/) is checked as one: its
// payees, memos, account numbers, ids and amounts are the anonymiser's own made-up values, which no scan can tell from
// real ones, so only what the anonymiser keeps as it was is looked at (codes, the bank, cheque numbers, stray text).
// A raw file committed by mistake isn't named so, and is checked in full.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { isAnonymised } from '../../scripts/anonymise/index'
import { checkableCsv } from '../../scripts/anonymise/csv'
import { checkableQif } from '../../scripts/anonymise/qif'
import { checkableOfx, isOfx } from '../../scripts/anonymise/ofx'
import { plain, scan } from '../../scripts/anonymise/scan'

const repo = path.resolve(__dirname, '../..')
const FOLDERS = ['samples/statements', 'tests/fixtures/import']
const STATEMENTS = /\.(ofx|qfx|qbo|csv|qif|txt|json)$/i

/** Made-up values in the samples and fixtures that look personal on purpose. */
const ALLOWED: { file: RegExp, text: string, why: string }[] = [
  { file: /maple-trust-chequing-2026-1[01]/, text: '8812345678', why: 'the made-up Maple Trust chequing account number, which the walkthroughs type in' },
  { file: /lakeside-business/, text: '4002290117', why: 'the made-up Lakeside Credit Union account number' },
  { file: /cedar-savings/, text: '7703301', why: 'the made-up Cedar Credit Union account number' },
  { file: /northwind-visa/, text: '0142325781', why: 'a made-up airline ticket number, as card statements show them' },
  { file: /northwind-visa/, text: '866-579-7172', why: 'a made-up merchant phone number, as card statements show them' },
  { file: /qbo\/converter-[ab]/, text: '6100440', why: 'the made-up Pine Street Bank account number of the converter fixtures' },
  { file: /csv\/layouts\/06-/, text: '5012345', why: 'a made-up account number, in the layout of a bank that writes it after the transit number' },
  { file: /csv\/layouts\/07-/, text: '20261031', why: 'a date written in a preamble\'s sentence, as one bank writes it' }
]

function files(): string[] {
  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true })
    .flatMap(entry => entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)])
  return FOLDERS.flatMap(folder => walk(path.join(repo, folder))).filter(file => STATEMENTS.test(file) && !file.endsWith('.meta.json'))
}

/** What the scan finds in a file that isn't allowed. */
function findingsIn(file: string) {
  const text = fs.readFileSync(file, 'utf8')
  const anonymised = isAnonymised(file)
  const scannable = /\.(ofx|qfx|qbo)$/i.test(file) || isOfx(text) ? checkableOfx(text, { anonymised })
    : /\.csv$/i.test(file) ? checkableCsv(text, { anonymised })
    : /\.qif$/i.test(file) ? checkableQif(text, { anonymised }) : plain(text)
  const relative = path.relative(repo, file).split(path.sep).join('/')
  return scan(scannable).filter(f => !ALLOWED.some(a => a.file.test(relative) && a.text === f.text)).map(f => `${relative}:${f.line}: ${f.kind} ${f.masked}`)
}

describe('the statements the repository keeps', () => {
  it('hold nothing that looks personal, apart from the made-up values allowed above', () => {
    const all = files()
    expect(all.length).toBeGreaterThan(20)
    expect(all.flatMap(findingsIn)).toEqual([])
  })

  it('would be caught holding a card number or an email address', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-privacy-'))
    const planted = path.join(dir, 'maple-trust-chequing-2026-10.ofx')      // the sample, with something planted
    fs.writeFileSync(planted, fs.readFileSync(path.join(repo, 'samples/statements/maple-trust-chequing-2026-10.ofx'), 'utf8')
      .replace('<MEMO>Cheque cleared', '<MEMO>Card 4111 1111 1111 1111, jane.doe@example.com'))
    expect(findingsIn(planted).map(f => f.replace(/^.*: /, ''))).toEqual(['card number •••• •••• •••• ••11', 'email address ••••.•••@•••••••.•om'])
  })

  it('allow only values that are still in the files, so the list can’t go stale', () => {
    const texts = files().map(file => [path.relative(repo, file).split(path.sep).join('/'), fs.readFileSync(file, 'utf8')] as const)
    for (const allowed of ALLOWED) {
      expect(texts.some(([name, text]) => allowed.file.test(name) && text.includes(allowed.text)), allowed.why).toBe(true)
    }
  })
})
