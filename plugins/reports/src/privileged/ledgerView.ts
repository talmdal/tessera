// What both sources and the run read about the ledger: its tree, its accounts and the accounts archives removed, and
// the rules over them: which accounts a scope covers and counts, how a scope reads, and the columns sub-ledgers side by
// side make. Pure, over what the services returned. See docs/reporting-design.md, "Scope and currency" and "Reporting
// by sub-ledger".
import {
  ACCOUNT_TYPE_LABELS, accountScope, type Account, type AccountScope, type AccountType, type RemovedAccount
} from '@tessera/accounts-api'
import { childrenOf, type SubLedger } from '@tessera/ledger-api'
import { EVERYDAY_ACCOUNT_TYPES, SUB_LEDGER_COLUMNS_MAX, ReportsError, type ScopeValue } from '@tessera/reports-api'

export interface LedgerView {
  ledgerName: string
  subLedgers: SubLedger[]
  /** The ledger's accounts, closed ones included, in the navigator's order. */
  accounts: Account[]
  /** The accounts archives removed, as they kept them. */
  removed: RemovedAccount[]
}

/** An account as reports place it: one of the ledger's, or one an archive removed. */
export interface Placed {
  id: string
  name: string
  type: AccountType
  currency: string
  /** Where it is now (or, removed, where it was). */
  subLedgerId: string | null
  openingDate: string
  /** What it opened with, before any archive carried anything into it: what its history is built from. */
  openingBalance: number
  closed: boolean
  closedOn?: string
  removed: boolean
  /** Its history before this date is incomplete: an archive before accounts-api 1.15 kept no totals of it. */
  incompleteBefore?: string
}

/** Every account, the ledger's and those archives removed, by id. */
export function placedAccounts(view: Pick<LedgerView, 'accounts' | 'removed'>): Map<string, Placed> {
  const out = new Map<string, Placed>()
  for (const a of view.accounts) {
    const incomplete = a.archived !== undefined && (a.archived.countWithTotals ?? 0) < a.archived.count && a.lastArchiveDate !== undefined
    out.set(a.id, {
      id: a.id, name: a.name, type: a.type, currency: a.currency, subLedgerId: a.subLedgerId, openingDate: a.openingDate,
      openingBalance: a.archived?.originalOpeningBalance ?? a.openingBalance, closed: a.closed, ...(a.closedOn && { closedOn: a.closedOn }),
      removed: false, ...(incomplete && { incompleteBefore: a.lastArchiveDate })
    })
  }
  for (const r of view.removed) {
    if (out.has(r.id)) continue
    out.set(r.id, {
      id: r.id, name: r.name, type: r.type, currency: r.currency, subLedgerId: r.subLedgerId, openingDate: r.openingDate,
      openingBalance: r.openingBalance, closed: true, ...(r.closedOn && { closedOn: r.closedOn }), removed: true,
      ...(!r.complete && { incompleteBefore: r.removedBefore })
    })
  }
  return out
}

/** The scope over the ledger's accounts, for figures in `currency` (undefined: every currency counts). */
export function scopeOf(value: ScopeValue, view: LedgerView, currency: string | undefined): AccountScope {
  const scope = accountScope(value, view.subLedgers, view.accounts, currency ?? '')
  if (currency !== undefined) return scope
  return { ...scope, counted: scope.inside, notCounted: [] }
}

/** Whether a scope covers an account: one of the ledger's, where it is; one an archive removed, where it was. */
export const covers = (scope: AccountScope, account: Placed): boolean =>
  account.removed ? scope.covers({ id: account.id, subLedgerId: account.subLedgerId, type: account.type }) : scope.inside.has(account.id)

/** Whether an account's figures count: covered, and in the currency (every currency when undefined). */
export const counts = (scope: AccountScope, account: Placed, currency: string | undefined): boolean =>
  covers(scope, account) && (currency === undefined || account.currency === currency)

const list = (items: string[]) => items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`

/** How a scope reads in a report's heading: "Whole ledger", "Business and its sub-ledgers", "Everyday accounts in Business". */
export function scopeLabel(value: ScopeValue, view: LedgerView, placed?: Map<string, Placed>): string {
  const name = (id: string) => view.subLedgers.find(s => s.id === id)?.name ?? 'a sub-ledger'
  switch (value.kind) {
    case 'ledger': return 'Whole ledger'
    case 'subLedger': return view.subLedgers.some(s => s.parentId === value.subLedgerId) ? `${name(value.subLedgerId)} and its sub-ledgers` : name(value.subLedgerId)
    case 'types': {
      const everyday = value.types.length === EVERYDAY_ACCOUNT_TYPES.length && EVERYDAY_ACCOUNT_TYPES.every(t => value.types.includes(t))
      const what = everyday ? 'Everyday accounts' : list(value.types.map((t, i) => i === 0 ? ACCOUNT_TYPE_LABELS[t] : ACCOUNT_TYPE_LABELS[t].toLocaleLowerCase()))
      return value.subLedgerId === undefined ? what : `${what} in ${name(value.subLedgerId)}`
    }
    case 'accounts': {
      const all = placed ?? placedAccounts(view)
      const known = value.accountIds.filter(id => all.has(id))
      return known.length === 1 ? all.get(known[0])!.name : `${known.length} accounts`
    }
  }
}

/**
 * A scope as the ledger has it now: NOT_FOUND for a sub-ledger that is gone; accounts that no longer exist (chosen,
 * then deleted) left out, and counted.
 */
export function checkedScope(value: ScopeValue, view: LedgerView, placed: Map<string, Placed>): { scope: ScopeValue, dropped: number } {
  const exists = (id: string) => view.subLedgers.some(s => s.id === id)
  if ((value.kind === 'subLedger' || value.kind === 'types') && value.subLedgerId !== undefined && !exists(value.subLedgerId)) {
    throw new ReportsError('NOT_FOUND', 'The sub-ledger this report covers no longer exists.', 'parameters.scope')
  }
  if (value.kind !== 'accounts') return { scope: value, dropped: 0 }
  const accountIds = value.accountIds.filter(id => placed.has(id))
  return { scope: { kind: 'accounts', accountIds }, dropped: value.accountIds.length - accountIds.length }
}

/**
 * *Compare with: Sub-ledgers*: a scope for each sub-ledger directly beneath the scope's (each with everything beneath
 * it); one for the accounts the scope holds directly, if any; and the scope itself, last. A scope of account types
 * keeps its types in each. At most `SUB_LEDGER_COLUMNS_MAX`, the scope itself included.
 */
export function subLedgerScopes(value: ScopeValue, view: LedgerView, placed: Map<string, Placed>): { scopes: ScopeValue[], labels: string[], left: number } {
  if (value.kind === 'accounts') throw new ReportsError('INVALID', 'Sub-ledgers can be compared over the whole ledger, a sub-ledger, or account types.', 'parameters.compare')
  const base = value.kind === 'ledger' ? null : value.subLedgerId ?? null
  const types = value.kind === 'types' ? value.types : undefined
  const scopes: ScopeValue[] = []
  const labels: string[] = []
  for (const child of childrenOf(view.subLedgers, base)) {
    scopes.push(types ? { kind: 'types', types, subLedgerId: child.id } : { kind: 'subLedger', subLedgerId: child.id })
    labels.push(child.name)
  }
  // The accounts directly in the scope's own node (the ledger's own, or the sub-ledger's), removed ones included
  const own = [...placed.values()].filter(a => a.subLedgerId === base && (types === undefined || types.includes(a.type))).map(a => a.id)
  if (own.length > 0) {
    scopes.push({ kind: 'accounts', accountIds: own })
    labels.push(`${base === null ? view.ledgerName : view.subLedgers.find(s => s.id === base)?.name ?? ''} itself`)
  }
  const room = SUB_LEDGER_COLUMNS_MAX - 1
  const left = Math.max(0, scopes.length - room)
  return { scopes: [...scopes.slice(0, room), value], labels: [...labels.slice(0, room), scopeLabel(value, view, placed)], left }
}
