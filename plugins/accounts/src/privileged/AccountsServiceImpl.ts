// `accounts.service`: the accounts of the open ledger. Every rule is enforced here, so whatever writes accounts (the
// dialogs, an importer, a future plugin) gets the same checks.
import type { Collection, Database, Disposable, Event, Logger, Transaction } from '@tessera/types'
import { descendantIds, type ArchiveParticipant, type LedgerSession, type LedgerTree, type SubLedgerParticipant } from '@tessera/ledger-api'
import {
  ACCOUNT_CLASS, ACCOUNT_NOTES_MAX_LENGTH, ACCOUNT_NUMBER_MAX_LENGTH, ACCOUNT_TEXT_MAX_LENGTH, AccountsError,
  CREDIT_LIMIT_TYPES, MINIMUM_BALANCE_TYPES, accountNameKey, accountNumberKey, formatAmount, isAccountType, isAmount,
  isCurrencyCode, isIsoDate, todayIso, validateAccountName,
  type Account, type AccountBalances, type AccountFilter, type AccountInput, type AccountPatch, type AccountsChange,
  type AccountsService, type AccountSummary, type CategoryDirectory, type Chart, type ClearingStatus, type CurrencyTotals,
  type BankMatch, type BankUnmatch,
  type PayeeDirectory, type ReconciliationService, type TransactionDraft, type TransactionManager, type TransactionPatch,
  type WriteOptions
} from '@tessera/accounts-api'
import {
  Emitter, change, collectionsOf, invalid, optionalText, toAccount, translate,
  type Collections, type StoredAccount
} from './store'
import { applyArchive, describePlan, planArchive, readLedger, removesClosedAccounts } from './archiveCore'
import * as reconcile from './reconcileCore'
import * as core from './transactionsCore'

export { translate }

/** The fields a patch clears with `null`. Elsewhere `null` is a value: `subLedgerId: null` is the ledger itself. */
const CLEARABLE: ReadonlySet<string> = new Set(['institution', 'accountNumber', 'notes', 'creditLimit', 'minimumBalance', 'showAvailableBalance'])

/** What only archiving sets: a form, or another plugin, can't. */
const SET_BY_ARCHIVING = ['lastArchiveDate', 'archived'] as const

/** Checks and normalises every field of an account. Throws INVALID naming the field at fault. */
export function checkAccountInput(input: AccountInput): Omit<StoredAccount, 'order' | 'closed' | 'closedOn' | 'lastReconciled'> {
  if (typeof input !== 'object' || input === null) throw invalid('name', 'Enter the account’s details.')
  for (const field of SET_BY_ARCHIVING) {
    if ((input as unknown as Record<string, unknown>)[field] !== undefined) throw invalid(field, 'This is set by archiving the ledger, not by editing the account.')
  }
  const nameProblem = validateAccountName(input.name)
  if (nameProblem) throw invalid('name', nameProblem)
  if (!isAccountType(input.type)) throw invalid('type', 'Choose an account type.')
  const currency = typeof input.currency === 'string' ? input.currency.trim().toUpperCase() : ''
  if (!isCurrencyCode(currency)) throw invalid('currency', 'Choose a currency, like CAD.')
  if (!isIsoDate(input.openingDate)) throw invalid('openingDate', 'Enter the date the account opened.')
  if (!isAmount(input.openingBalance)) throw invalid('openingBalance', 'Enter the opening balance.')
  if (input.subLedgerId !== null && typeof input.subLedgerId !== 'string') throw invalid('subLedgerId', 'Choose where the account goes.')

  let creditLimit: number | undefined
  if (input.creditLimit !== undefined && input.creditLimit !== null) {
    if (!CREDIT_LIMIT_TYPES.includes(input.type)) throw invalid('creditLimit', 'Only credit cards and lines of credit have a credit limit.')
    if (!isAmount(input.creditLimit) || input.creditLimit < 0) throw invalid('creditLimit', 'Enter a credit limit of zero or more.')
    creditLimit = input.creditLimit
  }

  let minimumBalance: number | undefined
  if (input.minimumBalance !== undefined && input.minimumBalance !== null) {
    if (!MINIMUM_BALANCE_TYPES.includes(input.type)) throw invalid('minimumBalance', 'Only asset accounts, such as chequing and savings, have a minimum balance.')
    if (!isAmount(input.minimumBalance) || input.minimumBalance < 0) throw invalid('minimumBalance', 'Enter a minimum balance of zero or more.')
    minimumBalance = input.minimumBalance
  }
  if (input.showAvailableBalance !== undefined && input.showAvailableBalance !== null && typeof input.showAvailableBalance !== 'boolean') {
    throw invalid('showAvailableBalance', 'Choose whether to show the balance above the minimum.')
  }
  if (input.showAvailableBalance === true && minimumBalance === undefined) {
    throw invalid('minimumBalance', 'Enter the minimum balance, to show the balance above it.')
  }

  const name = input.name.trim()
  const institution = optionalText(input.institution, 'institution', ACCOUNT_TEXT_MAX_LENGTH)
  const accountNumber = optionalText(input.accountNumber, 'accountNumber', ACCOUNT_NUMBER_MAX_LENGTH)
  const notes = optionalText(input.notes, 'notes', ACCOUNT_NOTES_MAX_LENGTH, true)
  return {
    name, nameKey: accountNameKey(name), type: input.type, subLedgerId: input.subLedgerId, currency,
    openingDate: input.openingDate, openingBalance: input.openingBalance,
    ...(creditLimit !== undefined && { creditLimit }),
    ...(minimumBalance !== undefined && { minimumBalance }),
    ...(input.showAvailableBalance === true && { showAvailableBalance: true }),
    ...(institution !== undefined && { institution }),
    ...(accountNumber !== undefined && { accountNumber, numberKey: accountNumberKey(accountNumber) }),
    ...(notes !== undefined && { notes })
  }
}

/** The input an account was made from, with a patch applied; `null` clears an optional field. */
function applyPatch(account: Account, patch: AccountPatch): AccountInput {
  if (typeof patch !== 'object' || patch === null) throw invalid('name', 'Nothing to change.')
  const merged: Record<string, unknown> = {
    name: account.name, type: account.type, subLedgerId: account.subLedgerId, currency: account.currency,
    openingDate: account.openingDate, openingBalance: account.openingBalance,
    creditLimit: account.creditLimit, minimumBalance: account.minimumBalance, showAvailableBalance: account.showAvailableBalance,
    institution: account.institution, accountNumber: account.accountNumber, notes: account.notes
  }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    merged[key] = value === null && CLEARABLE.has(key) ? undefined : value
  }
  // A type without a credit limit drops the one the account had, rather than refusing the change
  if (patch.type !== undefined && !CREDIT_LIMIT_TYPES.includes(patch.type) && patch.creditLimit === undefined) delete merged.creditLimit
  if (patch.type !== undefined && !MINIMUM_BALANCE_TYPES.includes(patch.type) && patch.minimumBalance === undefined) {
    delete merged.minimumBalance
    delete merged.showAvailableBalance
  }
  if (merged.minimumBalance === undefined && patch.showAvailableBalance === undefined) delete merged.showAvailableBalance
  return merged as unknown as AccountInput
}

const add = (totals: CurrencyTotals, currency: string, amount: number) => { totals[currency] = (totals[currency] ?? 0) + amount }

/** Accounts in navigator order: under each node, its sub-ledgers (each with its contents) first, then its accounts. */
export function navigatorOrder(tree: LedgerTree, accounts: readonly Account[]): Account[] {
  const ordered: Account[] = []
  const visit = (parentId: string | null) => {
    for (const sub of tree.subLedgers.filter(s => s.parentId === parentId).sort((a, b) => a.order - b.order)) visit(sub.id)
    ordered.push(...accounts.filter(a => a.subLedgerId === parentId).sort((a, b) => a.order - b.order || a.name.localeCompare(b.name)))
  }
  visit(null)
  // Accounts whose sub-ledger is gone (shouldn't happen) are kept, last
  const placed = new Set(ordered.map(a => a.id))
  return [...ordered, ...accounts.filter(a => !placed.has(a.id))]
}

export interface AccountsServiceDeps {
  session: LedgerSession
  log: Pick<Logger, 'warn' | 'error'>
  /** Today, as YYYY-MM-DD: the default closing date. */
  today?: () => string
  /** Now, as an ISO timestamp: when transactions are created and changed. */
  now?: () => string
  /** Lets the event loop turn during a long archive (tests count the turns). Default: `setImmediate`. */
  turn?: () => Promise<void>
}

export class AccountsServiceImpl implements AccountsService {
  private readonly changes: Emitter<AccountsChange>
  private readonly subscriptions: Disposable[] = []
  /** Accounts a sub-ledger delete moved, announced with the tree change that follows its commit. */
  private moved: string[] = []
  /** What an archive changed, announced once the ledger has committed it. */
  private archivedChange: AccountsChange | undefined

  readonly onDidChange: Event<AccountsChange>

  constructor(private readonly deps: AccountsServiceDeps) {
    this.changes = new Emitter(deps.log)
    this.onDidChange = this.changes.event
    this.subscriptions.push(
      // Another ledger means other accounts
      deps.session.onDidChange(() => this.changes.fire(change({}))),
      deps.session.onDidChangeTree(() => {
        const updated = this.moved
        this.moved = []
        this.changes.fire(change({ updated }))
      })
    )
  }

  dispose() {
    for (const subscription of this.subscriptions.splice(0)) subscription.dispose()
  }

  private get today() { return this.deps.today ?? (() => todayIso()) }
  private get now() { return this.deps.now ?? (() => new Date().toISOString()) }

  private db(): Database {
    try {
      return this.deps.session.database('accounts')
    } catch (err) { throw translate(err) }
  }

  /** The collections, read directly or, inside a write, through its transaction. */
  private c(tx?: Transaction): Collections {
    return collectionsOf(tx ?? this.db())
  }

  private async read<T>(work: (c: Collections) => Promise<T>): Promise<T> {
    try { return await work(this.c()) } catch (err) { throw translate(err) }
  }

  /** Runs a write in one storage transaction, then announces what it touched. */
  private async write<T>(work: (c: Collections) => Promise<T>, announce: (result: T) => Partial<AccountsChange>): Promise<T> {
    let result: T
    try {
      result = await this.db().transaction(tx => work(this.c(tx)))
    } catch (err) { throw translate(err) }
    this.changes.fire(change(announce(result)))
    return result
  }

  private async tree(): Promise<LedgerTree> {
    try { return await this.deps.session.tree() } catch (err) { throw translate(err) }
  }

  private async checkSubLedger(subLedgerId: string | null) {
    if (subLedgerId === null) return
    if (!(await this.tree()).subLedgers.some(s => s.id === subLedgerId)) {
      throw new AccountsError('NOT_FOUND', 'That sub-ledger no longer exists.', 'subLedgerId')
    }
  }

  private async checkNameFree(accounts: Collection<StoredAccount>, nameKey: string, except?: string) {
    const clash = await accounts.findOne({ nameKey })
    if (clash && clash.id !== except) throw new AccountsError('DUPLICATE_NAME', `There is already an account named “${clash.name}”.`, 'name')
  }

  private async endOf(accounts: Collection<StoredAccount>, subLedgerId: string | null, except?: string) {
    const siblings = (await accounts.find({ subLedgerId })).filter(a => a.id !== except)
    return siblings.reduce((max, a) => Math.max(max, a.order), -1) + 1
  }

  // ---- Reading accounts

  async get(id: string): Promise<Account | undefined> {
    return this.read(async c => {
      const doc = typeof id === 'string' ? await c.accounts.get(id) : undefined
      return doc && toAccount(doc)
    })
  }

  async list(filter: AccountFilter = {}): Promise<Account[]> {
    const tree = await this.tree()
    return this.read(async c => {
      let accounts = (await c.accounts.find()).map(toAccount)

      if (filter.subLedgerId !== undefined) {
        const within = new Set<string | null>([filter.subLedgerId])
        if (filter.includeDescendants) {
          if (filter.subLedgerId === null) tree.subLedgers.forEach(s => within.add(s.id))
          else descendantIds(tree.subLedgers, filter.subLedgerId).forEach(id => within.add(id))
        }
        accounts = accounts.filter(a => within.has(a.subLedgerId))
      }
      if (filter.types) accounts = accounts.filter(a => filter.types!.includes(a.type))
      if (filter.classes) accounts = accounts.filter(a => filter.classes!.includes(ACCOUNT_CLASS[a.type]))
      if (filter.currency) accounts = accounts.filter(a => a.currency === filter.currency!.toUpperCase())
      if (filter.includeClosed === false) accounts = accounts.filter(a => !a.closed)
      if (filter.institution !== undefined) {
        const wanted = filter.institution.trim().toLocaleLowerCase()
        accounts = accounts.filter(a => a.institution?.toLocaleLowerCase() === wanted)
      }
      if (filter.accountNumber !== undefined) {
        const number = filter.accountNumber
        const key = accountNumberKey(typeof number === 'string' ? number : number.endsWith)
        accounts = accounts.filter(a => {
          const own = a.accountNumber === undefined ? '' : accountNumberKey(a.accountNumber)
          return key !== '' && (typeof number === 'string' ? own === key : own.endsWith(key))
        })
      }
      return navigatorOrder(tree, accounts)
    })
  }

  async chart(options: { includeClosed?: boolean } = {}): Promise<Chart> {
    const tree = await this.tree()
    return this.read(async c => {
      const accounts = navigatorOrder(tree, (await c.accounts.find()).map(toAccount))
      const sums = await core.sumsByAccount(c)

      // Totals add actual balances, closed accounts included, so net worth is right whatever each account shows
      const totals: CurrencyTotals = {}
      const bySubLedger = new Map<string | null, CurrencyTotals>()
      const parentOf = new Map(tree.subLedgers.map(s => [s.id, s.parentId]))
      const summaries: AccountSummary[] = accounts.map(account => ({ account, balances: core.balancesFor(account, sums.get(account.id)) }))
      for (const { account, balances } of summaries) {
        add(totals, account.currency, balances.current)
        for (let at: string | null | undefined = account.subLedgerId; at != null; at = parentOf.get(at)) {
          const sub = bySubLedger.get(at) ?? {}
          add(sub, account.currency, balances.current)
          bySubLedger.set(at, sub)
        }
      }

      return {
        ledger: { name: tree.ledger.name, ...(tree.ledger.readOnly && { readOnly: true }) },
        subLedgers: tree.subLedgers.map(({ id, parentId, name, order }) => ({ id, parentId, name, order, totals: bySubLedger.get(id) ?? {} })),
        accounts: options.includeClosed === false ? summaries.filter(s => !s.account.closed) : summaries,
        totals
      }
    })
  }

  async balances(id: string): Promise<AccountBalances> {
    return this.read(async c => core.balancesOf(c, toAccount(await core.accountOf(c, id))))
  }

  // ---- Writing accounts

  async createAccount(input: AccountInput): Promise<Account> {
    const fields = checkAccountInput(input)
    await this.checkSubLedger(fields.subLedgerId)
    return this.write(async c => {
      await this.checkNameFree(c.accounts, fields.nameKey)
      const order = await this.endOf(c.accounts, fields.subLedgerId)
      return toAccount(await c.accounts.insert({ ...fields, order, closed: false }))
    }, account => ({ created: [account.id], balances: [account.id] }))
  }

  async updateAccount(id: string, patch: AccountPatch, options: WriteOptions = {}): Promise<Account> {
    const current = await this.get(id)
    if (!current) throw new AccountsError('NOT_FOUND', 'That account no longer exists.')
    if (current.closed) throw new AccountsError('ACCOUNT_CLOSED', `“${current.name}” is closed. Reopen it to change it.`)
    const fields = checkAccountInput(applyPatch(current, patch))
    if (fields.subLedgerId !== current.subLedgerId) await this.checkSubLedger(fields.subLedgerId)

    return this.write(async c => {
      const stored = await core.accountOf(c, id)
      if (fields.currency !== stored.currency && (await core.sumsByAccount(c)).get(id)?.count) {
        throw invalid('currency', 'The currency can’t change once the account has transactions.')
      }
      await this.checkNameFree(c.accounts, fields.nameKey, id)
      const order = fields.subLedgerId === stored.subLedgerId ? stored.order : await this.endOf(c.accounts, fields.subLedgerId, id)
      // Carry what a form doesn't edit (closing, reconciliation); replace the rest, so cleared fields are gone
      const next: StoredAccount & { id: string } = {
        id, ...fields, order, closed: stored.closed,
        ...(stored.closedOn !== undefined && { closedOn: stored.closedOn }),
        ...(stored.lastReconciled !== undefined && { lastReconciled: stored.lastReconciled }),
        ...(stored.lastArchiveDate !== undefined && { lastArchiveDate: stored.lastArchiveDate }),
        ...(stored.archived !== undefined && { archived: stored.archived })
      }
      return toAccount(await c.accounts.replace(next, options.expectedRev === undefined ? {} : { expectedRev: options.expectedRev }))
    }, account => ({
      updated: [account.id],
      balances: account.openingBalance !== current.openingBalance || account.minimumBalance !== current.minimumBalance ? [account.id] : []
    }))
  }

  async closeAccount(id: string, options: WriteOptions & { closedOn?: string } = {}): Promise<Account> {
    const closedOn = options.closedOn ?? this.today()
    if (!isIsoDate(closedOn)) throw invalid('closedOn', 'Enter the date the account closed.')
    return this.write(async c => {
      const account = toAccount(await core.accountOf(c, id))
      if (account.closed) return account
      const { current } = await core.balancesOf(c, account)
      if (current !== 0 && !options.confirm?.includes('closeWithBalance')) {
        throw new AccountsError('CONFIRMATION_REQUIRED',
          `“${account.name}” has a balance of ${formatAmount(current, account.currency)}.`, undefined, ['closeWithBalance'])
      }
      await c.accounts.updateOne({ id }, { $set: { closed: true, closedOn } }, options.expectedRev === undefined ? {} : { expectedRev: options.expectedRev })
      return toAccount(await core.accountOf(c, id))
    }, account => ({ updated: [account.id] }))
  }

  async reopenAccount(id: string, options: WriteOptions = {}): Promise<Account> {
    return this.write(async c => {
      const account = await core.accountOf(c, id)
      if (!account.closed) return toAccount(account)
      await c.accounts.updateOne({ id }, { $set: { closed: false }, $unset: { closedOn: true } }, options.expectedRev === undefined ? {} : { expectedRev: options.expectedRev })
      return toAccount(await core.accountOf(c, id))
    }, account => ({ updated: [account.id] }))
  }

  async deleteAccount(id: string, options: WriteOptions = {}): Promise<void> {
    await this.write(async c => {
      const account = await core.accountOf(c, id)
      const touched = await core.deleteTransactionsOfAccount(c, account, this.now())
      await c.reconciliations.deleteMany({ accountId: id })
      await c.accounts.deleteOne({ id }, options.expectedRev === undefined ? {} : { expectedRev: options.expectedRev })
      return touched
    }, touched => ({ deleted: [id], transactions: [...touched], balances: [id], reconciliations: [id] }))
  }

  async moveAccount(id: string, to: string | null, index?: number): Promise<void> {
    const target = to ?? null
    await this.checkSubLedger(target)
    await this.write(async c => {
      const moving = await core.accountOf(c, id)
      const siblings = (await c.accounts.find({ subLedgerId: target }, { sort: { order: 1 } })).filter(a => a.id !== id)
      const at = index === undefined ? siblings.length : Math.max(0, Math.min(Math.trunc(index), siblings.length))
      const ordered = [...siblings.slice(0, at), moving, ...siblings.slice(at)]
      for (const [order, account] of ordered.entries()) {
        const subLedgerId = account.id === id ? target : account.subLedgerId
        if (account.order === order && account.subLedgerId === subLedgerId) continue
        await c.accounts.updateOne({ id: account.id }, { $set: { order, subLedgerId } })
      }
      // Close the gap it left behind
      if (moving.subLedgerId !== target) {
        const left = await c.accounts.find({ subLedgerId: moving.subLedgerId }, { sort: { order: 1 } })
        for (const [order, account] of left.entries()) {
          if (account.order !== order) await c.accounts.updateOne({ id: account.id }, { $set: { order } })
        }
      }
    }, () => ({ updated: [id] }))
  }

  // ---- Transactions

  transactions(accountId: string): TransactionManager {
    const touchedChange = (touched: core.Touched): Partial<AccountsChange> => ({ transactions: [...touched], balances: [...touched] })
    return {
      accountId,
      list: range => this.read(async c => { await core.accountOf(c, accountId); return core.listTransactions(c, accountId, range) }),
      register: () => this.read(c => core.registerOf(c, accountId)),
      get: id => this.read(async c => {
        const found = typeof id === 'string' ? await c.transactions.get(id) : undefined
        return found && found.accountId === accountId ? { ...found } : undefined
      }),
      create: (draft: TransactionDraft) => this.write(c => core.createTransaction(c, accountId, draft, this.now()),
        result => touchedChange(result.touched)).then(result => result.transaction),
      update: (id: string, patch: TransactionPatch, options: WriteOptions = {}) =>
        this.write(c => core.updateTransaction(c, accountId, id, patch, options, this.now()),
          result => touchedChange(result.touched)).then(result => result.transaction),
      delete: async (ids: string[], options: WriteOptions = {}) => {
        await this.write(c => core.deleteTransactions(c, accountId, ids, options), touchedChange)
      },
      setStatus: async (ids: string[], status: ClearingStatus, options: WriteOptions = {}) => {
        await this.write(c => core.setStatus(c, accountId, ids, status, options, this.now()), touchedChange)
      },
      setVoided: async (ids: string[], voided: boolean, options: WriteOptions = {}) => {
        await this.write(c => core.setVoided(c, accountId, ids, voided, options, this.now()), touchedChange)
      },
      balances: () => this.balances(accountId),
      nextNumber: () => this.read(c => core.nextNumber(c, accountId)),

      // For importers. Nothing to create writes nothing and announces nothing, but still checks the account
      createMany: (drafts: TransactionDraft[]) => Array.isArray(drafts) && drafts.length === 0
        ? this.read(async c => { await core.openAccount(c, accountId); return [] })
        : this.write(c => core.createTransactions(c, accountId, drafts, this.now()), result => touchedChange(result.touched))
          .then(result => result.transactions),
      findByExternalIds: (ids: string[]) => this.read(c => core.findByExternalIds(c, accountId, ids)),
      match: (id: string, match: BankMatch, options: WriteOptions = {}) =>
        this.write(c => core.matchTransaction(c, accountId, id, match, options, this.now()), result => touchedChange(result.touched))
          .then(result => result.transaction),
      unmatch: (id: string, unmatch: BankUnmatch, options: WriteOptions = {}) =>
        this.write(c => core.unmatchTransaction(c, accountId, id, unmatch, options, this.now()), result => touchedChange(result.touched))
          .then(({ transaction, added }) => added ? { transaction, added } : { transaction })
    }
  }

  readonly payees: PayeeDirectory = {
    search: (prefix, limit) => this.read(c => core.searchPayees(c, prefix, limit))
  }

  readonly categories: CategoryDirectory = {
    list: () => this.read(c => core.listCategories(c)),
    create: (path, kind) => this.write(c => core.createCategory(c, path, kind),
      ({ created }) => ({ categories: created, chart: false })).then(result => result.category)
  }

  // ---- Reconciliation

  readonly reconciliation: ReconciliationService = {
    get: accountId => this.read(async c => {
      const session = await reconcile.inProgress(c, accountId)
      return session ? reconcile.stateOf(c, accountId, session) : undefined
    }),
    // Begin can add the statement's service charge and interest, so the balances and the register may change
    begin: (accountId, statement) => this.write(c => reconcile.begin(c, accountId, statement, this.now()),
      state => state.reconciliation.addedIds.length > 0
        ? { reconciliations: [accountId], transactions: [accountId], balances: [accountId] }
        : { reconciliations: [accountId], chart: false }),
    mark: (accountId, ids, marked) => this.write(c => reconcile.mark(c, accountId, ids, marked, this.now()),
      () => ({ transactions: [accountId], balances: [accountId], reconciliations: [accountId] })),
    pause: accountId => this.write(c => reconcile.pause(c, accountId),
      () => ({ reconciliations: [accountId], chart: false })),
    finish: (accountId, options = {}) => this.write(c => reconcile.finish(c, accountId, options.confirm ?? [], this.now()),
      () => ({ transactions: [accountId], balances: [accountId], reconciliations: [accountId], updated: [accountId] })),
    cancel: accountId => this.write(c => reconcile.cancel(c, accountId, this.now()),
      touched => ({ transactions: [...touched], balances: [...touched], reconciliations: [accountId] })).then(() => undefined)
  }

  // ---- Taking part in sub-ledgers

  /** Deleting a sub-ledger moves its accounts to its parent, inside the ledger's transaction. */
  readonly participant: SubLedgerParticipant = {
    describe: async subLedgerId => {
      const count = await this.c().accounts.count({ subLedgerId })
      return count === 0 ? undefined : `${count} account${count === 1 ? '' : 's'}`
    },
    reparent: async (tx, from, to) => {
      const { accounts } = this.c(tx)
      let order = await this.endOf(accounts, to)
      for (const account of await accounts.find({ subLedgerId: from }, { sort: { order: 1 } })) {
        await accounts.updateOne({ id: account.id }, { $set: { subLedgerId: to, order: order++ } })
        this.moved.push(account.id)
      }
    }
  }

  // ---- Taking part in archives

  /**
   * File › Archive Ledger…: removes the transactions no longer required before the archive date, carries their total
   * into each account's opening balance, removes closed accounts left with nothing (unless the user unticks it), and
   * checks that no balance changed, all inside the ledger's archive transaction. Shares what it removed
   * (`AccountsArchived`) with the participants after it. See docs/ledger-compaction-design.md.
   */
  readonly archiver: ArchiveParticipant = {
    describe: (before, options) => this.read(async c => {
      const data = await readLedger(c)
      return describePlan(planArchive(data, before, { removeClosedAccounts: removesClosedAccounts(options) }), data.accounts)
    }),
    archive: async (tx, request) => {
      this.archivedChange = undefined
      try {
        const { result, change: touched } = await applyArchive(this.c(tx), request.before, request.options, this.deps.turn ?? (() => new Promise<void>(resolve => setImmediate(resolve))))
        this.archivedChange = change(touched)
        return result
      } catch (err) { throw translate(err) }
    },
    committed: () => {
      const touched = this.archivedChange
      this.archivedChange = undefined
      if (touched) this.changes.fire(touched)
    }
  }
}
