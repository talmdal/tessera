// Archiving: what a plugin that keeps data about archivable things has to do, and what the user is shown before
// agreeing to it. See docs/archive-design.md, "Participants" and "The Archive dialog".
import type { Transaction as StorageTransaction } from '@tessera/types'

/** What is being archived: the cut-off, and what counts as removable. Settled before any participant is asked. */
export interface ArchiveRequest {
  /** Exclusive: things dated strictly before this are candidates. `YYYY-MM-DD`. */
  before: string
  /** Remove reconciled transactions before the cut-off. */
  removeReconciled: boolean
  /** Remove voided transactions before the cut-off. */
  removeVoided: boolean
}

/** Something the user should know before agreeing. Shown as a list, most important first. */
export interface ArchiveWarning {
  kind: 'unreconciled' | 'openImport' | 'other'
  /** A whole sentence: "Chequing: 14 transactions before 1 Jan 2026 are not reconciled (oldest 3 Mar 2019)." */
  message: string
}

/** One line of the dialog's *Details* table: what a participant will do to one thing it keeps. */
export interface ArchiveRow {
  /** The participant's own id for it (an account id), for keys and tests. */
  id: string
  /** What to call it: an account name. */
  label: string
  /** How many documents go from it. */
  removed: number
  /** What it will look like afterwards, already formatted by the participant, which alone knows how: an
   * account's new opening balance in its own currency. */
  detail?: string
}

/** What a participant would do, without doing it. */
export interface ArchiveSurvey {
  /** For the confirmation: "8,412 transactions in 6 accounts", "213 recurring postings". */
  describe: string
  /** How many documents this participant would remove; for the totals line. */
  documents: number
  warnings: ArchiveWarning[]
  /** Per-thing rows for the Details disclosure. */
  rows?: ArchiveRow[]
  /** Why this participant can't take part at all: archiving is refused and this is the message. */
  blocker?: string
  /**
   * Ids of documents this participant will remove that other plugins may point at — `accounts` publishes the
   * transactions it is removing, so `recurring` can clear the postings that named them and `exchange` can drop
   * the import batches that created them. Collected from every survey and handed to every `prune`, so it does
   * not matter which participant runs first.
   */
  removesIds?: readonly string[]
}

/** What `prune` is given: the request, and what every participant's survey said it would remove. */
export interface ArchiveContext {
  request: ArchiveRequest
  /** Every id published by every survey (`ArchiveSurvey.removesIds`), this participant's included. */
  removedIds: ReadonlySet<string>
}

export interface ArchiveResult {
  /** How many documents were actually removed. The plan said `documents`; a difference is worth logging. */
  documents: number
}

/**
 * A plugin that keeps data about things archiving removes, and so must take part when a book is archived.
 * Register with `BookSession.participateInArchive`.
 */
export interface ArchiveParticipant {
  /**
   * What this plugin would remove for a cut-off, without removing it. Must not write. What it says is what the
   * user is shown and agrees to.
   *
   * Surveys run in **two passes**, because what one plugin removes can depend on what another does: an import
   * batch goes only when every transaction it created goes. The first pass runs with `published` empty and only
   * collects every survey's `removesIds`; the second runs with the full set and is the plan. A survey that
   * ignores `published` must simply answer the same both times.
   */
  survey(request: ArchiveRequest, published: ReadonlySet<string>): Promise<ArchiveSurvey>
  /**
   * Inside the single archiving transaction, with `tx` scoped to this participant's own collections: remove what
   * `survey` said, and make whatever adjustments keep the book true. Throwing rolls the whole archive back — the
   * archive file is kept, the book is left exactly as it was.
   */
  prune(tx: StorageTransaction, context: ArchiveContext): Promise<ArchiveResult>
}

/** One participant's part of the plan. */
export interface ArchivePlanPart {
  contributor: string
  describe: string
  documents: number
}

/** A Details row with the participant that contributed it. */
export interface ArchivePlanRow extends ArchiveRow {
  contributor: string
}

/** What the Archive dialog shows and what the user confirms: every participant's survey, put together. */
export interface ArchivePlan {
  before: string
  /** Where the archive would go. Filled in by the Archiver, not by the surveys. */
  file?: string
  /** Everything that would be removed, across every participant. Zero means there is nothing to archive. */
  documents: number
  /** In the order the participants will run. */
  parts: ArchivePlanPart[]
  rows: ArchivePlanRow[]
  warnings: ArchiveWarning[]
  /** Why archiving can't go ahead at all, from the first participant that said so. */
  blocker?: string
  /** Ids published by the surveys, carried into the prune as `ArchiveContext.removedIds`. */
  removedIds: readonly string[]
}

/** What an archive run produced. */
export interface ArchiveOutcome {
  file: string
  before: string
  /** Documents removed from the book. */
  documents: number
}
