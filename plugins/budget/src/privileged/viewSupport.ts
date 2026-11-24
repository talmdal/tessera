// What the budget plugin's own views and dialogs need beyond the `BudgetService` contract: how a line is named, what a
// new line can be for, and the transactions behind a row's actual. Kept apart from the service, which holds the rules
// every caller gets; these only read, through the service and `accounts.service`.
import {
  categoryLabel, type AccountsService, type Transaction as AccountTransaction
} from '@tessera/accounts-api'
import {
  STATUS_MONTHS_MAX, firstDayOf, isMonth, lastDayOf, monthsOf,
  type BudgetLine, type LineGroup, type MonthRange, type RowRef, type TargetChoice, type TransactionRow
} from '@tessera/budget-api'
import type { BudgetServiceImpl } from './BudgetServiceImpl'
import { classifier, rowKeys, type Placement } from './status'
import { invalid, notFound, targetKey, translate } from './store'

/** What `rowTransactions` reads of a transaction. */
type TransactionRead = Pick<AccountTransaction, 'id' | 'accountId' | 'date' | 'amount' | 'voided' | 'categoryId' | 'transferAccountId'>

export class BudgetViewSupport {
  constructor(private readonly service: BudgetServiceImpl, private readonly accounts: AccountsService) {}

  /** A call into the accounts plugin, its errors as budget errors where they mean something. */
  private async outside<T>(work: () => Promise<T>): Promise<T> {
    try { return await work() } catch (err) { throw translate(err) }
  }

  /** What a line is for, as the view and the dialogs name it: 'Food : Groceries', 'Transfers from Business Chequing'. */
  async describeLine(line: BudgetLine): Promise<{ label: string, group: LineGroup }> {
    if (line.target.kind === 'category') {
      const { categoryId } = line.target
      const categories = await this.outside(() => this.accounts.categories.list())
      const kind = categories.find(c => c.id === categoryId)?.kind ?? 'expense'
      return { label: categoryLabel(categories, categoryId) ?? '(deleted category)', group: kind }
    }
    const { accountId, direction } = line.target
    const name = (await this.outside(() => this.accounts.list())).find(a => a.id === accountId)?.name
    return {
      label: name === undefined ? '(deleted account)' : `${direction === 'in' ? 'Transfers from' : 'Transfers to'} ${name}`,
      group: direction === 'in' ? 'income' : 'expense'
    }
  }

  /**
   * What a new line can be for: every category, by label, then transfers from and to every open account outside the
   * scope in the budget's currency; less those the budget has a line for.
   */
  async targets(budgetId: string): Promise<TargetChoice[]> {
    const budget = await this.service.get(budgetId)
    if (!budget) throw notFound('budget', 'budgetId')
    const [lines, categories, { scope, accounts }] = await Promise.all([this.service.lines(budgetId), this.outside(() => this.accounts.categories.list()), this.service.scope(budget)])
    const taken = new Set(lines.map(l => targetKey(l.target)))
    const byLabel = categories
      .filter(c => !taken.has(`c:${c.id}`))
      .map((c): TargetChoice => ({ target: { kind: 'category', categoryId: c.id }, group: c.kind, label: categoryLabel(categories, c.id) ?? c.name }))
      .sort((a, b) => a.label.localeCompare(b.label))
    const outside = accounts
      .filter(a => !scope.inside.has(a.id) && a.currency === budget.currency && !a.closed && !taken.has(`t:${a.id}`))
      .sort((a, b) => a.name.localeCompare(b.name))
    return [
      ...byLabel,
      ...outside.map((a): TargetChoice => ({ target: { kind: 'transfer', accountId: a.id, direction: 'in' }, group: 'income', label: `Transfers from: ${a.name}` })),
      ...outside.map((a): TargetChoice => ({ target: { kind: 'transfer', accountId: a.id, direction: 'out' }, group: 'expense', label: `Transfers to: ${a.name}` }))
    ]
  }

  /**
   * The transactions behind a row's actual over `range`, by the same rules as the status (`classifier`): each with the
   * amount it adds to the row. Archived months can't be listed; what they add is given apart, with the date the ledger's
   * transactions start from.
   */
  async rowTransactions(budgetId: string, row: RowRef, range: MonthRange): Promise<{ rows: TransactionRow[], total: number, actual: number, archived?: { amount: number, before?: string } }> {
    if (typeof row !== 'object' || row === null) throw invalid('row', 'Choose a row.')
    return this.rowsTransactions(budgetId, [{ row, sign: 1 }], range)
  }

  /**
   * The transactions behind several rows at once, each with a sign: a group's total, or the net (income adding,
   * expenses taking away), as Budget vs Actual asks for them (R5). Each transaction once, with its part of them all.
   */
  async rowsTransactions(budgetId: string, parts: readonly { row: RowRef, sign: 1 | -1 }[], range: MonthRange): Promise<{ rows: TransactionRow[], total: number, actual: number, archived?: { amount: number, before?: string } }> {
    if (typeof range !== 'object' || range === null || !isMonth(range.from) || !isMonth(range.to) || range.to < range.from) throw invalid('months', 'Choose the months, as YYYY-MM.')
    if (monthsOf(range).length > STATUS_MONTHS_MAX) throw invalid('months', `Choose at most ${STATUS_MONTHS_MAX} months.`)
    if (parts.some(p => typeof p.row !== 'object' || p.row === null)) throw invalid('row', 'Choose a row.')
    const { lines, categories, scope, accounts, totals } = await this.service.gather(budgetId, range)
    const { place } = classifier(lines, categories)
    // Each bucket's sign: a transaction is in one bucket, so in one row (a subtotal's buckets are its lines')
    const signs = new Map<string, number>()
    for (const { row, sign } of parts) for (const key of rowKeys(row, lines, categories)) signs.set(key, sign)
    const keys = new Set(signs.keys())
    const counts = (placements: Placement[]) => placements.filter(p => keys.has(p.key)).reduce((sum, p) => sum + signs.get(p.key)! * p.amount, 0)

    let archivedAmount = 0
    for (const t of totals) if (t.archived) archivedAmount += counts(place(t))

    const from = firstDayOf(range.from), to = lastDayOf(range.to)
    const found: { t: TransactionRead, amount: number }[] = []
    for (const accountId of scope.counted) {
      for (const t of await this.outside(() => this.accounts.transactions(accountId).list({ from, to }))) {
        if (t.voided || (t.transferAccountId !== undefined && scope.inside.has(t.transferAccountId))) continue
        const placements = place({
          month: t.date.slice(0, 7), categoryId: t.transferAccountId === undefined ? t.categoryId ?? null : null,
          transferAccountId: t.transferAccountId ?? null, inflow: Math.max(t.amount, 0), outflow: Math.max(-t.amount, 0)
        })
        if (placements.some(p => keys.has(p.key))) found.push({ t, amount: counts(placements) })
      }
    }
    // Payees and labels as the register shows them, read only for the accounts that have any
    const shown = new Map<string, { payeeName?: string, categoryLabel?: string }>()
    for (const accountId of new Set(found.map(f => f.t.accountId))) {
      for (const r of (await this.outside(() => this.accounts.transactions(accountId).register())).rows) shown.set(r.transaction.id, r)
    }
    const rows = found.map(({ t, amount }): TransactionRow => {
      const more = shown.get(t.id)
      return {
        transactionId: t.id, accountId: t.accountId, accountName: accounts.get(t.accountId)?.name ?? '', date: t.date, amount,
        ...(more?.payeeName !== undefined && { payee: more.payeeName }),
        ...(more?.categoryLabel !== undefined && { label: more.categoryLabel })
      }
    }).sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : a.accountName.localeCompare(b.accountName))
    const total = rows.reduce((sum, r) => sum + r.amount, 0)
    const before = [...scope.counted].map(id => accounts.get(id)?.lastArchiveDate).filter((d): d is string => d !== undefined).sort().at(-1)
    return {
      rows, total, actual: total + archivedAmount,
      ...(archivedAmount !== 0 && { archived: { amount: archivedAmount, ...(before !== undefined && { before }) } })
    }
  }
}
