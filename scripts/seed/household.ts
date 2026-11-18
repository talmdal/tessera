// The household whose money the seeded book holds: five accounts in two sub-books, and four years of plausible
// transactions generated day by day from a fixed seed.
//
// Everything is generated in date order with running balances, so the figures hang together: the Visa payment
// really clears the previous month's statement, the savings interest really follows the balance, and the tax
// account really holds what was put aside. A book whose numbers do not add up is a poor place to test an
// importer, because every mismatch looks like the importer's fault.
import {
  addDays, dayIn, dayOfMonth, datesBetween, endOfMonth, monthsBetween, onBusinessDay, random, weekday, yearOf,
  type Random
} from './random'

export const BOOK_NAME = 'Household'

/** The period the book covers, and the month after which nothing is reconciled. */
export const PERIOD = { from: '2023-01-01', to: '2026-10-31' }
export const RECONCILED_THROUGH = '2026-09-30'

export type AccountKey =
  | 'personal.chequing' | 'personal.savings' | 'personal.visa'
  | 'business.chequing' | 'business.tax'

export interface SeedAccount {
  key: AccountKey
  subBook: 'Personal' | 'Business'
  name: string
  type: 'chequing' | 'savings' | 'creditCard'
  /** Minor units, signed as a balance: a card's is negative. */
  openingBalance: number
  accountNumber: string
  institution: string
  creditLimit?: number
  minimumBalance?: number
  /** The bank's routing id, for the OFX files generated beside the book. */
  bankId: string
}

export const ACCOUNTS: readonly SeedAccount[] = [
  {
    // Enough to carry the first month: the rent, the daycare and the card are all paid before the owner's
    // first draw arrives on the 28th, and a book that opens overdrawn is not one anybody would recognise
    key: 'personal.chequing', subBook: 'Personal', name: 'Chequing', type: 'chequing',
    openingBalance: 900_000, accountNumber: '00412-1234567', institution: 'Maple Trust Bank',
    bankId: '021000021', minimumBalance: 50_000
  },
  {
    key: 'personal.savings', subBook: 'Personal', name: 'Savings', type: 'savings',
    openingBalance: 1_200_000, accountNumber: '00412-7654321', institution: 'Maple Trust Bank',
    bankId: '021000021'
  },
  {
    key: 'personal.visa', subBook: 'Personal', name: 'Visa', type: 'creditCard',
    openingBalance: -84_217, accountNumber: '4510 2200 1188 9043', institution: 'Maple Trust Bank',
    bankId: '021000021', creditLimit: 800_000
  },
  {
    key: 'business.chequing', subBook: 'Business', name: 'Business Chequing', type: 'chequing',
    openingBalance: 950_000, accountNumber: '00819-2003344', institution: 'Riverstone Credit Union',
    bankId: '026009593'
  },
  {
    key: 'business.tax', subBook: 'Business', name: 'Tax Set-Aside', type: 'savings',
    openingBalance: 0, accountNumber: '00819-2003351', institution: 'Riverstone Credit Union',
    bankId: '026009593'
  }
]

/** Categories the starter chart does not have. Created before anything is written. */
export const EXTRA_CATEGORIES: { path: string, kind: 'income' | 'expense' }[] = [
  { path: 'Business income : Consulting', kind: 'income' },
  { path: 'Business : Software', kind: 'expense' },
  { path: 'Business : Accounting', kind: 'expense' },
  { path: 'Business : Supplies', kind: 'expense' },
  { path: 'Business : Phone', kind: 'expense' }
]

/** One generated transaction. A transfer is one entry, owned by the side the money leaves. */
export interface Entry {
  date: string
  account: AccountKey
  /** Minor units, signed from `account`'s point of view. */
  amount: number
  payee?: string
  category?: string
  /** The other account of a transfer; mutually exclusive with `category`. */
  transferTo?: AccountKey
  memo?: string
  number?: string
  /**
   * False for a row the household has not entered yet: it is on the bank's statement but not in the book.
   * Only ever false in the open month, which is what gives the import something to find.
   */
  inBook: boolean
  /** False for a row the bank does not report separately (the far side of an internal transfer). */
  inStatement: boolean
  /**
   * When the bank posted it, if that differs from the date the household used. The statement carries this
   * date and the book carries `date`, which is what the matcher's window exists for.
   */
  postedDate?: string
}

const GROCERS = ['Loblaws', 'Farm Boy', 'Metro', 'Your Independent Grocer'] as const
const RESTAURANTS = ['Café Martin', 'The Works', 'Pho Mignon', 'Stella Osteria', 'Big Rig Kitchen'] as const
const FUEL = ['Petro-Canada', 'Shell', 'Esso'] as const
const PHARMACIES = ['Shoppers Drug Mart', 'Rexall'] as const
const CLIENTS = [
  'Northwind Logistics', 'Birchbank Dental', 'Kestrel Analytics', 'Harbourview Legal',
  'Quarry Lane Bakery', 'Ironwood Property Group'
] as const

/** Rent, which goes up each year. */
const RENT_BY_YEAR: Record<number, number> = { 2023: 185_000, 2024: 190_000, 2025: 197_500, 2026: 205_000 }

/**
 * The float each account keeps. The business draws everything above its float to the owner once the tax is set
 * aside, and the household sweeps everything above its own into savings at the end of the month. Sweeping
 * rather than moving a fixed sum is what keeps four years of generated money from quietly piling up in the
 * chequing account: a book where the business has accumulated two hundred thousand dollars it never spends is
 * not a book anyone would recognise.
 */
const BUSINESS_FLOAT = 1_000_000
const HOUSEHOLD_FLOAT = 800_000

/** Electricity costs more in winter: a multiplier per calendar month, January first. */
const HYDRO_SEASON = [1.45, 1.4, 1.2, 1.0, 0.85, 0.8, 0.9, 0.95, 0.85, 0.95, 1.15, 1.35]

/** The share of revenue put aside each month for income tax, CPP and HST. */
const TAX_RATE = 0.32

/** Entries the household enters as a matter of routine, so they are in the book even in the open month. */
const ROUTINE = new Set([
  'rent', 'draw', 'toSavings', 'visaPayment', 'internet', 'phone', 'hydro', 'toTax', 'interest',
  'daycare', 'carInsurance', 'homeInsurance'
])

interface Balances {
  'personal.chequing': number
  'personal.savings': number
  'personal.visa': number
  'business.chequing': number
  'business.tax': number
}

export interface Ledger {
  entries: Entry[]
  /** The closing balance of each account, for checking the generated book against itself. */
  closing: Record<AccountKey, number>
}

/**
 * Four years of a household's money. `openMonth` is the month whose discretionary spending has not been
 * entered in the book yet — the month the generated statements cover, and the only one where the book and the
 * bank disagree.
 */
export function generate(seed = 20_260_101, openMonth = '2026-10'): Ledger {
  const rng = random(seed)
  const entries: Entry[] = []
  const balances: Balances = {
    'personal.chequing': 0, 'personal.savings': 0, 'personal.visa': 0,
    'business.chequing': 0, 'business.tax': 0
  }
  for (const account of ACCOUNTS) balances[account.key] = account.openingBalance

  /** Visa spending of the month just gone, which the payment on the 20th clears. */
  let visaStatementBalance = -ACCOUNTS.find(a => a.key === 'personal.visa')!.openingBalance
  let visaThisMonth = 0
  /** Revenue of the month so far, which sets what goes to the tax account. */
  let revenueThisMonth = 0
  /** What the tax account owes the taxman at the next quarter end. */
  let taxOwing = 0

  const add = (kind: string, entry: Omit<Entry, 'inBook' | 'inStatement'> & { inStatement?: boolean }) => {
    const open = entry.date.startsWith(openMonth)
    const full: Entry = {
      ...entry,
      // In the open month, only what the household enters as a matter of routine is in the book
      inBook: !open || ROUTINE.has(kind),
      inStatement: entry.inStatement ?? true
    }
    entries.push(full)
    balances[entry.account] += entry.amount
    if (entry.transferTo !== undefined) balances[entry.transferTo] -= entry.amount
    return full
  }

  const oneOffs = oneOffsByDate()

  for (const date of datesBetween(PERIOD.from, PERIOD.to)) {
    for (const entry of oneOffs.get(date) ?? []) add(entry.kind, entry.entry)

    const day = dayOfMonth(date)
    const month = date.slice(0, 7)
    const year = yearOf(date)
    const monthIndex = Number(date.slice(5, 7)) - 1
    const lastDay = date === endOfMonth(date)

    if (day === 1) {
      visaThisMonth = 0
      revenueThisMonth = 0

      add('rent', {
        date, account: 'personal.chequing', amount: -RENT_BY_YEAR[year],
        payee: 'Maple Ridge Properties', category: 'Housing : Rent', number: 'EFT'
      })
    }

    if (day === 2) {
      add('daycare', {
        date, account: 'personal.chequing', amount: -90_000,
        payee: 'Brightpath Early Learning', category: 'Childcare', number: 'PAP'
      })
    }

    if (day === 4) {
      add('carInsurance', {
        date, account: 'personal.chequing', amount: -18_500,
        payee: 'Co-operators Insurance', category: 'Transportation : Car insurance', number: 'PAP'
      })
      add('homeInsurance', {
        date, account: 'personal.chequing', amount: -9_500,
        payee: 'Co-operators Insurance', category: 'Housing : Home insurance', number: 'PAP'
      })
    }

    if (day === 5) {
      add('internet', {
        date, account: 'personal.chequing', amount: -8_999,
        payee: 'Rogers', category: 'Utilities : Internet', number: 'PAP'
      })
    }

    if (day === 8) {
      add('phone', {
        date, account: 'personal.chequing', amount: -7_550,
        payee: 'Telus', category: 'Utilities : Phone', number: 'PAP'
      })
    }

    if (day === 15) {
      const base = rng.money(95, 135)
      add('hydro', {
        date, account: 'personal.chequing', amount: -Math.round(base * HYDRO_SEASON[monthIndex]),
        payee: 'Hydro Ottawa', category: 'Utilities : Electricity', number: 'PAP'
      })
    }

    // Groceries every Saturday, on the card about half the time
    if (weekday(date) === 6) {
      const amount = rng.money(118, 236)
      const onCard = rng.chance(0.45)
      add('groceries', {
        date,
        account: onCard ? 'personal.visa' : 'personal.chequing',
        amount: -amount,
        payee: rng.pick(GROCERS),
        category: 'Food : Groceries',
        number: onCard ? undefined : 'POS'
      })
      if (onCard) visaThisMonth += amount
    }

    // The card's own habits
    if (day === 3) {
      add('subscription', {
        date, account: 'personal.visa', amount: -1_899,
        payee: 'Netflix', category: 'Entertainment'
      })
      visaThisMonth += 1_899
    }
    for (const fuelDay of [12, 26]) {
      if (day === fuelDay) {
        const amount = rng.money(62, 104)
        add('fuel', {
          date, account: 'personal.visa', amount: -amount,
          payee: rng.pick(FUEL), category: 'Transportation : Fuel'
        })
        visaThisMonth += amount
      }
    }
    // Named rather than picked: the open month's statement must always carry a non-ASCII payee, or the
    // Windows-1252 fixture stops testing the encoding it exists to test
    if (day === 7) {
      const amount = rng.money(16, 38)
      add('bakery', {
        date, account: 'personal.visa', amount: -amount,
        payee: 'Boulangerie Côté', category: 'Food : Groceries'
      })
      visaThisMonth += amount
    }

    if (day === 18) {
      const amount = rng.money(38, 126)
      add('dining', {
        date, account: 'personal.visa', amount: -amount,
        payee: rng.pick(RESTAURANTS), category: 'Food : Dining out'
      })
      visaThisMonth += amount
    }
    if (day === 22 && rng.chance(0.7)) {
      const amount = rng.money(14, 78)
      add('pharmacy', {
        date, account: 'personal.visa', amount: -amount,
        payee: rng.pick(PHARMACIES), category: 'Health : Pharmacy'
      })
      visaThisMonth += amount
    }

    // The card is paid off on the 20th, clearing what the last statement showed
    if (day === 20 && visaStatementBalance > 0) {
      add('visaPayment', {
        date, account: 'personal.chequing', amount: -visaStatementBalance,
        transferTo: 'personal.visa', memo: 'Visa payment', number: 'TFR'
      })
      visaStatementBalance = 0
    }

    // Business: clients pay through the month
    if ([6, 14, 23].includes(day)) {
      const invoiced = day === 23 && rng.chance(0.35) ? 0 : rng.money(2_900, 5_400)
      if (invoiced > 0) {
        add('invoice', {
          date: onBusinessDay(date), account: 'business.chequing', amount: invoiced,
          payee: rng.pick(CLIENTS), category: 'Business income : Consulting', number: 'DEP'
        })
        revenueThisMonth += invoiced
      }
    }

    if (day === 10) {
      add('software', {
        date, account: 'business.chequing', amount: -8_900,
        payee: 'Atlassian', category: 'Business : Software', number: 'PAP'
      })
      add('businessPhone', {
        date, account: 'business.chequing', amount: -6_200,
        payee: 'Telus Business', category: 'Business : Phone', number: 'PAP'
      })
    }

    if (day === 17 && rng.chance(0.4)) {
      add('supplies', {
        date, account: 'business.chequing', amount: -rng.money(45, 310),
        payee: 'Staples', category: 'Business : Supplies', number: 'POS'
      })
    }

    // The owner takes a draw, and sets tax aside, at the end of the month
    if (day === 28) {
      const aside = Math.round(revenueThisMonth * TAX_RATE)
      if (aside > 0) {
        add('toTax', {
          date, account: 'business.chequing', amount: -aside,
          transferTo: 'business.tax', memo: 'Tax set-aside', number: 'TFR'
        })
        taxOwing += aside
      }
      const drawable = balances['business.chequing'] - BUSINESS_FLOAT
      if (drawable > 0) {
        add('draw', {
          date, account: 'business.chequing', amount: -drawable,
          transferTo: 'personal.chequing', memo: 'Owner’s draw', number: 'TFR'
        })
      }
    }

    // Quarterly: the accountant, then the taxman — the money comes back out of the set-aside to pay him
    if (day === 15 && [0, 3, 6, 9].includes(monthIndex)) {
      add('accounting', {
        date, account: 'business.chequing', amount: -45_000,
        payee: 'Pelletier & Co. CPA', category: 'Business : Accounting', number: 'EFT'
      })
      if (taxOwing > 0) {
        // Keep a little back: a remittance is never exactly what was set aside
        const remit = Math.round(taxOwing * 0.92)
        add('fromTax', {
          date, account: 'business.tax', amount: -remit,
          transferTo: 'business.chequing', memo: 'For the quarterly remittance', number: 'TFR'
        })
        add('taxPayment', {
          date, account: 'business.chequing', amount: -remit,
          payee: 'Canada Revenue Agency', category: 'Taxes', number: 'EFT',
          memo: `Quarterly remittance`
        })
        taxOwing -= remit
      }
    }

    if (lastDay) {
      const surplus = balances['personal.chequing'] - HOUSEHOLD_FLOAT
      if (surplus > 0) {
        add('toSavings', {
          date, account: 'personal.chequing', amount: -surplus,
          transferTo: 'personal.savings', memo: 'Month-end saving', number: 'TFR'
        })
      }
    }

    // Interest, at the end of the month, on what is actually in the account
    if (lastDay) {
      const savings = Math.max(0, balances['personal.savings'])
      const earned = Math.round(savings * 0.028 / 12)
      if (earned > 0) {
        add('interest', {
          date, account: 'personal.savings', amount: earned,
          payee: 'Maple Trust Bank', category: 'Interest'
        })
      }
      const setAside = Math.max(0, balances['business.tax'])
      const taxInterest = Math.round(setAside * 0.031 / 12)
      if (taxInterest > 0) {
        add('interest', {
          date, account: 'business.tax', amount: taxInterest,
          payee: 'Riverstone Credit Union', category: 'Interest'
        })
      }
      // What the card's next statement will ask for
      visaStatementBalance = visaThisMonth
    }
  }

  entries.sort((a, b) => a.date.localeCompare(b.date))
  stagger(entries, openMonth, rng)

  return {
    entries,
    closing: { ...balances }
  }
}

/** The things that happen once: a holiday, a car repair, a laptop, a cheque left in a drawer. */
function oneOffsByDate(): Map<string, { kind: string, entry: Omit<Entry, 'inBook' | 'inStatement'> }[]> {
  const once: { kind: string, entry: Omit<Entry, 'inBook' | 'inStatement'> }[] = [
    {
      kind: 'holiday',
      entry: {
        date: '2024-07-08', account: 'personal.savings', amount: -320_000,
        transferTo: 'personal.chequing', memo: 'Nova Scotia holiday', number: 'TFR'
      }
    },
    {
      kind: 'holiday',
      entry: {
        date: '2024-07-12', account: 'personal.visa', amount: -186_400,
        payee: 'Air Canada', category: 'Travel', memo: 'Flights'
      }
    },
    {
      kind: 'carRepair',
      entry: {
        date: '2025-03-04', account: 'personal.savings', amount: -180_000,
        transferTo: 'personal.chequing', memo: 'Car repair', number: 'TFR'
      }
    },
    {
      kind: 'carRepair',
      entry: {
        date: '2025-03-06', account: 'personal.chequing', amount: -176_500,
        payee: 'Bytown Auto Service', category: 'Transportation : Car maintenance', number: '0142'
      }
    },
    {
      kind: 'laptop',
      entry: {
        date: '2025-09-19', account: 'business.chequing', amount: -248_900,
        payee: 'Apple Canada', category: 'Business : Supplies', memo: 'Replacement laptop', number: 'POS'
      }
    },
    {
      kind: 'dentist',
      entry: {
        date: '2026-05-21', account: 'personal.chequing', amount: -94_000,
        payee: 'Ottawa Dental Centre', category: 'Health : Dental', number: '0143'
      }
    },
    {
      // A cheque that sat in a drawer for a fortnight before it was cashed: the register and the bank disagree
      kind: 'landscaping',
      entry: {
        date: '2026-06-02', account: 'personal.chequing', amount: -37_500,
        payee: 'Ridgeview Landscaping', category: 'Housing : Maintenance', number: '0144',
        postedDate: '2026-06-16'
      }
    }
  ]

  const byDate = new Map<string, { kind: string, entry: Omit<Entry, 'inBook' | 'inStatement'> }[]>()
  for (const item of once) {
    const list = byDate.get(item.entry.date) ?? []
    list.push(item)
    byDate.set(item.entry.date, list)
  }
  return byDate
}

/**
 * In the open month, moves every second entry the household has recorded a day or two later than the bank
 * posted it. This is the ordinary case the matcher's date window exists for — a bill paid on Friday clears on
 * Monday — and a seeded book without it would make the importer look better than it is.
 *
 * Every second, rather than at random: the point of the fixture is that it reliably contains staggered rows,
 * and a seed that happened to stagger none of them would quietly stop testing the thing it exists to test.
 * The drift never crosses the month end, or the row would vanish from the statement it belongs to.
 */
function stagger(entries: Entry[], openMonth: string, rng: Random) {
  const eligible = entries.filter(entry =>
    entry.date.startsWith(openMonth) && entry.inBook && entry.inStatement && entry.transferTo === undefined)

  for (const [at, entry] of eligible.entries()) {
    if (at % 2 !== 0) continue
    const lastDay = endOfMonth(entry.date)
    const drift = rng.int(1, 3)
    const posted = addDays(entry.date, drift)
    if (posted <= lastDay) entry.postedDate = posted
  }
}

/** Running balances per account at the end of each month, for the reconciliation statements. */
export function monthlyBalances(ledger: Ledger): Map<string, Record<AccountKey, number>> {
  const byMonth = new Map<string, Record<AccountKey, number>>()
  const running: Record<AccountKey, number> = {
    'personal.chequing': 0, 'personal.savings': 0, 'personal.visa': 0,
    'business.chequing': 0, 'business.tax': 0
  }
  for (const account of ACCOUNTS) running[account.key] = account.openingBalance

  for (const month of monthsBetween(PERIOD.from.slice(0, 7), PERIOD.to.slice(0, 7))) {
    for (const entry of ledger.entries) {
      if (entry.date.slice(0, 7) !== month) continue
      running[entry.account] += entry.amount
      if (entry.transferTo !== undefined) running[entry.transferTo] -= entry.amount
    }
    byMonth.set(month, { ...running })
  }
  return byMonth
}

/** The entries one account's bank statement would show for a month, in the bank's own date order. */
export function statementRows(ledger: Ledger, account: AccountKey, month: string): Entry[] {
  const rows: Entry[] = []
  for (const entry of ledger.entries) {
    if (!entry.inStatement) continue
    if (entry.account === account) {
      const when = entry.postedDate ?? entry.date
      if (when.slice(0, 7) === month) rows.push(entry)
    } else if (entry.transferTo === account) {
      // The other side of a transfer: the bank reports it in this account too, with the sign reversed
      const when = entry.postedDate ?? entry.date
      if (when.slice(0, 7) === month) rows.push({ ...entry, account, amount: -entry.amount, transferTo: entry.account })
    }
  }
  return rows.sort((a, b) => (a.postedDate ?? a.date).localeCompare(b.postedDate ?? b.date))
}

export { dayIn }
