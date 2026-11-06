// A bank line as a new transaction: the payee a saved alias names, or an existing payee when one is named almost the
// same (so next month's 'COSTCO WHSE #0456' lands on last month's payee), otherwise a tidy name from the bank's text;
// the payee's usual category, or one from the kind of line the bank says it is. Marked electronically cleared, with
// the line's id.
// See docs/import-manager-design.md, "New transactions".
import type { Category, PayeeSuggestion, TransactionDraft } from '@tessera/accounts-api'
import type { ConvertedLine } from './convert'
import { normalizePayee, normalizedSimilarity, tidyPayee } from './matching/payees'

/** How alike a bank's payee text and an existing payee's name must be to use that payee. */
export const SAME_PAYEE = 0.9

export interface DraftContext {
  /** Every payee in the ledger, with what each was last used for. */
  payees: PayeeSuggestion[]
  categories: Category[]
  /** The account is a liability (a card, a loan): interest it charges goes to Interest paid. */
  liability: boolean
  /** Saved payee aliases: normalised bank text → payee name. */
  aliases?: ReadonlyMap<string, string>
}

export class Drafts {
  private readonly chosen = new Map<string, { name: string, suggestion?: PayeeSuggestion }>()
  /** The aliases the drafts used, to count their uses. */
  readonly usedAliases = new Set<string>()

  /** The ledger's payees with their names normalised once, and the payees this import adds. */
  private readonly known: { suggestion: PayeeSuggestion, normalized: string }[]
  /** The payees' names by normalised bank text: a statement repeats its payees. */
  private readonly byPattern = new Map<string, { suggestion: PayeeSuggestion, score: number } | undefined>()

  constructor(private readonly context: DraftContext) {
    this.known = context.payees.map(suggestion => ({ suggestion, normalized: normalizePayee(suggestion.name) }))
  }

  /**
   * The payee for a bank's text: the one a saved alias names; else an existing one scoring at least SAME_PAYEE (the
   * best); else a tidy new name.
   */
  payeeFor(bankText: string): { name: string, suggestion?: PayeeSuggestion } {
    const known = this.chosen.get(bankText)
    if (known) return known
    const pattern = normalizePayee(bankText)
    const alias = pattern !== '' ? this.context.aliases?.get(pattern) : undefined
    if (alias !== undefined) {
      const suggestion = this.context.payees.find(p => p.id !== '' && p.name.toLowerCase() === alias.toLowerCase())
      const choice = { name: suggestion?.name ?? alias, ...(suggestion && { suggestion }) }
      this.usedAliases.add(pattern)
      this.chosen.set(bankText, choice)
      return choice
    }
    let best = this.byPattern.get(pattern)
    if (!this.byPattern.has(pattern)) {
      for (const { suggestion, normalized } of this.known) {
        const score = normalizedSimilarity(pattern, normalized)
        if (score >= SAME_PAYEE && (!best || score > best.score)) best = { suggestion, score }
      }
      this.byPattern.set(pattern, best)
    }
    let choice: { name: string, suggestion?: PayeeSuggestion }
    // (A payee new in this import has no history yet: it names the payee, but suggests no category)
    if (best) choice = { name: best.suggestion.name, ...(best.suggestion.id !== '' && { suggestion: best.suggestion }) }
    else {
      choice = { name: tidyPayee(bankText) }
      // A new payee is a candidate for the rest of this import too, so one statement doesn't make two of it
      const added = { suggestion: { id: '', rev: 0, name: choice.name }, normalized: normalizePayee(choice.name) }
      this.known.push(added)
      for (const [other, was] of this.byPattern) {
        const score = normalizedSimilarity(other, added.normalized)
        if (score >= SAME_PAYEE && (!was || score > was.score)) this.byPattern.set(other, { suggestion: added.suggestion, score })
      }
    }
    this.chosen.set(bankText, choice)
    return choice
  }

  /** A top-level category by name, ignoring case, if the ledger has it. */
  private category(name: string): string | undefined {
    return this.context.categories.find(c => c.parentId === null && c.name.toLowerCase() === name.toLowerCase())?.id
  }

  private categoryFor(line: ConvertedLine, suggestion: PayeeSuggestion | undefined): string | undefined {
    // The payee's last category, unless it was last a transfer: that would create the other side, unasked
    if (suggestion?.lastCategoryId !== undefined && suggestion.lastTransferAccountId === undefined &&
        this.context.categories.some(c => c.id === suggestion.lastCategoryId)) return suggestion.lastCategoryId
    if (suggestion?.lastTransferAccountId !== undefined) return undefined
    switch (line.bank.kind) {
      case 'fee': case 'serviceCharge': return this.category('Bank fees')
      case 'interest': return this.category(this.context.liability ? 'Interest paid' : 'Interest')
      default: return undefined
    }
  }

  draftFor(line: ConvertedLine): TransactionDraft {
    const { bank } = line
    const payee = bank.payee !== undefined ? this.payeeFor(bank.payee) : undefined
    const categoryId = this.categoryFor(line, payee?.suggestion)
    return {
      date: bank.date, amount: bank.amount, status: 'electronic', externalId: line.importId,
      ...(payee !== undefined && payee.name !== '' && { payee: payee.name }),
      ...(bank.memo !== undefined && { memo: bank.memo }),
      ...(bank.number !== undefined && { number: bank.number }),
      ...(categoryId !== undefined && { categoryId })
    }
  }
}
