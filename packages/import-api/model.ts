// What the import manager keeps and shows: bank lines (in minor units, once the account is known), saved account
// matches, and the candidates the Change Match dialog offers. Money is integer minor units, dates are 'YYYY-MM-DD'.
import type { Transaction } from '@tessera/accounts-api'
import type { KeyStrength, StatementLineKind } from './contract'

/** A statement line as the import manager keeps it: converted to the account's currency, the bank's text as sent. */
export interface BankLine {
  date: string
  userDate?: string
  /** Minor units, signed from the account's point of view. */
  amount: number
  /** The bank's text, as sent: shown under the row while it is reviewed. */
  payee?: string
  memo?: string
  number?: string
  kind?: StatementLineKind
}

/** "Statements from this source go to that account", saved in the ledger. */
export interface AccountLink {
  id: string
  /** `StatementAccount.key`, or a key the import manager made from the file's name. Unique. */
  key: string
  strength: KeyStrength
  accountId: string
  /** Use the account without asking. Always true for a saved strong match; the user's choice for a weak one. */
  autoApply: boolean
  /** What the file called the account, for the Saved Account Matches dialog: 'TD Canada Trust •••• 5678'. */
  label: string
  /** The format the statement came through. */
  formatId: string
  createdAt: string
  lastUsedAt: string
  rev: number
}

/**
 * Where a bank line stands, for the Change Match dialog:
 * - 'proposed': matched to a transaction, waiting for Accept (nothing in the transaction has changed yet);
 * - 'accepted': matched, and accepted (the transaction took the bank's date, amount and id);
 * - 'new': added as a new transaction, whether acknowledged or not;
 * - 'unresolved': it lost its transaction (the proposed one was deleted, voided or reconciled, or moving an accepted
 *   match was interrupted), so it is in the register nowhere until the user says where it goes;
 * - 'duplicate': it looks like a transaction already imported from another file (a CSV export, say, where this is the
 *   bank's OFX), so nothing was added for it; Accept confirms it is the same, Change… can add it after all
 *   (since import-api 1.4).
 */
export type MatchState = 'proposed' | 'accepted' | 'new' | 'unresolved' | 'duplicate'

/** A transaction the Change Match dialog offers for a bank line. */
export interface MatchCandidate {
  transaction: Transaction
  payeeName?: string
  /** `Parent : Child`, or `Transfer to: Savings`. */
  categoryLabel?: string
  /** 0 to 1; 0 for transactions found by searching outside the matching window. */
  score: number
  /** What differs, in words, for the Differences column: ['1 day earlier', '0.12 less']. */
  differences: string[]
  /** The bank's text already names this payee (the same name, or a saved payee alias), so there is nothing to learn. */
  payeeKnown: boolean
}
