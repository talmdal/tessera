// The accounts plugin's part in archiving. See docs/archive-design.md, "Participants" and "Moving the opening
// balance".
//
// It runs last of all the participants, because it is the one that moves each account's opening balance forward
// and checks that no balance moved as a result. The survey and the prune both go through `planAccountsArchive`,
// so they can never disagree about the rules — and the prune recomputes inside the storage transaction, so what
// it removes is decided on the book as it is at that moment, not as it was when the user was asked.
import type { Transaction as StorageTransaction } from '@tessera/types'
import {
  BookError, type ArchiveContext, type ArchiveParticipant, type ArchiveRequest, type ArchiveResult, type ArchiveSurvey
} from '@tessera/book-api'
import { collectionsOf, type Collections } from './store'
import { balancesFor, sumsByAccount } from './transactionsCore'
import { balanceProblem, describeRemoval, planAccountsArchive, removalCount, removalRows, removalWarnings } from './archiveCore'

export interface AccountsArchiveDeps {
  /** The accounts collections, read through the open book's database. */
  collections: () => Collections
}

export function accountsArchiveParticipant(deps: AccountsArchiveDeps): ArchiveParticipant {
  return {
    async survey(request: ArchiveRequest): Promise<ArchiveSurvey> {
      const plan = await planAccountsArchive(deps.collections(), request)
      return {
        describe: describeRemoval(plan),
        documents: removalCount(plan),
        warnings: removalWarnings(plan, request.before),
        rows: removalRows(plan),
        // So `recurring` can clear the postings that named them, and `exchange` the batches that made them
        removesIds: plan.transactionIds,
        ...(plan.blocker !== undefined && { blocker: plan.blocker })
      }
    },

    async prune(tx: StorageTransaction, context: ArchiveContext): Promise<ArchiveResult> {
      const c = collectionsOf(tx)
      const plan = await planAccountsArchive(c, context.request)
      if (plan.blocker !== undefined) throw new BookError('ARCHIVE_BLOCKED', plan.blocker)

      // The pre-image: every affected account's balances before anything goes
      const sumsBefore = await sumsByAccount(c)
      const before = new Map(plan.accounts.map(({ account }) =>
        [account.id, balancesFor(account, sumsBefore.get(account.id))]))

      if (plan.transactionIds.length > 0) await c.transactions.deleteMany({ id: { $in: plan.transactionIds } })
      if (plan.reconciliationIds.length > 0) await c.reconciliations.deleteMany({ id: { $in: plan.reconciliationIds } })
      for (const { account, openingBalance, openingDate } of plan.accounts) {
        await c.accounts.updateOne({ id: account.id }, { $set: { openingBalance, openingDate } })
      }

      // The post-image, read back rather than assumed — the stored account, not the value that was meant to be
      // stored, so even a write that quietly went wrong is caught. A wrong adjustment rolls the whole archive back
      const sumsAfter = await sumsByAccount(c)
      for (const { account, removed } of plan.accounts) {
        const stored = await c.accounts.findOne({ id: account.id })
        if (!stored) throw new BookError('ARCHIVE_BALANCE_MISMATCH', `Archiving was stopped because “${account.name}” disappeared while it ran. Nothing was removed.`)
        const after = balancesFor(stored, sumsAfter.get(account.id))
        const problem = balanceProblem(account.name, before.get(account.id)!, after, removed.length)
        if (problem !== undefined) {
          throw new BookError('ARCHIVE_BALANCE_MISMATCH', `Archiving was stopped because ${problem} Nothing was removed.`)
        }
      }

      return { documents: plan.transactionIds.length + plan.reconciliationIds.length }
    }
  }
}
