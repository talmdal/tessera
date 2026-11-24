// The seven reports the reports plugin ships, contributed through `reports.definitions` like any plugin's, on its own
// two sources and with no special treatment (review, Q7). Budget vs Actual is the budget plugin's (R5).
import { REPORT_GROUPS, type ReportDefinitionContribution, type ReportGroupContribution } from '@tessera/reports-api'
import { ACCOUNT_BALANCES } from './accountBalances'
import { CASH_FLOW } from './cashFlow'
import { CATEGORY_TRENDS } from './categoryTrends'
import { INCOME_VS_EXPENSES } from './incomeVsExpenses'
import { NET_WORTH } from './netWorth'
import { SPENDING_BY_CATEGORY } from './spendingByCategory'
import { SPENDING_BY_PAYEE } from './spendingByPayee'

export const GROUPS: ReportGroupContribution[] = [
  { id: REPORT_GROUPS.spending, label: 'Income and Spending', order: 10 },
  { id: REPORT_GROUPS.balances, label: 'Net Worth and Balances', order: 20 }
]

export const DEFINITIONS: ReportDefinitionContribution[] = [
  INCOME_VS_EXPENSES, SPENDING_BY_CATEGORY, SPENDING_BY_PAYEE, CATEGORY_TRENDS, CASH_FLOW, NET_WORTH, ACCOUNT_BALANCES
]
