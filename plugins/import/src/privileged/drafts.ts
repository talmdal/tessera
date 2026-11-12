// A bank line as a new transaction: the payee a saved alias names, or an existing payee when one is named almost the
// same (so next month's 'COSTCO WHSE #0456' lands on last month's payee), otherwise a tidy name from the bank's text;
// the payee's usual category, or one from the kind of line the bank says it is. Marked electronically cleared, with
// the line's id. A category the file gives is used only for a source the user said to take them from, and only when
// it names a category the ledger has.
// See docs/import-manager-design.md, "New transactions", and docs/import-formats-design.md, "Category hints".
import { CATEGORY_SEPARATOR, accountNameKey, categoryLabel, type Category, type PayeeSuggestion, type TransactionDraft } from '@tessera/accounts-api'
import type { CategoryExample, CategorySource } from '@tessera/import-api'
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

/** What drafting needs of a line: its identity, the bank's version, and the file's category, if any. */
export type DraftLine = Pick<ConvertedLine, 'importId' | 'bank' | 'category'>

/** A new line whose file gives a category the ledger has, and the category its payee would give it. */
export interface CategoryOffer {
  line: DraftLine
  payee: string
  /** The file's category. */
  file: string
  /** The payee's usual category, if it has one. */
  usual?: string
}

/** How many examples the Categories from the File dialog shows. */
export const CATEGORY_EXAMPLES = 5

export class Drafts {
  private readonly chosen = new Map<string, { name: string, suggestion?: PayeeSuggestion }>()
  /** The aliases the drafts used, to count their uses. */
  readonly usedAliases = new Set<string>()

  /** The ledger's payees with their names normalised once, and the payees this import adds. */
  private readonly known: { suggestion: PayeeSuggestion, normalized: string }[]
  /** The payees' names by normalised bank text: a statement repeats its payees. */
  private readonly byPattern = new Map<string, { suggestion: PayeeSuggestion, score: number } | undefined>()

  /** Category paths as the ledger has them, by their parts' name keys → id. */
  private readonly paths = new Map<string, string>()

  /**
   * Which category a line takes when its file gives one: 'payee' (the default, and how imports behaved before files
   * could give categories) leaves the file's unused; 'file' uses it when the ledger has it. Set once the user has
   * answered for the statement's source.
   */
  categorySource: CategorySource = 'payee'

  constructor(private readonly context: DraftContext) {
    this.known = context.payees.map(suggestion => ({ suggestion, normalized: normalizePayee(suggestion.name) }))
    for (const category of context.categories) {
      const label = categoryLabel(context.categories, category.id)
      if (label !== undefined) this.paths.set(pathKey(label.split(CATEGORY_SEPARATOR)), category.id)
    }
  }

  /** The ledger's category at a file's path ('Food:Groceries', 'food : groceries'), as accounts compares names; undefined if it has none. */
  categoryAt(path: string | undefined): string | undefined {
    if (path === undefined) return undefined
    return this.paths.get(pathKey(path.split(':')))
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

  /** The payee's last category, unless it was last a transfer: that would create the other side, unasked. */
  private usualCategory(suggestion: PayeeSuggestion | undefined): string | undefined {
    if (suggestion?.lastCategoryId !== undefined && suggestion.lastTransferAccountId === undefined &&
        this.context.categories.some(c => c.id === suggestion.lastCategoryId)) return suggestion.lastCategoryId
    return undefined
  }

  /**
   * The lines whose file gives a category the ledger has, with the payee each will have and its usual category: what
   * the user is asked about before any of them is used.
   */
  offers(lines: readonly DraftLine[]): CategoryOffer[] {
    const offers: CategoryOffer[] = []
    for (const line of lines) {
      const file = this.categoryAt(line.category)
      if (file === undefined) continue
      const payee = line.bank.payee !== undefined ? this.payeeFor(line.bank.payee) : undefined
      const usual = this.usualCategory(payee?.suggestion)
      offers.push({ line, payee: payee?.name ?? '', file, ...(usual !== undefined && { usual }) })
    }
    return offers
  }

  /** A few offers as the dialog shows them, by name: those whose payee usually has another category first, one per payee. */
  examples(offers: readonly CategoryOffer[], max = CATEGORY_EXAMPLES): CategoryExample[] {
    const label = (id: string) => categoryLabel(this.context.categories, id) ?? ''
    const differing = (o: CategoryOffer) => o.usual !== undefined && o.usual !== o.file
    const ordered = [...offers.filter(differing), ...offers.filter(o => !differing(o))]
    const seen = new Set<string>()
    const examples: CategoryExample[] = []
    for (const offer of ordered) {
      const key = offer.payee.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      examples.push({ payee: offer.payee || '(no payee)', file: label(offer.file), ...(offer.usual !== undefined && { usual: label(offer.usual) }) })
      if (examples.length === max) break
    }
    return examples
  }

  private categoryFor(line: DraftLine, suggestion: PayeeSuggestion | undefined): string | undefined {
    // The file's category, only when the user said to take them for this source, and only one the ledger has
    if (this.categorySource === 'file') {
      const file = this.categoryAt(line.category)
      if (file !== undefined) return file
    }
    const usual = this.usualCategory(suggestion)
    if (usual !== undefined) return usual
    if (suggestion?.lastTransferAccountId !== undefined) return undefined
    switch (line.bank.kind) {
      case 'fee': case 'serviceCharge': return this.category('Bank fees')
      case 'interest': return this.category(this.context.liability ? 'Interest paid' : 'Interest')
      default: return undefined
    }
  }

  draftFor(line: DraftLine): TransactionDraft {
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

/** A category path compared as the accounts plugin compares category names: part by part, by their name keys. */
function pathKey(parts: readonly string[]): string {
  return parts.map(part => accountNameKey(part.trim())).join(':')
}
