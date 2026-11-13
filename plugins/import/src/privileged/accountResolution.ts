// Which account a statement goes into: a saved account match, then the account number, then the Account dialog,
// where the user picks an account, creates one (the accounts plugin's own form, filled in from the statement), or
// skips the statement. What the user chooses is remembered, by the statement's key. See docs/import-manager-design.md,
// "Finding the account".
import type { Logger, ShellPrompts } from '@tessera/types'
import {
  ACCOUNTS_DIALOGS, ACCOUNT_NUMBER_MAX_LENGTH, ACCOUNT_TYPE_LABELS, BANK_ID_MAX_LENGTH, INTUIT_BANK_ID_MAX_LENGTH, accountNumberKey, maskAccountNumber, shownBalance,
  type Account, type AccountDialogInput as NewAccountDialogInput, type AccountInput, type AccountsService, type AccountSummary,
  type Chart
} from '@tessera/accounts-api'
import {
  IMPORT_DIALOGS, fileNameStem,
  type AccountChoice, type AccountDialogInput, type AccountDialogResult, type KeyStrength, type ParsedStatement
} from '@tessera/import-api'
import { toMinor } from './convert'
import type { Links } from './links'

/** How a statement is known from one file to the next. */
export interface StatementIdentity {
  key: string
  strength: KeyStrength
  /** Made from the file's name, as the format gave no key. */
  fromFileName: boolean
}

/** A key from a file's name, for formats that give none: without digits, dates and copy suffixes ('Checking 2026-10 (2).qif' → 'checking'). */
export function fileNameKey(formatId: string, fileName: string): string {
  return `${formatId}:file:${fileNameStem(fileName) || 'statement'}`
}

export function identityOf(statement: ParsedStatement, formatId: string, fileName: string): StatementIdentity {
  const key = statement.account.key
  if (typeof key === 'string' && key !== '') return { key, strength: statement.account.keyStrength ?? 'strong', fromFileName: false }
  return { key: fileNameKey(formatId, fileName), strength: 'weak', fromFileName: true }
}

/** The last four letters or digits of an account number, which is all a masked one ('XXXX5678') reliably has. */
const lastFour = (number: string) => accountNumberKey(number).replace(/x+/g, '').slice(-4)

const sameText = (a: string | undefined, b: string | undefined) =>
  a !== undefined && b !== undefined && a.trim().toLowerCase() === b.trim().toLowerCase()

/** The usual currency of the ledger's accounts (the accounts plugin's rule), or `fallback`. */
export function usualCurrency(chart: Chart, fallback = 'CAD'): string {
  const counts = new Map<string, number>()
  for (const { account } of chart.accounts) counts.set(account.currency, (counts.get(account.currency) ?? 0) + 1)
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? fallback
}

/**
 * The accounts the dialog lists, best first: those in the statement's currency, the one used last time, one whose
 * number ends the same, one at the same bank, one of the type the file suggests; then in the navigator's order.
 * Closed accounts come last, and can't be chosen; nor can one in another currency.
 */
export function rankChoices(statement: ParsedStatement, summaries: AccountSummary[], linkedId?: string): { choices: AccountChoice[], preselectedId?: string } {
  const number = statement.account.accountNumber ? lastFour(statement.account.accountNumber) : ''
  const scored = summaries.map(({ account, balances }, position) => {
    const currencyOk = statement.currency === undefined || account.currency === statement.currency
    const linked = account.id === linkedId
    const numberMatches = number !== '' && account.accountNumber !== undefined && lastFour(account.accountNumber) === number
    const sameBank = sameText(account.institution, statement.account.institution)
    const sameType = statement.account.type === account.type
    const score = (currencyOk ? 100 : 0) + (linked ? 50 : 0) + (numberMatches ? 20 : 0) + (sameBank ? 5 : 0) + (sameType ? 2 : 0)
    const hint = linked ? 'Used last time' : numberMatches ? 'Account number matches' : sameBank ? 'Same bank' : undefined
    const disabledReason = account.closed ? 'Closed' : !currencyOk ? 'Other currency' : undefined
    const choice: AccountChoice = {
      account, balance: shownBalance(account, balances),
      ...(disabledReason !== undefined && { disabledReason }),
      ...(hint !== undefined && { hint })
    }
    return { choice, score, position, closed: account.closed }
  })
  scored.sort((a, b) => Number(a.closed) - Number(b.closed) || b.score - a.score || a.position - b.position)
  const choices = scored.map(s => s.choice)
  const best = choices.find(c => c.disabledReason === undefined)
  return { choices, ...(best && { preselectedId: best.account.id }) }
}

/** The day before a YYYY-MM-DD date. */
function dayBefore(date: string): string {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10)
}

/**
 * A new account as the statement describes it, for the New Account form: its name, type, currency, bank and number,
 * opened the day before its first line, with the opening balance that, with the lines, gives the bank's balance. A
 * weak key's label describes the file ('CSV file with columns Date, Description, …'), not an account, so it isn't
 * offered as the name: the user types one.
 */
export function accountFromStatement(statement: ParsedStatement, currency: string, today: string): Partial<AccountInput> {
  const { account } = statement
  const dates = statement.lines.map(l => l.date).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort()
  const first = dates[0] ?? statement.period?.from
  let openingBalance = 0
  if (statement.balance) {
    const balance = toMinor(statement.balance.amount, currency)
    const asOf = statement.balance.asOf
    if (balance.ok) {
      let sum = 0
      for (const line of statement.lines) {
        const amount = line.date <= asOf ? toMinor(line.amount, currency) : undefined
        if (amount?.ok) sum += amount.value
      }
      openingBalance = balance.value - sum
    }
  }
  const number = account.accountNumber
  const kept = accountNumberOf(statement)
  const name = account.name
    ?? (account.institution && number ? `${account.institution} ${lastFour(number)}` : undefined)
    ?? (account.keyStrength === 'weak' ? undefined : account.label)
  return {
    ...(name !== undefined && { name: name.slice(0, 100) }),
    ...(account.type !== undefined && { type: account.type }),
    currency,
    ...(account.institution !== undefined && { institution: account.institution }),
    ...(kept !== undefined && { accountNumber: kept }),
    // What the bank calls itself in its files, for exports (never how the account was found)
    ...(usableBankId(account.bankId) && { bankId: account.bankId!.trim() }),
    ...(usableIntuitBankId(account.intuitBankId) && { intuitBankId: account.intuitBankId!.trim() }),
    openingDate: first ? dayBefore(first) : today,
    openingBalance
  }
}

/**
 * The account number an account takes from a statement: the whole number, or only the last four of a masked one
 * ('XXXXXXXXXXXX3456' → '3456'), which is all it reliably has. None when the file gives none, or one the account can't hold.
 */
export function accountNumberOf(statement: ParsedStatement): string | undefined {
  const number = statement.account.accountNumber?.trim()
  if (number === undefined || number === '') return undefined
  const kept = statement.account.numberIsPartial ? lastFour(number) : number
  return kept !== '' && kept.length <= ACCOUNT_NUMBER_MAX_LENGTH && !/[\u0000-\u001f\u007f]/.test(kept) ? kept : undefined
}

/**
 * Whether an account's number and a statement's are different numbers. Only the last four are compared when either
 * is no more than that (a masked file's, or an account that took one), so 'XXXX3456' and '3456' are the same.
 */
export function accountNumbersDiffer(accountNumber: string, statement: ParsedStatement): boolean {
  const given = statement.account.accountNumber ?? ''
  const own = accountNumberKey(accountNumber)
  if (statement.account.numberIsPartial || own.length <= 4) return lastFour(accountNumber) !== lastFour(given)
  return own !== accountNumberKey(given)
}

/** A statement's bank number an account can take: the account's own rule (letters and digits, 9 at most). */
export const usableBankId = (value: string | undefined): value is string =>
  typeof value === 'string' && new RegExp(`^[0-9A-Za-z]{1,${BANK_ID_MAX_LENGTH}}$`).test(value.trim())

/** A statement's Intuit bank id an account can take. */
export const usableIntuitBankId = (value: string | undefined): value is string =>
  typeof value === 'string' && value.trim() !== '' && value.trim().length <= INTUIT_BANK_ID_MAX_LENGTH && !/[\u0000-\u001f\u007f]/.test(value)

export type Resolution =
  /** `remembered`: statements like this one go to the account without asking from now on (a saved match). */
  | { kind: 'account', account: Account, how: 'saved' | 'number' | 'chosen' | 'created', remembered: boolean }
  | { kind: 'skip' }
  | { kind: 'cancel' }
  | { kind: 'needsAccount' }

export interface ResolveRequest {
  statement: ParsedStatement
  statementIndex: number
  statementCount: number
  fileName: string
  format: { id: string, label: string }
  interactive: boolean
  windowId?: number
}

export class AccountResolver {
  constructor(private readonly deps: {
    accounts: AccountsService
    links: Links
    prompts: Pick<ShellPrompts, 'show'>
    log: Pick<Logger, 'warn'>
    today: () => string
  }) {}

  async resolve(request: ResolveRequest): Promise<Resolution> {
    const { accounts, links } = this.deps
    const { statement } = request
    const identity = identityOf(statement, request.format.id, request.fileName)
    const chart = await accounts.chart({ includeClosed: true })
    const byId = new Map(chart.accounts.map(s => [s.account.id, s.account]))

    // 1. A saved match, when it can be used without asking
    let note: string | undefined
    let linkedId: string | undefined
    const link = await links.get(identity.key)
    if (link) {
      const linked = byId.get(link.accountId)
      if (!linked) await links.forget(identity.key)               // the account is gone
      else {
        linkedId = linked.id
        if (linked.closed) note = `Last time this went to “${linked.name}”, which is closed.`
        else if (statement.currency !== undefined && linked.currency !== statement.currency) {
          note = `Last time this went to “${linked.name}”, which is in ${linked.currency}; this statement is in ${statement.currency}.`
        } else if (link.autoApply) {
          await links.touch(identity.key)
          return { kind: 'account', account: linked, how: 'saved', remembered: true }
        }
      }
    }

    // 2. The account number, when exactly one open account has it
    const number = statement.account.accountNumber
    if (number !== undefined && number !== '') {
      let found = await accounts.list({
        accountNumber: statement.account.numberIsPartial ? { endsWith: lastFour(number) } : number,
        includeClosed: false,
        ...(statement.currency !== undefined && { currency: statement.currency })
      })
      if (found.length > 1 && statement.account.institution) {
        const atBank = found.filter(a => sameText(a.institution, statement.account.institution))
        if (atBank.length > 0) found = atBank
      }
      if (found.length === 1) {
        await this.remember(identity, request, found[0].id, identity.strength === 'strong')
        return { kind: 'account', account: found[0], how: 'number', remembered: identity.strength === 'strong' }
      }
    }

    // 3. Ask
    if (!request.interactive) return { kind: 'needsAccount' }
    for (;;) {
      const { choices, preselectedId } = rankChoices(statement, chart.accounts, linkedId)
      const input = this.dialogInput(request, identity, choices, preselectedId, note)
      const title = request.statementCount > 1 ? `Statement ${request.statementIndex + 1} of ${request.statementCount}: which account is it for?` : undefined
      const answer = await this.deps.prompts.show<AccountDialogResult, AccountDialogInput>(IMPORT_DIALOGS.account, input, {
        ...(title !== undefined && { title }), ...(request.windowId !== undefined && { windowId: request.windowId })
      })
      if (!answer) return { kind: 'cancel' }
      if (answer.kind === 'skip') return { kind: 'skip' }
      if (answer.kind === 'create') {
        const created = await this.createAccount(request, chart)
        if (!created) continue                                    // New Account cancelled: back to the choice
        const remember = answer.remember ?? input.remember.checked
        if (identity.strength === 'weak' || remember) await this.remember(identity, request, created.id, remember)
        return { kind: 'account', account: created, how: 'created', remembered: remember }
      }
      const chosen = byId.get(answer.accountId)
      const usable = choices.find(c => c.account.id === answer.accountId && c.disabledReason === undefined)
      if (!chosen || !usable) {
        this.deps.log.warn(`[import] The Account dialog chose an account it can't use: ${answer.accountId}`)
        continue
      }
      // A strong key is remembered only when the box is ticked; a weak one always, to suggest it next time
      if (identity.strength === 'weak' || answer.remember) await this.remember(identity, request, chosen.id, answer.remember)
      return { kind: 'account', account: chosen, how: 'chosen', remembered: answer.remember === true }
    }
  }

  private async remember(identity: StatementIdentity, request: ResolveRequest, accountId: string, autoApply: boolean) {
    await this.deps.links.save({
      key: identity.key, strength: identity.strength, accountId, autoApply,
      label: request.statement.account.label ?? request.fileName, formatId: request.format.id
    })
  }

  private dialogInput(request: ResolveRequest, identity: StatementIdentity, choices: AccountChoice[], preselectedId: string | undefined, note: string | undefined): AccountDialogInput {
    const { statement } = request
    const { account } = statement
    const dates = statement.lines.map(l => l.date).sort()
    const period = statement.period ?? (dates.length > 0 ? { from: dates[0], to: dates[dates.length - 1] } : undefined)
    const label = account.label ?? request.fileName
    return {
      fileName: request.fileName,
      formatLabel: request.format.label,
      statementIndex: request.statementIndex,
      statementCount: request.statementCount,
      statement: {
        ...(account.label !== undefined && { label: account.label }),
        ...(account.institution !== undefined && { institution: account.institution }),
        ...(account.accountNumber !== undefined && { accountNumber: maskAccountNumber(account.accountNumber) }),
        ...(account.type !== undefined && { typeLabel: ACCOUNT_TYPE_LABELS[account.type] }),
        ...(statement.currency !== undefined && { currency: statement.currency }),
        lineCount: statement.lines.length,
        ...(period !== undefined && { period })
      },
      choices,
      ...(preselectedId !== undefined && { preselectedId }),
      ...(note !== undefined && { note }),
      remember: identity.strength === 'strong'
        ? { strength: 'strong', label: `Remember this account for “${label}”`, checked: true }
        : {
            strength: 'weak', checked: false,
            label: identity.fromFileName ? `Don't ask again for files named like “${request.fileName}”` : "Don't ask again for files like this one"
          }
    }
  }

  /** The accounts plugin's New Account form, filled in from the statement. */
  private async createAccount(request: ResolveRequest, chart: Chart): Promise<Account | undefined> {
    const currency = request.statement.currency ?? usualCurrency(chart)
    const input: NewAccountDialogInput = {
      mode: 'create', subLedgerId: null, subLedgers: chart.subLedgers, ledgerName: chart.ledger.name, defaultCurrency: currency,
      initial: accountFromStatement(request.statement, currency, this.deps.today())
    }
    const result = await this.deps.prompts.show<{ id: string }, NewAccountDialogInput>(ACCOUNTS_DIALOGS.account, input,
      request.windowId !== undefined ? { windowId: request.windowId } : undefined)
    return result ? this.deps.accounts.get(result.id) : undefined
  }
}
