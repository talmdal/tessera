// `import.annotator`: the import's marks on register rows (accounts.register.annotations). A proposed match shows the
// bank's version under the row, with what differs emphasised; a row added as new says it is new from the bank. Both
// have Accept and Change…. An accepted row looks like any other, with Change Match… in its menu; a bank line that lost
// its transaction is counted in the review bar, with Resolve…. The marks are worked out from the lines and the
// account's transactions each time, so they never show buttons for a change already made. Reads only.
// See docs/import-manager-design.md, "What the import plugin annotates".
import type { Event } from '@tessera/types'
import type { LedgerSession } from '@tessera/ledger-api'
import {
  formatAmount,
  type AccountAnnotations, type AccountsService, type AnnotationAction, type RegisterAnnotator, type RowAnnotation, type Transaction
} from '@tessera/accounts-api'
import {
  IMPORT_COMMANDS, IMPORT_PLUGIN_ID,
  type AcceptAllArgs, type AcceptArgs, type ChangeArgs
} from '@tessera/import-api'
import type { PayeeAliases } from './aliases'
import { matchedDate, settle, viewOf, type Line } from './lineState'
import { payeeScore, prepareLine, prepareTarget, scorePair, type PreparedLine } from './matching/score'
import { BALANCED, type MatchTuning } from './matching/tuning'
import { collectionsOf } from './store'

const dateFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })
/** 'Oct 6'. */
export const shortDate = (date: string) => dateFormat.format(new Date(`${date}T00:00:00Z`))

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`

export interface AnnotatorDeps {
  session: LedgerSession
  accounts: AccountsService
  aliases: PayeeAliases
  /** The matching preset the user chose (the `import` setting). Balanced when not given. */
  tuning?: () => MatchTuning
}

/** What Accept does to a proposal, for its tooltip: "Use the bank’s date, Oct 6, and amount, 84.12, and mark it…". */
export function acceptTooltip(line: Line, t: Transaction, currency: string, start?: string): string {
  const date = matchedDate(line, t, start)
  const uses = [
    t.date !== date && `date, ${shortDate(date)}`,
    t.amount !== line.bank.amount && `amount, ${formatAmount(line.bank.amount, currency, { sign: 'never', currency: false })}`
  ].filter((u): u is string => typeof u === 'string')
  const marks = t.status === 'uncleared'
  if (uses.length === 0) return marks ? 'Link it to the bank line, and mark it electronically cleared' : 'Link it to the bank line; nothing else changes'
  return `Use the bank’s ${uses.join(', and ')}${marks ? ', and mark it electronically cleared' : ''}`
}

export class ImportAnnotator {
  private readonly listeners = new Set<(change: { accounts: string[] }) => void>()

  constructor(private readonly deps: AnnotatorDeps) {}

  readonly onDidChange: Event<{ accounts: string[] }> = listener => {
    this.listeners.add(listener)
    return { dispose: () => { this.listeners.delete(listener) } }
  }

  /** Says that these accounts' marks changed. */
  fire(accounts: string[]): void {
    if (accounts.length === 0) return
    for (const listener of [...this.listeners]) listener({ accounts })
  }

  /**
   * The matching preset changed: the registers with proposals still to review are read again, so their rows are
   * scored, and shown as *Matched* or *Possible match*, by the new one.
   */
  async presetChanged(): Promise<void> {
    if (!this.deps.session.current) return
    const c = collectionsOf(this.deps.session.database(IMPORT_PLUGIN_ID))
    const pending = await c.lines.find({ outcome: 'matched', review: 'pending' })
    this.fire([...new Set(pending.map(line => line.accountId))])
  }

  /** Exactly the `RegisterAnnotator` contract. */
  service(): RegisterAnnotator {
    return { annotate: accountId => this.annotate(accountId), onDidChange: this.onDidChange }
  }

  async annotate(accountId: string): Promise<AccountAnnotations> {
    const current = this.deps.session.current
    if (!current) return { rows: [] }
    const c = collectionsOf(this.deps.session.database(IMPORT_PLUGIN_ID))
    const lines = (await c.lines.find({ accountId })).filter(l => l.outcome !== 'skipped') as Line[]
    if (lines.length === 0) return { rows: [] }
    const tuning = this.deps.tuning?.() ?? BALANCED
    const { accounts } = this.deps
    const account = await accounts.get(accountId)
    if (!account) return { rows: [] }
    const [transactions, payees, aliases] = await Promise.all([
      accounts.transactions(accountId).list(), accounts.payees.search('', 100_000), this.deps.aliases.map()
    ])
    const byId = new Map(transactions.map(t => [t.id, t]))
    const byImportId = new Map(transactions.filter(t => t.externalId !== undefined).map(t => [t.externalId!, t]))
    const names = new Map(payees.map(p => [p.id, p.name]))
    // A read-only ledger shows the marks, but nothing can be done about them
    const actionable = !current.readOnly

    const rows: RowAnnotation[] = []
    const unresolved: Line[] = []
    const sources = new Set<string>()
    let matches = 0
    let news = 0
    for (const stored of lines) {
      const line = settle(stored, byImportId.get(stored.importId))
      const view = viewOf(line, id => byId.get(id))
      const change: AnnotationAction = {
        id: 'import.change', label: 'Change…', icon: 'CompareArrows', placement: 'button', command: IMPORT_COMMANDS.change,
        args: { lineId: line.id } satisfies ChangeArgs,
        tooltip: view.state === 'new' ? 'Match it to a transaction you entered, or leave it out' : 'Match it to another transaction, unmatch it, or leave the bank line out'
      }
      const accept = (tooltip: string): AnnotationAction => ({
        id: 'import.accept', label: 'Accept', icon: 'Check', placement: 'button', command: IMPORT_COMMANDS.accept,
        args: { lineIds: [line.id] } satisfies AcceptArgs, tooltip
      })
      switch (view.state) {
        case 'proposed': {
          const prepared = prepareLine(line.bank, aliases)
          const t = view.transaction
          const payeeName = t.payeeId !== undefined ? names.get(t.payeeId) : undefined
          const target = prepareTarget({ id: t.id, date: t.date, amount: t.amount, ...(payeeName && { payeeName }), ...(t.number && { number: t.number }) })
          // Scored again, with the preset chosen now: the user may have edited the transaction since the import
          const score = scorePair(prepared, target, account.currency, undefined, tuning)?.score ?? 0
          const matched = score >= tuning.matchedAt
          matches++
          sources.add(line.batchId)
          rows.push({
            transactionId: t.id, review: true, tone: matched ? 'info' : 'warning',
            detail: { icon: matched ? 'CompareArrows' : 'Warning', parts: bankParts(line, t, prepared, payeeScore(prepared, target), account.currency, matched ? 'Matched to bank line: ' : 'Possible match: ', tuning) },
            actions: actionable ? [accept(acceptTooltip(line, t, account.currency, account.lastArchiveDate)), change] : []
          })
          break
        }
        case 'new':
          if (view.pending) {
            news++
            sources.add(line.batchId)
            rows.push({
              transactionId: view.transaction.id, review: true, tone: 'info',
              detail: {
                icon: 'NewReleases',
                parts: [{ text: 'New from the bank: ' }, { text: [line.bank.payee, line.bank.memo].filter(Boolean).join(' · ') || 'no description' }]
              },
              actions: actionable ? [accept('Keep it as the bank sent it'), change] : []
            })
          } else rows.push(acceptedRow(view.transaction, line, actionable))
          break
        case 'accepted':
          rows.push(acceptedRow(view.transaction, line, actionable))
          break
        case 'unresolved':
          unresolved.push(line)
          sources.add(line.batchId)
          break
      }
    }

    const toReview = matches + news
    if (toReview === 0 && unresolved.length === 0) return { rows }
    const files = [...new Set((await c.batches.getMany([...sources])).map(b => b.fileName))]
    const from = files.length === 1 ? `, from ${files[0]}` : files.length > 1 ? `, from ${files.length} imports` : ''
    const messages: string[] = []
    if (toReview > 0) {
      const kinds = [matches > 0 && plural(matches, 'match', 'matches'), news > 0 && `${news.toLocaleString()} new`].filter(Boolean)
      messages.push(`${plural(toReview, 'imported transaction')} to review (${kinds.join(', ')})${from}.`)
    }
    if (unresolved.length > 0) {
      messages.push(`${plural(unresolved.length, 'bank line')}${toReview > 0 ? '' : from} lost ${unresolved.length === 1 ? 'its' : 'their'} match: say where ${unresolved.length === 1 ? 'it goes' : 'they go'}.`)
    }
    const actions: AnnotationAction[] = !actionable ? [] : [
      ...(toReview > 0 ? [{
        id: 'import.acceptAll', label: 'Accept All…', icon: 'Check', placement: 'button' as const, command: IMPORT_COMMANDS.acceptAll,
        args: { accountId } satisfies AcceptAllArgs, tooltip: 'Accept every imported transaction to review in this account'
      }] : []),
      ...(unresolved.length > 0 ? [{
        id: 'import.resolve', label: 'Resolve…', icon: 'CompareArrows', placement: 'button' as const, command: IMPORT_COMMANDS.change,
        args: { lineId: unresolved[0].id } satisfies ChangeArgs,
        tooltip: `${shortDate(unresolved[0].bank.date)} · ${unresolved[0].bank.payee ?? 'no description'} · ${formatAmount(unresolved[0].bank.amount, account.currency, { sign: 'never', currency: false })}`
      }] : [])
    ]
    return { rows, summary: { message: messages.join(' '), actions, outstanding: unresolved.length } }
  }
}

/** The bank's version of a proposed match, with what differs from the transaction emphasised. */
function bankParts(line: Line, t: Transaction, prepared: PreparedLine, payee: number | undefined, currency: string, label: string, tuning: MatchTuning) {
  const parts: { text: string, emphasis?: boolean }[] = [{ text: label }]
  const add = (text: string, emphasis: boolean) => {
    if (parts.length > 1) parts.push({ text: ' · ' })
    parts.push({ text, ...(emphasis && { emphasis: true }) })
  }
  add(shortDate(line.bank.date), t.date !== line.bank.date)
  if (prepared.line.payee) add(prepared.line.payee, payee !== undefined && payee < tuning.payeeDiffersBelow)
  add(formatAmount(line.bank.amount, currency, { sign: 'never', currency: false }), t.amount !== line.bank.amount)
  return parts
}

/** An accepted row (or an acknowledged new one): no marks, and Change Match… in its menu. */
function acceptedRow(t: Transaction, line: Line, actionable: boolean): RowAnnotation {
  return {
    transactionId: t.id, review: false, tone: 'info', detail: { parts: [] },
    actions: actionable ? [{
      id: 'import.changeMatch', label: 'Change Match…', icon: 'CompareArrows', placement: 'menu', command: IMPORT_COMMANDS.change,
      args: { lineId: line.id } satisfies ChangeArgs,
      tooltip: line.outcome === 'matched' ? 'Move the bank line to another transaction, or unmatch it' : 'Match the bank line to a transaction you entered, or leave it out'
    }] : []
  }
}
