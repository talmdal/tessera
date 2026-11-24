// @vitest-environment node
// Export Report… (phase R6): a result's table as CSV, as the view shows it. Exact decimals in CAD, JPY and a
// three-digit currency; shares as decimals of a per cent; rows labelled by their paths; folded rows left out; text a
// spreadsheet would run protected; UTF-8 with a byte-order mark. And every shipped report, run on the household,
// written and read back by Tessera's own CSV reader (the import's), row for row and figure for figure.
import { describe, expect, it } from 'vitest'
import { minorDigits } from '@tessera/accounts-api'
import type { ReportResult, ResultColumn, ResultRow } from '@tessera/reports-api'
import { readCsv, valuesOf } from '../../../plugins/format-csv/src/shared/csv'
import { csvBytes, figureText, reportCsv } from '../../../plugins/reports/src/privileged/csv'
import { DEFINITIONS } from '../../../plugins/reports/src/privileged/definitions'
import { household } from './examples'
import { setupReports } from './harness'

const money = (key: string, label: string, extra: Partial<ResultColumn> = {}): ResultColumn => ({ key, label, unit: 'money', ...extra })
const row = (id: string, label: string, values: (number | null)[], extra: Partial<ResultRow> = {}): ResultRow => ({ id, label, depth: 1, kind: 'member', values, ...extra })
const result = (columns: ResultColumn[], rows: ResultRow[], currency: string | null = 'CAD'): Pick<ReportResult, 'columns' | 'rows' | 'currency'> => ({ columns, rows, currency })
const lines = (text: string) => text.split('\r\n').filter(l => l !== '')

describe('a report as CSV', () => {
  it('writes amounts exactly, with their currency\'s digits: CAD, JPY and BHD', () => {
    expect(figureText(-8412, { unit: 'money' }, 'CAD')).toBe('-84.12')
    expect(figureText(123456789012, { unit: 'money' }, 'CAD')).toBe('1234567890.12')
    expect(figureText(1200, { unit: 'money' }, 'JPY')).toBe('1200')
    expect(figureText(5, { unit: 'money' }, 'BHD')).toBe('0.005')
    expect(figureText(-12345, { unit: 'money' }, 'BHD')).toBe('-12.345')
    // Shares are basis points: 45.20 (per cent); counts are whole; "—" is an empty cell
    expect(figureText(4520, { unit: 'percent' }, 'CAD')).toBe('45.20')
    expect(figureText(-5, { unit: 'percent' }, 'CAD')).toBe('-0.05')
    expect(figureText(12, { unit: 'count' }, 'CAD')).toBe('12')
    expect(figureText(null, { unit: 'money' }, 'CAD')).toBe('')
  })

  it('has a header row, then the rows as the view shows them, each labelled by its path; a heading\'s cells empty', () => {
    const csv = reportCsv(result([money('2026-01', 'Jan'), money('total', 'Total', { total: true })], [
      row('expense', 'Expenses', [null, null], { kind: 'heading' }),
      row('food', 'Food', [81035, 81035], { depth: 2, parentId: 'expense', kind: 'subtotal' }),
      row('groceries', 'Groceries', [59830, 59830], { depth: 3, parentId: 'food' }),
      row('own:food', 'Food (other)', [21205, 21205], { depth: 3, parentId: 'food', kind: 'own' }),
      row('total:expense', 'Total expenses', [81035, 81035], { kind: 'subtotal' })
    ]), { rowsLabel: 'Category' })
    expect(lines(csv.text)).toEqual([
      'Category,Jan,Total',
      'Expenses,,',
      'Expenses : Food,810.35,810.35',
      'Expenses : Food : Groceries,598.30,598.30',
      'Expenses : Food : Food (other),212.05,212.05',
      'Total expenses,810.35,810.35'
    ])
    expect(csv.rows).toBe(5)
    expect(csv.text.endsWith('\r\n')).toBe(true)
  })

  it('leaves out what folded rows hide, as the view does', () => {
    const rows = [
      row('food', 'Food', [81035], { kind: 'subtotal' }),
      row('groceries', 'Groceries', [59830], { depth: 2, parentId: 'food' }),
      row('organic', 'Organic', [10000], { depth: 3, parentId: 'groceries' }),
      row('total', 'Total', [81035], { kind: 'total' })
    ]
    expect(lines(reportCsv(result([money('v', 'Amount')], rows), { collapsed: ['food'] }).text)).toEqual([',Amount', 'Food,810.35', 'Total,810.35'])
    expect(lines(reportCsv(result([money('v', 'Amount')], rows), { collapsed: ['groceries'] }).text)).toEqual([',Amount', 'Food,810.35', 'Food : Groceries,598.30', 'Total,810.35'])
  })

  it('heads a month\'s several figures with the month and the figure, and writes shares as decimals', () => {
    const csv = reportCsv(result([
      money('m1', 'Budget', { group: 'Mar 2027' }), money('m2', 'Actual', { group: 'Mar 2027' }), { key: 'm3', label: '% used', group: 'Mar 2027', unit: 'percent' }
    ], [row('groceries', 'Groceries', [65000, 59830, 9204])]))
    expect(lines(csv.text)).toEqual([',Mar 2027 Budget,Mar 2027 Actual,Mar 2027 % used', 'Groceries,650.00,598.30,92.04'])
  })

  it('says each row\'s currency, in a column of its own, when the report is in each account\'s own', () => {
    const csv = reportCsv(result([money('b', 'Balance')], [
      row('chq', 'Chequing', [150000], { currency: 'CAD' }), row('yen', 'Tokyo savings', [250000], { currency: 'JPY' }), row('bh', 'Manama', [1234567], { currency: 'BHD' })
    ], null), { rowsLabel: 'Account' })
    expect(lines(csv.text)).toEqual(['Account,Currency,Balance', 'Chequing,CAD,1500.00', 'Tokyo savings,JPY,250000', 'Manama,BHD,1234.567'])
  })

  it('protects text a spreadsheet would run as a formula, and quotes commas, quotes and line breaks', () => {
    const csv = reportCsv(result([money('v', 'Amount')], [
      row('a', '=HYPERLINK("http://example.com")', [100]), row('b', '+1 Shop', [200]), row('c', '-Minus', [300]), row('d', '@home', [400]),
      row('e', 'Smith, Jones & "Co"', [500]), row('f', 'Two\nlines', [-600])
    ]))
    expect(lines(csv.text.replace('Two\r\nlines', 'Two<br>lines').replace('Two\nlines', 'Two<br>lines'))).toEqual([
      ',Amount',
      `"'=HYPERLINK(""http://example.com"")",1.00`,
      "'+1 Shop,2.00",
      "'-Minus,3.00",
      "'@home,4.00",
      '"Smith, Jones & ""Co""",5.00',
      '"Two<br>lines",-6.00'
    ])
    // Negative amounts are numbers, not text: never protected
    expect(csv.guarded).toBe(4)
  })

  it('is UTF-8 with a byte-order mark, so a spreadsheet reads the accents', () => {
    const bytes = csvBytes(reportCsv(result([money('v', 'Montant')], [row('c', 'Café Olé', [1250])])))
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    expect(new TextDecoder().decode(bytes.slice(3))).toBe(',Montant\r\nCafé Olé,12.50\r\n')
  })
})

describe('every shipped report as CSV', () => {
  it('reads back with Tessera\'s own CSV reader, row for row and figure for figure, for the household\'s 2026', async () => {
    const env = await setupReports()
    await household(env)
    const parameters = {
      'reports.netWorth': { asOf: { ends: { from: '2026-01-01', to: '2026-12-31' } } },
      'reports.accountBalances': { asOf: { date: '2026-12-31' }, currency: 'all' }
    } as Record<string, object>
    for (const d of DEFINITIONS) {
      const r = await env.reports.run({ definitionId: d.id }, parameters[d.id] ?? { period: { from: '2026-01-01', to: '2026-12-31' } })
      const csv = reportCsv(r)
      const text = new TextDecoder().decode(csvBytes(csv).slice(3))
      const { delimiter, rows } = readCsv(text)
      expect(delimiter, d.id).toBe(',')
      const read = rows.map(valuesOf)
      const each = r.currency === null ? 1 : 0
      expect(read[0], d.id).toEqual(['', ...(each ? ['Currency'] : []), ...r.columns.map(c => [c.group, c.label].filter(Boolean).join(' '))])
      expect(read.length - 1, d.id).toBe(r.rows.length)
      r.rows.forEach((resultRow, i) => {
        const cells = read[i + 1]
        expect(cells[0].endsWith(resultRow.label), `${d.id} ${resultRow.label}`).toBe(true)
        resultRow.values.forEach((v, j) => {
          const cell = cells[1 + each + j]
          if (resultRow.kind === 'heading' || v === null) expect(cell).toBe('')
          // Back to the integers the engine gave: exact, not near
          else {
            const unit = r.columns[j].unit
            const digits = unit === 'count' ? 0 : unit === 'percent' ? 2 : minorDigits(resultRow.currency ?? r.currency!)
            expect(Math.round(Number(cell) * 10 ** digits), `${d.id} ${resultRow.label} ${j}`).toBe(v)
          }
        })
      })
    }
  })
})
