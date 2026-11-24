// The ledgers behind docs/reporting-design.md's worked examples, built through the accounts service so every figure
// the note shows is produced by a test (Phase R2, "Done when"). Three ledgers, since the note's examples are of three:
// - the household (Income vs Expenses, Spending by Category and by Payee, Category Trends, Cash Flow), 2026;
// - a sole proprietor's ledger, Personal and Business, March 2026 (Reporting by sub-ledger);
// - a ledger with a mortgage, January to June 2026 (Net Worth).
// Amounts are spread over transactions and payees in code, to the cent, so the totals are exactly the note's.
import type { TransactionDraft } from '@tessera/accounts-api'
import { account, category, type ReportsEnv } from './harness'

const pad = (n: number) => String(n).padStart(2, '0')
const date = (month: number, day: number) => `2026-${pad(month)}-${pad(day)}`

/** `total` split into `count` parts that differ by at most a cent, the larger first. */
export function split(total: number, count: number): number[] {
  const base = Math.floor(total / count)
  return Array.from({ length: count }, (_, i) => base + (i < total - base * count ? 1 : 0))
}

/** `total` shared out in proportion to `weights`, to the cent: the remainder goes to the last. */
export function share(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0)
  const parts = weights.map(w => Math.floor(w * total / sum))
  parts[parts.length - 1] += total - parts.reduce((a, b) => a + b, 0)
  return parts
}

// ---- The household, 2026

/** Groceries and dining out, month by month: Category Trends' rows for January to June, and the rest of the year. */
export const GROCERIES = [59830, 61145, 65010, 60275, 63320, 64190, 70000, 72000, 71000, 73000, 72000, 72000]
export const DINING = [21405, 13365, 21205, 18000, 9640, 24510, 12000, 13000, 12500, 13125, 12500, 12500]
export const TRANSPORT = [14000, 14000, 17500, 42000, 43000, 44000, 42500, 43000, 43500, 42000, 43000, 42550]
const UTILITIES = [0, 0, 0, 36000, 35000, 35480, 36000, 35000, 36000, 37000, 35000, 35000]

/**
 * The household of the examples: Chequing, Savings and a Visa (the everyday accounts) and Retirement (RRSP); a salary
 * and interest; rent from Riverside Properties, groceries at FreshCo, fuel at Esso, hydro from City Hydro, coffee at
 * Corner Café, and 143 other payees; a transfer to the RRSP in March.
 */
export async function household(env: ReportsEnv) {
  const { accounts } = env
  const chq = await accounts.createAccount(account('Chequing', null, { openingBalance: 500000 }))
  const sav = await accounts.createAccount(account('Savings', null, { type: 'savings', openingBalance: 505850 }))
  const visa = await accounts.createAccount(account('Visa', null, { type: 'creditCard', openingBalance: -100000 }))
  const rrsp = await accounts.createAccount(account('Retirement (RRSP)', null, { type: 'retirement', openingBalance: 2000000 }))
  const cat = {
    salary: await category(env, 'Salary', 'income'),
    interest: await category(env, 'Interest', 'income'),
    rent: await category(env, 'Housing : Rent'),
    maintenance: await category(env, 'Housing : Maintenance'),
    groceries: await category(env, 'Food : Groceries'),
    dining: await category(env, 'Food : Dining out'),
    fuel: await category(env, 'Transportation : Fuel'),
    transit: await category(env, 'Transportation : Public transit'),
    electricity: await category(env, 'Utilities : Electricity'),
    internet: await category(env, 'Utilities : Internet'),
    entertainment: await category(env, 'Entertainment'),
    health: await category(env, 'Health : Pharmacy'),
    gifts: await category(env, 'Gifts'),
    clothing: await category(env, 'Clothing'),
    education: await category(env, 'Education')
  }

  const onChequing: TransactionDraft[] = []
  const onSavings: TransactionDraft[] = []
  const onVisa: TransactionDraft[] = []
  /** Spending: `amount` minor units in `count` transactions, on the Visa (rent: the chequing account). */
  const spend = (month: number, categoryId: string | undefined, amount: number, count: number, payee: string | null, into = onVisa) => {
    split(amount, count).forEach((part, i) => into.push({
      date: date(month, 1 + (i * 5 + month) % 27), amount: -part, ...(categoryId && { categoryId }), ...(payee !== null && { payee })
    }))
  }

  // Income: the salary into chequing, interest into savings
  for (let m = 1; m <= 12; m++) onChequing.push({ date: date(m, 25), amount: 420000, payee: 'Northwind Ltd', categoryId: cat.salary })
  ;[1240, 1185, 1210, 1200, 1200, 1200, 1200, 1200, 1200, 1200, 1200, 1200].forEach((a, i) => onSavings.push({ date: date(i + 1, 28), amount: a, categoryId: cat.interest }))
  // The RRSP contribution: a transfer out of the everyday accounts, inside the ledger
  onChequing.push({ date: date(3, 15), amount: -150000, transferAccountId: rrsp.id })

  // The five payees the examples name
  for (let m = 1; m <= 12; m++) spend(m, cat.rent, 150000, 1, 'Riverside Properties', onChequing)
  const fresh = share(481233, GROCERIES)
  const freshCounts = [5, 4, 4, 5, 4, 4, 5, 4, 4, 5, 4, 4]
  const cafe = share(68450, DINING)
  const cafeCounts = [5, 5, 5, 4, 5, 5, 5, 5, 4, 5, 5, 4]
  const esso = [14000, 14000, 17500, ...share(86775, TRANSPORT.slice(3))]
  const essoCounts = [2, 2, 2, 3, 3, 3, 3, 3, 3, 3, 2, 2]
  const hydro = [0, 0, 0, ...share(149020, UTILITIES.slice(3))]
  const hydroCounts = [0, 0, 0, 2, 1, 1, 2, 1, 1, 2, 1, 1]
  for (let m = 1; m <= 12; m++) {
    spend(m, cat.groceries, fresh[m - 1], freshCounts[m - 1], 'FreshCo')
    spend(m, cat.dining, cafe[m - 1], cafeCounts[m - 1], 'Corner Café')
    spend(m, cat.fuel, esso[m - 1], essoCounts[m - 1], 'Esso')
    if (hydroCounts[m - 1] > 0) spend(m, cat.electricity, hydro[m - 1], hydroCounts[m - 1], 'City Hydro')
  }
  // No payee: nine uncategorised purchases, April to December
  for (let m = 4; m <= 12; m++) spend(m, undefined, [2840, 2600, 2600, 2600, 2600, 2600, 2600, 2600, 2600][m - 4], 1, null)

  // Everything else, from 143 other payees: what each month's category has left, in 412 transactions
  const other: { month: number, categoryId: string | undefined, amount: number }[] = []
  const spread = (total: number, months: number[], categoryId: string | undefined) =>
    split(total, months.length).forEach((amount, i) => other.push({ month: months[i], categoryId, amount }))
  const aprToDec = [4, 5, 6, 7, 8, 9, 10, 11, 12]
  for (let m = 1; m <= 12; m++) {
    other.push({ month: m, categoryId: cat.groceries, amount: GROCERIES[m - 1] - fresh[m - 1] })
    other.push({ month: m, categoryId: cat.dining, amount: DINING[m - 1] - cafe[m - 1] })
    if (m >= 4) {
      other.push({ month: m, categoryId: cat.transit, amount: TRANSPORT[m - 1] - esso[m - 1] })
      other.push({ month: m, categoryId: cat.internet, amount: UTILITIES[m - 1] - hydro[m - 1] })
    }
  }
  other.push({ month: 6, categoryId: cat.maintenance, amount: 42000 })
  spread(198640, aprToDec, cat.entertainment)
  spread(110460, aprToDec, cat.health)
  spread(70215, aprToDec, cat.gifts)
  spread(49825, aprToDec, cat.clothing)
  other.push({ month: 9, categoryId: cat.education, amount: 23400 })
  other.push({ month: 3, categoryId: undefined, amount: 4100 })               // the 41.00 uncategorised in March
  spread(13460, aprToDec, undefined)
  const otherTotal = other.reduce((a, b) => a + b.amount, 0)
  if (otherTotal !== 1420172) throw new Error(`the other payees come to ${otherTotal}, not 1420172`)
  // 412 transactions in proportion to each part's amount (at least one each), then the payees in turn
  const counts = other.map(o => Math.max(1, Math.floor(o.amount * 412 / otherTotal)))
  const perTransaction = (i: number) => other[i].amount / counts[i]
  const indexes = [...counts.keys()]
  while (counts.reduce((a, b) => a + b, 0) < 412) counts[indexes.reduce((a, b) => perTransaction(b) > perTransaction(a) ? b : a)]++
  while (counts.reduce((a, b) => a + b, 0) > 412) counts[indexes.filter(i => counts[i] > 1).reduce((a, b) => perTransaction(b) < perTransaction(a) ? b : a)]--
  let payee = 0
  other.forEach((o, i) => split(o.amount, counts[i]).forEach((part, k) => onVisa.push({
    date: date(o.month, 1 + (k * 3 + i) % 28), amount: -part, ...(o.categoryId && { categoryId: o.categoryId }),
    payee: `Shop ${String(payee++ % 143 + 1).padStart(3, '0')}`
  })))

  await accounts.transactions(chq.id).createMany(onChequing)
  await accounts.transactions(sav.id).createMany(onSavings)
  await accounts.transactions(visa.id).createMany(onVisa)
  return { chq, sav, visa, rrsp, cat }
}

// ---- A sole proprietor's ledger, March 2026

/** Personal (chequing, savings) and Business (chequing); the business pays its owner 3,000.00 in March. */
export async function proprietor(env: ReportsEnv) {
  const { accounts, session } = env
  const personal = await session.createSubLedger({ name: 'Personal', parentId: null })
  const business = await session.createSubLedger({ name: 'Business', parentId: null })
  const pchq = await accounts.createAccount(account('Personal Chequing', personal.id, { openingBalance: 200000 }))
  const psav = await accounts.createAccount(account('Personal Savings', personal.id, { type: 'savings', openingBalance: 1000000 }))
  const bchq = await accounts.createAccount(account('Business Chequing', business.id, { openingBalance: 1500000 }))
  const c = {
    consulting: await category(env, 'Consulting fees', 'income'),
    interest: await category(env, 'Interest', 'income'),
    rent: await category(env, 'Housing : Rent'),
    groceries: await category(env, 'Food : Groceries'),
    dining: await category(env, 'Food : Dining out'),
    fuel: await category(env, 'Transportation : Fuel'),
    office: await category(env, 'Office and software'),
    bank: await category(env, 'Bank charges')
  }
  await accounts.transactions(psav.id).create({ date: '2026-03-31', amount: 1210, categoryId: c.interest })
  await accounts.transactions(pchq.id).createMany([
    { date: '2026-03-01', amount: -150000, payee: 'Riverside Properties', categoryId: c.rent },
    { date: '2026-03-07', amount: -65010, payee: 'FreshCo', categoryId: c.groceries },
    { date: '2026-03-14', amount: -21205, payee: 'Corner Café', categoryId: c.dining },
    { date: '2026-03-20', amount: -17500, payee: 'Esso', categoryId: c.fuel },
    { date: '2026-03-22', amount: -4100, payee: 'Farmers’ Market' }
  ])
  await accounts.transactions(bchq.id).createMany([
    { date: '2026-03-05', amount: 840000, payee: 'Contoso Inc.', categoryId: c.consulting },
    { date: '2026-03-10', amount: -35740, payee: 'Cloud Tools', categoryId: c.office },
    { date: '2026-03-31', amount: -1850, payee: 'The Bank', categoryId: c.bank },
    // The owner's pay: a transfer from the business to the household
    { date: '2026-03-28', amount: -300000, transferAccountId: pchq.id }
  ])
  return { personal, business, pchq, psav, bchq, c }
}

// ---- Net worth, January to June 2026

export const ASSETS = [4821055, 4987620, 5110285, 5364010, 5498045, 5631170]
export const LIABILITIES = [-21243018, -21190562, -21138807, -21084255, -21030190, -20977033]

/** A chequing account and a mortgage, whose month ends are the Net Worth example's. */
export async function mortgaged(env: ReportsEnv) {
  const { accounts } = env
  const chq = await accounts.createAccount(account('Chequing', null, { openingBalance: ASSETS[0] }))
  const mortgage = await accounts.createAccount(account('Mortgage', null, { type: 'mortgage', openingBalance: LIABILITIES[0] }))
  for (let m = 2; m <= 6; m++) {
    await accounts.transactions(chq.id).create({ date: date(m, 15), amount: ASSETS[m - 1] - ASSETS[m - 2] })
    await accounts.transactions(mortgage.id).create({ date: date(m, 15), amount: LIABILITIES[m - 1] - LIABILITIES[m - 2] })
  }
  return { chq, mortgage }
}
