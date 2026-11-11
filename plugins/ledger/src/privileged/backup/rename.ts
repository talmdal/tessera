// Renaming a file another program may be holding. Windows refuses a rename while another program has the file open
// without sharing deletion, and Node reports it as EBUSY: antivirus scanning a file just written, a sync client, the
// indexer, another copy of Tessera. The policy (docs/backup-restore-design.md, "Replacing a ledger") follows
// graceful-fs, which npm uses: retry, but only onto a name that doesn't exist, so a refusal means the source is held.
import type { LedgerDisk } from '../disk'

export interface RetryOptions {
  /** How long to keep trying. Default 10 s: an interactive wait, not npm's 60 s. */
  budgetMs?: number
  /** When to tell the user what we are waiting for. Default 1 s. */
  noticeMs?: number
  onWaiting?(): void
  /** Stops the waiting: the rename is tried once more at most. */
  signal?: AbortSignal
  /** For tests: how to wait, and what time it is. */
  sleep?(ms: number): Promise<void>
  now?(): number
}

/** The codes a held file gives: EBUSY on Windows (measured), and EPERM and EACCES, which graceful-fs retries too. */
const HELD = new Set(['EBUSY', 'EPERM', 'EACCES'])

export async function renameWithRetry(disk: Pick<LedgerDisk, 'rename' | 'exists'>, from: string, to: string, options: RetryOptions = {}) {
  const { budgetMs = 10_000, noticeMs = 1000, onWaiting } = options
  const now = options.now ?? (() => Date.now())
  const sleep = options.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const start = now()
  let backoff = 0
  let told = false
  for (;;) {
    try {
      await disk.rename(from, to)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code
      if (!HELD.has(code ?? '') || options.signal?.aborted || await disk.exists(to) || now() - start >= budgetMs) throw err
      if (!told && now() - start >= noticeMs) {
        told = true
        onWaiting?.()
      }
      await sleep(backoff)
      if (backoff < 100) backoff += 10
    }
  }
}
