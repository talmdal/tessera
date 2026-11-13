// What an export writes, read from accounts.service: the chosen accounts in the navigator's order, their transactions
// in the range, each with its running balance, and the balances either side, exactly as the register shows them.
// Names, not ids: the payee's name, the category's path, a transfer's other account. Bank ids, never import
// fingerprints. Amounts become exact text here, once. Nothing is changed. See docs/export-design.md, "What is exported".
import {
  minorDigits, periodStart, todayIso,
  type AccountsService, type Category, type RegisterRow
} from '@tessera/accounts-api'
import {
  ExportError, minorToDecimal,
  type ExportAccount, type ExportData, type ExportRange, type ExportTransaction
} from '@tessera/export-api'
import { rangeProblem } from '../shared/ranges'

export interface GatherRequest {
  accountIds: string[]
  /** Open ends are filled in: from the earliest account's start, to the later of today and the last transaction. */
  range: { from?: string, to?: string }
}

export interface Gathered {
  data: ExportData
  /** Accounts whose earlier transactions are in an archive file, and the date each starts from. */
  archived: { account: string, from: string }[]
}

/** A category's path from the top, by id. */
function pathsOf(categories: readonly Category[]): Map<string, string[]> {
  const byId = new Map(categories.map(c => [c.id, c]))
  const paths = new Map<string, string[]>()
  for (const category of categories) {
    const names: string[] = []
    for (let at: Category | undefined = category; at && names.length <= categories.length; at = at.parentId === null ? undefined : byId.get(at.parentId)) {
      names.unshift(at.name)
    }
    paths.set(category.id, names)
  }
  return paths
}

/** The sub-ledgers holding an account, from the top. */
function locationOf(subLedgerId: string | null, subLedgers: ReadonlyMap<string, { parentId: string | null, name: string }>): string[] {
  const names: string[] = []
  for (let id = subLedgerId; id !== null && names.length <= subLedgers.size;) {
    const sub = subLedgers.get(id)
    if (!sub) break
    names.unshift(sub.name)
    id = sub.parentId
  }
  return names
}

const isFingerprint = (id: string) => id.startsWith('fp:')

export async function gather(accounts: AccountsService, request: GatherRequest, now: () => Date = () => new Date()): Promise<Gathered> {
  const ids = [...new Set(request.accountIds)]
  if (ids.length === 0) throw new ExportError('INVALID', 'Choose at least one account to export.')
  const problem = rangeProblem(request.range)
  if (problem) throw new ExportError('INVALID', problem)

  const [chart, all, categories] = await Promise.all([accounts.chart({ includeClosed: true }), accounts.list({ includeClosed: true }), accounts.categories.list()])
  const missing = ids.filter(id => !all.some(a => a.id === id))
  if (missing.length > 0) throw new ExportError('NOT_FOUND', 'An account chosen to export no longer exists. Choose the accounts again.')
  const chosen = all.filter(a => ids.includes(a.id))                       // in the navigator's order
  const names = new Map(all.map(a => [a.id, a.name]))
  const paths = pathsOf(categories)
  const subLedgers = new Map(chart.subLedgers.map(s => [s.id, s]))
  const registers = new Map<string, RegisterRow[]>()
  for (const account of chosen) registers.set(account.id, (await accounts.transactions(account.id).register()).rows)

  // The open ends: the earliest start of the chosen accounts, and the later of today and their last transaction
  const starts = chosen.map(periodStart)
  const from = request.range.from ?? starts.reduce((a, b) => (b < a ? b : a))
  const lastDates = chosen.flatMap(a => registers.get(a.id)!.slice(-1).map(r => r.transaction.date))
  const today = todayIso(now())
  const to = request.range.to ?? [today, ...lastDates].reduce((a, b) => (b > a ? b : a))

  const archived: Gathered['archived'] = []
  const exported: ExportAccount[] = chosen.map(account => {
    const rows = registers.get(account.id)!
    const digits = minorDigits(account.currency)
    const money = (minor: number) => minorToDecimal(minor, digits)
    const start = periodStart(account)
    const accountFrom = from > start ? from : start
    // Earlier transactions are in an archive file when the export reaches back past where the register now starts
    const startsAtArchive = account.lastArchiveDate !== undefined && (request.range.from === undefined || request.range.from < start)
    if (startsAtArchive) archived.push({ account: account.name, from: start })
    const before = rows.filter(r => r.transaction.date < accountFrom)
    const opening = before.length > 0 ? before[before.length - 1].balance : account.openingBalance
    const within = rows.filter(r => r.transaction.date >= accountFrom && r.transaction.date <= to)
    const upTo = rows.filter(r => r.transaction.date <= to)
    const closing = upTo.length > 0 ? upTo[upTo.length - 1].balance : account.openingBalance
    return {
      id: account.id, name: account.name, type: account.type, currency: account.currency, digits, closed: account.closed,
      ...(account.institution !== undefined && { institution: account.institution }),
      ...(account.accountNumber !== undefined && { accountNumber: account.accountNumber }),
      ...(account.bankId !== undefined && { bankId: account.bankId }),
      ...(account.intuitBankId !== undefined && { intuitBankId: account.intuitBankId }),
      location: locationOf(account.subLedgerId, subLedgers),
      opening: { date: accountFrom, balance: money(opening) },
      closing: { date: to, balance: money(closing) },
      ...(startsAtArchive && { startsAtArchive: true }),
      transactions: within.map(row => transactionOf(row, names, paths, money))
    }
  })

  const range: ExportRange = { from: exported.map(a => a.opening.date).reduce((a, b) => (b < a ? b : a)), to }
  const data: ExportData = {
    ledger: { name: chart.ledger.name },
    exportedAt: now().toISOString(),
    range,
    accounts: exported,
    categories: categories.map(c => ({ path: paths.get(c.id)!, kind: c.kind })).sort((a, b) => a.path.join('\u0000').localeCompare(b.path.join('\u0000')))
  }
  return { data, archived }
}

function transactionOf(row: RegisterRow, names: ReadonlyMap<string, string>, paths: ReadonlyMap<string, string[]>, money: (minor: number) => string): ExportTransaction {
  const t = row.transaction
  const category = t.categoryId !== undefined ? paths.get(t.categoryId) : undefined
  return {
    id: t.id, date: t.date, amount: money(t.amount),
    ...(t.number !== undefined && { number: t.number }),
    ...(row.payeeName !== undefined && { payee: row.payeeName }),
    ...(category !== undefined && t.transferAccountId === undefined && { category: [...category] }),
    ...(t.transferAccountId !== undefined && {
      transfer: { account: names.get(t.transferAccountId) ?? 'another account', direction: t.amount < 0 ? 'to' as const : 'from' as const }
    }),
    ...(t.memo !== undefined && { memo: t.memo }),
    status: t.status,
    voided: t.voided,
    ...(t.externalId !== undefined && !isFingerprint(t.externalId) && { bankId: t.externalId }),
    balance: money(row.balance)
  }
}
