// The view's pure parts (phase R3): how figures read, the chart's series and its words for screen readers, the rows a
// folded tree leaves, Page Up and Page Down, and the rule that carries Accounts from report to report.
import { describe, expect, it } from 'vitest'
import { formatAmount } from '@tessera/accounts-api'
import type { ResultColumn, ResultRow } from '@tessera/reports-api'
import { chartLabel, chartModel, toneOf } from '../../../../plugins/reports/src/renderer/chartModel'
import { figure, percent } from '../../../../plugins/reports/src/renderer/display'
import { stepParameters } from '../../../../plugins/reports/src/renderer/ParameterBar'
import { canDrill, columnWidthEm, headingGroups, isBad, visibleRows } from '../../../../plugins/reports/src/renderer/tableModel'
import { carryScope } from '../../../../plugins/reports/src/privileged/viewSupport'
import { incomeResult, openedOf, spendingResult } from './fixtures'

describe('figures', () => {
  it('reads basis points as a percentage to one decimal, toward zero, as the engine rounds shares', () => {
    expect([4529, -4529, 0, 5, 99999, 100000].map(percent)).toEqual(['45.2 %', '-45.2 %', '0.0 %', '0.0 %', '999.9 %', '1,000.0 %'])
  })

  it('reads each column’s unit: money from minor units, counts, percentages, and nothing as a dash', () => {
    const money: Pick<ResultColumn, 'unit'> = { unit: 'money' }
    expect(figure(-95010, money, 'CAD')).toBe('-950.10')
    expect(figure(1200, money, 'JPY')).toBe('1,200')
    expect(figure(1234, { unit: 'count' }, 'CAD')).toBe('1,234')
    expect(figure(5118, { unit: 'percent' }, 'CAD')).toBe('51.1 %')
    expect(figure(null, money, 'CAD')).toBe('—')
  })
})

describe('the chart', () => {
  it('colours what means money in and out, and a net or total over bars, by what it is', () => {
    expect(['income', 'transferIn', 'asset', 'expense', 'transferOut', 'liability'].map(key => toneOf({ key }, 'groupedBar')))
      .toEqual(['positive', 'positive', 'positive', 'negative', 'negative', 'negative'])
    expect(toneOf({ key: 'net:0', as: 'line' }, 'groupedBar')).toBe('emphasis')
    expect(toneOf({ key: 'total', as: 'line' }, 'bar')).toBe('emphasis')
    expect(toneOf({ key: 'food' }, 'line')).toBeUndefined()
  })

  it('makes Income vs Expenses income and expenses as bars with the net as a line', () => {
    const model = chartModel(incomeResult())!
    expect(model.kind).toBe('groupedBar')
    expect(model.categories).toEqual(['Jan 2026', 'Feb 2026', 'Mar 2026'])
    expect(model.series.map(s => [s.label, s.as, s.tone])).toEqual([['Income', 'bar', 'positive'], ['Expenses', 'bar', 'negative'], ['Net income', 'line', 'emphasis']])
    // With the currency as this machine's locale writes it ("$4,200.00", "CA$4,200.00")
    const cad = (minor: number) => formatAmount(minor, 'CAD')
    expect(model.label).toBe(`Income vs Expenses, bar chart: Income ${cad(420000)} in Mar 2026, Expenses ${cad(515010)} in Mar 2026, Net income ${cad(-95010)} in Mar 2026`)
  })

  it('tells a donut as each slice’s share of the whole, and says how many more past a dozen', () => {
    expect(chartModel(spendingResult())!.label).toBe('Spending by Category, donut chart: Housing 51.1 %, Food 27.4 %, Transportation 11.9 %, Utilities 8.9 %, Uncategorised 0.4 %')
    const many = { kind: 'bar' as const, categories: Array.from({ length: 15 }, (_, i) => `P${i}`), series: [{ key: 'value', label: 'Spending', values: Array(15).fill(100) }], unit: 'money' as const }
    expect(chartLabel({ title: 'Payees', currency: 'CAD' }, many).endsWith(`P11 ${formatAmount(100, 'CAD')}, and 3 more`)).toBe(true)
  })

  it('draws no chart for a result without one, or with nothing in it', () => {
    expect(chartModel(incomeResult({ chart: undefined }))).toBeUndefined()
    expect(chartModel(incomeResult({}, []))).toBeUndefined()
  })
})

describe('the table', () => {
  const r = (id: string, parentId?: string, extra: Partial<ResultRow> = {}): ResultRow => ({ id, label: id, depth: parentId ? 2 : 1, kind: 'member', values: [1], ...(parentId && { parentId }), ...extra })

  it('hides every row under a folded one, however deep', () => {
    const rows = [r('food'), r('groceries', 'food'), r('organic', 'groceries'), r('housing')]
    expect(visibleRows(rows, new Set(['food'])).map(x => x.row.id)).toEqual(['food', 'housing'])
    expect(visibleRows(rows, new Set(['groceries'])).map(x => [x.row.id, x.parent, x.open])).toEqual([
      ['food', true, true], ['groceries', true, false], ['housing', false, true]
    ])
  })

  it('colours a figure only when negative, of money, in a row where that is bad', () => {
    const net = r('net', undefined, { negativeIsBad: true })
    expect(isBad(net, { unit: 'money' }, -1)).toBe(true)
    expect(isBad(net, { unit: 'money' }, 0)).toBe(false)
    expect(isBad(net, { unit: 'percent' }, -1)).toBe(false)
    expect(isBad(r('food'), { unit: 'money' }, -1)).toBe(false)
  })

  it('offers a figure’s transactions only where both its row and its column say what they cover', () => {
    const column: ResultColumn = { key: 'c0', label: 'Jan', unit: 'money', drill: { measure: 'amount', months: ['2026-01'] } }
    expect(canDrill(r('food', undefined, { drill: { keys: ['food'] } }), column, 100)).toBe(true)
    expect(canDrill(r('food', undefined, { drill: { keys: ['food'] } }), column, null)).toBe(false)
    expect(canDrill(r('food'), column, 100)).toBe(false)
    expect(canDrill(r('food', undefined, { drill: {} }), { ...column, drill: undefined }, 100)).toBe(false)
  })

  it('heads columns that share a month in a row above, and widens a column in em for its longest figure', () => {
    const columns: ResultColumn[] = [
      { key: 'a', label: 'Spending', group: 'Jan', unit: 'money' }, { key: 'b', label: 'Share', group: 'Jan', unit: 'percent' },
      { key: 'c', label: 'Spending', group: 'Total', unit: 'money' }
    ]
    expect(headingGroups(columns)).toEqual([{ label: 'Jan', span: 2 }, { label: 'Total', span: 1 }])
    expect(headingGroups([{ key: 'a', label: 'Total', unit: 'money' }])).toBeUndefined()
    expect(columnWidthEm(columns[0], ['1.00'])).toBeLessThan(columnWidthEm(columns[0], ['1,234,567,890.00']))
  })
})

describe('Page Up and Page Down', () => {
  const view = openedOf('incomeVsExpenses')
  it('step a year by a year, a month by a month, and any other span by its days', () => {
    expect(stepParameters({ period: { preset: 'thisYear' } }, -1, view)!.period).toEqual({ from: '2026-01-01', to: '2026-12-31' })
    expect(stepParameters({ period: { preset: 'lastMonth' } }, 1, view)!.period).toEqual({ from: '2027-01-01', to: '2027-01-31' })
    expect(stepParameters({ period: { from: '2026-03-10', to: '2026-03-19' } }, 1, view)!.period).toEqual({ from: '2026-03-20', to: '2026-03-29' })
    expect(stepParameters({ period: { preset: 'allDates' } }, 1, view)).toBeUndefined()
  })

  it('step a balance’s date by a month, keeping a month end a month end, and dates over a period by the period', () => {
    const balances = { ...view, source: { ...view.source, time: 'asOf' as const } }
    expect(stepParameters({ asOf: { date: '2026-02-28' } }, 1, balances)!.asOf).toEqual({ date: '2026-03-31' })
    expect(stepParameters({ asOf: { date: '2026-01-15' } }, -1, balances)!.asOf).toEqual({ date: '2025-12-15' })
    expect(stepParameters({ asOf: { at: 'endOfLastMonth' } }, -1, balances)!.asOf).toEqual({ date: '2026-11-30' })
    // The last 12 months on 15 January 2027 are February 2026 to January 2027
    expect(stepParameters({ asOf: { ends: { preset: 'last12Months' } } }, -1, balances)!.asOf).toEqual({ ends: { from: '2025-02-01', to: '2026-01-31' } })
  })
})

describe('Accounts, carried from report to report', () => {
  const ALL = ['ledger', 'subLedger', 'types', 'accounts'] as const
  const subs = new Set(['personal'])
  const everyday = { kind: 'types' as const, types: ['chequing' as const, 'savings' as const] }

  it('keeps the sub-ledger chosen, as everyday accounts in it for a report that starts on them', () => {
    const personal = { kind: 'subLedger' as const, subLedgerId: 'personal' }
    expect(carryScope(personal, { kind: 'ledger' }, ALL, subs)).toEqual(personal)
    expect(carryScope(personal, everyday, ALL, subs)).toEqual({ ...everyday, subLedgerId: 'personal' })
    expect(carryScope({ ...everyday, subLedgerId: 'personal' }, { kind: 'ledger' }, ALL, subs)).toEqual(personal)
  })

  it('carries types only to a report that starts on types, accounts only to one that takes them, and a deleted sub-ledger not at all', () => {
    const cards = { kind: 'types' as const, types: ['creditCard' as const] }
    expect(carryScope(cards, everyday, ALL, subs)).toEqual(cards)
    expect(carryScope({ kind: 'accounts', accountIds: ['a'] }, { kind: 'ledger' }, ALL, subs)).toEqual({ kind: 'accounts', accountIds: ['a'] })
    expect(carryScope({ kind: 'accounts', accountIds: ['a'] }, { kind: 'ledger' }, ['ledger', 'subLedger'], subs)).toEqual({ kind: 'ledger' })
    expect(carryScope({ kind: 'subLedger', subLedgerId: 'gone' }, { kind: 'subLedger', subLedgerId: 'personal' }, ALL, subs)).toEqual({ kind: 'ledger' })
    expect(carryScope(undefined, everyday, ALL, subs)).toEqual(everyday)
  })
})
