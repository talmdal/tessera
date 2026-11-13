// The accounts domain: accounts, transactions, payees and categories, and what a register shows.
// Money is always integer minor units (cents), dates are 'YYYY-MM-DD'. See docs/account-manager-design.md.

export const ACCOUNT_TYPES = [
  'chequing', 'savings', 'cash',
  'creditCard', 'lineOfCredit',
  'loan', 'mortgage',
  'investment', 'retirement',
  'otherAsset', 'otherLiability'
] as const

export type AccountType = typeof ACCOUNT_TYPES[number]

/** Assets normally have positive balances, liabilities negative ones (what is owed). */
export type AccountClass = 'asset' | 'liability'

export const ACCOUNT_CLASS: Readonly<Record<AccountType, AccountClass>> = {
  chequing: 'asset',
  savings: 'asset',
  cash: 'asset',
  investment: 'asset',
  retirement: 'asset',
  otherAsset: 'asset',
  creditCard: 'liability',
  lineOfCredit: 'liability',
  loan: 'liability',
  mortgage: 'liability',
  otherLiability: 'liability'
}

/**
 * The register's two amount columns for each type: the one that lowers the balance, then the one that raises it.
 * Amounts in these columns are shown unsigned, as in Microsoft Money. (To be checked against Money Plus in phase 4.)
 */
export const AMOUNT_COLUMNS: Readonly<Record<AccountType, { decrease: string, increase: string }>> = {
  chequing: { decrease: 'Payment', increase: 'Deposit' },
  savings: { decrease: 'Payment', increase: 'Deposit' },
  cash: { decrease: 'Payment', increase: 'Deposit' },
  investment: { decrease: 'Withdrawal', increase: 'Deposit' },
  retirement: { decrease: 'Withdrawal', increase: 'Deposit' },
  otherAsset: { decrease: 'Decrease', increase: 'Increase' },
  creditCard: { decrease: 'Charge', increase: 'Payment' },
  lineOfCredit: { decrease: 'Charge', increase: 'Payment' },
  loan: { decrease: 'Increase', increase: 'Payment' },
  mortgage: { decrease: 'Increase', increase: 'Payment' },
  otherLiability: { decrease: 'Increase', increase: 'Payment' }
}

export interface Account {
  id: string
  /** The sub-ledger holding the account, or null when it sits directly in the ledger. */
  subLedgerId: string | null
  /** Unique in the ledger, ignoring case. */
  name: string
  type: AccountType
  /** ISO 4217, e.g. 'CAD'. Can change only while the account has no transactions. */
  currency: string
  institution?: string
  /** As entered (ledgers are not encrypted in the first release); shown masked, •••• 1234. */
  accountNumber?: string
  /**
   * The number the bank uses for itself in downloaded statements (OFX `BANKID`): usually its routing or transit number.
   * Exports to OFX, QFX and QBO need it; OFX imports fill it in. (Since accounts-api 1.12.)
   */
  bankId?: string
  /**
   * The bank's id with Intuit (`INTU.BID` in a QFX or QBO file), which Quicken and QuickBooks expect in a file they
   * import. Exports to QFX and QBO write it; OFX imports fill it in. (Since accounts-api 1.12.)
   */
  intuitBankId?: string
  /** When the account opened. A historical fact: archiving never changes it. */
  openingDate: string
  /**
   * Minor units, signed like every balance: a liability's opening balance is negative. The opening balance of the
   * current period: from `lastArchiveDate` when the account has been archived (what the archived transactions added up
   * to is carried into it), else from `openingDate`. Every balance is built from it.
   */
  openingBalance: number
  /** Minor units; credit cards and lines of credit. */
  creditLimit?: number
  /** Minor units, not negative: the balance the bank requires the account to keep (asset accounts). */
  minimumBalance?: number
  /**
   * Show the balance less the minimum (`available`) rather than the actual balance, in the navigator and the
   * register. Totals always add actual balances, so net worth stays true.
   */
  showAvailableBalance?: boolean
  /** Closed at the bank: read-only, hidden by default, still counted in totals. */
  closed: boolean
  closedOn?: string
  /** Position among the accounts of its sub-ledger; lower first. */
  order: number
  notes?: string
  lastReconciled?: { date: string, balance: number, reconciliationId: string }
  /**
   * The last archival date (YYYY-MM-DD): the latest archive date that removed anything from this account, and so the
   * start of its current period. Every transaction archived from it was dated before. Unset if none ever was. Set only
   * by archiving: `createAccount` and `updateAccount` refuse it.
   */
  lastArchiveDate?: string
  /** What archiving has taken out of the account, over every archive. Set with `lastArchiveDate`. */
  archived?: AccountArchived
  rev: number
}

/** What archiving has taken out of an account. See docs/ledger-compaction-design.md, "What the account records". */
export interface AccountArchived {
  /** How many transactions have been archived from the account, in all. */
  count: number
  /** The balance the account opened with on `openingDate`, before the first archive carried anything into it. */
  originalOpeningBalance: number
  /** The highest numeric transaction number archived, so the next cheque number suggested still follows it. */
  highestNumber?: number
}

/**
 * What the accounts plugin's archive participant shares with the participants after it (`ArchiveRequest.earlier`,
 * under `accounts`), so they can drop what they kept about what it removed.
 */
export interface AccountsArchived {
  /** The transactions removed. */
  transactionIds: string[]
  /** The accounts they were removed from, each with its last archival date now. */
  accounts: { id: string, lastArchiveDate: string }[]
  /** Closed accounts removed, with nothing left in them. */
  removedAccountIds: string[]
}

/** Uncleared, then E (the bank reported it), C (the user cleared it), R (reconciled). Void is a separate flag. */
export const CLEARING_STATUSES = ['uncleared', 'electronic', 'cleared', 'reconciled'] as const

export type ClearingStatus = typeof CLEARING_STATUSES[number]

/** The register's one status letter. A voided transaction shows `V` whatever its status. */
export const STATUS_LETTERS: Readonly<Record<ClearingStatus, string>> & { voided: string } = {
  uncleared: '',
  electronic: 'E',
  cleared: 'C',
  reconciled: 'R',
  voided: 'V'
}

/** The statuses that count towards the cleared balance. */
export const CLEARED_STATUSES: readonly ClearingStatus[] = ['electronic', 'cleared', 'reconciled']

export interface Split {
  amount: number
  categoryId?: string
  memo?: string
}

/** A transaction in one account. The other side of a transfer is a second transaction, in the other account. */
export interface Transaction {
  /** Internal identifier: a ULID. Never shown, never reused; sorts by creation. */
  id: string
  accountId: string
  date: string
  /** A cheque number or a code such as 'ATM', 'EFT', 'DEP'. */
  number?: string
  /** Minor units. Positive raises this account's balance. */
  amount: number
  payeeId?: string
  /** Absent for transfers and split transactions. */
  categoryId?: string
  /** Set on both sides of a transfer: the pair's shared id. */
  transferId?: string
  /** Set on both sides of a transfer: the other account. */
  transferAccountId?: string
  memo?: string
  status: ClearingStatus
  /** Excluded from every balance; the amount and status are kept, so unvoiding restores them. */
  voided: boolean
  /** Reserved (later): split lines, summing to `amount`. */
  splits?: Split[]
  /**
   * The import's identity for the bank line this transaction is: the bank's own id (OFX FITID), or an importer's
   * fingerprint ('fp:…') when the file has none. Unique in the account, so a line can't be imported twice. Never shown.
   */
  externalId?: string
  createdAt: string
  updatedAt: string
  rev: number
}

export interface Payee {
  id: string
  name: string
  rev: number
}

/** A payee as the register's autocomplete sees it, with what its most recent transaction was. */
export interface PayeeSuggestion extends Payee {
  lastCategoryId?: string
  lastTransferAccountId?: string
  /** Signed, from the point of view of the account it was in. */
  lastAmount?: number
}

export interface Category {
  id: string
  /** The parent category, or null at the top. Shown as `Parent : Child`. */
  parentId: string | null
  name: string
  kind: 'income' | 'expense'
  rev: number
}

/** Balances in minor units; all exclude voided transactions. */
export interface AccountBalances {
  /** Opening balance plus every transaction. */
  current: number
  /** `current` less the minimum balance; `current` when the account has none. */
  available: number
  /** Opening balance plus electronic, cleared and reconciled transactions. */
  cleared: number
  /** Opening balance plus reconciled transactions. */
  reconciled: number
  /** Every transaction, voided ones included. */
  transactionCount: number
}

/** Whether an account's balances are shown above its minimum: it asks for that, and has a minimum. */
export function showsAvailable(account: Pick<Account, 'showAvailableBalance' | 'minimumBalance'>): boolean {
  return account.showAvailableBalance === true && account.minimumBalance !== undefined
}

/** The balance to show for an account: the available balance when it asks for that, else the actual one. */
export function shownBalance(account: Pick<Account, 'showAvailableBalance' | 'minimumBalance'>, balances: AccountBalances): number {
  return showsAvailable(account) ? balances.available : balances.current
}

/** The running balance to show on a register row, by the same rule as `shownBalance`. */
export function shownRunningBalance(account: Pick<Account, 'showAvailableBalance' | 'minimumBalance'>, row: Pick<RegisterRow, 'balance' | 'available'>): number {
  return showsAvailable(account) ? row.available : row.balance
}

/** An account in the chart, with its balances. */
export interface AccountSummary {
  account: Account
  balances: AccountBalances
}

/** Totals of the accounts beneath a sub-ledger (or the ledger), one per currency. */
export type CurrencyTotals = Record<string, number>

/** The ledger tree with accounts placed in it. Sub-ledgers come from `ledger.session`. */
export interface Chart {
  /** `readOnly`: the ledger is open read-only (an archive file), so views offer nothing that changes it. */
  ledger: { name: string, readOnly?: boolean }
  subLedgers: { id: string, parentId: string | null, name: string, order: number, totals: CurrencyTotals }[]
  accounts: AccountSummary[]
  /** Totals of every account in the ledger. */
  totals: CurrencyTotals
}

export interface RegisterRow {
  transaction: Transaction
  /** The running balance after this row, in minor units. */
  balance: number
  /** The running balance less the account's minimum balance; `balance` when it has none. */
  available: number
  payeeName?: string
  /** `Parent : Child`, or `Transfer to: Savings` / `Transfer from: Savings`. */
  categoryLabel?: string
}

/** Everything the register view shows for one account. The opening-balance row is drawn by the view. */
export interface RegisterSnapshot {
  account: Account
  rows: RegisterRow[]
  balances: AccountBalances
}
