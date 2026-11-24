// The balances source's rules (`reports.balances`): how much was in each account at a date, by the navigator's rule
// (its opening balance plus every non-voided transaction dated on or before it, liabilities negative, so net worth is
// a plain sum), and the rows and members a query asks for. Pure, over `balanceHistory`'s points.
// See docs/reporting-design.md, "How things stood: the balances source".
import { ACCOUNT_CLASS, ACCOUNT_TYPE_LABELS, ACCOUNT_TYPES, type AccountScope, type BalancePoint } from '@tessera/accounts-api'
import type { SubLedger } from '@tessera/ledger-api'
import {
  BALANCES_SOURCE, ReportsError,
  type DimensionField, type Member, type ReportSourceContribution, type SourceRow
} from '@tessera/reports-api'
import { counts, type Placed } from './ledgerView'

const CLASSES = [{ id: 'asset', label: 'Assets' }, { id: 'liability', label: 'Liabilities' }]

/** What `reports.balances` can report on. */
export const BALANCES_CONTRIBUTION: ReportSourceContribution = {
  id: BALANCES_SOURCE,
  label: 'Balances',
  description: 'How things stood: each account’s balance at a date, as the navigator shows it.',
  service: BALANCES_SOURCE,
  time: 'asOf',
  drillDown: false,
  fields: [
    { kind: 'dimension', key: 'date', label: 'Date', type: 'time' },
    { kind: 'dimension', key: 'byType', label: 'Assets and liabilities, by type', type: 'member', tree: true, values: CLASSES, plural: 'accounts' },
    { kind: 'dimension', key: 'byPlace', label: 'Sub-ledgers and accounts', type: 'member', tree: true, plural: 'accounts' },
    { kind: 'dimension', key: 'account', label: 'Account', type: 'member', plural: 'accounts' },
    { kind: 'dimension', key: 'accountType', label: 'Account type', type: 'enum', values: ACCOUNT_TYPES.map(t => ({ id: t, label: ACCOUNT_TYPE_LABELS[t] })) },
    { kind: 'dimension', key: 'accountClass', label: 'Asset or liability', type: 'enum', values: CLASSES },
    { kind: 'dimension', key: 'currency', label: 'Currency', type: 'member', plural: 'currencies' },
    { kind: 'dimension', key: 'state', label: 'Open or closed', type: 'enum', values: [{ id: 'open', label: 'Open, or holding something' }, { id: 'closed', label: 'Closed and empty' }] },
    { kind: 'measure', key: 'balance', label: 'Balance', unit: 'money', combine: 'last', negativeIsBad: true }
  ]
}

export interface BalancesInput {
  points: readonly BalancePoint[]
  placed: ReadonlyMap<string, Placed>
  subLedgers: readonly SubLedger[]
  scopes: AccountScope[]
  /** Sub-ledgers side by side: each row says which scope (column) it is of. */
  sideBySide?: boolean
  /** undefined: each account in its own (rows carry their currency). */
  currency: string | undefined
  dimensions: readonly string[]
  measures: readonly string[]
}

/** Closed by that date, and holding nothing: left out unless closed accounts are asked for. Removed or not, the same. */
const stateOf = (account: Placed, date: string, balance: number) =>
  account.closed && (account.closedOn === undefined || account.closedOn <= date) && balance === 0 ? 'closed' : 'open'

/** One row per counted account and date it has a balance at, keyed by the dimensions asked. */
export function balanceRowsOf(input: BalancesInput): SourceRow[] {
  const rows: SourceRow[] = []
  input.scopes.forEach((scope, s) => {
    for (const point of input.points) {
      const account = input.placed.get(point.accountId)
      if (!account || !counts(scope, account, input.currency)) continue
      const keys = input.dimensions.map(d => {
        switch (d) {
          case 'date': return point.date
          case 'byType': case 'byPlace': case 'account': return account.id
          case 'accountType': return account.type
          case 'accountClass': return ACCOUNT_CLASS[account.type]
          case 'currency': return account.currency
          case 'state': return stateOf(account, point.date, point.balance)
          default: throw new ReportsError('INVALID', `Source “${BALANCES_SOURCE}” has no dimension “${d}”.`)
        }
      })
      rows.push({
        keys, values: input.measures.map(m => m === 'balance' ? point.balance : 0),
        ...(input.currency === undefined && { currency: account.currency }), ...(input.sideBySide && { scope: s })
      })
    }
  })
  return rows
}

/** The members the rows need: trees of classes and types, or of sub-ledgers, down to the accounts. */
export function balanceMembers(rows: readonly SourceRow[], input: BalancesInput, fields: readonly DimensionField[]): Record<string, Member[]> {
  const out: Record<string, Member[]> = {}
  const subLedgers = new Map(input.subLedgers.map(s => [s.id, s]))
  const label = (a: Placed) => a.removed ? `${a.name} (archived)` : a.name
  // The navigator's order: under each sub-ledger, its sub-ledgers, then its own accounts
  const position = new Map([...input.placed.keys()].map((id, i) => [id, 1_000_000 + i]))
  input.dimensions.forEach((dimension, i) => {
    const field = fields.find(f => f.key === dimension)
    if (!field || field.type !== 'member') return
    const found = new Map<string, Member>()
    for (const row of rows) {
      const key = row.keys[i]
      if (key === null || found.has(key)) continue
      if (dimension === 'currency') { found.set(key, { id: key, label: key }); continue }
      const account = input.placed.get(key)
      if (!account) continue
      if (dimension === 'byType') {
        const type = `type:${account.type}`
        found.set(key, { id: key, label: label(account), parentId: type, order: position.get(key)! })
        if (!found.has(type)) found.set(type, { id: type, label: ACCOUNT_TYPE_LABELS[account.type], parentId: ACCOUNT_CLASS[account.type], order: ACCOUNT_TYPES.indexOf(account.type) })
      } else if (dimension === 'byPlace') {
        found.set(key, { id: key, label: label(account), parentId: account.subLedgerId, order: position.get(key)! })
        for (let s = account.subLedgerId === null ? undefined : subLedgers.get(account.subLedgerId); s && !found.has(s.id); s = s.parentId === null ? undefined : subLedgers.get(s.parentId)) {
          found.set(s.id, { id: s.id, label: s.name, parentId: s.parentId, order: s.order })
        }
      } else {
        found.set(key, { id: key, label: label(account) })
      }
    }
    out[dimension] = [...found.values()]
  })
  return out
}
