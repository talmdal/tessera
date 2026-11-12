// Reviewing imported lines, from the register's buttons: Accept, Accept All, and Change…, whose dialog moves a line to
// another transaction, unmatches it (it becomes a transaction of its own) or leaves it out. Every change goes through
// `accounts.service`, and writes its intent on the line first, so an interruption is put right from what the account
// holds (lineState.ts). A change reaching a reconciled transaction is confirmed with the user, then sent again.
// See docs/import-manager-design.md, "Reviewing in the register" and "The Change Match dialog".
import type { Database, Logger, ShellPrompts } from '@tessera/types'
import type { LedgerSession } from '@tessera/ledger-api'
import {
  isAccountsError, isLiability, minorDigits,
  type AccountsErrorCode, type AccountsService, type Confirmation, type Transaction, type TransactionDraft, type WriteOptions
} from '@tessera/accounts-api'
import {
  IMPORT_DIALOGS, IMPORT_PLUGIN_ID, ImportError, isImportError,
  type AcceptAllArgs, type AcceptArgs, type ChangeArgs, type ImportErrorCode, type ImportResult, type MatchCandidate,
  type MatchCandidatesRequest, type MatchCandidatesResponse, type MatchDialogResult
} from '@tessera/import-api'
import type { PayeeAliases } from './aliases'
import { Drafts } from './drafts'
import { matchStateOf, matchedDate, settle, transactionOf, viewOf, type Line, type LineView } from './lineState'
import { bankName, normalizeSearch } from './matching/payees'
import { dayNumber, differences, looseScore, payeeScore, prepareLine, prepareTarget } from './matching/score'
import { BALANCED, MAX_CANDIDATES, WIDE_DAYS, type MatchTuning } from './matching/tuning'
import { collectionsOf, type Before, type LineIntent } from './store'

export interface ReviewDeps {
  session: LedgerSession
  accounts: AccountsService
  prompts: Pick<ShellPrompts, 'show' | 'confirm'>
  aliases: PayeeAliases
  /** Told which accounts' import records changed, so their registers' marks are read again. */
  changed: (accounts: string[]) => void
  log: Pick<Logger, 'warn'>
  /** The matching preset the user chose (the `import` setting). Balanced when not given. */
  tuning?: () => MatchTuning
}

/** The user said no to changing a reconciled transaction: nothing more is done, and that is not a failure. */
class Declined extends Error {}

const isText = (v: unknown): v is string => typeof v === 'string' && v !== ''

/** An accounts refusal, in the import's terms. */
function importCodeOf(code: AccountsErrorCode): ImportErrorCode {
  switch (code) {
    case 'NO_LEDGER': case 'READ_ONLY': case 'NOT_FOUND': case 'ACCOUNT_CLOSED': case 'CURRENCY_MISMATCH': return code
    default: return 'REFUSED'
  }
}

/** Runs `work` for a view or a command: the user's problems as a failed result, anything else (a bug) thrown. */
export async function toReviewResult<T>(work: () => Promise<T>): Promise<ImportResult<T | undefined>> {
  try {
    return { ok: true, value: await work() }
  } catch (err) {
    if (err instanceof Declined) return { ok: true, value: undefined }
    if (isImportError(err)) return { ok: false, error: { code: err.code, message: err.message } }
    if (isAccountsError(err)) return { ok: false, error: { code: importCodeOf(err.code), message: err.message } }
    throw err
  }
}

/** A cheque's line names the cheque, not who it paid ('CHQ 104'), so it teaches nothing about payees. */
const teaches = (line: Line) => line.bank.number === undefined && line.bank.kind !== 'cheque' && isText(line.bank.payee)

const beforeOf = (t: Transaction): Before => ({ date: t.date, amount: t.amount, status: t.status })

/**
 * What Unmatch puts back on an accepted match's transaction: only the fields that still hold the bank's values, so
 * a change the user made since is kept. The status goes back only while it is still 'electronic'.
 */
export function restoresFor(line: Pick<Line, 'bank' | 'before'>, t: Transaction): { date?: string, amount?: number, status?: Before['status'] } {
  const before = line.before
  if (!before) return {}
  return {
    ...(t.date === line.bank.date && before.date !== line.bank.date && { date: before.date }),
    ...(t.amount === line.bank.amount && before.amount !== line.bank.amount && { amount: before.amount }),
    ...(t.status === 'electronic' && before.status !== 'electronic' && { status: before.status })
  }
}

/**
 * Settles every review change an interruption left half made (a line still holding its intent), by what the account
 * holds. Run when a ledger opens and before each import, as interrupted imports are.
 */
export async function settleInterrupted(db: () => Database, accounts: AccountsService): Promise<void> {
  const lines = collectionsOf(db()).lines
  for (const stored of await lines.find({ intent: { $exists: true } })) {
    let carrier: Transaction | undefined
    try {
      carrier = (await accounts.transactions(stored.accountId).findByExternalIds([stored.importId]))[0]
    } catch (err) {
      if (!isAccountsError(err) || err.code !== 'NOT_FOUND') throw err       // the account is gone: so is the line, soon
      continue
    }
    await lines.replace(settle(stored as Line, carrier))
  }
}

export class Review {
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly deps: ReviewDeps) {}

  private get lines() {
    return collectionsOf(this.deps.session.database(IMPORT_PLUGIN_ID)).lines
  }

  /** One review change at a time: a second click waits for the first rather than racing it. */
  private serially<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work)
    this.queue = run.catch(() => undefined)
    return run
  }

  private writable() {
    const current = this.deps.session.current
    if (!current) throw new ImportError('NO_LEDGER', 'Open a ledger first.')
    if (current.readOnly) throw new ImportError('READ_ONLY', 'This ledger is open read-only.')
  }

  private async load(lineId: unknown): Promise<Line> {
    const line = isText(lineId) ? await this.lines.get(lineId) : undefined
    if (!line) throw new ImportError('NOT_FOUND', 'That bank line is no longer there.')
    return line as Line
  }

  private async save(line: Line): Promise<Line> {
    return await this.lines.replace(line) as Line
  }

  private async carrierOf(line: Line): Promise<Transaction | undefined> {
    return (await this.deps.accounts.transactions(line.accountId).findByExternalIds([line.importId]))[0]
  }

  /**
   * The line settled, and where it stands. With `persist`, what settling finds is saved: an interrupted change is
   * finished or forgotten, and a proposal found already applied is recorded as accepted.
   */
  private async stand(stored: Line, persist: boolean): Promise<{ line: Line, view: LineView }> {
    const manager = this.deps.accounts.transactions(stored.accountId)
    const carrier = await this.carrierOf(stored)
    let line = settle(stored, carrier)
    const known = new Map<string, Transaction>(carrier ? [[carrier.id, carrier]] : [])
    for (const id of [line.transactionId, line.proposedId]) {
      if (id === undefined || known.has(id)) continue
      const t = await manager.get(id)
      if (t) known.set(id, t)
    }
    const view = viewOf(line, id => known.get(id))
    if (persist) {
      if (view.state === 'accepted' && line.transactionId === undefined) {
        const { proposedId: _p, ...rest } = line
        line = await this.save({ ...rest, outcome: 'matched', review: 'done', transactionId: view.transaction.id })
      } else if (stored.intent) line = await this.save(line)
    }
    return { line, view }
  }

  /**
   * Runs an accounts write; when it needs the user's confirmation (a reconciled transaction), asks, and sends it
   * again with it. Throws `Declined` if the user says no.
   */
  private async confirming<T>(work: (options: WriteOptions) => Promise<T>, confirm: Confirmation[] = []): Promise<T> {
    try {
      return await work(confirm.length > 0 ? { confirm } : {})
    } catch (err) {
      if (!isAccountsError(err) || err.code !== 'CONFIRMATION_REQUIRED' || !err.reasons?.length) throw err
      const yes = await this.deps.prompts.confirm({ message: 'Change a reconciled transaction?', detail: err.message, confirmLabel: 'Change It' })
      if (!yes) throw new Declined()
      return this.confirming(work, [...confirm, ...err.reasons])
    }
  }

  /**
   * A change to a line with an `accounts` write: the intent first, then the write, then the line as the account now
   * says it is. However the write ends (done, refused, declined, half done), the line is settled by its carrier.
   */
  private async changing(line: Line, intent: LineIntent, write: () => Promise<unknown>): Promise<void> {
    await this.lines.updateOne({ id: line.id }, { $set: { intent } as never })
    try {
      await write()
    } finally {
      await this.save(settle({ ...line, intent }, await this.carrierOf(line)))
    }
  }

  private manager(line: Line) {
    return this.deps.accounts.transactions(line.accountId)
  }

  /** The line matched to `target`, which takes the bank's date, amount and id. */
  private async matchTo(line: Line, target: Transaction, options: { replaces?: string, release?: Transaction } = {}): Promise<void> {
    const manager = this.manager(line)
    // The bank's date, unless it would move the transaction before the account's last archival date
    const date = matchedDate(line, target, (await this.deps.accounts.get(line.accountId))?.lastArchiveDate)
    await this.changing(line, {
      carrier: { kind: 'id', id: target.id },
      next: { outcome: 'matched', review: 'done', transactionId: target.id, before: beforeOf(target) }
    }, async () => {
      // Moving an accepted match: its transaction goes back first. Interrupted here, the line is left unresolved
      if (options.release) await this.confirming(o => manager.unmatch(options.release!.id, { restore: restoresFor(line, options.release!) }, o))
      await this.confirming(o => manager.match(target.id, {
        externalId: line.importId,
        ...(target.date !== date && { date }),
        ...(target.amount !== line.bank.amount && { amount: line.bank.amount }),
        ...(options.replaces !== undefined && { replaces: options.replaces })
      }, o))
    })
  }

  /** The line as a transaction of its own, already acknowledged (the user has just looked at it). */
  private async addAsNew(line: Line, release?: Transaction): Promise<void> {
    const draft = await this.draftFor(line)
    const manager = this.manager(line)
    await this.changing(line, { carrier: { kind: 'new' }, next: { outcome: 'added', review: 'done' } }, async () => {
      if (release) await this.confirming(o => manager.unmatch(release.id, { restore: restoresFor(line, release), add: draft }, o))
      else await manager.createMany([draft])
    })
  }

  /** The line left out: recorded as skipped, so a later import doesn't bring it back. */
  private async leaveOut(line: Line, from?: { release?: Transaction, remove?: Transaction }): Promise<void> {
    if (!from?.release && !from?.remove) {
      const { transactionId: _t, proposedId: _p, before: _b, intent: _i, ...rest } = line
      await this.save({ ...rest, outcome: 'skipped', review: 'done' })
      return
    }
    const manager = this.manager(line)
    await this.changing(line, { carrier: { kind: 'none' }, next: { outcome: 'skipped', review: 'done' } }, async () => {
      if (from.release) await this.confirming(o => manager.unmatch(from.release!.id, { restore: restoresFor(line, from.release!) }, o))
      else await this.confirming(o => manager.delete([from.remove!.id], o))
    })
  }

  /** The bank line as a new transaction, as an import would add it (payee alias, similar payee, category). */
  private async draftFor(line: Line): Promise<TransactionDraft> {
    const { accounts } = this.deps
    const account = await accounts.get(line.accountId)
    if (!account) throw new ImportError('NOT_FOUND', 'That account no longer exists.')
    const [payees, categories, aliases] = await Promise.all([accounts.payees.search('', 100_000), accounts.categories.list(), this.deps.aliases.map()])
    return new Drafts({ payees, categories, aliases, liability: isLiability(account.type) }).draftFor({ importId: line.importId, bank: line.bank })
  }

  private async payeeNameOf(t: Transaction): Promise<string | undefined> {
    if (t.payeeId === undefined) return undefined
    return (await this.deps.accounts.payees.search('', 100_000)).find(p => p.id === t.payeeId)?.name
  }

  /** Learns how the bank writes the payee of the transaction the line was matched to. */
  private async learn(line: Line, target: Transaction): Promise<void> {
    if (!teaches(line)) return
    await this.deps.aliases.learn(line.bank.payee, await this.payeeNameOf(target))
      .catch(err => this.deps.log.warn(`[import] Could not save a payee alias: ${(err as Error)?.message ?? err}`))
  }

  /**
   * The line is the transaction imported before that it looks like (Already imported?): it is left out, as the same
   * bank line from another file, and nothing in the account changes. The earlier line is acknowledged too, if it was
   * still waiting: its row showed this one's mark.
   */
  private async confirmDuplicate(line: Line): Promise<void> {
    const { proposedId: _p, transactionId: _t, before: _b, intent: _i, ...rest } = line
    await this.save({ ...rest, outcome: 'skipped', review: 'done' })
    const earlier = line.duplicateOf !== undefined ? await this.lines.get(line.duplicateOf) : undefined
    if (earlier && earlier.outcome === 'added' && earlier.review === 'pending') await this.lines.updateOne({ id: earlier.id }, { $set: { review: 'done' } })
  }

  /** Accepts one line's row: a proposal is applied; a new row is acknowledged; an already-imported line is left out. */
  private async acceptLine(stored: Line): Promise<void> {
    const { line, view } = await this.stand(stored, true)
    if (view.state === 'accepted') return
    if (view.state === 'duplicate') return this.confirmDuplicate(line)
    if (view.state === 'new') {
      if (view.pending) await this.lines.updateOne({ id: line.id }, { $set: { review: 'done' } })
      return
    }
    if (view.state !== 'proposed') throw new ImportError('NOT_FOUND', 'This bank line has no match to accept. Use Change… to say where it goes.')
    await this.matchTo(line, view.transaction)
    await this.learn(line, view.transaction)
  }

  /** `import.review.accept`. */
  accept(args: AcceptArgs): Promise<ImportResult<void | undefined>> {
    return this.serially(() => toReviewResult(async () => {
      this.writable()
      const ids = Array.isArray(args?.lineIds) ? args.lineIds.filter(isText) : []
      if (ids.length === 0) throw new ImportError('NOT_FOUND', 'Choose the bank lines to accept.')
      const touched = new Set<string>()
      try {
        for (const id of ids) {
          const line = await this.load(id)
          touched.add(line.accountId)
          await this.acceptLine(line)
        }
      } finally {
        if (touched.size > 0) this.deps.changed([...touched])
      }
    }))
  }

  /** `import.review.acceptAll`: every row to review in the account, once the user agrees. */
  acceptAll(args: AcceptAllArgs): Promise<ImportResult<void | undefined>> {
    return this.serially(() => toReviewResult(async () => {
      this.writable()
      const accountId = args?.accountId
      if (!isText(accountId)) throw new ImportError('NOT_FOUND', 'Choose the account.')
      const pending: { line: Line, view: LineView }[] = []
      for (const stored of await this.lines.find({ accountId, review: 'pending' })) {
        const stood = await this.stand(stored as Line, true)
        if (stood.view.state === 'proposed' || stood.view.state === 'duplicate' || (stood.view.state === 'new' && stood.view.pending)) pending.push(stood)
      }
      if (pending.length === 0) return
      const matches = pending.filter(p => p.view.state === 'proposed')
      const duplicates = pending.filter(p => p.view.state === 'duplicate').length
      // A new line whose transaction another line looks like is acknowledged with it, and isn't counted twice
      const duplicated = new Set(pending.filter(p => p.view.state === 'duplicate').map(p => transactionOf(p.view)!.id))
      const news = pending.filter(p => p.view.state === 'new' && !duplicated.has(p.view.transaction.id)).length
      const changes = matches.filter(({ line, view }) => {
        const t = transactionOf(view)!
        return t.date !== line.bank.date || t.amount !== line.bank.amount
      }).length
      const parts = [
        matches.length > 0 && `${matches.length} ${matches.length === 1 ? 'match' : 'matches'}`,
        news > 0 && `${news} new ${news === 1 ? 'transaction' : 'transactions'}`,
        duplicates > 0 && `${duplicates} ${duplicates === 1 ? 'line' : 'lines'} already imported`
      ].filter((p): p is string => typeof p === 'string')
      const what = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0]
      const details = [
        changes > 0 && `${changes} ${changes === 1 ? 'match changes' : 'matches change'} a date or an amount to the bank’s.`,
        duplicates > 0 && `The ${duplicates === 1 ? 'line' : `${duplicates} lines`} already imported from another file won’t be added again.`
      ].filter((d): d is string => typeof d === 'string')
      const yes = await this.deps.prompts.confirm({
        message: `Accept ${what}?`,
        ...(details.length > 0 && { detail: details.join(' ') }),
        confirmLabel: 'Accept All'
      })
      if (!yes) return
      const failures: string[] = []
      try {
        for (const { line } of pending) {
          try {
            await this.acceptLine(line)
          } catch (err) {
            if (err instanceof Declined) continue
            if (!isImportError(err) && !isAccountsError(err)) throw err
            failures.push(err.message)
          }
        }
      } finally {
        this.deps.changed([accountId])
      }
      if (failures.length > 0) {
        throw new ImportError('REFUSED', `${failures.length === 1 ? 'One row' : `${failures.length} rows`} couldn’t be accepted: ${failures[0]}`)
      }
    }))
  }

  /** `import.review.change`: the Change Match dialog, then what the user chose. */
  change(args: ChangeArgs): Promise<ImportResult<void | undefined>> {
    return this.serially(() => toReviewResult(async () => {
      this.writable()
      const first = await this.stand(await this.load(args?.lineId), true)
      if (!matchStateOf(first.view)) throw new ImportError('NOT_FOUND', 'That bank line isn’t in the register any more.')
      const answer = await this.deps.prompts.show<MatchDialogResult, ChangeArgs>(IMPORT_DIALOGS.match, { lineId: first.line.id })
      if (!answer) return
      // What the line is now: a change elsewhere while the dialog was open wins over the dialog's picture
      const { line, view } = await this.stand(await this.load(first.line.id), true)
      try {
        await this.apply(line, view, answer)
      } finally {
        this.deps.changed([line.accountId])
      }
    }))
  }

  private async apply(line: Line, view: LineView, answer: MatchDialogResult): Promise<void> {
    const current = transactionOf(view)
    switch (answer?.kind) {
      case 'match': {
        const target = await this.target(line, view, answer.transactionId)
        if (target.id === current?.id) {
          // The transaction it looks like, chosen: it is the same, as Accept says
          if (view.state === 'duplicate') return this.confirmDuplicate(line)
          // The proposal itself: as Accept, but the dialog's box says whether to learn the payee
          if (view.state === 'proposed') {
            await this.matchTo(line, target)
            if (answer.rememberPayee === true) await this.learn(line, target)
          }
          return                                                  // an accepted match chosen again: nothing to do
        }
        if (view.state === 'accepted') await this.matchTo(line, target, { release: view.transaction })
        else if (view.state === 'new') await this.matchTo(line, target, { replaces: view.transaction.id })
        else await this.matchTo(line, target)
        if (answer.rememberPayee === true) await this.learn(line, target)
        return
      }
      case 'unmatch':
        if (view.state === 'new') throw new ImportError('REFUSED', 'This bank line is a transaction of its own already.')
        return this.addAsNew(line, view.state === 'accepted' ? view.transaction : undefined)
      case 'skip':
        if (view.state === 'duplicate') return this.confirmDuplicate(line)
        if (view.state === 'accepted') return this.leaveOut(line, { release: view.transaction })
        if (view.state === 'new') {
          const yes = await this.deps.prompts.confirm({
            message: 'Delete the transaction added for this bank line?',
            detail: 'It won’t be imported again.', confirmLabel: 'Delete', destructive: true
          })
          if (!yes) return
          return this.leaveOut(line, { remove: view.transaction })
        }
        return this.leaveOut(line)
      default:
        throw new ImportError('REFUSED', 'Choose what to do with the bank line.')
    }
  }

  /** Ids of the transactions proposed for other bank lines of the account, still waiting for review. */
  private async proposedElsewhere(line: Line): Promise<Set<string>> {
    const waiting = await this.lines.find({ accountId: line.accountId, outcome: 'matched', review: 'pending' })
    return new Set(waiting.filter(l => l.id !== line.id).map(l => l.proposedId).filter((id): id is string => id !== undefined))
  }

  /** The transaction chosen for a line, checked as the dialog's list was: it must be free to take the line. */
  private async target(line: Line, view: LineView, id: unknown): Promise<Transaction> {
    const t = isText(id) ? await this.manager(line).get(id) : undefined
    if (!t) throw new ImportError('NOT_FOUND', 'That transaction no longer exists.')
    const current = transactionOf(view)
    if (view.state === 'new' && t.id === current?.id) throw new ImportError('REFUSED', 'That is the transaction this bank line was added as.')
    if ((view.state === 'accepted' || view.state === 'duplicate') && t.id === current?.id) return t
    if (Math.sign(t.amount) !== Math.sign(line.bank.amount)) throw new ImportError('REFUSED', 'That transaction goes the other way: money in can’t match money out.')
    if (t.voided) throw new ImportError('REFUSED', 'That transaction is void.')
    if (t.status === 'reconciled') throw new ImportError('REFUSED', 'That transaction is reconciled: it was on an earlier statement.')
    if (t.externalId !== undefined) throw new ImportError('REFUSED', 'That transaction is matched to another bank line already.')
    if ((await this.proposedElsewhere(line)).has(t.id)) throw new ImportError('REFUSED', 'That transaction is proposed for another bank line. Review that one first.')
    return t
  }

  /** `import:match.candidates`: what the Change Match dialog lists for a line. Reads only. */
  async candidates(request: MatchCandidatesRequest): Promise<MatchCandidatesResponse> {
    if (!this.deps.session.current) throw new ImportError('NO_LEDGER', 'Open a ledger first.')
    const { line, view } = await this.stand(await this.load(request?.lineId), false)
    const state = matchStateOf(view)
    if (!state) throw new ImportError('NOT_FOUND', 'That bank line isn’t in the register any more.')
    const account = await this.deps.accounts.get(line.accountId)
    if (!account) throw new ImportError('NOT_FOUND', 'That account no longer exists.')
    const [{ rows }, aliases, elsewhere] = await Promise.all([
      this.manager(line).register(), this.deps.aliases.map(), this.proposedElsewhere(line)
    ])
    const prepared = prepareLine(line.bank, aliases)
    const current = transactionOf(view)
    const listsCurrent = current !== undefined && view.state !== 'new'

    const tuning = this.deps.tuning?.() ?? BALANCED
    const range = request?.range === 'all' || request?.range === 'wide' ? request.range : 'window'
    const days = [dayNumber(line.bank.date), ...(line.bank.userDate ? [dayNumber(line.bank.userDate)] : [])]
    const [from, to] = range === 'all' ? [-Infinity, Infinity]
      : range === 'wide' ? [Math.min(...days) - WIDE_DAYS, Math.max(...days) + WIDE_DAYS]
      : [Math.min(...days) - (line.bank.number !== undefined ? tuning.window.chequeBefore : tuning.window.before), Math.max(...days) + tuning.window.after]
    const query = normalizeSearch(typeof request?.query === 'string' ? request.query : '')
    const digits = query.replace(/[^\d.]/g, '')

    const candidates: (MatchCandidate & { distance: number })[] = []
    for (const row of rows) {
      const t = row.transaction
      const isCurrent = listsCurrent && t.id === current!.id
      if (!isCurrent) {
        if (view.state === 'new' && t.id === current?.id) continue
        if (t.voided || t.status === 'reconciled' || t.externalId !== undefined || elsewhere.has(t.id)) continue
        if (Math.sign(t.amount) !== Math.sign(line.bank.amount)) continue
        const day = dayNumber(t.date)
        if (day < from || day > to) continue
        if (query !== '') {
          const text = normalizeSearch([row.payeeName, t.memo, row.categoryLabel, t.number].filter(Boolean).join(' '))
          const amount = (Math.abs(t.amount) / 10 ** minorDigits(account.currency)).toFixed(minorDigits(account.currency))
          if (!text.includes(query) && !(digits !== '' && amount.includes(digits))) continue
        }
      }
      const target = prepareTarget({ id: t.id, date: t.date, amount: t.amount, ...(row.payeeName && { payeeName: row.payeeName }), ...(t.number && { number: t.number }) })
      const p = payeeScore(prepared, target)
      candidates.push({
        transaction: t,
        ...(row.payeeName !== undefined && { payeeName: row.payeeName }),
        ...(row.categoryLabel !== undefined && { categoryLabel: row.categoryLabel }),
        score: looseScore(prepared, target, account.currency, tuning),
        differences: differences(prepared, target, account.currency, tuning),
        payeeKnown: !teaches(line) || p === undefined || p === 1,
        distance: Math.abs(dayNumber(t.date) - dayNumber(line.bank.date))
      })
    }
    candidates.sort((a, b) => b.score - a.score || a.distance - b.distance || (a.transaction.id < b.transaction.id ? -1 : 1))
    const restores = view.state === 'accepted' ? restoresFor(line, view.transaction) : undefined
    return {
      account, line: line.bank, state,
      ...(current !== undefined && { currentId: current.id }),
      candidates: candidates.slice(0, MAX_CANDIDATES).map(({ distance: _d, ...c }) => c),
      ...(isText(line.bank.payee) && { bankName: bankName(line.bank.payee) }),
      ...(restores && { restores: { ...(restores.date !== undefined && { date: restores.date }), ...(restores.amount !== undefined && { amount: restores.amount }) } })
    }
  }
}
